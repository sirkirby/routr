// Account policy and outcome identity: pure fixtures, never harnesses or models.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountUse, loadConfig } from "../src/lib/config.mjs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { append, assess, latestRuns, read, shareRows, toEntry } from "../src/lib/ledger.mjs";
import { recordCommand, usageCommand } from "../src/lib/commands.mjs";
import { telemetryRows } from "../src/lib/telemetry.mjs";
import { cfg, cliEnv, live, metered, none, row, scratch, SCRIPT } from "./helpers.mjs";

test("normal enterprise accounts compete on task fit, without invented capacity or weakened exclusions", async () => {
  const c = cfg();
  c.subscriptions.claude.use = c.subscriptions.codex.use = "normal";
  let r = rankSubscriptions("strong", [metered("claude"), metered("codex")], c);
  expect(r.candidates).toEqual({ normal: ["claude", "codex"], fallback: [] });
  expect(r.most_room).toBeNull();
  expect(r.ranked.every((x) => x.usable === null && x.headroom === null)).toBe(true);
  r = rankSubscriptions("strong", [live("claude", 0.8), metered("codex")], c);
  expect(r.candidates.normal).toEqual(["claude", "codex"]);
  expect(r.ranked.find((x) => x.subscription === "codex")).toMatchObject({ usable: null, use: "normal", age_sec: 1 });
  c.subscriptions.claude.use = "fallback";
  expect(rankSubscriptions("strong", [live("claude", 0.8), metered("codex")], c).candidates).toEqual({ normal: ["codex"], fallback: ["claude"] });
  // Normal use must not override a measured cap, including a user billing override.
  c.subscriptions.codex.billing = "metered";
  r = rankSubscriptions("strong", [live("claude", 0.1), { ...live("codex", 0.9), class: "capped", windows: [{ name: "cap", usedPct: 100 }] }], c);
  expect(r.candidates).toEqual({ normal: [], fallback: [] });
  expect(r.ranked.find((x) => x.subscription === "codex")).toMatchObject({ class: "capped", usable: 0 });
  for (const reason of ["disabled", "signedout", "level"]) {
    const one = cfg({ subscriptions: { codex: { ...c.subscriptions.codex } } });
    const usage = metered("codex");
    if (reason === "disabled") one.subscriptions.codex.enabled = false;
    if (reason === "signedout") { usage.signedIn = false; usage.note = "sign in first"; }
    if (reason === "level") one.subscriptions.codex.hardest_work = "basic";
    r = rankSubscriptions("strong", [usage], one);
    expect(r.candidates).toEqual({ normal: [], fallback: [] });
    expect(r.excluded).toHaveLength(1);
  }
  const u = await usageCommand([], c, {}, { read: async () => [metered("claude"), metered("codex"), none("cursor")] });
  expect(u.candidates.normal).toEqual(["codex", "cursor"]);
  expect(u.ranked.find((x) => x.subscription === "cursor").usage).toBe("assumed");
});

test("account use validates without rewriting config, and overrides legacy policy independently of billing", () => {
  const path = join(scratch("use-config"), "config.json");
  const raw = JSON.stringify({ subscriptions: {
    claude: { hardest_work: "strong", reserve: 0, billing: "metered", metered_rank: "after", use: "normal" },
    codex: { hardest_work: "strong", reserve: 0, metered_rank: "with", use: "bad" },
  } });
  writeFileSync(path, raw);
  const { config, notes } = loadConfig(path);
  expect(readFileSync(path, "utf8")).toBe(raw);
  expect(notes).toHaveLength(1); expect(notes[0]).toContain(".use:");
  expect(accountUse(config.subscriptions.claude, "metered")).toBe("normal");
  expect(accountUse(config.subscriptions.codex, "metered")).toBe("normal");
  expect(accountUse({}, "metered")).toBe("fallback");
  expect(accountUse({}, "unknown")).toBe("normal");
  expect(accountUse({ use: "fallback", metered_rank: "with" }, "included")).toBe("fallback");
});

const advice = { id: "same-advice", brief_sha: "abc", level: "standard", mode: "dispatch", facts: {} };
const choice = { subscription: "codex", model: "worker-model", effort: "medium", project: "fixture" };
test("separate workers share advice, but only explicit matching run revisions replace an outcome", () => {
  const dir = scratch("runs"), ledger = join(dir, "ledger.jsonl"), adviceFile = join(dir, "advice.json");
  writeFileSync(adviceFile, JSON.stringify(advice));
  const first = recordCommand({ ...choice, advice: adviceFile, ledger, verdict: "partial", check: "fail", attempts: "1", causes: ["execution"] });
  const second = recordCommand({ ...choice, advice: adviceFile, ledger, verdict: "done", check: "pass", attempts: "1", causes: ["none"] });
  expect(first.run_id).not.toBe(second.run_id);
  const revised = recordCommand({ ...choice, advice: adviceFile, ledger, run_id: first.run_id, verdict: "done", check: "pass", attempts: "2", causes: ["execution", "brief"] });
  expect(revised.run_id).toBe(first.run_id);
  expect(read(ledger)).toHaveLength(3);
  const latest = latestRuns(read(ledger));
  expect(latest).toHaveLength(2); expect(latest[0].outcome).toMatchObject({ attempts: 2, check: "pass" });
  expect(assess(read(ledger))).toContain("2 recorded runs (3 rows) · 2 verified accepted · 1 accepted first pass · 1 execution corrections");
  for (const different of [{ model: "different" }, { effort: "high" }, { project: "different" }, { level: "strong" }, { subscription: "claude" }]) {
    expect(recordCommand({ ...choice, ...different, advice: adviceFile, ledger, run_id: first.run_id }).recorded).toBeNull();
  }
  const unknown = toEntry(advice, choice);
  expect(() => append(unknown, ledger, { revision: true })).toThrow("not found");
  expect(read(ledger)).toHaveLength(3);
  expect(latestRuns([row(), row()])).toHaveLength(2); // legacy advice ids are not worker identities
});

test("unknown attempts, successful reviews and launch trouble cannot masquerade as execution quality", () => {
  const outcomes = [
    { verdict: "done", check: "pass", attempts: 1, causes: ["none"] },
    { verdict: "done", check: "pass", attempts: 2, causes: ["review"] },
    { verdict: "blocked", check: "none", attempts: 2, causes: ["launch"] },
    { verdict: "done", check: "pass", attempts: 1, causes: ["execution"] }, // lead repaired before acceptance
    { verdict: "done", check: "none", attempts: 1, causes: ["none"] },
    { verdict: "done", check: "pass" },
  ].map((o) => toEntry(advice, { ...choice, ...o }));
  const report = assess(outcomes);
  expect(report).toContain("4 verified accepted · 1 accepted first pass · 1 execution corrections · 2 not verified accepted");
  expect(report).toContain("2 runs with multiple attempts; 1 unknown");
  expect(report).toContain("execution 1, brief 0, scope 0, review 1, launch 1, unknown 1");
  expect(outcomes.at(-1).outcome).toMatchObject({ attempts: null, causes: null });
  for (const bad of [0, -1, 1.5, "", "2x", Infinity]) expect(() => toEntry(advice, { attempts: bad })).toThrow("--attempts");
  for (const bad of [-1, "", "forever", Infinity]) expect(() => toEntry(advice, { seconds: bad })).toThrow("--seconds");
  for (const bad of [["none", "execution"], ["model bad"], "execution"]) expect(() => toEntry(advice, { causes: bad })).toThrow("--cause");
  expect(toEntry(advice, { seconds: 0 }).outcome.seconds).toBe(0);
  expect(() => toEntry(advice, { run_id: "not-an-id" })).toThrow("--run-id");
});

test("new local outcome fields do not change the telemetry or share projection", () => {
  const old = row(), local = { ...old, run_id: "814bf16e-5f1d-4ed7-a02e-f838bf927b13", outcome: { ...old.outcome, causes: ["execution", "brief"] } };
  expect(telemetryRows([local], "fixture-install")).toEqual(telemetryRows([old], "fixture-install"));
  expect(shareRows([local])).toEqual(shareRows([old]));
  const unknown = toEntry(advice, choice);
  expect(unknown.outcome.attempts).toBeNull();
  expect(telemetryRows([unknown], "fixture-install")[0].outcome.attempts).toBe(1); // legacy wire behavior, documented
});

test("record CLI accepts repeatable causes and returns an identity usable for outcome revisions", () => {
  const home = scratch("record-run-cli"), path = join(home, "advice.json");
  writeFileSync(path, JSON.stringify(advice));
  const env = cliEnv(home);
  const args = [process.execPath, SCRIPT, "record", "--advice", path, "--subscription", "codex", "--model", "worker-model", "--effort", "medium", "--verdict", "done", "--check", "pass", "--attempts", "2", "--cause", "execution", "--cause", "scope"];
  const invoke = (extra = []) => { const r = Bun.spawnSync([...args, ...extra], { env }); expect(r.exitCode).toBe(0); return JSON.parse(r.stdout.toString()); };
  const first = invoke(); expect(first.recorded).toBe(advice.id);
  const second = invoke(["--run-id", first.run_id]); expect(second.run_id).toBe(first.run_id);
  const rows = read(first.ledger);
  expect(rows).toHaveLength(2); expect(rows[1].outcome.causes).toEqual(["execution", "scope"]);
  expect(latestRuns(rows)).toHaveLength(1);
  expect(invoke(["--run-id"]).recorded).toBeNull();
  expect(read(first.ledger)).toHaveLength(2);
});
