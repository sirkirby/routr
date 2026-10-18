import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, failureMessage, secretsFor } from "../src/lib/systemone.mjs";
import { DecisionError, decisionTarget, ollamaTooOld, PROVIDERS } from "../src/lib/providers.mjs";
import { adviseCommand, checkCommand } from "../src/lib/commands.mjs";
import { checkQuestions, questions } from "../src/lib/questions.mjs";
import { BRIEF_MARKER, KEY_MARKER, replyFetch } from "./fixtures/provider-fetch.mjs";
import { cfg, cliEnv, scratch, SCRIPT } from "./helpers.mjs";

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
  ...(provider === "cloudflare" ? [["envelope", "invalid_response"], ["allowance", "daily_allowance"], ["allowance200", "daily_allowance"], ["string_code", "provider_error", 429], ["unknown_code", "provider_error", 429]] : []),
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
  const run = (args, scenario, noKey = false, extraEnv = {}) => {
    const result = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "fixtures/provider-fetch.mjs"), SCRIPT, ...args], {
      env: cliEnv(home, { PATH: home, ...(noKey ? {} : credentials), ROUTR_TEST_PROVIDER: provider, ROUTR_TEST_REPLY: scenario, ...extraEnv }),
      stdin: Buffer.from(provider === "cloudflare" ? `${KEY_MARKER}\n${credentials.CLOUDFLARE_ACCOUNT_ID}\n` : `${KEY_MARKER}\n`),
    });
    expect(result.exitCode).toBe(0); clean(result.stdout.toString()); clean(result.stderr.toString());
    return result.stdout.toString();
  };
  const rows = () => existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse) : [];
  const record = (stdout) => {
    const before = rows().length, id = JSON.parse(stdout).id;
    writeFileSync(advice, stdout);
    const result = JSON.parse(run(["record", "--advice", advice, "--ledger", ledger], "valid"));
    expect(result).toMatchObject({ recorded: id, ledger }); expect(result.run_id).toBeString();
    const after = rows(); expect(after).toHaveLength(before + 1); expect(after.at(-1)).toMatchObject({ id, run_id: result.run_id });
    clean(readFileSync(ledger, "utf8"));
  };
  // Avoid retry delays in child runs; exhausted retryable statuses are covered through fetchFn above.
  for (const [scenario, code, status] of cases(provider).filter(([s]) => !["http429", "http529", "string_code", "unknown_code"].includes(s))) {
    for (const command of commands) {
      const stdout = run(command, scenario);
      expect(stdout).toContain(expected(provider, code, status));
      if (["dispatch", "subagent"].includes(command[0])) {
        const parsed = JSON.parse(stdout); expect(parsed).toMatchObject({ fallback: true, level: "standard" });
        record(stdout);
      }
      if (command[0] === "doctor" && command.includes("--json") && code === "key_refused") {
        const r = JSON.parse(stdout);
        expect(r.next_steps[0]).toBe(r.key.error);
        expect(r.next_steps[0].split(PROVIDERS[provider].get).length - 1).toBe(provider === "ollama" ? 0 : 1);
      }
    }
  }
  for (const scenario of ["work_type", "verdict"]) {
    for (const command of commands.filter(([c]) => c === "check" || (scenario === "work_type" && ["dispatch", "subagent"].includes(c)))) {
      const stdout = run(command, scenario);
      expect(stdout).toContain(expected(provider, "invalid_response"));
      if (command[0] !== "check") {
        record(stdout);
      }
    }
  }
  // A valid answer can still carry arbitrary text in unused fields and response metadata: none crosses the boundary.
  for (const command of commands) {
    const stdout = run(command, "valid");
    if (["dispatch", "subagent", "check"].includes(command[0])) expect(JSON.parse(stdout).fallback).toBeUndefined();
    if (["dispatch", "subagent"].includes(command[0])) {
      record(stdout);
    }
  }
  if (provider !== "ollama") {
    // Clear the test key saved above before testing absent credentials and an unreadable secrets file.
    writeFileSync(join(home, ".config/routr/env"), "");
    for (const command of commands.filter(([c]) => c !== "key")) expect(run(command, "valid", true)).toContain(expected(provider, "no_key"));
    rmSync(join(home, ".config/routr/env")); mkdirSync(join(home, ".config/routr/env"));
    for (const command of commands.filter(([c]) => c !== "key")) {
      const stdout = run(command, "valid", true);
      expect(stdout).toContain("routr cannot read its secrets file"); expect(stdout).toContain(join(home, ".config/routr/env"));
    }
  }
  if (provider === "typesafe") {
    const stdout = run(["doctor"], "identity", false, { ROUTR_DECISION_MODEL: "jev-preview" });
    expect(stdout).toContain("jev-1.14.0, asked as jev-preview answers");
  }
  if (provider === "ollama") {
    const r = JSON.parse(run(["doctor", "--json"], "digest")); expect(r.key.note).toBeNull();
    // --yes setup checks local readiness, including /api/version; no key or harness is needed.
    const stdout = run(["setup", "--yes", "--decision", "ollama:clef-flash:9b-q8_0", "--json"], "version");
    expect(stdout).not.toContain("Ollama 0.40.0");
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

test("model identities resolve aliases and expose pin mismatches only through each provider's validator", async () => {
  for (const provider of providers) {
    const config = { decision: { provider } }, target = decisionTarget(config, {});
    const identities = provider === "typesafe" ? ["jev-1.14.0", "jev-1.13.0"] : Object.keys(PROVIDERS[provider].models);
    for (const requested of provider === "typesafe" ? ["jev-preview", target.model] : [target.model]) {
      for (const identity of [...identities, `${BRIEF_MARKER} ${KEY_MARKER}`, null, 7, {}, "constructor", "jev-preview", "jev-1.14.0 evil"]) {
        const fetchFn = async (url, init) => {
          const j = await (await replyFetch(provider, "valid")(url, init)).json(), result = provider === "cloudflare" ? j.result : j;
          result.model = identity; return Response.json(j);
        };
        const r = await ask({}, questions, { target: { ...target, model: requested }, env: credentials, fetchFn });
        expect(r.model).toBe(identities.includes(identity) ? identity : requested); clean(r);
      }
    }
  }
});

test("missing secrets name routr's own secret and variable; unreadable files are distinct and never send a request", async () => {
  const dir = scratch("unreadable-secrets"), file = join(dir, "env"); mkdirSync(file);
  for (const provider of ["typesafe", "cloudflare"]) {
    const config = { decision: { provider } };
    for (const secret of PROVIDERS[provider].secrets) {
      const env = { ...credentials }; delete env[secret.name];
      const missing = new DecisionError(decisionTarget(config, {}), "no_key", undefined, { secret: secret.name });
      expect(() => secretsFor(provider, { env, file: join(dir, "absent") })).toThrow(missing.message);
      expect(missing.message).toContain(secret.label); expect(missing.message).toContain(secret.name);
      let sent = false;
      try { await ask({}, questions, { config, env, file, fetchFn: async () => { sent = true; } }); throw new Error("unexpected success"); }
      catch (e) {
        expect(e).toBeInstanceOf(DecisionError); expect(e.code).toBe("secrets_unreadable");
        expect(e.message).toContain(file); expect(e.message).toContain(secret.name); clean(e.message);
      }
      expect(sent).toBe(false);
    }
    expect(secretsFor(provider, { env: credentials, file })).toMatchObject(Object.fromEntries(PROVIDERS[provider].secrets.map((s) => [s.name, credentials[s.name]])));
  }
});

test("a request routr cannot build is an internal error, not a failed network call or provider reply", async () => {
  for (const provider of providers) {
    let sent = false;
    const config = { decision: { provider } }, original = PROVIDERS[provider].request;
    try {
      PROVIDERS[provider].request = () => { throw new Error(`${BRIEF_MARKER} ${KEY_MARKER}`); };
      await expect(ask({}, questions, { config, env: credentials, fetchFn: async () => { sent = true; } })).rejects.toMatchObject({ provider, code: "internal_error", message: expected(provider, "internal_error") });
      expect(sent).toBe(false);
    } finally { PROVIDERS[provider].request = original; }
    const state = {}; state.self = state;
    await expect(ask(state, questions, { config, env: credentials, fetchFn: async () => { sent = true; } })).rejects.toMatchObject({ code: "internal_error" });
    expect(sent).toBe(false);
  }
});

test("failures inside advise and readReport use the same fixed internal sentence without exposing exception text", async () => {
  const config = cfg(), internal = "routr: an internal error stopped the decision check. Run routr doctor; if it persists, report it to routr.";
  const fail = () => { throw new Error(`${BRIEF_MARKER} ${KEY_MARKER}`); };
  expect(failureMessage(new Error(KEY_MARKER), config)).toBe(internal);
  for (const mode of ["dispatch", "subagent"]) {
    const r = await adviseCommand(mode, BRIEF_MARKER, { config }, {}, { askFn: async () => ({ answers: { get level() { return fail(); } } }), read: async () => [] });
    expect(r.fallback).toBe(true); expect(r.notes.join(" ")).toContain(internal); clean(r);
  }
  const dir = scratch("internal-report"), brief = join(dir, "brief"), report = join(dir, "report");
  writeFileSync(brief, BRIEF_MARKER); writeFileSync(report, "Complete report. ".repeat(20));
  const r = await checkCommand({ brief, report }, { config, askFn: async () => ({ answers: { get work_type() { return fail(); } } }) });
  expect(r).toMatchObject({ fallback: true, error: internal }); clean(r);
});

test("Ollama accepts only declared version and digest formats, keeping unknown metadata out of readiness and doctor notes", async () => {
  const P = PROVIDERS.ollama, model = "clef-flash:9b-q8_0", profile = P.models[model];
  for (const version of [undefined, null, 7, {}, "0.40", "0.40.0 extra", `0.40.0 ${BRIEF_MARKER} ${KEY_MARKER}`, "0.40.0\n" + KEY_MARKER, "0.40.3", "0.0.0", "0.41.0-rc1"]) {
    const fetchFn = async (url) => Response.json(url.endsWith("/api/version") ? { version } : { models: [{ name: model, digest: "a".repeat(64) }] });
    expect(await ollamaTooOld({}, fetchFn)).toBeNull(); expect(await P.ready(model, {}, fetchFn)).toBeNull();
  }
  for (const version of ["0.40.0", "0.40.1-rc1"]) {
    const message = await ollamaTooOld({}, async () => Response.json({ version }));
    expect(message).toContain(`Ollama ${version} is running`); expect(message).toContain("update Ollama"); clean(message);
  }
  for (const digest of [undefined, null, 7, {}, "abcdef", "ABCDEF012345", `a123456789ab${BRIEF_MARKER} ${KEY_MARKER}`, "a123456789ab extra", profile.digest]) {
    expect(await P.check(model, profile, {}, async () => Response.json({ models: [{ name: model, digest }] }))).toBeNull();
  }
  const note = await P.check(model, profile, {}, async () => Response.json({ models: [{ name: model, digest: "a".repeat(64) }] }));
  expect(note).toContain("here is build aaaaaaaaaaaa"); expect(note).toContain(`not ${profile.digest}`); clean(note);
  const fetchFn = async () => { throw new Error(`${BRIEF_MARKER} ${KEY_MARKER}`); };
  await expect(ask({}, questions, { config: { decision: { provider: "ollama" } }, env: { OLLAMA_HOST: "127.0.0.1:11999" }, fetchFn })).rejects.toThrow("cannot be reached at http://127.0.0.1:11999");
});

test("HTTP families and Cloudflare's numeric allowance code give different actions without using messages", async () => {
  for (const provider of providers) {
    const config = { decision: { provider } };
    for (const [status, action] of [[400, "Check the decision model and provider settings before trying again."], [429, "Check the provider's limits and try again after they reset."], [500, "Try again later."]]) {
      await expect(ask({}, questions, { config, env: credentials, deadlineMs: 20, fetchFn: replyFetch(provider, `http${status}`) })).rejects.toThrow(action);
    }
  }
  const message = "Cloudflare Workers AI: the daily free allowance is used up. Wait for the daily reset or enable the Workers Paid plan in Cloudflare.";
  for (const scenario of ["allowance", "allowance200"]) {
    let sent = 0;
    await expect(ask({}, questions, { config: { decision: { provider: "cloudflare" } }, env: credentials, fetchFn: (...args) => { sent++; return replyFetch("cloudflare", scenario)(...args); } })).rejects.toMatchObject({ code: "daily_allowance", message });
    expect(sent).toBe(1);
  }
  // Authentication status wins even if the body also happens to match another fixed provider diagnostic.
  for (const provider of providers) for (const status of [401, 403]) {
    await expect(ask({}, questions, { config: { decision: { provider } }, env: credentials,
      fetchFn: async () => Response.json({ success: false, errors: [{ code: 3036, message: `${BRIEF_MARKER} ${KEY_MARKER}` }], error: "does not support decision" }, { status }),
    })).rejects.toMatchObject({ code: "key_refused" });
  }
});

for (const provider of ["typesafe", "cloudflare"]) test(`${provider}: setup's real key step displays classified failures without markers`, () => {
  const home = scratch("setup-provider-key"), folder = join(home, ".config/routr"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "config.json"), JSON.stringify({ decision: { provider }, subscriptions: {}, telemetry: false, auto_update: false }));
  const scenarios = ["http500", "http401", "json", "network", "timeout", ...(provider === "cloudflare" ? ["envelope", "allowance"] : [])];
  for (const scenario of scenarios) {
    const code = cases(provider).find(([s]) => s === scenario);
    const result = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "fixtures/provider-fetch.mjs"), join(import.meta.dir, "fixtures/provider-setup.mjs")], {
      env: cliEnv(home, { PATH: home, ...credentials, ROUTR_TEST_PROVIDER: provider, ROUTR_TEST_REPLY: scenario }),
      stdin: Buffer.from(provider === "cloudflare" ? `${KEY_MARKER}\n${credentials.CLOUDFLARE_ACCOUNT_ID}\n` : `${KEY_MARKER}\n`),
    });
    expect(result.exitCode).toBe(0); const stdout = result.stdout.toString(); clean(stdout); clean(result.stderr.toString());
    expect(stdout).toContain(expected(provider, code[1], code[2]));
    const r = JSON.parse(stdout); expect(r.result.ok).toBe(true); expect(r.result.did.join(" ")).toContain(`saved the ${PROVIDERS[provider].label} key`);
  }
}, 30000);
