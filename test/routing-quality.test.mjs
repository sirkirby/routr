// Account policy and outcome identity: pure fixtures, never harnesses or models.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountUse, loadConfig } from "../src/lib/config.mjs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { append, assess, latestRuns, levelReview, read, shareRows, toEntry } from "../src/lib/ledger.mjs";
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

test("usage filters both level overrides through account policy while preserving the plain view", async () => {
  const c = cfg();
  c.subscriptions.claude.hardest_work = "basic";
  c.subscriptions.codex.use = "normal";
  c.subscriptions.cursor.use = "fallback";
  const readings = [live("claude", 0.9), metered("codex"), live("cursor", 0.6)];
  const read = async () => readings;
  const original = structuredClone(c);
  const plain = await usageCommand([], c, {}, { read });
  expect(plain).not.toHaveProperty("level");
  expect(plain.candidates).toEqual({ normal: ["claude", "codex"], fallback: ["cursor"] });
  const basic = await usageCommand(["--level", "basic"], c, {}, { read });
  expect(basic).toEqual({ ...plain, level: "basic" });
  const standard = await usageCommand(["--json", "--level", "standard"], c, {}, { read });
  expect(standard).toMatchObject({ ok: true, level: "standard", candidates: { normal: ["codex"], fallback: ["cursor"] } });
  expect(standard.excluded).toEqual([{ subscription: "claude", reason: "the user does not give it standard work" }]);
  expect(standard.ranked.find((x) => x.subscription === "codex")).toMatchObject({ usable: null, headroom: null, age_sec: 1 });
  const strong = await usageCommand(["--level", "strong"], c, {}, { read });
  expect(strong.candidates).toEqual({ normal: ["codex"], fallback: [] });
  // Downgrading restores standard accounts; neither direction rewrites preferences.
  expect(await usageCommand(["--level", "standard"], c, {}, { read })).toEqual(standard);
  expect(c).toEqual(original);

  for (const boundary of ["reserve", "disabled", "signedout"]) {
    const limited = cfg({ subscriptions: { codex: { ...c.subscriptions.codex } } });
    const u = live("codex", boundary === "reserve" ? 0.1 : 0.9);
    if (boundary === "disabled") limited.subscriptions.codex.enabled = false;
    if (boundary === "signedout") { u.signedIn = false; u.note = "sign in first"; }
    let names;
    const result = await usageCommand(["--level", "standard"], limited, {}, { read: async (n) => { names = n; return [u]; } });
    expect(result.candidates).toEqual({ normal: [], fallback: [] });
    expect(names).toEqual(boundary === "disabled" ? [] : ["codex"]);
  }
  const failed = await usageCommand(["--level", "strong"], c, {}, { read: async () => { throw new Error("unavailable"); } });
  expect(failed).toEqual({ ok: false, error: "unavailable" });
});

test("usage rejects invalid level combinations before any usage read or named refresh", async () => {
  let calls = 0;
  const called = async () => { calls++; return []; };
  const deps = { read: called, sources: { cursor: { check: called }, kiro: { check: called } } };
  for (const words of [
    ["--level"], ["--level", ""], ["--level", "standard "], ["--level", "STRONG"],
    ["--level", "unknown"], ["--level", "--json"], ["--level=strong"],
    ["--level", "basic", "--level", "strong"], ["--level", "strong", "--level"],
    ["cursor", "--level", "basic"], ["--level", "strong", "kiro"], ["claude", "--level", "standard"],
    ["--background", "--level", "strong"], ["cursor", "--background", "--level", "basic"],
  ]) {
    const result = await usageCommand(words, cfg(), {}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage:");
  }
  expect(calls).toBe(0);
});

test("usage level CLI fails open and keeps headroom overrides and default behavior", () => {
  const home = scratch("usage-level-cli"), config = join(home, "config.json");
  writeFileSync(config, JSON.stringify(cfg()));
  const invokeArgs = (...args) => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: cliEnv(home, { PATH: home }) });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
    return JSON.parse(r.stdout.toString());
  };
  const invokeRaw = (...args) => invokeArgs("usage", ...args);
  const invoke = (...args) => invokeRaw("--config", config, ...args);
  expect(invoke()).not.toHaveProperty("level");
  const r = invoke("--level", "strong", "--headroom", "codex=90%", "--json");
  expect(r).toMatchObject({ ok: true, level: "strong" });
  expect(r.ranked.some((x) => x.subscription === "cursor")).toBe(false);
  // With no harness on PATH, a supplied reading cannot bypass the sign-in gate.
  expect(r.candidates).toEqual({ normal: [], fallback: [] });
  for (const words of [["--level"], ["--level", "nope"], ["--level", "basic", "--level", "strong"], ["cursor", "--level", "standard"], ["--level", "strong", "--background"]])
    expect(invoke(...words).ok).toBe(false);
  // Global option parsing must not swallow --level before usage validates it. Otherwise these reach Cursor/Kiro's
  // named refresh or hide a duplicate. Assert the validation error, not merely a harness failing to start.
  for (const words of [
    ["cursor", "--headroom", "--level"], ["kiro", "--config", "--level"],
    ["--headroom", "--level", "--level", "strong"], ["--config", "--level", "--level", "strong"],
    ["cursor", "--headroom", "--level", "standard"], ["kiro", "--config", "--level", "standard"],
  ]) {
    const invalid = invokeRaw(...words);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toStartWith("usage: --level");
  }
  for (const words of [
    ["--config", "--level", "usage", "cursor"], ["--headroom", "--level", "usage", "kiro"],
    ["--headroom", "codex=90%", "usage", "cursor", "--config", "--level"],
    ["--config", config, "--headroom", "--level", "usage", "--level", "strong"],
  ]) {
    const invalid = invokeArgs(...words);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toStartWith("usage: --level");
  }
  expect(invokeArgs("--config", config, "--headroom", "codex=90%", "usage", "--level", "strong")).toMatchObject({ ok: true, level: "strong" });
});

const advice = { id: "same-advice", brief_sha: "abc", level: "standard", mode: "dispatch", facts: {} };
const choice = { subscription: "codex", model: "worker-model", effort: "medium", project: "fixture" };
test("record keeps work-level overrides independent of model changes and original advice", () => {
  const dir = scratch("chosen-level"), path = join(dir, "advice.json"), ledger = join(dir, "ledger.jsonl");
  writeFileSync(path, JSON.stringify(advice));
  const saved = readFileSync(path, "utf8");
  for (const level of ["basic", "standard", "strong"]) {
    const result = recordCommand({ ...choice, advice: path, ledger, model: "larger-worker-model", level, verdict: "done", check: "pass" });
    expect(result.recorded).toBe(advice.id);
  }
  expect(readFileSync(path, "utf8")).toBe(saved);
  expect(read(ledger).map((e) => [e.advised.level, e.chose.level])).toEqual([
    ["standard", "basic"], ["standard", "standard"], ["standard", "strong"],
  ]);
});
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

test("outcome revisions preserve omitted choice evidence and permit explicit replacements", () => {
  const dir = scratch("revision-evidence"), ledger = join(dir, "ledger.jsonl"), adviceFile = join(dir, "advice.json"), report = join(dir, "report.txt");
  writeFileSync(adviceFile, JSON.stringify(advice));
  const args = { ...choice, advice: adviceFile, ledger, verdict: "done", check: "pass", attempts: "1", causes: ["none"] };
  const first = recordCommand({ ...args, note: "Model fits the task; funded normal account" }, ["count files → basic → small-model"]);
  const revised = recordCommand({ ...args, run_id: first.run_id, attempts: "2", causes: ["execution"] });
  expect(revised.run_id).toBe(first.run_id);
  let latest = latestRuns(read(ledger))[0];
  expect(latest.subagents).toEqual([{ subtask: "count files", advised: "basic", model: "small-model" }]);
  expect(latest.outcome.note).toBe("Model fits the task; funded normal account");
  expect(assess(read(ledger))).toContain("subagents: 1 recorded");
  writeFileSync(report, "SUBAGENTS: none\n");
  expect(recordCommand({ ...args, run_id: first.run_id, report, note: "" }).run_id).toBe(first.run_id);
  latest = latestRuns(read(ledger))[0];
  expect(latest.subagents).toEqual([]); expect(latest.outcome.note).toBe("");
  expect(recordCommand({ ...args, run_id: first.run_id, note: "Updated evidence" }, ["inspect → standard → another-model"]).run_id).toBe(first.run_id);
  latest = latestRuns(read(ledger))[0];
  expect(latest.subagents[0].model).toBe("another-model"); expect(latest.outcome.note).toBe("Updated evidence");
});

test("calibration treats unchecked outcomes as unknown and counts explicit run revisions once", () => {
  const make = (outcome) => row({ outcome });
  const unknown = Array.from({ length: 5 }, () => make({ verdict: "done", check: "none" }));
  expect(levelReview(unknown)).toEqual([]);
  expect(levelReview(unknown.map((e) => ({ ...e, outcome: { verdict: "done" } })))).toEqual([]);
  const failures = ["partial", "blocked"].map((verdict) => make({ verdict, check: "none" }));
  expect(levelReview([...unknown, ...failures])).toEqual([]); // two evaluated runs are below MIN
  const accepted = Array.from({ length: 3 }, () => make({ verdict: "done", check: "pass" }));
  const mixed = [...unknown, ...failures, ...accepted];
  expect(levelReview(mixed)[0]).toContain("2/5");
  const lower = [...accepted, accepted[0], accepted[1], ...unknown].map((e) => ({ ...e, chose: { ...e.chose, level: "basic" } }));
  expect(levelReview(lower)[0]).toContain("went lower 5 times and 5 delivered");
  const failed = toEntry(advice, { ...choice, verdict: "done", check: "fail" });
  expect(levelReview(Array.from({ length: 5 }, () => failed))).toEqual([]);
  expect(levelReview([...unknown, ...Array.from({ length: 5 }, () => make({ verdict: "done", check: "fail" }))])[0]).toContain("5/5");
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
