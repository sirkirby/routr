// `routr board` and the usage cache under it: readings kept by live reads and served aged without a harness call, the
// join of launches to recorded runs, scope by a folder's project, counts by the ledger's rules, and what fails open.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { cachedReadings, keepReadings, STALE_SEC } from "../src/lib/usage-cache.mjs";
import { cachedUsage, readUsage } from "../src/lib/harnesses.mjs";
import { summarize, failedUsage } from "../src/lib/usage.mjs";
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
  // A later failed read keeps the last good one.
  keepReadings([failedUsage("claude", "claude /usage")], { file });
  expect(JSON.parse(readFileSync(file, "utf8")).readings.claude.ts).toBe(NOW - 60);
}));

test("a cached read serves kept readings aged to now, a window reset since rolled, and starts at most one detached read when they are stale", () => withRefresh(() => {
  const file = join(scratch("cache-read"), "usage-readings.json");
  keepReadings([summarize({ pool: "claude", source: "claude /usage", ts: NOW - 60, windows: [{ name: "five_hour", usedPct: 90, windowMin: 300, resetsAt: NOW + 600 }], nowSec: NOW })], { file });
  let started = 0; const refresh = () => ++started;
  // Fresh, nothing missing: no refresh.
  const fresh = cachedReadings(["claude"], { file, now: NOW, refresh });
  expect([fresh.rows[0].ageSec, fresh.rows[0].headroom, fresh.missing, started]).toEqual([60, expect.closeTo(0.1, 5), [], 0]);
  // An hour later the window has reset: room is back, the age says how old the reading is, and one refresh starts.
  const later = cachedReadings(["claude", "codex"], { file, now: NOW + 3600, refresh });
  expect([later.rows[0].ageSec, later.rows[0].headroom, later.missing, later.refreshing, started]).toEqual([3660, 1, ["codex"], true, 1]);
  // Within STALE_SEC of that try, no second one.
  cachedReadings(["claude", "codex"], { file, now: NOW + 3600 + STALE_SEC - 1, refresh });
  expect(started).toBe(1);
}));

test("cachedUsage calls no harness: a kept 'not signed in' answer leaves one out, a missing reading is not_read_yet", () => {
  const rows = cachedUsage(["claude", "codex", "agy"], {
    cache: () => ({ rows: [summarize({ pool: "claude", source: "claude /usage", ts: NOW, windows: [{ name: "five_hour", usedPct: 10 }], nowSec: NOW })], refreshing: false }),
    signIn: (n) => (n === "codex" ? "no" : null) }).rows;
  expect(rows.map((r) => [r.pool, r.signedIn ?? true, r.failure?.code ?? null])).toEqual([["claude", true, null], ["codex", false, null], ["agy", true, "not_read_yet"]]);
});

test("readUsage keeps what it read for the cached path", async () => {
  let kept = null;
  const sources = { claude: { source: "claude /usage", read: async () => summarize({ pool: "claude", source: "claude /usage", ts: NOW, windows: [{ name: "five_hour", usedPct: 5 }], nowSec: NOW }) } };
  await readUsage(["claude"], {}, { sources, why: async () => null, billing: async () => ({}), keep: (rows) => { kept = rows; } });
  expect(kept.map((r) => r.pool)).toEqual(["claude"]);
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
  expect([broken.ok, broken.subscriptions, broken.unavailable[0].code]).toEqual([true, null, "internal_error"]);
  for (const [args, why] of [[["--cwd"], "takes a folder"], [["--cwd", w.repo, "--cwd", w.repo], "more than once"], [["--level", "strong"], "unknown flag"], [["--cwd", join(w.dir, "gone")], "is not a folder"]]) {
    const r = await boardCommand(args, config, { usage: usageOk, ledger: w.ledger, history: () => ({ records: [] }) });
    expect([r.ok, r.error]).toEqual([false, expect.stringContaining(why)]);
  }
});
