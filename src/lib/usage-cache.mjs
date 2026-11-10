// Each subscription's last good usage reading, kept so a reader that must not wait (`routr board`, which the Herdr app
// panel asks every minute or so) answers in milliseconds without calling any harness. Every live read (readUsage:
// dispatch, usage, doctor, setup) keeps what its sources read, before billing is settled; a cached read serves those,
// aged to now, and when the newest is older than STALE_SEC (or one is missing) it starts one detached `routr usage` and
// does not wait. A failed read keeps nothing: the last good reading stays, with its age. Kept as summarize's inputs,
// never its output, with the source's own limit on how long it may be used (usageTrustedUntil), so a reading's age, a
// window that has reset since and a reading past its source's limit are worked out at the time it is served. routr's own
// bookkeeping, under its cache folder; it holds usage numbers and notes only, as the harness snapshots do.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, ensureParent, lockIsStale, lockToken, olderThan, releaseFileLock, takeLock, whileLockOwned, writeJsonAtomic } from "./state-files.mjs";
import { spawnSelf } from "./processes.mjs";
import { summarize, usageReadingTime, usageTrustedUntil } from "./usage.mjs";

export const USAGE_READINGS = () => join(CACHE_DIR(), "usage-readings.json");
// The last refresh this cache started, a file of its own: a live read keeping its readings never writes over the mark,
// and the mark never over a reading.
export const USAGE_REFRESH = () => join(CACHE_DIR(), "usage-refresh.json");
export const STALE_SEC = 10 * 60;
// The lock is held only to check and set the mark, a few file operations: one older than this was abandoned mid-way.
const LOCK_MS = 30_000;
const nowSec = () => Date.now() / 1000;
const CLASSES = ["included", "capped", "metered", "unknown"];
const read = (file) => { try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const noRefresh = () => process.env.ROUTR_NO_REFRESH === "1"; // tests: nothing detached, nothing written

// What is kept of one reading: what summarize needs to make it again. Only a reading the harness gave: not a number the
// caller passed (`given`), not a sign-in refusal, not a failed read (even one carrying an older reading).
function entryOf(u) {
  if (!u || u.given || u.signedIn === false || u.failure || u.kept || typeof u.pool !== "string") return null;
  const time = usageReadingTime(u), until = usageTrustedUntil(u);
  const windows = (u.windows ?? []).filter((w) => w && typeof w.name === "string" && Number.isFinite(w.usedPct))
    .map((w) => ({ name: w.name, usedPct: w.usedPct, ...(Number.isFinite(w.windowMin) ? { windowMin: w.windowMin } : {}), ...(Number.isFinite(w.resetsAt) ? { resetsAt: w.resetsAt } : {}), ...(typeof w.label === "string" ? { label: w.label } : {}) }));
  return { pool: u.pool, source: typeof u.source === "string" ? u.source : u.pool, ts: Number.isSafeInteger(time) ? time / 1000 : null, kept_at: nowSec(), windows,
    ...(Number.isFinite(until) ? { until } : {}),
    ...(typeof u.note === "string" ? { note: u.note } : {}), ...(CLASSES.includes(u.class) ? { class: u.class } : {}), ...(typeof u.reason === "string" ? { reason: u.reason } : {}) };
}

// Keep the good readings of a live read. A reading older than the one kept is not kept: a refresh that ran long cannot
// put back what a later read replaced. Two live reads at the same moment can each write the file whole, and one's
// readings are then lost until the next read: bookkeeping, never an answer, so no lock is taken for it. Never throws,
// and writes nothing in tests that turned refreshes off.
export function keepReadings(rows, { file = USAGE_READINGS() } = {}) {
  if (noRefresh()) return;
  try {
    const was = read(file).readings ?? {};
    const newer = (e) => !(Number.isFinite(was[e.pool]?.ts) && Number.isFinite(e.ts) && e.ts < was[e.pool].ts);
    const add = Object.fromEntries((rows ?? []).map(entryOf).filter(Boolean).filter(newer).map((e) => [e.pool, e]));
    if (!Object.keys(add).length) return;
    writeJsonAtomic(file, { readings: { ...was, ...add } }, { mode: 0o600 });
  } catch {} // bookkeeping: a write that fails never changes a command's answer
}

// The kept readings for `names`, each made again now (its age, a window reset since, its source's limit). `missing`
// names those with none. When the newest kept reading is older than STALE_SEC, or one is missing, one detached `routr
// usage` (with the caller's `--config`, so it reads the same subscriptions) is started, at most once per STALE_SEC: the
// mark is checked and set under a lock, so callers at the same moment start one between them. Never waits on it.
export function cachedReadings(names, { file = USAGE_READINGS(), mark = USAGE_REFRESH(), lock = `${mark}.lock`, now = nowSec(), configPath, spawn = spawnSelf,
  refresh = () => spawn(["usage", ...(configPath ? ["--config", configPath] : [])]) } = {}) {
  const readings = read(file).readings ?? {};
  const rows = [], missing = [];
  for (const n of names) {
    const e = readings[n];
    if (!e || typeof e !== "object") { missing.push(n); continue; }
    rows.push(summarize({ pool: n, source: e.source, ts: Number.isFinite(e.ts) ? e.ts : null, windows: Array.isArray(e.windows) ? e.windows : [], note: e.note, cls: e.class, reason: e.reason,
      until: Number.isFinite(e.until) ? e.until : undefined, nowSec: now }));
  }
  const newest = Math.max(0, ...rows.map((r) => (Number.isFinite(r.ageSec) ? now - r.ageSec : 0)), ...names.map((n) => readings[n]?.kept_at ?? 0));
  const due = () => { const t = read(mark).tried; return !(Number.isFinite(t) && now - t < STALE_SEC); };
  let refreshing = false;
  // The cache folder is made first: on a new machine it is not there, and a lock cannot be taken in it.
  const lockable = () => { try { ensureParent(lock); return true; } catch { return false; } };
  if ((missing.length > 0 || now - newest > STALE_SEC) && !noRefresh() && due() && lockable()
    && takeLock(lock, (f) => olderThan(LOCK_MS)(f) || lockIsStale(f))) {
    const token = lockToken(lock);
    // Checked again under the lock, and marked and started only while the lock is still this call's: a caller paused
    // past LOCK_MS has lost it to another, which may have started one already. Marked before it starts; a mark that
    // cannot be written starts nothing, so a cache folder that cannot be written never starts one on every call.
    try { whileLockOwned(lock, token, () => { if (due()) { writeJsonAtomic(mark, { tried: now }, { mode: 0o600 }); refreshing = Boolean(refresh()); } }); } catch {}
    finally { releaseFileLock(lock, token); }
  }
  return { rows, missing, refreshing };
}
