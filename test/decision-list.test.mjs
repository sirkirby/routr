import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/lib/config.mjs";
import { decisionTargets, PROVIDERS } from "../src/lib/providers.mjs";
import { ask } from "../src/lib/systemone.mjs";
import { adviseCommand, checkCommand } from "../src/lib/commands.mjs";
import { fallbackAdvice } from "../src/lib/advice-file.mjs";
import { toEntry } from "../src/lib/ledger.mjs";
import { questions } from "../src/lib/questions.mjs";
import { askDecision } from "../src/lib/setup-guided.mjs";
import { parseDecision } from "../src/lib/setup.mjs";
import { BRIEF_MARKER, KEY_MARKER, PROVIDER_MARKER, replyFetch } from "./fixtures/provider-fetch.mjs";
import { cfg, cliEnv, scratch, SCRIPT } from "./helpers.mjs";

const ts = { provider: "typesafe", model: "jev-1.13.0" }, cf = { provider: "cloudflare", model: "clef" };
const local = { provider: "ollama", model: "clef-flash:9b-q8_0" };
const credentials = { TYPESAFE_API_KEY: KEY_MARKER, CLOUDFLARE_API_TOKEN: KEY_MARKER, CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" };
const clean = (value) => { const text = typeof value === "string" ? value : JSON.stringify(value); for (const marker of [KEY_MARKER, BRIEF_MARKER, PROVIDER_MARKER]) expect(text).not.toContain(marker); };
const providerOf = (url) => url.includes("api.cloudflare.com") ? "cloudflare" : url.includes("api.typesafe.ai") ? "typesafe" : "ollama";
function fetches(replies, seen = []) {
  return (url, init) => { const provider = providerOf(url); seen.push([provider, JSON.parse(init.body).model]); return replyFetch(provider, replies[provider] ?? "valid")(url, init); };
}
const options = (decision, replies, seen) => ({ config: cfg({ decision }), env: credentials, fetchFn: fetches(replies, seen), file: join(scratch("list-secrets"), "absent") });

test("ordered hosted attempts stop at the first reading and keep each answering model's profile", async () => {
  for (const decision of [[ts, cf], [cf, ts]]) {
    const seen = [], r = await ask({}, questions, options(decision, {}, seen));
    expect(seen).toEqual([[decision[0].provider, decision[0].model]]); expect(r.unavailable).toEqual([]);
    expect(r.profile).toBe(PROVIDERS[decision[0].provider].models[r.model]); clean(r);
  }
  const config = cfg({ decision: [ts, cf] });
  const askFn = (state, q) => ask(state, q, options(config.decision, { typesafe: "http500" }));
  for (const mode of ["dispatch", "subagent"]) {
    const r = await adviseCommand(mode, BRIEF_MARKER, { config }, {}, { askFn, read: async () => [] });
    expect(r).toMatchObject({ provider: "cloudflare", decision_model: "clef", sure: true });
    expect(r.headline).toContain("clef on Cloudflare Workers AI"); expect(r.headline).not.toContain("no reading");
    expect(r.unavailable).toMatchObject([{ provider: "typesafe", model: ts.model, code: "provider_error", status: 500 }]);
    expect(fallbackAdvice(r)).toBe(false); expect(toEntry(r, {}).advised.fallback).toBe(false); clean(r);
  }
});

test("backup confidence and torn notes use the answering model's measured profile", async () => {
  const config = cfg({ decision: [ts, cf] });
  for (const [probabilities, sure] of [[{ 0: 0.1, 1: 0.85, 2: 0.05 }, true], [{ 0: 0.1, 1: 0.6, 2: 0.3 }, false]]) {
    const fetchFn = async (url, init) => {
      if (providerOf(url) === "typesafe") return replyFetch("typesafe", "network")(url, init);
      const j = await (await replyFetch("cloudflare", "valid")(url, init)).json(); j.result.answers.level.probabilities = probabilities;
      return Response.json(j);
    };
    const r = await adviseCommand("subagent", BRIEF_MARKER, { config }, {}, { askFn: (s, q) => ask(s, q, { ...options(config.decision, {}), fetchFn }) });
    expect(r.sure).toBe(sure); if (!sure) expect(r.notes.join(" ")).toContain("26"); clean(r);
  }
});

for (const [reply, code] of [["network", "unreachable"], ["timeout", "timeout"], ["http500", "provider_error"], ["allowance", "daily_allowance"]]) test(`${code} moves on without provider prose`, async () => {
  const decision = reply === "allowance" ? [cf, ts] : [ts, cf], seen = [];
  const r = await ask({}, questions, options(decision, { [decision[0].provider]: reply }, seen));
  expect(seen.map(([p]) => p)).toEqual(decision.map((d) => d.provider));
  expect(r.unavailable).toMatchObject([{ code }]); expect(r.model).toBe(decision[1].model); clean(r);
});

test("no key moves on, but unreadable secrets stop with their own fix", async () => {
  const opts = options([ts, cf], {}), seen = [];
  const r = await ask({}, questions, { ...opts, env: { ...credentials, TYPESAFE_API_KEY: "" }, fetchFn: fetches({}, seen) });
  expect(r.unavailable).toMatchObject([{ code: "no_key" }]); expect(seen).toEqual([[cf.provider, cf.model]]); clean(r);
  const file = scratch("secrets-directory");
  await expect(ask({}, questions, { ...opts, file, env: { ...credentials, TYPESAFE_API_KEY: "" } })).rejects.toMatchObject({ code: "secrets_unreadable", unavailable: [{ code: "secrets_unreadable" }] });
});

for (const [reply, code] of [["http401", "key_refused"], ["http403", "key_refused"], ["json", "invalid_response"], ["work_type", "invalid_response"]]) test(`${reply} stops instead of asking a backup`, async () => {
  const seen = [];
  await expect(ask({}, questions, options([ts, cf], { typesafe: reply }, seen))).rejects.toMatchObject({ code, unavailable: [{ provider: "typesafe", code }] });
  expect(seen).toEqual([[ts.provider, ts.model]]);
});

test("local models go last in either position; unsupported and missing local models move on", async () => {
  for (const decision of [[local, ts, cf], [ts, local, cf]]) {
    const seen = [], r = await ask({}, questions, options(decision, { typesafe: "network", cloudflare: "network" }, seen));
    expect(seen.map(([p]) => p)).toEqual(["typesafe", "cloudflare", "ollama"]); expect(r.model).toBe(local.model); clean(r);
  }
  for (const [reply, code] of [["unsupported", "model_unsupported"], ["http404", "model_missing"]]) {
    const seen = [], opts = options([local, { ...local, model: "clef-flash:9b-mxfp8" }], {}, seen);
    const fetchFn = (url, init) => { seen.push(JSON.parse(init.body).model); return replyFetch("ollama", seen.length === 1 ? reply : "valid")(url, init); };
    const r = await ask({}, questions, { ...opts, fetchFn }); expect(seen).toHaveLength(2); expect(r.unavailable).toMatchObject([{ code }]); clean(r);
  }
});

test("a hosted 8-second cut leaves time for a backup inside the same overall deadline", async () => {
  const started = performance.now(), seen = [];
  const hold = setTimeout(() => {}, 12000);
  try {
    const fetchFn = (url, init) => {
      seen.push(providerOf(url));
      return seen.length === 1 ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })) : replyFetch("cloudflare", "valid")(url, init);
    };
    const r = await ask({}, questions, { ...options([ts, cf], {}), fetchFn });
    expect(performance.now() - started).toBeGreaterThan(7800); expect(performance.now() - started).toBeLessThan(10000);
    expect(seen).toEqual(["typesafe", "cloudflare"]); expect(r.unavailable).toMatchObject([{ code: "timeout" }]); clean(r);
  } finally { clearTimeout(hold); }
}, 12000);

test("one overall deadline bounds the list and reports each remaining entry as timed out", async () => {
  let calls = 0;
  const fetchFn = (_url, { signal }) => { calls++; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); };
  const hold = setTimeout(() => {}, 1000);
  try { await expect(ask({}, questions, { ...options([ts, cf, local], {}), deadlineMs: 20, fetchFn })).rejects.toMatchObject({ unavailable: [{ code: "timeout" }, { code: "timeout" }, { code: "timeout" }] }); }
  finally { clearTimeout(hold); }
  expect(calls).toBe(1);
});

test("all failures use fallback_level and keep one fixed unavailable entry per model; check uses the same list", async () => {
  const config = cfg({ decision: [ts, cf], fallback_level: "strong" });
  const askFn = (state, q) => ask(state, q, options(config.decision, { typesafe: "http500", cloudflare: "network" }));
  const r = await adviseCommand("dispatch", BRIEF_MARKER, { config }, {}, { askFn, read: async () => [] });
  expect(r).toMatchObject({ level: "strong", sure: false }); expect(r.unavailable.map((u) => u.code)).toEqual(["provider_error", "unreachable"]);
  expect(r.decision_model).toBeUndefined(); expect(fallbackAdvice(r)).toBe(true); clean(r);
  const dir = scratch("check-list"), brief = join(dir, "brief"), report = join(dir, "report");
  writeFileSync(brief, BRIEF_MARKER); writeFileSync(report, "Verified work. ".repeat(30));
  const down = await checkCommand({ brief, report }, { config, askFn }); expect(down.ok).toBe(false); expect(down.unavailable).toHaveLength(2); clean(down);
  const up = await checkCommand({ brief, report }, { config, askFn: (s, q) => ask(s, q, options(config.decision, { typesafe: "http500" })) });
  expect(up).toMatchObject({ ok: true, provider: "cloudflare", decision_model: "clef" }); expect(up.unavailable).toHaveLength(1); clean(up);
});

test("settings accept a single object, drop each bad entry with a fix, and default when empty or all bad", () => {
  const path = join(scratch("list-config"), "config.json");
  const read = (decision) => { writeFileSync(path, JSON.stringify({ decision })); return loadConfig(path); };
  expect(read(ts).config.decision).toEqual([ts]);
  const invalid = [{ provider: "unknown", model: "x" }, { provider: "cloudflare", model: "unknown" }, null, 5];
  const r = read([invalid[0], ts, ...invalid.slice(1), cf]); expect(r.config.decision).toEqual([ts, cf]); expect(r.notes).toHaveLength(4);
  for (const note of r.notes) { expect(note).toContain("dropped"); expect(note).toContain("routr setup --decision"); }
  for (const decision of [[], invalid]) expect(read(decision).config.decision).toEqual([{ provider: "typesafe", model: null }]);
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    const r = read([{ provider: "ollama", model: "clef-flash:9b-mxfp8" }, cf]); expect(r.config.decision).toEqual([cf]); expect(r.notes.join(" ")).toContain("does not run on this machine");
  }
});

test("ROUTR_DECISION_MODEL replaces the whole list, including an override without a provider", async () => {
  for (const override of ["cloudflare:clef-flash", "clef-flash"]) {
    const seen = [], opts = options([cf, ts, local], { cloudflare: "network" }, seen);
    expect(decisionTargets(opts.config, { ROUTR_DECISION_MODEL: override })).toMatchObject([{ provider: "cloudflare", model: "clef-flash" }]);
    await expect(ask({}, questions, { ...opts, env: { ...credentials, ROUTR_DECISION_MODEL: override } })).rejects.toMatchObject({ unavailable: [{ provider: "cloudflare", model: "clef-flash" }] });
    expect(seen).toEqual([["cloudflare", "clef-flash"]]);
  }
});

test("guided setup chooses a first model and an optional backup; the flag preserves ordered choices", async () => {
  expect(parseDecision(["--decision", "typesafe,cloudflare:clef-flash"])).toEqual([ts, { provider: "cloudflare", model: "clef-flash" }]);
  for (const backup of ["none", "cloudflare\u0000clef"]) {
    const values = ["typesafe\u0000jev-1.13.0", backup], screens = [];
    const r = await askDecision({ style: { dim: (s) => s }, select: async (screen) => { screens.push(screen); return values.shift(); } }, [ts]);
    expect(r).toEqual(backup === "none" ? [ts] : [ts, cf]); expect(screens[0].message).toContain("local models are tried after hosted models");
  }
});

test("source CLI: dispatch/check/doctor/setup/key, launch and record preserve backup readings without leaking markers", () => {
  const home = scratch("list-source-cli"), folder = join(home, ".config/routr"); mkdirSync(folder, { recursive: true });
  const config = join(folder, "config.json"), brief = join(home, "task"), report = join(home, "report"), advice = join(home, "advice.json"), ledger = join(home, "ledger.jsonl");
  writeFileSync(config, JSON.stringify({ decision: [ts, cf], auto_update: false, telemetry: false, subscriptions: {} }));
  writeFileSync(brief, BRIEF_MARKER); writeFileSync(report, "Verified work. ".repeat(30));
  const run = (args, { replies = { typesafe: "http500" }, input = "", env = {} } = {}) => {
    const r = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "fixtures/decision-list-fetch.mjs"), SCRIPT, ...args], { env: cliEnv(home, { PATH: home, ...credentials, ROUTR_TEST_REPLIES: JSON.stringify(replies), ...env }), stdin: Buffer.from(input) });
    expect(r.exitCode).toBe(0); clean(r.stdout.toString()); clean(r.stderr.toString()); return r.stdout.toString();
  };
  for (const mode of ["dispatch", "subagent"]) {
    const stdout = run([mode, "--task-file", brief]), r = JSON.parse(stdout); expect(r.decision_model).toBe(cf.model); expect(r.unavailable).toHaveLength(1);
    writeFileSync(advice, stdout);
  }
  const checked = JSON.parse(run(["check", "--brief", brief, "--report", report])); expect(checked.decision_model).toBe(cf.model); expect(checked.unavailable).toHaveLength(1);
  const doctor = JSON.parse(run(["doctor", "--json"])); expect(doctor).not.toHaveProperty("key");
  expect(doctor.decision).toMatchObject([{ provider: "typesafe", works: false, code: "provider_error" }, { provider: "cloudflare", works: true, model: "clef" }]);
  const doctorText = run(["doctor"]); expect(doctorText).toContain("key found but the test call failed"); expect(doctorText).toContain("clef answers");
  // Every new traversal outcome goes through every full command output, not just the provider return value.
  for (const [reply, code] of [["network", "unreachable"], ["timeout", "timeout"], ["http401", "key_refused"], ["json", "invalid_response"]]) {
    const replies = { typesafe: reply }, stopping = ["key_refused", "invalid_response"].includes(code);
    for (const mode of ["dispatch", "subagent", "check"]) {
      const r = JSON.parse(run(mode === "check" ? [mode, "--brief", brief, "--report", report] : [mode, "--task-file", brief], { replies }));
      expect(r.unavailable).toMatchObject([{ provider: "typesafe", code }]); expect(r.decision_model).toBe(stopping ? undefined : "clef");
    }
    const d = JSON.parse(run(["doctor", "--json"], { replies })); expect(d.decision).toMatchObject([{ works: false, code }, { works: true }]);
  }
  for (const mode of ["dispatch", "subagent", "check"]) {
    const args = mode === "check" ? [mode, "--brief", brief, "--report", report] : [mode, "--task-file", brief];
    const noKey = JSON.parse(run(args, { env: { TYPESAFE_API_KEY: "" } })); expect(noKey.decision_model).toBe("clef"); expect(noKey.unavailable).toMatchObject([{ code: "no_key" }]);
    const allDown = JSON.parse(run(args, { replies: { typesafe: "http500", cloudflare: "network" } })); expect(allDown.unavailable).toHaveLength(2); expect(allDown.decision_model).toBeUndefined();
  }
  // --task-file advice must be dispatch advice; overwrite the subagent output above.
  writeFileSync(advice, run(["dispatch", "--task-file", brief]));
  const launched = JSON.parse(run(["launch", "--kind", "codex", "--name", "worker", "--model", "worker", "--effort", "medium", "--task-file", brief, "--advice", advice, "--dry-run"]));
  expect(launched.ok).toBe(true); expect(launched.unavailable).toMatchObject([{ provider: "typesafe", code: "provider_error" }]); expect(launched.warnings.join(" ")).not.toContain("fallback");
  const recorded = JSON.parse(run(["record", "--advice", advice, "--task-file", brief, "--subscription", "codex", "--model", "worker", "--effort", "medium", "--verdict", "done", "--check", "pass", "--ledger", ledger]));
  expect(recorded.ok).toBe(true); const row = JSON.parse(readFileSync(ledger, "utf8")); expect(row).toMatchObject({ provider: "cloudflare", decision_model: "clef", advised: { fallback: false } }); clean(row);
  const setup = JSON.parse(run(["setup", "--yes", "--decision", "typesafe,cloudflare:clef-flash", "--json"]));
  expect(setup.did.join(" ")).toContain("decision"); expect(JSON.parse(readFileSync(config, "utf8")).decision).toEqual([{ ...ts, model: null }, { provider: "cloudflare", model: "clef-flash" }]);
  // Storing a key for an unused provider names the preserving command and leaves the list unchanged.
  writeFileSync(config, JSON.stringify({ decision: [ts], auto_update: false, telemetry: false, subscriptions: {} }));
  const before = readFileSync(config, "utf8"), key = JSON.parse(run(["key", "set", "cloudflare"], { input: `${KEY_MARKER}\n${credentials.CLOUDFLARE_ACCOUNT_ID}\n` }));
  expect(key).toMatchObject({ ok: true, works: true }); expect(key.note).toContain("routr setup --decision typesafe:jev-1.13.0,cloudflare"); expect(readFileSync(config, "utf8")).toBe(before);
  const defaultKey = JSON.parse(run(["key", "set"], { input: `${KEY_MARKER}\n`, replies: {} })); expect(defaultKey.provider).toBe("typesafe");
}, 20000);
