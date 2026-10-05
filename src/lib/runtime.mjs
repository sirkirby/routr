// Facts about this process and routr's own files, and the small process and file primitives several modules share
// (an atomic write, a lock, a detached copy of routr, a subprocess read). No imports beyond node: `statusline` loads
// this on every Claude Code turn. It is the only module that imports node:child_process (a test holds every other file
// in src/ to that), so every process routr starts gets the same platform defaults from `start` / `startSync`.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";

// The user's home, read when asked: HOME (USERPROFILE on Windows), as Node's os.homedir() reads it. Bun's os.homedir()
// ignores a HOME changed while it runs (measured 2026-09-26, Bun 1.3.13), so a test's scratch home reached only the CLIs
// it spawned, not routr's own code in the test process.
export const home = () => (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();

// A compiled release binary has no script path of its own; a source checkout runs `bun src/routr.mjs`.
export const standalone = () => !/\.m?js$/.test(process.argv[1] ?? "");

export const CACHE_DIR = () => join(home(), ".cache/routr");
export const UPDATE_STAMP = () => join(CACHE_DIR(), "update-check");
export const TELEMETRY_LOG = () => join(CACHE_DIR(), "telemetry.log");
export const UPDATE_LOCK = () => join(CACHE_DIR(), "update.lock");
// Written by `routr statusline` on each Claude Code turn, read by the usage reader.
export const CLAUDE_SNAPSHOT = join(home(), ".cache/routr/claude-usage.json");
// Written by `routr usage cursor` (by hand, or in the background when the reading is old), read by the usage reader.
export const CURSOR_SNAPSHOT = join(home(), ".cache/routr/cursor-usage.json");
// Written by `routr usage kiro` the same way, read by the usage reader.
export const KIRO_SNAPSHOT = join(home(), ".cache/routr/kiro-usage.json");

// Written whole or not at all (a temp file, then a rename): a reader never sees half a file. Windows will not rename
// over an existing file, so it is removed first there.
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value) + "\n");
  try { renameSync(tmp, file); } catch { try { unlinkSync(file); } catch {} renameSync(tmp, file); }
}

// Take a lock file, or say someone else holds it. Exclusive create, so two processes in a burst cannot both win; the
// file holds the taker's pid. A lock `stale(file)` calls abandoned is taken over. An unwritable folder means no lock,
// never a lock on every try.
export function takeLock(file, stale) {
  const make = () => { const fd = openSync(file, "wx"); try { writeSync(fd, String(process.pid)); } catch {} closeSync(fd); };
  try { make(); return true; } catch (e) { if (e?.code !== "EEXIST") return false; }
  try { if (!stale(file)) return false; rmSync(file, { force: true }); make(); return true; } catch { return false; }
}
// The updater's lock is only taken over when its owner is gone: age alone would let a slow download be overlapped by a
// second swap. A lock with no readable pid (written by an older routr) falls back to age.
export function lockIsStale(file, { alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } } } = {}) {
  const pid = Number(readFileSync(file, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) return !alive(pid);
  return Date.now() - statSync(file).mtimeMs >= 10 * 60 * 1000;
}
// A lock whose file was last written `ms` or more before `nowMs`.
export const olderThan = (ms, nowMs = Date.now()) => (file) => nowMs - statSync(file).mtimeMs >= ms;

// routr's defaults for every process it starts. windowsHide: on Windows a console program started by a process that has
// no console of its own (a detached background job: the Cursor or Kiro refresh, the updater) gets a NEW console, which
// Windows 11 opens as a Windows Terminal window: QA saw 20 to 70 windows flash per Cursor refresh, one per herdr poll,
// before every start came through here. Off Windows the option does nothing. It is forced, never left to the caller.
export const startOptions = (opts = {}) => ({ ...opts, windowsHide: true });
// Start a process with those defaults: `start` as node's spawn, `startSync` as spawnSync, the command resolved on
// Windows as below. `via` and `platform` are test seams.
const prepare = (cmd, args = [], opts = {}, platform = process.platform) => {
  if (platform !== "win32") return [cmd, args, startOptions(opts)];
  const w = windowsCommand(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd ?? process.cwd() });
  return [w.cmd, w.args, startOptions(w.verbatim ? { ...opts, windowsVerbatimArguments: true } : opts)];
};
export const start = (cmd, args, opts, { via = spawn, platform } = {}) => via(...prepare(cmd, args, opts, platform));
export const startSync = (cmd, args, opts, { via = spawnSync, platform } = {}) => via(...prepare(cmd, args, opts, platform));

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
// A name not found is passed on unchanged, so the start fails as it did (ENOENT, or Bun's own error). Through cmd.exe
// or node the CLI runs one or more processes below the child routr holds, so a timeout stops the tree (stop, below).
const RUNNABLE = [".com", ".exe", ".bat", ".cmd"];
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const readSmall = (p) => { try { return statSync(p).size < 65536 ? readFileSync(p, "utf8") : ""; } catch { return ""; } };
const envGet = (env, name) => { const k = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()); return k ? env[k] : undefined; };

// The file a shell would start for `cmd`, or null. Only extensions both PATHEXT and CreateProcess-or-cmd can start count:
// PATHEXT also lists .JS and .VBS, which cmd would hand to Windows Script Host (an npm shim strips .JS for that reason).
export function resolveCommand(cmd, { env = process.env, cwd = process.cwd(), exists = isFile } = {}) {
  const exts = (envGet(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => RUNNABLE.includes(e));
  const tries = (base) => { base = win32.resolve(cwd, base); return [...(win32.extname(base) ? [base] : []), ...exts.map((e) => base + e)].find(exists) ?? null; };
  if (/[\\/]/.test(cmd) || /^[a-z]:/i.test(cmd)) return tries(cmd);
  for (const dir of String(envGet(env, "PATH") ?? "").split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1"))) {
    const hit = dir && tries(win32.join(dir, cmd));
    if (hit) return hit;
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
  if (!file || !/\.(cmd|bat)$/i.test(file)) return { cmd: file ?? cmd, args };
  const script = npmShimScript(read(file)), dir = win32.dirname(file);
  if (script && depth < 2 && exists(win32.join(dir, script))) {
    const local = win32.join(dir, "node.exe");
    return windowsCommand(exists(local) ? local : "node", [win32.join(dir, script), ...args], { env, cwd, exists, read, depth: depth + 1 });
  }
  const comspec = envGet(env, "ComSpec") || win32.join(envGet(env, "SystemRoot") || "C:\\Windows", "System32", "cmd.exe");
  return { cmd: comspec, args: ["/d", "/s", "/c", `"${cmdLine(file, args)}"`], verbatim: true };
}

// Stop a child routr no longer waits for (a timeout, or `until` has its answer), and on Windows all it started: a .cmd
// runs the CLI under cmd.exe, and an npm shim's node may start the CLI's own binary, so killing the child alone would
// leave the CLI running. `taskkill /T /F` walks the tree by parent id, so it runs while the child is still there, and
// never for a child that has exited (its pid may belong to another process by then). If taskkill cannot start, the
// child alone is killed, as before. Off Windows, and for herdr (runHerdr: one herdr.exe, and a tree kill could reach a
// herdr server it started, the user's session), only the child is killed.
export function stop(child, { platform = process.platform, via } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (platform === "win32" && child.pid) {
    try {
      start("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }, { ...(via ? { via } : {}), platform })
        .on("error", () => { try { child.kill(); } catch {} });
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
}

// The environment for a harness read (`run`, `probe`): routr's own, without herdr's pane variables (HERDR_ENV,
// HERDR_SOCKET_PATH, HERDR_PANE_ID, ...). Inside a herdr pane a harness inherits them, and herdr's integration hooks in
// that harness (e.g. ~/.claude/hooks/herdr-agent-state.sh, which acts only when all three are set) would report
// routr's few-second read as an agent session in the user's pane. routr's own herdr calls (herdr.mjs runHerdr,
// terminal.mjs) keep them: herdr needs them to find its session. Windows names are case-insensitive, hence /i.
export const harnessEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^HERDR_/i.test(k)));

// Start routr again, detached, with `args`, and carry on without waiting: the binary itself, or `bun <script>` from a
// source checkout. A spawn that fails later (EACCES, EMFILE) is ignored; one that fails at once returns false.
export function spawnSelf(args) {
  try {
    const c = start(process.execPath, [...(standalone() ? [] : [process.argv[1]]), ...args], { detached: true, stdio: "ignore" });
    c.on("error", () => {}); c.unref(); return true;
  } catch { return false; }
}

// Run a harness command read-only, in harnessEnv, and collect stdout; resolve null on any failure or timeout, never
// throw.
// `status: true` resolves the exit code instead, for a command whose only answer is on stderr.
export function run(cmd, args, { input, timeoutMs = 8000, until, cwd, status = false } = {}) {
  return new Promise((resolve) => {
    let out = "", done = false, exited = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (!exited) stop(child); resolve(v); };
    let child;
    try { child = start(cmd, args, { stdio: ["pipe", "pipe", "ignore"], env: harnessEnv(), ...(cwd ? { cwd } : {}) }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", () => { exited = true; });
    child.stdout.on("data", (d) => { out += d; if (until?.(out)) finish(out); });
    child.on("close", (code) => finish(status ? code : out || null));
    if (input) child.stdin.write(input); else child.stdin.end();
  });
}

// Run a command, in harnessEnv, and collect everything it says, stdout and stderr together, with its exit code: for a
// harness's status check, which answers on either stream (measured 2026-09-26: Codex on stderr, Kiro on stdout,
// Antigravity and Cursor on both). Resolves null when it does not answer in time or cannot start; never throws.
export function probe(cmd, args, { timeoutMs = 15000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = "", done = false, exited = false, child;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (!exited) stop(child); resolve(v); };
    try { child = start(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: harnessEnv(), ...(cwd ? { cwd } : {}) }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", () => { exited = true; });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => finish({ out, code }));
  });
}
