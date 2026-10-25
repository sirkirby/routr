import { expect, test } from "bun:test";
import { parseTraceparent, leadSession } from "../src/lib/trace-context.mjs";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, scratch, ans, fact, cliEnv, SCRIPT } from "./helpers.mjs";
import { prepareOtel, OTEL_RESOURCE_ATTRIBUTES } from "../src/lib/otel.mjs";
import { usageCommand, adviseCommand, recordCommand, checkCommand } from "../src/lib/commands.mjs";
import { launch } from "../src/lib/launch.mjs";
import { ask } from "../src/lib/systemone.mjs";
import { replyFetch } from "./fixtures/provider-fetch.mjs";
import { cleanup } from "../src/lib/cleanup.mjs";
import { sendCommand, waitCommand, workersCommand, stopCommand } from "../src/lib/workers.mjs";
import { LaunchIndex } from "../src/lib/launch-index.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { TRACE_ATTRIBUTES, ERROR_CODES } from "../src/lib/traces.mjs";
import { readUsage } from "../src/lib/harnesses.mjs";

function exporting(env = {}) {
  const home = scratch("traces"), configPath = join(home, "config.json"), config = cfg({ subscriptions: {}, otel: { endpoint: "http://127.0.0.1:4318", consent: "1234567890abcdef1234567890abcdef" } });
  writeFileSync(configPath, JSON.stringify(config)); prepareOtel({ home });
  let tick = 1800000000000;
  const spawned = [], otel = { home, configPath, now: () => tick++, spawn: (args) => { spawned.push(args); return true; } };
  const batches = () => readdirSync(join(home, ".cache/routr/otel/traces")).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(join(home, ".cache/routr/otel/traces", n), "utf8")));
  return { home, config, otel, env, spawned, batches, spans: () => batches().flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans) };
}

test("usage queues an inherited span with the pinned resource and no success status", async () => {
  const x = exporting({ TRACEPARENT: parent, BAGGAGE: "BAGGAGE_MARKER" });
  const r = await usageCommand([], x.config, {}, { env: x.env, otel: x.otel, read: async () => [] });
  expect(r.ok).toBe(true);
  expect(x.spans()).toHaveLength(1);
  expect(x.spans()[0]).toMatchObject({ name: "routr usage", kind: 1, traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "00f067aa0ba902b7" });
  expect(x.spans()[0].status).toBeUndefined();
  const resource = x.batches()[0].resourceSpans[0];
  expect(resource.schemaUrl).toBe("https://opentelemetry.io/schemas/1.44.0");
  expect(resource.scopeSpans[0].schemaUrl).toBeUndefined();
  expect(resource.resource.attributes).toContainEqual({ key: "routr.otel.schema", value: { stringValue: "genai@9ffc7e00;semconv@1.44.0;routr@1" } });
  expect(JSON.stringify(x.batches())).not.toContain("BAGGAGE_MARKER");
  expect(x.spawned).toHaveLength(1);
});

test("launch hands its sampled span to panes, drops orphan tracestate, and leaves off/unsampled forwarding alone", async () => {
  for (const mode of ["inherited", "invalid", "none", "unsampled", "off"]) {
    const env = { HERDR_ENV: "1", ...(mode === "none" ? {} : { TRACEPARENT: mode === "invalid" ? "invalid" : mode === "unsampled" ? parent.slice(0, -2) + "00" : parent }), TRACESTATE: "vendor=STATE_MARKER", BAGGAGE: "BAGGAGE_MARKER" };
    const x = exporting(env);
    if (mode === "off") { delete x.config.otel; writeFileSync(x.otel.configPath, JSON.stringify(x.config)); }
    let split;
    const r = await launch(["--kind", "claude", "--name", "fixture", "--model", "sonnet", "--direction", "right"], {
      env, settings: () => ({ config: x.config }), ready: async () => null, otel: x.otel,
      run: async (args) => {
        if (args[0] === "pane" && args[1] === "split") { split = args; return { ok: false }; }
        return { ok: false };
      },
    });
    expect(r.state).toBe("failed"); // the fixture refuses after observing the actual pane environment
    expect(split).toBeDefined();
    if (["off", "unsampled"].includes(mode)) {
      expect(x.spans()).toHaveLength(0);
      expect(split).toContain(`TRACEPARENT=${env.TRACEPARENT}`);
      expect(split).toContain("TRACESTATE=vendor=STATE_MARKER");
      expect(x.spawned).toHaveLength(0);
    } else {
      const s = x.spans()[0];
      expect(split).toContain(`TRACEPARENT=00-${s.traceId}-${s.spanId}-01`);
      expect(split).toContain(mode === "inherited" ? "TRACESTATE=vendor=STATE_MARKER" : "TRACESTATE=");
      expect(s.parentSpanId).toBe(mode === "inherited" ? "00f067aa0ba902b7" : undefined);
    }
    expect(split).toContain("BAGGAGE=BAGGAGE_MARKER");
    expect(JSON.stringify(x.batches())).not.toMatch(/BAGGAGE_MARKER|STATE_MARKER/);
  }
});

const attrs = (s) => Object.fromEntries(s.attributes.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? (value.intValue == null ? value.doubleValue ?? value.arrayValue?.values.map((v) => v.stringValue) : Number(value.intValue))]));
test("dispatch's classify child exports observed usage, requested and named response model, never reply text", async () => {
  const x = exporting({ TRACEPARENT: parent });
  await adviseCommand("dispatch", "BRIEF_MARKER", { config: x.config }, {}, { env: x.env, otel: x.otel, read: async () => [], askFn: async () => ({
    answers: fact(ans(1, 0.9), { names_location: 0.8 }), provider: "typesafe", model: "jev-1.13.0", request_model: "jev-1.13.0", response_model: "jev-1.13.0", latencyMs: 3,
    usage: { input_tokens: 21, output_tokens: 7, total_tokens: 28, "cache_read.input_tokens": 10 }, reply: "REPLY_MARKER",
  }) });
  const spans = x.spans(), root = spans.find((s) => s.name === "routr dispatch"), child = spans.find((s) => s.name === "classify jev-1.13.0");
  expect(child).toMatchObject({ kind: 3, traceId: root.traceId, parentSpanId: root.spanId });
  expect(attrs(child)).toMatchObject({ "gen_ai.operation.name": "classify", "gen_ai.provider.name": "typesafe", "gen_ai.request.model": "jev-1.13.0", "gen_ai.response.model": "jev-1.13.0", "gen_ai.usage.input_tokens": 21, "gen_ai.usage.output_tokens": 7, "gen_ai.usage.cache_read.input_tokens": 10 });
  expect(attrs(child)).not.toHaveProperty("gen_ai.usage.total_tokens");
  expect(attrs(root)).toMatchObject({ "routr.assessment.names_location": 0.8, "routr.question_set.version": "r5" });
  expect(JSON.stringify(x.batches())).not.toMatch(/BRIEF_MARKER|REPLY_MARKER/);
});

test("record projects only its exact resolved outcome fields, using telemetry's checks", () => {
  const x = exporting(), advice = join(x.home, "advice.json");
  writeFileSync(advice, JSON.stringify({ id: "abc12345", brief_sha: "123456789abc", mode: "dispatch", level: "standard" }));
  const r = recordCommand({ advice, ledger: join(x.home, "ledger.jsonl"), subscription: "codex", model: "MODEL_MARKER", effort: "low", verdict: "NOTE_MARKER", check: "pass", attempts: "2", seconds: "4.5", causes: ["execution"], note: "NOTE_MARKER" }, [], x.config, { env: {}, otel: x.otel });
  expect(r.ok).toBe(true);
  expect(attrs(x.spans()[0])).toMatchObject({ "routr.verdict": "other", "routr.check": "pass", "routr.level": "standard", "routr.attempts": 2, "routr.seconds": 4.5, "routr.causes": ["execution"], "routr.subscription": "codex", "routr.effort": "low", "routr.effort_from": "given", "routr.advice.id": "abc12345" });
  expect(JSON.stringify(x.batches())).not.toMatch(/MODEL_MARKER|NOTE_MARKER/);
});

test("the provider boundary preserves requested identity separately and never echoes it as a response identity", async () => {
  const x = exporting(), valid = replyFetch("typesafe", "valid");
  for (const named of [false, true]) {
    const before = x.spans().length;
    await adviseCommand("subagent", "BRIEF_MARKER", { config: x.config }, {}, { env: {}, otel: x.otel,
      askFn: (state, questions, opts) => ask(state, questions, { ...opts, env: { TYPESAFE_API_KEY: "KEY_MARKER" }, fetchFn: async (url, init) => {
        const j = await (await valid(url, init)).json();
        if (named) j.model = "jev-1.14.0";
        j.usage["reasoning.output_tokens"] = 3;
        return Response.json(j);
      } }),
    });
    const span = x.spans().slice(before).find((s) => s.kind === 3);
    expect(attrs(span)["gen_ai.request.model"]).toBe("jev-1.13.0");
    expect(attrs(span)["gen_ai.response.model"]).toBe(named ? "jev-1.14.0" : undefined);
    expect(attrs(span)["gen_ai.usage.reasoning.output_tokens"]).toBe(3);
  }
});

test("usage has per-subscription children and orchestration commands emit only classified outcomes", async () => {
  const x = exporting();
  await usageCommand(["--level", "standard"], x.config, {}, { otel: x.otel, env: {}, read: async () => [{ pool: "codex", source: "app-server", headroom: 0.7, windows: [], ageSec: 0 }] });
  const root = x.spans().find((s) => s.name === "routr usage"), child = x.spans().find((s) => s.name === "routr usage codex");
  expect(attrs(root)["routr.level"]).toBe("standard");
  expect(child.parentSpanId).toBe(root.spanId);
  expect(attrs(child)).toMatchObject({ "routr.subscription": "codex", "routr.usage.state": "live", "routr.usage.source": "app-server" });
  const opts = { otel: x.otel, env: {}, settings: () => ({ config: x.config }) };
  for (const [cmd, fn, args] of [["send", sendCommand, []], ["wait", waitCommand, ["--timeout", "0"]], ["workers", workersCommand, []], ["stop", stopCommand, []], ["cleanup", cleanup, ["--unknown"]]]) {
    const before = x.spans().length;
    await fn(args, opts);
    expect(x.spans().slice(before)).toHaveLength(1);
    expect(x.spans().slice(before)[0].name).toBe(`routr ${cmd}`);
    if (["send", "stop", "cleanup"].includes(cmd)) expect(attrs(x.spans().at(-1))["error.type"]).toBeDefined();
  }
});

test("parallel usage child durations measure their own reading rather than the slowest subscription", async () => {
  const x = exporting(); x.config.subscriptions = { claude: {}, codex: {} };
  const sources = Object.fromEntries([["claude", 40], ["codex", 1]].map(([name, delay]) => [name, { source: "app-server", read: async () => { await Bun.sleep(delay); return { pool: name, windows: [], headroom: 0.7 }; } }]));
  await usageCommand([], x.config, {}, { env: {}, otel: x.otel, read: (names, given, opts) => readUsage(names, given, { sources, observe: opts.observe, why: async () => null, billing: async () => null }) });
  const duration = (name) => { const s = x.spans().find((s) => s.name === `routr usage ${name}`); return Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)); };
  expect(duration("codex")).toBeLessThan(duration("claude") * 0.7);
});

test("a pane launch records identity, session and immutable index; cleanup and later record link to it", async () => {
  const x = exporting({ HERDR_ENV: "1", CODEX_THREAD_ID: "019a1aaa-1234-7123-8123-123456789abc" }), advice = join(x.home, "advice.json"), task = "BRIEF_MARKER";
  writeFileSync(advice, JSON.stringify({ id: "abc12345", brief_sha: briefSha(task), mode: "dispatch", level: "standard" }));
  let ticks = 0, started = false;
  const session = "12345678-1234-4123-8123-123456789abc", run = async (a) => {
    const ok = (result) => ({ ok: true, data: { result } });
    if (a[0] === "pane" && a[1] === "get") return ok({ pane: { pane_id: "w1:p2", terminal_id: "term-1", agent_session: { kind: "id", value: session } } });
    if (a[1] === "split") return ok({ pane: { pane_id: "w1:p2" } });
    if (a[1] === "read") return ok({ text: started ? "Welcome\n❯" : "user % " });
    if (a[1] === "process-info") return ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, cwd: process.cwd() }] } });
    if (a[1] === "start") { started = true; return ok({}); }
    if (a[0] === "agent" && a[1] === "get") return started ? ok({ agent: { agent: "claude", agent_status: "idle", interactive_ready: true, cwd: process.cwd() } }) : { ok: false, data: { error: { code: "agent_not_found" } } };
    if (a[0] === "pane" && a[1] === "list") return ok({ panes: [{ pane_id: "w1:p2", terminal_id: "term-1", agent_status: "idle" }] });
    if (a[0] === "workspace") return ok({ workspaces: [] });
    return ok({});
  };
  const opts = { env: x.env, otel: x.otel, settings: () => ({ config: x.config }), run, ready: async () => null, now: () => ticks, sleep: async (ms) => { ticks += ms; } };
  const r = await launch(["--kind", "claude", "--name", "fixture", "--model", "sonnet", "--direction", "right", "--task", task, "--advice", advice], opts);
  expect(r.state).toBe("prompted");
  const s = x.spans().find((s) => s.name === "routr launch"), a = attrs(s);
  expect(a).toMatchObject({ "routr.kind": "claude", "routr.backend": "pane", "routr.launch.state": "prompted", "gen_ai.agent.name": "fixture", "routr.model": "sonnet", "routr.advice.matched": true, "gen_ai.conversation.id": session, "routr.lead.session_id": x.env.CODEX_THREAD_ID, "routr.cwd": "." });
  expect(a).not.toHaveProperty("gen_ai.request.model");
  const index = new LaunchIndex({ home: x.home }), entry = index.match({ advice_id: "abc12345" });
  expect(entry).toMatchObject({ traceId: s.traceId, spanId: s.spanId, pane_id: "w1:p2", terminal_id: "term-1", launch_id: a["routr.launch.id"] });
  const rerun = await launch(["--kind", "claude", "--name", "fixture", "--model", "sonnet", "--pane", "w1:p2", "--task", task, "--advice", advice], opts);
  expect(rerun.state).toBe("prompted");
  expect(index.entries()).toHaveLength(1);
  expect(index.match({ advice_id: "abc12345" }).spanId).toBe(s.spanId);
  expect((await cleanup(["--pane", "w1:p2"], opts)).state).toBe("closed");
  const c = x.spans().find((s) => s.name === "routr cleanup");
  expect(c.links).toContainEqual({ traceId: s.traceId, spanId: s.spanId, attributes: [] });
  expect(attrs(c)["gen_ai.conversation.id"]).toBe(session);
  expect(index.match({ advice_id: "abc12345" }).finished_at).toBeDefined();
  recordCommand({ advice, ledger: join(x.home, "ledger.jsonl"), subscription: "claude", model: "sonnet", effort: "low", verdict: "done", check: "pass" }, [], x.config, { env: {}, otel: x.otel });
  expect(x.spans().find((s) => s.name === "routr record").links).toEqual(c.links);
});

test("the real CLI consumes --lead-session independently of the brief and queues under --config", () => {
  const x = exporting(), id = "019a1aaa-1234-7123-8123-123456789abc";
  writeFileSync(join(x.home, ".cache/routr/otel/sender.lock"), JSON.stringify({ pid: process.pid, token: "fixture" }));
  const env = cliEnv(x.home, { PATH: x.home, CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "", CURSOR_CONVERSATION_ID: "", ANTIGRAVITY_CONVERSATION_ID: "", OTEL_SDK_DISABLED: "false", ROUTR_OTEL: "1" });
  const r = Bun.spawnSync([process.execPath, SCRIPT, "dispatch", "--config", x.otel.configPath, "--lead-session", id, "BRIEF_MARKER"], { env });
  const result = JSON.parse(r.stdout.toString());
  expect(result.ok).toBe(true); expect(result.brief_chars).toBe(12);
  expect(x.spans().find((s) => s.name === "routr dispatch")).toBeDefined();
  expect(attrs(x.spans().find((s) => s.name === "routr dispatch"))["routr.lead.session_id"]).toBe(id);
});

test("every command's complete queue files exclude all content and secret markers", async () => {
  const markers = ["PRIVATE_BRIEF_MARKER", "PRIVATE_KEY_MARKER", "PRIVATE_HEADER_MARKER", "PRIVATE_BAGGAGE_MARKER", "PRIVATE_NOTE_MARKER", "PRIVATE_SCREEN_MARKER", "PRIVATE_REPLY_MARKER"];
  const x = exporting({ TRACEPARENT: parent, BAGGAGE: markers[3], TRACESTATE: "vendor=" + markers[2] }), brief = join(x.home, "brief"), report = join(x.home, "report"), advice = join(x.home, "advice.json");
  writeFileSync(brief, markers[0]); writeFileSync(report, markers[4]);
  writeFileSync(advice, JSON.stringify({ id: "abc12345", brief_sha: briefSha(markers[0]), mode: "dispatch", level: "standard" }));
  writeFileSync(join(x.home, ".config-headers"), `Authorization=${markers[2]}`);
  const opts = { env: x.env, otel: x.otel, settings: () => ({ config: x.config }), read: async () => [], askFn: (state, questions, o) => ask(state, questions, { ...o, env: { TYPESAFE_API_KEY: markers[1] }, fetchFn: replyFetch("typesafe", "valid") }) };
  await adviseCommand("dispatch", markers[0], { config: x.config }, {}, opts);
  await adviseCommand("subagent", markers[0], { config: x.config }, {}, opts);
  await checkCommand({ brief, report }, { ...opts, config: x.config });
  await usageCommand([], x.config, {}, opts);
  recordCommand({ advice, ledger: join(x.home, "ledger"), subscription: markers[1], model: markers[6], effort: markers[2], verdict: markers[4], check: markers[4], note: markers[4] }, [], x.config, opts);
  let tick = 0;
  await launch(["--kind", "claude", "--name", "fixture", "--model", markers[6], "--direction", "right"], { ...opts, env: { ...x.env, HERDR_ENV: "1" }, ready: async () => null, now: () => tick, sleep: async (ms) => { tick += ms; }, run: async (a) => ({ ok: true, data: { result: a[1] === "split" ? { pane: { pane_id: "w1:p2" } } : a[1] === "read" ? { text: markers[5] + "\nSource it? [y/N]" } : a[1] === "process-info" ? { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } } : a[1] === "get" ? { pane: { pane_id: "w1:p2", terminal_id: "term-1" } } : {} } }) });
  await sendCommand(["--task", markers[0]], opts); await waitCommand(["--timeout", "0"], opts); await workersCommand([], opts); await stopCommand([], opts); await cleanup(["--unknown"], opts);
  const names = x.spans().map((s) => s.name);
  for (const command of ["dispatch", "subagent", "check", "usage", "record", "launch", "send", "wait", "workers", "stop", "cleanup"]) expect(names).toContain(`routr ${command}`);
  for (const batch of x.batches()) for (const marker of markers) expect(JSON.stringify(batch)).not.toContain(marker);
});

test("the published attribute names and types and error codes equal the shipped allow-lists in both directions", () => {
  const doc = readFileSync(new URL("../docs/opentelemetry.md", import.meta.url), "utf8");
  const fields = Object.fromEntries([...doc.matchAll(/^\| `([^`]+)` \| `(string\[\]|string|boolean|int|double)` \|/gm)].map((m) => [m[1], m[2]]));
  expect(fields).toEqual({ ...OTEL_RESOURCE_ATTRIBUTES, ...TRACE_ATTRIBUTES });
  const errors = doc.match(/<!-- span-errors -->\s*([^]*?)\s*<!-- \/span-errors -->/)?.[1].match(/`[^`]+`/g)?.map((s) => s.slice(1, -1));
  expect(errors?.sort()).toEqual([...ERROR_CODES].sort());
});

const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
test("W3C parents are version-aware, lowercase, nonzero and sampled by the low flag bit", () => {
  expect(parseTraceparent(parent)).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true });
  expect(parseTraceparent(parent.replace(/^00/, "01") + "-future")).toEqual(parseTraceparent(parent));
  expect(parseTraceparent(parent.replace(/01$/, "02"))?.sampled).toBe(false);
  for (const value of [undefined, "", parent.toUpperCase(), parent + "-extra", parent.replace(/^00/, "ff"), parent.replace(/4bf9.*-00f0/, "00000000000000000000000000000000-00f0"), parent.replace("00f067aa0ba902b7", "0000000000000000"), parent.slice(0, -1), " " + parent, parent.replace(/^00/, "01") + "x"])
    expect(parseTraceparent(value)).toBeNull();
});

test("lead ids use the measured harness formats before a strict explicit fallback, never an invented id", () => {
  const v7 = "019a1aaa-1234-7123-8123-123456789abc", v4 = "12345678-1234-4123-8123-123456789abc";
  expect(leadSession({ CODEX_THREAD_ID: v7 }, "a123456789abcdef")).toBe(v7);
  expect(leadSession({ CODEX_THREAD_ID: v4 }, "a123456789abcdef")).toBe("a123456789abcdef");
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CURSOR_CONVERSATION_ID", "ANTIGRAVITY_CONVERSATION_ID"]) expect(leadSession({ [key]: v4 })).toBe(v4);
  for (const value of [undefined, "a note with spaces", "/a/path", "sk-secret", "https://host", "x".repeat(129)]) expect(leadSession({}, value)).toBeNull();
  expect(leadSession({ KIRO_SESSION_ID: v4 })).toBeNull();
});
