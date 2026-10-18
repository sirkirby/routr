import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adviseCommand, checkCommand } from "../src/lib/commands.mjs";
import { launch } from "../src/lib/launch.mjs";
import { DECISION_FAILURES, DecisionError, decisionTarget, PROVIDERS } from "../src/lib/providers.mjs";
import { readUsage } from "../src/lib/harnesses.mjs";
import { readAgy, readClaude, readCodexLive, summarize } from "../src/lib/usage.mjs";
import { parseKiroUsage, refreshKiro, readKiro, kiroUsage } from "../src/lib/kiro-usage.mjs";
import { readCursor, refreshCursor } from "../src/lib/cursor-usage.mjs";
import { usageFailure } from "../src/lib/usage-failure.mjs";
import { briefSha, toEntry } from "../src/lib/ledger.mjs";
import { telemetryRows } from "../src/lib/telemetry.mjs";
import { BRIEF_MARKER, KEY_MARKER } from "./fixtures/provider-fetch.mjs";
import { ans, cfg, cliEnv, fact, herdrOK, scratch, SCRIPT } from "./helpers.mjs";

const marker = `${BRIEF_MARKER} ${KEY_MARKER}`;
const clean = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(BRIEF_MARKER); expect(text).not.toContain(KEY_MARKER);
};
const reading = async () => ({ answers: fact(ans(1, 1), {}), provider: "typesafe", model: "jev-1.13.0", latencyMs: 1 });
const empty = async () => [];

test("every classified decision failure has one output contract, independent of the asking command", async () => {
  const dir = scratch("unavailable"), brief = join(dir, "brief"), report = join(dir, "report");
  writeFileSync(brief, BRIEF_MARKER); writeFileSync(report, marker);
  for (const provider of Object.keys(PROVIDERS)) for (const code of Object.keys(DECISION_FAILURES)) {
    const config = cfg({ decision: { provider } }), target = decisionTarget(config, {});
    const askFn = async () => { throw new DecisionError(target, code); };
    const missing = { part: "decision model", provider, model: target.model, code, why: DECISION_FAILURES[code] };
    for (const mode of ["dispatch", "subagent", "check"]) {
      const r = mode === "check" ? await checkCommand({ brief, report }, { config, askFn })
        : await adviseCommand(mode, marker, { config }, {}, { askFn, read: empty });
      expect(r.unavailable).toEqual([missing]); expect(r.decision_model).toBeUndefined();
      expect(r.headline).toStartWith(`routr: no reading (${target.model} on ${PROVIDERS[provider].label} unavailable: ${code})`);
      clean(r);
    }
  }
});

test("aggregate usage rejection and synchronous throws name every unread enabled source without exception text", async () => {
  for (const read of [async () => { throw new Error(marker); }, () => { throw new Error(marker); }]) {
    const r = await adviseCommand("dispatch", marker, { config: cfg() }, {}, { askFn: reading, read });
    expect(r.fallback).toBeUndefined(); expect(r.headline).not.toContain("no reading");
    expect(r.unavailable).toEqual(["claude", "codex", "cursor"].map((subscription) => ({ part: "usage", subscription,
      source: { claude: "claude /usage", codex: "app-server", cursor: "cursor /usage" }[subscription], ...usageFailure("read_failed") })));
    expect(r.subscriptions.ranked).toHaveLength(3); clean(r);
  }
  const malformed = await adviseCommand("dispatch", marker, { config: cfg() }, {}, { askFn: reading, read: async () => null });
  expect(malformed.unavailable).toHaveLength(3); expect(malformed.subscriptions.ranked).toEqual([]); clean(malformed);
});

test("check lists both unreadable files and does not ask for a decision", async () => {
  const dir = scratch("unreadable-check");
  const r = await checkCommand({ brief: join(dir, "brief"), report: join(dir, "report") }, { askFn: () => { throw new Error("must not ask"); } });
  expect(r.unavailable.map((u) => [u.part, u.code])).toEqual([["brief", "unreadable"], ["report", "unreadable"]]);
  expect(r.headline).toBe("routr: no reading (brief unavailable: unreadable; report unavailable: unreadable); judge it yourself");
  expect(r.next).toBeUndefined(); clean(r);
});

test("a subscription excluded by the user's work-level setting is not reported as a failed reading", async () => {
  const config = cfg({ subscriptions: { codex: { ...cfg().subscriptions.codex, hardest_work: "basic" } } });
  const read = (names) => readUsage(names, {}, { why: () => null, billing: () => null,
    sources: { codex: { read: () => { throw new Error(marker); } } } });
  const r = await adviseCommand("dispatch", marker, { config }, {}, { askFn: reading, read });
  expect(r.unavailable).toEqual([]); expect(r.subscriptions.excluded).toEqual([{ subscription: "codex", reason: "the user does not give it standard work" }]); clean(r);
});

test("one source's failed read is isolated, structured at the reader, and never includes its output", async () => {
  const read = (names, given) => readUsage(names, given, { why: () => null, billing: () => null, sources: {
    codex: { source: "app-server", read: () => { throw new Error(marker); } },
    cursor: { read: () => summarize({ pool: "cursor", source: "cursor /usage", windows: [{ usedPct: 10 }] }) },
  } });
  const config = cfg({ subscriptions: { codex: cfg().subscriptions.codex, cursor: cfg().subscriptions.cursor } });
  const r = await adviseCommand("dispatch", marker, { config }, {}, { askFn: reading, read });
  expect(r.unavailable).toEqual([{ part: "usage", subscription: "codex", source: "app-server", ...usageFailure("read_failed") }]);
  expect(r.subscriptions.ranked.find((r) => r.subscription === "cursor").usage).toBe("live"); clean(r);
});

test("CLI distinguishes failed reads, stale snapshots with age, valid metered unknown capacity, and exclusions", () => {
  const home = scratch("unavailable-cli"), dir = join(home, ".config/routr"), cache = join(home, ".cache/routr");
  mkdirSync(dir, { recursive: true }); mkdirSync(cache, { recursive: true });
  const snapshot = join(cache, "cursor-usage.json"), ts = Date.now() / 1000 - 90000;
  const subscriptions = Object.fromEntries(["codex", "cursor", "kiro", "agy"].map((n) => [n, { hardest_work: "strong", enabled: n !== "agy" }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ subscriptions, auto_update: false }));
  const run = (scenario, signedIn = true) => {
    writeFileSync(join(cache, "signed-in.json"), JSON.stringify(Object.fromEntries(["codex", "cursor", "kiro"].map((n) => [n, { state: n === "codex" && !signedIn ? "no" : "yes", ts: Date.now() / 1000 }]))));
    const p = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "fixtures/provider-fetch.mjs"), "--preload", join(import.meta.dir, "fixtures/usage-sources.mjs"), SCRIPT, "dispatch", marker], {
      env: cliEnv(home, { PATH: home, TYPESAFE_API_KEY: KEY_MARKER, ROUTR_TEST_PROVIDER: "typesafe", ROUTR_TEST_REPLY: "valid", ROUTR_TEST_USAGE: scenario, ROUTR_TEST_SNAPSHOT: snapshot }), stdin: "ignore",
    });
    expect(p.exitCode).toBe(0); expect(p.stderr.toString()).toBe(""); clean(p.stdout.toString()); return JSON.parse(p.stdout.toString());
  };
  writeFileSync(snapshot, JSON.stringify({ ts, tried: ts, reading: { included_used_pct: 40 } }));
  const r = run("four_cases");
  expect(r.unavailable).toEqual([{ part: "usage", subscription: "codex", source: "app-server", ...usageFailure("read_failed") }]);
  expect(r.subscriptions.ranked.find((r) => r.subscription === "cursor")).toMatchObject({ usage: "assumed" });
  expect(r.subscriptions.ranked.find((r) => r.subscription === "cursor").age_sec).toBeGreaterThanOrEqual(90000);
  expect(r.subscriptions.ranked.find((r) => r.subscription === "kiro")).toMatchObject({ class: "metered", usable: null, headroom: null, usage: "metered" });
  expect(r.subscriptions.excluded).toContainEqual({ subscription: "agy", reason: expect.stringContaining("off") });
  const signedOut = run("four_cases", false);
  expect(signedOut.unavailable).toEqual([]);
  expect(signedOut.subscriptions.excluded).toContainEqual({ subscription: "codex", reason: expect.stringContaining("not signed in") });
  const failed = run("snapshot_failure", false);
  expect(failed.unavailable).toEqual([{ part: "usage", subscription: "cursor", source: "cursor /usage", ...usageFailure("invalid_response") }]);
  const saved = readFileSync(snapshot, "utf8"); clean(saved);
  expect(JSON.parse(saved).failure).toEqual(usageFailure("invalid_response")); expect(JSON.parse(saved)).not.toHaveProperty("error");
});

test("snapshot writer and reader share codes, redact raw failures, and forget a failure after success", async () => {
  for (const [refresh, read, good] of [
    [refreshCursor, readCursor, { included_used_pct: 20 }],
    [refreshKiro, readKiro, { credits_used: 10, credits_limit: 50, used_pct: 20 }],
  ]) {
    const file = join(scratch("snapshot-failures"), "snapshot.json"), nowSec = 1800000000;
    for (const code of ["no_response", "invalid_response", "private_folder", "source_missing", "read_failed", marker]) {
      const r = await refresh({ file, nowSec, read: async () => ({ ok: false, code, why: marker, error: marker }) });
      expect(r).toEqual({ ok: false, ...usageFailure(code) }); clean(r);
      const saved = readFileSync(file, "utf8"); clean(saved); expect(JSON.parse(saved).failure).toEqual(usageFailure(code));
      expect(read({ file, nowSec: nowSec + 1, background: false }).failure).toEqual(usageFailure(code));
    }
    await refresh({ file, nowSec, read: async () => { throw new Error(marker); } });
    clean(readFileSync(file, "utf8"));
    await refresh({ file, nowSec, read: async () => ({ ok: true, ...good }) });
    expect(read({ file, nowSec: nowSec + 1 }).failure).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("failure");
    // Old raw errors and unclassified notes cannot be replayed or copied by the next refresh.
    writeFileSync(file, JSON.stringify({ ts: nowSec, tried: nowSec, reading: { ...good, plan: marker, other: marker }, error: marker }));
    clean(read({ file, nowSec: nowSec + 1 }));
    await refresh({ file, nowSec: nowSec + 2, read: async () => ({ ok: false, error: marker }) });
    clean(readFileSync(file, "utf8"));
  }
});

test("snapshot file failures have codes too; a missing first snapshot is not a failed source", () => {
  const dir = scratch("snapshot-files"), missing = join(dir, "missing"), invalid = join(dir, "invalid"), malformed = join(dir, "malformed");
  writeFileSync(invalid, `{ ${marker}`);
  for (const read of [readCursor, readKiro]) {
    expect(read({ file: missing }).failure).toBeUndefined();
    const broken = read({ file: invalid }); expect(broken.failure).toEqual(usageFailure("invalid_response")); clean(broken);
    const unreadable = read({ file: dir }); expect(unreadable.failure).toEqual(usageFailure("read_failed")); clean(unreadable);
    writeFileSync(malformed, JSON.stringify({ ts: marker, reading: { included_used_pct: 10, used_pct: 10 } }));
    const badTime = read({ file: malformed }); expect(badTime.failure).toEqual(usageFailure("invalid_response")); expect(badTime.headroom).toBeNull(); clean(badTime);
    writeFileSync(malformed, JSON.stringify({ ts: Date.now() / 1000, reading: { included_used_pct: marker, used_pct: marker } }));
    const badNumbers = read({ file: malformed }); expect(badNumbers.failure).toEqual(usageFailure("invalid_response")); clean(badNumbers);
  }
});

test("live usage readers classify failed reads and never reflect harness output", async () => {
  const exec = async () => marker;
  const rows = [await readClaude({ file: join(scratch("usage-live"), "none"), exec }),
    await readCodexLive({ exec, fallback: () => summarize({ pool: "codex", source: "session log" }) }), await readAgy({ exec })];
  for (const r of rows) { expect(r.failure).toEqual(usageFailure("invalid_response")); clean(r); }
  expect(await kiroUsage({ exec })).toMatchObject({ ok: false, ...usageFailure("invalid_response") });
  expect(await kiroUsage({ exec: async () => { throw new Error(marker); } })).toMatchObject({ ok: false, ...usageFailure("read_failed") });
  clean(parseKiroUsage(`Estimated Usage | resets on 2026-10-01 | ${marker}\nCredits (1 of 50 covered in plan)\n${marker}`));
});

test("matching fallback launch preserves dispatch's attempted model through settings changes and keeps diagnostics out of storage", async () => {
  const dir = scratch("saved-fallback"), adviceFile = join(dir, "advice.json");
  const config = cfg({ decision: { provider: "typesafe", model: "jev-1.13.0" } });
  const target = decisionTarget(config, {});
  const advice = await adviseCommand("dispatch", marker, { config }, {}, { askFn: async () => { throw new DecisionError(target, "timeout"); }, read: empty });
  writeFileSync(adviceFile, JSON.stringify(advice));
  const changed = cfg({ decision: { provider: "cloudflare", model: "clef-flash" } });
  let prompted = false;
  const deps = { env: { HERDR_ENV: "1" }, settings: () => changed, ready: async () => null, run: async (args) => {
    if (args[1] === "get") return herdrOK({ agent: { agent: "claude", cwd: process.cwd(), agent_status: prompted ? "working" : "idle", interactive_ready: true } });
    if (args[1] === "prompt") { prompted = true; return herdrOK(); }
    if (args[1] === "rename") return herdrOK();
    throw new Error("unexpected herdr call");
  } };
  const args = ["--kind", "claude", "--name", "worker", "--model", "sonnet", "--task", marker, "--advice", adviceFile, "--pane", "w1:p9"];
  const real = await launch(args, deps);
  expect(real).toMatchObject({ ok: true, state: "prompted" }); expect(prompted).toBe(true);
  expect(real.unavailable).toEqual(advice.unavailable); expect(real.warnings.join(" ")).toContain("Fallback advice: jev-1.13.0"); clean(real);
  const dry = await launch([...args, "--dry-run"], deps);
  expect(dry).toMatchObject({ ok: true, state: "planned", unavailable: advice.unavailable }); clean(dry);
  const entry = toEntry(advice, {}); expect(entry.decision_model).toBeNull(); expect(entry).not.toHaveProperty("unavailable");
  const sent = telemetryRows([entry], "test-install"); expect(sent[0]).not.toHaveProperty("unavailable"); clean(sent);
  writeFileSync(adviceFile, JSON.stringify({ fallback: true, brief_sha: briefSha(marker) }));
  const old = await launch([...args, "--dry-run"], deps);
  expect(old.ok).toBe(true); expect(old.unavailable).toEqual([{ part: "decision model", provider: null, model: null, code: "attempt_unknown", why: "The saved fallback advice does not name the attempted decision model and its failure." }]);
  expect(old.warnings.join(" ")).toContain("does not name the attempted decision model"); expect(JSON.stringify(old)).not.toContain("clef-flash"); clean(old);
  prompted = false;
  const oldReal = await launch(args, deps);
  expect(oldReal).toMatchObject({ ok: true, state: "prompted", unavailable: old.unavailable }); clean(oldReal);
  // Text in saved diagnostics is classified again; it is never blindly copied into a launch.
  writeFileSync(adviceFile, JSON.stringify({ ...advice, unavailable: [{ ...advice.unavailable[0], why: marker, extra: marker }] }));
  const projected = await launch([...args, "--dry-run"], deps); expect(projected.unavailable).toEqual(advice.unavailable); clean(projected);
  writeFileSync(adviceFile, JSON.stringify({ ...advice, fallback: false, unavailable: [] }));
  expect((await launch([...args, "--dry-run"], deps)).unavailable).toEqual([]);
});
