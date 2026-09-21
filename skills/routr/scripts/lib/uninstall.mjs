// `routr uninstall`: remove what the installer and `routr setup` put on this machine. By default the user's own data
// stays (config, TypeSafe key, ledger), as with a typical uninstall; `--purge` removes that too. A person is shown the
// plan and asked; an agent or a script must pass `--yes`. Worktrees and herdr panes belong to the user's repos, not to routr.
import { spawn } from "node:child_process";
import { copyFileSync, lstatSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

const OURS = /routr(\.exe)?"? statusline/; // only a statusline that setup (or the guide) pointed at routr

// What would be removed, as data: a test can check the plan without touching a disk.
export function uninstallPlan({ home = homedir(), purge = false, binary = null } = {}) {
  const remove = [], keep = [];
  if (binary) remove.push({ path: binary, what: "the routr binary" });
  for (const rel of [".claude/skills/routr", ".agents/skills/routr"]) remove.push({ path: join(home, rel), what: "the routr skill" });
  remove.push({ path: join(home, ".cache/routr"), what: "cache: the Claude usage snapshot and the update log" });
  const data = [{ path: join(home, ".config/routr"), what: "your config and TypeSafe key" }, { path: join(home, ".local/share/routr"), what: "your ledger" }];
  (purge ? remove : keep).push(...data);
  const present = (l) => l.filter((x) => { try { lstatSync(x.path); return true; } catch { return false; } });
  let statusline = false;
  try { statusline = OURS.test(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).statusLine?.command ?? ""); } catch {}
  return { remove: present(remove), keep: present(keep), statusline };
}

// A link is unlinked, never followed: a developer's skill folder is a link into their checkout.
function removePath(p) { if (lstatSync(p).isSymbolicLink()) unlinkSync(p); else rmSync(p, { recursive: true, force: true }); }

export async function uninstall(args, { home = homedir() } = {}) {
  const standalone = !/\.m?js$/.test(process.argv[1] ?? "");
  const json = args.includes("--json"), dry = args.includes("--dry-run");
  const say = (s) => { if (!json) console.log(s); };
  const interactive = Boolean(process.stdin.isTTY) && !args.includes("--yes");
  let purge = args.includes("--purge");
  if (!interactive && !args.includes("--yes") && !dry) return { ok: false, error: "routr uninstall needs a terminal to ask, or --yes. Add --purge to remove your config, key, and ledger as well; --dry-run shows the plan" };

  // From a source checkout there is no installed binary of ours to remove: the launcher is the developer's own.
  let plan = uninstallPlan({ home, purge, binary: standalone ? process.execPath : null });
  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const show = (p) => { say("\nThis removes:"); for (const x of p.remove) say(`  ${x.path}   (${x.what})`); if (p.statusline) say("  the `routr statusline` entry in ~/.claude/settings.json (a backup is kept)"); if (p.keep.length) { say("and keeps:"); for (const x of p.keep) say(`  ${x.path}   (${x.what})`); } };
    if (!purge && plan.keep.length && /^y/i.test((await rl.question("Also remove your config, TypeSafe key, and ledger? [y/N] ")).trim())) { purge = true; plan = uninstallPlan({ home, purge, binary: standalone ? process.execPath : null }); }
    show(plan);
    const go = /^y/i.test((await rl.question("\nUninstall routr? [y/N] ")).trim());
    rl.close();
    if (!go) return { ok: true, removed: [], note: "nothing was removed" };
  }
  if (dry) return { ok: true, dry_run: true, would_remove: plan.remove.map((x) => x.path), would_keep: plan.keep.map((x) => x.path), statusline: plan.statusline };

  const removed = [], failed = [];
  if (plan.statusline) try {
    const file = join(home, ".claude/settings.json"), settings = JSON.parse(readFileSync(file, "utf8"));
    copyFileSync(file, `${file}.bak-before-routr-uninstall`);
    delete settings.statusLine;
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    removed.push("the statusline entry in ~/.claude/settings.json");
  } catch (e) { failed.push(`~/.claude/settings.json: ${String(e?.message ?? e).slice(0, 100)}`); }
  for (const x of plan.remove) {
    try {
      if (x.path === process.execPath && process.platform === "win32") {
        // Windows will not delete a running program. Move it aside (allowed), then a detached `cmd` deletes it once we exit.
        const aside = `${x.path}.old`; rmSync(aside, { force: true }); renameSync(x.path, aside);
        // Run from the binary's folder with a bare file name: a quoted path does not survive argument quoting on its way to `cmd` (seen: the file stayed).
        spawn("cmd", ["/c", `ping -n 4 127.0.0.1 >nul & del /f /q ${basename(aside)}`], { cwd: dirname(aside), detached: true, stdio: "ignore", windowsHide: true }).unref();
      } else removePath(x.path);
      removed.push(x.path);
    } catch (e) { failed.push(`${x.path}: ${String(e?.message ?? e).slice(0, 100)}`); }
  }
  const result = { ok: !failed.length, removed, kept: plan.keep.map((x) => x.path), ...(failed.length ? { failed } : {}) };
  for (const p of removed) say(`removed ${p}`);
  for (const p of result.kept) say(`kept    ${p}`);
  for (const f of failed) say(`FAILED  ${f}`);
  if (!failed.length) say(`\nroutr is uninstalled.${result.kept.length ? " Your config, key, and ledger are still there for a reinstall; `--purge` removes them." : ""}`);
  return result;
}
