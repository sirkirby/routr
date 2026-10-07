// cleanup: finish a worker in one call, so its worktree and pane do not outlive it. The guide used to give this as two
// herdr steps, close the pane and then `herdr worktree remove`, and that order cannot work: a launch's worktree pane
// is its workspace's only pane, closing it closes the workspace, and herdr's remove finds a worktree only by an open
// workspace (measured on herdr 0.9.3, 2026-10-07: `workspace_not_found`, worktree left on disk). One lead's repository
// held 25 such worktrees, none with an open workspace. routr checks, removes, and says what it kept.
//
// Nothing is lost by a removal: a worktree is removed only when it has no change git sees, no file git is told not to
// check, every untracked file in it is an exact copy of the same file in the main checkout (what `launch --copy` put
// there), and the commit it is on is held by a branch or tag (a branch is kept unless --delete-branch is given and git
// agrees it is merged). Files git ignores go with the folder, as `git worktree remove` does: checking them would
// refuse nearly every worktree (node_modules, build output), so the guide tells the lead. Nothing runs in it either:
// herdr's remove closes the workspace and stops whatever is running there without asking (measured: a `sleep` in the
// pane was killed). herdr has no remove-if-idle, so the panes are read again just before the removal; a worker started
// in between is the one case this narrows and does not close (from the review of b32617a).
import { lstatSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BRANCH, quote, runHerdr } from "./herdr.mjs";
import { probe } from "./runtime.mjs";

const herdrLine = (args) => ["herdr", ...args].map(quote).join(" ");
const gitIn = (dir, args) => probe("git", ["-C", dir, ...args], { timeoutMs: 15000, separate: true });
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
// git's own reason, its first line: the rest is hints.
const said = (r) => (r?.err || r?.out || "no answer").trim().split("\n")[0].slice(0, 200);
const few = (list) => list.slice(0, 5).join(", ") + (list.length > 5 ? ` and ${list.length - 5} more` : "");

export function parseCleanupArgs(args) {
  const o = { dryRun: false, deleteBranch: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, "");
    if (args[i] === "--dry-run") { o.dryRun = true; continue; }
    if (args[i] === "--delete-branch") { o.deleteBranch = true; continue; }
    if (!args[i].startsWith("--") || !["cwd", "worktree", "path", "pane"].includes(key)) throw new Error(`Unknown cleanup option: ${args[i]}`);
    if (seen.has(key)) throw new Error(`Repeated cleanup option: --${key}`);
    seen.add(key);
    if (!args[i + 1]?.trim() || /^-\S/.test(args[i + 1])) throw new Error(`--${key} requires a value`);
    if (args[i + 1].includes("\0")) throw new Error(`--${key} must not contain NUL`);
    o[key] = args[++i];
  }
  if ([o.worktree, o.path, o.pane].filter((v) => v != null).length > 1) throw new Error("Name one worker: --worktree, --path, or --pane");
  if (o.worktree != null && !BRANCH.test(o.worktree)) throw new Error("--worktree must be a plain branch name");
  if (o.deleteBranch && o.worktree == null && o.path == null) throw new Error("--delete-branch goes with --worktree or --path");
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

// Remove one file copied in at launch, only if it is still that copy and is reached through no link: a folder swapped
// for a link would aim the removal at the main checkout (from the review of b32617a). Compared again here, right
// before the removal, not only when the worktree was checked.
export function dropCopy(root, source, rel) {
  const target = join(root, rel);
  try { if (realpathSync(dirname(target)) !== join(realpathSync(root), dirname(rel))) return false; } catch { return false; }
  if (!sameFile(target, join(source, rel))) return false;
  rmSync(target, { force: true }); return true;
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

// `run` is one herdr command and `git(dir, args)` one git command ({ out, err, code }, or null): test seams.
export async function cleanup(args, { run = runHerdr, git = gitIn, env = process.env } = {}) {
  const out = { ok: false, state: "failed", cwd: null, command: [], steps: [], warnings: [] };
  const step = (step, ok, detail) => out.steps.push({ step, ok, detail });
  const herdr = async (a, tolerate = false) => {
    out.command.push(herdrLine(a));
    const r = await run(a, 10000);
    if (!r.ok && !tolerate) throw new Error(`herdr ${a.slice(0, 2).join(" ")}: ${r.data?.error?.message ?? r.data?.error?.code ?? "unexpected response"}`);
    return r;
  };
  const gitRun = async (dir, a) => { out.command.push(["git", "-C", dir, ...a].map(quote).join(" ")); return git(dir, a); };
  const refuse = (why, then) => { out.ok = false; out.state = "refused"; out.refused = { why, then }; step("refused", false, why); return out; };
  const own = env.HERDR_PANE_ID;

  // Whether anything still runs in these panes: an agent that is working or waiting at a question, or (no agent) a
  // command in the shell. Returns why not, or null.
  const busy = async (panes) => {
    for (const p of panes) {
      if (own && p.pane_id === own) return { why: `${p.pane_id} is your own pane`, then: "Run cleanup for a worker's pane or worktree, never your own" };
      if (["working", "blocked"].includes(p.agent_status)) {
        return { why: `The agent in ${p.pane_id} is ${p.agent_status === "blocked" ? "waiting at a question" : "working"}`,
          then: `Wait until it is done (herdr agent wait ${p.pane_id} --until idle) or answer it, then run cleanup again` };
      }
      if (["idle", "done"].includes(p.agent_status)) continue;
      // Not knowing what runs there is not knowing it is safe (from the review of b32617a).
      const r = await herdr(["pane", "process-info", "--pane", p.pane_id], true);
      const info = r.ok ? r.data?.result?.process_info : null;
      if (!Array.isArray(info?.foreground_processes)) return { why: `Could not read what runs in ${p.pane_id}`, then: `Look at the pane (herdr pane read ${p.pane_id}), then run cleanup again` };
      const others = info.foreground_processes.filter((f) => f.pid !== info.shell_pid);
      if (others.length) return { why: `${p.pane_id} is running ${others.map((f) => f.name ?? f.argv0 ?? f.pid).join(", ")}`, then: `Let it finish, or stop it (herdr pane send-keys ${p.pane_id} ctrl+c), then run cleanup again` };
    }
    return null;
  };

  const busyIn = async (workspace) => busy((await herdr(["pane", "list", "--workspace", workspace])).data?.result?.panes ?? []);
  // Whether a branch, remote branch or tag holds `rev`. Always asked, of the commit the worktree is on now: one on a
  // branch when herdr listed it can have been detached since (from the review of b32617a).
  const held = async (dir, rev) => {
    const on = await gitRun(dir, ["for-each-ref", "--contains", rev, "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]);
    return on?.code === 0 && Boolean(on.out.trim());
  };
  let heads = null;
  const unheld = (w, source, sha) => ({ why: `${w.path} is on a commit no branch or tag holds${sha ? ` (${sha.slice(0, 12)})` : ""}`,
    then: `Keep it on a branch first (git -C ${quote(w.is_prunable ? source : w.path)} branch <name>${sha ? ` ${sha}` : ""}), then run cleanup again` });

  // What stands between a worktree and its removal. Returns { why, then } or { copies } (untracked exact copies).
  const check = async (w, source) => {
    if (w.open_workspace_id) { const b = await busyIn(w.open_workspace_id); if (b) return b; }
    if (w.is_prunable) {
      // Its folder is gone. git still records the commit it was on, and removing the record loses that commit unless
      // a branch or tag holds it.
      heads ??= parseWorktreeHeads((await gitRun(source, ["worktree", "list", "--porcelain"]))?.out);
      const sha = heads.get(w.path) ?? [...heads].find(([p]) => real(p) === real(w.path))?.[1];
      if (!sha || !(await held(source, sha))) return unheld(w, source, sha);
      return { copies: [] };
    }
    const st = await gitRun(w.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (st?.code !== 0) return { why: `git could not read the state of ${w.path}`, then: `Look at it yourself (git -C ${quote(w.path)} status)` };
    // A file marked skip-worktree or assume-unchanged can hold an edit that status does not show.
    const ls = await gitRun(w.path, ["ls-files", "-v", "-z"]);
    if (ls?.code !== 0) return { why: `git could not list the files of ${w.path}`, then: `Look at it yourself (git -C ${quote(w.path)} ls-files -v)` };
    const unchecked = ls.out.split("\0").filter((l) => /^(?:[a-z]|S) /.test(l)).map((l) => l.slice(2));
    if (unchecked.length) return { why: `${unchecked.length} file${unchecked.length > 1 ? "s" : ""} in ${w.path} git is told not to check (skip-worktree or assume-unchanged), so a change to ${unchecked.length > 1 ? "them" : "it"} would not show: ${few(unchecked)}`,
      then: `Look at ${unchecked.length > 1 ? "them" : "it"} (git -C ${quote(w.path)} ls-files -v), and ask the user` };
    const { changed, untracked } = parseStatus(st.out);
    if (changed.length) return { why: `${changed.length} uncommitted change${changed.length > 1 ? "s" : ""} in ${w.path}: ${few(changed)}`,
      then: "Have the worker commit what should be kept on its branch, or ask the user; never discard a worker's changes yourself" };
    const made = untracked.filter((rel) => !sameFile(join(w.path, rel), join(source, rel)));
    if (made.length) return { why: `${made.length} untracked file${made.length > 1 ? "s" : ""} in ${w.path} that the main checkout does not hold as they are: ${few(made)}`,
      then: "Have the worker commit them if they are part of the work, or ask the user; files copied in with launch --copy and left unchanged are removed by cleanup itself" };
    if (!(await held(w.path, "HEAD"))) return unheld(w, source);
    return { copies: untracked };
  };

  try {
    const o = parseCleanupArgs(args);
    if (o.pane != null) {
      out.pane = o.pane;
      const panes = (await herdr(["pane", "list"])).data?.result?.panes ?? [];
      const p = panes.find((x) => x.pane_id === o.pane);
      if (!p) { out.ok = true; out.state = "absent"; step("pane", true, `No pane ${o.pane}: nothing to close`); return out; }
      const ws = ((await herdr(["workspace", "list"])).data?.result?.workspaces ?? []).find((x) => x.workspace_id === p.workspace_id);
      if (ws?.worktree?.is_linked_worktree && panes.filter((x) => x.workspace_id === p.workspace_id).length === 1) {
        return refuse(`${o.pane} is the only pane of worktree ${ws.worktree.checkout_path}: closing it would leave the worktree behind`,
          `routr cleanup --cwd ${quote(ws.worktree.repo_root ?? ws.worktree.checkout_path)} --path ${quote(ws.worktree.checkout_path)}`);
      }
      const b = await busy([p]); if (b) return refuse(b.why, b.then);
      if (o.dryRun) { out.ok = true; out.state = "planned"; step("plan", true, `Would close ${o.pane}`); return out; }
      await herdr(["pane", "close", o.pane]);
      step("close", true, `Closed ${o.pane}`);
      out.ok = true; out.state = "closed"; return out;
    }

    out.cwd = resolve(o.cwd ?? ".");
    const list = (await herdr(["worktree", "list", "--cwd", out.cwd])).data?.result ?? {};
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
      out.then = `Remove one with routr cleanup --cwd ${quote(out.cwd)} --path <path> (add --delete-branch once its work has landed)`;
      return out;
    }

    const w = o.worktree != null ? linked.find((x) => x.branch === o.worktree) : linked.find((x) => real(x.path) === real(resolve(o.path)));
    if (!w) {
      const main = (list.worktrees ?? []).find((x) => !x.is_linked_worktree);
      if (main && (main.branch === o.worktree || (o.path != null && real(main.path) === real(resolve(o.path))))) return refuse("That is the main checkout, not a worker's worktree", "Name a worker's worktree");
      out.ok = true; out.state = "absent";
      step("worktree", true, `No worktree of ${source} ${o.worktree != null ? `is on branch ${o.worktree}` : `at ${o.path}`}: nothing to remove`);
      if (linked.length) out.warnings.push(`Its other worktrees: ${few(linked.map((x) => x.branch ?? x.path))}. Run routr cleanup --cwd ${quote(out.cwd)} to see them all`);
      return out;
    }
    out.worktree = brief(w);
    const c = await check(w, source);
    if (c.why) return refuse(c.why, c.then);
    if (o.dryRun) {
      out.ok = true; out.state = "planned";
      step("plan", true, `Would ${c.copies.length ? `remove ${c.copies.length} file${c.copies.length > 1 ? "s" : ""} copied in at launch, then ` : ""}remove ${w.path}${w.open_workspace_id ? ` and close workspace ${w.open_workspace_id}` : ""}${o.deleteBranch && w.branch ? `, then delete branch ${w.branch} if it is merged` : ""}`);
      return out;
    }
    if (w.open_workspace_id) { const b = await busyIn(w.open_workspace_id); if (b) return refuse(b.why, b.then); }
    for (const rel of c.copies) {
      if (!dropCopy(w.path, source, rel)) return refuse(`${rel} in ${w.path} changed, or is reached through a link, since cleanup checked it`, `Look at it, then run cleanup again`);
    }
    if (c.copies.length) step("copies", true, `Removed ${c.copies.length} unchanged file${c.copies.length > 1 ? "s" : ""} copied in at launch`);
    // Never --force: if anything changed since the check, herdr and git refuse and the worktree stays.
    if (w.open_workspace_id) {
      const r = await herdr(["worktree", "remove", "--workspace", w.open_workspace_id], true);
      if (!r.ok) return refuse(`herdr did not remove ${w.path}: ${r.data?.error?.message ?? r.data?.error?.code}`, `Look at it (git -C ${quote(w.path)} status), then run cleanup again`);
      step("remove", true, `Removed ${w.path} and closed workspace ${w.open_workspace_id}`);
    } else {
      const r = await gitRun(source, ["worktree", "remove", w.path]);
      if (r?.code !== 0) return refuse(`git did not remove ${w.path}: ${said(r)}`, `Look at it (git -C ${quote(w.path)} status), then run cleanup again`);
      step("remove", true, `Removed ${w.path} (no workspace was open for it)`);
    }
    out.ok = true; out.state = "removed";
    if (w.branch) {
      if (o.deleteBranch) {
        // -d, never -D: git deletes only a branch merged into the checkout's current branch (or its upstream).
        const d = await gitRun(source, ["branch", "-d", w.branch]);
        out.branch = { name: w.branch, deleted: d?.code === 0 };
        if (d?.code === 0) step("branch", true, `Deleted branch ${w.branch}`);
        else { step("branch", false, `Kept branch ${w.branch}`); out.warnings.push(`Branch ${w.branch} was kept: git deletes only a merged branch (${said(d)})`); }
      } else out.branch = { name: w.branch, deleted: false };
    }
  } catch (e) {
    out.ok = false; out.state = "failed"; step("failed", false, String(e?.message ?? e));
  }
  return out;
}
