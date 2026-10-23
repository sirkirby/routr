// A usage reading that takes seconds, kept as a snapshot every call reads in milliseconds and refreshed in the
// background. Cursor's (cursor-usage.mjs) and Kiro's (kiro-usage.mjs) are read this way.
import { readFileSync, rmSync } from "node:fs";
import { olderThan, spawnSelf, takeLock, writeJsonAtomic } from "./runtime.mjs";
import { summarize } from "./usage.mjs";
import { usageFailure } from "./usage-failure.mjs";
import { newer, ROUTR_VERSION } from "./version.mjs";

const now = () => Date.now() / 1000;

// Cursor shows usage only in its own /usage screen, which takes seconds to read (a private herdr session, Cursor, the
// panel: 4 to 5 s measured), too slow for a call that answers in 300 ms. Kiro's /usage answers in ~10 s and leaves a
// session behind that takes ~8 s more to delete (measured 2026-09-26). So both are read as a snapshot every
// call reads in milliseconds, with its age shown, and a fresh reading taken in the BACKGROUND about once per working
// session: when the last try is over 4 hours old, the call starts a detached `routr usage <name>` and does not wait.
// Both are monthly pools and burn slowly, so a reading hours old routes the same (the maintainer's call, 2026-09-25).
// `setup` and `doctor` read usage too, so a new install has its first reading before its first dispatch.
// A try that got no reading does not count when an older routr made it (or one that did not say, 0.8.0 and before): a
// newer routr may read what the old one could not (2026-10-23: v0.7.0 failed every Cursor read under herdr 0.9.5, and
// after the upgrade to 0.8.0, whose reader works, `routr usage` and setup kept the failure for hours because the failed
// try was under 4 hours old). Each write says which version (`by`). Only an older one's: a source checkout (0.0.0-dev)
// and an installed binary sharing the cache would otherwise start a reading each time the other had tried (from the
// review of 0298b56); this way the newer retries once and the older never does.
const REFRESH_SEC = 4 * 3600;
// A reading that has not been refreshed for a day is not used: refreshes are failing, and the plan may have reset
// since (Cursor's screen shows no reset time). Past it, the subscription is assumed and the note says so.
const TRUST_SEC = 24 * 3600;
const LOCK_SEC = 120; // one background reading at a time; a lock older than any reading (90 s at most) is abandoned
const readJson = (file) => {
  try { return { snapshot: JSON.parse(readFileSync(file, "utf8")) }; }
  catch (e) { return e?.code === "ENOENT" ? {} : { failure: usageFailure(e instanceof SyntaxError ? "invalid_response" : "read_failed") }; }
};
const noRefresh = () => process.env.ROUTR_NO_REFRESH === "1"; // tests: nothing detached, nothing written
const startRefresh = (name) => spawnSelf(["usage", name, "--background"]);

// `routr usage <name>`: read now and keep the reading. A failed read keeps the last good one, whose age then says how
// old it is. Only the background reading (`--background`) holds the refresh lock, so only it releases it: a reading
// asked for by hand must not free a lock a background reading still holds.
// `ready()` gates the read: null to go ahead, or a harness not signed in. That is an exclusion, never a read failure.
export async function refreshSnapshot({ read, keep, file, lock = `${file}.lock`, nowSec = now(), background = false, ready, version = ROUTR_VERSION }) {
  try {
    let r;
    try {
      const why = ready ? await ready() : null;
      r = why ? { ok: false, excluded: true, why } : await read();
    }
    catch { r = { ok: false, ...usageFailure("read_failed") }; }
    // A reader returns a code, never prose for the cache. This also classifies unexpected failures from a reader.
    if (r?.ok !== true && !r?.excluded) r = { ok: false, ...usageFailure(r?.code), ...(r?.note ? { note: r.note } : {}) };
    const last = readJson(file).snapshot;
    try {
      writeJsonAtomic(file, r.ok ? { ts: nowSec, tried: nowSec, by: version, reading: keep(r) }
        : { ts: Number.isFinite(last?.ts) ? last.ts : null, tried: nowSec, by: version, reading: last?.reading ? keep(last.reading) : null,
          ...(r.excluded ? { excluded: true } : { failure: usageFailure(r.code) }) });
    } catch {}
    return r;
  } finally { if (background) try { rmSync(lock, { force: true }); } catch {} }
}

// `background: false` reads without starting a refresh: doctor, for a harness installed but not in the config.
// `windows(reading)` and `describe(reading)` turn the kept reading into the usage row; `byHand` is said when reading fails.
export function readSnapshot({ name, source, windows, describe, keep, byHand, file, lock = `${file}.lock`, nowSec = now(), refresh = () => startRefresh(name), background = true, off = noRefresh(), version = ROUTR_VERSION }) {
  const cached = readJson(file);
  let snap = cached.snapshot ?? (cached.failure ? { failure: cached.failure } : null);
  // Drop the old raw error field on reads and writes; it is never interpreted or copied forward.
  if (snap) {
    const { ts, tried, by, reading, failure, excluded } = snap;
    snap = { ts: Number.isFinite(ts) ? ts : null, tried: Number.isFinite(tried) ? tried : null, by: typeof by === "string" ? by : null, reading: reading ? keep(reading) : null,
      ...(failure ? { failure: usageFailure(failure.code) } : {}), ...(excluded ? { excluded: true } : {}) };
  }
  let started = false;
  const olderFailed = snap && (snap.failure || snap.excluded || !snap.reading) && (snap.by == null || newer(version, snap.by));
  const triedHere = !olderFailed && nowSec - (snap?.tried ?? 0) < REFRESH_SEC;
  if (background && !off && !triedHere && takeLock(lock, olderThan(LOCK_SEC * 1000, nowSec * 1000))) {
    // Marked before it starts, so the next call waits its turn; if the mark cannot be written, nothing is started.
    try { writeJsonAtomic(file, { ...snap, tried: nowSec, by: version }); started = refresh(); } catch {}
    if (!started) try { rmSync(lock, { force: true }); } catch {}
  }
  const r = snap?.reading, age = snap?.ts == null ? null : nowSec - snap.ts;
  const ws = r ? windows(r) : [];
  const invalid = r && (!Number.isFinite(age) || !ws.some((w) => Number.isFinite(w.usedPct)));
  const failure = cached.failure ?? snap?.failure ?? (invalid ? usageFailure("invalid_response") : undefined);
  const after = [started && "a fresh reading is being taken in the background", failure && `the last try failed: ${failure.why}`].filter(Boolean).join("; ");
  if (r && !invalid && age >= 0 && age < TRUST_SEC) return summarize({ pool: name, source, ts: snap.ts, windows: ws, note: `${describe(r)}${after ? `; ${after}` : ""}`, nowSec, failure, ...(failure && age >= REFRESH_SEC ? { kept: { source: `${name} snapshot`, ageSec: Math.round(age) } } : {}) });
  const why = invalid ? "the saved reading cannot be read" : r ? age < 0 ? "the last reading is from the future, so it is not used"
    : `the last reading is ${Math.round(age / 3600)} h old, too old to use` : "no reading yet";
  return summarize({ pool: name, source, ts: snap?.ts, note: `${why}${after ? `; ${after}` : ""}; using the assumed headroom.`, nowSec, failure });
}
