// Facts about this process and routr's own files, and the small process and file primitives several modules share
// (an atomic write, a lock, a detached copy of routr, a subprocess read). No imports beyond node: `statusline` loads
// this on every Claude Code turn.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A compiled release binary has no script path of its own; a source checkout runs `bun src/routr.mjs`.
export const standalone = () => !/\.m?js$/.test(process.argv[1] ?? "");

export const CACHE_DIR = () => join(homedir(), ".cache/routr");
// Written by `routr statusline` on each Claude Code turn, read by the usage reader.
export const CLAUDE_SNAPSHOT = join(homedir(), ".cache/routr/claude-usage.json");
// Written by `routr usage cursor` (by hand, or in the background when the reading is old), read by the usage reader.
export const CURSOR_SNAPSHOT = join(homedir(), ".cache/routr/cursor-usage.json");
// Written by `routr usage kiro` the same way, read by the usage reader.
export const KIRO_SNAPSHOT = join(homedir(), ".cache/routr/kiro-usage.json");

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
// A lock whose file was last written `ms` or more before `nowMs`.
export const olderThan = (ms, nowMs = Date.now()) => (file) => nowMs - statSync(file).mtimeMs >= ms;

// Start routr again, detached, with `args`, and carry on without waiting: the binary itself, or `bun <script>` from a
// source checkout. A spawn that fails later (EACCES, EMFILE) is ignored; one that fails at once returns false.
export function spawnSelf(args) {
  try {
    const c = spawn(process.execPath, [...(standalone() ? [] : [process.argv[1]]), ...args], { detached: true, stdio: "ignore", windowsHide: true });
    c.on("error", () => {}); c.unref(); return true;
  } catch { return false; }
}

// Run a harness command read-only and collect stdout; resolve null on any failure or timeout, never throw.
// `status: true` resolves the exit code instead, for a command whose only answer is on stderr.
export function run(cmd, args, { input, timeoutMs = 8000, until, cwd, status = false } = {}) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(v); };
    let child;
    try { child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"], ...(cwd ? { cwd } : {}) }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.stdout.on("data", (d) => { out += d; if (until?.(out)) finish(out); });
    child.on("close", (code) => finish(status ? code : out || null));
    if (input) child.stdin.write(input); else child.stdin.end();
  });
}
