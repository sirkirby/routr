import { expect, test } from "bun:test";
import * as otel from "../src/lib/otel.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliEnv, scratch, SCRIPT } from "./helpers.mjs";
import { ROUTR_VERSION } from "../src/lib/version.mjs";
import { writeJsonAtomic } from "../src/lib/runtime.mjs";
import { carryOut, uninstall } from "../src/lib/uninstall.mjs";
import { COMMANDS, formatCommandHelp } from "../src/lib/help.mjs";
import { briefSha, read as readLedger } from "../src/lib/ledger.mjs";
import { telemetryRows } from "../src/lib/telemetry.mjs";
import { loadConfig } from "../src/lib/config.mjs";
import { setup, showSettings } from "../src/lib/setup.mjs";
import { guided } from "../src/lib/setup-guided.mjs";
import { createServer } from "node:http";
import { writeSecrets } from "../src/lib/systemone.mjs";

async function receiver(handle) {
  const requests = [], server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    handle(req, res, requests.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}/prefix`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

function install(endpoint = "http://127.0.0.1:4318") {
  const home = scratch("otel"), configPath = join(home, "config.json");
  const config = { otel: { endpoint, consent: "1234567890abcdef1234567890abcdef" } };
  writeFileSync(configPath, JSON.stringify(config));
  const spawned = [], opts = { home, configPath, env: {}, spawn: (args) => { spawned.push(args); return true; } };
  return { home, configPath, config, spawned, opts, root: join(home, ".cache/routr/otel") };
}

test("OTLP endpoints keep prefixes and allow cleartext only on loopback, without credentials or query", () => {
  for (const url of ["https://example.test/prefix///", "http://localhost:4318/prefix/", "http://127.0.0.2:4318", "http://[::1]:4318/"])
    expect(otel.otelEndpoint(url)).toBe(url.replace(/\/+$/, ""));
  for (const url of ["http://example.test", "ftp://localhost", "https://u:p@example.test", "https://example.test/?key=secret", "https://example.test/?", "https://example.test/#secret", "http://localhost.evil.test", "http://[::2]", "garbage"])
    expect(() => otel.otelEndpoint(url)).toThrow("invalid OpenTelemetry endpoint");
});

test("export needs a valid persisted consent and ignores ambient exporters, DNT and CI", () => {
  const config = { otel: { endpoint: "https://example.test/prefix", consent: "1234567890abcdef1234567890abcdef" } };
  for (const env of [{}, { CI: "1", DO_NOT_TRACK: "1" }, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://elsewhere" }, { OTEL_SDK_DISABLED: "false" }])
    expect(otel.otelSwitch(config, env)).toMatchObject({ on: true, why_off: null });
  for (const env of [{ OTEL_SDK_DISABLED: "TrUe" }, { ROUTR_OTEL: "0" }]) expect(otel.otelSwitch(config, env).on).toBe(false);
  for (const value of [undefined, {}, { endpoint: config.otel.endpoint }, { ...config.otel, consent: "bad" }, { ...config.otel, endpoint: "http://elsewhere" }])
    expect(otel.otelSwitch({ otel: value }, {}).on).toBe(false);
  expect(otel.otelSwitch({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.test" }).on).toBe(false);
});

test("headers save and reload losslessly through the secrets file, with a distinct secret-free result", () => {
  const home = scratch("otel-headers"), env = cliEnv(home, { PATH: home, ROUTR_OTEL_HEADERS: "ignored=ambient" });
  const value = " 'name = ends%27, Authorization=Bearer%20HEADER_MARKER%2C%3D%23%22%25, tab=a%09b ";
  const r = Bun.spawnSync([process.execPath, SCRIPT, "key", "set", "otel-headers"], { env, stdin: Buffer.from(value + "\n") });
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout.toString())).toEqual({ ok: true, key: "otel-headers", file: join(home, ".config/routr/env"), headers: "set" });
  expect(r.stdout.toString() + r.stderr.toString()).not.toContain("HEADER_MARKER");
  const file = join(home, ".config/routr/env");
  expect(readFileSync(file, "utf8")).toContain("ROUTR_OTEL_HEADERS=%27name=ends%27,Authorization=Bearer%20HEADER_MARKER%2C%3D%23%22%25,tab=a%09b");
  expect(otel.otelHeaders(file)).toEqual({ "'name": "ends'", Authorization: 'Bearer HEADER_MARKER,=#"%', tab: "a\tb" });
  for (const value of ["a=b,A=c", "a=%", "a=%FF", "a=%0d%0aHEADER_MARKER", "a=%1b", "a=é", "bad name=HEADER_MARKER", "missing", "content-type=x", "Content-Length=3", "HOST=x", "transfer-encoding=x", "connection=x", "Accept-Encoding=x"])
    expect(() => otel.parseOtelHeaders(value)).toThrow("invalid OpenTelemetry headers");
  const bad = Bun.spawnSync([process.execPath, SCRIPT, "key", "set", "otel-headers"], { env, stdin: Buffer.from("a=%0dHEADER_MARKER\n") });
  expect(bad.exitCode).toBe(1);
  expect(bad.stdout.toString() + bad.stderr.toString()).not.toContain("HEADER_MARKER");
  expect(otel.otelHeaders(file).Authorization).toContain("HEADER_MARKER"); // a refused edit kept the previous secret
});

test("the trace encoder uses OTLP JSON's hex ids, string nanos, integer enums and nested AnyValues", () => {
  // OTLP JSON mapping and the protocol's trace example: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
  const span = { traceId: "5B8EFFF798038103D269B633813FC60C", spanId: "EEE19B7EC3C1B174", parentSpanId: "EEE19B7EC3C1B173", name: "test", kind: 2,
    startTimeUnixNano: 1544712660000000000n, endTimeUnixNano: "1544712661000000000", flags: 1,
    attributes: { string: "a", bool: true, integer: 12n, double: 1.5, array: [1, false], map: { nested: "yes" }, bytes: new Uint8Array([0, 255]) },
    events: [{ timeUnixNano: 1544712660500000000n, name: "event", attributes: { a: "b" } }],
    links: [{ traceId: "5b8efff798038103d269b633813fc60c", spanId: "eee19b7ec3c1b175", attributes: {} }], status: { code: 1 } };
  const body = otel.encodeTraces([span], { resource: { "service.name": "my.service" }, scope: { name: "my.library", version: "1.0", attributes: { a: "b" } } });
  expect(JSON.parse(JSON.stringify(body))).toEqual({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "my.service" } }] }, scopeSpans: [{
    scope: { name: "my.library", version: "1.0", attributes: [{ key: "a", value: { stringValue: "b" } }] }, spans: [{
      traceId: "5b8efff798038103d269b633813fc60c", spanId: "eee19b7ec3c1b174", parentSpanId: "eee19b7ec3c1b173", name: "test", kind: 2, flags: 1,
      startTimeUnixNano: "1544712660000000000", endTimeUnixNano: "1544712661000000000",
      attributes: [{ key: "string", value: { stringValue: "a" } }, { key: "bool", value: { boolValue: true } }, { key: "integer", value: { intValue: "12" } }, { key: "double", value: { doubleValue: 1.5 } },
        { key: "array", value: { arrayValue: { values: [{ intValue: "1" }, { boolValue: false }] } } }, { key: "map", value: { kvlistValue: { values: [{ key: "nested", value: { stringValue: "yes" } }] } } }, { key: "bytes", value: { bytesValue: "AP8=" } }],
      events: [{ timeUnixNano: "1544712660500000000", name: "event", attributes: [{ key: "a", value: { stringValue: "b" } }] }],
      links: [{ traceId: "5b8efff798038103d269b633813fc60c", spanId: "eee19b7ec3c1b175", attributes: [] }], status: { code: 1 }
    }] }] }] });
  expect(() => otel.encodeTraces([{ ...span, traceId: "not hex" }])).toThrow();
});

test("resources have an exclusive per-install id and use OpenTelemetry operating system names", () => {
  const home = scratch("otel-resource");
  const r = otel.otelResource({ home, platform: "darwin" });
  expect(r).toEqual({ "service.name": "routr", "service.version": ROUTR_VERSION, "os.type": "darwin", "service.instance.id": expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(otel.otelResource({ home, platform: "win32" })).toEqual({ ...r, "os.type": "windows" });
  expect(otel.otelResource({ home, platform: "linux" })["os.type"]).toBe("linux");
});

test("no-mkdir atomic writes cannot recreate a removed queue", () => {
  const root = scratch("otel-atomic"), file = join(root, "removed/file.json");
  expect(() => writeJsonAtomic(file, { a: 1 }, { mkdir: false })).toThrow();
  expect(existsSync(join(root, "removed"))).toBe(false);
  writeJsonAtomic(file, { a: 1 });
  expect(JSON.parse(readFileSync(file))).toEqual({ a: 1 });
});

test("a failed atomic rename preserves the old retry state", () => {
  const file = join(scratch("otel-atomic-failure"), "sender.json"); writeFileSync(file, '{"attempt":3}');
  expect(() => writeJsonAtomic(file, { attempt: 4 }, { rename: () => { throw Object.assign(new Error("full disk"), { code: "ENOSPC" }); } })).toThrow();
  expect(JSON.parse(readFileSync(file))).toEqual({ attempt: 3 });
});

test("sessions do nothing off, and queue only under the consent they started with without deleting files", () => {
  const f = install(), offHome = scratch("otel-off"), offSpawns = [];
  const off = otel.otelSession({}, {}, { home: offHome, spawn: (...v) => offSpawns.push(v) });
  off.queue("traces", {});
  expect(readdirSync(offHome)).toEqual([]); expect(offSpawns).toEqual([]);
  otel.prepareOtel(f.opts);
  const session = otel.otelSession(f.config, {}, f.opts), body = { resourceSpans: [] };
  session.queue("traces", body);
  const files = readdirSync(join(f.root, "traces"));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d+-12345678-[a-f0-9-]{36}\.json$/);
  expect(JSON.parse(readFileSync(join(f.root, "traces", files[0])))).toEqual(body);
  expect(readFileSync(join(f.root, "traces", files[0]), "utf8")).not.toContain(f.config.otel.consent);
  expect(f.spawned).toHaveLength(1);
  writeFileSync(f.configPath, "{}"); session.queue("traces", body);
  writeFileSync(f.configPath, JSON.stringify({ otel: { ...f.config.otel, consent: "abcdef1234567890abcdef1234567890" } })); session.queue("traces", body);
  expect(readdirSync(join(f.root, "traces"))).toEqual(files);
  mkdirSync(join(f.home, ".local/state/routr"), { recursive: true }); writeFileSync(join(f.home, ".local/state/routr/uninstalling"), "1");
  writeFileSync(f.configPath, JSON.stringify(f.config)); session.queue("traces", body);
  expect(readdirSync(join(f.root, "traces"))).toEqual(files);
  rmSync(f.root, { recursive: true }); session.queue("traces", body);
  expect(existsSync(f.root)).toBe(false);
});

test("setup rotates consent on every explicit endpoint, off removes only the setting, and show reports status", async () => {
  expect(formatCommandHelp(COMMANDS.setup)).toContain("--otel-endpoint <url>");
  expect(formatCommandHelp(COMMANDS.setup)).toContain("--otel-off");
  expect(formatCommandHelp(COMMANDS.key)).toContain("otel-headers");
  const f = install(), starts = [];
  const inspect = async () => ({ config: { exists: existsSync(f.configPath), subscriptions: [] }, harnesses: {}, decision: [{ works: true }], next_steps: [],
    skill: ["routr", "routr-orchestrate"].map((name) => ({ name, where: `~/.agents/skills/${name}`, version: ROUTR_VERSION })) });
  const run = (flags) => setup(["--yes", "--json", "--config", f.configPath, ...flags], { inspect, interactive: false, env: {}, otelStart: () => starts.push(1), otelHome: f.home });
  const bad = await run(["--otel-endpoint", "https://u:HEADER_MARKER@example.test"]);
  expect(bad.ok).toBe(false); expect(JSON.stringify(bad)).not.toContain("HEADER_MARKER");
  expect((await run(["--otel-endpoint", "https://example.test/prefix///"])).ok).toBe(true);
  const first = loadConfig(f.configPath).config.otel;
  expect(first).toMatchObject({ endpoint: "https://example.test/prefix", consent: expect.stringMatching(/^[a-f0-9]{32}$/) });
  expect(first.consent).not.toBe(f.config.otel.consent);
  expect((await run(["--otel-endpoint", first.endpoint])).ok).toBe(true);
  const second = loadConfig(f.configPath).config.otel;
  expect(second.consent).not.toBe(first.consent);
  const shown = showSettings(f.configPath, { home: f.home, env: {} });
  expect(shown.otel).toEqual({ on: true, why_off: null, endpoint_origin: "https://example.test", headers: "not set", last_export: null, queued_files: 0, oldest_age_sec: null, dropped_total: 0, dropped_by_code: {} });
  writeFileSync(join(f.root, "traces", `1-${second.consent.slice(0, 8)}-00000000-0000-0000-0000-000000000001.json`), "{}");
  expect((await run(["--otel-off"])).ok).toBe(true);
  expect(loadConfig(f.configPath).config.otel).toBeUndefined();
  expect(readdirSync(join(f.root, "traces"))).toHaveLength(1);
  expect(starts).toHaveLength(3);
  expect((await run(["--show", "--otel-off"])).ok).toBe(false);
  expect((await run(["--otel-off", "--otel-endpoint", first.endpoint])).ok).toBe(false);
});

test("guided setup offers a person export with skip as the default and validates the endpoint", async () => {
  for (const on of [false, true]) {
    const questions = [], ui = { style: { dim: (s) => s }, glyphs: { arrow: "→" }, line() {}, note() {},
      multiselect: async () => ["cursor"], search: async () => "", select: async (q) => q.initial,
      confirm: async (q) => { questions.push(q); return on; }, text: async (q) => q.parse("http://localhost:4318/prefix/") };
    const result = await guided({ ui, r: { harnesses: { cursor: { installed: true, signed_in: true } } }, config: null, efforts: async () => null });
    expect(questions).toContainEqual(expect.objectContaining({ message: "Export OpenTelemetry to your own endpoint?", initial: false }));
    expect(result.otelEndpoint).toBe(on ? "http://localhost:4318/prefix" : undefined);
  }
});

test("doctor and setup --show share the complete read-only export status", () => {
  const f = install();
  mkdirSync(join(f.home, ".config/routr"), { recursive: true });
  writeFileSync(join(f.home, ".config/routr/config.json"), JSON.stringify(f.config));
  const run = (...args) => Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: cliEnv(f.home, { PATH: f.home, CI: "1", DO_NOT_TRACK: "1" }) }).stdout.toString();
  const status = JSON.parse(run("setup", "--show")).otel;
  expect(JSON.parse(run("doctor", "--json")).otel).toEqual(status);
  expect(status).toMatchObject({ on: true, endpoint_origin: "http://127.0.0.1:4318" });
  expect(run("doctor")).toContain("OpenTelemetry export on");
  expect(existsSync(f.root)).toBe(false);
});

test("the sender claims batches, POSTs JSON with saved headers, deletes accepted files and records status", async () => {
  const r = await receiver((req, res) => { res.end("{}"); });
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts);
    writeSecrets({ ROUTR_OTEL_HEADERS: otel.parseOtelHeaders(" 'name = ends%27, Authorization=Bearer%20HEADER_MARKER%2C%3D%27, x=one%252Ctwo, tab=a%09b ").stored }, join(f.home, ".config/routr/env"));
    const body = otel.encodeTraces([], { resource: otel.otelResource({ home: f.home }) });
    otel.otelSession(f.config, {}, f.opts).queue("traces", body);
    await otel.sendOtel({ ...f.opts, env: { ROUTR_OTEL_HEADERS: "ignored=ambient" } });
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({ url: "/prefix/v1/traces", headers: { "'name": "ends'", authorization: "Bearer HEADER_MARKER,='", x: "one%2Ctwo", tab: "a\tb", "content-type": "application/json", "accept-encoding": "identity" }, body: JSON.stringify(body) + "\n" });
    expect(readdirSync(join(f.root, "traces"))).toEqual([]);
    expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ last_export: { ok: true, sent: 1, refused: 0, error: null }, headers: "set", queued_files: 0 });
    expect(readFileSync(join(f.root, "sender.json"), "utf8")).not.toContain("HEADER_MARKER");
    expect(existsSync(join(f.root, "sender.lock"))).toBe(false);
  } finally { await r.close(); }
});

test("accepted responses count partial rejection and diagnostics without retaining response text", async () => {
  for (const [body, code, count] of [[JSON.stringify({ partialSuccess: { rejectedSpans: "3", errorMessage: "HEADER_MARKER" } }), "rejected", 3],
    [JSON.stringify({ partialSuccess: { rejectedSpans: "0", errorMessage: "HEADER_MARKER" } }), "partial_warning", 1], ["not JSON HEADER_MARKER", "response_unreadable", 1], ["x".repeat(65537), "response_unreadable", 1]]) {
    const r = await receiver((req, res) => res.end(body));
    try {
      const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
      await otel.sendOtel(f.opts);
      expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ last_export: { ok: true }, queued_files: 0, dropped_by_code: { [code]: count } });
      expect(readFileSync(join(f.root, "sender.json"), "utf8")).not.toContain("HEADER_MARKER");
    } finally { await r.close(); }
  }
});

test("retriable responses persist jittered backoff and Retry-After across sender restarts", async () => {
  const r = await receiver((req, res) => { res.statusCode = 503; res.setHeader("Retry-After", "2"); res.end("HEADER_MARKER"); });
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
    let time = Date.now(); const opts = { ...f.opts, now: () => time, random: () => 0.5 };
    await otel.sendOtel(opts);
    let st = JSON.parse(readFileSync(join(f.root, "sender.json")));
    expect(st).toMatchObject({ attempt: 1, next_attempt_at: time + 2000, last_export: { ok: false, sent: 0, error: "http_503" } });
    expect(readdirSync(join(f.root, "traces"))).toHaveLength(1);
    await otel.sendOtel(opts); expect(r.requests).toHaveLength(1);
    time += 2000; await otel.sendOtel(opts);
    st = JSON.parse(readFileSync(join(f.root, "sender.json")));
    expect(st).toMatchObject({ attempt: 2, next_attempt_at: time + 2000 });
    time += 2000; await otel.sendOtel(opts);
    expect(JSON.parse(readFileSync(join(f.root, "sender.json")))).toMatchObject({ attempt: 3, next_attempt_at: time + 4000 });
    expect(readFileSync(join(f.root, "sender.json"), "utf8")).not.toContain("HEADER_MARKER");
  } finally { await r.close(); }
});

test("redirects and other non-retriable statuses drop once, with fixed codes and no response bodies", async () => {
  for (const status of [101, 301, 400, 401, 404, 500, 501]) {
    const r = await receiver((req, res) => { res.statusCode = status; res.setHeader("Location", "/must-not-follow"); if (status === 101) { res.setHeader("Connection", "Upgrade"); res.setHeader("Upgrade", "other"); } res.end("HEADER_MARKER"); });
    try {
      const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
      await otel.sendOtel({ ...f.opts, timeoutMs: 30 });
      expect(r.requests).toHaveLength(1);
      expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ queued_files: 0, dropped_total: 1, dropped_by_code: { [`http_${status}`]: 1 } });
      expect(readFileSync(join(f.root, "sender.json"), "utf8")).not.toContain("HEADER_MARKER");
    } finally { await r.close(); }
  }
});

test("only the sender folds drop markers and sweeps old consent, age, caps and abandoned atomic temp files", async () => {
  const r = await receiver((req, res) => res.end("{}"));
  try {
    const f = install(r.endpoint), time = Date.now(); otel.prepareOtel(f.opts);
    const queue = otel.otelSession(f.config, {}, { ...f.opts, capBytes: 8 });
    queue.queue("traces", { a: 1 }); queue.queue("traces", { a: 2 }); queue.queue("traces", { a: 3 });
    expect(readdirSync(join(f.root, "traces"))).toHaveLength(2);
    expect(readdirSync(join(f.root, "drops"))).toHaveLength(1);
    expect(otel.otelStatus(f.config, {}, f.opts).dropped_total).toBe(0);
    const oldest = join(f.root, "traces", readdirSync(join(f.root, "traces"))[0]); utimesSync(oldest, new Date(time - 2000), new Date(time - 2000));
    const oldNonce = join(f.root, "traces/1-aaaaaaaa-00000000-0000-0000-0000-000000000002.json"); writeFileSync(oldNonce, "{}");
    const oldAge = join(f.root, "traces/2-12345678-00000000-0000-0000-0000-000000000003.json"); writeFileSync(oldAge, "{}"); utimesSync(oldAge, new Date(0), new Date(0));
    const tmp = `${oldest}.tmp.123`, freshTmp = `${oldest}.tmp.456`; writeFileSync(tmp, "partial"); writeFileSync(freshTmp, "partial"); utimesSync(tmp, new Date(time - 3600_001), new Date(time - 3600_001));
    const foreign = join(f.root, "traces/user.json"); writeFileSync(foreign, "KEEP");
    await otel.sendOtel({ ...f.opts, capBytes: 8, now: () => time });
    expect(r.requests).toHaveLength(1);
    expect(existsSync(oldest)).toBe(false); expect(existsSync(tmp)).toBe(false); expect(existsSync(freshTmp)).toBe(true); expect(readFileSync(foreign, "utf8")).toBe("KEEP");
    expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ queued_files: 0, dropped_total: 4, dropped_by_code: { ceiling: 1, consent: 1, cap: 2 } });
    expect(readdirSync(join(f.root, "drops"))).toEqual([]);
  } finally { await r.close(); }
});

test("a sender recovers every owned .sending file only after taking the lock, and sweeps even when off", async () => {
  const r = await receiver((req, res) => res.end("{}"));
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
    const file = join(f.root, "traces", readdirSync(join(f.root, "traces"))[0]); renameSync(file, file + ".sending");
    const lock = join(f.root, "sender.lock"); writeFileSync(lock, String(process.pid));
    await otel.sendOtel(f.opts); expect(existsSync(file + ".sending")).toBe(true); expect(r.requests).toHaveLength(0);
    utimesSync(lock, new Date(Date.now() - 300_001), new Date(Date.now() - 300_001)); // stale even with a live pid
    await otel.sendOtel(f.opts); expect(r.requests).toHaveLength(1); expect(existsSync(file + ".sending")).toBe(false);
    otel.otelSession(f.config, {}, f.opts).queue("traces", {});
    writeFileSync(f.configPath, "{}");
    await otel.sendOtel(f.opts);
    expect(otel.otelStatus({}, {}, f.opts)).toMatchObject({ queued_files: 0, dropped_by_code: { consent: 1 } });
    expect(r.requests).toHaveLength(1);
  } finally { await r.close(); }
});

test("concurrent processes write complete distinct batches and agree on the installation identity", async () => {
  const f = install(); otel.prepareOtel(f.opts);
  const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/otel-child.mjs"), "queue"], { env: cliEnv(f.home), stdout: "pipe", stderr: "pipe" }));
  const ids = await Promise.all(children.map(async (p) => { expect(await p.exited).toBe(0); return new Response(p.stdout).text(); }));
  expect(new Set(ids).size).toBe(1);
  const files = readdirSync(join(f.root, "traces")); expect(files).toHaveLength(80);
  for (const name of files) expect(JSON.parse(readFileSync(join(f.root, "traces", name))).resourceSpans[0].resource["service.instance.id"]).toBe(ids[0].trim());
});

test("killing a sender before POST keeps the batch; after 2xx it resends the same bytes and ids", async () => {
  const r = await receiver((req, res) => res.end("{}"));
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts);
    otel.otelSession(f.config, {}, f.opts).queue("traces", { resourceSpans: [{ traceId: "5b8efff798038103d269b633813fc60c" }] });
    const child = async (mode) => { const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/otel-child.mjs"), mode], { env: cliEnv(f.home), stdout: "ignore", stderr: "pipe" }); await p.exited; expect(p.signalCode).toBe("SIGKILL"); };
    await child("die-before"); expect(r.requests).toHaveLength(0);
    expect(otel.otelStatus(f.config, {}, f.opts).queued_files).toBe(1);
    await child("die-after"); expect(r.requests).toHaveLength(1);
    expect(readdirSync(join(f.root, "traces"))[0]).toEndWith(".sending");
    await otel.sendOtel(f.opts); expect(r.requests).toHaveLength(2);
    expect(r.requests[0].body).toBe(r.requests[1].body);
    expect(readdirSync(join(f.root, "traces"))).toEqual([]);
  } finally { await r.close(); }
});

test("a partial queue write or full disk never affects a command, and an unwritable sender state prevents POST", async () => {
  const r = await receiver((req, res) => res.end("{}"));
  try {
    for (const partial of [false, true]) {
      const f = install(r.endpoint); otel.prepareOtel(f.opts);
      const session = otel.otelSession(f.config, {}, { ...f.opts, write: (file, body, options) => {
        if (file.includes("traces")) { if (partial) writeFileSync(`${file}.tmp.${process.pid}`, "{\"partial"); throw Object.assign(new Error("HEADER_MARKER"), { code: "ENOSPC" }); }
        writeJsonAtomic(file, body, options);
      } });
      expect(() => session.queue("traces", {})).not.toThrow();
      expect(readdirSync(join(f.root, "drops"))).toHaveLength(1);
      await otel.sendOtel(f.opts); expect(r.requests).toHaveLength(0);
      expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ dropped_total: 1, dropped_by_code: { write_failed: 1 } });
    }
    const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
    await otel.sendOtel({ ...f.opts, write: () => { throw new Error("HEADER_MARKER"); } });
    expect(r.requests).toHaveLength(0); expect(otel.otelStatus(f.config, {}, f.opts).queued_files).toBe(1);
  } finally { await r.close(); }
});

test("a batch arriving as the sender releases its lock is found by its final rescan", async () => {
  const r = await receiver((req, res) => res.end("{}"));
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts);
    const session = otel.otelSession(f.config, {}, f.opts); session.queue("traces", {});
    let released = false;
    await otel.sendOtel({ ...f.opts, release: (file) => { unlinkSync(file); if (!released) { released = true; session.queue("traces", { late: true }); } } });
    expect(r.requests).toHaveLength(2); expect(otel.otelStatus(f.config, {}, f.opts).queued_files).toBe(0);
  } finally { await r.close(); }
});

test("hanging endpoints do not delay queueing; requests time out and stop with persisted backoff", async () => {
  const r = await receiver(() => {});
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts);
    const session = otel.otelSession(f.config, {}, f.opts), began = performance.now();
    session.queue("traces", {});
    expect(performance.now() - began).toBeLessThan(250);
    await otel.sendOtel({ ...f.opts, timeoutMs: 30 });
    expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ queued_files: 1, last_export: { ok: false, error: "timeout" } });
    expect(existsSync(join(f.root, "sender.lock"))).toBe(false);
  } finally { await r.close(); }
});

test("uninstall reports a running sender and its in-flight timeout cannot recreate removed folders", async () => {
  let received;
  const arrived = new Promise((resolve) => { received = resolve; }), r = await receiver(() => received());
  let child;
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
    child = Bun.spawn([process.execPath, SCRIPT, "--otel-sender", "--config", f.configPath], { env: cliEnv(f.home), stdout: "ignore", stderr: "pipe" });
    await arrived;
    const began = performance.now();
    const result = await uninstall(["--yes", "--json"], { home: f.home });
    expect(performance.now() - began).toBeLessThan(1000);
    expect(result).toMatchObject({ ok: true, otel_sender_running: true });
    expect(result.note).toContain("OpenTelemetry sender");
    expect(existsSync(f.root)).toBe(false);
    expect(await child.exited).toBe(0);
    expect(existsSync(f.root)).toBe(false); expect(existsSync(join(f.home, ".local/state/routr"))).toBe(false);
  } finally { child?.kill(); await r.close(); }
}, 20_000);

test("Windows uninstall leaves the binary for a running sender and says when it can be removed", () => {
  const home = scratch("otel-uninstall-win"), binary = join(home, "routr.exe"); writeFileSync(binary, "fixture");
  const result = carryOut({ remove: [{ path: binary, binary: true }], not_ours: [] }, { home, platform: "win32", senderRunning: true });
  expect(result.removed).toEqual([]); expect(result.userFiles).toContain(binary); expect(existsSync(binary)).toBe(true);
});

test("uninstall checks for a sender again under its lock before removing files", async () => {
  const home = scratch("otel-uninstall-race"); let checks = 0;
  const r = await uninstall(["--yes", "--json"], { home, senderStatus: () => {
    checks++; if (checks === 1) return false;
    expect(existsSync(join(home, ".local/state/routr/uninstalling"))).toBe(true); return true;
  } });
  expect(checks).toBe(2); expect(r).toMatchObject({ ok: true, otel_sender_running: true });
});

test("saved header values stay out of every command's whole output, queued batches, ledger and telemetry rows", () => {
  const f = install(), marker = "PRIVATE_OTEL_HEADER_MARKER_917d", config = join(f.home, ".config/routr/config.json"), ledger = join(f.home, "ledger.jsonl"), advice = join(f.home, "advice.json");
  mkdirSync(join(f.home, ".config/routr"), { recursive: true });
  writeFileSync(config, JSON.stringify({ ...f.config, subscriptions: {}, telemetry: false, auto_update: false }));
  writeSecrets({ ROUTR_OTEL_HEADERS: `authorization=${marker}` }, join(f.home, ".config/routr/env"));
  writeFileSync(advice, JSON.stringify({ id: "safe-advice", brief_sha: briefSha("safe task"), mode: "dispatch", level: "standard", facts: {} }));
  const cases = [
    ["dispatch", "safe task"], ["subagent", "safe task"], ["check", "--brief", advice, "--report", advice], ["doctor", "--json"], ["doctor"], ["setup", "--show"],
    ["key", "set", "otel-headers"], ["launch", "--dry-run"], ["cleanup", "--dry-run"], ["workers"], ["wait", "--timeout", "1"], ["send"], ["stop"], ["usage"],
    ["record", "--advice", advice, "--ledger", ledger, "--subscription", "codex", "--model", "fixture", "--effort", "low", "--verdict", "done", "--check", "pass"],
    ["assess", "--ledger", ledger], ["share", "--ledger", ledger, "--out", join(f.home, "share.jsonl")], ["telemetry", "status"], ["feedback"], ["skill", "install", "--dry-run"], ["uninstall", "--dry-run", "--json"], ["update", "--help"], ["statusline"]
  ];
  expect(new Set(cases.map((a) => a[0])).size).toBe(Object.keys(COMMANDS).length);
  for (const args of cases) {
    const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: cliEnv(f.home, { PATH: f.home, ROUTR_OTEL_HEADERS: marker }), stdin: Buffer.from(`authorization=${marker}\n`) });
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain(marker);
  }
  expect(readFileSync(ledger, "utf8")).not.toContain(marker);
  expect(JSON.stringify(telemetryRows(readLedger(ledger), "test-install"))).not.toContain(marker);
  otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", otel.encodeTraces([], { resource: otel.otelResource({ home: f.home }) }));
  for (const name of readdirSync(join(f.root, "traces"))) expect(readFileSync(join(f.root, "traces", name), "utf8")).not.toContain(marker);
}, 20_000);

test("each off switch leaves the command API completely inert", () => {
  for (const [config, env] of [[{}, {}], [{ otel: { endpoint: "https://example.test" } }, {}], [{ otel: { endpoint: "https://example.test", consent: "bad" } }, {}],
    [{ otel: { endpoint: "https://example.test", consent: "a".repeat(32) } }, { OTEL_SDK_DISABLED: "TRUE" }], [{ otel: { endpoint: "https://example.test", consent: "a".repeat(32) } }, { ROUTR_OTEL: "0" }]]) {
    const home = scratch("otel-inert"), starts = [], session = otel.otelSession(config, env, { home, spawn: (args) => starts.push(args) });
    expect(session.on).toBe(false); session.queue("traces", {});
    expect(readdirSync(home)).toEqual([]); expect(starts).toEqual([]);
  }
});

test("all four retriable HTTP codes honour HTTP-date Retry-After and a successful retry resets progression", async () => {
  for (const status of [429, 502, 503, 504]) {
    let time = Date.now(); const retryAt = new Date(time + 5000).toUTCString();
    const r = await receiver((req, res, n) => { if (n === 1) { res.statusCode = status; res.setHeader("Retry-After", retryAt); } res.end("{}"); });
    try {
      const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
      const opts = { ...f.opts, now: () => time, random: () => 0 };
      await otel.sendOtel(opts);
      expect(JSON.parse(readFileSync(join(f.root, "sender.json")))).toMatchObject({ attempt: 1, next_attempt_at: Date.parse(retryAt) });
      time = Date.parse(retryAt); await otel.sendOtel(opts);
      expect(r.requests).toHaveLength(2); expect(JSON.parse(readFileSync(join(f.root, "sender.json")))).toMatchObject({ attempt: 0, next_attempt_at: null });
    } finally { await r.close(); }
  }
});

test("network failures retry, and a state failure after acceptance stops before another batch", async () => {
  const r = await receiver((req, res, n) => { if (n === 1) req.socket.destroy(); else res.end("{}"); });
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); const session = otel.otelSession(f.config, {}, f.opts); session.queue("traces", {});
    let time = Date.now(); const opts = { ...f.opts, now: () => time };
    await otel.sendOtel(opts);
    expect(otel.otelStatus(f.config, {}, f.opts).last_export.error).toBe("network");
    time = JSON.parse(readFileSync(join(f.root, "sender.json"))).next_attempt_at; session.queue("traces", {});
    await otel.sendOtel({ ...opts, write: (file, value, options) => { if (value.last_export?.ok) throw new Error("state unwritable"); writeJsonAtomic(file, value, options); } });
    expect(r.requests).toHaveLength(2);
    expect(readdirSync(join(f.root, "traces")).filter((n) => n.endsWith(".sending"))).toHaveLength(1);
    await otel.sendOtel(opts); expect(r.requests).toHaveLength(4);
  } finally { await r.close(); }
});

test("queue age follows file times through forward and backward clock jumps", async () => {
  const r = await receiver((req, res) => res.end("{}"));
  try {
    const f = install(r.endpoint), time = Date.now(); otel.prepareOtel(f.opts);
    otel.otelSession(f.config, {}, { ...f.opts, now: () => 1 }).queue("traces", {});
    expect(otel.otelStatus(f.config, {}, { ...f.opts, now: () => time - 86400_000 }).oldest_age_sec).toBe(0);
    await otel.sendOtel({ ...f.opts, now: () => time }); expect(r.requests).toHaveLength(1);
    otel.otelSession(f.config, {}, { ...f.opts, now: () => time + 100 * 365 * 86400_000 }).queue("traces", {});
    await otel.sendOtel({ ...f.opts, now: () => time + 8 * 86400_000 });
    expect(r.requests).toHaveLength(1); expect(otel.otelStatus(f.config, {}, f.opts).dropped_by_code).toEqual({ cap: 1 });
  } finally { await r.close(); }
});

test("a live sender protects its claim and a batch written during its request starts no second sender", async () => {
  let arrived, finish;
  const received = new Promise((resolve) => { arrived = resolve; });
  const r = await receiver((req, res, n) => { if (n === 1) { finish = () => res.end("{}"); arrived(); } else res.end("{}"); });
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); const session = otel.otelSession(f.config, {}, f.opts); session.queue("traces", {});
    const sender = otel.sendOtel(f.opts); await received;
    const claimed = readdirSync(join(f.root, "traces")).find((n) => n.endsWith(".sending")); expect(claimed).toBeDefined();
    session.queue("traces", {}); expect(f.spawned).toHaveLength(1);
    await otel.sendOtel(f.opts); expect(r.requests).toHaveLength(1); expect(existsSync(join(f.root, "traces", claimed))).toBe(true);
    finish(); await sender; expect(r.requests).toHaveLength(2);
  } finally { finish?.(); await r.close(); }
});

test("the sender's one-minute life is monotonic and permits only the request already in flight to finish", async () => {
  let elapsed = 0;
  const r = await receiver((req, res) => { elapsed = 60_001; res.end("{}"); });
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); const session = otel.otelSession(f.config, {}, f.opts); session.queue("traces", {}); session.queue("traces", {});
    await otel.sendOtel({ ...f.opts, monotonic: () => elapsed });
    expect(r.requests).toHaveLength(1); expect(otel.otelStatus(f.config, {}, f.opts).queued_files).toBe(1);
  } finally { await r.close(); }
});

test("the sender repairs signal folders inside an existing cache but never recreates a removed cache", async () => {
  const f = install(); otel.prepareOtel(f.opts);
  rmSync(join(f.root, "traces"), { recursive: true });
  await otel.sendOtel(f.opts); expect(existsSync(join(f.root, "traces"))).toBe(true);
  rmSync(f.root, { recursive: true });
  await otel.sendOtel(f.opts); expect(existsSync(f.root)).toBe(false);
});

test("queue writers racing the sender's removals lose no complete batches", async () => {
  const r = await receiver((req, res) => res.end("{}")), f = install(r.endpoint); otel.prepareOtel(f.opts);
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/otel-child.mjs"), "queue"], { env: cliEnv(f.home, { ROUTR_TEST_QUEUE_COUNT: "100" }), stdout: "ignore", stderr: "pipe" }));
  let active = children.length;
  const exits = children.map(async (c) => { try { expect(await c.exited).toBe(0); } finally { active--; } });
  try {
    while (active) { await otel.sendOtel(f.opts); await new Promise((resolve) => setTimeout(resolve, 1)); }
    await Promise.all(exits); await otel.sendOtel(f.opts);
    expect(r.requests).toHaveLength(400); expect(otel.otelStatus(f.config, {}, f.opts).dropped_total).toBe(0);
  } finally { for (const c of children) c.kill(); await r.close(); }
}, 20_000);
