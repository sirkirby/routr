// A lock holder paused at one file operation while others act, through node:fs itself, so a test reaches the same
// point whatever the lock code's own seams are. Modes: lock, guard and claim (paused as each is published),
// release (paused between an owner's check and its delete), mark (a refresh claimer paused before its mark), spawn (a
// refresh claimer paused after its mark has landed, before it starts the refresh).
import { mock } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
const [mode, dir] = process.argv.slice(2);
const fds = new Map(), hooks = [];
// A hook runs once, on the first operation it matches, before that operation.
const hook = (match, run) => hooks.push({ match, run });
const fire = (op, path) => { const i = hooks.findIndex((h) => h.match(op, String(path))); if (i !== -1) hooks.splice(i, 1)[0].run(String(path)); };
mock.module("node:fs", () => ({
  ...fs,
  openSync: (path, ...rest) => { const fd = fs.openSync(path, ...rest); fds.set(fd, String(path)); fire("open", path); return fd; },
  writeFileSync: (target, ...rest) => { fire("write", typeof target === "number" ? fds.get(target) : target); return fs.writeFileSync(target, ...rest); },
  linkSync: (from, to) => { fire("link", to); return fs.linkSync(from, to); },
  unlinkSync: (path) => { fire("unlink", path); return fs.unlinkSync(path); },
  renameSync: (from, to) => { const r = fs.renameSync(from, to); fire("renamed", to); return r; },
}));
const { lockToken, releaseFileLock, takeLock } = await import("../../src/lib/state-files.mjs");
const file = join(dir, "job.lock"), guard = `${file}.takeover`, out = {};
const record = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
// What another process sees at that path now: absent, or present with or without its owner's pid.
const seen = (p) => (!fs.existsSync(p) ? "absent" : Number.isInteger(record(p)?.pid) ? "pid" : "no pid");
const age = (p) => { if (fs.existsSync(p)) { const t = new Date(Date.now() - 11 * 60_000); fs.utimesSync(p, t, t); } };
const publishing = (match) => (op, p) => (op === "write" || op === "link") && match(p);

if (mode === "guard" || mode === "claim") {
  takeLock(file, () => false); const mine = lockToken(file);
  if (mode === "claim") fs.writeFileSync(guard, JSON.stringify({ pid: 999999999, token: "crashed" }));
  const target = mode === "guard" ? (p) => p === guard : (p) => /\.takeover\.[0-9a-f]{16}\.\d+$/.test(p);
  // Paused ten minutes as it is published: another release reclaims what it can see, then the owner's own release
  // goes on, and between its check and its delete a third process tries to take the lock.
  hook(publishing(target), (p) => { out.seen = seen(p); age(p); out.other = releaseFileLock(file, "another-token"); });
  hook((op, p) => op === "unlink" && p === file, () => { out.taken = takeLock(file, () => true); out.token = lockToken(file); });
  out.released = releaseFileLock(file, mine);
  out.lock = record(file)?.token ?? null;
} else if (mode === "lock") {
  // Paused ten minutes as it publishes the lock itself: another taker sees what is there, and takes it if it can.
  const { lockIsStale } = await import("../../src/lib/state-files.mjs");
  hook(publishing((p) => p === file), (p) => { out.seen = seen(p); age(p); out.other = takeLock(file, lockIsStale); out.otherToken = lockToken(file) ?? null; });
  out.mine = takeLock(file, lockIsStale); out.mineToken = lockToken(file) ?? null;
  out.lock = record(file)?.token ?? null;
} else if (mode === "release") {
  takeLock(file, () => false);
  hook((op, p) => op === "unlink" && p === file, () => { out.taken = takeLock(file, () => true); out.token = lockToken(file); });
  out.released = releaseFileLock(file);
  out.lock = record(file)?.token ?? null;
} else if (mode === "mark") {
  const { fileStore, usageReadings } = await import("../../src/lib/usage-readings.mjs");
  const entry = join(dir, "cursor.json"), lock = `${entry}.lock`, T = 1_800_000_000;
  // Once the claimer has its lock, its next write by name is the first step toward its mark: there another call takes
  // the lock over and its refresh lands a complete reading.
  let locked = false;
  hook((op, p) => (op === "open" || op === "link") && p === lock, () => { locked = true; });
  hook((op, p) => locked && op === "write" && typeof p === "string" && p !== "undefined" && !p.endsWith(".lock"), () => {
    out.taken = takeLock(lock, () => true);
    fs.writeFileSync(entry, JSON.stringify({ reading: { source: "cursor /usage", takenAt: T + 100, windows: [{ name: "included", usedPct: 70 }] }, attempt: { at: T + 100, by: "0.0.0-dev", outcome: "ok" } }));
  });
  let started = 0;
  const readers = { cursor: { source: "cursor /usage", speed: "background", check: async () => ({ ok: false }), reading: () => null } };
  usageReadings({ configPath: null, store: fileStore(dir, { legacy: null }), clock: { now: () => T }, starter: { start: () => { started++; return true; } }, readers, signIn: { kept: () => null, why: () => "" } }).kept(["cursor"]);
  out.started = started; out.entry = record(entry);
} else if (mode === "spawn") {
  const { fileStore, usageReadings } = await import("../../src/lib/usage-readings.mjs");
  const entry = join(dir, "cursor.json"), lock = `${entry}.lock`, T = 1_800_000_000;
  // Its mark has landed and the mark's guard is gone: as it goes to start the refresh (publishing the guard again),
  // paused past the lock's age, another caller takes the lock over.
  hook((op, p) => op === "renamed" && p === entry, () => { out.marked = record(entry)?.attempt?.pending === true; });
  hook((op, p) => out.marked && (op === "write" || op === "link") && p.startsWith(`${lock}.takeover`), () => { out.taken = takeLock(lock, () => true); });
  let started = 0;
  const readers = { cursor: { source: "cursor /usage", speed: "background", check: async () => ({ ok: false }), reading: () => null } };
  const kept = usageReadings({ configPath: null, store: fileStore(dir, { legacy: null }), clock: { now: () => T }, starter: { start: () => { started++; return true; } }, readers, signIn: { kept: () => null, why: () => "" } }).kept(["cursor"]);
  out.started = started; out.refreshing = kept.refreshing; out.note = kept.served[0].row.note;
}
console.log(JSON.stringify(out));
