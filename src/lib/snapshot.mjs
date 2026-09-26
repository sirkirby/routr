// A usage reading that takes seconds, kept as a snapshot every call reads in milliseconds and refreshed in the
// background. Cursor's (cursor-usage.mjs) and Kiro's (kiro-usage.mjs) are read this way.
import { readFileSync, rmSync } from "node:fs";
import { olderThan, spawnSelf, takeLock, writeJsonAtomic } from "./runtime.mjs";
import { summarize } from "./usage.mjs";

const now = () => Date.now() / 1000;

// Cursor shows usage only in its own /usage screen, which takes seconds to read (a private herdr session, Cursor, the
// panel: 4 to 5 s measured), too slow for a call that answers in 300 ms. Kiro's /usage answers in ~10 s and leaves a
// session behind that takes ~8 s more to delete (measured 2026-09-26). So both are read like Claude's: a snapshot every
// call reads in milliseconds, with its age shown, and a fresh reading taken in the BACKGROUND about once per working
// session: when the last try is over 4 hours old, the call starts a detached `routr usage <name>` and does not wait.
// Both are monthly pools and burn slowly, so a reading hours old routes the same (the maintainer's call, 2026-09-25).
// `setup` and `doctor` read usage too, so a new install has its first reading before its first dispatch.
const REFRESH_SEC = 4 * 3600;
// A reading that has not been refreshed for a day is not used: refreshes are failing, and the plan may have reset
// since (Cursor's screen shows no reset time). Past it, the subscription is assumed and the note says so.
const TRUST_SEC = 24 * 3600;
const LOCK_SEC = 120; // one background reading at a time; a lock older than any reading (90 s at most) is abandoned
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const noRefresh = () => process.env.ROUTR_NO_REFRESH === "1"; // tests: nothing detached, nothing written
const startRefresh = (name) => spawnSelf(["usage", name, "--background"]);

// `routr usage <name>`: read now and keep the reading. A failed read keeps the last good one, whose age then says how
// old it is. Only the background reading (`--background`) holds the refresh lock, so only it releases it: a reading
// asked for by hand must not free a lock a background reading still holds.
export async function refreshSnapshot({ read, keep, file, lock = `${file}.lock`, nowSec = now(), background = false }) {
  try {
    const r = await read();
    const last = readJson(file);
    try {
      writeJsonAtomic(file, r.ok ? { ts: nowSec, tried: nowSec, reading: keep(r) }
        : { ts: last?.ts ?? null, tried: nowSec, reading: last?.reading ?? null, error: r.error });
    } catch {}
    return r;
  } finally { if (background) try { rmSync(lock, { force: true }); } catch {} }
}

// `background: false` reads without starting a refresh: doctor, for a harness installed but not in the config.
// `windows(reading)` and `describe(reading)` turn the kept reading into the usage row; `byHand` is said when reading fails.
export function readSnapshot({ name, source, windows, describe, byHand, file, lock = `${file}.lock`, nowSec = now(), refresh = () => startRefresh(name), background = true, off = noRefresh() }) {
  let snap = readJson(file);
  let started = false;
  if (background && !off && !(nowSec - (snap?.tried ?? 0) < REFRESH_SEC) && takeLock(lock, olderThan(LOCK_SEC * 1000, nowSec * 1000))) {
    // Marked before it starts, so the next call waits its turn; if the mark cannot be written, nothing is started.
    try { writeJsonAtomic(file, { ...snap, tried: nowSec }); started = refresh(); } catch {}
    if (!started) try { rmSync(lock, { force: true }); } catch {}
  }
  const r = snap?.reading, age = snap?.ts == null ? null : nowSec - snap.ts;
  const after = [started && "a fresh reading is being taken in the background", snap?.error && `the last try failed: ${snap.error}`].filter(Boolean).join("; ");
  if (r && age < TRUST_SEC) return summarize(name, source, snap.ts, windows(r), `${describe(r)}${after ? `; ${after}` : ""}`, undefined, nowSec);
  const why = r ? `the last reading is ${Math.round(age / 3600)} h old, too old to use` : "no reading yet";
  return summarize(name, source, null, [], `${why}${after ? `; ${after}` : ""}; using the assumed headroom.${snap?.error ? ` By hand: ${byHand}` : ""}`, undefined, nowSec);
}
