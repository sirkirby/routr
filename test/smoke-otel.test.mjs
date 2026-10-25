import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeTraces } from "../src/lib/otel.mjs";
import { checkPaneTrace, checkHeadlessTrace, paneFixtureDeps, checkSmokeTraces, fixtureHarness, fixturePaneRun, smokeOtel, smokeParent, guardSmoke, SMOKE_ACTIVE, smokeProcessRows, smokeProcessesIn, teardownSmoke } from "../scripts/smoke-otel.mjs";

const span = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "1234567890abcdef", parentSpanId: "00f067aa0ba902b7", flags: 1, name: "routr usage", kind: 1, startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: {} };
const batch = (s = span) => encodeTraces([s], { schemaUrl: "https://opentelemetry.io/schemas/1.44.0" });
test("smoke refuses any arguments and inherited markers before invoking its runner", async () => {
  let called = 0; const log = [], run = async () => { called++; return 0; };
  for (const args of [["--otel-sender"], ["--help"], ["anything"]]) expect(await guardSmoke(run, { args, env: {}, log: (s) => log.push(s) })).toBe(1);
  for (const value of ["1", "", "0"]) expect(await guardSmoke(run, { args: [], env: { [SMOKE_ACTIVE]: value }, log: (s) => log.push(s) })).toBe(1);
  expect(called).toBe(0); expect(log).toHaveLength(6);
  expect(await smokeOtel({ args: ["--otel-sender"], env: {}, log: () => {} }, { run })).toBe(1);
  expect(called).toBe(0);
  expect(await smokeOtel({ args: [], env: {}, log: () => {} }, { run })).toBe(0);
  expect(called).toBe(1);
});
test("smoke marks its own process and children, refuses nested entry, and restores the marker after failure", async () => {
  const prior = process.env[SMOKE_ACTIVE], log = [], env = {};
  try {
    delete process.env[SMOKE_ACTIVE];
    const code = await guardSmoke(async ({ env: childEnv }) => {
      expect(process.env[SMOKE_ACTIVE]).toBe("1"); expect(childEnv[SMOKE_ACTIVE]).toBe("1");
      return guardSmoke(() => { throw new Error("nested smoke ran"); }, { args: [], env: {}, log: (s) => log.push(s) });
    }, { args: [], env, log: (s) => log.push(s) });
    expect(code).toBe(1); expect(process.env[SMOKE_ACTIVE]).toBeUndefined(); expect(env).toEqual({});
    expect(await guardSmoke(async () => { throw new Error("fixture failure"); }, { args: [], env, log: (s) => log.push(s) })).toBe(1);
    expect(process.env[SMOKE_ACTIVE]).toBeUndefined();
  } finally { if (prior == null) delete process.env[SMOKE_ACTIVE]; else process.env[SMOKE_ACTIVE] = prior; }
});
test("smoke's decoder verifies wire types, parentage, links, counts, duplicates and all never-sent content", () => {
  const opts = { counts: { "routr usage": 1 }, parent: smokeParent, markers: ["PRIVATE_MARKER"] };
  expect(checkSmokeTraces([batch()], opts).unique).toBe(1);
  expect(checkSmokeTraces([batch(), batch()], opts).duplicates).toBe(1);
  for (const change of [
    { attributes: { "invented.field": "x" } }, { attributes: { "routr.level": "PRIVATE_MARKER" } },
    { attributes: { "routr.attempts": "2" } }, { parentSpanId: "1111111111111111" },
    { links: [{ traceId: "a".repeat(32), spanId: "b".repeat(16) }] },
  ]) expect(() => checkSmokeTraces([batch({ ...span, ...change })], opts)).toThrow();
  expect(() => checkSmokeTraces([], opts)).toThrow();
});
test("the smoke entrypoint and its fixture parse without running herdr, a sender or any harness", () => {
  const syntax = new Bun.Transpiler({ loader: "js" });
  expect(() => syntax.transformSync(readFileSync(new URL("../scripts/smoke-otel.mjs", import.meta.url), "utf8"))).not.toThrow();
  expect(() => syntax.transformSync(fixtureHarness)).not.toThrow();
});

test("the pane smoke starts only its absolute fixture and accepts herdr's empty pane-run success", async () => {
  const calls = [], run = fixturePaneRun("/fixture path.mjs", { runtime: "/bun path", shell: "posix", cwd: "/fixture-home", run: async (args) => { calls.push(args); return { ok: true, data: "" }; } });
  expect(await run(["agent", "start", "worker", "--kind", "claude", "--pane", "w1:p2", "--", "--model", "unused"])).toEqual({ ok: true, data: { result: {} } });
  expect(calls).toEqual([["pane", "run", "w1:p2", "'/bun path' '/fixture path.mjs'"]]);
  expect((await run(["agent", "get", "w1:p2"])).data.result.agent.agent_status).toBe("idle");
});

test("the pane smoke owns a split immediately and permits only one creation attempt", async () => {
  const calls = [], owned = [], run = fixturePaneRun("/fixture.mjs", { onPane: (p) => owned.push(p), run: async (args) => {
    calls.push(args); return { ok: true, data: { result: { pane: { pane_id: "w1:p2" } } } };
  } });
  await run(["pane", "split", "--direction", "right"]);
  expect(owned).toEqual(["w1:p2"]);
  await expect(run(["pane", "split", "--direction", "right"])).rejects.toThrow("one pane");
  for (const args of [["worktree", "create"], ["workspace", "create"], ["tab", "create"]]) await expect(run(args)).rejects.toThrow("one pane");
  expect(calls).toHaveLength(1);
  const failedCalls = [], failed = fixturePaneRun("/fixture.mjs", { run: async (a) => { failedCalls.push(a); throw new Error("split's reply lost"); } });
  await expect(failed(["pane", "split"])).rejects.toThrow("reply lost");
  await expect(failed(["pane", "split"])).rejects.toThrow("one pane");
  expect(failedCalls).toHaveLength(1);
});

test("smoke inventory matches the exact home, including Windows paths, and rejects incomplete listings", () => {
  // This fixture is ps output, even when CI runs on Windows and the default parser expects CIM JSON.
  const rows = smokeProcessRows(' 10 1 /bun /repo/routr.mjs --otel-sender --config /tmp/ro-one/config.json\n 11 1 /bun /tmp/ro-one/routr.mjs workers --hold fixture\n 12 1 /bun /tmp/ro-one-more/routr.mjs workers --hold fixture\n', "linux");
  expect(smokeProcessesIn(rows, "/tmp/ro-one", { platform: "linux" }).map((r) => r.pid)).toEqual([10, 11]);
  expect(smokeProcessRows("10 1 valid\ntruncated", "linux")).toBeNull();
  const win = smokeProcessRows(JSON.stringify([{ ProcessId: 20, ParentProcessId: 1, CommandLine: 'bun.exe routr.mjs --otel-sender --config "C:\\Temp Dir\\RO-one\\config.json"' }]), "win32");
  expect(smokeProcessesIn(win, "c:\\temp dir\\ro-one", { platform: "win32" }).map((r) => r.pid)).toEqual([20]);
  expect(smokeProcessesIn(win, "c:\\temp dir\\ro", { platform: "win32" })).toEqual([]);
  expect(smokeProcessRows("not json", "win32")).toBeNull();
});

test("failure teardown closes the owned pane, stops children and workers, kills owned processes, then verifies absence", async () => {
  let rows = [{ pid: 10, ppid: 1, command: "bun routr.mjs --otel-sender --config /tmp/ro-one/config.json" }, { pid: 11, ppid: 1, command: "bun /tmp/ro-one/routr.mjs workers --hold fixture" }, { pid: 12, ppid: 1, command: `"${process.execPath}" /tmp/ro-one/bin/fixture.mjs` }, { pid: 98, ppid: 1, command: "cat /tmp/ro-one/config.json" }, { pid: 99, ppid: 1, command: "bun /tmp/ro-other/routr.mjs --otel-sender" }];
  const killed = [], closed = [], child = { pid: 40, exitCode: null, signalCode: null }; let stopped = 0, listed = 0;
  const errors = await teardownSmoke({ home: "/tmp/ro-one", children: new Set([child]), pane: "w1:p2", closePane: async (p) => { closed.push(p); return { ok: true }; }, stopWorker: async () => { stopped++; } }, {
    list: async () => { listed++; return rows; }, kill: (pid) => { killed.push(pid); rows = rows.filter((r) => r.pid !== pid); }, stopChild: (c) => { c.exitCode = 0; }, pause: async () => {}, attempts: 2,
  });
  expect(errors).toEqual([]); expect(closed).toEqual(["w1:p2"]); expect(stopped).toBe(1); expect(killed).toEqual([10, 11, 12]); expect(listed).toBeGreaterThanOrEqual(2);
});

test("teardown fails on survivors, unreadable process state or a pane it cannot close", async () => {
  const row = { pid: 10, ppid: 1, command: "bun routr.mjs --otel-sender --config /tmp/ro-one/config.json" };
  expect(await teardownSmoke({ home: "/tmp/ro-one" }, { list: async () => [row], kill: () => {}, pause: async () => {}, attempts: 1 })).not.toEqual([]);
  expect(await teardownSmoke({ home: "/tmp/ro-one" }, { list: async () => null })).not.toEqual([]);
  expect(await teardownSmoke({ home: "/tmp/ro-one", pane: "w1:p2", closePane: async () => ({ ok: false }) }, { list: async () => [] })).not.toEqual([]);
  // Holders normally name their home only in the environment: their own claim pids are checked too, without killing a reused pid.
  const holder = { pid: 30, ppid: 1, command: "bun /repo/routr.mjs workers --hold fixture" }, killed = [];
  expect(await teardownSmoke({ home: "/tmp/ro-one", holderPids: new Set([30]) }, { list: async () => [holder], kill: (pid) => killed.push(pid), pause: async () => {}, attempts: 1 })).not.toEqual([]);
  expect(killed).toEqual([]);
  expect(await teardownSmoke({ home: "/tmp/ro-one", holderPids: new Set([30]) }, { list: async () => [{ ...holder, command: "unrelated process" }] })).toEqual([]);
  expect(await teardownSmoke({ home: "/tmp/ro-one", senderPids: new Set([31]) }, { list: async () => [{ pid: 31, ppid: 1, command: "" }], pause: async () => {}, attempts: 1 })).not.toEqual([]);
});

test("the pane smoke bypasses installed model probes and captures the one split's arguments", async () => {
  const split = ["pane", "split", "--env", `TRACEPARENT=${smokeParent}`], captured = [];
  const deps = paneFixtureDeps("/fixture.mjs", { cwd: "/fixture-home", config: {}, env: {}, onSplit: (a) => captured.push(a), run: async () => ({ ok: true, data: { result: { pane: { pane_id: "w1:p2" } } } }) });
  expect(await deps.models()).toBeNull(); expect(await deps.ready()).toBeNull();
  await deps.run(split); split.push("changed");
  expect(captured).toEqual([["pane", "split", "--env", `TRACEPARENT=${smokeParent}`]]);
});

test("the pane smoke verifies its generated launch carrier and cleanup link", () => {
  const launched = { ...span, name: "routr launch", attributes: [{ key: "gen_ai.agent.name", value: { stringValue: "pane-fixture" } }] };
  const cleaned = { ...span, spanId: "f".repeat(16), name: "routr cleanup", links: [{ traceId: span.traceId, spanId: span.spanId }] };
  const split = ["pane", "split", "--env", `TRACEPARENT=00-${span.traceId}-${span.spanId}-01`];
  expect(() => checkPaneTrace([launched, cleaned], split)).not.toThrow();
  expect(() => checkPaneTrace([launched, cleaned], ["pane", "split", "--env", `TRACEPARENT=${smokeParent}`])).toThrow();
  expect(() => checkPaneTrace([launched, { ...cleaned, links: [] }], split)).toThrow();
  expect(() => checkPaneTrace([cleaned], split)).toThrow();
});

test("the smoke checks both invoke_agent turns under the launch and the carrier of each fixture process", () => {
  const attr = (key, value) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } });
  const launched = { ...span, name: "routr launch", attributes: [attr("gen_ai.agent.name", "fixture")] };
  const turns = [1, 2].map((n) => ({ ...span, name: "invoke_agent fixture", kind: 3, spanId: String(n).repeat(16), parentSpanId: span.spanId,
    attributes: [attr("gen_ai.operation.name", "invoke_agent"), attr("gen_ai.provider.name", "anthropic"), attr("gen_ai.agent.name", "fixture"), attr("routr.turn", n), attr("routr.turn.outcome", "finished"), attr("routr.turn.messages", 1)] }));
  const carriers = [{ TRACEPARENT: `00-${span.traceId}-${span.spanId}-01` }, { TRACEPARENT: `00-${span.traceId}-${turns[1].spanId}-01` }];
  expect(() => checkHeadlessTrace([launched, ...turns], carriers)).not.toThrow();
  expect(() => checkHeadlessTrace([launched, ...turns], [carriers[0], carriers[0]])).toThrow();
  expect(() => checkHeadlessTrace([launched, turns[0]], carriers)).toThrow();
  expect(() => checkHeadlessTrace([launched, turns[0], { ...turns[1], parentSpanId: "a".repeat(16) }], carriers)).toThrow();
  const body = encodeTraces([span, { ...turns[0], attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "fixture", "routr.turn": 1 } }], { schemaUrl: "https://opentelemetry.io/schemas/1.44.0" });
  expect(() => checkSmokeTraces([body], { counts: { "invoke_agent fixture": 1 } })).not.toThrow();
});

import * as smoke from "../scripts/smoke-otel.mjs";
import { encodeLogs, encodeHeadroom } from "../src/lib/otel.mjs";
test("smoke decodes correlated empty-body log events and the install headroom Gauge, rejecting wrong mappings and content", () => {
  const log = encodeLogs([{ ...span, timeUnixNano: "2", eventName: "routr.warning", severityNumber: 13, severityText: "WARN", attributes: { "routr.warning.code": "prompt_uncertain" } }], { schemaUrl: "https://opentelemetry.io/schemas/1.44.0" });
  const metric = encodeHeadroom([{ subscription: "claude", window: "five_hour", value: 0.75, time: 1700000000000 }], { resource: { "service.name": "routr", "service.instance.id": "7d27dd02-0951-5268-b356-413ed1cf4b75" }, schemaUrl: "https://opentelemetry.io/schemas/1.44.0" });
  const opts = { spans: [span], markers: ["PRIVATE_MARKER"] };
  expect(smoke.checkSmokeSignals([log, metric], opts)).toEqual({ logs: 1, points: 1 });
  const badLog = (change) => { const b = structuredClone(log); Object.assign(b.resourceLogs[0].scopeLogs[0].logRecords[0], change); return b; };
  for (const b of [badLog({ eventName: undefined, attributes: [{ key: "event.name", value: { stringValue: "routr.warning" } }] }), badLog({ severityNumber: 9 }), badLog({ observedTimeUnixNano: "3" }), badLog({ flags: 0 }), badLog({ body: { stringValue: "PRIVATE_MARKER" } }), badLog({ spanId: "f".repeat(16) }), badLog({ attributes: [{ key: "routr.warning.code", value: { stringValue: "PRIVATE_MARKER" } }] })]) expect(() => smoke.checkSmokeSignals([b, metric], opts)).toThrow();
  for (const change of [{ asDouble: 2 }, { asDouble: undefined, asInt: "1" }, { timeUnixNano: 1700000000000000000 }]) {
    const b = structuredClone(metric); Object.assign(b.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0], change);
    expect(() => smoke.checkSmokeSignals([log, b], opts)).toThrow();
  }
});

test("smoke checks each event's fixed code vocabulary, not just its string wire type", () => {
  for (const [eventName, severityNumber, severityText, attributes] of [
    ["routr.needs_input", 13, "WARN", { "routr.needs_input.why": "arbitrary" }],
    ["routr.usage.failed", 13, "WARN", { "error.type": "arbitrary", "routr.subscription": "claude" }],
    ["routr.worker.state", 9, "INFO", { "routr.worker.state.from": "arbitrary", "routr.worker.state.to": "working" }],
  ]) {
    const body = encodeLogs([{ ...span, timeUnixNano: "2", eventName, severityNumber, severityText, attributes }], { schemaUrl: "https://opentelemetry.io/schemas/1.44.0" });
    expect(() => smoke.checkSmokeSignals([body], { spans: [span] })).toThrow();
  }
});
