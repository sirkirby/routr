// Facts about this process and routr's own files, and the small process and file primitives several modules share
// (an atomic write, a lock, a detached copy of routr, a subprocess read). No imports beyond node: `statusline` loads
// this on every Claude Code turn. It is the only module that imports node:child_process (a test holds every other file
// in src/ to that), so every process routr starts gets the same platform defaults from `start` / `startSync`.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

// The user's home, read when asked: HOME (USERPROFILE on Windows), as Node's os.homedir() reads it. Bun's os.homedir()
// ignores a HOME changed while it runs (measured 2026-09-26, Bun 1.3.13), so a test's scratch home reached only the CLIs
// it spawned, not routr's own code in the test process.
export const home = () => (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();

// Bun's compiled module lives in its virtual filesystem (1.4.3: /$bunfs on POSIX, B:/~BUN on Windows).
// The importing script is not routr: smoke:otel's in-process launch exposed argv[1] re-entry, 2026-10-25.
let COMPILED = false, ROUTR_ENTRY = null;
try { COMPILED = /^(?:\/\$bunfs\/|[A-Za-z]:\/~BUN\/)/i.test(fileURLToPath(import.meta.url).replaceAll("\\", "/")); } catch {} // A URL probe failure falls back to source, never to the caller's argv.
if (!COMPILED) try { ROUTR_ENTRY = fileURLToPath(new URL("../routr.mjs", import.meta.url)); } catch {}
export const standalone = () => COMPILED;

export const CACHE_DIR = () => join(home(), ".cache/routr");
// Headless workers: each one's run folder, and the sockets of their channels (channel.mjs, headless.mjs).
export const STATE_DIR = () => join(home(), ".local/state/routr");
// Which folder this is, not where: a worktree removed and made again at the same path, even on the same branch,
// is another folder. Device and file number, read whole (Windows' file IDs exceed 2^53). Its birth time too,
// where the file system keeps one: Linux may give a removed folder's number to the next one made. `link: true`
// reads the path itself, not what a link there points at.
export const folderId = (path, { link = false } = {}) => { try { const st = (link ? lstatSync : statSync)(path, { bigint: true }); return st.isSymbolicLink() ? null : `${st.dev}:${st.ino}:${st.birthtimeNs}`; } catch { return null; } };
// Held by `routr uninstall` from its last check through its removal (its pid inside); a headless launch that reserves
// a run folder while it is held backs out (headless.mjs reserve), so neither misses the other.
export const UNINSTALL_LOCK = (h = home()) => join(h, ".local/state/routr", "uninstalling");
export const UPDATE_STAMP = () => join(CACHE_DIR(), "update-check");
export const TELEMETRY_LOG = () => join(CACHE_DIR(), "telemetry.log");
export const UPDATE_LOCK = () => join(CACHE_DIR(), "update.lock");
// Written by `routr statusline` on each Claude Code turn, read by the usage reader.
export const CLAUDE_SNAPSHOT = join(home(), ".cache/routr/claude-usage.json");
// Written by `routr usage cursor` (by hand, or in the background when the reading is old), read by the usage reader.
export const CURSOR_SNAPSHOT = join(home(), ".cache/routr/cursor-usage.json");
// Written by `routr usage kiro` the same way, read by the usage reader.
export const KIRO_SNAPSHOT = join(home(), ".cache/routr/kiro-usage.json");

// A path as the file system names it, for comparing two paths. The native call: on Windows it also expands 8.3 short
// names and folds case, which the JS one leaves as written (measured 2026-10-22, Bun 1.4.3 on Windows 11 x64:
// C:\PROGRA~1 stays as it is, native gives C:\Program Files; GitHub's runner hands out %TEMP% as C:\Users\RUNNER~1,
// and git lists the long name). `realPath` throws as realpathSync does; `realOr` gives a path that cannot be read
// resolved as written.
export const realPath = (p) => realpathSync.native(p);
export const realOr = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };

export function ensureParent(file, { mkdir = mkdirSync } = {}) {
  const dir = dirname(resolve(file));
  try { mkdir(dir, { recursive: true }); }
  catch (e) {
    // Bun on Windows can report EEXIST for an existing parent even with recursive:true. A file or unreadable
    // parent is still a failure; permission and other mkdir errors must never be mistaken for success.
    if (e?.code === "EEXIST") try { if (statSync(dir).isDirectory()) return; } catch {}
    throw e;
  }
}

// A temp file, then rename. Windows refuses a rename over a file another process has open (EPERM), as any reader of it
// does for a moment, and removing the file first leaves it missing for a reader in between: a headless worker's state
// read as none, on CI. So a refused rename is tried again, with the old file in place, for up to 100 ms, and only then
// replaced by removing first. Measured 2026-10-26 on Windows 11 with Bun 1.4.3, a writer in a loop against three
// readers in loops: 15-25% of reads found no file before, about 1% after (each write at most 120 ms); readers 5 ms
// apart, 1 read in about 740 before, none in about 900 after. OTel retry state opts out of removing first
// (preserveOnError): a failed replacement must retain its previous recorded backoff.
const replacePause = new Int32Array(new SharedArrayBuffer(4));
export function writeJsonAtomic(file, value, { mkdir = true, mode, preserveOnError = false, indent, rename = renameSync } = {}) {
  if (mkdir) ensureParent(file);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, indent) + "\n", { mode });
  for (const began = performance.now(); ;) {
    try { rename(tmp, file); return; }
    catch (e) {
      if (["EPERM", "EACCES", "EBUSY"].includes(e?.code) && performance.now() - began < 100) { Atomics.wait(replacePause, 0, 0, 2); continue; }
      if (preserveOnError) throw e;
      break;
    }
  }
  try { unlinkSync(file); } catch {}
  rename(tmp, file);
}

// Take a lock file, or say someone else holds it. Exclusive create, so two processes in a burst cannot both win; the
// file holds the taker's pid and random token, published whole (publishLock, below). A lock `stale(file)` calls
// abandoned is taken over. An unwritable folder means no lock, never a lock on every try.
const locksHere = new Map();
export const lockToken = (file) => locksHere.get(realOr(file));
const lockRecord = (file) => { const value = JSON.parse(readFileSync(file, "utf8")); return typeof value === "number" ? { pid: value } : value; };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
const createLock = (path, id, write = writeFileSync) => {
  const fd = openSync(path, "wx", 0o600);
  try { try { write(fd, JSON.stringify({ pid: process.pid, token: id })); } finally { closeSync(fd); } }
  catch (e) { try { unlinkSync(path); } catch {} throw e; }
};
export function lockOwned(file, token = lockToken(file)) {
  try { const owner = lockRecord(file); return Boolean(token) && owner?.token === token && owner.pid === process.pid; } catch { return false; }
}
// Old pid-only locks remain readable; new owners always prove the random token they made, never a read-back token.
const dropOwn = (file, token) => {
  try {
    const legacy = !token && lockRecord(file)?.pid === process.pid && !lockRecord(file)?.token;
    if (!legacy && !lockOwned(file, token)) return false;
    const key = realOr(file); unlinkSync(file); if (locksHere.get(key) === token) locksHere.delete(key); return true;
  } catch { return false; }
};
// A lock, guard or claim is published whole: its pid and token written to a file of its own beside it, then linked
// into place, which fails if the name exists. So it is never seen without its owner's pid, and an owner paused while
// it is published cannot be taken for one that died. Where hard links are not supported (FAT, some network shares) it
// is an exclusive open and then a write: only there (and in a lock an older routr wrote) can one be seen without a
// pid, and taken as abandoned if its opener pauses ten minutes between the two.
const publishLock = (path, token, { link = linkSync, write = writeFileSync } = {}) => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  write(tmp, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
  try { link(tmp, path); }
  catch (e) { if (e?.code === "EEXIST" || e?.code === "ENOENT") throw e; createLock(path, token, write); }
  finally { try { unlinkSync(tmp); } catch {} }
};
// Every move or removal of a lock is made under its guard, `<lock>.takeover`, held for a few file operations, never
// for the job. A guard is taken from its holder only once that process is gone (or, with no pid to read, after ten
// minutes): a holder paused between its last check and its move keeps it, so no one else moves the lock while it may
// still act: a guard that expired after a few seconds let a taker paused past it move the next owner's live lock
// aside, and a third take the empty path while that owner worked. A guard whose pid now belongs to another process
// stays held until that one exits too: blocked, never shared. A dead guard is moved by one taker only, the one that
// creates the claim named for that guard's bytes and file: the dead owner cannot touch it, so the move takes exactly
// the guard that was checked. A claim whose own holder died passes to the next number.
// Returns the held guard, "busy", or null when the folder cannot be written.
function holdGuard(file, { alive = isAlive, rename = renameSync } = {}) {
  const guard = `${file}.takeover`, token = randomUUID(), gone = (f) => lockIsStale(f, { alive });
  const held = { held: () => lockOwned(guard, token), release: () => dropOwn(guard, token) };
  try { publishLock(guard, token); return held; } catch (e) { if (e?.code !== "EEXIST") return null; }
  const seen = () => { const st = statSync(guard, { bigint: true }); return `${readFileSync(guard, "utf8")}\0${st.dev}:${st.ino}:${st.mtimeNs}`; };
  let claim = null;
  try {
    const observed = seen();
    if (!gone(guard)) return "busy";
    const id = createHash("sha256").update(observed).digest("hex").slice(0, 16), dead = [];
    for (let k = 1; !claim; k++) {
      const name = `${guard}.${id}.${k}`;
      try { publishLock(name, token); claim = name; } catch (e) { if (e?.code !== "EEXIST" || !gone(name)) return "busy"; dead.push(name); }
    }
    if (seen() !== observed || !gone(guard)) return "busy";
    const aside = `${guard}.stale.${randomUUID()}`, bytes = readFileSync(guard, "utf8");
    rename(guard, aside);
    if (readFileSync(aside, "utf8") !== bytes) return "busy"; // somebody else's file: left aside, never deleted
    unlinkSync(aside); for (const name of dead) try { unlinkSync(name); } catch {}
    publishLock(guard, token); return held;
  } catch { return "busy"; }
  finally { if (claim) dropOwn(claim, token); }
}
// `fn` under the lock's guard, run only while the guard at its path is still the one published for it; false when the
// guard cannot be had. One try unless `wait`: a command never waits on a lock (a release that finds the guard busy
// leaves its lock, which the stale rule frees once its owner is gone). `wait`, for background work only, tries for a
// second.
const pause = new Int32Array(new SharedArrayBuffer(4));
function underGuard(file, fn, { wait = false, ...opts } = {}) {
  for (let i = 0; i < (wait ? 200 : 1); i++) {
    if (i) Atomics.wait(pause, 0, 0, 5);
    const guard = holdGuard(file, opts);
    if (guard === null) return false;
    if (guard !== "busy") try { return guard.held() ? fn() : false; } finally { guard.release(); }
  }
  return false;
}
export const releaseFileLock = (file, token = lockToken(file), { alive } = {}) => underGuard(file, () => dropOwn(file, token), { alive });
// `fn` only while this process owns the lock, and with no takeover possible until it returns: true once it has run.
export const whileLockOwned = (file, token, fn, { wait = false } = {}) => underGuard(file, () => { if (!lockOwned(file, token)) return false; fn(); return true; }, { wait });
// A lock another process took for this one and handed it the token of (the background usage refresh): this process's
// from here, its age counted again, and only while it still holds that token. Background work: it waits for a busy guard.
export const adoptLock = (file, token) => underGuard(file, () => {
  try {
    if (!token || lockRecord(file)?.token !== token) return false;
    // Replaced whole or not at all: removing it first would leave the path empty for any taker.
    writeJsonAtomic(file, { pid: process.pid, token }, { mkdir: false, mode: 0o600, preserveOnError: true });
  } catch { return false; }
  locksHere.set(realOr(file), token); return true;
}, { wait: true });
export function takeLock(file, stale, { token = randomUUID(), rename = renameSync, write = writeFileSync, alive } = {}) {
  const make = () => { publishLock(file, token, { write }); locksHere.set(realOr(file), token); };
  // Published only when nothing is there: a retry on a live lock writes nothing, not even a temporary file.
  try { if (!existsSync(file)) { make(); return true; } } catch (e) { if (e?.code !== "EEXIST") return false; }
  // A live (or never-stale) lock needs no writes, especially while uninstall removes its state folder.
  try { if (!stale(file)) return false; } catch { return false; }
  const guard = holdGuard(file, { alive, rename });
  if (!guard || guard === "busy") return false;
  try {
    // Checked again under the guard, which nothing else moves or removes the lock without.
    const observed = readFileSync(file, "utf8");
    if (!stale(file) || !guard.held()) return false;
    const aside = `${file}.stale.${randomUUID()}`;
    rename(file, aside);
    // An unexpected replacement is somebody else's file, including on filesystems without hard links: leave it.
    if (readFileSync(aside, "utf8") !== observed) return false;
    unlinkSync(aside);
    if (!guard.held()) return false;
    make(); return true;
  } catch { return false; }
  finally { guard.release(); }
}
// The updater's lock is only taken over when its owner is gone: age alone would let a slow download be overlapped by a
// second swap. A lock with no readable pid (written by an older routr) falls back to age.
export function lockIsStale(file, { alive = isAlive } = {}) {
  let pid; try { pid = lockRecord(file)?.pid; } catch {}
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
// A name not found fails the start with ENOENT, as a missing program does: passed on bare, libuv's own search would
// look in the current folder first, the hijack the lookup avoids. Through cmd.exe
// or node the CLI runs one or more processes below the child routr holds, so a timeout stops the tree (stop, below).
const RUNNABLE = [".com", ".exe", ".bat", ".cmd"];
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const readSmall = (p) => { try { return statSync(p).size < 65536 ? readFileSync(p, "utf8") : ""; } catch { return ""; } };
const envGet = (env, name) => { const k = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()); return k ? env[k] : undefined; };

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

// The environment for harness reads, detached routr jobs, headless turns (through workerEnv) and the private herdr
// server: routr's own,
// without the trace-context carriers (below), and without herdr's pane variables (HERDR_ENV, HERDR_SOCKET_PATH,
// HERDR_PANE_ID, ...). A harness inherits them, and herdr's integration hooks in
// that harness (e.g. ~/.claude/hooks/herdr-agent-state.sh, which acts only when all three are set) would report
// routr's few-second read as an agent session in the user's pane. routr's own herdr calls (herdr.mjs runHerdr,
// terminal.mjs clients) keep them: herdr needs them to find its session. Windows names are case-insensitive, hence /i.
// The lead's own session variables go too: CLAUDECODE and Claude Code's session and messaging ones make a Claude that
// routr starts take itself for a child of the lead's session, and CODEX_THREAD_ID ties a Codex to the lead's thread
// (measured 2026-10-21: a child otherwise inherited the lead identity). Herdr 0.9.5 binary strings list the eight pane
// names: config (HERDR_CONFIG_PATH, HERDR_HOME, HERDR_LOG) must stay so server and clients use the same settings.
// The other harness session names were checked in vendor source and installed binaries
// 2026-10-24 (versions and sources in references/harnesses.md). Exact names, not harness prefixes: sign-in, provider
// and config settings (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, CODEX_HOME, CURSOR_CONFIG_DIR, …) stay.
const LEAD_SESSION = /^(?:HERDR_(?:ENV|SOCKET_PATH|CLIENT_SOCKET_PATH|SESSION|BIN_PATH|WORKSPACE_ID|TAB_ID|PANE_ID)|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(?:ENTRYPOINT|EXECPATH|SESSION_ID|SESSION_ATTENDED|CHILD_SESSION|BRIDGE_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|SSE_PORT)|CODEX_THREAD_ID|CODEX_SESSION_ID|CODEX_TOOL_CALL_ID|CODEX_SANDBOX|CODEX_SANDBOX_NETWORK_DISABLED|CURSOR_CONVERSATION_ID|CURSOR_REQUEST_ID|CURSOR_AGENT|CURSOR_ASKPASS_SOCKET|CURSOR_ASKPASS_SECRET|CURSOR_AGENT_STORE_FILES_DIR|CURSOR_AGENT_STORE_SHARED_PATHS|CURSOR_SANDBOX|AGENT_TRANSCRIPTS|ANTIGRAVITY_CONVERSATION_ID|KIRO_SESSION_ID)$/i;

// W3C trace context, as OpenTelemetry's "environment variables as context propagation carriers" names it: routr hands
// the carriers in its own environment on to workers unchanged when export is off. This transport boundary checks
// opaque strings; traces owns W3C parsing and sampled launch parentage. Harness reads and detached routr jobs get none
// (harnessEnv); a worker start adds the checked ones back (workerEnv).
export const CARRIERS = ["TRACEPARENT", "TRACESTATE", "BAGGAGE"];
const CARRIER = new RegExp(`^(?:${CARRIERS.join("|")})$`, "i");
// routr's own limit on what it hands on, not the W3C grammar: printable ASCII and horizontal tab (Baggage's optional
// whitespace; nothing in the three formats needs more), so no control character reaches a child's environment or
// herdr's argv. Bytes: room for later traceparent versions, W3C's minimum tracestate to propagate, and W3C's minimum
// baggage size, taken here as routr's maximum.
export const CARRIER_MAX = Object.freeze({ TRACEPARENT: 512, TRACESTATE: 512, BAGGAGE: 8192 });
const CARRIER_TEXT = /^[\t\x20-\x7e]*$/;
// Shown in output where a carrier stands: its value never is.
export const FORWARDED = "<forwarded>";
// { carriers, withheld }: those within the limits, by name, and the names of those present but outside them.
// `present(v)` says whether a value counts as there at all. Checked by character first, so a length is a count of bytes.
const checked = (get, present = (v) => v != null && v !== "") => {
  const carriers = {}, withheld = [];
  for (const name of CARRIERS) {
    const v = get(name);
    if (!present(v, name)) continue;
    if (typeof v === "string" && v !== "" && CARRIER_TEXT.test(v) && v.length <= CARRIER_MAX[name]) carriers[name] = v; else withheld.push(name);
  }
  return { carriers, withheld };
};
// The carriers in an environment: by exact name, and case-insensitively on Windows, as its environment is. An empty
// value is absent, as an unset variable.
const carrierIn = (env, name, platform) => (platform === "win32" ? envGet(env, name) : env[name]);
export const carriersFrom = (env = process.env, { platform = process.platform } = {}) => checked((n) => carrierIn(env, n, platform));
// The carriers a worker was saved with (headless worker.json), checked again on every load: only the three names, and
// only own keys; anything else in the object is ignored. Only an absent key is absent: launch saves no other kind, so
// one present that is not a non-empty string (null, "", a number) was changed since, and is withheld and named.
const own = (saved, n) => saved && typeof saved === "object" && !Array.isArray(saved) && Object.hasOwn(saved, n);
export const savedCarriers = (saved) => checked((n) => (own(saved, n) ? saved[n] : undefined), (v, n) => own(saved, n));
// Every carrier value present in an environment, within routr's limits or not: what pane text is redacted of.
export const carrierValues = (env = process.env, { platform = process.platform } = {}) => CARRIERS.map((n) => carrierIn(env, n, platform)).filter((v) => typeof v === "string" && v !== "");
// Pane text (a screen routr returns) with each of `values` replaced by a fixed placeholder. A pane wraps a long line at
// its width, and a terminal may show a TAB as spaces: a value is matched across line breaks, a TAB as spaces too.
// A value split by anything else the screen drew (a colour code inside it) is not matched.
export const CARRIER_SHOWN = "<carrier>";
export function redactCarriers(text, values) {
  if (typeof text !== "string" || !values?.length) return text;
  // Longest first, so a value inside another is not replaced in part.
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    const pattern = [...v].map((c) => (c === "\t" ? "[\t ]+" : c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"))).join("(?:\r?\n)?");
    text = text.replace(new RegExp(pattern, "g"), CARRIER_SHOWN);
  }
  return text;
}
export const harnessEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !LEAD_SESSION.test(k) && !CARRIER.test(k)));
// A worker's environment: the harness environment, the carriers it was given (checked again here, so nothing unchecked
// is ever spread into it), then the adapter's own variables, which win for their keys.
export const workerEnv = (carriers, extra = {}, env = process.env) => ({ ...harnessEnv(env), ...savedCarriers(carriers).carriers, ...extra });

// Start routr again, detached, with `args`, and carry on without waiting: the binary itself, or `bun <script>` from a
// source checkout, located beside this module rather than the importing script. A spawn that fails later (EACCES,
// EMFILE) is ignored; one that fails at once returns false.
export function spawnSelf(args) {
  try {
    if (!standalone() && !ROUTR_ENTRY) return false;
    const c = start(process.execPath, [...(standalone() ? [] : [ROUTR_ENTRY]), ...args], { detached: true, stdio: "ignore", env: harnessEnv() });
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
// `separate: true` keeps stderr out of `out`, in `err`: for output that is parsed (cleanup's `git status -z`).
export function probe(cmd, args, { timeoutMs = 15000, cwd, separate = false } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false, exited = false, child;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (!exited) stop(child); resolve(v); };
    try { child = start(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: harnessEnv(), ...(cwd ? { cwd } : {}) }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", () => { exited = true; });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { if (separate) err += d; else out += d; });
    child.on("close", (code) => finish(separate ? { out, err, code } : { out, code }));
  });
}
