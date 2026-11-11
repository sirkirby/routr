import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adviseCommand, checkCommand, usageCommand } from "./contract.mjs";
import { launch } from "./contract.mjs";
import { savedDecisionUnavailable } from "../src/lib/advice-file.mjs";
import { DECISION_CODES, DecisionError, decisionTarget, PROVIDERS } from "../src/lib/providers.mjs";
import { fileStore, memoryStore, usageReadings } from "../src/lib/usage-readings.mjs";
import { readAgy, readClaude, readCodexLive, summarize } from "../src/lib/usage.mjs";
import { parseKiroUsage, kiroReading, kiroUsage } from "../src/lib/kiro-usage.mjs";
import { cursorReading } from "../src/lib/cursor-usage.mjs";
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
// The usage-readings module with fake readers, every harness signed in, at the clock given.
const signedIn = { state: async () => ({ state: "yes", billing: null }), kept: () => null, why: () => "" };
const readingsWith = (readers, clock = { now: () => Date.now() / 1000 }, store = memoryStore()) => usageReadings({ configPath: null, store, clock, readers, signIn: signedIn });
const liveRead = (readers) => (names, given, o) => readingsWith(readers).live(names, { given, ...o });
const slowReader = (source, toReading, outcomes) => ({ source, speed: "background", reading: toReading, check: async () => { const o = outcomes.shift(); if (o instanceof Error) throw o; return o; } });
const dispatchUsage = (row) => adviseCommand("dispatch", marker, { config: cfg({ subscriptions: { [row.pool]: cfg().subscriptions.codex } }) }, {}, { askFn: reading, read: async () => [row] });

test("failed background refreshes leave fresh snapshots available; older and unknown readings say what was used", async () => {
  const T = 1800000000;
  for (const [name, toReading, good] of [
    ["cursor", cursorReading, { included_used_pct: 40 }],
    ["kiro", kiroReading, { credits_used: 20, credits_limit: 50, used_pct: 40 }],
  ]) {
    const clock = { t: T, now: () => clock.t };
    const r = readingsWith({ [name]: slowReader(`${name} /usage`, toReading, [{ ok: true, ...good }, { ok: false, ...usageFailure("read_failed") }]) }, clock);
    await r.readNow(name); clock.t = T + 1; await r.readNow(name);
    const read = async (t) => { clock.t = t; return (await r.live([name], { mayRefresh: [] }))[0].row; };
    const fresh = await dispatchUsage(await read(T));
    expect(fresh.unavailable).toEqual([]);
    expect(fresh.subscriptions.ranked[0]).toMatchObject({ usage: "live", age_sec: 0 });
    const older = await dispatchUsage(await read(T + 4 * 3600));
    expect(older.unavailable).toEqual([{ part: "usage", subscription: name, source: `${name} /usage`, ...usageFailure("read_failed"),
      reading: "kept", reading_source: `${name} snapshot`, age_sec: 4 * 3600 }]);
    const expired = await dispatchUsage(await read(T + 86400));
    expect(expired.unavailable).toEqual([{ part: "usage", subscription: name, source: `${name} /usage`, ...usageFailure("read_failed"), reading: "unknown" }]);
    expect(expired.subscriptions.ranked[0]).toMatchObject({ usage: "unknown", age_sec: 86400 });
    clean([fresh, older, expired]);
  }
});

test("Claude and Codex fallback diagnostics distinguish a fresh local reading from a kept older one", async () => {
  const T = 1800000000, file = join(scratch("local-fallback"), "claude-snapshot");
  writeFileSync(file, JSON.stringify({ ts: T, rate_limits: { seven_day: { used_percentage: 40, resets_at: T + 86400 } } }));
  const freshClaude = await readClaude({ file, nowSec: T + 299, exec: () => { throw new Error("a fresh snapshot needs no live read"); } });
  expect((await dispatchUsage(freshClaude)).unavailable).toEqual([]);
  const olderClaude = await readClaude({ file, nowSec: T + 300, exec: async () => null });
  expect((await dispatchUsage(olderClaude)).unavailable).toEqual([{ part: "usage", subscription: "claude", source: "claude /usage", ...usageFailure("no_response"),
    reading: "kept", reading_source: "statusline", age_sec: 300 }]);
  for (const age of [0, 299, 300]) {
    const codex = await readCodexLive({ exec: async () => null, nowSec: T + age, fallback: () => summarize({ pool: "codex", source: "session log", ts: T, nowSec: T + age, windows: [{ usedPct: 40 }] }) });
    const r = await dispatchUsage(codex);
    expect(r.unavailable).toEqual(age < 300 ? [] : [{ part: "usage", subscription: "codex", source: "app-server", ...usageFailure("no_response"),
      reading: "kept", reading_source: "session log", age_sec: age }]); clean(r);
  }
});

test("a failed live Codex read reports its metered session-log fallback, including its age", async () => {
  const T = 1800000000;
  for (const age of [0, 7200]) {
    const fallback = () => summarize({ pool: "codex", source: "session log", cls: "metered", ts: T, nowSec: T + age });
    expect((await dispatchUsage(fallback())).unavailable).toEqual([]); // Unknown metered capacity alone is a valid reading.
    const row = await readCodexLive({ exec: async () => null, fallback, nowSec: T + age });
    const r = await dispatchUsage(row);
    expect(r.unavailable).toEqual([{ part: "usage", subscription: "codex", source: "app-server", ...usageFailure("no_response"),
      reading: "kept", reading_source: "session log", age_sec: age }]);
    expect(r.subscriptions.ranked[0]).toMatchObject({ class: "metered", usable: null, headroom: null, age_sec: age });
    expect(row.note).toContain("Using the session log's last reading"); expect(row.note).not.toContain("unknown capacity"); clean(r);
  }
});

test("launch rebuilds every saved recovery action and HTTP status without trusting saved prose", async () => {
  const dir = scratch("launch-actions"), file = join(dir, "advice");
  const args = ["--kind", "claude", "--name", "worker", "--model", "sonnet", "--task", marker, "--advice", file, "--dry-run"];
  for (const [provider, code, status] of [
    ["typesafe", "no_key"], ["typesafe", "key_refused"], ["typesafe", "secrets_unreadable"],
    ["cloudflare", "daily_allowance"], ["cloudflare", "provider_error", 429], ["typesafe", "provider_error", 500],
    ["ollama", "model_missing"], ["ollama", "model_unsupported"], ["ollama", "unreachable"],
  ]) {
    const target = decisionTarget({ decision: { provider } }, {}), error = new DecisionError(target, code, status);
    writeFileSync(file, JSON.stringify({ mode: "dispatch", id: "older", fallback: true, brief_sha: briefSha(marker), unavailable: [{ part: "decision model", ...target, code, status, why: marker }] }));
    const r = await launch(args, { settings: () => cfg({ decision: { provider: "cloudflare", model: "clef-flash" } }) });
    expect(r.unavailable[0].why).toBe(error.message); expect(r.warnings).toEqual([]);
    if (status) expect(r.unavailable[0].status).toBe(status);
    if (code === "no_key") expect(r.unavailable[0].why).toContain("routr key set typesafe");
    clean(r);
  }
});

test("Antigravity window names come from known keys instead of outside ids", async () => {
  const row = await readAgy({ exec: async () => JSON.stringify({ command: { data: { groups: [{ name: "Gemini", buckets: ["weekly", "5h", marker].map((window) => ({ id: marker, window, remaining_fraction: 0.5 })) }] } } }) });
  expect(row.windows.map((w) => w.name)).toEqual(["weekly", "5h", "unknown"]); clean(row);
});

test("every classified decision failure has one output contract, independent of the asking command", async () => {
  const dir = scratch("unavailable"), brief = join(dir, "brief"), report = join(dir, "report");
  writeFileSync(brief, BRIEF_MARKER); writeFileSync(report, marker);
  for (const provider of Object.keys(PROVIDERS)) for (const code of DECISION_CODES.filter((c) => c !== "attempt_unknown" && (provider === "cloudflare" || c !== "daily_allowance"))) {
    const config = cfg({ decision: { provider } }), target = decisionTarget(config, {});
    const askFn = async () => { throw new DecisionError(target, code); };
    const missing = { part: "decision model", provider, model: target.model, code, why: new DecisionError(target, code).message, ...(code === "provider_error" ? { status: 0 } : {}) };
    expect(savedDecisionUnavailable({ unavailable: [missing] })).toEqual(missing);
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
      source: { claude: "claude /usage", codex: "app-server", cursor: "cursor /usage" }[subscription], ...usageFailure("read_failed"), reading: "unknown" })));
    expect(r.subscriptions.ranked).toHaveLength(3); clean(r);
  }
  const malformed = await adviseCommand("dispatch", marker, { config: cfg() }, {}, { askFn: reading, read: async () => null });
  expect(malformed.unavailable).toEqual([{ part: "usage", subscription: null, source: "routr", ...usageFailure("internal_error") }]); expect(malformed.subscriptions.ranked).toEqual([]); clean(malformed);
});

test("check lists both unreadable files and does not ask for a decision", async () => {
  const dir = scratch("unreadable-check");
  const r = await checkCommand({ brief: join(dir, "brief"), report: join(dir, "report") }, { askFn: () => { throw new Error("must not ask"); } });
  expect(r.unavailable.map((u) => [u.part, u.code])).toEqual([["brief", "unreadable"], ["report", "unreadable"]]);
  expect(r.headline).toBe("routr: no reading (brief unavailable: unreadable; report unavailable: unreadable); judge the report yourself");
  expect(r.next[0].why).toContain("Judge the report yourself"); clean(r);
});

test("a subscription excluded by the user's work-level setting is not reported as a failed reading", async () => {
  const config = cfg({ subscriptions: { codex: { ...cfg().subscriptions.codex, hardest_work: "basic" } } });
  const read = liveRead({ codex: { source: "app-server", speed: "inline", read: () => { throw new Error(marker); } } });
  const r = await adviseCommand("dispatch", marker, { config }, {}, { askFn: reading, read });
  expect(r.unavailable).toEqual([]); expect(r.subscriptions.excluded).toEqual([{ subscription: "codex", why: "the user does not give it standard work" }]); clean(r);
});

test("one source's failed read is isolated, structured at the reader, and never includes its output", async () => {
  const read = liveRead({
    codex: { source: "app-server", speed: "inline", read: () => { throw new Error(marker); } },
    cursor: { source: "cursor /usage", speed: "inline", read: () => summarize({ pool: "cursor", source: "cursor /usage", windows: [{ usedPct: 10 }] }) },
  });
  const config = cfg({ subscriptions: { codex: cfg().subscriptions.codex, cursor: cfg().subscriptions.cursor } });
  const r = await adviseCommand("dispatch", marker, { config }, {}, { askFn: reading, read });
  expect(r.unavailable).toEqual([{ part: "usage", subscription: "codex", source: "app-server", ...usageFailure("read_failed"), reading: "unknown" }]);
  expect(r.subscriptions.ranked.find((r) => r.subscription === "cursor").usage).toBe("live"); clean(r);
});

test("CLI distinguishes failed reads, stale snapshots with age, valid metered unknown capacity, and exclusions", () => {
  const home = scratch("unavailable-cli"), dir = join(home, ".config/routr"), cache = join(home, ".cache/routr");
  mkdirSync(dir, { recursive: true }); mkdirSync(cache, { recursive: true });
  const snapshot = join(cache, "usage", "cursor.json"), ts = Date.now() / 1000 - 90000;
  mkdirSync(join(cache, "usage"), { recursive: true });
  // What routr keeps of Cursor (usage-readings.mjs): its reading, read `age` seconds ago.
  const keep = (age) => { const at = Date.now() / 1000 - age; writeFileSync(snapshot, JSON.stringify({ reading: { ...cursorReading({ included_used_pct: 40 }, at), trustedUntil: at + 86400 }, attempt: { at, by: null, outcome: "ok" } })); };
  const subscriptions = Object.fromEntries(["codex", "cursor", "kiro", "agy"].map((n) => [n, { hardest_work: "strong", enabled: n !== "agy" }]));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ subscriptions, auto_update: false }));
  const run = (scenario, signedIn = true) => {
    writeFileSync(join(cache, "signed-in.json"), JSON.stringify(Object.fromEntries(["codex", "cursor", "kiro"].map((n) => [n, { state: n === "codex" && !signedIn ? "no" : "yes", ts: Date.now() / 1000 }]))));
    const p = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "fixtures/provider-fetch.mjs"), "--preload", join(import.meta.dir, "fixtures/usage-sources.mjs"), SCRIPT, "dispatch", marker], {
      env: cliEnv(home, { PATH: home, TYPESAFE_API_KEY: KEY_MARKER, ROUTR_TEST_PROVIDER: "typesafe", ROUTR_TEST_REPLY: "valid", ROUTR_TEST_USAGE: scenario }), stdin: "ignore",
    });
    expect(p.exitCode).toBe(0); expect(p.stderr.toString()).toBe(""); clean(p.stdout.toString()); return JSON.parse(p.stdout.toString());
  };
  keep(Date.now() / 1000 - ts);
  const r = run("four_cases");
  expect(r.unavailable).toEqual([{ part: "usage", subscription: "codex", source: "app-server", ...usageFailure("read_failed"), reading: "unknown" }]);
  expect(r.subscriptions.ranked.find((r) => r.subscription === "cursor")).toMatchObject({ usage: "unknown" });
  expect(r.subscriptions.ranked.find((r) => r.subscription === "cursor").age_sec).toBeGreaterThanOrEqual(90000);
  expect(r.subscriptions.ranked.find((r) => r.subscription === "kiro")).toMatchObject({ class: "metered", usable: null, headroom: null, usage: "metered" });
  expect(r.subscriptions.excluded).toContainEqual({ subscription: "agy", why: expect.stringContaining("off") });
  const signedOut = run("four_cases", false);
  expect(signedOut.unavailable).toEqual([]);
  expect(signedOut.subscriptions.excluded).toContainEqual({ subscription: "codex", why: expect.stringContaining("not signed in") });
  const failed = run("snapshot_failure", false);
  expect(failed.unavailable).toEqual([{ part: "usage", subscription: "cursor", source: "cursor /usage", ...usageFailure("invalid_response"), reading: "unknown" }]);
  const saved = readFileSync(snapshot, "utf8"); clean(saved);
  expect(JSON.parse(saved).attempt).toMatchObject({ outcome: "failed", code: "invalid_response" }); expect(saved).not.toContain("error");
  keep(0);
  const fresh = run("snapshot_failure", false);
  expect(fresh.unavailable).toEqual([]);
  expect(fresh.subscriptions.ranked.find((r) => r.subscription === "cursor")).toMatchObject({ usage: "live", age_sec: 0 });
  keep(18000);
  const kept = run("snapshot_failure", false), age = kept.unavailable[0].age_sec;
  expect(age).toBeGreaterThanOrEqual(18000);
  expect(kept.unavailable).toEqual([{ part: "usage", subscription: "cursor", source: "cursor /usage", ...usageFailure("invalid_response"), reading: "kept", reading_source: "cursor snapshot", age_sec: age }]);
});

test("a slow source's kept try and its named read share codes, redact raw failures, and forget a failure after success", async () => {
  for (const [name, toReading, good] of [
    ["cursor", cursorReading, { included_used_pct: 20 }],
    ["kiro", kiroReading, { credits_used: 10, credits_limit: 50, used_pct: 20 }],
  ]) {
    const nowSec = 1800000000, store = memoryStore(), clock = { now: () => nowSec }, later = { now: () => nowSec + 1 };
    const named = (outcome) => readingsWith({ [name]: slowReader(`${name} /usage`, toReading, [outcome]) }, clock, store).readNow(name);
    const served = async () => (await readingsWith({ [name]: slowReader(`${name} /usage`, toReading, []) }, later, store).live([name], { mayRefresh: [] }))[0].row;
    for (const code of ["no_response", "invalid_response", "private_folder", "source_missing", "read_failed", marker]) {
      const r = await named({ ok: false, code, why: marker, error: marker });
      expect(r).toEqual({ ok: false, ...usageFailure(code) }); clean(r);
      clean(JSON.stringify([...store.entries])); expect(store.get(name).entry.attempt).toEqual({ at: nowSec, by: expect.anything(), outcome: "failed", code: usageFailure(code).code });
      const row = await served(); expect(row.failure).toEqual(usageFailure(code)); clean(row);
    }
    await named(new Error(marker));
    clean(JSON.stringify([...store.entries]));
    await named({ ok: true, ...good });
    expect((await served()).failure).toBeUndefined();
    expect(store.get(name).entry.attempt).not.toHaveProperty("code");
    // Raw errors and unclassified text in a kept entry cannot be replayed, or copied by the next try.
    store.entries.set(name, { reading: { ...toReading(good, nowSec), plan: marker, other: marker }, attempt: { at: nowSec, outcome: "failed", code: marker, error: marker }, error: marker });
    clean(await served());
    await named({ ok: false, error: marker });
    clean(JSON.stringify([...store.entries]));
  }
});

test("kept entries that cannot be read have codes too; a missing first reading is not a failed source", async () => {
  const dir = scratch("kept-files"), store = fileStore(dir, { legacy: null }), nowSec = Date.now() / 1000;
  for (const [name, window] of [["cursor", "included"], ["kiro", "monthly_credits"]]) {
    const file = join(dir, `${name}.json`);
    const read = async () => (await readingsWith({ [name]: slowReader(`${name} /usage`, () => null, []) }, { now: () => nowSec }, store).live([name], { mayRefresh: [] }))[0].row;
    expect((await read()).failure).toBeUndefined();
    writeFileSync(file, `{ ${marker}`);
    const broken = await read(); expect(broken.failure).toEqual(usageFailure("invalid_response")); clean(broken);
    rmSync(file); mkdirSync(file);
    const unreadable = await read(); expect(unreadable.failure).toEqual(usageFailure("read_failed")); clean(unreadable);
    rmSync(file, { recursive: true });
    writeFileSync(file, JSON.stringify({ reading: { source: `${name} /usage`, takenAt: marker, windows: [{ name: window, usedPct: 10 }] } }));
    const badTime = await read(); expect(badTime.failure).toEqual(usageFailure("invalid_response")); expect(badTime.headroom).toBeNull(); clean(badTime);
    writeFileSync(file, JSON.stringify({ reading: { source: `${name} /usage`, takenAt: nowSec, windows: [{ name: window, usedPct: marker }] } }));
    const badNumbers = await read(); expect(badNumbers.failure).toEqual(usageFailure("invalid_response")); clean(badNumbers);
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
  expect(real.unavailable).toEqual(advice.unavailable); expect(real.warnings).toEqual([]); clean(real);
  const dry = await launch([...args, "--dry-run"], deps);
  expect(dry).toMatchObject({ ok: true, state: "planned", unavailable: advice.unavailable }); clean(dry);
  const entry = toEntry(advice, {}); expect(entry.decision_model).toBeNull(); expect(entry).not.toHaveProperty("unavailable");
  const sent = telemetryRows([entry], "test-install"); expect(sent[0]).not.toHaveProperty("unavailable"); clean(sent);
  writeFileSync(adviceFile, JSON.stringify({ mode: "dispatch", id: "older", fallback: true, brief_sha: briefSha(marker) }));
  const old = await launch([...args, "--dry-run"], deps);
  expect(old.ok).toBe(true); expect(old.unavailable).toEqual([{ part: "decision model", provider: null, model: null, code: "attempt_unknown", why: "The saved fallback advice does not name the attempted decision model and its failure." }]);
  expect(old.warnings).toEqual([]); expect(JSON.stringify(old)).not.toContain("clef-flash"); clean(old);
  prompted = false;
  const oldReal = await launch(args, deps);
  expect(oldReal).toMatchObject({ ok: true, state: "prompted", unavailable: old.unavailable }); clean(oldReal);
  // Text in saved diagnostics is classified again; it is never blindly copied into a launch.
  writeFileSync(adviceFile, JSON.stringify({ ...advice, unavailable: [{ ...advice.unavailable[0], why: marker, extra: marker }] }));
  const projected = await launch([...args, "--dry-run"], deps); expect(projected.unavailable).toEqual(advice.unavailable); clean(projected);
  writeFileSync(adviceFile, JSON.stringify({ ...advice, fallback: false, unavailable: [] }));
  expect((await launch([...args, "--dry-run"], deps)).unavailable).toEqual([]);
});


test("a shadowed usage command never recommends running /usage in usage or dispatch next steps", async () => {
  const configDir = scratch("shadow-next"), file = join(configDir, "missing");
  mkdirSync(join(configDir, "skills/usage"), { recursive: true });
  const row = await readClaude({ configDir, file, exec: async () => { throw new Error("must not execute"); } });
  const config = cfg({ subscriptions: { claude: cfg().subscriptions.claude } });
  for (const out of [await dispatchUsage(row), await usageCommand([], config, {}, { read: async () => [row] })]) {
    expect(out.unavailable).toContainEqual(expect.objectContaining({ code: "command_shadowed" }));
    expect(JSON.stringify(out.next)).not.toContain("/usage");
    expect(out.next).toContainEqual(expect.objectContaining({
      why: "Rename or remove your own usage skill or command, or pass --headroom from a number you already have",
      template: "--headroom claude=<share left>",
    }));
  }
});
