// Cleanup: finish a worker in one call, so its worktree and pane do not outlive it. The guide used to give this
// as two herdr steps, close the pane and then `herdr worktree remove`, and that order cannot work: a launch's
// worktree pane is its workspace's only pane, closing it closes the workspace, and herdr's remove finds a
// worktree only by an open workspace (measured on herdr 0.9.3, 2026-10-07: `workspace_not_found`, worktree left
// on disk). One lead's repository held 25 such worktrees, none with an open workspace. routr checks, removes,
// and says what it kept. What a removal keeps: a worktree is removed only when it has no change git sees, no
// file git is told not to check, every untracked file in it is an exact copy of the same file in the main
// checkout (what `launch --copy` put there), and the commit it is on is held by a branch or tag (a branch is
// kept unless --delete-branch is given and git agrees it is merged). Files git ignores go with the folder, as
// `git worktree remove` does: checking them would refuse nearly every worktree (node_modules, build output), so
// the guide tells the lead. Nothing runs in it either: herdr's remove closes the workspace and stops whatever
// is running there without asking (measured: a `sleep` in the pane was killed). Neither herdr nor git has a
// remove-if-unchanged, so right before the removal the commit is compared with the one checked and then the
// panes are read again, last: a commit made after that comparison, or a worker started after that read, is the
// limit this narrows and does not close.
import { warning } from "./warnings.mjs";
import { commandTrace, cleanupLink } from "./traces.mjs";
import { configOf, oneReading } from "./config.mjs";
import { lstatSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { displayCommand, doNext, runNext, templateCommand } from "./next.mjs";
import { BRANCH, runHerdr } from "./herdr.mjs";
import { count } from "./wording.mjs";
import { answer } from "./output.mjs";
import { callHerdr, callGit, processError, processSteps } from "./process-boundary.mjs";
import { probe, realOr, realPath, WORKER_NAME } from "./runtime.mjs";

const herdrLine = (args) => displayCommand(["herdr", ...args]);
const gitIn = (dir, args) => probe("git", ["-C", dir, ...args], { timeoutMs: 15000, separate: true });
const real = realOr;
const few = (list) => list.slice(0, 5).join(", ") + (list.length > 5 ? ` and ${list.length - 5} more` : "");

export function parseCleanupArgs(args) {
  const o = { dryRun: false, deleteBranch: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, "");
    if (args[i] === "--dry-run") { o.dryRun = true; continue; }
    if (args[i] === "--delete-branch") { o.deleteBranch = true; continue; }
    if (!args[i].startsWith("--") || !["cwd", "worktree", "path", "pane", "worker"].includes(key)) throw new Error(`Unknown cleanup option: ${args[i]}`);
    if (seen.has(key)) throw new Error(`Repeated cleanup option: --${key}`);
    seen.add(key);
    if (!args[i + 1]?.trim() || /^-\S/.test(args[i + 1])) throw new Error(`--${key} requires a value`);
    if (args[i + 1].includes("\0")) throw new Error(`--${key} must not contain NUL`);
    o[key] = args[++i];
  }
  if ([o.worktree, o.path, o.pane, o.worker].filter((v) => v != null).length > 1) throw new Error("Name one worker: --worktree, --path, --pane, or --worker");
  if (o.worker != null && !WORKER_NAME.test(o.worker)) throw new Error("--worker must be a worker's name");
  if (o.worker != null && o.cwd != null) throw new Error("--worker takes no --cwd: the worker's run folder says where its worktree is");
  if (o.worktree != null && !BRANCH.test(o.worktree)) throw new Error("--worktree must be a plain branch name");
  if (o.deleteBranch && o.worktree == null && o.path == null && o.worker == null) throw new Error("--delete-branch goes with --worktree, --path or --worker");
  if (o.pane != null && o.cwd != null) throw new Error("--pane needs no --cwd");
  return o;
}

// `git status` with -z: "XY path", and a rename or copy carries its old path as one more entry.
export function parseStatus(text) {
  const parts = String(text ?? "").split("\0").filter(Boolean), changed = [], untracked = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2), path = parts[i].slice(3);
    if (xy === "??") untracked.push(path); else changed.push(path);
    if (/[RC]/.test(xy)) i++;
  }
  return { changed, untracked };
}

// The same file, or the same link, at both paths.
export function sameFile(a, b) {
  try {
    const x = lstatSync(a), y = lstatSync(b);
    if (x.isSymbolicLink() || y.isSymbolicLink()) return x.isSymbolicLink() && y.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
    return x.isFile() && y.isFile() && x.size === y.size && readFileSync(a).equals(readFileSync(b));
  } catch { return false; }
}

// Remove one file copied in at launch, only if it is still that copy and is reached through no link: a folder
// swapped for a link, the worktree's own included, would aim the removal at the main checkout. `rootReal` is
// the worktree's real path when it was checked. Compared again here, right before the removal.
export function dropCopy(root, source, rel, rootReal = real(root)) {
  const target = join(root, rel);
  try { if (realPath(root) !== rootReal || realPath(dirname(target)) !== join(rootReal, dirname(rel))) return false; } catch { return false; }
  if (!sameFile(target, join(source, rel))) return false;
  rmSync(target, { force: true }); return true;
}

// A linked worktree's folder holds a `.git` file pointing into the repository's worktrees; the main checkout holds the
// `.git` folder itself.
export function linkedWorktree(rootReal, source) {
  try {
    if (rootReal === real(source)) return false;
    const git = join(rootReal, ".git");
    return lstatSync(git).isFile() && /^gitdir:.*[\\/]worktrees[\\/][^\\/]+\s*$/m.test(readFileSync(git, "utf8"));
  } catch { return false; }
}

// `git worktree list --porcelain` as herdr's `worktree list` gives it, for cleanup outside herdr: the first block is the
// main checkout; each other one a linked worktree, with its branch (or detached), and prunable when its folder is gone.
// No workspace is open for any of them.
export function worktreesFromGit(text) {
  const blocks = String(text ?? "").trim().split(/\r?\n\r?\n/).filter(Boolean);
  const all = blocks.map((b, i) => ({ path: b.match(/^worktree (.+)$/m)?.[1], branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null,
    is_detached: /^detached$/m.test(b), is_prunable: /^prunable\b/m.test(b), is_linked_worktree: i > 0, open_workspace_id: null })).filter((w) => w.path);
  return { source: { source_checkout_path: all[0]?.path }, worktrees: all };
}

// `git worktree list --porcelain`: each worktree's path and the commit git recorded for it.
export function parseWorktreeHeads(text) {
  const heads = new Map();
  for (const block of String(text ?? "").split(/\r?\n\r?\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1], head = block.match(/^HEAD ([0-9a-f]+)$/m)?.[1];
    if (path && head) heads.set(path, head);
  }
  return heads;
}

// `run` is one herdr command, `git(dir, args)` one git command ({ out, err, code }, or null), and `linked` the
// linked-worktree test: seams for tests.
async function cleanupBody(args, { run = runHerdr, git = gitIn, env = process.env, linked = linkedWorktree, assertOwned = () => {} } = {}) {
  // Outside herdr, worktrees are listed and removed through git alone (headless workers make theirs that way), and
  // what runs in a folder is not seen: the warning says so.
  const viaGit = env.HERDR_ENV !== "1";
  let target = null;
  const out = { ok: false, state: "failed", ran: [], next: [], steps: [], warnings: [], unavailable: [] };
  const step = (step, ok, detail) => out.steps.push({ step, ok, detail });
  const herdr = async (a, tolerate = false) => {
    out.ran.push(herdrLine(a));
    const r = processSteps(out, await callHerdr(run, a, 10000));
    if (!r.ok && !tolerate) throw processError(r);
    return r;
  };
  const gitRun = async (dir, a) => { out.ran.push(displayCommand(["git", "-C", dir, ...a])); return callGit(git, dir, a); };
  const refuse = (why, next) => { out.ok = false; out.state = "refused"; out.headline = `routr: kept ${out.worktree?.path ?? out.pane ?? out.cwd}: ${why}`; out.next.push(...(Array.isArray(next) ? next : [next])); step("refused", false, why); return out; };
  const inspect = (why, argv) => [runNext(why, argv), doNext("Inspect the result, resolve what kept this worker, then run cleanup again.")];
  const own = env.HERDR_PANE_ID;
  const missing = (part, value) => {
    if (!out.unavailable.some((u) => u.part === part && u[part === "pane" ? "pane" : "path"] === value)) out.unavailable.push({ part, [part === "pane" ? "pane" : "path"]: value, code: "unreadable", why: `The ${part} state could not be read. Inspect it before removing the worker.` });
  };

  // Whether anything still runs in these panes: an agent that is working or waiting at a question, or (no agent) a
  // command in the shell. Returns why not, or null.
  const busy = async (panes) => {
    for (const p of panes) {
      if (own && p.pane_id === own) return { why: `${p.pane_id} is your own pane`, next: doNext("Run cleanup for a worker's pane or worktree, never your own") };
      if (["working", "blocked"].includes(p.agent_status)) {
        return { why: `The agent in ${p.pane_id} is ${p.agent_status === "blocked" ? "waiting at a question" : "working"}`,
          next: [doNext("Answer the worker’s question if within scope, or let it finish before cleanup."), runNext("Wait until this worker is idle, then run cleanup again.", ["herdr", "agent", "wait", p.pane_id, "--until", "idle"])] };
      }
      if (["idle", "done"].includes(p.agent_status)) continue;
      // Not knowing what runs there is not knowing it is safe.
      const r = await herdr(["pane", "process-info", "--pane", p.pane_id], true);
      const info = r.ok ? r.data?.result?.process_info : null;
      if (!Array.isArray(info?.foreground_processes)) { missing("pane", p.pane_id); return { why: `Could not read what runs in ${p.pane_id}`, next: inspect("Look at the pane before deciding whether cleanup is safe.", ["herdr", "pane", "read", p.pane_id]) }; }
      const others = info.foreground_processes.filter((f) => f.pid !== info.shell_pid);
      if (others.length) return { why: `${p.pane_id} is running ${count(others.length, "command")} besides its shell`, next: [runNext("Read the pane before deciding whether to let it finish or stop it.", ["herdr", "pane", "read", p.pane_id]), doNext("Let the command finish, or decide whether it is within scope to stop it, then run cleanup again.")] };
    }
    return null;
  };

  // A pane list herdr did not give whole is not an empty one.
  const paneList = async (args) => {
    const panes = (await herdr(["pane", "list", ...args])).data?.result?.panes;
    if (!Array.isArray(panes) || panes.some((p) => typeof p?.pane_id !== "string")) throw new Error("herdr pane list: no pane list in its answer");
    return panes;
  };
  const busyIn = async (workspace) => busy(await paneList(["--workspace", workspace]));
  const headOf = async (dir) => { const r = await gitRun(dir, ["rev-parse", "--verify", "HEAD"]); if (r?.code !== 0) missing("worktree", dir); return r?.code === 0 ? r.out.trim() : null; };
  // Whether a branch, remote branch or tag holds `rev`. Always asked, of the commit the worktree is on now: one
  // on a branch when herdr listed it can have been detached since.
  const refArgs = (rev) => ["for-each-ref", "--contains", rev, "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"];
  const held = async (dir, rev, path = dir) => {
    const on = await gitRun(dir, refArgs(rev));
    if (on?.code !== 0) missing("worktree", path);
    return on?.code === 0 ? Boolean(on.out.trim()) : null;
  };
  const unreadableRefs = (w, dir, sha) => ({ why: `git could not read the refs for ${w.path}`, next: inspect("Read the repository refs before deciding whether this commit is held.", ["git", "-C", dir, ...refArgs(sha)]) });
  let heads = null;
  const unheld = (w, source, sha) => ({ why: `${w.path} is on a commit no branch or tag holds${sha ? ` (${sha.slice(0, 12)})` : ""}`,
    next: doNext("Keep the commit on a branch first, then run cleanup again.", templateCommand(["git", "-C", w.is_prunable ? source : w.path, "branch", "<name>", ...(sha ? [sha] : [])])) });

  // What stands between a worktree and its removal. Returns { why, next } or { copies } (untracked exact copies).
  const check = async (w, source) => {
    // Where the worktree is, fixed before anything else is awaited, and shown to be a linked worktree and not the
    // main checkout: a folder swapped for a link to the main checkout would otherwise be checked, and its
    // copies removed, as the worker's.
    const rootReal = w.is_prunable ? null : real(w.path);
    if (rootReal && !linked(rootReal, source)) return { why: `${w.path} is not a linked worktree of ${source}`, next: inspect("Check the repository’s actual worktrees.", ["git", "-C", source, "worktree", "list"]) };
    if (w.open_workspace_id) { const b = await busyIn(w.open_workspace_id); if (b) return b; }
    if (w.is_prunable) {
      // Its folder is gone. git still records the commit it was on, and removing the record loses that commit unless
      // a branch or tag holds it.
      heads ??= parseWorktreeHeads((await gitRun(source, ["worktree", "list", "--porcelain"]))?.out);
      const sha = heads.get(w.path) ?? [...heads].find(([p]) => real(p) === real(w.path))?.[1];
      if (!sha) { missing("worktree", w.path); return { why: `git could not read the recorded commit for ${w.path}`, next: inspect("Read git’s recorded worktree commits.", ["git", "-C", source, "worktree", "list", "--porcelain"]) }; }
      const refs = await held(source, sha, w.path);
      if (refs == null) return unreadableRefs(w, source, sha);
      if (!refs) return unheld(w, source, sha);
      return { copies: [] };
    }
    const head = await headOf(w.path);
    if (!head) { missing("worktree", w.path); return { why: `git could not read the commit ${w.path} is on`, next: inspect("Read the worktree’s state.", ["git", "-C", w.path, "status"]) }; }
    const st = await gitRun(w.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (st?.code !== 0) { missing("worktree", w.path); return { why: `git could not read the state of ${w.path}`, next: inspect("Read the worktree’s state.", ["git", "-C", w.path, "status"]) }; }
    // A file marked skip-worktree or assume-unchanged can hold an edit that status does not show.
    const ls = await gitRun(w.path, ["ls-files", "-v", "-z"]);
    if (ls?.code !== 0) { missing("worktree", w.path); return { why: `git could not list the files of ${w.path}`, next: inspect("Read the worktree’s file flags.", ["git", "-C", w.path, "ls-files", "-v"]) }; }
    const unchecked = ls.out.split("\0").filter((l) => /^(?:[a-z]|S) /.test(l)).map((l) => l.slice(2));
    if (unchecked.length) return { why: `${unchecked.length} file${unchecked.length > 1 ? "s" : ""} in ${w.path} git is told not to check (skip-worktree or assume-unchanged), so a change to ${unchecked.length > 1 ? "them" : "it"} would not show`,
      next: [runNext("Read the files git is told not to check.", ["git", "-C", w.path, "ls-files", "-v"]), doNext("Ask the user how to handle these unchecked files.")] };
    const { changed, untracked } = parseStatus(st.out);
    if (changed.length) return { why: `${changed.length} uncommitted change${changed.length > 1 ? "s" : ""} in ${w.path}`,
      next: [runNext("Inspect the uncommitted files.", ["git", "-C", w.path, "status"]), doNext("Have the worker commit what should be kept on its branch, or ask the user; never discard a worker's changes yourself")] };
    const made = untracked.filter((rel) => !sameFile(join(w.path, rel), join(source, rel)));
    if (made.length) return { why: `${made.length} untracked file${made.length > 1 ? "s" : ""} in ${w.path} that the main checkout does not hold as they are`,
      next: [runNext("Inspect the untracked files.", ["git", "-C", w.path, "status"]), doNext("Have the worker commit them if they are part of the work, or ask the user; files copied in with launch --copy and left unchanged are removed by cleanup itself")] };
    const refs = await held(w.path, head);
    if (refs == null) return unreadableRefs(w, w.path, head);
    if (!refs) return unheld(w, source, head);
    return { copies: untracked, head, rootReal };
  };

  try {
    const o = parseCleanupArgs(args);
    await cleanupLink(o, run);
    target = o.worktree ?? o.path;
    if (o.worker != null) return await (await import("./workers.mjs")).cleanupWorker(o.worker, o, out);
    if (o.pane != null) {
      out.pane = o.pane;
      const panes = await paneList([]);
      const p = panes.find((x) => x.pane_id === o.pane);
      if (!p) { out.ok = true; out.state = "absent"; step("pane", true, `No pane ${o.pane}: nothing to close`); return out; }
      const ws = ((await herdr(["workspace", "list"])).data?.result?.workspaces ?? []).find((x) => x.workspace_id === p.workspace_id);
      if (ws?.worktree?.is_linked_worktree && panes.filter((x) => x.workspace_id === p.workspace_id).length === 1) {
        return refuse(`${o.pane} is the only pane of worktree ${ws.worktree.checkout_path}: closing it would leave the worktree behind`,
          runNext("Remove the worktree instead of closing its only pane.", ["routr", "cleanup", "--cwd", ws.worktree.repo_root ?? ws.worktree.checkout_path, "--path", ws.worktree.checkout_path]));
      }
      const b = await busy([p]); if (b) return refuse(b.why, b.next);
      if (o.dryRun) { out.ok = true; out.state = "planned"; step("plan", true, `Would close ${o.pane}`); return out; }
      // Again, right before closing: a worker may have started since.
      const now = (await paneList([])).find((x) => x.pane_id === o.pane);
      if (now) { const again = await busy([now]); if (again) return refuse(again.why, again.next); }
      await herdr(["pane", "close", o.pane]);
      step("close", true, `Closed ${o.pane}`);
      out.ok = true; out.state = "closed"; return out;
    }

    out.cwd = resolve(o.cwd ?? ".");
    let list;
    if (viaGit) {
      const r = await gitRun(out.cwd, ["worktree", "list", "--porcelain"]);
      if (!r?.ok) throw new Error(`git found no repository at ${out.cwd} it could list the worktrees of (${r?.code ?? "git_unreachable"})`);
      list = worktreesFromGit(r.out);
      out.warnings.push(warning("cleanup_unseen", "Outside herdr, cleanup cannot see whether anything runs in a worktree's folder: it checks git's state only"));
    } else list = (await herdr(["worktree", "list", "--cwd", out.cwd])).data?.result ?? {};
    const source = list.source?.source_checkout_path ?? list.source?.repo_root;
    if (!source) throw new Error(`herdr found no git repository at ${out.cwd}`);
    const linked = (list.worktrees ?? []).filter((w) => w.is_linked_worktree);
    const brief = (w) => ({ branch: w.branch ?? null, path: w.path, workspace: w.open_workspace_id ?? null, detached: Boolean(w.is_detached) });

    // No worker named: every worktree of the repository, and what cleanup would do with each. Changes nothing.
    if (o.worktree == null && o.path == null) {
      out.worktrees = [];
      for (const w of linked) {
        const c = await check(w, source);
        out.worktrees.push({ ...brief(w), removable: !c.why, ...(c.why ? { why: c.why } : {}) });
      }
      out.ok = true; out.state = "listed";
      step("list", true, `${linked.length} worktree${linked.length === 1 ? "" : "s"} besides the main checkout; ${out.worktrees.filter((w) => w.removable).length} can be removed now`);
      out.next.push(doNext("Choose a worktree to remove; add --delete-branch once its work has landed.", templateCommand(["routr", "cleanup", "--cwd", out.cwd, "--path", "<path>"])));
      return out;
    }

    const w = o.worktree != null ? linked.find((x) => x.branch === o.worktree) : linked.find((x) => real(x.path) === real(resolve(o.path)));
    if (!w) {
      const main = (list.worktrees ?? []).find((x) => !x.is_linked_worktree);
      if (main && (main.branch === o.worktree || (o.path != null && real(main.path) === real(resolve(o.path))))) return refuse("That is the main checkout, not a worker's worktree", doNext("Name a worker's worktree"));
      out.ok = true; out.state = "absent";
      step("worktree", true, `No worktree of ${source} ${o.worktree != null ? `is on branch ${o.worktree}` : `at ${o.path}`}: nothing to remove`);
      if (linked.length) {
        out.warnings.push(warning("other_worktrees", `Its other worktrees: ${few(linked.map((x) => x.branch ?? x.path))}`));
        out.next.push(runNext("List the repository’s remaining worktrees.", ["routr", "cleanup", "--cwd", out.cwd]));
      }
      return out;
    }
    out.worktree = brief(w);
    const c = await check(w, source);
    if (c.why) return refuse(c.why, c.next);
    if (o.dryRun) {
      out.ok = true; out.state = "planned";
      step("plan", true, `Would ${c.copies.length ? `remove ${c.copies.length} file${c.copies.length > 1 ? "s" : ""} copied in at launch, then ` : ""}remove ${w.path}${w.open_workspace_id ? ` and close workspace ${w.open_workspace_id}` : ""}${o.deleteBranch && w.branch ? `, then delete branch ${w.branch} if it is merged` : ""}`);
      return out;
    }
    for (const rel of c.copies) {
      assertOwned(); // Headless worker cleanup keeps its lock through asynchronous checks, up to each action.
      if (!dropCopy(w.path, source, rel, c.rootReal)) return refuse(`A copy in ${w.path} changed, or is reached through a link, since cleanup checked it`, doNext("Look at the changed copy, then run cleanup again."));
    }
    if (c.copies.length) step("copies", true, `Removed ${c.copies.length} unchanged file${c.copies.length > 1 ? "s" : ""} copied in at launch`);
    // The last looks before the removal: the commit it is on, then what runs there, read last of all.
    if (c.head && (await headOf(w.path)) !== c.head) return refuse(`${w.path} moved to another commit since cleanup checked it`, runNext("Recheck the worktree at its current commit.", ["routr", "cleanup", ...args]));
    if (w.open_workspace_id) { const b = await busyIn(w.open_workspace_id); if (b) return refuse(b.why, b.next); }
    // Never --force: if anything changed since the check, herdr and git refuse and the worktree stays.
    assertOwned();
    if (w.open_workspace_id) {
      const r = await herdr(["worktree", "remove", "--workspace", w.open_workspace_id], true);
      if (!r.ok) return refuse(`herdr refused worktree remove for ${w.path} (${r.code})`, inspect("Read the worktree after removal was refused.", ["git", "-C", w.path, "status"]));
      step("remove", true, `Removed ${w.path} and closed workspace ${w.open_workspace_id}`);
    } else {
      const r = await gitRun(source, ["worktree", "remove", w.path]);
      if (r?.code !== 0) return refuse(`git refused worktree remove for ${w.path} (${r.code})`, inspect("Read the worktree after removal was refused.", ["git", "-C", w.path, "status"]));
      step("remove", true, `Removed ${w.path} (no workspace was open for it)`);
    }
    out.ok = true; out.state = "removed";
    if (w.branch) {
      if (o.deleteBranch) {
        // -d, never -D: git deletes only a branch merged into the checkout's current branch (or its upstream).
        assertOwned();
        const d = await gitRun(source, ["branch", "-d", w.branch]);
        out.branch = { name: w.branch, deleted: d?.code === 0 };
        if (d?.code === 0) step("branch", true, `Deleted branch ${w.branch}`);
        else { step("branch", false, `Kept branch ${w.branch}`); out.warnings.push(warning("branch_unmerged", `Branch ${w.branch} was kept: git deletes only a merged branch`)); }
      } else out.branch = { name: w.branch, deleted: false };
    }
  } catch (e) {
    out.ok = false; out.state = "failed"; out.error = String(e?.message ?? e); step("failed", false, out.error);
  } finally {
    out.headline ??= out.state === "failed" ? `routr: cleanup failed: ${out.error}`
      : out.state === "listed" ? `routr: ${count(out.worktrees.length, "worktree")}, ${out.worktrees.filter((w) => w.removable).length} can be removed now`
      : out.state === "absent" ? `routr: nothing to remove: no ${out.pane ? `pane ${out.pane}` : `worktree ${out.worktree?.path ?? target}`}`
      : `routr: ${out.state === "planned" ? "would " + (out.pane ? "close" : "remove") : out.state} ${out.pane ?? out.worktree?.path}`;
    const ordered = answer(out); for (const key of Object.keys(out)) delete out[key]; Object.assign(out, ordered);
  }
  return out;
}

export const cleanup = (args, opts = {}) => {
  const settings = oneReading(opts.settings);
  return commandTrace("cleanup", () => ({ config: configOf(settings()), ...opts, cwd: args.includes("--cwd") ? args[args.indexOf("--cwd") + 1] : undefined }), () => cleanupBody(args, { ...opts, settings }));
};
