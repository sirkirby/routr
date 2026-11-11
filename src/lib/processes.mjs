// Every process routr starts, and how: the platform defaults, the Windows command shims, stopping a child and what it
// started, a detached copy of routr, a browser, a harness read. It is the only module that imports node:child_process (a
// test holds every other file in src/ to that), so every process routr starts gets the same platform defaults from
// `start` / `startSync`. What environment each one gets is the worker-environment module's.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { accountEnv, envGet, harnessEnv } from "./worker-env.mjs";

// Bun's compiled module lives in its virtual filesystem (1.4.3: /$bunfs on POSIX, B:/~BUN on Windows).
// The importing script is not routr: smoke:otel's in-process launch exposed argv[1] re-entry, 2026-10-25.
let COMPILED = false, ROUTR_ENTRY = null;
try { COMPILED = /^(?:\/\$bunfs\/|[A-Za-z]:\/~BUN\/)/i.test(fileURLToPath(import.meta.url).replaceAll("\\", "/")); } catch {} // A URL probe failure falls back to source, never to the caller's argv.
if (!COMPILED) try { ROUTR_ENTRY = fileURLToPath(new URL("../routr.mjs", import.meta.url)); } catch {}
export const standalone = () => COMPILED;

// routr's defaults for every process it starts. windowsHide: on Windows a console program started by a process that has
// no console of its own (a detached background job: the Cursor or Kiro refresh, the updater) gets a NEW console, which
// Windows 11 opens as a Windows Terminal window: QA saw 20 to 70 windows flash per Cursor refresh, one per herdr poll,
// before every start came through here. Off Windows the option does nothing. It is forced, never left to the caller.
// The one exception asks for it by `visible: true`: a harness run for a person in a terminal of its own (a terminal
// worker's runner) keeps that terminal's console, which a hidden start would take from it. Not measured on Windows.
export const startOptions = ({ visible = false, ...opts } = {}) => ({ ...opts, windowsHide: !visible });
// Start a process with those defaults: `start` as node's spawn, `startSync` as spawnSync, the command resolved on
// Windows as below. `via` and `platform` are test seams.
// `account`: an extra account's variables, over the environment given (the worker-environment module's accountEnv).
const prepare = (cmd, args = [], opts = {}, platform = process.platform) => {
  if (platform !== "win32") return [cmd, args, startOptions(opts)];
  const w = windowsCommand(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd ?? process.cwd() });
  return [w.cmd, w.args, startOptions(w.verbatim ? { ...opts, windowsVerbatimArguments: true } : opts)];
};
export const start = (cmd, args, opts, { via = spawn, platform, account } = {}) => {
  if (account) opts = { ...opts, env: accountEnv(opts?.env ?? process.env, account, { platform }) };
  return via(...prepare(cmd, args, opts, platform));
};
export const startSync = (cmd, args, opts, { via = spawnSync, platform } = {}) => via(...prepare(cmd, args, opts, platform));

// Open one file in the default browser. Direct, never through a shell: `open` on macOS, `xdg-open` on Linux,
// `rundll32 url.dll,FileProtocolHandler` on Windows. A missing program or any exit but 0 is a failed open; the
// caller still has the path. Ten seconds, then the opener is killed, so one that does not exit cannot hold the command.
export function browserArgv(file, platform = process.platform) {
  const path = resolve(file);
  if (platform === "darwin") return ["open", path];
  if (platform === "linux") return ["xdg-open", path];
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", path];
  return null;
}
export function openInBrowser(file, { platform = process.platform, start = startSync } = {}) {
  const argv = browserArgv(file, platform);
  if (!argv) return false;
  try {
    const r = start(argv[0], argv.slice(1), { stdio: "ignore", env: harnessEnv(), timeout: 10_000, killSignal: "SIGKILL" });
    return r?.status === 0 && !r.error;
  } catch { return false; }
}

// Windows: a command resolved as the shell would. A CLI installed with npm is a `.cmd` shim (`%APPDATA%\npm\codex.cmd`),
// and child_process without a shell neither finds it by its bare name nor starts it. Measured on windows-latest,
// 2026-10-05, Bun 1.4.2 (test/windows-shims.test.mjs): `codex`-style bare names failed with ERR_INVALID_ARG_VALUE, a
// `.cmd` by name or full path with EINVAL, so run() and probe() answered null and every such harness read as not
// installed; `cmd.exe /d /s /c` with windowsVerbatimArguments started the same file. So, before every start:
//   - a bare name is looked up in PATH with PATHEXT (case-insensitive), a name with an extension or a folder as given;
//     the current folder is not searched first, as cmd would (a planted `codex.cmd` in a work tree is the classic hijack);
//     a relative PATH entry or command is taken from the folder the child starts in (its `cwd`), and what is started
//     is always the absolute path that was checked;
//   - `.exe`/`.com` start directly;
//   - npm's own shim starts `node` on its script directly, the node the shim would pick (its folder's node.exe, else
//     node on PATH): no shell and no quoting;
//   - any other `.cmd`/`.bat` starts through `cmd.exe /d /s /c` with every argument quoted for cmd (cmdLine below).
// A name not found fails the start with ENOENT, as a missing program does: passed on bare, libuv's own search would
// look in the current folder first, the hijack the lookup avoids. Through cmd.exe
// or node the CLI runs one or more processes below the child routr holds, so a timeout stops the tree (stop, below).
const RUNNABLE = [".com", ".exe", ".bat", ".cmd"];
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const readSmall = (p) => { try { return statSync(p).size < 65536 ? readFileSync(p, "utf8") : ""; } catch { return ""; } };

// The file a shell would start for `cmd`, or null. Only extensions both PATHEXT and CreateProcess-or-cmd can start count:
// PATHEXT also lists .JS and .VBS, which cmd would hand to Windows Script Host (an npm shim strips .JS for that reason).
// doctor finds harnesses with this too, so what it reports found is what start() can start. `path` replaces PATH's
// folders (doctor's look in the usual install folders that are not on PATH).
export function resolveCommand(cmd, { env = process.env, cwd = process.cwd(), exists = isFile, path = envGet(env, "PATH") } = {}) {
  const exts = (envGet(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => RUNNABLE.includes(e));
  const tries = (base) => { base = win32.resolve(cwd, base); return [...(win32.extname(base) ? [base] : []), ...exts.map((e) => base + e)].find(exists) ?? null; };
  if (/[\\/]/.test(cmd) || /^[a-z]:/i.test(cmd)) return tries(cmd);
  for (const dir of String(path ?? "").split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1"))) {
    const hit = dir && tries(win32.join(dir, cmd));
    if (hit) return hit;
  }
  return null;
}

// POSIX: the file a bare command name runs, the first executable file of that name on PATH as a shell finds it,
// its links followed; null when there is none, when a relative or empty PATH entry comes first (the file would
// depend on the folder it runs in), and on Windows, where nothing asks yet.
export function installedAt(cmd, { env = process.env, platform = process.platform } = {}) {
  if (platform === "win32") return null;
  for (const dir of String(env.PATH ?? "").split(":")) {
    if (!dir.startsWith("/")) return null;
    try { const p = join(dir, cmd); accessSync(p, constants.X_OK); if (statSync(p).isFile()) return realpathSync.native(p); } catch {}
  }
  return null;
}

// npm's cmd-shim for a `#!/usr/bin/env node` bin, matched whole and in order: the form cmd-shim 7.0.0 and 8.0.0 write
// (PATHEXT set inside the ELSE) and 9.0.2's (set on the run line), each read from its source. Only the script path may
// differ; blank lines and indentation are ignored. The shim sets dp0 to its own folder, picks `%dp0%\node.exe` or
// `node`, and runs `"%_prog%"  "%dp0%\<script>" %*`. Returns that script, relative to the shim's folder, or null for
// anything else: a line added, moved or repeated (an `exit /b` before the run line would never reach it), a shebang
// with arguments or variables, another program than node, pnpm's shim (it also sets NODE_PATH), an older form. Those
// go through cmd.exe, which runs them exactly as written.
const SHIM_HEAD = ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
  'IF EXIST "%dp0%\\node.exe" (', 'SET "_prog=%dp0%\\node.exe"', ") ELSE (", 'SET "_prog=node"'];
const SHIM_RUN = "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ";
const NPM_SHIMS = [
  [...SHIM_HEAD, "SET PATHEXT=%PATHEXT:;.JS;=;%", ")", `${SHIM_RUN}"%_prog%"  "%dp0%\\<script>" %*`],
  [...SHIM_HEAD, ")", `${SHIM_RUN}set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\<script>" %*`],
];
export function npmShimScript(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const form of NPM_SHIMS) {
    if (lines.length !== form.length || form.some((l, i) => i < form.length - 1 && lines[i] !== l)) continue;
    const [before, after] = form.at(-1).split("<script>"), last = lines.at(-1);
    const script = last.startsWith(before) && last.endsWith(after) ? last.slice(before.length, last.length - after.length) : "";
    if (/^[^"%]+$/.test(script)) return script;
  }
  return null;
}

// cmd.exe's own parse, then the C runtime's argv parse in the program it starts (cross-spawn's rules, which Node's docs
// point to): each argument is quoted for the C runtime (backslashes doubled before a quote and at the end), then every
// cmd metacharacter, the quotes included, is escaped with ^. Twice: a shim hands its arguments on with %*, and cmd parses
// that expanded line again, so one escape would leave `a"&b` able to run `b` (cross-spawn escapes npm shims twice for
// the same reason). Every .cmd a CLI installs forwards %* that way (npm, pnpm, yarn, scoop). That assumes exactly one
// such re-parse: a wrapper that CALLs another batch file with %*, or turns on delayed expansion, parses again, and that
// is not measured (the carets would be off by one pass). A line break cannot cross cmd at all, so such an argument is
// refused rather than cut.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
export const cmdArg = (arg) => {
  const s = String(arg);
  if (/[\r\n\0]/.test(s)) throw new Error("an argument with a line break cannot be passed through cmd.exe");
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
};
export const cmdLine = (file, args) => [file.replace(CMD_META, "^$1"), ...args.map(cmdArg)].join(" ");

// What to start for `cmd args` on Windows: { cmd, args, verbatim } (verbatim: hand the line to cmd.exe as it is).
export function windowsCommand(cmd, args = [], { env = process.env, cwd = process.cwd(), exists = isFile, read = readSmall, depth = 0 } = {}) {
  const file = resolveCommand(cmd, { env, cwd, exists });
  if (!file) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT", errno: -4058, syscall: `spawn ${cmd}`, path: cmd });
  if (!/\.(cmd|bat)$/i.test(file)) return { cmd: file, args };
  const script = npmShimScript(read(file)), dir = win32.dirname(file);
  if (script && depth < 2 && exists(win32.join(dir, script))) {
    const local = win32.join(dir, "node.exe");
    return windowsCommand(exists(local) ? local : "node", [win32.join(dir, script), ...args], { env, cwd, exists, read, depth: depth + 1 });
  }
  const comspec = envGet(env, "ComSpec") || win32.join(envGet(env, "SystemRoot") || "C:\\Windows", "System32", "cmd.exe");
  return { cmd: comspec, args: ["/d", "/s", "/c", `"${cmdLine(file, args)}"`], verbatim: true };
}

// Stop a child routr no longer waits for (a timeout, or `until` has its answer), and on Windows all it started:
// a .cmd runs the CLI under cmd.exe, and an npm shim's node may start the CLI's own binary, so killing the child
// alone would leave the CLI running. `taskkill /T /F` walks the tree by parent id, so it runs while the child
// is still there, and never for a child that has exited (its pid may belong to another process by then). If
// taskkill cannot start, exits non-zero, or has not finished within KILL_GRACE_MS, the child alone is killed,
// unless it has exited meanwhile (a failing taskkill used to leave the child running). Off Windows a SIGTERM,
// then SIGKILL after KILL_GRACE_MS if the child is still there: a CLI that ignores SIGTERM survived the one
// signal. The caller has its answer already; the grace timers are unref'd, so they never hold routr's exit. For
// herdr (runHerdr: one herdr.exe, and a tree kill could reach a herdr server it started, the user's session),
// only the child is killed, and not through here. `via` and `after` are test seams.
const KILL_GRACE_MS = 2000;
const alive = (child) => child.exitCode == null && child.signalCode == null;
const later = (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
// Children still owed their last kill, and the taskkills still running for them. The grace timers are unref'd, and
// usage and doctor call process.exit right after printing, so a timer alone never fired there and a child that
// ignored SIGTERM outlived routr (from the verification of 2b89d1d). On exit, whatever is still pending is killed at
// once (process.kill is synchronous): SIGKILL off Windows, TerminateProcess on Windows.
const pending = new Map(); // child -> the signal it is owed
let reaping = false;
const reapPending = () => {
  for (const [c, sig] of pending) { if (alive(c)) { try { c.kill(sig); } catch {} } }
  pending.clear();
};
const owe = (c, sig) => {
  if (!reaping) { reaping = true; process.on("exit", reapPending); }
  pending.set(c, sig); c.once?.("exit", () => pending.delete(c));
};
// `group: true` (off Windows) signals the child's whole process group, for a child started `detached`, which leads its
// own group: a headless Claude runs each tool command in a group of its own, and SIGTERM to Claude ends them while
// SIGKILL leaves them running (prototype p36, 2026-10-22), so the SIGKILL comes only after the grace. The group is
// signalled while the child is unreaped, so its id cannot have been handed to another group.
export function stop(child, { platform = process.platform, via, after = later, group = false } = {}) {
  if (!child || !alive(child)) return;
  if (platform === "win32" && child.pid) {
    let fell = false, tk;
    // taskkill's work is over (it answered, failed, or ran out of time): the child alone, unless it has exited (its
    // pid may be someone else's by then). A taskkill that hangs is killed and let go, its listeners off: a child
    // still referenced kept routr running after the grace (from the verification of 2b89d1d).
    const fallBack = ({ hung = false } = {}) => {
      if (fell) return; fell = true; pending.delete(tk);
      if (hung && tk) { try { tk.removeAllListeners?.(); tk.on("error", () => {}); tk.kill(); tk.unref?.(); } catch {} }
      if (alive(child)) { try { child.kill(); } catch {} }
      pending.delete(child);
    };
    try {
      // Windows' own taskkill.exe by its full path: no PATH search to resolve (or to plant a taskkill in).
      const exe = win32.join(envGet(process.env, "SystemRoot") || "C:\\Windows", "System32", "taskkill.exe");
      tk = (via ?? spawn)(exe, ["/PID", String(child.pid), "/T", "/F"], startOptions({ stdio: "ignore" }));
      owe(child); owe(tk);
      const t = after(KILL_GRACE_MS, () => fallBack({ hung: true }));
      tk.on("error", () => { clearTimeout(t); fallBack(); });
      tk.on("exit", (code) => { clearTimeout(t); if (code !== 0) fallBack(); else { pending.delete(tk); pending.delete(child); } });
      return;
    } catch {}
  }
  const signal = (sig) => { if (group && platform !== "win32" && child.pid) { try { process.kill(-child.pid, sig); return; } catch {} } try { child.kill(sig); } catch {} };
  signal("SIGTERM");
  if (platform !== "win32") {
    if (!group) owe(child, "SIGKILL");
    after(KILL_GRACE_MS, () => { pending.delete(child); if (alive(child)) signal("SIGKILL"); });
  }
}

// Start routr again, detached, with `args`, and carry on without waiting: the binary itself, or `bun <script>` from a
// source checkout, located beside this module rather than the importing script. A spawn that fails later (EACCES,
// EMFILE) is ignored; one that fails at once returns false.
// `onExit` hears when it ends, for a caller that shows it running; it still never keeps the caller alive.
export function spawnSelf(args, { onExit } = {}) {
  try {
    const argv = selfCommand(args);
    if (!argv) return false;
    const c = start(argv[0], argv.slice(1), { detached: true, stdio: "ignore", env: harnessEnv() });
    let heard = false; const end = () => { if (!heard && onExit) { heard = true; onExit(); } };
    c.on("error", end); c.on("exit", end); c.unref(); return true;
  } catch { return false; }
}
// A process in a terminal of its own, from Bun (POSIX only), for what a harness shows only on an interactive screen.
export const startInTerminal = (argv, { cwd, extraEnv = {}, terminal }) => Bun.spawn(argv, { cwd, env: { ...harnessEnv(), TERM: "xterm-256color", ...extraEnv }, terminal });
// The command line that runs routr again; null from a source checkout it cannot locate.
export const selfCommand = (args) => (!standalone() && !ROUTR_ENTRY ? null : [process.execPath, ...(standalone() ? [] : [ROUTR_ENTRY]), ...args]);

// Run a harness command read-only, in harnessEnv, and collect stdout; resolve null on any failure or timeout, never
// throw.
// `status: true` resolves the exit code instead, for a command whose only answer is on stderr. `exitZero: true` resolves
// null for a command that printed and then exited non-zero: what it printed is not taken as its answer.
// `account`: as start takes it.
export function run(cmd, args, { input, timeoutMs = 8000, until, cwd, status = false, exitZero = false, account } = {}) {
  return new Promise((resolve) => {
    let out = "", done = false, exited = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (!exited) stop(child); resolve(v); };
    let child;
    try { child = start(cmd, args, { stdio: ["pipe", "pipe", "ignore"], env: harnessEnv(), ...(cwd ? { cwd } : {}) }, { account }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", () => { exited = true; });
    child.stdout.on("data", (d) => { out += d; if (until?.(out)) finish(out); });
    child.on("close", (code) => finish(status ? code : exitZero && code !== 0 ? null : out || null));
    if (input) child.stdin.write(input); else child.stdin.end();
  });
}

// Run a command, in harnessEnv, and collect everything it says, stdout and stderr together, with its exit code: for a
// harness's status check, which answers on either stream (measured 2026-09-26: Codex on stderr, Kiro on stdout,
// Antigravity and Cursor on both). Resolves null when it does not answer in time or cannot start; never throws.
// `separate: true` keeps stderr out of `out`, in `err`: for output that is parsed (cleanup's `git status -z`).
// `account`: as start takes it.
export function probe(cmd, args, { timeoutMs = 15000, cwd, separate = false, account } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false, exited = false, child;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (!exited) stop(child); resolve(v); };
    try { child = start(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: harnessEnv(), ...(cwd ? { cwd } : {}) }, { account }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", () => { exited = true; });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { if (separate) err += d; else out += d; });
    child.on("close", (code) => finish(separate ? { out, err, code } : { out, code }));
  });
}
