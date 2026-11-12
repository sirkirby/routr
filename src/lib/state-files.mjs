// routr's own folders and files: where each one is, an atomic write and a checked read of one, and the lock files that
// keep two routr processes from doing one job at once. No imports beyond node: `statusline` loads this on every Claude
// Code turn.
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// The user's home, read when asked: HOME (USERPROFILE on Windows), as Node's os.homedir() reads it. Bun's os.homedir()
// ignores a HOME changed while it runs (measured 2026-09-26, Bun 1.3.13), so a test's scratch home reached only the CLIs
// it spawned, not routr's own code in the test process.
export const home = () => (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();

export const CACHE_DIR = (h = home()) => join(h, ".cache/routr");
// Headless workers: each one's run folder, and the sockets of their channels (channel.mjs, headless.mjs).
export const STATE_DIR = (h = home()) => join(h, ".local/state/routr");
// The user's settings and keys, and routr's ledger and headless worktrees.
export const CONFIG_DIR = (h = home()) => join(h, ".config/routr");
export const DATA_DIR = (h = home()) => join(h, ".local/share/routr");
export const WORKTREES_DIR = (h = home()) => join(DATA_DIR(h), "worktrees"); // headless launches' git worktrees
// The folder name a headless launch gives a branch's worktree, under WORKTREES_DIR.
export const worktreeFolder = (branch) => branch.replace(/[\\/]/g, "-");
// Which folder this is, not where: a worktree removed and made again at the same path, even on the same branch,
// is another folder. Device and file number, read whole (Windows' file IDs exceed 2^53). Its birth time too,
// where the file system keeps one: Linux may give a removed folder's number to the next one made. `link: true`
// reads the path itself, not what a link there points at.
export const folderId = (path, { link = false } = {}) => { try { const st = (link ? lstatSync : statSync)(path, { bigint: true }); return st.isSymbolicLink() ? null : `${st.dev}:${st.ino}:${st.birthtimeNs}`; } catch { return null; } };
// Held by `routr uninstall` from its last check through its removal (its pid inside); a headless launch that reserves
// a run folder while it is held backs out (worker-start.mjs reserve), so neither misses the other.
export const UNINSTALL_LOCK = (h = home()) => join(STATE_DIR(h), "uninstalling");
export const UPDATE_STAMP = () => join(CACHE_DIR(), "update-check");
export const TELEMETRY_LOG = () => join(CACHE_DIR(), "telemetry.log");
export const UPDATE_LOCK = () => join(CACHE_DIR(), "update.lock");
// Written by `routr statusline` on each Claude Code turn, read by the usage reader.
// One per folder Claude Code runs with (`dir`: its CLAUDE_CONFIG_DIR, or none), so one account's is never read as
// another's. The default folder's keeps the name it always had.
export const CLAUDE_SNAPSHOT = (dir) => join(CACHE_DIR(), !dir || realOr(dir) === realOr(join(home(), ".claude")) ? "claude-usage.json" : `claude-usage-${folderSha(dir)}.json`);

// A path as the file system names it, for comparing two paths. The native call: on Windows it also expands 8.3 short
// names and folds case, which the JS one leaves as written (measured 2026-10-22, Bun 1.4.3 on Windows 11 x64:
// C:\PROGRA~1 stays as it is, native gives C:\Program Files; GitHub's runner hands out %TEMP% as C:\Users\RUNNER~1,
// and git lists the long name). `realPath` throws as realpathSync does; `realOr` gives a path that cannot be read
// resolved as written.
export const realPath = (p) => realpathSync.native(p);
export const realOr = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
// The folder an extra account signs in from, as `accounts` in the config names it: a full path, or one under the home
// folder (`~/…`), made absolute and normalised; null for anything else, or a control character, as worker-env's config
// locations refuse. Here, not there: `statusline` reads it.
export const configDirOf = (v) => {
  if (typeof v !== "string" || !/^[^\0-\x1f\x7f]{1,4096}$/.test(v)) return null;
  const p = /^~[\\/]/.test(v) ? join(home(), v.slice(2)) : v;
  return isAbsolute(p) ? resolve(p) : null;
};
// What dispatch advice keeps of an extra account's folder, for launch to compare (advice-file.mjs): never the path.
export const folderSha = (dir) => createHash("sha256").update(realOr(dir)).digest("hex").slice(0, 12);

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
// read as none, on CI. So on Windows a refused rename is tried again, with the old file in place, for up to `busyFor`
// ms (REPLACE_BUSY_MS), and only then replaced by removing first. Measured 2026-10-26 on Windows 11 with Bun 1.4.3, a
// writer in a loop against three readers in loops: 15-25% of reads found no file before, 1-2% after (each write at most
// about 190 ms); readers 5 ms apart, 1 read in about 740 before, 0 or 1 in about 900 after. Elsewhere a rename over an
// open file succeeds, and a refusal is a permission that waiting will not change, so there is no retry. OTel retry
// state opts out of removing first (preserveOnError): a failed replacement must retain its previous recorded backoff. A
// write that fails removes its temp file. `now` and `pause` are the clock and the wait, for tests.
const replacePause = new Int32Array(new SharedArrayBuffer(4));
export const REPLACE_BUSY_MS = 100;

// A JSON file routr wrote, read back: { value }, { absent: true } when there is no such file, or { unreadable: code }
// when it is there and could not be read or parsed (`not_json`, or the system's code). A caller never takes the last
// for the second: a worker's state it could not read is not a worker with none (a holder that did so wrote over its
// session). On Windows a reader can meet a file another process holds or is replacing (writeJsonAtomic, above), so an
// unreadable one is read again for up to `busyFor` ms; elsewhere routr's writers replace whole files, so one that does
// not parse is broken, and is read once. `read`, `now` and `pause` are the file read, the clock and the wait, for tests.
export function readJsonFile(file, { busyFor = process.platform === "win32" ? REPLACE_BUSY_MS : 0, now = () => performance.now(),
  pause = (ms) => Atomics.wait(replacePause, 0, 0, ms), read = (f) => readFileSync(f, "utf8") } = {}) {
  for (const began = now(); ;) {
    let unreadable;
    try { return { value: JSON.parse(read(file)) }; }
    catch (e) {
      if (e?.code === "ENOENT") return { absent: true };
      unreadable = e instanceof SyntaxError ? "not_json" : typeof e?.code === "string" ? e.code : "read_failed";
    }
    if (now() - began >= busyFor) return { unreadable };
    pause(5);
  }
}
// `userFile`: a file the person may keep elsewhere (config.json, Claude's settings.json linked from a dotfiles folder):
// written where its link points, even a link to a file not made yet, keeping the link, and with exactly the mode it
// has (set on the new file, so the umask cannot narrow it: 0660 under umask 022 came back 0640).
const linkTarget = (file) => {
  for (let i = 0; i < 40; i++) {
    let st; try { st = lstatSync(file); } catch { return file; }
    if (!st.isSymbolicLink()) return realOr(file);
    // From the folder's real path: `..` in a link is taken where the folder really is (a lexical resolve of
    // alias/nested -> ../x landed beside the alias, on another file).
    file = resolve(realOr(dirname(file)), readlinkSync(file));
  }
  throw new Error(`${file}: too many links (a loop?); nothing was written`);
};
// A temp file in the same folder, then a rename over the path. The rename replaces a symlink at the path; it does not
// follow one, so the link's target is never the file written. `userFile` is the exception, for a file the person keeps
// elsewhere: written where its link points.
function writeAtomic(file, text, { mkdir = true, mode, preserveOnError = false, rename = renameSync, userFile = false,
  busyFor = process.platform === "win32" ? REPLACE_BUSY_MS : 0, now = () => performance.now(), pause = (ms) => Atomics.wait(replacePause, 0, 0, ms) } = {}) {
  let exact;
  if (userFile) { file = linkTarget(file); try { exact = mode ??= statSync(file).mode & 0o777; } catch {} }
  if (mkdir) ensureParent(file);
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode });
    if (exact !== undefined && process.platform !== "win32") chmodSync(tmp, exact);
    for (const began = now(); ;) {
      try { rename(tmp, file); return; }
      catch (e) {
        if (["EPERM", "EACCES", "EBUSY"].includes(e?.code) && now() - began < busyFor) { pause(2); continue; }
        if (preserveOnError) throw e;
        break;
      }
    }
    try { unlinkSync(file); } catch {}
    rename(tmp, file);
  } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
}
export const writeTextAtomic = (file, text, opts) => writeAtomic(file, text, opts);
export function writeJsonAtomic(file, value, { indent, ...opts } = {}) {
  return writeAtomic(file, JSON.stringify(value, null, indent) + "\n", opts);
}

// Take a lock file, or say someone else holds it. Exclusive create, so two processes in a burst cannot both win; the
// file holds the taker's pid and random token, published whole (publishLock, below). A lock `stale(file)` calls
// abandoned is taken over. An unwritable folder means no lock, never a lock on every try.
const locksHere = new Map();
export const lockToken = (file) => locksHere.get(realOr(file));
const lockRecord = (file) => { const value = JSON.parse(readFileSync(file, "utf8")); return typeof value === "number" ? { pid: value } : value; };
export const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
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
function holdGuard(file, { alive = processAlive, rename = renameSync } = {}) {
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
export function lockIsStale(file, { alive = processAlive } = {}) {
  let pid; try { pid = lockRecord(file)?.pid; } catch {}
  if (Number.isInteger(pid) && pid > 0) return !alive(pid);
  return Date.now() - statSync(file).mtimeMs >= 10 * 60 * 1000;
}
// A lock whose file was last written `ms` or more before `nowMs`.
export const olderThan = (ms, nowMs = Date.now()) => (file) => nowMs - statSync(file).mtimeMs >= ms;
