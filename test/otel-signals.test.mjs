import { expect, test } from "bun:test";
import * as otel from "../src/lib/otel.mjs";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ids, install, points, receiver } from "./fixtures/otel-signals.mjs";

import { commandTrace, usageSpans } from "../src/lib/traces.mjs";
import { summarize } from "../src/lib/usage.mjs";
import { withBilling } from "../src/lib/harnesses.mjs";
test("commands queue only fresh numeric windows with the original reading time and exact observation fields", async () => {
  const f = install("http://127.0.0.1:4318"), fresh = summarize({ pool: "claude", source: "statusline", ts: 1700000000, nowSec: 1700000001, windows: [{ name: "five_hour", usedPct: 25 }, { name: "PRIVATE_WINDOW_MARKER", usedPct: 10 }], note: "PRIVATE_NOTE_MARKER" });
  await commandTrace("usage", { config: f.config, env: {}, otel: f.opts }, () => usageSpans(async () => [
    withBilling("claude", fresh, { billing: "metered", why: "PRIVATE_BILLING_MARKER" }),
    { ...fresh, kept: { source: "statusline" } }, { ...fresh, given: true },
    summarize({ pool: "codex", source: "app-server", ts: 1700000001, cls: "metered" }),
    summarize({ pool: "cursor", source: "none" }),
  ]));
  const files = readdirSync(join(f.root, "metrics")); expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.root, "metrics", files[0])))).toEqual({ subscription: "claude", window: "five_hour", value: 0.75, time: 1700000000000 });
});

import * as warnings from "../src/lib/warnings.mjs";
test("every emitted warning keeps its text for the caller but has a fixed origin code for export", async () => {
  const f = install("http://127.0.0.1:4318");
  await commandTrace("launch", { config: f.config, env: {}, otel: f.opts }, () => ({ ok: true, warnings: [warnings.warning("prompt_uncertain", "PRIVATE_WARNING_MARKER"), "PRIVATE_UNKNOWN_MARKER"] }));
  const batches = readdirSync(join(f.root, "logs")).map((n) => JSON.parse(readFileSync(join(f.root, "logs", n))));
  expect(batches).toHaveLength(1);
  const log = batches[0].resourceLogs[0].scopeLogs[0].logRecords[0];
  expect(log).toMatchObject({ eventName: "routr.warning", severityNumber: 13, severityText: "WARN", attributes: expect.arrayContaining([{ key: "routr.warning.code", value: { stringValue: "prompt_uncertain" } }]) });
  expect(JSON.stringify(batches)).not.toContain("PRIVATE_");
  const span = JSON.parse(readFileSync(join(f.root, "traces", readdirSync(join(f.root, "traces"))[0]))).resourceSpans[0].scopeSpans[0].spans[0];
  expect(log.traceId).toBe(span.traceId); expect(log.spanId).toBe(span.spanId);
  expect(log.flags).toBe(span.flags); expect(log.observedTimeUnixNano).toBe(log.timeUnixNano);
});

import { failedUsage } from "../src/lib/usage.mjs";
import { launch } from "../src/lib/launch.mjs";
const logsIn = (f) => readdirSync(join(f.root, "logs")).sort().flatMap((n) => JSON.parse(readFileSync(join(f.root, "logs", n))).resourceLogs[0].scopeLogs[0].logRecords);
const spansIn = (f) => readdirSync(join(f.root, "traces")).flatMap((n) => JSON.parse(readFileSync(join(f.root, "traces", n))).resourceSpans[0].scopeSpans[0].spans);
const attrs = (r) => Object.fromEntries(r.attributes.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]));
test("usage failure logs correlate with their usage child, including a recovered kept reading", async () => {
  const f = install("http://127.0.0.1:4318");
  await commandTrace("usage", { config: f.config, env: {}, otel: f.opts }, () => usageSpans(async () => [failedUsage("codex", "app-server", "invalid_response"), { ...failedUsage("claude", "statusline", "PRIVATE_FAILURE_MARKER"), headroom: 0.5, kept: {} }]));
  const logs = logsIn(f); expect(logs).toHaveLength(2);
  expect(logs.map(attrs)).toEqual([expect.objectContaining({ "error.type": "invalid_response", "routr.subscription": "codex" }), expect.objectContaining({ "error.type": "read_failed", "routr.subscription": "claude" })]);
  for (const log of logs) { expect(log.eventName).toBe("routr.usage.failed"); expect(spansIn(f).find((s) => s.spanId === log.spanId)?.name).toBe(`routr usage ${attrs(log)["routr.subscription"]}`); }
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
});
test("a launch needing shell input logs only a fixed why code with its completed launch identity", async () => {
  const f = install("http://127.0.0.1:4318"); let time = 0;
  const r = await launch(["--kind", "claude", "--name", "fixture", "--model", "fixture", "--direction", "right"], { env: { HERDR_ENV: "1" }, otel: f.opts, settings: () => ({ config: f.config }), ready: async () => null, models: async () => null, now: () => time, sleep: async (ms) => { time += ms; }, run: async (a) => {
    const ok = (result) => ({ ok: true, data: { result } });
    if (a[1] === "split") return ok({ pane: { pane_id: "w1:p2" } });
    if (a[1] === "read") return ok({ text: "PRIVATE_SHELL_MARKER Source it? [y/N]" });
    if (a[1] === "process-info") return ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } });
    return ok({});
  } });
  expect(r.state).toBe("needs_input");
  const log = logsIn(f).find((l) => l.eventName === "routr.needs_input");
  expect(log).toBeDefined(); expect(attrs(log)).toMatchObject({ "routr.needs_input.why": "shell_not_ready", "gen_ai.agent.name": "fixture", "routr.kind": "claude" });
  expect(log.spanId).toBe(spansIn(f)[0].spanId); expect(JSON.stringify(logsIn(f))).not.toContain("PRIVATE_");
});

import { Glob } from "bun";
test("warning code names in shipped source match the single stable table", () => {
  const calls = new Set();
  for (const file of new Glob("src/**/*.mjs").scanSync({ cwd: join(import.meta.dir, "..") })) {
    const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
    for (const match of text.matchAll(/\bwarning\("([a-z_]+)"/g)) { expect(warnings.WARNING_CODES).toHaveProperty(match[1]); calls.add(match[1]); }
  }
  expect([...calls].sort()).toEqual(Object.keys(warnings.WARNING_CODES).sort());
});

import { workerTurn } from "../src/lib/traces.mjs";
test("holder transitions are INFO events on the finished turn, with fresh consent and idempotent completion", () => {
  const f = install("http://127.0.0.1:4318"), worker = { name: "fixture", kind: "claude", cwd: f.opts.home, model: "sonnet" };
  const turn = workerTurn(worker, 1, { env: {}, otel: f.opts });
  turn.state("idle", "working"); turn.state("working", "waiting");
  expect(logsIn(f)).toEqual([]); // finished-turn batch only
  turn.end("finished", 1, "12345678-1234-4123-8123-123456789abc"); turn.end("failed", 9);
  turn.state("waiting", "idle"); turn.state("PRIVATE_STATE_MARKER", "idle");
  const logs = logsIn(f); expect(logs).toHaveLength(3);
  expect(logs.map((l) => [attrs(l)["routr.worker.state.from"], attrs(l)["routr.worker.state.to"]])).toEqual([["idle", "working"], ["working", "waiting"], ["waiting", "idle"]]);
  for (const log of logs) {
    expect(log).toMatchObject({ eventName: "routr.worker.state", severityNumber: 9, severityText: "INFO", traceId: spansIn(f)[0].traceId, spanId: spansIn(f)[0].spanId });
    expect(log.observedTimeUnixNano).toBe(log.timeUnixNano); expect(log.flags).toBe(spansIn(f)[0].flags);
    expect(attrs(log)).toMatchObject({ "routr.turn": 1, "routr.kind": "claude", "gen_ai.agent.name": "fixture", "gen_ai.conversation.id": "12345678-1234-4123-8123-123456789abc" });
  }
  const revoked = workerTurn(worker, 2, { env: {}, otel: f.opts }); revoked.state("idle", "working");
  writeFileSync(f.opts.configPath, "{}"); revoked.end("finished", 1); revoked.state("working", "idle");
  expect(logsIn(f)).toHaveLength(3); expect(spansIn(f)).toHaveLength(1);
});

import { existsSync, rmSync } from "node:fs";
import { cliEnv, SCRIPT } from "./helpers.mjs";
test("logs and gauge claims recover a killed sender before POST and after acknowledgement", async () => {
  await receiver(async (endpoint, requests) => {
    for (const signal of ["logs", "metrics"]) {
      const f = install(endpoint), before = requests.length;
      f.queue.queue(signal, signal === "logs" ? otel.encodeLogs([{ ...ids, eventName: "routr.warning", severityNumber: 13, severityText: "WARN", timeUnixNano: "1", attributes: {} }]) : { subscription: "claude", window: "five_hour", time: 1000, value: 0.5 });
      const die = async (mode) => {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/otel-child.mjs"), mode], { env: cliEnv(f.opts.home), stdout: "ignore", stderr: "pipe" });
        expect(await child.exited).not.toBe(0);
      };
      await die("die-before"); expect(requests).toHaveLength(before); expect(otel.otelStatus(f.config, {}, f.opts).queued_files).toBe(1);
      await die("die-after"); expect(requests).toHaveLength(before + 1);
      expect(readdirSync(join(f.root, signal))[0]).toEndWith(".sending");
      await otel.sendOtel(f.opts);
      expect(requests).toHaveLength(before + (signal === "metrics" ? 1 : 2));
      if (signal === "logs") expect(requests.at(-1).body).toEqual(requests.at(-2).body);
      expect(readdirSync(join(f.root, signal))).toEqual([]);
    }
  });
});

test("all three signals obey consent, caps, status and uninstall folder ownership", async () => {
  await receiver(async (endpoint, requests) => {
    const f = install(endpoint);
    for (const signal of ["traces", "logs", "metrics"]) f.queue.queue(signal, { marker: "only-local" });
    expect(otel.otelStatus(f.config, {}, f.opts).queued_files).toBe(3);
    writeFileSync(f.opts.configPath, "{}"); await otel.sendOtel(f.opts);
    expect(requests).toEqual([]); expect(otel.otelStatus({}, {}, f.opts)).toMatchObject({ queued_files: 0, dropped_by_code: { consent: 3 } });
    writeFileSync(f.opts.configPath, JSON.stringify(f.config));
    for (const signal of ["logs", "metrics"]) {
      f.queue.queue(signal, { marker: "only-local" }); await otel.sendOtel({ ...f.opts, capBytes: 1 });
      expect(readdirSync(join(f.root, signal))).toEqual([]);
    }
    expect(otel.otelStatus(f.config, {}, f.opts).dropped_by_code.cap).toBe(2);
    rmSync(f.root, { recursive: true });
    f.queue.queue("logs", {}); f.queue.queue("metrics", {}); await otel.sendOtel(f.opts);
    expect(existsSync(f.root)).toBe(false);
  });
});

test("off and statusline write no signal files, and revoked command batches cannot write any signal", async () => {
  const f = install("http://127.0.0.1:4318");
  for (const config of [{}, f.config]) for (const env of [{ ROUTR_OTEL: "0" }, { OTEL_SDK_DISABLED: "true" }]) {
    await commandTrace("usage", { config, env, otel: f.opts }, () => usageSpans(async () => [failedUsage("codex", "app-server")]));
  }
  const home = f.opts.home, configPath = join(home, ".config/routr/config.json"); mkdirSync(join(home, ".config/routr"), { recursive: true }); writeFileSync(configPath, JSON.stringify(f.config));
  const result = Bun.spawnSync([process.execPath, SCRIPT, "statusline"], { env: cliEnv(home, { PATH: home }), stdin: Buffer.from('{"rate_limits":{"five_hour":{"used_percentage":25}}}') });
  expect(result.exitCode).toBe(0);
  for (const signal of ["traces", "logs", "metrics"]) expect(readdirSync(join(f.root, signal))).toEqual([]);
  await commandTrace("usage", { config: f.config, env: {}, otel: f.opts }, async () => { await usageSpans(async () => [failedUsage("codex", "app-server")]); writeFileSync(f.opts.configPath, "{}"); return { warnings: [warnings.warning("prompt_uncertain", "PRIVATE_MARKER")] }; });
  for (const signal of ["traces", "logs", "metrics"]) expect(readdirSync(join(f.root, signal))).toEqual([]);
});

test("invalid or unknown metric observations send no point, and extra content never enters the OTLP request", async () => {
  await receiver(async (endpoint, requests) => {
    const f = install(endpoint), observation = { subscription: "claude", window: "five_hour", value: 0.5, time: 1000 };
    for (const change of [{ value: null }, { value: "0.5" }, { value: 2 }, { time: null }, { window: "PRIVATE_WINDOW_MARKER" }, { subscription: "PRIVATE_SUB_MARKER" }]) f.queue.queue("metrics", { ...observation, ...change });
    await otel.sendOtel(f.opts); expect(requests).toEqual([]);
    expect(readdirSync(join(f.root, "metrics"))).toEqual([]);
    f.queue.queue("metrics", { ...observation, note: "PRIVATE_NOTE_MARKER", resource: "PRIVATE_PATH_MARKER" });
    await otel.sendOtel(f.opts); expect(points(requests)).toHaveLength(1); expect(JSON.stringify(requests)).not.toContain("PRIVATE_");
  });
});

test("event definitions and the warning table match the published schema exactly", () => {
  const doc = readFileSync(join(import.meta.dir, "../docs/opentelemetry.md"), "utf8");
  const codes = doc.split("<!-- warning-codes -->")[1].split("<!-- /warning-codes -->")[0];
  expect([...codes.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort()).toEqual(Object.keys(warnings.WARNING_CODES).sort());
  const events = doc.split("<!-- log-events -->")[1].split("<!-- /log-events -->")[0];
  expect([...events.matchAll(/^\| `(routr\.[a-z_.]+)` \|/gm)].map((m) => m[1]).sort()).toEqual(["routr.needs_input", "routr.usage.failed", "routr.warning", "routr.worker.state"]);
});

test("a still-live numeric reading remains an observation when its refresh fails without becoming kept", async () => {
  const f = install("http://127.0.0.1:4318"), row = summarize({ pool: "cursor", source: "cursor /usage", ts: 1700000000, nowSec: 1700000001, windows: [{ name: "included", usedPct: 40 }], failure: { code: "no_response" } });
  await commandTrace("usage", { config: f.config, env: {}, otel: f.opts }, () => usageSpans(async () => [row]));
  expect(readdirSync(join(f.root, "metrics"))).toHaveLength(1);
  expect(logsIn(f).map((l) => l.eventName)).toEqual(["routr.usage.failed"]);
});

import { adviseCommand, parseHeadroom } from "../src/lib/commands.mjs";
import { takeLeadSession } from "../src/lib/trace-context.mjs";
test("advice accepts input warnings before its batch ends, including a refused brief", async () => {
  for (const brief of ["task", ""]) {
    const f = install("http://127.0.0.1:4318"), input = [...parseHeadroom(["bad"]).notes, ...takeLeadSession(["--lead-session", "bad"]).warnings, warnings.warning("brief_flag", "--json was read as brief text")];
    const r = await adviseCommand("subagent", brief, { config: f.config }, {}, { env: {}, otel: f.opts, warnings: input, askFn: async () => { throw new Error("fixture offline"); } });
    expect(r.warnings).toEqual(input);
    expect(logsIn(f).filter((l) => l.eventName === "routr.warning").map((l) => attrs(l)["routr.warning.code"]).sort()).toEqual(["brief_flag", "headroom_ignored", "lead_session_ignored"]);
  }
});

test("unsampled commands queue live headroom with no traces or logs and still recheck consent", async () => {
  const f = install("http://127.0.0.1:4318"), row = summarize({ pool: "claude", source: "statusline", ts: 1700000000, nowSec: 1700000001, windows: [{ name: "five_hour", usedPct: 25 }] });
  const setup = { config: f.config, env: { TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00" }, otel: f.opts };
  await commandTrace("usage", setup, async () => { await usageSpans(async () => [row]); return { warnings: [warnings.warning("prompt_uncertain", "local only")] }; });
  expect(readdirSync(join(f.root, "metrics"))).toHaveLength(1); expect(spansIn(f)).toEqual([]); expect(logsIn(f)).toEqual([]);
  await commandTrace("usage", setup, async () => { await usageSpans(async () => [row]); writeFileSync(f.opts.configPath, "{}"); });
  expect(readdirSync(join(f.root, "metrics"))).toHaveLength(1);
});

test("summarized window resets are newer points at the reset, with other windows keeping the snapshot time", async () => {
  await receiver(async (endpoint, requests) => {
    const f = install(endpoint), snapshot = { pool: "claude", source: "statusline", ts: 1700000000, windows: [{ name: "five_hour", usedPct: 90, resetsAt: 1700003600 }, { name: "seven_day", usedPct: 50, resetsAt: 1700600000 }] };
    const observe = (nowSec) => commandTrace("usage", { config: f.config, env: {}, otel: f.opts }, () => usageSpans(async () => [summarize({ ...snapshot, nowSec })]));
    await observe(1700000001); await otel.sendOtel(f.opts);
    expect(points(requests)).toHaveLength(2);
    await observe(1700007200); await otel.sendOtel(f.opts);
    expect(points(requests)).toHaveLength(3);
    expect(points(requests).at(-1)).toMatchObject({ asDouble: 1, timeUnixNano: "1700003600000000000" });
    expect(points(requests).at(-1).attributes).toContainEqual({ key: "routr.usage.window", value: { stringValue: "five_hour" } });
    await observe(1700007300); await otel.sendOtel(f.opts); expect(points(requests)).toHaveLength(3);
  });
});

test("CLI input notes become warning records once, for every accepting command and brief form", () => {
  for (const command of ["check", "usage", "dispatch", "subagent"]) for (const form of ["inline", "file"]) {
    if (!["dispatch", "subagent"].includes(command) && form === "file") continue;
    const f = install("http://127.0.0.1:4318"), home = f.opts.home, file = join(home, "task.txt");
    mkdirSync(join(home, ".config/routr"), { recursive: true }); writeFileSync(join(home, ".config/routr/config.json"), JSON.stringify({ ...f.config, subscriptions: {}, auto_update: false }));
    writeFileSync(join(f.root, "sender.lock"), JSON.stringify({ pid: process.pid, token: "fixture" })); writeFileSync(file, "safe task");
    const brief = ["dispatch", "subagent"].includes(command) ? form === "file" ? ["--task-file", file, "--lead-session", "invalid"] : ["safe task", "--json"] : [];
    const child = Bun.spawnSync([process.execPath, SCRIPT, command, "--headroom", "bad", ...brief], { env: cliEnv(home, { PATH: home, ROUTR_OTEL: "1", OTEL_SDK_DISABLED: "false", ROUTR_NO_UPDATE: "1" }), stdin: "ignore" });
    expect(child.exitCode).toBe(0);
    const output = JSON.parse(child.stdout.toString()), codes = logsIn(f).filter((l) => l.eventName === "routr.warning").map((l) => attrs(l)["routr.warning.code"]);
    expect(codes).toContain("headroom_ignored");
    if (brief.length) expect(codes).toContain(form === "file" ? "lead_session_ignored" : "brief_flag");
    expect(codes).toHaveLength(output.warnings.length);
  }
});

test("unknown windows create no command observation and are rejected from an existing queue", async () => {
  await receiver(async (endpoint, requests) => {
    const f = install(endpoint), row = summarize({ pool: "agy", source: "agy /usage", ts: 1700000000, nowSec: 1700000001, windows: [{ name: "unknown", usedPct: 10 }, { name: "unknown", usedPct: 50 }] });
    await commandTrace("usage", { config: f.config, env: {}, otel: f.opts }, () => usageSpans(async () => [row]));
    expect(readdirSync(join(f.root, "metrics"))).toEqual([]);
    f.queue.queue("metrics", { subscription: "agy", window: "unknown", value: 0.5, time: 1700000000000 });
    await otel.sendOtel(f.opts); expect(points(requests)).toEqual([]); expect(readdirSync(join(f.root, "metrics"))).toEqual([]);
  });
});

test("gauge identity failures report a fixed status before folding or claiming any observation", async () => {
  await receiver(async (endpoint, requests) => {
    for (const mode of ["missing", "malformed"]) {
      const f = install(endpoint), state = join(f.opts.home, ".local/state/routr");
      for (const time of [1000, 2000]) f.queue.queue("metrics", { subscription: "claude", window: "five_hour", value: 0.5, time });
      const before = readdirSync(join(f.root, "metrics")).sort();
      if (mode === "missing") rmSync(state, { recursive: true }); else writeFileSync(join(state, "service-instance-id"), "PRIVATE_BAD_ID_MARKER");
      await otel.sendOtel(f.opts); expect(requests).toEqual([]);
      expect(readdirSync(join(f.root, "metrics")).sort()).toEqual(before);
      expect(otel.otelStatus(f.config, {}, f.opts).last_export).toMatchObject({ ok: false, sent: 0, refused: 0, error: "gauge_identity_unavailable" });
      expect(readFileSync(join(f.root, "sender.json"), "utf8")).not.toContain("PRIVATE_");
      if (mode === "missing") mkdirSync(state, { recursive: true }); else rmSync(join(state, "service-instance-id"));
      await otel.sendOtel(f.opts); expect(requests).toHaveLength(1); requests.length = 0;
      expect(readdirSync(join(f.root, "metrics"))).toEqual([]);
    }
  });
});

test("an unsampled holder queues a supplied fresh subscription reading at turn completion, without logs or spans", () => {
  const f = install("http://127.0.0.1:4318"), worker = { name: "fixture", kind: "claude", cwd: f.opts.home, launch: { sampled: false }, carriers: { TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00" } };
  const row = summarize({ pool: "claude", source: "statusline", ts: 1700000000, nowSec: 1700000001, windows: [{ name: "five_hour", usedPct: 25 }] });
  const turn = workerTurn(worker, 1, { env: {}, otel: f.opts });
  turn.observeUsage(row); turn.state("idle", "working"); turn.end("finished", 1);
  expect(spansIn(f)).toEqual([]); expect(logsIn(f)).toEqual([]);
  expect(readdirSync(join(f.root, "metrics"))).toHaveLength(1);
  const revoked = workerTurn(worker, 2, { env: {}, otel: f.opts }); revoked.observeUsage(row); writeFileSync(f.opts.configPath, "{}"); revoked.end("finished", 1);
  expect(readdirSync(join(f.root, "metrics"))).toHaveLength(1);
});

import { readCodexLive } from "../src/lib/usage.mjs";
test("a live session-log fallback preserves the snapshot time when its app-server refresh fails", async () => {
  const f = install("http://127.0.0.1:4318"), saved = summarize({ pool: "codex", source: "session log", ts: 1700000000, nowSec: 1700000001, windows: [{ name: "primary", usedPct: 25 }] });
  const row = await readCodexLive({ exec: async () => null, fallback: () => saved, nowSec: 1700000001 });
  expect(row.kept).toBeUndefined();
  await commandTrace("usage", { config: f.config, env: {}, otel: f.opts }, () => usageSpans(async () => [row]));
  const files = readdirSync(join(f.root, "metrics")); expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.root, "metrics", files[0]))).time).toBe(1700000000000);
});
