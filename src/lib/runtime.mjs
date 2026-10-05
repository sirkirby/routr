// Facts about this process and routr's own files, and the small process and file primitives several modules share
// (an atomic write, a lock, a detached copy of routr, a subprocess read). No imports beyond node: `statusline` loads
// this on every Claude Code turn. It is the only module that imports node:child_process (a test holds every other file
// in src/ to that), so every process routr starts gets the same platform defaults from `start` / `startSync`.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
// Start a process with those defaults: `start` as node's spawn, `startSync` as spawnSync. `via` is a test seam.
export const start = (cmd, args, opts, { via = spawn } = {}) => via(cmd, args, startOptions(opts));
export const startSync = (cmd, args, opts, { via = spawnSync } = {}) => via(cmd, args, startOptions(opts));

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
    let out = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(v); };
    let child;
    try { child = start(cmd, args, { stdio: ["pipe", "pipe", "ignore"], env: harnessEnv(), ...(cwd ? { cwd } : {}) }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
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
    let out = "", done = false, child;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(v); };
    try { child = start(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: harnessEnv(), ...(cwd ? { cwd } : {}) }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => finish({ out, code }));
  });
}
