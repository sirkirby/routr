// `routr uninstall`: remove what the installer and `routr setup` put on this machine. By default the user's own data
// stays (config, decision provider keys, ledger), as with a typical uninstall; `--purge` removes that too. A person is shown the
// plan and asked; an agent or a script must pass `--yes`. Worktrees and herdr panes belong to the user's repos, not to routr.
// Headless workers are the exception that stops it: a worker's run folder (its reports, and while it runs, its holder,
// which is this binary) is routr's, and only `routr cleanup --worker` removes one with its checks. And the worktrees a
// headless launch made sit inside ~/.local/share/routr, so `--purge` would delete them unchecked. While any is there,
// uninstall removes nothing and says what to run (found in the doc sweep of 2026-10-23: `--purge` removed them whole).
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { notOursWhy, owner, removeOwned, skillPlaces } from "./skill-install.mjs";
import { lockIsStale, home as userHome, standalone, start, takeLock, UNINSTALL_LOCK } from "./runtime.mjs";
import { FORMAT } from "./headless.mjs";
import { isOurStatusline } from "./statusline.mjs";


// A folder's entries; none when it is not there. Anything else unreadable is thrown: it is not known to be empty.
const entries = (p) => { try { return readdirSync(p).sort(); } catch (e) { if (e?.code === "ENOENT") return []; throw Object.assign(new Error(p), { path: p }); } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch (e) { if (e?.code === "ENOENT") return false; throw Object.assign(new Error(p), { path: p }); } };
const emptyTree = (p) => isDir(p) && entries(p).every((n) => emptyTree(join(p, n)));
const NAME = /^[a-z][a-z0-9_-]{0,31}$/; // launch's --name rule, which cleanup --worker takes
// What would stop uninstall: headless workers (a run folder launch finished writing, running or not), run folders it did
// not finish, and anything under worktrees/ but empty folders (a worktree is <repo folder>/<branch> today; any other
// layout is reported, never trusted), plus paths it could not read.
export function leftovers(home = userHome()) {
  const workers = [], unknown = [], worktrees = [], unreadable = [];
  const dir = join(home, ".local/state/routr/workers");
  try {
    for (const n of entries(dir)) {
      if (!isDir(join(dir, n))) continue; // a worker's lock file
      let w = null; try { w = JSON.parse(readFileSync(join(dir, n, "worker.json"), "utf8")); } catch {}
      if (NAME.test(n) && w?.format === FORMAT && w.name === n) workers.push(n); else unknown.push(join(dir, n));
    }
  } catch (e) { unreadable.push(e.path ?? dir); }
  const root = join(home, ".local/share/routr/worktrees");
  try {
    for (const repo of entries(root)) {
      const r = join(root, repo);
      if (!isDir(r) || existsSync(join(r, ".git"))) { worktrees.push(r); continue; }
      for (const b of entries(r)) if (!emptyTree(join(r, b))) worktrees.push(join(r, b));
    }
  } catch (e) { unreadable.push(e.path ?? root); }
  return { workers, unknown, worktrees, unreadable };
}

// Why uninstall stops, and what to run first; null when nothing stops it.
export function blockedBy({ workers, unknown = [], worktrees, unreadable = [] }, purge) {
  const steps = [];
  if (workers.length) steps.push(`headless workers are still here (${workers.join(", ")}): finish each with \`routr cleanup --worker <name>\` (it keeps a worktree with uncommitted work; stop a running one first with \`routr stop --name <name>\`)`);
  if (unknown.length) steps.push(`run folders a launch did not finish writing are here (${unknown.join(", ")}): look at each, and remove it yourself once nothing of it runs`);
  if (purge && worktrees.length) steps.push(`--purge would delete what a headless launch left under ~/.local/share/routr/worktrees, unchecked (${worktrees.join(", ")}): finish a worktree with \`routr cleanup --cwd <path> --path <path>\`, which keeps uncommitted work, look at anything else yourself, or uninstall without --purge to keep them`);
  if (unreadable.length) steps.push(`routr could not read ${unreadable.join(", ")}, so it cannot tell whether a worker or worktree is there: look at it`);
  return steps.length ? `routr uninstall removed nothing: ${steps.join("; ")}. Then run it again` : null;
}

// What would be removed, as data: a test can check the plan without touching a disk.
export function uninstallPlan({ home = userHome(), purge = false, binary = null } = {}) {
  const remove = [], keep = [], notOurs = [];
  if (binary) remove.push({ path: binary, what: "the routr binary" });
  // Each of routr's skills: each harness's link first, then the folder the links point at. Only routr's own: a link to
  // anything but routr's copy, or a folder of the same name routr did not write, stays (skill-install.mjs, `owner`).
  for (const p of skillPlaces(home)) {
    if (p.state === "ours") remove.push({ path: p.path, what: `the ${p.skill} skill`, skill: p.skill });
    else if (p.state === "theirs") notOurs.push({ path: p.path, what: p.why });
  }
  remove.push({ path: join(home, ".cache/routr"), what: "cache: the usage snapshots and the update log" });
  const left = leftovers(home);
  const data = [{ path: join(home, ".config/routr"), what: "your config and decision provider keys" },
    { path: join(home, ".local/share/routr"), what: left.worktrees.length ? "your ledger, and worktrees a headless launch made (yours to finish)" : "your ledger" }];
  (purge ? remove : keep).push(...data);
  // Last: it holds the uninstall lock, which keeps a launch from starting until everything else is gone. With no worker
  // left (blockedBy), what remains here is routr's own bookkeeping: sockets and locks.
  remove.push({ path: join(home, ".local/state/routr"), what: "state: headless workers' sockets and locks", state: true });
  const present = (l) => l.filter((x) => { try { lstatSync(x.path); return true; } catch { return false; } });
  let statusline = false;
  try { statusline = isOurStatusline(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).statusLine?.command); } catch {}
  return { remove: present(remove), keep: present(keep), not_ours: notOurs, statusline, blocked: blockedBy(left, purge) };
}

// A link is unlinked, never followed.
const removePath = (p) => { if (lstatSync(p).isSymbolicLink()) unlinkSync(p); else rmSync(p, { recursive: true, force: true }); };

export async function uninstall(args, { home = userHome() } = {}) {
  const json = args.includes("--json"), dry = args.includes("--dry-run");
  const say = (s) => { if (!json) console.log(s); };
  const interactive = Boolean(process.stdin.isTTY) && !args.includes("--yes");
  let purge = args.includes("--purge");
  if (!interactive && !args.includes("--yes") && !dry) return { ok: false, error: "routr uninstall needs a terminal to ask, or --yes. Add --purge to remove your config, key, and ledger as well; --dry-run shows the plan" };

  // From a source checkout there is no installed binary of ours to remove: the launcher is the developer's own.
  let plan = uninstallPlan({ home, purge, binary: standalone() ? process.execPath : null });
  if (plan.blocked) return { ok: false, error: plan.blocked };
  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const show = (p) => { say("\nThis removes:"); for (const x of p.remove) say(`  ${x.path}   (${x.what})`); if (p.statusline) say("  the `routr statusline` entry in ~/.claude/settings.json (a backup is kept)"); if (p.keep.length || p.not_ours.length) { say("and keeps:"); for (const x of [...p.keep, ...p.not_ours]) say(`  ${x.path}   (${x.what})`); } };
    if (!purge && plan.keep.length && /^y/i.test((await rl.question("Also remove your config, decision provider keys, and ledger? [y/N] ")).trim())) {
      purge = true; plan = uninstallPlan({ home, purge, binary: standalone() ? process.execPath : null });
      if (plan.blocked) { rl.close(); return { ok: false, error: plan.blocked }; }
    }
    show(plan);
    const go = /^y/i.test((await rl.question("\nUninstall routr? [y/N] ")).trim());
    rl.close();
    if (!go) return { ok: true, removed: [], note: "nothing was removed" };
  }
  if (dry) return { ok: true, dry_run: true, would_remove: plan.remove.map((x) => x.path), would_keep: plan.keep.map((x) => x.path), not_ours: plan.not_ours.map((x) => x.path), statusline: plan.statusline };

  // Again now, under the uninstall lock: the person may have been asked for minutes, and a launch that reserves a run
  // folder from here on sees the lock and backs out (headless.mjs reserve). The lock goes with the state folder.
  const lock = UNINSTALL_LOCK(home);
  try { mkdirSync(join(home, ".local/state/routr"), { recursive: true, mode: 0o700 }); } catch {}
  if (!takeLock(lock, lockIsStale)) return { ok: false, error: `routr uninstall removed nothing: ${existsSync(lock) ? "another routr uninstall is running" : `it could not write ${lock}`}` };
  let late;
  try { late = blockedBy(leftovers(home), purge); } catch (e) { releaseLock(lock); throw e; }
  if (late) { releaseLock(lock); return { ok: false, error: late }; }
  const removed = [], failed = [], userFiles = [];
  if (plan.statusline) try {
    // Read again now: the plan may be minutes old (a person was asked), and the entry may have been replaced since.
    const file = join(home, ".claude/settings.json"), settings = JSON.parse(readFileSync(file, "utf8"));
    if (isOurStatusline(settings.statusLine?.command)) {
      copyFileSync(file, `${file}.bak-before-routr-uninstall`);
      delete settings.statusLine;
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
      removed.push("the statusline entry in ~/.claude/settings.json");
    }
  } catch (e) { failed.push(`~/.claude/settings.json: ${String(e?.message ?? e).slice(0, 100)}`); }
  let done, state;
  try { done = carryOut(plan, { home }); state = removeState(home, lock); }
  finally { releaseLock(lock); }
  removed.push(...done.removed, ...state.removed); failed.push(...done.failed, ...state.failed); userFiles.push(...done.userFiles);
  const notOurs = [...plan.not_ours, ...done.notOurs, ...state.notOurs];
  const result = { ok: !failed.length, removed, kept: plan.keep.map((x) => x.path), ...(notOurs.length ? { not_ours: notOurs.map((x) => x.path) } : {}),
    ...(userFiles.length ? { kept_files: userFiles } : {}), ...(failed.length ? { failed } : {}) };
  for (const p of removed) say(`removed ${p}`);
  for (const p of result.kept) say(`kept    ${p}`);
  for (const x of notOurs) say(`kept    ${x.path} (${x.what})`);
  for (const p of userFiles) say(`kept    ${p} (yours, in routr's skill folder)`);
  for (const f of failed) say(`FAILED  ${f}`);
  if (!failed.length) say(`\nroutr is uninstalled.${result.kept.length ? " Your config, key, and ledger are still there for a reinstall; `--purge` removes them." : ""}`);
  return result;
}

// routr's state folder, last, whether or not the plan saw it (taking the lock may have made it): everything in it but
// the uninstall lock, then the lock, then the folder itself, never recursively. While the lock is there a launch that
// reserves a run folder backs out; one that comes after finds no lock and keeps its folder, which then keeps this one
// (said, not removed). `between` is for a test to act at the moment the lock is the only thing left.
export function removeState(home, lock, { between = () => {} } = {}) {
  const root = join(home, ".local/state/routr"), removed = [], failed = [], notOurs = [];
  // A linked state folder is unlinked, never walked: what it points at is not known to be routr's (from #104's review).
  try { if (lstatSync(root).isSymbolicLink()) { releaseLock(lock); unlinkSync(root); removed.push(root); return { removed, failed, notOurs }; } }
  catch (e) { if (e?.code === "ENOENT") return { removed, failed, notOurs }; failed.push(`${root}: ${String(e?.message ?? e).slice(0, 100)}`); return { removed, failed, notOurs }; }
  let names = [];
  try { names = readdirSync(root); } catch (e) { if (e?.code !== "ENOENT") failed.push(`${root}: could not read it`); return { removed, failed, notOurs }; }
  for (const n of names) if (join(root, n) !== lock) try { removePath(join(root, n)); } catch (e) { failed.push(`${join(root, n)}: ${String(e?.message ?? e).slice(0, 100)}`); }
  between();
  if (failed.length) return { removed, failed, notOurs }; // the lock goes in uninstall's finally; the folder stays
  releaseLock(lock);
  try { rmdirSync(root); removed.push(root); }
  catch (e) { if (e?.code === "ENOTEMPTY" || e?.code === "EEXIST") notOurs.push({ path: root, what: "written there while routr was uninstalling (a worker launched since?)" }); else failed.push(`${root}: ${String(e?.message ?? e).slice(0, 100)}`); }
  return { removed, failed, notOurs };
}
// Only a lock that still holds this process's pid is ours to remove.
export const releaseLock = (lock) => { try { if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock); } catch {} };

// Remove what the plan lists. Each skill place is checked again right before it is touched: from the final review,
// ownership was settled before the confirmation prompt and acted on after it, so a folder swapped in while the prompt
// waited (a user's own skill, no manifest) lost its SKILL.md and agents/openai.yaml. A place that is no longer routr's
// (owner(), the linked-folder rule for pre-manifest folders included) is kept and reported in `notOurs`; one already
// gone is nothing to do.
export function carryOut(plan, { home = userHome() } = {}) {
  const removed = [], failed = [], userFiles = [], notOurs = [];
  for (const x of plan.remove) {
    if (x.state) continue; // removeState, last, around the uninstall lock
    try {
      if (x.skill) {
        const now = owner(home, x.skill, x.path);
        if (now === "absent") continue;
        if (now !== "ours") { notOurs.push({ path: x.path, what: `${notOursWhy(home, x.skill, x.path)} (it changed after the plan was made)` }); continue; }
      }
      if (x.path === process.execPath && process.platform === "win32") {
        // Windows will not delete a running program. Move it aside (allowed), then a detached `cmd` deletes it once we exit.
        const aside = `${x.path}.old`; rmSync(aside, { force: true }); renameSync(x.path, aside);
        // The name goes into a `cmd` line unquoted, so only a plain one is allowed there; anything else is left for the user.
        if (!/^[\w.-]+$/.test(basename(aside))) throw new Error(`moved aside as ${aside}; delete that file yourself`);
        // Run from the binary's folder with a bare file name: a quoted path does not survive argument quoting on its way to `cmd` (seen: the file stayed).
        start("cmd", ["/c", `ping -n 4 127.0.0.1 >nul & del /f /q ${basename(aside)}`], { cwd: dirname(aside), detached: true, stdio: "ignore" }).unref();
      } else if (x.skill) {
        // routr's skill: only the files its manifest lists, then the folders left empty. A file the user added stays.
        // A file it could not remove (or would have to follow a link to reach) is a failure; the manifest then stays.
        const out = removeOwned(x.path, x.skill);
        failed.push(...out.failed);
        userFiles.push(...out.left.map((f) => join(x.path, f)));
        if (out.failed.length || out.left.length) { if (!out.failed.length) removed.push(`${x.path} (routr's files)`); continue; }
      } else removePath(x.path);
      removed.push(x.path);
    } catch (e) { failed.push(`${x.path}: ${String(e?.message ?? e).slice(0, 100)}`); }
  }
  return { removed, failed, userFiles, notOurs };
}
