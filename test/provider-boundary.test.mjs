import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../src/lib/systemone.mjs";
import { DecisionError, decisionTarget } from "../src/lib/providers.mjs";
import { checkQuestions, questions } from "../src/lib/questions.mjs";
import { BRIEF_MARKER, KEY_MARKER, replyFetch } from "./fixtures/provider-fetch.mjs";
import { cliEnv, scratch, SCRIPT } from "./helpers.mjs";

const providers = ["typesafe", "cloudflare", "ollama"];
const credentials = { TYPESAFE_API_KEY: KEY_MARKER, CLOUDFLARE_API_TOKEN: KEY_MARKER, CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" };
const clean = (value) => { const text = typeof value === "string" ? value : JSON.stringify(value); expect(text).not.toContain(BRIEF_MARKER); expect(text).not.toContain(KEY_MARKER); };
const expected = (provider, code, status) => new DecisionError(decisionTarget({ decision: { provider } }, {}), code, status).message;
const cases = (provider) => [
  ["http500", "provider_error", 500], ["http429", "provider_error", 429], ["http529", "provider_error", 529],
  ["http401", "key_refused"], ["http403", "key_refused"],
  ["http404", provider === "ollama" ? "model_missing" : "provider_error", 404],
  ["unsupported", provider === "ollama" ? "model_unsupported" : "provider_error", 400],
  ["logit", provider === "ollama" ? "model_unsupported" : "provider_error", 500],
  ["network", "unreachable"], ["timeout", "timeout"], ["json", "invalid_response"],
  ["missing_answers", "invalid_response"], ["missing_question", "invalid_response"], ["answers", "invalid_response"],
  ["confidence", "invalid_response"], ["probability", "invalid_response"],
  ...(provider === "cloudflare" ? [["envelope", "invalid_response"]] : []),
];

for (const provider of providers) test(`${provider}: every request failure carries only its class, provider and fixed action`, async () => {
  const config = { decision: { provider } }, file = join(scratch("boundary-errors"), "none");
  for (const [scenario, code, status] of cases(provider)) {
    let error;
    try { await ask({ task: { brief: BRIEF_MARKER } }, questions, { config, env: credentials, file, deadlineMs: 20, fetchFn: replyFetch(provider, scenario) }); }
    catch (e) { error = e; }
    expect(error).toBeInstanceOf(DecisionError);
    expect(error).toMatchObject({ code, provider, message: expected(provider, code, status) });
    clean(error.message); clean(error); clean(error.stack);
  }
  if (provider !== "ollama") {
    let called = false;
    await expect(ask({}, questions, { config, env: {}, file, fetchFn: async () => { called = true; } }))
      .rejects.toMatchObject({ code: "no_key", provider, message: expected(provider, "no_key") });
    expect(called).toBe(false);
  }
});

test("the real request signal, and a timeout while reading a body, are classified without exception text", async () => {
  for (const provider of providers) {
    const config = { decision: { provider } };
    // Keep a timer referenced because AbortSignal.timeout itself does not keep Node's event loop alive.
    const hold = setTimeout(() => {}, 1000);
    try {
      await expect(ask({}, questions, { config, env: credentials, deadlineMs: 5, fetchFn: (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }))
        .rejects.toMatchObject({ code: "timeout", provider, message: expected(provider, "timeout") });
      const e = new Error(`${BRIEF_MARKER} ${KEY_MARKER}`); e.name = "AbortError";
      await expect(ask({}, questions, { config, env: credentials, fetchFn: async () => ({ ok: true, json: async () => { throw e; } }) }))
        .rejects.toMatchObject({ code: "timeout", provider });
      await expect(ask({}, questions, { config, env: credentials, fetchFn: async () => ({ ok: true, json: async () => { throw new TypeError(`${BRIEF_MARKER} ${KEY_MARKER}`); } }) }))
        .rejects.toMatchObject({ code: "unreachable", provider, message: expected(provider, "unreachable") });
    } finally { clearTimeout(hold); }
  }
});

// Drive the shipped CLI, including its real print/exit behavior. A preload supplies fetchFn via fetch's default;
// no model, network, harness, detached refresh or real home is used. Each run has its own secrets/config/ledger.
for (const provider of providers) test(`${provider}: every CLI caller prints fixed failures, never provider text`, () => {
  const home = scratch("boundary-cli"), config = join(home, ".config/routr/config.json");
  mkdirSync(join(home, ".config/routr"), { recursive: true });
  writeFileSync(config, JSON.stringify({ decision: { provider }, subscriptions: {}, auto_update: false }));
  const brief = join(home, "brief"), report = join(home, "report"), advice = join(home, "advice.json"), ledger = join(home, "ledger.jsonl");
  writeFileSync(brief, BRIEF_MARKER); writeFileSync(report, "Worker report with verification. ".repeat(10));
  const commands = [["dispatch", BRIEF_MARKER], ["subagent", BRIEF_MARKER], ["check", "--brief", brief, "--report", report], ["doctor", "--json"], ["doctor"]];
  if (provider !== "ollama") commands.push(["key", "set", provider]); // Ollama never asks for a key or runs a key test
  const run = (args, scenario, noKey = false) => {
    const result = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "fixtures/provider-fetch.mjs"), SCRIPT, ...args], {
      env: cliEnv(home, { PATH: home, ...(noKey ? {} : credentials), ROUTR_TEST_PROVIDER: provider, ROUTR_TEST_REPLY: scenario }),
      stdin: Buffer.from(provider === "cloudflare" ? `${KEY_MARKER}\n${credentials.CLOUDFLARE_ACCOUNT_ID}\n` : `${KEY_MARKER}\n`),
    });
    expect(result.exitCode).toBe(0); clean(result.stdout.toString()); clean(result.stderr.toString());
    return result.stdout.toString();
  };
  // Avoid retry delays in child runs; exhausted retryable statuses are covered through fetchFn above.
  for (const [scenario, code, status] of cases(provider).filter(([s]) => !["http429", "http529"].includes(s))) {
    for (const command of commands) {
      const stdout = run(command, scenario);
      expect(stdout).toContain(expected(provider, code, status));
      if (["dispatch", "subagent"].includes(command[0])) {
        const parsed = JSON.parse(stdout); expect(parsed).toMatchObject({ fallback: true, level: "standard" });
        writeFileSync(advice, stdout);
        run(["record", "--advice", advice, "--ledger", ledger], "valid");
        clean(readFileSync(ledger, "utf8"));
      }
    }
  }
  for (const scenario of ["work_type", "verdict"]) {
    for (const command of commands.filter(([c]) => c === "check" || (scenario === "work_type" && ["dispatch", "subagent"].includes(c)))) {
      const stdout = run(command, scenario);
      expect(stdout).toContain(expected(provider, "invalid_response"));
      if (command[0] !== "check") {
        writeFileSync(advice, stdout); run(["record", "--advice", advice, "--ledger", ledger], "valid"); clean(readFileSync(ledger, "utf8"));
      }
    }
  }
  // A valid answer can still carry arbitrary text in unused fields and response metadata: none crosses the boundary.
  for (const command of commands) {
    const stdout = run(command, "valid");
    if (["dispatch", "subagent", "check"].includes(command[0])) expect(JSON.parse(stdout).fallback).toBeUndefined();
    if (["dispatch", "subagent"].includes(command[0])) {
      writeFileSync(advice, stdout); run(["record", "--advice", advice, "--ledger", ledger], "valid"); clean(readFileSync(ledger, "utf8"));
    }
  }
  if (provider !== "ollama") {
    // key set above saved a test key: remove only that file before testing absent credentials.
    writeFileSync(join(home, ".config/routr/env"), "");
    for (const command of commands.filter(([c]) => c !== "key")) expect(run(command, "valid", true)).toContain(expected(provider, "no_key"));
  }
}, 30000);

for (const provider of providers) test(`${provider}: declared choices, numbers and probability keys/values are enforced before use`, async () => {
  const config = { decision: { provider } }, fetchValid = replyFetch(provider, "valid");
  const modify = (change) => async (url, init) => {
    const j = await (await fetchValid(url, init)).json(), result = provider === "cloudflare" ? j.result : j;
    change(result.answers); return Response.json(j);
  };
  const mutations = [
    (a) => { a.work_type.choice = BRIEF_MARKER; }, (a) => { a.verdict.choice = KEY_MARKER; },
    (a) => { a.states_verification.noul = -0.1; }, (a) => { a.states_verification.noul = 1.1; },
    (a) => { a.states_verification.noul = KEY_MARKER; }, (a) => { a.work_type.confidence = null; },
    (a) => { a.work_type.confidence = 1.1; }, (a) => { a.work_type.probabilities = { implement: -0.1 }; },
    (a) => { a.work_type.probabilities = { implement: KEY_MARKER }; }, (a) => { a.work_type.probabilities = { [BRIEF_MARKER]: 1 }; },
    (a) => { a.work_type.probabilities = []; }, (a) => { a.verdict.choice = { text: KEY_MARKER }; },
    (a) => { a.verdict.type = KEY_MARKER; }, (a) => { a.verdict = null; },
  ];
  for (const change of mutations) await expect(ask({}, checkQuestions, { config, env: credentials, fetchFn: modify(change) })).rejects.toMatchObject({ code: "invalid_response", provider });
  for (const value of [-1, 3, null, KEY_MARKER]) await expect(ask({}, questions, { config, env: credentials, fetchFn: modify((a) => { a.level.score = value; }) })).rejects.toMatchObject({ code: "invalid_response" });
  for (const probabilities of [{ 0: 1.1 }, { 3: 1 }, { [BRIEF_MARKER]: 1 }]) await expect(ask({}, questions, { config, env: credentials, fetchFn: modify((a) => { a.level.probabilities = probabilities; }) })).rejects.toMatchObject({ code: "invalid_response" });
  const valid = await ask({}, questions, { config, env: credentials, fetchFn: fetchValid });
  clean(valid); expect(valid.model).toBe(decisionTarget(config, {}).model); expect(valid.usage).toEqual({ input_tokens: 10 });
});
