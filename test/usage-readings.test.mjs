// The usage-readings module, through its interface: a fake clock, fake readers, a recording starter and fake sign-in
// answers. Nothing is detached and no harness is called. Lock and claim races run against the real file store in a
// scratch folder.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLOCKS, due, fileStore, memoryStore, usageReadings } from "../src/lib/usage-readings.mjs";
import { codexSnapshot, summarize } from "../src/lib/usage.mjs";
import { cursorReading } from "../src/lib/cursor-usage.mjs";
import { kiroReading } from "../src/lib/kiro-usage.mjs";
import { staleReaders, usageFailure } from "../src/lib/usage-failure.mjs";
import { releaseFileLock, takeLock } from "../src/lib/state-files.mjs";
import { scratch } from "./helpers.mjs";

const T = 1_800_000_000;
const V = "0.9.0";
const clockAt = (t = T) => { const c = { t, now: () => c.t, advance: (s) => { c.t += s; return c; } }; return c; };
const recorder = (ok = true) => { const s = { calls: [], start: (argv) => { s.calls.push(argv); return ok; } }; return s; };
const tokenOf = (argv) => argv[argv.indexOf("--claim") + 1];
// Sign-in answers by key: `state()` counts each ask, `kept()` is the kept answer (null: none).
const answers = (now = {}, kept = {}) => {
  const s = { asked: [], state: async (key, o) => { s.asked.push([key, Boolean(o?.fresh)]); return (typeof now === "function" ? now(key, o) : now[key]) ?? { state: "yes", billing: null }; },
    kept: (key) => kept[key] ?? null, why: (key, state) => `${key} is ${state}` };
  return s;
};
// An inline reader answering rows made at the reader's own clock; a slow one answering Cursor's or Kiro's raw screen.
const inline = (source, rowAt, extra = {}) => ({ source, speed: "inline", read: async (ctx) => rowAt(ctx.nowSec), ...extra });
const cursorScreen = (pct) => ({ ok: true, subscription: "cursor", plan: "Team", included_used_pct: pct, auto_used_pct: 1, api_used_pct: 0, headroom: 1 - pct / 100 });
const slow = (raws, toReading = cursorReading, source = "cursor /usage") => {
  const r = { source, speed: "background", checks: 0, reading: (raw, at) => toReading(raw, at),
    check: async () => { r.checks++; const next = Array.isArray(raws) ? raws.shift() : raws; return typeof next === "function" ? next() : next; } };
  return r;
};
const claude = (pct, ts = T) => (nowSec) => summarize({ pool: "claude", source: "claude /usage", ts, windows: [{ name: "seven_day", usedPct: pct, windowMin: 10080, resetsAt: ts + 7 * 86400 }], nowSec });
const make = (o = {}) => {
  const ports = { clock: clockAt(), starter: recorder(), store: memoryStore(), signIn: answers(), ...o };
  return { ...ports, r: usageReadings({ configPath: null, version: V, ...ports }) };
};
const rowsOf = (served) => served.map((s) => s.row);

test("configPath is required when the module is made: null names the default config", () => {
  expect(() => usageReadings({})).toThrow(/configPath is required/);
  expect(() => usageReadings({ configPath: null, store: memoryStore() })).not.toThrow();
});

test("it serves { key, row, takenAt, windowSince }, the row exactly the reader's row, its provenance in milliseconds", async () => {
  const { r } = make({ readers: { claude: inline("claude /usage", (n) => summarize({ pool: "claude", source: "claude /usage", ts: T - 7200, nowSec: n,
    windows: [{ name: "five_hour", usedPct: 90, windowMin: 300, resetsAt: T - 3600 }, { name: "seven_day", usedPct: 40, windowMin: 10080, resetsAt: T + 86400 }] })) } });
  const [s] = await r.live(["claude"]);
  expect(Object.keys(s).sort()).toEqual(["key", "row", "takenAt", "windowSince"]);
  expect(s).toMatchObject({ key: "claude", takenAt: (T - 7200) * 1000, windowSince: { five_hour: (T - 3600) * 1000 } });
  expect(s.row).toEqual({ pool: "claude", source: "claude /usage", ageSec: 7200, headroom: 0.6, class: "included", note: undefined,
    windows: [{ name: "five_hour", usedPct: 0, windowMin: 300, resetsAt: T - 3600 }, { name: "seven_day", usedPct: 40, windowMin: 10080, resetsAt: T + 86400 }] });
});

// ---- at most one refresh per period --------------------------------------------------------------------------------
test("eight callers at once start one refresh between them, with the caller's --config; null starts it with none", () => {
  for (const [configPath, tail] of [["rel/routr.json", ["--config", resolve("rel/routr.json")]], [null, []]]) {
    const dir = scratch("claim-eight"), starter = recorder(), clock = clockAt();
    const readers = { claude: inline("claude /usage", claude(10)), cursor: slow([]) };
    const results = Array.from({ length: 8 }, () => usageReadings({ configPath, version: V, store: fileStore(dir, { legacy: null }), clock, starter, readers, signIn: answers() }).kept(["claude", "cursor"]));
    expect(results.map((x) => x.refreshing)).toEqual([true, false, false, false, false, false, false, false]);
    expect(starter.calls).toHaveLength(1);
    expect(starter.calls[0]).toEqual(["usage", "--background", "--claim", expect.any(String), ...tail]);
    // Within the period, nobody else starts one; past it, one more.
    clock.advance(CLOCKS.inlineRefreshSec - 1);
    usageReadings({ configPath, version: V, store: fileStore(dir, { legacy: null }), clock, starter, readers, signIn: answers() }).kept(["claude", "cursor"]);
    expect(starter.calls).toHaveLength(1);
    clock.advance(2);
    usageReadings({ configPath, version: V, store: fileStore(dir, { legacy: null }), clock, starter, readers, signIn: answers() }).kept(["claude", "cursor"]);
    expect(starter.calls).toHaveLength(2);
    expect(starter.calls[1].slice(4)).toEqual(tail);
  }
});

test("eight processes at once against one store claim each key once between them", async () => {
  const dir = scratch("claim-processes"), starts = join(dir, "starts.jsonl");
  const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/claim-race.mjs"), dir, starts, "/x/routr.json"], { stdout: "pipe", stderr: "pipe" }));
  writeFileSync(join(dir, "go"), "");
  const outs = await Promise.all(children.map(async (p) => { expect(await p.exited, await new Response(p.stderr).text()).toBe(0); return JSON.parse(await new Response(p.stdout).text()); }));
  // Each key is claimed by one caller: one refresh as a rule, and never two for one key (two callers can each win a
  // different key's lock, and each starts one for the key it holds).
  const started = readFileSync(starts, "utf8").trim().split("\n").map((l) => JSON.parse(l)), tokens = started.map(tokenOf);
  expect(started.length).toBeGreaterThanOrEqual(1); expect(started.length).toBeLessThanOrEqual(2);
  expect(outs.filter(Boolean)).toHaveLength(started.length);
  expect(new Set(tokens).size).toBe(started.length);
  for (const argv of started) expect(argv.slice(-2)).toEqual(["--config", resolve("/x/routr.json")]); // resolved: a drive letter on Windows
  const store = fileStore(join(dir, "usage"), { legacy: null });
  expect(tokens.flatMap((t) => store.claimed(t)).sort()).toEqual(["claude", "cursor"]);
});

test("a caller that meets a key's lock held, or is overtaken between its check and its mark, starts nothing", () => {
  // The file store: another caller holds the key's lock.
  const dir = scratch("claim-held"), store = fileStore(dir, { legacy: null }), starter = recorder();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "claude.json.lock");
  expect(takeLock(lock, () => false)).toBe(true);
  const held = usageReadings({ configPath: null, store, clock: clockAt(), starter, readers: { claude: inline("claude /usage", claude(10)) }, signIn: answers() }).kept(["claude"]);
  expect([held.refreshing, starter.calls.length, existsSync(join(dir, "claude.json"))]).toEqual([false, 0, false]);
  releaseFileLock(lock);
  // The memory store, paused between the check and the mark: a second caller then finds the key locked.
  const inner = [];
  const paused = memoryStore({ pause: () => inner.push(usageReadings({ configPath: null, store: paused, clock: clockAt(), starter, readers: { claude: inline("claude /usage", claude(10)) }, signIn: answers() }).kept(["claude"]).refreshing) });
  usageReadings({ configPath: null, store: paused, clock: clockAt(), starter, readers: { claude: inline("claude /usage", claude(10)) }, signIn: answers() }).kept(["claude"]);
  expect([inner, starter.calls.length]).toEqual([[false], 1]);
});

test("a claimer whose lock was taken over before its mark leaves the newer entry and starts nothing", async () => {
  const dir = scratch("claim-mark");
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/lock-pauses.mjs"), "mark", dir], { stdout: "pipe", stderr: "pipe" });
  expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
  const out = JSON.parse(await new Response(p.stdout).text());
  expect(out).toMatchObject({ taken: true, started: 0, entry: { reading: { takenAt: T + 100 }, attempt: { at: T + 100, outcome: "ok" } } });
  expect(out.entry.attempt.pending).toBeUndefined();
});

test("a mark that cannot be written starts nothing, and a start that fails leaves the mark: neither tries on every call", () => {
  const dir = scratch("claim-blocked"), blocked = join(dir, "not-a-folder");
  writeFileSync(blocked, "");
  const starter = recorder();
  for (let i = 0; i < 3; i++) usageReadings({ configPath: null, store: fileStore(join(blocked, "usage"), { legacy: null }), clock: clockAt(), starter, readers: { claude: inline("claude /usage", claude(10)) }, signIn: answers() }).kept(["claude"]);
  expect(starter.calls).toEqual([]);
  const failing = recorder(false), store = memoryStore();
  const first = usageReadings({ configPath: null, store, clock: clockAt(), starter: failing, readers: { cursor: slow([]) }, signIn: answers() }).kept(["cursor"]);
  const again = usageReadings({ configPath: null, store, clock: clockAt(T + 60), starter: failing, readers: { cursor: slow([]) }, signIn: answers() }).kept(["cursor"]);
  expect([first.refreshing, again.refreshing, failing.calls.length]).toEqual([false, false, 1]);
  expect(first.served[0].row.note).not.toContain("being taken"); // only a refresh that started is said
});

// The fix of 2026-11: a background refresh of Cursor's or Kiro's usage was started without the caller's --config, and
// took its lock without first making the cache folder.
test("a slow source's background refresh carries the caller's --config, on a new machine with no cache folder yet", async () => {
  const dir = join(scratch("cold"), "not", "made", "usage"), starter = recorder();
  const r = usageReadings({ configPath: "/x/routr.json", store: fileStore(dir, { legacy: null }), clock: clockAt(), starter, readers: { cursor: slow([]), kiro: slow([], kiroReading, "kiro /usage") }, signIn: answers() });
  const served = await r.live(["cursor", "kiro"]);
  expect(starter.calls).toEqual([["usage", "--background", "--claim", expect.any(String), "--config", resolve("/x/routr.json")]]);
  expect(readdirSync(dir).sort()).toEqual(["cursor.json", "kiro.json"]);
  expect(served.map((s) => s.row.note)).toEqual(["no reading yet; a fresh reading is being taken in the background; remaining capacity is unknown.", "no reading yet; a fresh reading is being taken in the background; remaining capacity is unknown."]);
});

// The fix of 2026-11: `routr board` could repeat a kept note such as "a fresh reading is being taken in the background"
// long after it was true. Notes are worded when a reading is served.
test("a kept reading's note says a reading is being taken only when this call started one", async () => {
  // 1. A good slow reading.
  const store = fileStore(scratch("note"), { legacy: null });
  const { r, starter, clock } = make({ store, readers: { cursor: slow([cursorScreen(40), cursorScreen(30)]) } });
  r.kept(["cursor"]);
  await r.refreshClaimed(tokenOf(starter.calls[0]));
  // 2. Aged until a live call starts a refresh, which serves the old reading and says so.
  clock.advance(CLOCKS.backgroundRefreshSec + 60);
  const [live] = rowsOf(await r.live(["cursor"]));
  expect([live.note, live.headroom]).toEqual(["Included 40% used (Auto 1%, API 0%); a fresh reading is being taken in the background", 0.6]);
  // 3. The refresh completes. 4. Read with no further live call: no suffix.
  await r.refreshClaimed(tokenOf(starter.calls[1]));
  clock.advance(60);
  const kept = r.kept(["cursor"]);
  expect([kept.refreshing, kept.served[0].row.note, kept.served[0].row.headroom]).toEqual([false, "Included 30% used (Auto 1%, API 0%)", 0.7]);
  // Four hours on, a kept read that starts one itself says so once; the next, with that one under way, does not.
  clock.advance(CLOCKS.backgroundRefreshSec);
  expect(r.kept(["cursor"]).served[0].row.note).toBe("Included 30% used (Auto 1%, API 0%); a fresh reading is being taken in the background");
  expect(r.kept(["cursor"]).served[0].row.note).toBe("Included 30% used (Auto 1%, API 0%)");
});

// ---- validity at both bounds ----------------------------------------------------------------------------------------
test("a reading's validity holds at both bounds, the same live and kept: a Codex stop for 300 s, a Cursor reading for a day", async () => {
  const stop = (n) => codexSnapshot({ spendControlReached: true, primary: { usedPercent: 10, windowDurationMins: 300 } }, "app-server", T, n);
  const { r, store, clock } = make({ readers: { codex: inline("app-server", stop), cursor: slow([cursorScreen(20)]) } });
  await r.live(["codex"]); // kept as read
  store.put("cursor", { ...cursorReading(cursorScreen(20), T), trustedUntil: T + CLOCKS.backgroundTrustSec }, { at: T, by: V, outcome: "ok" });
  const at = async (t) => {
    clock.t = t;
    const live = rowsOf(await r.live(["codex", "cursor"], { mayRefresh: [] })), kept = rowsOf(r.kept(["codex", "cursor"], { mayRefresh: [] }).served);
    return [live.map((x) => [x.headroom, x.class]), kept.map((x) => [x.headroom, x.class])];
  };
  expect(await at(T + 299)).toEqual([[[0, "metered"], [0.8, "included"]], [[0, "metered"], [0.8, "included"]]]);
  expect(await at(T + 301)).toEqual([[[null, "unknown"], [0.8, "included"]], [[null, "unknown"], [0.8, "included"]]]);
  expect(await at(T + 23 * 3600)).toEqual([[[null, "unknown"], [0.8, "included"]], [[null, "unknown"], [0.8, "included"]]]);
  expect(await at(T + 24 * 3600)).toEqual([[[null, "unknown"], [null, "unknown"]], [[null, "unknown"], [null, "unknown"]]]);
  // Nor before it was read: a reading from 60 s in the future (a clock set back) is not used.
  expect(await at(T - 60)).toEqual([[[null, "unknown"], [null, "unknown"]], [[null, "unknown"], [null, "unknown"]]]);
});

// ---- kept readings keep no failed read ------------------------------------------------------------------------------
test("a failed read leaves the kept reading as it was; only a live read says the last try failed", async () => {
  let claudeRow = claude(30);
  const { r, store, starter, clock } = make({ readers: { claude: inline("claude /usage", (n) => claudeRow(n)), cursor: slow([cursorScreen(20), { ok: false, code: "read_failed", why: "raw" }]) } });
  await r.live(["claude", "cursor"]);
  await r.refreshClaimed(tokenOf(starter.calls[0]));
  claudeRow = (n) => summarize({ pool: "claude", source: "claude /usage", nowSec: n, failure: usageFailure("no_response") });
  clock.advance(CLOCKS.backgroundRefreshSec + 60);
  const live = rowsOf(await r.live(["claude", "cursor"]));
  await r.refreshClaimed(tokenOf(starter.calls[1]));
  expect(store.get("claude").entry.reading.windows[0].usedPct).toBe(30);
  expect(store.get("cursor").entry).toMatchObject({ reading: { windows: [{ usedPct: 20 }] }, attempt: { outcome: "failed", code: "read_failed" } });
  expect(JSON.stringify(store.get("cursor").entry)).not.toContain("raw");
  const kept = rowsOf(r.kept(["claude", "cursor"], { mayRefresh: [] }).served);
  expect(kept.map((x) => [x.pool, x.failure ?? null, x.headroom])).toEqual([["claude", null, 0.7], ["cursor", null, 0.8]]);
  const cursorLive = rowsOf(await r.live(["cursor"], { mayRefresh: [] }))[0];
  expect(cursorLive).toMatchObject({ headroom: 0.8, failure: usageFailure("read_failed"), kept: { source: "cursor snapshot", ageSec: CLOCKS.backgroundRefreshSec + 60 } });
  expect(cursorLive.note).toContain("the last try failed: routr could not read this usage source.");
  expect(live[0].failure).toEqual(usageFailure("no_response"));
  // A day without a good reading: only a live read warns that the reader stopped working.
  clock.advance(CLOCKS.backgroundTrustSec);
  const config = { subscriptions: { cursor: {} } };
  expect(staleReaders(rowsOf(await r.live(["cursor"], { mayRefresh: [] })), config).map((s) => s.pool)).toEqual(["cursor"]);
  expect(staleReaders(rowsOf(r.kept(["cursor"], { mayRefresh: [] }).served), config)).toEqual([]);
});

test("a kept reading is replaced only by a newer one: a refresh that ran long cannot put back an older reading", async () => {
  let ts = T;
  const { r, store } = make({ readers: { claude: inline("claude /usage", (n) => claude(ts === T ? 40 : 99, ts)(n)) } });
  await r.live(["claude"]);
  ts = T - 120;
  await r.live(["claude"]);
  expect(store.get("claude").entry.reading).toMatchObject({ takenAt: T, windows: [{ usedPct: 40 }] });
  // The file store keeps the same rule.
  const files = fileStore(scratch("monotonic"), { legacy: null });
  files.put("claude", { source: "claude /usage", takenAt: T, windows: [{ name: "five_hour", usedPct: 40 }] }, undefined);
  files.put("claude", { source: "claude /usage", takenAt: T - 120, windows: [{ name: "five_hour", usedPct: 99 }] }, undefined);
  expect(files.get("claude").entry.reading).toMatchObject({ takenAt: T, windows: [{ usedPct: 40 }] });
});

test("only a reading the harness gave is kept: not a given number, a sign-in refusal, or a fallback that carries an older reading", async () => {
  const fallback = (n) => ({ ...claude(50)(n), failure: usageFailure("no_response"), kept: { source: "statusline", ageSec: 900 } });
  const { r, store } = make({ readers: { claude: inline("claude /usage", fallback), codex: inline("app-server", claude(10)) }, signIn: answers({ agy: { state: "no" } }) });
  const served = await r.live(["claude", "codex", "agy"], { given: { codex: 0.5 } });
  expect(rowsOf(served).map((x) => [x.pool, x.headroom, x.signedIn ?? true])).toEqual([["claude", 0.5, true], ["codex", 0.5, true], ["agy", null, false]]);
  expect([...store.entries.keys()]).toEqual([]);
});

// ---- billing travels with the sign-in answer ------------------------------------------------------------------------
const METERED = { billing: "metered", why: "signed in with an API key, billed per token" };
const noWindows = (n) => summarize({ pool: "claude", source: "claude /usage", nowSec: n, reason: "no_windows_after_answer", note: "no windows" });
test("billing settles from the sign-in answer it came with: kept, fresh, and a doctor's answers without a second check", async () => {
  // A fresh process whose first call is kept(): the kept answer alone, no check run.
  const signIn = answers({}, { claude: { state: "yes", billing: METERED } });
  const { r } = make({ readers: { claude: inline("claude /usage", noWindows) }, signIn });
  const [kept] = rowsOf(r.kept(["claude"], { mayRefresh: [] }).served);
  expect([kept.class, kept.billing?.billing, signIn.asked]).toEqual(["metered", "metered", []]);
  // A live read with no windows asks the status again now: a login switched since the kept answer counts.
  const switched = answers((k, o) => (o?.fresh ? { state: "yes", billing: METERED } : { state: "yes", billing: null }));
  const [live] = rowsOf(await make({ readers: { claude: inline("claude /usage", noWindows, { billsBySignIn: true }) }, signIn: switched }).r.live(["claude"]));
  expect([live.class, live.reason, switched.asked]).toEqual(["metered", undefined, [["claude", false], ["claude", true]]]);
  // …and when that answer is no longer "signed in", the harness is left out of this call.
  const out = answers((k, o) => (o?.fresh ? { state: "no", billing: null } : { state: "yes", billing: null }));
  const [left] = rowsOf(await make({ readers: { claude: inline("claude /usage", noWindows, { billsBySignIn: true }) }, signIn: out }).r.live(["claude"]));
  expect(left).toMatchObject({ signedIn: false, headroom: null, note: "claude is no" });
  // Windows arrived: no second ask, and the windows decide.
  const once = answers({ claude: { state: "yes", billing: METERED } });
  const [windows] = rowsOf(await make({ readers: { claude: inline("claude /usage", claude(40), { billsBySignIn: true }) }, signIn: once }).r.live(["claude"]));
  expect([windows.headroom, windows.class, once.asked]).toEqual([0.6, "included", [["claude", false]]]);
  // Doctor's answers, just asked afresh: no status check at all, and their billing settles the class.
  const doctor = answers();
  const [d] = rowsOf(await make({ readers: { claude: inline("claude /usage", noWindows, { billsBySignIn: true }) }, signIn: doctor }).r.live(["claude"], { signIns: { claude: { state: "yes", billing: METERED } } }));
  expect([d.class, doctor.asked]).toEqual(["metered", []]);
});

test("a harness that is not signed in is never read, never kept, and says how to sign in, live or kept", async () => {
  const reader = slow([cursorScreen(10)]), claudeReads = [];
  const { r, starter } = make({ readers: { cursor: reader, claude: inline("claude /usage", (n) => { claudeReads.push(n); return claude(10)(n); }) },
    signIn: answers({ cursor: { state: "no answer" }, claude: { state: "no" } }, { cursor: { state: "no" } }) });
  const live = rowsOf(await r.live(["cursor", "claude"]));
  expect(live.map((x) => [x.pool, x.signedIn, x.note])).toEqual([["cursor", false, "cursor is no answer"], ["claude", false, "claude is no"]]);
  expect([reader.checks, claudeReads, starter.calls]).toEqual([0, [], []]);
  expect(rowsOf(r.kept(["cursor"], { mayRefresh: [] }).served)[0]).toMatchObject({ signedIn: false, note: "cursor is no" });
  // A refresh job finds it signed out: the try is recorded as excluded, and nothing is read.
  const job = make({ readers: { cursor: slow([cursorScreen(10)]) }, signIn: answers({ cursor: { state: "no" } }) });
  job.r.kept(["cursor"]);
  await job.r.refreshClaimed(tokenOf(job.starter.calls[0]));
  expect([job.store.get("cursor").entry.attempt.outcome, job.store.get("cursor").entry.reading]).toEqual(["excluded", null]);
});

// ---- nothing waits on background work -------------------------------------------------------------------------------
test("a slow reader that never answers: live() and kept() still answer at once; only a person's named read waits on it", async () => {
  const never = slow(() => new Promise(() => {}));
  const { r, starter } = make({ readers: { cursor: never, claude: inline("claude /usage", claude(10)) } });
  const served = await r.live(["claude", "cursor"]);
  expect(rowsOf(served).map((x) => x.pool)).toEqual(["claude", "cursor"]);
  expect([never.checks, starter.calls.length]).toEqual([0, 1]);
  expect(served[1].row.note).toContain("being taken in the background");
  expect(r.kept(["cursor"]).refreshing).toBe(false); // one under way
  // mayRefresh: [] (a named read, doctor for an unconfigured harness) starts nothing.
  const quiet = make({ readers: { cursor: slow([]) } });
  await quiet.r.live(["cursor"], { mayRefresh: [] });
  quiet.r.kept(["cursor"], { mayRefresh: [] });
  expect(quiet.starter.calls).toEqual([]);
});

test("a person's named read reads now, keeps it, claims nothing, and records every try", async () => {
  const reader = slow([{ ok: false, code: "no_response", why: "RAW", read_yourself: "x" }, cursorScreen(66), () => { throw new Error("RAW"); }]);
  const { r, store, starter, clock } = make({ readers: { cursor: reader } });
  expect(await r.readNow("cursor")).toEqual({ ok: false, ...usageFailure("no_response") });
  expect(store.get("cursor").entry).toEqual({ reading: null, attempt: { at: T, by: V, outcome: "failed", code: "no_response" } });
  clock.advance(5);
  expect(await r.readNow("cursor")).toEqual(cursorScreen(66));
  expect(store.get("cursor").entry).toMatchObject({ reading: { takenAt: T + 5, trustedUntil: T + 5 + CLOCKS.backgroundTrustSec, windows: [{ name: "included", usedPct: 66 }] }, attempt: { outcome: "ok" } });
  expect(await r.readNow("cursor")).toEqual({ ok: false, ...usageFailure("read_failed") });
  expect(store.get("cursor").entry.reading.windows[0].usedPct).toBe(66);
  expect(starter.calls).toEqual([]);
  // A Kiro read that left its session behind keeps its note for the command's warning.
  const kiro = make({ readers: { kiro: slow([{ ok: false, code: "invalid_response", note: "Kiro kept an empty usage session; inspect its saved sessions to remove it." }], kiroReading, "kiro /usage") } });
  expect(await kiro.r.readNow("kiro")).toMatchObject({ ok: false, code: "invalid_response", note: expect.stringContaining("empty usage session") });
  // Not signed in: its reader's own gate leaves it unread, and says why; the try is recorded as excluded.
  const out = make({ readers: { cursor: slow([{ ok: false, excluded: true, why: "not signed in: run `cursor-agent login`" }]) } });
  expect(await out.r.readNow("cursor")).toEqual({ ok: false, excluded: true, why: "not signed in: run `cursor-agent login`" });
  expect(out.store.get("cursor").entry).toEqual({ reading: null, attempt: { at: T, by: V, outcome: "excluded" } });
  // A reading that worked but cannot be kept is still the person's answer; nothing is kept.
  const odd = make({ readers: { cursor: slow([{ ok: true, opened: true }], () => null) } });
  expect(await odd.r.readNow("cursor")).toEqual({ ok: true, opened: true });
  expect(odd.store.get("cursor").entry).toEqual({ reading: null, attempt: { at: T, by: V, outcome: "failed", code: "invalid_response" } });
  // A source read in the call has no named read.
  expect(await make({ readers: { claude: inline("claude /usage", claude(1)) } }).r.readNow("claude")).toMatchObject({ ok: false, code: "source_missing" });
});

// ---- when a refresh is due ------------------------------------------------------------------------------------------
test("a try an older routr made that got no reading does not hold back the next one; this version's waits its period", () => {
  const P = CLOCKS.backgroundRefreshSec, failed = (by, outcome = "failed") => ({ reading: null, attempt: { at: T - 600, by, outcome, code: "read_failed" } });
  for (const [label, entry, isDue] of [
    ["no version (0.8.0 and before)", failed(null), true], ["an older version", failed("0.7.0"), true], ["an older version, excluded", failed("0.7.0", "excluded"), true],
    ["a version that only looks newer", failed("0.9.invalid"), true], ["a version with a fourth number", failed("0.8.1.0"), true],
    ["a pre-release number with a leading zero", failed("0.9.0-beta.01"), true], ["a newer pre-release", failed("0.9.1-beta.1"), false],
    ["this version", failed(V), false], ["this version, excluded", failed(V, "excluded"), false], ["a newer version", failed("1.0.0"), false],
    ["an older version that got a reading", { reading: { takenAt: T - 600, windows: [] }, attempt: { at: T - 600, by: "0.7.0", outcome: "ok" } }, false],
    ["nothing kept, never tried", null, true]]) {
    const stored = memoryStore({ entries: entry ? { cursor: entry } : {} }).get("cursor").entry ?? null; // as the store reads it back
    expect([label, due(stored, P, T, V)]).toEqual([label, isDue]);
  }
  // Through the module: a failed try this version made holds back the next for the period; the store keeps `by`.
  const store = memoryStore({ entries: { cursor: failed("0.7.0") } }), starter = recorder();
  const at = (t) => usageReadings({ configPath: null, version: V, store, clock: clockAt(t), starter, readers: { cursor: slow([]) }, signIn: answers() }).kept(["cursor"]).refreshing;
  expect([at(T), at(T + 60), at(T + P + 1)]).toEqual([true, false, true]);
  expect(store.get("cursor").entry.attempt.by).toBe(V);
  // A source checkout and an installed binary sharing the cache, both failing: the newer retries once, the older never.
  const shared = memoryStore({ entries: { cursor: failed("0.0.0-dev") } }), seen = [];
  for (let k = 0; k < 4; k++) {
    const version = k % 2 ? "0.0.0-dev" : V, s = recorder();
    const r = usageReadings({ configPath: null, version, store: shared, clock: clockAt(T + k * 60), starter: s, readers: { cursor: slow([{ ok: false, code: "read_failed" }]) }, signIn: answers() });
    seen.push(r.kept(["cursor"]).refreshing);
  }
  expect(seen).toEqual([true, false, false, false]);
});

test("the refresh job reads only what its claim still holds, and keeps each key as it lands", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { r, store, starter } = make({ readers: { claude: inline("claude /usage", claude(25)), cursor: slow([() => gate.then(() => cursorScreen(30))]) } });
  r.kept(["claude", "cursor"]);
  await r.refreshClaimed("not-the-token");
  await r.refreshClaimed(undefined);
  expect([store.get("claude").entry.reading, store.get("cursor").entry.reading]).toEqual([null, null]);
  const job = r.refreshClaimed(tokenOf(starter.calls[0]));
  await Bun.sleep(5);
  // Claude's reading is in while Cursor's is still being read.
  expect([store.get("claude").entry.reading?.windows[0].usedPct, store.get("cursor").entry.reading]).toEqual([25, null]);
  release(); await job;
  expect(store.get("cursor").entry).toMatchObject({ reading: { windows: [{ usedPct: 30 }] }, attempt: { outcome: "ok" } });
  expect(store.claimed(tokenOf(starter.calls[0]))).toEqual([]);
  // A claim taken over by a newer one: the older job reads nothing.
  const late = make({ readers: { cursor: slow([cursorScreen(5)]) } });
  late.r.kept(["cursor"]);
  late.clock.advance(CLOCKS.backgroundRefreshSec + 1);
  late.r.kept(["cursor"]);
  await late.r.refreshClaimed(tokenOf(late.starter.calls[0]));
  expect(late.store.get("cursor").entry.reading).toBeNull();
});

// ---- keys -----------------------------------------------------------------------------------------------------------
test("source keys of one harness are stored, claimed and billed apart", async () => {
  const signIn = answers({}, { codex: { state: "yes", billing: METERED }, "codex~work": { state: "yes", billing: null } });
  const { r, store, starter } = make({ readers: { codex: inline("app-server", (n) => summarize({ pool: "codex", source: "app-server", nowSec: n })) }, signIn });
  const kept = r.kept(["codex", "codex~work"]);
  expect(rowsOf(kept.served).map((x) => [x.pool, x.class])).toEqual([["codex", "metered"], ["codex~work", "unknown"]]);
  expect([...store.entries.keys()].sort()).toEqual(["codex", "codex~work"]);
  expect(store.claimed(tokenOf(starter.calls[0])).sort()).toEqual(["codex", "codex~work"]);
  const files = fileStore(scratch("keys"), { legacy: null });
  files.put("codex~work", { source: "app-server", takenAt: T, windows: [] }, undefined);
  expect([files.get("codex~work").entry.reading.takenAt, files.get("codex").entry]).toEqual([T, undefined]);
});

// ---- the file store -------------------------------------------------------------------------------------------------
test("the file store's entries are owner-only, and unreadable ones are said with a code", async () => {
  const dir = join(scratch("unreadable"), "usage");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cursor.json"), "{ not json");
  const store = fileStore(dir, { legacy: null });
  expect(store.get("cursor")).toEqual({ failure: "invalid_response" });
  const r = usageReadings({ configPath: null, store, clock: clockAt(), starter: recorder(), readers: { cursor: slow([]) }, signIn: answers() });
  r.kept(["cursor"]); // claims: a write
  if (process.platform !== "win32") expect(statSync(join(dir, "cursor.json")).mode & 0o777).toBe(0o600);
  // A folder where an entry should be: read_failed. A kept reading with no number: it cannot be read.
  mkdirSync(join(dir, "kiro.json"));
  expect(store.get("kiro")).toEqual({ failure: "read_failed" });
  writeFileSync(join(dir, "agy.json"), JSON.stringify({ reading: { source: "x", takenAt: T, windows: [{ name: "included", usedPct: "MARKER" }], other: "MARKER" }, attempt: { at: T, by: V, outcome: "failed", code: "MARKER", error: "MARKER" } }));
  expect(JSON.stringify(store.get("agy"))).not.toContain("MARKER");
  const bad = usageReadings({ configPath: null, store, clock: clockAt(T + 1), starter: recorder(), readers: { agy: slow([]) }, signIn: answers() });
  const [unreadable] = rowsOf(await bad.live(["agy"], { mayRefresh: [] }));
  expect([unreadable.headroom, unreadable.note]).toEqual([null, "the saved reading cannot be read; the last try failed: routr could not read this usage source.; remaining capacity is unknown."]);
});

// ---- routr's old files ----------------------------------------------------------------------------------------------
const LEGACY_FILES = ["cursor-usage.json", "kiro-usage.json", "usage-readings.json", "usage-refresh.json"];
const ageFile = (file, sec) => { const t = new Date(Date.now() - sec * 1000); utimesSync(file, t, t); };
test("an old lock whose file is already gone goes too once abandoned, never while held", async () => {
  const cache = join(scratch("legacy-lock"), ".cache/routr"), dir = join(cache, "usage");
  mkdirSync(cache, { recursive: true });
  const kiroLock = join(cache, "kiro-usage.json.lock"), cursorLock = join(cache, "cursor-usage.json.lock");
  writeFileSync(kiroLock, JSON.stringify({ pid: process.pid, token: "dead" })); ageFile(kiroLock, 3600); // abandoned
  writeFileSync(cursorLock, JSON.stringify({ pid: process.pid, token: "older-routr" })); ageFile(cursorLock, 60); // held
  fileStore(dir, { legacy: cache }).put("claude", { source: "claude /usage", takenAt: T, windows: [] }, undefined);
  expect([existsSync(kiroLock), existsSync(cursorLock)]).toEqual([false, true]);
});

test("routr's old files go only once no older routr can be using them: over a day unchanged, with their lock absent or abandoned", async () => {
  const cache = join(scratch("legacy"), ".cache/routr"), dir = join(cache, "usage"), DAY = 24 * 3600;
  mkdirSync(cache, { recursive: true });
  for (const f of [...LEGACY_FILES, "claude-usage.json", "signed-in.json"]) writeFileSync(join(cache, f), "{}");
  // Cursor's snapshot is two days old, but an older routr refreshing it right now holds its lock (taken a minute ago,
  // under its 120 s rule). Kiro's is two days old, with a lock a refresh that died long ago left. The kept readings,
  // written with no lock, are two days old. The cache mark was written a minute ago: an older routr is still running.
  const cursorLock = join(cache, "cursor-usage.json.lock"), kiroLock = join(cache, "kiro-usage.json.lock");
  for (const f of ["cursor-usage.json", "kiro-usage.json", "usage-readings.json"]) ageFile(join(cache, f), 2 * DAY);
  ageFile(join(cache, "usage-refresh.json"), 60);
  writeFileSync(cursorLock, JSON.stringify({ pid: process.pid, token: "older-routr" })); ageFile(cursorLock, 60);
  writeFileSync(kiroLock, JSON.stringify({ pid: process.pid, token: "dead" })); ageFile(kiroLock, 3600);
  const store = fileStore(dir, { legacy: cache });
  // Reading removes nothing, and neither does a write that cannot land.
  store.get("cursor");
  const blocked = fileStore(join(cache, "signed-in.json", "usage"), { legacy: cache });
  expect(blocked.put("claude", { source: "claude /usage", takenAt: T, windows: [] }, undefined)).toBe(false);
  expect(LEGACY_FILES.every((f) => existsSync(join(cache, f)))).toBe(true);
  // The first write: the old unlocked file goes, and Kiro's with its abandoned lock; a fresh one stays, and a held lock
  // keeps its file.
  store.put("claude", { source: "claude /usage", takenAt: T, windows: [] }, undefined);
  expect(readdirSync(cache).sort()).toEqual(["claude-usage.json", "cursor-usage.json", "cursor-usage.json.lock", "signed-in.json", "usage", "usage-refresh.json"]);
  expect(JSON.parse(readFileSync(cursorLock, "utf8")).token).toBe("older-routr"); // never removed or taken over while held
  // That older routr stops: its lock is abandoned (past 120 s) and the mark ages out; a later write removes them.
  ageFile(cursorLock, 121);
  store.put("claude", { source: "claude /usage", takenAt: T + 1, windows: [] }, undefined);
  expect(readdirSync(cache).sort()).toEqual(["claude-usage.json", "signed-in.json", "usage", "usage-refresh.json"]);
  ageFile(join(cache, "usage-refresh.json"), DAY + 60);
  store.put("claude", { source: "claude /usage", takenAt: T + 2, windows: [] }, undefined);
  expect(readdirSync(cache).sort()).toEqual(["claude-usage.json", "signed-in.json", "usage"]);
});

// ---- a person's read during a refresh -------------------------------------------------------------------------------
test("a person's failed named read during a background refresh is recorded beside its claim: the refresh's reading still lands", async () => {
  for (const kind of ["memory", "file"]) {
    let releaseA;
    const heldA = new Promise((r) => { releaseA = r; });
    const store = kind === "memory" ? memoryStore() : fileStore(scratch("named-during-refresh"), { legacy: null });
    const { r, starter, clock } = make({ store, readers: { cursor: slow([() => heldA.then(() => cursorScreen(25)), { ok: false, code: "no_response" }]) } });
    r.kept(["cursor"]);
    const token = tokenOf(starter.calls[0]);
    const a = r.refreshClaimed(token); // refresh A: holding its reader
    await Bun.sleep(5);
    clock.advance(30);
    expect(await r.readNow("cursor")).toEqual({ ok: false, ...usageFailure("no_response") });
    expect(store.get("cursor").entry.attempt).toEqual({ at: T + 30, by: V, outcome: "failed", code: "no_response", pending: true, token });
    clock.advance(30); releaseA(); await a;
    expect([kind, store.get("cursor").entry]).toEqual([kind, { reading: expect.objectContaining({ takenAt: T + 60, windows: [expect.objectContaining({ usedPct: 25 })] }), attempt: { at: T + 60, by: V, outcome: "ok" } }]);
    expect([kind, rowsOf(r.kept(["cursor"], { mayRefresh: [] }).served)[0].headroom]).toEqual([kind, 0.75]);
  }
});

// ---- a refresh that lost its claim ----------------------------------------------------------------------------------
test("a refresh that lost its claim while it read publishes nothing: the refresh that took the key over keeps its reading", async () => {
  for (const kind of ["memory", "file"]) {
    let releaseA;
    const heldA = new Promise((r) => { releaseA = r; });
    const reads = [() => heldA.then(() => cursorScreen(10)), cursorScreen(70)];
    const store = kind === "memory" ? memoryStore() : fileStore(scratch("lost-claim"), { legacy: null });
    const { r, starter, clock } = make({ store, readers: { cursor: slow(reads) } });
    r.kept(["cursor"]);
    const a = r.refreshClaimed(tokenOf(starter.calls[0])); // refresh A: held inside its reader
    await Bun.sleep(5);
    clock.advance(CLOCKS.backgroundRefreshSec + 1); // past the period, refresh B claims the key and finishes
    r.kept(["cursor"]);
    expect(starter.calls).toHaveLength(2);
    await r.refreshClaimed(tokenOf(starter.calls[1]));
    expect(store.get("cursor").entry.reading.windows[0].usedPct).toBe(70);
    clock.advance(60); releaseA(); await a; // A lands later, with a newer time: still not published
    expect([kind, store.get("cursor").entry.reading.windows[0].usedPct, store.get("cursor").entry.attempt.outcome]).toEqual([kind, 70, "ok"]);
  }
});

// ---- the start happens inside the claim's locks ---------------------------------------------------------------------
test("a claimer paused after its mark and overtaken starts nothing and does not say a reading is being taken", async () => {
  const dir = scratch("claim-spawn");
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/lock-pauses.mjs"), "spawn", dir], { stdout: "pipe", stderr: "pipe" });
  expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
  const out = JSON.parse(await new Response(p.stdout).text());
  expect(out).toMatchObject({ marked: true, taken: true, started: 0, refreshing: false });
  expect(out.note).not.toContain("being taken");
});

// ---- after an update ------------------------------------------------------------------------------------------------
test("after an update, a slow source whose last try an older routr failed is read again at once, even beside a fresh reading", async () => {
  const fresh = { ...cursorReading(cursorScreen(20), T - 600), trustedUntil: T - 600 + CLOCKS.backgroundTrustSec };
  for (const [by, starts] of [["0.7.0", 1], [null, 1], [V, 0]]) {
    const store = memoryStore({ entries: { cursor: { reading: fresh, attempt: { at: T - 300, by, outcome: "failed", code: "read_failed" } } } });
    const { r, starter } = make({ store, readers: { cursor: slow([]) } });
    const [row] = rowsOf(await r.live(["cursor"]));
    expect([by, starter.calls.length]).toEqual([by, starts]);
    if (starts) expect(row.note).toBe("Included 20% used (Auto 1%, API 0%); a fresh reading is being taken in the background; the last try failed: routr could not read this usage source.");
    expect(row.headroom).toBe(0.8);
  }
  // A good try this version made waits out the period, fresh reading or not.
  const ok = memoryStore({ entries: { cursor: { reading: fresh, attempt: { at: T - 300, by: V, outcome: "ok" } } } });
  const quiet = make({ store: ok, readers: { cursor: slow([]) } });
  await quiet.r.live(["cursor"]);
  expect(quiet.starter.calls).toEqual([]);
});

// ---- an unreadable entry keeps saying so ----------------------------------------------------------------------------
test("a claim records its try beside an unreadable entry: doctor's read keeps saying invalid_response until a try completes", async () => {
  const dir = scratch("unreadable-claim");
  writeFileSync(join(dir, "cursor.json"), "{ not json");
  const store = fileStore(dir, { legacy: null });
  const doctorRead = async (r) => rowsOf(await r.live(["cursor"], { signIns: { cursor: { state: "yes", billing: null } }, mayRefresh: ["cursor"] }))[0];
  const { r, starter } = make({ store, readers: { cursor: slow([{ ok: false, code: "no_response" }]) } });
  for (let i = 0; i < 2; i++) {
    const row = await doctorRead(r);
    expect([i, row.failure, row.headroom]).toEqual([i, usageFailure("invalid_response"), null]);
  }
  expect(starter.calls).toHaveLength(1);
  // The refresh's own try replaces what the unreadable entry said.
  await r.refreshClaimed(tokenOf(starter.calls[0]));
  expect((await doctorRead(r)).failure).toEqual(usageFailure("no_response"));
});
