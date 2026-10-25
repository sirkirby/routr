// Live check that the trace-context carriers routr passes to a pane it splits arrive exactly, inside a live herdr
// session on THIS machine. Run after updating herdr, and before a release that changes worker environment handling
// (AGENTS.md, CONTRIBUTING.md), from a pane of a herdr session:
//   bun run smoke:carriers
// 1. Splits a pane with routr's own split code, its carriers hostile but valid (`%` `"` `&` `!` `;` `,` `=` TAB and
//    spaces, each value exactly at routr's limit), starts a small fixture in that pane's shell that writes its
//    environment to a file, checks each value arrived byte for byte, and closes the pane.
// 2. macOS and Linux: splits another pane, its carriers short markers, and `herdr agent start`s the installed Claude
//    Code there with no task, reads that agent's own environment (`ps eww -o command= -p <pid>` on macOS,
//    /proc/<pid>/environ on Linux), looks for each NAME=value whole, and closes the pane. There is no ordinary way to
//    read another process's environment on Windows, so this half is posix only. No task is sent, so no subscription is
//    spent (Claude may stop at its folder-trust screen; its process is there all the same). The environment read is
//    the harness's own: the process started as `claude`, or running the file `claude` on PATH resolves to; a wrapper
//    in front of it, or no such process, fails the check.
// 3. Makes a throwaway git repository in its temporary folder (never the checkout it runs from), and opens a worker's
//    pane in a new worktree of it with routr's own worktree steps (worktree create, a split of the root pane with the
//    carriers, the root closed), one carrier left out. Checks the workspace holds only the new pane, that the new pane's
//    shell got the values byte for byte and the one left out empty (not the herdr server's own), then removes the
//    worktree and its workspace with `herdr worktree remove`, and the repository with the temporary folder. With no
//    workspace open for a repository, herdr's worktree create opens one for the source checkout too (seen 2026-10-25,
//    herdr 0.9.5: a workspace on the throwaway repository, not a linked worktree, one shell pane), so every workspace
//    whose checkout is inside the temporary folder is closed before the folder goes, found by its checkout path, and
//    no other. launch does not do this: a lead's repository has its workspace open already.
// Every pane it made is closed at the end, however the run went; a pane it could not close is named, and fails it, and
// so does a worktree it could not remove.
// Why the halves differ: ps prints a process's environment as one line, entries separated by spaces, so it cannot show
// a value holding a TAB or a space exactly, and the live run (herdr 0.9.5, macOS zsh, 2026-10-24) found the hostile
// values at their limits missing from ps's text while short ones were there exactly. So the shell half proves the
// bytes (its fixture writes its own environment as JSON), and the agent half proves only that the agent inherits what
// its pane's shell has, with markers of letters, digits, `-` and `_` that ps shows unambiguously.
// Writes only in a temporary folder it removes, and the worktree herdr makes for its repository, which it removes. Prints carrier names, never values. Exits 1 when a check fails.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, win32 } from "node:path";
import { deadline, paneView, quote, runHerdr, splitArgs, waitForShell, worktreeArgs, worktreePane } from "../src/lib/herdr.mjs";
import { worktreesFromGit } from "../src/lib/cleanup.mjs";
import { displayCommand } from "../src/lib/next.mjs";
import { processError } from "../src/lib/process-boundary.mjs";
import { CARRIERS, carriersFrom, installedAt, probe, realOr } from "../src/lib/runtime.mjs";

const LIMITS = { TRACEPARENT: 512, TRACESTATE: 512, BAGGAGE: 8192 };
// What a shell or herdr could take for something else: quotes, expansions, separators, TAB and spaces.
export const HOSTILE = "%PATH% \"q\" 'q' & ! ; , = \t $HOME `x` a=b,c=d";
// Each carrier: its marker, the hostile characters, padded to exactly routr's limit for it.
export function hostileCarriers(tag = randomUUID().slice(0, 8)) {
  return Object.fromEntries(CARRIERS.map((name) => {
    const head = `routr-smoke-${tag}-${name}:${HOSTILE}:`;
    return [name, head + "x".repeat(LIMITS[name] - head.length)];
  }));
}
// One short marker per carrier, of characters ps shows unambiguously (letters, digits, - and _): the agent half's.
// TRACEPARENT is shaped as a valid one (version, trace id, span id, flags) in case the harness reads it.
export function agentCarriers(tag = randomUUID().replace(/-/g, "").slice(0, 8)) {
  const hex = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  return { TRACEPARENT: `00-${hex.slice(0, 32)}-${hex.slice(32, 48)}-01`, TRACESTATE: `routr_smoke-${tag}-ts`, BAGGAGE: `routr_smoke-${tag}-bg` };
}
// The worktree half's carriers: `sent` without `left` (one routr does not have), and what the pane's shell must then
// hold: the others exactly, and `left` empty, whatever the herdr server has.
export function leftOut(sent, left = "TRACESTATE") {
  const passed = Object.fromEntries(Object.entries(sent).filter(([name]) => name !== left));
  return { passed, expected: { ...passed, [left]: "" } };
}
// The ids of the workspaces (`workspace list`'s) whose checkout is `dir` or inside it: by path, never by name.
// Compared as routr compares paths, through each one's real path, and with the platform's own rules: on Windows any
// case and either slash, a path on another drive never inside. `platform` is a test seam; a real path is read only on
// the platform this runs on.
export function workspacesIn(workspaces, dir, { platform = process.platform } = {}) {
  const P = platform === "win32" ? win32 : posix, canon = (p) => (platform === process.platform ? realOr(p) : p);
  const under = (p) => {
    if (typeof p !== "string" || !P.isAbsolute(p)) return false;
    const rel = P.relative(canon(dir), canon(p));
    return rel === "" || (!rel.startsWith("..") && !P.isAbsolute(rel));
  };
  return (workspaces ?? []).filter((w) => under(w?.worktree?.checkout_path)).map((w) => w.workspace_id);
}
// The carriers `sent` that `got` (an environment object) does not hold exactly.
export const missingIn = (got, sent) => Object.keys(sent).filter((name) => got?.[name] !== sent[name]);
// The carriers `sent` (short markers: no space or TAB) not found whole as NAME=value in a process's environment as
// text: /proc/<pid>/environ (NUL-separated entries), or ps's line (the command, then each entry after a space).
export function missingInText(text, sent) {
  const entries = new Set(String(text).split(/[\0\s]+/));
  return Object.keys(sent).filter((name) => !entries.has(`${name}=${sent[name]}`));
}
// What is typed into the pane's shell to start the fixture: the runtime and the script, quoted for that shell.
export const fixtureCommand = (shell, exe, script) => (shell === "posix" ? `${quote(exe)} ${quote(script)}`
  : shell === "powershell" ? `& '${exe.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'` : `"${exe}" "${script}"`);
const FIXTURE = (out) => `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n`;
// The program a process was started as: the first word of `ps -o command=` (a path with a space is not told apart), or
// the first entry of /proc/<pid>/cmdline.
export const argv0Of = (text, { proc = false } = {}) => (proc ? String(text).split("\0")[0] : String(text).trim().split(/\s+/)[0]) || null;
// Whether a process is the harness itself, not a wrapper, shell or helper in front of it: started as `claude` (by name
// or path), or as the file the `claude` on PATH resolves to (`installed`), or running that file (`exe`, Linux). Read
// from ps or /proc: routr's herdr boundary keeps only shell names from `pane process-info`.
export const isHarness = ({ argv0, exe = null }, { name = "claude", installed = null } = {}) => {
  if (argv0 && basename(argv0) === name) return true;
  if (installed == null) return false;
  return exe === installed || (Boolean(argv0) && (argv0 === installed || (isAbsolute(argv0) && realOr(argv0) === installed)));
};

const gitIn = (dir, args) => probe("git", ["-C", dir, ...args], { separate: true });
// The check itself; `herdr` (the transport), `git(dir, args)`, `env` and `log` are seams the tests give.
export async function smokeCarriers({ herdr = runHerdr, git = gitIn, env = process.env, log = console.log } = {}) {
  if (env.HERDR_ENV !== "1") { log("smoke:carriers runs inside a herdr pane (HERDR_ENV=1); nothing done"); return 1; }
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "routr-smoke-carriers-")));
  const sent = hostileCarriers();
  const call = async (a, ms = 15000) => { const r = await herdr(a, ms); if (!r.ok) throw processError(r); return r; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Every pane this run made, from the moment herdr names it: all are closed at the end, however the run ended.
  const panes = [];
  let failed = 0;
  const say = (what, missing) => { if (missing.length) failed++; log(`${what}: ${missing.length ? `FAILED (${missing.join(", ")} did not arrive exactly)` : `ok (${CARRIERS.join(", ")} arrived exactly)`}`); };
  // `pane`'s shell at a prompt in `cwd`: its family.
  const shellOf = async (pane, cwd, what = "the pane's shell") => {
    let shell = "posix";
    const r = await waitForShell(paneView(call, pane), { sleep, now: () => performance.now(), remaining: deadline(30000, () => performance.now(), `${what} did not come to a prompt in 30 s`), cwd,
      onShell: (name) => { shell = /^(pwsh|powershell)/i.test(name) ? "powershell" : /^cmd/i.test(name) ? "cmd" : "posix"; } });
    if (!r.ok) throw new Error(`${what}: ${r.why}`);
    return shell;
  };
  // A pane split with `carriers`, its shell at a prompt.
  const split = async (carriers) => {
    const pane = (await call(splitArgs("down", dir, carriers))).data.result.pane.pane_id;
    panes.push(pane);
    return { pane, shell: await shellOf(pane, dir) };
  };
  // Starts the fixture in `pane`'s shell; the environment it saw, or null if it wrote none within 15 s.
  const envIn = async (pane, shell, name) => {
    const script = join(dir, `${name}.cjs`), out = join(dir, `${name}.json`);
    writeFileSync(script, FIXTURE(out));
    await call(["pane", "run", pane, fixtureCommand(shell, process.execPath, script)]);
    for (let i = 0; i < 60; i++) { await sleep(250); try { return JSON.parse(readFileSync(out, "utf8")); } catch {} }
    return null;
  };
  // The harness's own process among the pane's foreground ones, once it is there; null if none is within 10 s.
  const harnessIn = async (pane) => {
    const installed = installedAt("claude");
    for (let i = 0; i < 40; i++) {
      const info = (await call(["pane", "process-info", "--pane", pane])).data.result.process_info;
      for (const { pid } of info.foreground_processes.filter((p) => p.pid !== info.shell_pid)) {
        const who = process.platform === "linux"
          ? { argv0: argv0Of((() => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return ""; } })(), { proc: true }), exe: (() => { try { return realpathSync.native(`/proc/${pid}/exe`); } catch { return null; } })() }
          : { argv0: argv0Of((await probe("/bin/ps", ["-o", "command=", "-p", String(pid)], { separate: true }))?.out ?? "") };
        if (isHarness(who, { installed })) return pid;
      }
      await sleep(250);
    }
    return null;
  };
  try {
    if (carriersFrom(sent).withheld.length) throw new Error("the smoke's own carriers are outside routr's limits");
    {
      const { pane, shell } = await split(sent);
      const got = await envIn(pane, shell, "split");
      say(`split pane, ${shell} shell`, got ? missingIn(got, sent) : CARRIERS);
    }
    if (process.platform === "win32") log("agent: not checked on Windows (another process's environment cannot be read there)");
    else {
      const markers = agentCarriers();
      const { pane } = await split(markers);
      const started = await herdr(["agent", "start", "routr-smoke-carriers", "--kind", "claude", "--pane", pane, "--timeout", "20000"], 25000);
      if (!started.ok && !["agent_not_ready", "timeout"].includes(started.data?.error?.code)) throw processError(started);
      const pid = await harnessIn(pane);
      if (!pid) throw new Error("no process in the pane is Claude Code itself (by its argv0, or the file `claude` on PATH resolves to): its environment was not read");
      const text = process.platform === "linux" ? readFileSync(`/proc/${pid}/environ`, "utf8") : (await probe("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { separate: true }))?.out ?? "";
      say(`agent (claude, pid ${pid})`, missingInText(text, markers));
    }
  } catch (e) { failed++; log(`FAILED: ${e?.message ?? e}`); }
  finally {
    for (const pane of panes) {
      let r; try { r = await herdr(["pane", "close", pane], 5000); } catch { r = { ok: false, code: "herdr_unreachable" }; }
      if (!r?.ok) { failed++; log(`FAILED: could not close pane ${pane} (${r?.code ?? "no answer"}); close it yourself`); }
    }
  }
  // The worktree half, on its own: a failure above does not skip it. Its pane is never closed by itself (that would
  // close the workspace and leave the worktree); removing the worktree closes the workspace.
  const repo = join(dir, "repo");
  let workspace = null, tree = null, created = false;
  try {
    const branch = `routr-smoke-${randomUUID().slice(0, 8)}`;
    mkdirSync(repo);
    for (const a of [["init", "-q"], ["-c", "user.name=routr smoke", "-c", "user.email=smoke@routr.invalid", "commit", "-q", "--allow-empty", "-m", "routr smoke"]]) {
      const r = await git(repo, a);
      if (r?.code !== 0) throw new Error(`git ${a.includes("init") ? "init" : "commit"} in the throwaway repository failed`);
    }
    created = true; // from here on, herdr may have made a worktree whatever it answers
    const made = (await call(worktreeArgs(repo, branch))).data?.result;
    workspace = made?.workspace?.workspace_id ?? null; tree = made?.worktree?.path ?? null;
    if (typeof made?.root_pane?.pane_id !== "string" || !workspace || !tree) throw new Error("herdr worktree create returned an answer this check cannot read");
    const { passed, expected } = leftOut(sent);
    const { pane, closed } = await worktreePane((a, _shown, tolerate) => (tolerate ? herdr(a, 15000) : call(a)), made.root_pane.pane_id, tree, passed);
    if (!closed) { failed++; log(`FAILED: could not close the worktree's root pane ${made.root_pane.pane_id}`); }
    const left = ((await call(["pane", "list", "--workspace", workspace])).data?.result?.panes ?? []).map((p) => p.pane_id);
    if (left.length !== 1 || left[0] !== pane) { failed++; log(`FAILED: the worktree's workspace holds ${left.length} panes, not only the new one`); }
    const shell = await shellOf(pane, tree, "the worktree pane's shell");
    const got = await envIn(pane, shell, "worktree");
    say(`worktree pane, ${shell} shell, one carrier empty`, got ? missingIn(got, expected) : CARRIERS);
  } catch (e) { failed++; log(`FAILED: worktree: ${e?.message ?? e}`); }
  finally {
    // The folder goes only once nothing in it is still in use: the worktree removed (its git metadata is in the
    // repository, so a removal that failed or cannot be known keeps the repository for the retry), and every workspace
    // on the folder closed. Each part kept is named, with its exact path.
    let keep = false;
    const fail = (why) => { failed++; keep = true; log(`FAILED: ${why}`); };
    // herdr's workspaces, or null when it did not give a list: never an empty one in its place.
    const listWorkspaces = async () => { try { const r = await herdr(["workspace", "list"], 5000); const all = r?.ok ? r.data?.result?.workspaces : null; return Array.isArray(all) ? all : null; } catch { return null; } };
    // What a create that failed, or answered unusably, made: the repository's own worktree list says (it is new, so
    // any linked worktree is this run's), and herdr's workspaces which one is that worktree's.
    if (created && !tree) {
      const r = await git(repo, ["worktree", "list", "--porcelain"]);
      if (r?.code === 0 && typeof r.out === "string") tree = worktreesFromGit(r.out).worktrees.find((w) => w.is_linked_worktree)?.path ?? null;
      else fail(`git could not list the worktrees of the throwaway repository at ${repo}, so whether herdr made one is not known; it is kept: look with ${displayCommand(["git", "-C", repo, "worktree", "list"])}`);
    }
    // A worktree with no workspace known is removed through git only once herdr's list answered and shows none for it:
    // git's remove would leave an open workspace behind, outside the folder, where nothing here would close it.
    let placed = true;
    if (tree && !workspace) { const all = await listWorkspaces(); placed = all != null; workspace = all && (workspacesIn(all, tree)[0] ?? null); }
    if (tree && !placed) {
      fail(`herdr's workspaces could not be listed, so whether the worktree at ${tree} has a workspace open is not known; the throwaway repository at ${repo} is kept for it: find its workspace with ${displayCommand(["herdr", "workspace", "list"])} and remove it with herdr worktree remove --workspace <id>, or if it has none, ${displayCommand(["git", "-C", repo, "worktree", "remove", tree])}; then remove the folder ${dir}`);
    } else if (tree) {
      // Through herdr when the worktree has a workspace (that closes it too), else through git; never forced.
      const retry = workspace ? ["herdr", "worktree", "remove", "--workspace", workspace] : ["git", "-C", repo, "worktree", "remove", tree];
      let ok = false;
      try { ok = workspace ? (await herdr(retry.slice(1), 15000))?.ok === true : (await git(repo, retry.slice(3)))?.code === 0; } catch {}
      if (!ok || existsSync(tree)) fail(`could not remove the worktree at ${tree}; the throwaway repository at ${repo} is kept for it: remove it with ${displayCommand(retry)}, then the folder ${dir}`);
    }
    const all = await listWorkspaces(), own = all && workspacesIn(all, dir);
    if (own == null) fail(`could not list herdr's workspaces to close any on the throwaway repository; ${dir} is kept: close any workspace on it, then remove it`);
    for (const id of own ?? []) {
      let r; try { r = await herdr(["workspace", "close", id], 5000); } catch { r = { ok: false, code: "herdr_unreachable" }; }
      if (!r?.ok) fail(`could not close workspace ${id}, on the throwaway repository (${r?.code ?? "no answer"}); ${dir} is kept: close it with ${displayCommand(["herdr", "workspace", "close", id])}, then remove the folder`);
    }
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}
if (import.meta.main) process.exitCode = (await smokeCarriers()) ? 1 : 0;
