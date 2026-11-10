// `routr board` and the usage cache under it: readings kept by live reads and served aged without a harness call, the
// join of launches to recorded runs, scope by a folder's project, counts by the ledger's rules, and what fails open.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { cachedReadings, keepReadings, STALE_SEC } from "../src/lib/usage-cache.mjs";
import { cachedUsage, readUsage } from "../src/lib/harnesses.mjs";
import { codexSnapshot, summarize, failedUsage } from "../src/lib/usage.mjs";
import { releaseFileLock, takeLock } from "../src/lib/runtime.mjs";
import { cliEnv, SCRIPT } from "./helpers.mjs";
import { boardCommand, DECISIONS_MAX, joinDecisions } from "../src/lib/board.mjs";
import { projectName } from "../src/lib/ledger.mjs";
import { cfg, scratch } from "./helpers.mjs";

const NOW = 1_800_000_000; // seconds
// The test setup turns background refreshes off (ROUTR_NO_REFRESH); the cache's own tests turn them on for a moment.
const withRefresh = (fn) => { const was = process.env.ROUTR_NO_REFRESH; delete process.env.ROUTR_NO_REFRESH; try { return fn(); } finally { process.env.ROUTR_NO_REFRESH = was; } };

test("a live read keeps each good reading as it was read; a given number, a failure or a signed-out harness keeps nothing", () => withRefresh(() => {
  const file = join(scratch("cache"), "usage-readings.json");
  const good = summarize({ pool: "claude", source: "claude /usage", ts: NOW - 60, windows: [{ name: "five_hour", usedPct: 40, windowMin: 300, resetsAt: NOW + 3600 }], nowSec: NOW });
  keepReadings([good, { pool: "codex", given: true, headroom: 0.5 }, failedUsage("agy", "agy /usage"), { ...summarize({ pool: "kiro", source: "x" }), signedIn: false }], { file });
  const kept = JSON.parse(readFileSync(file, "utf8")).readings;
  expect(Object.keys(kept)).toEqual(["claude"]);
  expect(kept.claude).toMatchObject({ pool: "claude", source: "claude /usage", ts: NOW - 60, windows: [{ name: "five_hour", usedPct: 40, windowMin: 300, resetsAt: NOW + 3600 }] });
  // A later failed read keeps the last good one, and an older reading (a refresh that ran long) does not replace it.
  keepReadings([failedUsage("claude", "claude /usage")], { file });
  keepReadings([summarize({ pool: "claude", source: "claude /usage", ts: NOW - 120, windows: [{ name: "five_hour", usedPct: 99 }], nowSec: NOW })], { file });
  expect(JSON.parse(readFileSync(file, "utf8")).readings.claude).toMatchObject({ ts: NOW - 60, windows: [{ usedPct: 40 }] });
}));

const cacheFiles = (name) => { const d = scratch(name); return { file: join(d, "usage-readings.json"), mark: join(d, "usage-refresh.json") }; };

test("a cached read serves kept readings aged to now, a window reset since rolled, and starts at most one detached read when they are stale", () => withRefresh(() => {
  const { file, mark } = cacheFiles("cache-read");
  keepReadings([summarize({ pool: "claude", source: "claude /usage", ts: NOW - 60, windows: [{ name: "five_hour", usedPct: 90, windowMin: 300, resetsAt: NOW + 600 }], nowSec: NOW })], { file });
  let started = 0; const refresh = () => ++started;
  // Fresh, nothing missing: no refresh.
  const fresh = cachedReadings(["claude"], { file, mark, now: NOW, refresh });
  expect([fresh.rows[0].ageSec, fresh.rows[0].headroom, fresh.missing, started]).toEqual([60, expect.closeTo(0.1, 5), [], 0]);
  // An hour later the window has reset: room is back, the age says how old the reading is, and one refresh starts.
  const later = cachedReadings(["claude", "codex"], { file, mark, now: NOW + 3600, refresh });
  expect([later.rows[0].ageSec, later.rows[0].headroom, later.missing, later.refreshing, started]).toEqual([3660, 1, ["codex"], true, 1]);
  // Within STALE_SEC of that try, no second one; the mark is its own file, and the readings are untouched by it.
  cachedReadings(["claude", "codex"], { file, mark, now: NOW + 3600 + STALE_SEC - 1, refresh });
  expect([started, JSON.parse(readFileSync(mark, "utf8")).tried, Object.keys(JSON.parse(readFileSync(file, "utf8")))]).toEqual([1, NOW + 3600, ["readings"]]);
}));

test("callers at the same moment start one refresh between them: the mark is checked and set under a lock", () => withRefresh(() => {
  const { file, mark } = cacheFiles("cache-lock"), lock = `${mark}.lock`;
  let started = 0; const refresh = () => ++started;
  // A caller holding the lock (alive, just taken): this one starts nothing and marks nothing.
  expect(takeLock(lock, () => false)).toBe(true);
  expect([cachedReadings(["codex"], { file, mark, lock, now: NOW, refresh }).refreshing, started, existsSync(mark)]).toEqual([false, 0, false]);
  releaseFileLock(lock);
  // Once it is free, one starts, and the lock is released after the mark.
  expect([cachedReadings(["codex"], { file, mark, lock, now: NOW, refresh }).refreshing, started, existsSync(lock)]).toEqual([true, 1, false]);
  // The refresh is the caller's config: it reads the subscriptions that config names.
  const argv = [];
  cachedReadings(["codex"], { ...cacheFiles("cache-config"), now: NOW, configPath: "/x/routr.json", spawn: (a) => argv.push(a) });
  cachedReadings(["codex"], { ...cacheFiles("cache-default"), now: NOW, spawn: (a) => argv.push(a) });
  expect(argv).toEqual([["usage", "--config", "/x/routr.json"], ["usage"]]);
}));

test("a kept reading obeys its source's own limit: a resetless Codex stop for 5 minutes, a Cursor or Kiro snapshot for a day", () => withRefresh(() => {
  const { file, mark } = cacheFiles("cache-trust");
  const stop = codexSnapshot({ spendControlReached: true, primary: { usedPercent: 10, windowDurationMins: 300 } }, "app-server", NOW, NOW);
  const snap = summarize({ pool: "cursor", source: "cursor /usage", ts: NOW, windows: [{ name: "included", usedPct: 20 }], until: NOW + 86400, nowSec: NOW });
  expect([stop.headroom, snap.headroom]).toEqual([0, 0.8]);
  keepReadings([stop, snap], { file });
  const at = (now) => cachedReadings(["codex", "cursor"], { file, mark, now, refresh: () => true }).rows.map((r) => [r.pool, r.headroom, r.class]);
  expect(at(NOW + 299)).toEqual([["codex", 0, "metered"], ["cursor", 0.8, "included"]]);
  expect(at(NOW + 301)).toEqual([["codex", null, "unknown"], ["cursor", 0.8, "included"]]);
  expect(at(NOW + 86401)).toEqual([["codex", null, "unknown"], ["cursor", null, "unknown"]]);
  // Nor before it was read: a clock set back, as the live snapshot reader refuses a reading from the future.
  expect(at(NOW - 60)).toEqual([["codex", null, "unknown"], ["cursor", null, "unknown"]]);
}));

test("a new machine, with no cache folder yet, starts its first refresh", () => withRefresh(() => {
  const d = join(scratch("cache-cold"), "not", "made"); let started = 0;
  const r = cachedReadings(["claude"], { file: join(d, "usage-readings.json"), mark: join(d, "usage-refresh.json"), now: NOW, refresh: () => ++started });
  expect([r.refreshing, started, existsSync(join(d, "usage-refresh.json"))]).toEqual([true, 1, true]);
}));

test("cachedUsage calls no harness: a kept 'not signed in' answer leaves one out, a missing reading is not_read_yet, kept billing settles the class", () => {
  const rows = cachedUsage(["claude", "codex", "agy"], {
    cache: () => ({ rows: [summarize({ pool: "claude", source: "claude /usage", ts: NOW, windows: [{ name: "five_hour", usedPct: 10 }], nowSec: NOW })], refreshing: false }),
    signIn: (n) => (n === "codex" ? { state: "no", billing: null } : null) }).rows;
  expect(rows.map((r) => [r.pool, r.signedIn ?? true, r.failure?.code ?? null])).toEqual([["claude", true, null], ["codex", false, null], ["agy", true, "not_read_yet"]]);
  // An API-key Claude, kept as signed in and metered, with no reading yet: metered, as a live read with no windows says.
  const [claude] = cachedUsage(["claude"], { cache: () => ({ rows: [], refreshing: false }), signIn: () => ({ state: "yes", billing: { billing: "metered", why: "an API key is billed per token" } }) }).rows;
  expect([claude.class, claude.billing?.billing]).toEqual(["metered", "metered"]);
});

test("readUsage keeps what its sources read, before billing settles it", async () => {
  let kept = null;
  const sources = { claude: { source: "claude /usage", read: async () => summarize({ pool: "claude", source: "claude /usage", ts: NOW, nowSec: NOW }) } };
  const rows = await readUsage(["claude"], {}, { sources, why: async () => null, billing: async () => ({ billing: { billing: "metered", why: "an API key" } }), keep: (r) => { kept = r; } });
  expect([rows[0].class, kept.map((r) => [r.pool, r.class, r.source])]).toEqual(["metered", [["claude", "unknown", "claude /usage"]]]);
});

// ---- the join ---------------------------------------------------------------------------------------------------------
const launch = (over) => ({ launch_id: randomUUID(), at: Date.parse("2026-11-04T10:00:00Z"), subscription: "codex", model: "m", effort: "high", id: "ab12cd34",
  advised: { level: "strong", sure: true, between: null, work_type: "review", high_risk: false, fallback: false, facts: {} }, project: "myco", backend: "terminal", name: "rev", ...over });
const run = (over) => ({ ts: "2026-11-04T11:00:00Z", run_id: randomUUID(), launch_id: null, project: "myco", id: "ab12cd34",
  advised: { level: "strong" }, chose: { subscription: "codex", model: "m", effort: "high", effort_from: "given", level: "strong" },
  outcome: { verdict: "done", check: "pass", seconds: null, attempts: 1, causes: null, note: "the recorder's own words" }, ...over });

test("a run joins its launch by launch_id; a legacy run only when one launch used its advice; the rest stand alone", () => {
  const a = launch(), b = launch({ id: "ffff0000" }), c = launch({ id: "ffff0000" });
  const byId = run({ launch_id: a.launch_id }), legacy = run({ id: "ffff0000" }), alone = run({ id: "99990000", ts: "2026-11-03T09:00:00Z" });
  const d = joinDecisions([a, b, c], [byId, legacy, alone]);
  const of = (x) => d.find((e) => e.launch_id === x.launch_id && e.run_id);
  expect(of(a)).toMatchObject({ run_id: byId.run_id, name: "rev", chose: byId.chose, outcome: { verdict: "done", check: "pass" } });
  // Two launches used ffff0000: the legacy run joins neither, and both stay unrecorded, with no level chosen yet.
  expect(d.filter((e) => e.launch_id === b.launch_id || e.launch_id === c.launch_id).map((e) => [e.run_id, e.chose.level, e.outcome])).toEqual([[null, null, null], [null, null, null]]);
  expect(d.filter((e) => !e.launch_id).map((e) => e.run_id).sort()).toEqual([legacy.run_id, alone.run_id].sort());
  expect(JSON.stringify(d)).not.toContain("the recorder's own words");
});

// ---- the command ------------------------------------------------------------------------------------------------------
function world() {
  const dir = scratch("board"), repo = join(dir, "myco"), ledger = join(dir, "ledger.jsonl");
  mkdirSync(join(repo, ".git"), { recursive: true });
  return { dir, repo, ledger, rows: [] };
}
const usageOk = () => ({ rows: [summarize({ pool: "claude", source: "claude /usage", ts: NOW, windows: [{ name: "five_hour", usedPct: 20 }], nowSec: NOW })], refreshing: false });
const config = cfg({ subscriptions: { claude: { reserve: 0, use: "normal", hardest_work: "strong" } } });

test("board scopes to the folder's repository, joins, counts by the ledger's rules before the display limit, and never prints a note", async () => {
  const w = world(), now = Date.parse("2026-11-04T12:00:00Z");
  const a = launch({ project: "myco" }), other = launch({ project: "elsewhere" });
  // A run and its revision count once; a run first recorded 8 days ago is outside the window.
  const first = run({ launch_id: a.launch_id, outcome: { verdict: "partial", check: "fail", attempts: 1, causes: ["execution"], note: "SECRET-NOTE" } });
  const revised = { ...first, ts: "2026-11-04T11:30:00Z", outcome: { verdict: "done", check: "pass", attempts: 2, causes: ["execution"], note: "SECRET-NOTE" } };
  const old = run({ ts: "2026-10-27T11:00:00Z", chose: { level: "basic" } });
  const many = Array.from({ length: DECISIONS_MAX + 5 }, (_, i) => run({ id: "11110000", ts: `2026-11-04T0${i % 9}:00:00Z`, outcome: { verdict: "done", check: "pass", attempts: 1, causes: [], note: null } }));
  writeFileSync(w.ledger, [first, revised, old, ...many, run({ project: "elsewhere" })].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const b = await boardCommand(["--cwd", join(w.repo)], config, { usage: usageOk, ledger: w.ledger, history: () => ({ records: [a, other] }), now });
  expect([b.ok, b.project, b.level, b.decisions.length]).toEqual([true, projectName(w.repo), "basic", DECISIONS_MAX]);
  expect(b.decisions.find((d) => d.launch_id === a.launch_id)).toMatchObject({ run_id: first.run_id, outcome: { verdict: "done", check: "pass", attempts: 2 } });
  expect(b.decisions.some((d) => d.launch_id === other.launch_id)).toBe(false);
  // 1 launch; runs first recorded in 7 days: the revised one and the 55; first time: the 55 (done, pass, 1, no causes).
  expect(b.outcomes).toEqual({ launches: 1, recorded: DECISIONS_MAX + 6, done_first_time: DECISIONS_MAX + 5, level_changed: 0, check_failed: 0 });
  expect(b.subscriptions.ranked.map((r) => r.subscription)).toEqual(["claude"]);
  expect(JSON.stringify(b)).not.toContain("SECRET-NOTE");
});

test("board fails open: an unreadable ledger or history is said, its numbers null, never zero; bad input is refused", async () => {
  const w = world(); mkdirSync(w.ledger); // a folder where the ledger file should be: unreadable
  const b = await boardCommand([], config, { usage: usageOk, ledger: w.ledger, history: () => ({ records: [], unreadable: true }) });
  expect([b.ok, b.unavailable.map((u) => u.part).sort(), b.outcomes]).toEqual([true, ["launch history", "ledger"], { launches: null, recorded: null, done_first_time: null, level_changed: null, check_failed: null }]);
  const broken = await boardCommand([], config, { usage: () => { throw new Error("x"); }, ledger: join(w.dir, "none.jsonl"), history: () => ({ records: [] }) });
  expect([broken.ok, broken.subscriptions, broken.unavailable[0].code, broken.unavailable[0].why]).toEqual([true, null, "internal_error", "routr could not rank its kept usage readings"]);
  expect(broken.next.filter((n) => /capacity/i.test(n.why))).toEqual([]); // board's contract: no recovery step when ranking fails
  for (const [args, why] of [[["--cwd"], "takes a folder"], [["--cwd", w.repo, "--cwd", w.repo], "more than once"], [["--level", "strong"], "unknown flag"], [["--cwd", join(w.dir, "gone")], "is not a folder"]]) {
    const r = await boardCommand(args, config, { usage: usageOk, ledger: w.ledger, history: () => ({ records: [] }) });
    expect([r.ok, r.error]).toEqual([false, expect.stringContaining(why)]);
  }
  // A line that is JSON but not a row (a hand edit) is skipped, as one that does not parse.
  const odd = join(w.dir, "odd.jsonl"); writeFileSync(odd, `null\n[1]\n7\n${JSON.stringify(run({}))}\n`);
  const read = await boardCommand([], config, { usage: usageOk, ledger: odd, history: () => ({ records: [] }) });
  expect([read.ok, read.decisions.length, read.unavailable]).toEqual([true, 1, []]);
  // On the command line, a global flag cannot take --cwd as its value and leave every project's board.
  for (const extra of [["--headroom", "--cwd"], ["--config", "--cwd"]]) {
    const cli = Bun.spawnSync([process.execPath, SCRIPT, "board", ...extra, w.repo], { env: cliEnv(scratch("board-cli")) });
    const out = JSON.parse(cli.stdout.toString());
    expect([out.ok, out.error]).toEqual([false, expect.stringContaining("--cwd cannot be a value")]);
  }
});

test("whether a legacy run joins does not depend on the folder asked about", async () => {
  const w = world();
  const here = launch({ id: "ffff0000", project: projectName(w.repo) }), there = launch({ id: "ffff0000", project: "elsewhere" });
  writeFileSync(w.ledger, JSON.stringify(run({ id: "ffff0000", project: projectName(w.repo) })) + "\n");
  for (const args of [[], ["--cwd", w.repo]]) {
    const b = await boardCommand(args, config, { usage: usageOk, ledger: w.ledger, history: () => ({ records: [here, there] }) });
    expect(b.decisions.filter((d) => d.run_id).map((d) => d.launch_id)).toEqual([null]);
  }
});
