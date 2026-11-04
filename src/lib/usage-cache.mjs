// Each subscription's last good usage reading, kept so a reader that must not wait (`routr board`, which the Herdr app
// panel asks every minute or so) answers in milliseconds without calling any harness. Every live read (readUsage:
// dispatch, usage, doctor, setup) keeps what it read; a cached read serves those, aged to now, and when the newest is
// older than STALE_SEC (or one is missing) it starts one detached `routr usage` and does not wait. A failed read keeps
// nothing: the last good reading stays, with its age. Kept as summarize's inputs, never its output, so a reading's age
// and any window that has reset since are worked out at the time it is served. routr's own bookkeeping, under its cache
// folder; it holds usage numbers and notes only, as the harness snapshots do.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, spawnSelf, writeJsonAtomic } from "./runtime.mjs";
import { summarize, usageReadingTime } from "./usage.mjs";

export const USAGE_READINGS = () => join(CACHE_DIR(), "usage-readings.json");
export const STALE_SEC = 10 * 60;
const nowSec = () => Date.now() / 1000;
const CLASSES = ["included", "capped", "metered", "unknown"];
const read = (file) => { try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const noRefresh = () => process.env.ROUTR_NO_REFRESH === "1"; // tests: nothing detached, nothing written

// What is kept of one reading: what summarize needs to make it again. Only a reading the harness gave: not a number the
// caller passed (`given`), not a sign-in refusal, not a failed read (even one carrying an older reading).
function entryOf(u) {
  if (!u || u.given || u.signedIn === false || u.failure || u.kept || typeof u.pool !== "string") return null;
  const time = usageReadingTime(u);
  const windows = (u.windows ?? []).filter((w) => w && typeof w.name === "string" && Number.isFinite(w.usedPct))
    .map((w) => ({ name: w.name, usedPct: w.usedPct, ...(Number.isFinite(w.windowMin) ? { windowMin: w.windowMin } : {}), ...(Number.isFinite(w.resetsAt) ? { resetsAt: w.resetsAt } : {}), ...(typeof w.label === "string" ? { label: w.label } : {}) }));
  return { pool: u.pool, source: typeof u.source === "string" ? u.source : u.pool, ts: Number.isSafeInteger(time) ? time / 1000 : null, kept_at: nowSec(), windows,
    ...(typeof u.note === "string" ? { note: u.note } : {}), ...(CLASSES.includes(u.class) ? { class: u.class } : {}), ...(typeof u.reason === "string" ? { reason: u.reason } : {}) };
}

// Keep the good readings of a live read. Never throws, and writes nothing in tests that turned refreshes off.
export function keepReadings(rows, { file = USAGE_READINGS() } = {}) {
  if (noRefresh()) return;
  try {
    const add = Object.fromEntries((rows ?? []).map(entryOf).filter(Boolean).map((e) => [e.pool, e]));
    if (!Object.keys(add).length) return;
    const now = read(file);
    writeJsonAtomic(file, { ...now, readings: { ...(now.readings ?? {}), ...add } }, { mode: 0o600 });
  } catch {} // bookkeeping: a write that fails never changes a command's answer
}

// The kept readings for `names`, each made again now (its age, a window reset since). `missing` names those with none.
// When the newest kept reading is older than STALE_SEC, or one is missing, one detached `routr usage` is started, at most
// once per STALE_SEC (the `tried` mark): the next call reads what it kept. Never waits on it.
export function cachedReadings(names, { file = USAGE_READINGS(), now = nowSec(), refresh = () => spawnSelf(["usage"]) } = {}) {
  const kept = read(file), readings = kept.readings ?? {};
  const rows = [], missing = [];
  for (const n of names) {
    const e = readings[n];
    if (!e || typeof e !== "object") { missing.push(n); continue; }
    rows.push(summarize({ pool: n, source: e.source, ts: Number.isFinite(e.ts) ? e.ts : null, windows: Array.isArray(e.windows) ? e.windows : [], note: e.note, cls: e.class, reason: e.reason, nowSec: now }));
  }
  const newest = Math.max(0, ...rows.map((r) => (Number.isFinite(r.ageSec) ? now - r.ageSec : 0)), ...names.map((n) => readings[n]?.kept_at ?? 0));
  const stale = missing.length > 0 || now - newest > STALE_SEC;
  let refreshing = false;
  if (stale && !noRefresh() && !(Number.isFinite(kept.tried) && now - kept.tried < STALE_SEC)) {
    try { writeJsonAtomic(file, { ...kept, tried: now }, { mode: 0o600 }); refreshing = Boolean(refresh()); } catch {}
  }
  return { rows, missing, refreshing };
}
