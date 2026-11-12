// Usage readings: each subscription's usage as every command sees it, from one module. A live read (dispatch, usage,
// doctor, setup) reads the sources fast enough to read in the call and serves the rest from what routr keeps; a read
// that must not wait (board, and so top) serves only what routr keeps and calls no harness. Either may claim a refresh
// of what is due and start one detached `routr usage --background --claim <token>` for all it claimed, and never waits
// on it: the refresh job alone reads a slow source (Cursor's screen, Kiro's /usage) in the background. A person's named
// read (`routr usage cursor`) reads it now.
//
// What it hides: where readings are kept (one file and one lock per source key, under routr's cache folder), when a
// refresh is due (CLOCKS), how a refresh is claimed so that callers at the same moment start one between them, and how
// billing settles a reading from the sign-in answer it came with. What reaches a command is `Served` (usage.mjs,
// servedRow): `{ key, row, takenAt, windowSince }`, `row` exactly the usage row every command ranks.
//
// Ports, each with a production adapter here and a fake in tests: `store` (fileStore, memoryStore), `clock` (`now()`
// in seconds), `starter` (`start(argv)`: the processes module's spawnSelf), `readers` (by harness: the registry's usage
// entries) and `signIn` (`state(key, { fresh })` → `{ state, billing }`, `kept(key)`, `why(key, state)`).
//
// What a caller names is a subscription: a harness, or an extra account of one (usageReadings' `config`). What is kept
// is kept under its source key (the registry's sourceKey): the harness and the folder it signs in from, so two names
// that are one login share one reading, and a name pointed at another folder starts with none.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CACHE_DIR, ensureParent, lockIsStale, lockToken, olderThan, releaseFileLock, takeLock, whileLockOwned, writeJsonAtomic } from "./state-files.mjs";
import { spawnSelf } from "./processes.mjs";
import { accountOf, HARNESSES, sameLogin, sameLoginWhy, signIn as signInOf, signInWhy, sourceKey, SOURCES, withBilling } from "./harnesses.mjs";
import { keptSignIn } from "./signin.mjs";
import { failedUsage, servedRow, summarize } from "./usage.mjs";
import { usageFailure } from "./usage-failure.mjs";
import { isVersion, newer, ROUTR_VERSION } from "./version.mjs";

// Every clock of the kept readings, in seconds, each named for what it means.
export const CLOCKS = Object.freeze({
  // A source read in the call (Claude, Codex, Antigravity): every live read keeps what it read, so a kept reading is
  // older than this only when no live read ran; the next read that must not wait then claims a refresh.
  inlineRefreshSec: 10 * 60,
  // A source too slow to read in the call (Cursor's screen: 4 to 5 s; Kiro's /usage: ~10 s and ~8 s more to delete the
  // session it leaves, measured 2026-09-25/26) is refreshed about once per working session. Both are monthly pools and
  // burn slowly, so a reading hours old routes the same (the maintainer's call, 2026-09-25).
  backgroundRefreshSec: 4 * 3600,
  // A slow source's reading not refreshed for a day is not used: refreshes are failing, and the plan may have reset
  // since (Cursor's screen shows no reset time). Past it, remaining capacity is unknown and the note says so.
  backgroundTrustSec: 24 * 3600,
  // The claim lock is held only to check and set a key's mark, or to put a reading: a few file operations. One older
  // than this was abandoned mid-way.
  claimLockSec: 30,
});

export const harnessOf = (key) => String(key).split("~")[0];
const BEING_TAKEN = "a fresh reading is being taken in the background";
const CLASSES = ["included", "capped", "metered", "unknown"];
const OUTCOMES = ["ok", "failed", "excluded"];
const num = (x) => (Number.isFinite(x) ? x : null);
const safe = (f, fallback) => { try { return f(); } catch { return fallback; } };

// ---- what is kept ----------------------------------------------------------------------------------------------------
// A reading, as kept: what summarize needs to make the row again at any later time (its age, a window reset since, its
// source's limit worked out then). Usage numbers and routr's own notes only; anything else in a file is dropped.
function cleanReading(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const windows = (Array.isArray(r.windows) ? r.windows : []).filter((w) => w && typeof w === "object" && typeof w.name === "string")
    .map((w) => ({ name: w.name, usedPct: num(w.usedPct), windowMin: num(w.windowMin), resetsAt: num(w.resetsAt), ...(typeof w.label === "string" ? { label: w.label } : {}) }));
  return { source: typeof r.source === "string" ? r.source : null, takenAt: num(r.takenAt), ...(Number.isFinite(r.trustedUntil) ? { trustedUntil: r.trustedUntil } : {}), windows,
    ...(typeof r.note === "string" ? { note: r.note } : {}), ...(CLASSES.includes(r.class) ? { class: r.class } : {}), ...(typeof r.reason === "string" ? { reason: r.reason } : {}) };
}
// The last try: when (`at`), which routr (`by`, a version or null), and how it went. A claimed refresh not yet done is
// `pending`, with the claim's `token`, and keeps the try before it otherwise. A failure is kept only as its code.
function cleanAttempt(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const outcome = OUTCOMES.includes(a.outcome) ? a.outcome : null;
  return { at: num(a.at), by: isVersion(a.by) ? a.by : null, ...(outcome ? { outcome } : {}), ...(outcome === "failed" ? { code: usageFailure(a.code).code } : {}),
    ...(a.pending === true && typeof a.token === "string" && a.token ? { pending: true, token: a.token } : {}) };
}
// `unreadable`: the entry a claim found and could not read, said (as invalid_response or read_failed) until a try
// completes: a claim records its mark beside it, never in place of what is served.
const UNREADABLE = ["invalid_response", "read_failed"];
const cleanEntry = (e) => {
  if (!e || typeof e !== "object" || Array.isArray(e)) throw new SyntaxError("not an entry");
  return { reading: cleanReading(e.reading), attempt: cleanAttempt(e.attempt), ...(UNREADABLE.includes(e.unreadable) ? { unreadable: e.unreadable } : {}) };
};
// What a store's get answers for an entry it read: one marked unreadable is still that failure.
const got = (entry) => (entry.unreadable ? { entry, failure: entry.unreadable } : { entry });
// A put: the reading replaces the kept one only when newer, and both it and the attempt only while the claim `token`
// given is still the key's (a refresh that lost its claim publishes nothing); no token is a person's read, or a live
// read's reading. Recording a try never removes or replaces another claim's pending token: only that claim's own
// completion, or a newer claim, does. A person's try during a refresh is recorded beside it, as its outcome and time,
// and the refresh's later reading still lands. What to write, or null for nothing. Any write ends what `unreadable`
// said.
function putting(was, reading, attempt, token) {
  was ??= { reading: null, attempt: null };
  const pending = was.attempt?.pending === true ? was.attempt.token : null;
  const held = !token || pending === token;
  const ours = held && attempt !== undefined;
  const keep = held && reading && replaces(reading, was.reading) ? reading : was.reading;
  const tried = ours && pending && !token ? { ...attempt, pending: true, token: pending } : attempt;
  return keep === was.reading && !ours ? null : { reading: keep, attempt: ours ? tried : was.attempt };
}
// A claim's mark: the try under way, with the last try's outcome kept for the version rule, beside what was there.
const marking = (found, mark, token) => {
  const was = found.entry ?? { reading: null, attempt: null }, unreadable = found.failure ?? was.unreadable;
  return { reading: was.reading, attempt: { ...(was.attempt ?? {}), ...mark, pending: true, token }, ...(unreadable ? { unreadable } : {}) };
};
// Only a reading the harness gave: not a number the caller passed, not a sign-in refusal, not a failed read (even one
// carrying an older reading, as a fallback does). Kept before billing settles it: billing settles again when served.
const keepable = (row) => Boolean(row) && typeof row === "object" && !row.given && row.signedIn !== false && !row.sameAs && !row.failure && !row.kept;
const readingOf = (row) => cleanReading({ ...row, windows: (row.windows ?? []).filter((w) => Number.isFinite(w?.usedPct)) });
// A newer reading replaces the kept one; an older one (a refresh that ran long) never puts back what a later read replaced.
const replaces = (next, was) => !(Number.isFinite(was?.takenAt) && Number.isFinite(next?.takenAt) && next.takenAt < was.takenAt);

// When a key's refresh is due: no reading, or one older than its period, AND no try within that period. A try that got
// no reading does not count when an older routr made it, or one that did not say (2026-10-23: v0.7.0 failed every Cursor
// read under herdr 0.9.5, and after the upgrade to 0.8.0, whose reader works, the failure was kept for hours because the
// failed try was under 4 hours old). Only an older one's: a source checkout (0.0.0-dev) and an installed binary sharing
// the cache would otherwise each start a reading whenever the other had tried; this way the newer retries once and the
// older never does. A `by` that is not a version counts as none ("0.9.invalid" ordered above 0.8.1 and held it back).
// A source read in the call is kept by every live read, so it is also not due while its reading is fresh; a slow one is
// due by its last try alone, so the try an older routr failed is made again at once after an update even beside a
// fresh reading (v0.8.1, #101).
export function due(entry, periodSec, nowSec, version = ROUTR_VERSION, { slow = false } = {}) {
  const r = entry?.reading, a = entry?.attempt;
  if (!slow && r && Number.isFinite(r.takenAt) && nowSec - r.takenAt < periodSec) return false;
  if (!a || !Number.isFinite(a.at)) return true;
  const gotNone = !r || a.outcome === "failed" || a.outcome === "excluded";
  if (gotNone && (a.by == null || newer(version, a.by))) return true;
  return !(nowSec - a.at < periodSec);
}

// ---- stores ----------------------------------------------------------------------------------------------------------
// Every store: `get(key)` → `{ entry }`, `{}` (none kept) or `{ failure: code }` (unreadable, with `entry` when a claim
// marked it); `put(key, reading, attempt, { token, wait })` as `putting` says (attempt undefined: left as it is);
// `claim(keys, token, isDue, mark, start)`: each key `isDue(key, entry)`, checked again under its lock and marked with
// the token, keeps its lock; then `start(keys)` runs only while every one of those locks is still this caller's, and
// the locks are released. `{ claimed, started }`. `claimed(token)`: the keys a claim still holds.

// routr's own files from before this store, under its cache folder, each with the rule its old owner used to call its
// lock abandoned (the snapshot's 120 s; the cache mark's 30 s, or a dead owner), or none (never locked). No reading is
// carried over: Cursor and Kiro read "no reading yet" until the first refresh lands. An older routr writes some of them
// with no lock at all (the kept readings, a foreground snapshot read), so a lock alone cannot say one is unused: only a
// file unchanged for LEGACY_IDLE_MS is. While an older routr is in use it rewrites its files, and they never get that
// old; once nothing old runs, they age out and a later write removes them.
const LEGACY = [
  { file: "cursor-usage.json", stale: (f) => olderThan(120_000)(f) }, { file: "kiro-usage.json", stale: (f) => olderThan(120_000)(f) },
  { file: "usage-refresh.json", stale: (f) => olderThan(30_000)(f) || lockIsStale(f) }, { file: "usage-readings.json" },
];
const LEGACY_IDLE_MS = 24 * 3600 * 1000;
const pause = new Int32Array(new SharedArrayBuffer(4));
// Removes what of LEGACY no older routr can be using: a file only once it is over a day unchanged and its lock (where it
// has one) is absent or abandoned, taken while the file goes, so a stale lock goes only with its file; a held lock
// keeps both. True when nothing is left to try.
function sweepLegacy(dir) {
  let done = true;
  for (const { file, stale } of LEGACY) {
    const data = join(dir, file), lock = `${data}.lock`;
    try {
      // A lock its file has outlived (the file went, the lock stayed): taken by its old rule when abandoned, then let go,
      // which removes it; one still held is left for a later write.
      if (!existsSync(data)) { if (stale && existsSync(lock)) { if (takeLock(lock, stale)) releaseFileLock(lock, lockToken(lock)); else done = false; } continue; }
      const idle = () => Date.now() - statSync(data).mtimeMs > LEGACY_IDLE_MS;
      if (!idle()) { done = false; continue; }
      if (!stale) { rmSync(data, { force: true }); continue; }
      if (!takeLock(lock, stale)) { done = false; continue; }
      const token = lockToken(lock);
      try { if (!whileLockOwned(lock, token, () => { if (idle()) rmSync(data, { force: true }); else done = false; })) done = false; } finally { releaseFileLock(lock, token); }
    } catch { done = false; }
  }
  return done;
}

// One file per key, `<dir>/<key>.json` (owner-only), each with its own lock, so a 90 s Cursor refresh never writes over
// a dispatch's Claude reading. The lock protocol is state-files': the folder made first (on a new machine there is none,
// and a lock cannot be taken in it), then the lock, then the check and the write only while the lock is still this
// caller's. A command tries once (a busy key's put is bookkeeping, dropped); `wait` (the refresh job, a person's named
// read) tries for about a second.
export function fileStore(dir = join(CACHE_DIR(), "usage"), { legacy = CACHE_DIR(), lockAgeSec = CLOCKS.claimLockSec } = {}) {
  const fileOf = (key) => join(dir, `${encodeURIComponent(key)}.json`);
  const read = (file) => {
    try { return got(cleanEntry(JSON.parse(readFileSync(file, "utf8")))); }
    catch (e) { return e?.code === "ENOENT" ? {} : { failure: e instanceof SyntaxError ? "invalid_response" : "read_failed" }; }
  };
  let swept = !legacy;
  // The old files go only after this store's own write has landed, and are tried again on later writes until gone.
  const write = (file, entry) => {
    writeJsonAtomic(file, entry, { mode: 0o600 });
    if (!swept) swept = sweepLegacy(legacy);
  };
  // The key's lock, taken (`{ file, lock, token }`) or null: its folder made first, so a new machine can take one.
  const hold = (key, wait) => {
    const file = fileOf(key), lock = `${file}.lock`;
    try { ensureParent(lock); } catch { return null; }
    const stale = (f) => olderThan(lockAgeSec * 1000)(f) || lockIsStale(f);
    let taken = takeLock(lock, stale);
    for (let i = 0; !taken && wait && i < 100; i++) { Atomics.wait(pause, 0, 0, 10); taken = takeLock(lock, stale); }
    return taken ? { key, file, lock, token: lockToken(lock) } : null;
  };
  const locked = (key, fn, { wait = false } = {}) => {
    const h = hold(key, wait);
    if (!h) return false;
    let done = false;
    try { whileLockOwned(h.lock, h.token, () => { done = fn(h.file) !== false; }, { wait }); } catch { done = false; }
    finally { releaseFileLock(h.lock, h.token); }
    return done;
  };
  return {
    get: (key) => read(fileOf(key)),
    put: (key, reading, attempt, { token, wait = false } = {}) => locked(key, (file) => {
      const next = putting(read(file).entry, reading, attempt, token);
      if (!next) return false;
      write(file, next);
    }, { wait }),
    claim: (keys, token, isDue, mark, start) => {
      const held = [];
      let started = false;
      try {
        for (const key of keys) {
          if (!isDue(key, read(fileOf(key)).entry ?? null)) continue;
          const h = hold(key, false);
          if (!h) continue;
          let marked = false;
          try { whileLockOwned(h.lock, h.token, () => { const found = read(h.file); if (isDue(key, found.entry ?? null)) { write(h.file, marking(found, mark, token)); marked = true; } }); } catch {}
          if (marked) held.push(h); else releaseFileLock(h.lock, h.token);
        }
        // Started only while every lock it marked under is still its own: a caller paused past the lock's age has
        // lost one to another caller, which may have claimed that key itself.
        const within = (i) => (i === held.length ? (started = Boolean(start(held.map((h) => h.key)))) : whileLockOwned(held[i].lock, held[i].token, () => within(i + 1)));
        if (held.length) try { within(0); } catch {}
      } finally { for (const h of held) releaseFileLock(h.lock, h.token); }
      return { claimed: held.map((h) => h.key), started };
    },
    claimed: (token) => {
      let names = []; try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
      return names.map((f) => { try { return decodeURIComponent(f.slice(0, -5)); } catch { return null; } })
        .filter((k) => k != null)
        .filter((k) => { const a = read(fileOf(k)).entry?.attempt; return a?.pending === true && a.token === token; });
    },
  };
}

// The same contract in memory, for tests: entries as plain values, one lock per key, and `pause(key)` called between a
// claim's check and its mark, so a test can interleave another caller there.
export function memoryStore({ entries = {}, pause: between = () => {} } = {}) {
  const kept = new Map(Object.entries(entries)), held = new Set();
  const read = (key) => {
    if (!kept.has(key)) return {};
    const v = kept.get(key);
    if (v && typeof v === "object" && typeof v.failure === "string" && !("reading" in v)) return { failure: v.failure };
    try { return got(cleanEntry(structuredClone(v))); } catch { return { failure: "invalid_response" }; }
  };
  const locked = (key, fn) => { if (held.has(key)) return false; held.add(key); try { return fn() !== false; } finally { held.delete(key); } };
  return {
    entries: kept,
    get: read,
    put: (key, reading, attempt, { token } = {}) => locked(key, () => {
      const next = putting(read(key).entry, reading, attempt, token);
      if (!next) return false;
      kept.set(key, structuredClone(next));
    }),
    claim: (keys, token, isDue, mark, start) => {
      const marked = [];
      let started = false;
      try {
        for (const key of keys) {
          if (held.has(key) || !isDue(key, read(key).entry ?? null)) continue;
          held.add(key);
          between(key);
          const found = read(key);
          if (isDue(key, found.entry ?? null)) { kept.set(key, structuredClone(marking(found, mark, token))); marked.push(key); } else held.delete(key);
        }
        if (marked.length) started = Boolean(start(marked));
      } finally { for (const k of marked) held.delete(k); }
      return { claimed: marked, started };
    },
    claimed: (token) => [...kept.keys()].filter((k) => { const a = read(k).entry?.attempt; return a?.pending === true && a.token === token; }),
  };
}

// ---- production ports ------------------------------------------------------------------------------------------------
// Readers from the registry's usage entries (or a command's own `sources`, the same shape), looked up when read, so
// they load lazily, as the registry says. A source with `check` is too slow for the call: routr keeps its readings and
// refreshes them in the background, and its `check` is gated on the harness's sign-in (the registry's).
export const usageReaders = (sources = SOURCES) => Object.fromEntries(Object.entries(sources).map(([h, u]) => [h, u.check
  ? { source: u.source, speed: "background", check: (ctx) => u.check(ctx), reading: (raw, at) => u.reading(raw, at) }
  : { source: u.source, speed: "inline", read: (ctx) => u.read(ctx), billsBySignIn: Boolean(HARNESSES[h].auth?.billing) }]));
// Each harness's own status check (the registry's signIn), an extra account's with its folder (`account(name)`), its
// answer kept under the name's source key (`at(name)`). A name the registry does not know has no check: it is taken as
// signed in, as before.
const registrySignIn = (account, at) => {
  const known = (name) => account(name) ?? (Object.hasOwn(HARNESSES, harnessOf(name)) ? harnessOf(name) : null);
  return {
    state: (name, o) => (known(name) ? signInOf(known(name), o) : Promise.resolve({ state: "yes", billing: null })),
    kept: (name) => (known(name) ? keptSignIn(at(name)) : null),
    why: (name, state) => (known(name) ? signInWhy(known(name), state) : "not signed in"),
  };
};
// Tests set ROUTR_NO_REFRESH (test/setup.mjs): a command run in a test starts no detached refresh.
const selfStarter = () => ({ start: (argv) => (process.env.ROUTR_NO_REFRESH === "1" ? false : spawnSelf(argv)) });
const realClock = () => ({ now: () => Date.now() / 1000 });

// ---- the module ------------------------------------------------------------------------------------------------------
// Created once per command process. `configPath` is required (null: the default config, said explicitly): every refresh
// this instance starts carries it, so the refresh reads the subscriptions the caller's config names.
// `config`: the caller's, for its extra accounts (the registry's accountOf): a name that is one is signed in and read as
// its harness is, with its account (the reader's `account`), and its row is its own. Optional: without it an extra
// account's name has no reader and answers `source_missing`, never another account's reading.
export function usageReadings({ configPath, config: caller = null, store, clock, starter, readers, signIn, version = ROUTR_VERSION } = {}) {
  if (configPath === undefined) throw new TypeError("usageReadings: configPath is required (null for the default config)");
  const config = configPath ? resolve(configPath) : null;
  const account = (name) => accountOf(name, caller), harness = (name) => account(name)?.kind ?? harnessOf(name);
  // Where a name's reading is kept: its source key, worked out once per name.
  const sourceKeys = new Map(), keyOf = (name) => { if (!sourceKeys.has(name)) sourceKeys.set(name, safe(() => sourceKey(name, caller), name)); return sourceKeys.get(name); };
  store ??= fileStore(); clock ??= realClock(); starter ??= selfStarter(); readers ??= usageReaders(); signIn ??= registrySignIn(account, keyOf);
  const now = () => clock.now();
  const readerOf = (key) => readers[harness(key)] ?? null;
  const sourceOf = (key) => readerOf(key)?.source ?? key;
  const background = (key) => readerOf(key)?.speed === "background";
  const ctx = (key) => ({ key, harness: harness(key), configPath: config, nowSec: now(), ...(account(key) ? { account: account(key) } : {}) });
  const ask = async (key, o) => { const a = await signIn.state(key, o); return { state: a?.state ?? "no answer", billing: a?.billing ?? null }; };
  const signedOut = (key, state) => servedRow({ ...summarize({ pool: key, source: "sign-in check", note: signIn.why(key, state) }), signedIn: false }, key);
  // A harness's own entry that is, in this environment, the login of one of the caller's extra accounts: that account's
  // row is the login's, and this one says so (`sameAs`), with no check and no read of its own.
  const sameAs = (key) => { const other = safe(() => sameLogin(key, caller), null); return other ? servedRow({ ...summarize({ pool: key, source: "routr config", note: sameLoginWhy(key, caller) }), sameAs: other }, key) : null; };
  const get = (key) => store.get(keyOf(key));
  const put = (key, reading, attempt, o) => { try { return store.put(keyOf(key), reading, attempt, o); } catch { return false; } };
  // A reader names its harness's pool; an extra account's row is its own.
  const serve = (key, row, billing) => servedRow(withBilling(harness(key), account(key) && row ? { ...row, pool: key } : row, billing), key);
  // A try, kept: the reading it got (if any), and how it went. A read that worked but could not be kept is a failure here.
  const record = (key, o, token) => put(key, o.reading ?? null, { at: now(), by: version, ...(o.excluded ? { outcome: "excluded" } : o.reading ? { outcome: "ok" }
    : { outcome: "failed", code: o.ok ? "invalid_response" : o.code }) }, { token, wait: true });

  // Claims every key in `keys` that is due, under one token, and starts one refresh for them all, inside the claim's
  // locks: marked first, so a caller at the same moment finds it not due; a mark that cannot be written claims nothing,
  // and a start that fails leaves the mark, so a failing start is not tried on every call. The keys whose refresh
  // started, or none.
  const claimDue = (keys) => {
    if (!keys.length) return new Set();
    const at = now(), token = randomUUID();
    // Claimed by source key, once for two names that are one login; the names of what started are the answer.
    const named = new Map(); for (const k of keys) if (!named.has(keyOf(k))) named.set(keyOf(k), k);
    const isDue = (source, entry) => { const key = named.get(source); return due(entry, background(key) ? CLOCKS.backgroundRefreshSec : CLOCKS.inlineRefreshSec, at, version, { slow: background(key) }); };
    const start = () => { try { return starter.start(["usage", "--background", "--claim", token, ...(config ? ["--config", config] : [])]); } catch { return false; } };
    try { const r = store.claim([...named.keys()], token, isDue, { at, by: version }, start); return r.started ? new Set(keys.filter((k) => r.claimed.includes(keyOf(k)))) : new Set(); } catch { return new Set(); }
  };

  // A slow source served live from what is kept, as `routr usage` has always said it: its age, the try under way, and
  // the last try's failure (with the kept reading's age once it is older than its refresh period).
  const keptLive = (key, got, started) => {
    const nowSec = now(), source = sourceOf(key), r = got.entry?.reading ?? null, a = got.entry?.attempt;
    const ts = r?.takenAt ?? null, age = ts == null ? null : nowSec - ts;
    const invalid = r && (!Number.isFinite(age) || !r.windows.some((w) => Number.isFinite(w.usedPct)));
    const failure = got.failure ? usageFailure(got.failure) : a?.outcome === "failed" ? usageFailure(a.code) : invalid ? usageFailure("invalid_response") : undefined;
    const after = [started && BEING_TAKEN, failure && `the last try failed: ${failure.why}`].filter(Boolean).join("; ");
    if (r && !invalid && age >= 0 && age < CLOCKS.backgroundTrustSec) return summarize({ pool: key, source, ts, windows: r.windows, note: `${r.note ?? ""}${after ? `; ${after}` : ""}`, nowSec, failure,
      until: r.trustedUntil ?? ts + CLOCKS.backgroundTrustSec, ...(failure && age >= CLOCKS.backgroundRefreshSec ? { kept: { source: `${key} snapshot`, ageSec: Math.round(age) } } : {}) });
    const why = invalid ? "the saved reading cannot be read" : r ? age < 0 ? "the last reading is from the future, so it is not used"
      : `the last reading is ${Math.round(age / 3600)} h old, too old to use` : "no reading yet";
    return summarize({ pool: key, source, ts, note: `${why}${after ? `; ${after}` : ""}; remaining capacity is unknown.`, nowSec, failure });
  };

  // One source read now, whatever its speed: `{ ok, reading, raw, code, note }`, or `{ excluded, why }` when a slow
  // source's own gate says it is not signed in. A raw reading that worked but cannot be kept is still the person's
  // answer, with no reading. Never throws.
  const readOne = async (key) => {
    const reader = readerOf(key);
    if (!reader) return { ok: false, code: "source_missing" };
    try {
      if (reader.speed === "background") {
        const raw = await reader.check(ctx(key));
        if (raw?.excluded === true) return { ok: false, excluded: true, why: typeof raw.why === "string" ? raw.why : signIn.why(key, "no") };
        if (raw?.ok !== true) return { ok: false, code: usageFailure(raw?.code).code, ...(typeof raw?.note === "string" ? { note: raw.note } : {}) };
        const at = now(), reading = cleanReading(await Promise.resolve().then(() => reader.reading?.(raw, at)).catch(() => null));
        return { ok: true, raw, reading: reading && reading.windows.some((w) => Number.isFinite(w.usedPct)) ? { ...reading, takenAt: at, trustedUntil: at + CLOCKS.backgroundTrustSec } : null };
      }
      const row = await reader.read(ctx(key));
      return keepable(row) ? { ok: true, reading: readingOf(row) } : { ok: false, code: usageFailure(row?.failure?.code).code };
    } catch { return { ok: false, code: "read_failed" }; }
  };

  return {
    // The usage of `keys` now, one Served each, in key order. Signed in first (`signIns[key]` when the caller just asked,
    // as doctor does): one that is not is never read, since its read could open a sign-in. Then a number the caller
    // passed (`given`), which wins over any reading. A source read in the call is read and kept; a slow one is served
    // from what is kept, and claimed for a refresh when due and named in `mayRefresh`. Billing settles last, from the
    // sign-in answer; a reading without windows asks the status check again first (unless the caller's answers are
    // fresh), since a login switched within the 6 hours its answer is kept must not keep the old class, and a signed-out
    // answer then leaves the harness out. `observe(read)` wraps each key's work (OpenTelemetry's spans). Never rejects.
    live(keys, { given = {}, mayRefresh = keys, signIns, observe = (read) => read() } = {}) {
      // The slow sources of one call share one claim: each says, once signed in, whether it may be claimed.
      const slow = keys.filter(background), wants = new Map();
      let settle; const batch = new Promise((r) => { settle = r; });
      const report = (key, want) => { if (wants.has(key)) return; wants.set(key, want); if (wants.size === slow.length) settle(claimDue(slow.filter((k) => wants.get(k)))); };
      if (!slow.length) settle(new Set());
      const one = async (key) => {
        const reader = readerOf(key), slowKey = background(key);
        try {
          const same = sameAs(key);
          if (same) return same;
          const fresh = Boolean(signIns && Object.hasOwn(signIns, key));
          const answer = fresh ? { state: signIns[key]?.state ?? "no answer", billing: signIns[key]?.billing ?? null } : await ask(key);
          if (answer.state !== "yes") return signedOut(key, answer.state);
          if (typeof given[key] === "number") return servedRow({ pool: key, source: "given by caller", given: true, ageSec: 0, windows: [], headroom: Math.min(1, Math.max(0, given[key])) }, key);
          let row;
          if (!reader) row = failedUsage(key, sourceOf(key), "source_missing");
          else if (slowKey) {
            report(key, mayRefresh.includes(key));
            const started = await batch;
            row = keptLive(key, safe(() => get(key), { failure: "read_failed" }), started.has(key));
          } else {
            try { row = await reader.read(ctx(key)); } catch { row = failedUsage(key, sourceOf(key)); }
            if (keepable(row)) put(key, readingOf(row), undefined);
          }
          let billing = answer.billing;
          if (!fresh && row?.headroom == null && reader?.billsBySignIn) {
            const again = await ask(key, { fresh: true });
            if (again.state !== "yes") return signedOut(key, again.state);
            billing = again.billing;
          }
          return serve(key, row, billing);
        } catch { return servedRow(failedUsage(key, sourceOf(key)), key); }
        finally { if (slowKey) report(key, false); }
      };
      // A hook that fails before it reads still leaves its key's place in the shared claim, and its key a row.
      return Promise.all(keys.map((key) => Promise.resolve().then(() => observe(() => one(key)))
        .catch(() => { if (background(key)) report(key, false); return servedRow(failedUsage(key, sourceOf(key)), key); })));
    },

    // What is kept for `keys`, each made again now, with no harness called and no status check run: synchronous, and
    // never waits. A kept "not signed in" answer leaves a harness out; one with nothing kept is `not_read_yet`. Billing
    // settles from the kept sign-in answer. Due keys are claimed and one refresh started; `refreshing` says it started.
    // A kept reading never carries a failed try: that a reader stopped working is a live read's to say.
    kept(keys, { mayRefresh = keys } = {}) {
      const started = claimDue(keys.filter((k) => mayRefresh.includes(k)));
      const served = keys.map((key) => {
        try {
          const same = sameAs(key);
          if (same) return same;
          const answer = safe(() => signIn.kept(key), null);
          if (answer?.state && answer.state !== "yes") return signedOut(key, answer.state);
          const r = safe(() => get(key).entry?.reading, null);
          if (!r) return serve(key, failedUsage(key, sourceOf(key), "not_read_yet"), answer?.billing);
          const note = background(key) && started.has(key) ? [r.note, BEING_TAKEN].filter(Boolean).join("; ") : r.note;
          return serve(key, summarize({ pool: key, source: r.source ?? sourceOf(key), ts: r.takenAt, windows: r.windows, note, cls: r.class, reason: r.reason, until: r.trustedUntil, nowSec: now() }), answer?.billing);
        } catch { return servedRow(failedUsage(key, sourceOf(key)), key); }
      });
      return { served, refreshing: started.size > 0 };
    },

    // A person's named read of a slow source (`routr usage cursor`): read now, awaited, and kept; it claims nothing.
    // Its reader's own gate leaves a harness that is not signed in unread. Answers the reader's raw reading (`{ ok: true,
    // ... }`), a classified failure (`{ ok: false, code, why, note? }`), or `{ ok: false, excluded: true, why }`. Every
    // try is recorded.
    async readNow(key) {
      if (!background(key)) return { ok: false, ...usageFailure("source_missing") };
      const o = await readOne(key);
      record(key, o);
      return o.ok ? o.raw : o.excluded ? { ok: false, excluded: true, why: o.why } : { ok: false, ...usageFailure(o.code), ...(o.note ? { note: o.note } : {}) };
    },

    // The detached refresh job, and only it: reads every key its claim still holds, slow and fast together, and keeps
    // each as it lands. A token no claim holds (unknown, or a newer claim took the key) reads nothing.
    async refreshClaimed(token) {
      if (typeof token !== "string" || !token) return;
      // A claimed source key, as a name to read it by: a subscription of the caller's config, a harness, or the key
      // itself. One no name here is kept under (the config changed since the claim) is not read: read by another
      // name, it would be another login's reading.
      const names = [...Object.keys(caller?.subscriptions ?? {}), ...Object.keys(HARNESSES)];
      const made = (source) => source !== harnessOf(source) && Boolean(HARNESSES[harnessOf(source)]?.folder);
      const keys = safe(() => store.claimed(token), []).map((source) => names.find((n) => keyOf(n) === source) ?? (made(source) ? null : source)).filter((key, i, all) => key != null && all.indexOf(key) === i);
      await Promise.all(keys.map(async (key) => {
        let answer; try { answer = await ask(key); } catch { answer = { state: "no answer" }; }
        record(key, answer.state === "yes" ? await readOne(key) : { ok: false, excluded: true }, token);
      }));
    },
  };
}
