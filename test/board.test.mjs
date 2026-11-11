// `routr board`: the room each account has from what routr keeps, served without a harness call, the join of launches
// to recorded runs, scope by a folder's project, counts by the ledger's rules, and what fails open.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileStore } from "../src/lib/usage-readings.mjs";
import { summarize } from "../src/lib/usage.mjs";
import { CACHE_DIR } from "../src/lib/state-files.mjs";
import { cliEnv, SCRIPT } from "./helpers.mjs";
import { boardCommand, DECISIONS_MAX, joinDecisions } from "../src/lib/board.mjs";
import { projectName } from "../src/lib/ledger.mjs";
import { cfg, scratch } from "./helpers.mjs";

const NOW = 1_800_000_000; // seconds

// Board's own wiring: what routr keeps (usage-readings.mjs, whose tests cover keeping, claiming and serving), as rows.
test("board ranks what routr keeps, with no harness called: a kept 'not signed in' answer leaves one out, a missing reading is not_read_yet", async () => {
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = scratch("board-home"); // its own sign-in answers, read by no other test
  try { await boardKept(); } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
async function boardKept() {
  const store = fileStore(), now = Date.now() / 1000;
  store.put("claude", { source: "claude /usage", takenAt: now - 60, windows: [{ name: "seven_day", usedPct: 40, windowMin: 10080, resetsAt: now + 86400 }] }, undefined);
  mkdirSync(CACHE_DIR(), { recursive: true });
  writeFileSync(join(CACHE_DIR(), "signed-in.json"), JSON.stringify({ codex: { ts: now, state: "no" } }));
  const config = cfg({ subscriptions: { claude: { reserve: 0, hardest_work: "strong" }, codex: { reserve: 0, hardest_work: "strong" }, agy: { reserve: 0, hardest_work: "strong" } } });
  const b = await boardCommand([], config, { ledger: join(scratch("board-kept"), "none.jsonl"), history: () => ({ records: [] }) });
  expect(b.subscriptions.ranked.map((r) => [r.subscription, r.usage, r.age_sec >= 60])).toEqual([["claude", "live", true], ["agy", "unknown", false]]);
  expect(b.subscriptions.excluded).toEqual([{ subscription: "codex", why: expect.stringContaining("not signed in") }]);
  expect(b.unavailable.map((u) => [u.subscription, u.code])).toEqual([["agy", "not_read_yet"]]);
}

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
