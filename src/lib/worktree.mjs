// A worker's own git worktree, made by routr with git (herdr makes a pane's), and --copy, which a pane's worktree uses too.
import { warning } from "./warnings.mjs";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { displayCommand } from "./next.mjs";
import { callGit } from "./process-boundary.mjs";
import { dropCopy } from "./cleanup.mjs";
import { ensureParent, folderId, realPath, WORKTREES_DIR, worktreeFolder } from "./state-files.mjs";
import { probe as runProbe } from "./processes.mjs";

// In routr's own folder, one per repository and branch, its branch new and starting at --base (or the checkout's HEAD).
export const git = (dir, args) => callGit((d, a) => runProbe("git", ["-C", d, ...a], { timeoutMs: 20000, separate: true }), dir, args);
const worktreePath = (source, branch) => join(WORKTREES_DIR(), `${basename(source)}-${createHash("sha1").update(source).digest("hex").slice(0, 8)}`, worktreeFolder(branch));
// git's one-line answer, its line ending dropped and nothing else (a folder's name may end in a space).
const line = (out) => out.replace(/\r?\n$/, "");
// Before anything is written: the repository, a branch not taken, a folder not there, and the commit it starts at
// (resolved now, and given to git as that commit, so the branch starts where it was checked).
export async function planWorktree(o, cwd) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`--worktree needs a git repository: git found none at ${cwd} (${top.code})`);
  const source = realPath(line(top.out));
  if ((await git(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${o.worktree}`])).ok) throw new Error(`branch ${o.worktree} exists in ${source}; choose a new branch for the worker`);
  const start = await git(source, ["rev-parse", "--verify", `${o.base ?? "HEAD"}^{commit}`]);
  if (!start.ok) throw new Error(`${o.base ? `--base ${o.base}` : "HEAD"} is not a commit git finds in ${source}`);
  const path = worktreePath(source, o.worktree);
  if (existsSync(path)) throw new Error(`${path} exists; remove it with routr cleanup --cwd ${source} --path ${path}, or choose another branch`);
  return { source, path, start: line(start.out) };
}
// The worktree a launch is making: what unmakeWorktree takes back, whatever point the making reached. Made before git is
// asked, so a failure in git is taken back too. `copySource`: the folder launch was given, which --copy copies from.
export const newWorktree = (o, { source, path, start }, copySource) => ({ branch: o.worktree, base: o.base ?? null, path, source, start, copySource, files: [], dirs: [], added: false });
// The folder and its branch, on the commit planWorktree checked.
export async function makeWorktree(wt, out) {
  const { branch, path, source, start } = wt;
  ensureParent(path);
  out.ran.push(displayCommand(["git", "-C", source, "worktree", "add", "-b", branch, path, start]));
  const made = await git(source, ["worktree", "add", "-b", branch, path, start]);
  if (!made.ok) throw new Error(`git did not make the worktree (${made.code})`);
  wt.added = true;
  wt.path = realPath(wt.path); // as git lists it (macOS: /tmp is /private/tmp; Windows: long names)
  wt.folder = folderId(wt.path);
}
// A folder itself, reached through no link or junction on the way: its real path is the path.
const realFolder = (p) => { try { return lstatSync(p).isDirectory() && realPath(p) === p; } catch { return false; } };
// --copy, in a pane's worktree and a headless one: from the folder launch was given, to the same place in the worktree, never through a link (a folder in the
// commit that links elsewhere) and never over a file the worktree has. Records each file it made relative to the
// worktree, as dropCopy takes it, and each folder by its full path in the worktree.
export function copyInto(from, root, rel, made = { files: [], dirs: [] }) {
  const parts = rel.split(process.platform === "win32" ? /[\\/]/ : /\//).filter(Boolean); // a POSIX name may hold a backslash
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    if (!existsSync(at)) { mkdirSync(at); made.dirs.push(at); continue; }
    const st = lstatSync(at);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`--copy ${rel}: ${at} in the worktree is a link or not a folder; nothing is copied through it`);
  }
  const to = join(root, ...parts);
  if (existsSync(to) || (() => { try { lstatSync(to); return true; } catch { return false; } })()) throw new Error(`--copy ${rel}: the worktree already has it`);
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  // A link copied as a link is a file here, never a folder to walk or take back.
  if (realFolder(to)) { made.dirs.push(to); for (const f of readdirSync(to, { recursive: true }).map(String)) { if (realFolder(join(to, f))) made.dirs.push(join(to, f)); else made.files.push(join(rel, f)); } }
  else made.files.push(rel);
}
// The worktree a launch made and nothing ran in: its copies (unchanged ones, and the folders it made, only
// inside the worktree and reached through no link, checked again right before each removal), the worktree
// through cleanup's own checks, and its branch while it still points at the commit it started on (git compares
// and deletes in one step). The branch is this launch's only once git made the worktree: when `worktree add -b`
// failed, a branch of that name may be another command's, made since the check, so it is left and said.
// Anything else left is said too.
export async function unmakeWorktree(wt, out) {
  const exists = async () => (await git(wt.source, ["rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}`])).ok;
  if (!wt.added) {
    if (await exists()) out.warnings.push(warning("branch_unowned", `Branch ${wt.branch} exists in ${wt.source}, but git did not make this launch's worktree, so whose branch it is cannot be told; it was left`));
    return;
  }
  for (const rel of wt.files) dropCopy(wt.path, wt.copySource, rel);
  const inside = (d) => { const r = relative(wt.path, d); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
  for (const d of [...wt.dirs].reverse()) { if (inside(d) && realFolder(d)) { try { rmdirSync(d); } catch {} } }
  const { cleanup } = await import("./cleanup.mjs");
  const r = await cleanup(["--cwd", wt.source, "--path", wt.path], { env: {} });
  const removed = ["removed", "absent"].includes(r.state);
  const branchGone = removed && (await git(wt.source, ["update-ref", "-d", `refs/heads/${wt.branch}`, wt.start])).ok;
  if (!removed) out.warnings.push(warning("worktree_left", `The worktree ${wt.path} (branch ${wt.branch}) this launch made was left: run routr cleanup --cwd ${wt.source} --path ${wt.path}`));
  else if (!branchGone && await exists()) out.warnings.push(warning("branch_changed", `Branch ${wt.branch} this launch made was left, as it no longer points at ${wt.start}: run git -C ${wt.source} branch -d ${wt.branch} if it is not needed`));
}
