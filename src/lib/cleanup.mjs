// cleanup: finish a worker in one call, so its worktree and pane do not outlive it. The guide used to give this as two
// herdr steps, close the pane and then `herdr worktree remove`, and that order cannot work: a launch's worktree pane
// is its workspace's only pane, closing it closes the workspace, and herdr's remove finds a worktree only by an open
// workspace (measured on herdr 0.9.3, 2026-10-07: `workspace_not_found`, worktree left on disk). One lead's repository
// held 25 such worktrees, none with an open workspace. routr checks, removes, and says what it kept.
//
// Nothing is lost by a removal: a worktree is removed only when it has no change git sees (ignored files such as a
// copied .env do not count, and go with the folder), every untracked file in it is an exact copy of the same file in
// the main checkout (what `launch --copy` put there), and its commit is on a branch, which is kept unless
// --delete-branch is given and git agrees it is merged. Nothing runs in it either: herdr's remove closes the
// workspace and stops whatever is running there without asking (measured: a `sleep` in the pane was killed).
import { lstatSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
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
      const info = (await herdr(["pane", "process-info", "--pane", p.pane_id], true)).data?.result?.process_info;
      const others = (info?.foreground_processes ?? []).filter((f) => f.pid !== info?.shell_pid);
      if (others.length) return { why: `${p.pane_id} is running ${others.map((f) => f.name ?? f.argv0 ?? f.pid).join(", ")}`, then: `Let it finish, or stop it (herdr pane send-keys ${p.pane_id} ctrl+c), then run cleanup again` };
    }
    return null;
  };

  // What stands between a worktree and its removal. Returns { why, then } or { copies } (untracked exact copies).
  const check = async (w, source) => {
    if (w.is_prunable) return { copies: [] }; // its folder is gone; git keeps only the record
    if (w.open_workspace_id) {
      const panes = (await herdr(["pane", "list", "--workspace", w.open_workspace_id])).data?.result?.panes ?? [];
      const b = await busy(panes); if (b) return b;
    }
    const st = await gitRun(w.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (st?.code !== 0) return { why: `git could not read the state of ${w.path}`, then: `Look at it yourself (git -C ${quote(w.path)} status)` };
    const { changed, untracked } = parseStatus(st.out);
    if (changed.length) return { why: `${changed.length} uncommitted change${changed.length > 1 ? "s" : ""} in ${w.path}: ${few(changed)}`,
      then: "Have the worker commit what should be kept on its branch, or ask the user; never discard a worker's changes yourself" };
    const made = untracked.filter((rel) => !sameFile(join(w.path, rel), join(source, rel)));
    if (made.length) return { why: `${made.length} untracked file${made.length > 1 ? "s" : ""} in ${w.path} that the main checkout does not hold as they are: ${few(made)}`,
      then: "Have the worker commit them if they are part of the work, or ask the user; files copied in with launch --copy and left unchanged are removed by cleanup itself" };
    if (w.is_detached) {
      const on = await gitRun(w.path, ["for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]);
      if (on?.code !== 0 || !on.out.trim()) return { why: `${w.path} is on a commit no branch or tag holds`, then: `Keep it on a branch first (git -C ${quote(w.path)} branch <name>), then run cleanup again` };
    }
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
    for (const rel of c.copies) rmSync(join(w.path, rel), { force: true });
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
