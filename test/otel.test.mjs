import { expect, test } from "bun:test";
import * as otel from "../src/lib/otel.mjs";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  for (const value of ["a=b,A=c", "a=%", "a=%FF", "a=%0d%0aHEADER_MARKER", "a=%1b", "a=é", "a=\vHEADER_MARKER", "a=\fHEADER_MARKER", "a=\u00a0HEADER_MARKER", "\u00a0a=b", "a=b\u00a0", "bad name=HEADER_MARKER", "missing", "content-type=x", "Content-Length=3", "HOST=x", "transfer-encoding=x", "connection=x", "Accept-Encoding=x"])
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

test("trace and log resources use one in-memory UUIDv4 per process and OpenTelemetry operating system names", () => {
  const home = scratch("otel-resource");
  const r = otel.otelResource({ home, platform: "darwin" });
  expect(r).toEqual({ "service.name": "routr", "service.version": ROUTR_VERSION, "os.type": "darwin", "routr.otel.schema": "genai@9ffc7e00;semconv@1.44.0;routr@1", "service.instance.id": expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) });
  expect(otel.otelResource({ home, platform: "win32" })).toEqual({ ...r, "os.type": "windows" });
  expect(otel.otelResource({ home, platform: "linux" })["os.type"]).toBe("linux");
  expect(readdirSync(home)).toEqual([]);
  expect(otel.otelResource({ home: scratch("otel-other-home") })["service.instance.id"]).toBe(r["service.instance.id"]);
});

test("the gauge identity helper lazily derives UUIDv5 from the persistent installation id", async () => {
  const home = scratch("otel-gauge-id"), dir = join(home, ".local/state/routr"), file = join(dir, "service-instance-id");
  otel.otelResource({ home }); expect(existsSync(file)).toBe(false);
  mkdirSync(dir, { recursive: true });
  const id = otel.otelGaugeInstanceId({ home });
  expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const installed = readFileSync(file, "utf8");
  expect(installed).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(otel.otelGaugeInstanceId({ home })).toBe(id); expect(readFileSync(file, "utf8")).toBe(installed);
  const otherHome = scratch("otel-gauge-other-install"); mkdirSync(join(otherHome, ".local/state/routr"), { recursive: true });
  expect(otel.otelGaugeInstanceId({ home: otherHome })).not.toBe(id);
  // Independent Python stdlib uuid.uuid5 vector: convention namespace + UTF-8 UUID text as the name.
  writeFileSync(file, "00112233-4455-4677-8899-aabbccddeeff");
  expect(otel.otelGaugeInstanceId({ home })).toBe("7d27dd02-0951-5268-b356-413ed1cf4b75");
  const concurrentHome = scratch("otel-gauge-concurrent");
  mkdirSync(join(concurrentHome, ".local/state/routr"), { recursive: true });
  const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/otel-child.mjs"), "gauge"], { env: cliEnv(concurrentHome), stdout: "pipe", stderr: "pipe" }));
  const ids = await Promise.all(children.map(async (p) => { expect(await p.exited).toBe(0); return new Response(p.stdout).text(); }));
  expect(new Set(ids)).toEqual(new Set([otel.otelGaugeInstanceId({ home: concurrentHome }) + "\n"]));
});

test("no-mkdir atomic writes cannot recreate a removed queue", () => {
  const root = scratch("otel-atomic"), file = join(root, "removed/file.json");
  expect(() => writeJsonAtomic(file, { a: 1 }, { mkdir: false })).toThrow();
  expect(existsSync(join(root, "removed"))).toBe(false);
  writeJsonAtomic(file, { a: 1 });
  expect(JSON.parse(readFileSync(file))).toEqual({ a: 1 });
});

// Windows refuses a rename over a file another process is reading (EPERM), and removing the file first left it missing
// for a reader in between (a headless worker's state read as none, on CI). A refused rename is tried again with the
// old file in place; only one still refused after 100 ms is replaced by removing first.
test("atomic writes retry a refused rename in place, and keep the remove-and-rename fallback for one that stays refused", () => {
  const file = join(scratch("otel-atomic-default"), "value.json"); writeFileSync(file, '{"a":1}');
  const defaultMode = statSync(file).mode & 0o777;
  let calls = 0;
  writeJsonAtomic(file, { a: 2 }, { rename: (from, to) => {
    calls++; expect(existsSync(to)).toBe(true); // never a moment without the file
    if (calls < 3) throw Object.assign(new Error("in use"), { code: "EPERM" });
    renameSync(from, to);
  } });
  expect(calls).toBe(3); expect(JSON.parse(readFileSync(file))).toEqual({ a: 2 });
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(defaultMode);
  let stuck = 0; const began = performance.now();
  writeJsonAtomic(file, { a: 3 }, { rename: (from, to) => {
    if (existsSync(to)) { stuck++; throw Object.assign(new Error("in use"), { code: "EBUSY" }); }
    renameSync(from, to);
  } });
  expect(JSON.parse(readFileSync(file))).toEqual({ a: 3 });
  expect(stuck).toBeGreaterThan(1); expect(performance.now() - began).toBeLessThan(1000); // retried, briefly, then replaced
  // Not a file in use: no retry.
  let full = 0;
  writeJsonAtomic(file, { a: 4 }, { rename: (from, to) => { if (existsSync(to)) { full++; throw Object.assign(new Error("full disk"), { code: "ENOSPC" }); } renameSync(from, to); } });
  expect(full).toBe(1);
});

test("atomic writes keep the explicit mode option", () => {
  const file = join(scratch("otel-atomic-mode"), "value.json");
  writeJsonAtomic(file, {}, { mode: 0o600 });
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600 & ~process.umask());
  expect(JSON.parse(readFileSync(file))).toEqual({});
});

test("atomic writes can indent hand-edited settings while keeping the compact default", () => {
  const file = join(scratch("atomic-indent"), "config.json"), value = { otel: { endpoint: "https://example.test" } };
  writeJsonAtomic(file, value, { indent: 2 });
  expect(readFileSync(file, "utf8")).toBe('{\n  "otel": {\n    "endpoint": "https://example.test"\n  }\n}\n');
  writeJsonAtomic(file, value);
  expect(readFileSync(file, "utf8")).toBe('{"otel":{"endpoint":"https://example.test"}}\n');
});

test("atomic writes can preserve the old file and throw on failed replacement", () => {
  const file = join(scratch("otel-atomic-failure"), "sender.json"); writeFileSync(file, '{"attempt":3}');
  let calls = 0;
  expect(() => writeJsonAtomic(file, { attempt: 4 }, { preserveOnError: true, rename: () => { calls++; throw Object.assign(new Error("full disk"), { code: "ENOSPC" }); } })).toThrow();
  expect(calls).toBe(1);
  expect(JSON.parse(readFileSync(file))).toEqual({ attempt: 3 });
});

test("sender state requests replacement without deleting the previous retry state on failure", async () => {
  const f = install(); otel.prepareOtel(f.opts);
  const file = join(f.root, "sender.json"), previous = { attempt: 3, next_attempt_at: Date.now() + 60_000, consent: f.config.otel.consent, dropped_total: 0, dropped_by_code: {} };
  writeFileSync(file, JSON.stringify(previous));
  await otel.sendOtel({ ...f.opts, write: (file, value, options) => writeJsonAtomic(file, value, { ...options, rename: () => { throw Object.assign(new Error("full disk"), { code: "ENOSPC" }); } }) });
  expect(JSON.parse(readFileSync(file))).toEqual(previous);
  expect(existsSync(join(f.root, "sender.lock"))).toBe(false);
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
  expect(shown.otel).toEqual({ on: true, why_off: null, endpoint_origin: "https://example.test", headers: "not set", can_queue: true, queue_error: null, last_export: null, queued_files: 0, oldest_age_sec: null, dropped_total: 0, dropped_by_code: {} });
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

test("guided setup lists OpenTelemetry with settings before either exit or save action", async () => {
  const menus = [], ui = { style: { dim: (s) => s }, glyphs: { arrow: "→" }, note() {},
    select: async (q) => {
      if (q.message !== "What would you like to do?") return "beta";
      menus.push(q.options.map((o) => o.value));
      return menus.length === 1 ? "channel" : "quit";
    } };
  await guided({ ui, r: { harnesses: {} }, config: { subscriptions: {} } });
  expect(menus).toHaveLength(2);
  for (const values of menus) for (const action of ["save", "done", "quit"]) if (values.includes(action))
    expect(values.indexOf("otel")).toBeLessThan(values.indexOf(action));
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
    [JSON.stringify({ partialSuccess: { rejectedSpans: "0", errorMessage: "HEADER_MARKER" } }), "partial_warning", 1], ["", "response_unreadable", 1], ["not JSON HEADER_MARKER", "response_unreadable", 1], ["x".repeat(65537), "response_unreadable", 1]]) {
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

test("concurrent processes write complete distinct batches with their own process identities and no id file", async () => {
  const f = install(); otel.prepareOtel(f.opts);
  const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/otel-child.mjs"), "queue"], { env: cliEnv(f.home), stdout: "pipe", stderr: "pipe" }));
  const ids = await Promise.all(children.map(async (p) => { expect(await p.exited).toBe(0); return new Response(p.stdout).text(); }));
  expect(new Set(ids).size).toBe(8);
  const files = readdirSync(join(f.root, "traces")); expect(files).toHaveLength(80);
  const counts = {};
  for (const name of files) {
    const id = JSON.parse(readFileSync(join(f.root, "traces", name))).resourceSpans[0].resource["service.instance.id"];
    expect(ids.map((s) => s.trim())).toContain(id); counts[id] = (counts[id] ?? 0) + 1;
  }
  expect(Object.values(counts)).toEqual(Array(8).fill(10));
  expect(existsSync(join(f.home, ".local/state/routr/service-instance-id"))).toBe(false);
});

test("killing a sender before POST keeps the batch; after 2xx it resends the same bytes and ids", async () => {
  const r = await receiver((req, res) => res.end("{}"));
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts);
    otel.otelSession(f.config, {}, f.opts).queue("traces", { resourceSpans: [{ traceId: "5b8efff798038103d269b633813fc60c" }] });
    const child = async (mode) => {
      const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/otel-child.mjs"), mode], { env: cliEnv(f.home), stdout: "ignore", stderr: "pipe" });
      const code = await p.exited;
      if (process.platform === "win32") expect(code).not.toBe(0); // TerminateProcess has an exit code, not a POSIX signal
      else expect(p.signalCode).toBe("SIGKILL");
    };
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
  expect(result.removed).toEqual([]); expect(result.userFiles).toEqual([]); expect(result.keptBinary).toBe(binary); expect(existsSync(binary)).toBe(true);
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
  for (const signal of ["traces", "logs", "metrics"]) for (const name of readdirSync(join(f.root, signal))) expect(readFileSync(join(f.root, signal, name), "utf8")).not.toContain(marker);
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

test("a sender that loses its token stops before its next claim, state write, delete or release", async () => {
  let arrived, finish;
  const received = new Promise((resolve) => { arrived = resolve; });
  const r = await receiver((req, res, n) => { if (n === 1) { finish = () => res.end("{}"); arrived(); } else res.end("{}"); });
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); const session = otel.otelSession(f.config, {}, f.opts); session.queue("traces", {}); session.queue("traces", {});
    const sender = otel.sendOtel(f.opts); await received;
    const state = readFileSync(join(f.root, "sender.json"), "utf8"), lock = join(f.root, "sender.lock");
    // Same inode, another token: ownership must never depend on file identity (including inode reuse).
    const other = JSON.stringify({ pid: process.pid, token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }); writeFileSync(lock, other);
    finish(); await sender;
    expect(r.requests).toHaveLength(1); expect(readFileSync(join(f.root, "sender.json"), "utf8")).toBe(state);
    expect(readdirSync(join(f.root, "traces")).filter((n) => n.endsWith(".sending"))).toHaveLength(1);
    expect(readdirSync(join(f.root, "traces")).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(readFileSync(lock, "utf8")).toBe(other);
  } finally { finish?.(); await r.close(); }
});

test("wall time bounds a sleeping sender even when its monotonic clock stands still", async () => {
  let wall = Date.now();
  const r = await receiver((req, res) => { wall += 300_001; res.end("{}"); });
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); const session = otel.otelSession(f.config, {}, f.opts); session.queue("traces", {}); session.queue("traces", {});
    await otel.sendOtel({ ...f.opts, now: () => wall, monotonic: () => 0 });
    expect(r.requests).toHaveLength(1);
    expect(readdirSync(join(f.root, "traces"))).toHaveLength(2);
  } finally { await r.close(); }
});

test("a consent change during the first POST prevents the next old-consent batch from being sent", async () => {
  let arrived, finish;
  const received = new Promise((resolve) => { arrived = resolve; });
  const r = await receiver((req, res, n) => { if (n === 1) { finish = () => res.end("{}"); arrived(); } else res.end("{}"); });
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); const session = otel.otelSession(f.config, {}, f.opts); session.queue("traces", {}); session.queue("traces", {});
    const sender = otel.sendOtel(f.opts); await received;
    writeJsonAtomic(f.configPath, { otel: { endpoint: r.endpoint, consent: "abcdef1234567890abcdef1234567890" } });
    finish(); await sender;
    expect(r.requests).toHaveLength(1); expect(readdirSync(join(f.root, "traces"))).toEqual([]);
    expect(otel.otelStatus(f.config, {}, f.opts).dropped_by_code.consent).toBe(1);
  } finally { finish?.(); await r.close(); }
});

test("a 2xx is recorded and its claim removed before a failed config reread, without resending it", async () => {
  for (const mode of ["invalid", "unreadable"]) {
    let arrived, finish;
    const received = new Promise((resolve) => { arrived = resolve; });
    const r = await receiver((req, res, n) => { if (n === 1) { finish = () => res.end("{}"); arrived(); } else res.end("{}"); });
    try {
      const f = install(r.endpoint); otel.prepareOtel(f.opts); let time = Date.now() - 1000;
      const session = otel.otelSession(f.config, {}, { ...f.opts, now: () => time++ });
      session.queue("traces", { batch: "accepted" }); session.queue("traces", { batch: "pending" });
      const sender = otel.sendOtel(f.opts); await received;
      if (mode === "invalid") writeFileSync(f.configPath, "{partial");
      else { unlinkSync(f.configPath); mkdirSync(f.configPath); }
      finish(); await sender;
      expect(r.requests).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(f.root, "sender.json"))).last_export).toMatchObject({ ok: true, sent: 1, refused: 0 });
      const files = readdirSync(join(f.root, "traces")); expect(files).toHaveLength(1); expect(files[0]).toEndWith(".json");
      expect(JSON.parse(readFileSync(join(f.root, "traces", files[0])))).toEqual({ batch: "pending" });
      if (mode === "unreadable") rmSync(f.configPath, { recursive: true });
      writeJsonAtomic(f.configPath, f.config); await otel.sendOtel(f.opts);
      expect(r.requests.map((req) => JSON.parse(req.body).batch)).toEqual(["accepted", "pending"]);
    } finally { finish?.(); await r.close(); }
  }
});

test("an unreadable or unparseable config keeps every batch and stops without interpreting it as off", async () => {
  for (const mode of ["invalid", "unreadable"]) {
    const f = install(); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
    const before = readdirSync(join(f.root, "traces"));
    if (mode === "invalid") writeFileSync(f.configPath, "{partial");
    else { unlinkSync(f.configPath); mkdirSync(f.configPath); }
    await otel.sendOtel(f.opts);
    expect(readdirSync(join(f.root, "traces"))).toEqual(before);
    expect(existsSync(join(f.root, "sender.json"))).toBe(false);
  }
});

test("a config briefly renamed aside by an editor does not revoke queued batches", async () => {
  const r = await receiver((req, res) => res.end("{}"));
  const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", { batch: "keep" });
  const aside = `${f.configPath}.editor`; renameSync(f.configPath, aside);
  const restore = setTimeout(() => renameSync(aside, f.configPath), 50);
  try {
    await otel.sendOtel(f.opts);
    expect(r.requests.map((req) => JSON.parse(req.body))).toEqual([{ batch: "keep" }]);
    expect(otel.otelStatus(f.config, {}, f.opts).dropped_total).toBe(0);
  } finally {
    clearTimeout(restore); if (existsSync(aside)) renameSync(aside, f.configPath);
    await r.close();
  }
});

test("a config still missing after confirmation means export is off and the sender sweeps its queued batches", async () => {
  const f = install(); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
  unlinkSync(f.configPath);
  const began = performance.now();
  await otel.sendOtel(f.opts);
  expect(performance.now() - began).toBeGreaterThanOrEqual(200);
  expect(readdirSync(join(f.root, "traces"))).toEqual([]);
  expect(JSON.parse(readFileSync(join(f.root, "sender.json"))).dropped_by_code.consent).toBe(1);
});

test("a config permission error keeps all batches and creates no sender state", async () => {
  const f = install(); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
  const before = readdirSync(join(f.root, "traces"));
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/otel-config-denied.mjs"), f.home, f.configPath], { stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(0);
  expect(readdirSync(join(f.root, "traces"))).toEqual(before);
  expect(existsSync(join(f.root, "sender.json"))).toBe(false);
});

test("setup publishes config through the shared atomic writer without truncating the previous settings", async () => {
  const f = install(), before = readFileSync(f.configPath, "utf8"); let replacements = 0;
  const inspect = async () => ({ config: { exists: true, subscriptions: [] }, harnesses: {}, decision: [{ works: true }], next_steps: [],
    skill: ["routr", "routr-orchestrate"].map((name) => ({ name, where: `~/.agents/skills/${name}`, version: ROUTR_VERSION })) });
  const r = await setup(["--yes", "--json", "--config", f.configPath, "--channel", "beta"], { inspect, interactive: false, env: {}, otelHome: f.home,
    writeConfig: (file, value, options) => writeJsonAtomic(file, value, { ...options, rename: (from, to) => {
      expect(readFileSync(to, "utf8")).toBe(before); expect(JSON.parse(readFileSync(from)).update_channel).toBe("beta"); replacements++; renameSync(from, to);
    } }) });
  expect(r.ok).toBe(true); expect(replacements).toBe(1); expect(JSON.parse(readFileSync(f.configPath)).update_channel).toBe("beta");
  expect(readFileSync(f.configPath, "utf8")).toContain('\n  "otel": {\n    "endpoint":');
});

test("setup reports a failed config replacement and preserves the previous settings", async () => {
  const f = install(), before = readFileSync(f.configPath, "utf8"); let replacements = 0;
  const inspect = async () => ({ config: { exists: true, subscriptions: [] }, harnesses: {}, decision: [{ works: true }], next_steps: [],
    skill: ["routr", "routr-orchestrate"].map((name) => ({ name, where: `~/.agents/skills/${name}`, version: ROUTR_VERSION })) });
  await expect(setup(["--yes", "--json", "--config", f.configPath, "--channel", "beta"], { inspect, interactive: false, env: {}, otelHome: f.home,
    writeConfig: (file, value, options) => writeJsonAtomic(file, value, { ...options, rename: () => {
      replacements++; throw Object.assign(new Error("replace denied"), { code: "EPERM" }); // refused on every try
    } }) })).rejects.toThrow("replace denied");
  expect(replacements).toBeGreaterThan(1); expect(readFileSync(f.configPath, "utf8")).toBe(before);
});

test("strict sender-state replacement works repeatedly over an existing file on every platform", () => {
  const file = join(scratch("otel-state-replace"), "sender.json");
  for (let attempt = 0; attempt < 8; attempt++) {
    writeJsonAtomic(file, { attempt, next_attempt_at: 1000 + attempt }, { mkdir: false, mode: 0o600, preserveOnError: true });
    expect(JSON.parse(readFileSync(file))).toEqual({ attempt, next_attempt_at: 1000 + attempt });
  }
});

test("config and statusline static imports do not load the OTLP network modules", () => {
  for (const root of ["config", "statusline"]) {
    const seen = new Set(), imports = new Set();
    const walk = (file) => {
      if (seen.has(file)) return; seen.add(file);
      for (const m of readFileSync(file, "utf8").matchAll(/^(?:import\s+(?:[^;\n]+?\s+from\s+)?|export\s+[^;\n]+?\s+from\s+)["']([^"']+)["']/gm)) {
        imports.add(m[1]); if (m[1].startsWith(".")) walk(resolve(dirname(file), m[1]));
      }
    };
    walk(join(import.meta.dir, `../src/lib/${root}.mjs`));
    for (const name of ["node:http", "node:https", "node:net"]) expect(imports.has(name)).toBe(false);
  }
});

test("status exposes a missing queue after reinstall and ordinary setup repairs it without changing consent", async () => {
  const f = install(), inspect = async () => ({ config: { exists: true, subscriptions: [] }, harnesses: {}, decision: [{ works: true }], next_steps: [],
    skill: ["routr", "routr-orchestrate"].map((name) => ({ name, where: `~/.agents/skills/${name}`, version: ROUTR_VERSION })) });
  expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ on: true, can_queue: false, queue_error: expect.stringContaining("routr setup") });
  const before = f.config.otel.consent;
  const r = await setup(["--yes", "--json", "--config", f.configPath], { inspect, interactive: false, env: {}, otelHome: f.home });
  expect(r.ok).toBe(true); expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ can_queue: true, queue_error: null });
  expect(loadConfig(f.configPath).config.otel.consent).toBe(before);
  rmSync(f.root, { recursive: true }); mkdirSync(join(f.home, ".local/state/routr"), { recursive: true }); writeFileSync(join(f.home, ".local/state/routr/uninstalling"), "1");
  await setup(["--yes", "--json", "--config", f.configPath], { inspect, interactive: false, env: {}, otelHome: f.home });
  expect(existsSync(f.root)).toBe(false);
});

test("doctor flags an enabled but missing queue with a setup repair command", () => {
  const f = install(); mkdirSync(join(f.home, ".config/routr"), { recursive: true }); writeJsonAtomic(join(f.home, ".config/routr/config.json"), f.config);
  const run = (...args) => Bun.spawnSync([process.execPath, SCRIPT, "doctor", ...args], { env: cliEnv(f.home, { PATH: f.home }), stdin: "ignore" }).stdout.toString();
  const r = JSON.parse(run("--json"));
  expect(r.otel).toMatchObject({ on: true, can_queue: false }); expect(r.next_steps.some((s) => s.includes("OpenTelemetry") && s.includes("routr setup"))).toBe(true);
  expect(run()).toMatch(/!! OpenTelemetry export on[^\n]*routr setup/);
  expect(existsSync(f.root)).toBe(false);
});

test("Retry-After is capped at one hour and a farther persisted deadline is ignored", async () => {
  for (const after of ["31536000", "Wed, 01 Jan 2098 00:00:00 GMT"]) {
    const r = await receiver((req, res, n) => { if (n === 1) { res.statusCode = 503; res.setHeader("Retry-After", after); } res.end("{}"); });
    try {
      const f = install(r.endpoint), time = Date.now(); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
      const opts = { ...f.opts, now: () => time };
      await otel.sendOtel(opts);
      const file = join(f.root, "sender.json"), st = JSON.parse(readFileSync(file));
      expect(st.next_attempt_at).toBe(time + 3600_000);
      writeJsonAtomic(file, { ...st, next_attempt_at: time + 3600_001 });
      await otel.sendOtel(opts); expect(r.requests).toHaveLength(2); expect(otel.otelStatus(f.config, {}, f.opts).queued_files).toBe(0);
    } finally { await r.close(); }
  }
});

test("invalid saved headers are reported before claiming, without leaking their values or removing the batch", async () => {
  const r = await receiver((req, res) => res.end("{}"));
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
    const before = readdirSync(join(f.root, "traces"));
    writeSecrets({ ROUTR_OTEL_HEADERS: "authorization=%0aHEADER_MARKER" }, join(f.home, ".config/routr/env"));
    await otel.sendOtel(f.opts);
    expect(r.requests).toHaveLength(0); expect(readdirSync(join(f.root, "traces"))).toEqual(before);
    expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ headers: "invalid", last_export: { ok: false, sent: 0, refused: 0, error: "headers_invalid" } });
    expect(readFileSync(join(f.root, "sender.json"), "utf8")).not.toContain("HEADER_MARKER");
  } finally { await r.close(); }
});

test("last_export counts batches while partial rejection counts records only in the drop totals", async () => {
  const r = await receiver((req, res) => res.end(JSON.stringify({ partialSuccess: { rejectedSpans: "7" } })));
  try {
    const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
    await otel.sendOtel(f.opts);
    expect(otel.otelStatus(f.config, {}, f.opts)).toMatchObject({ last_export: { ok: true, sent: 1, refused: 0 }, dropped_by_code: { rejected: 7 } });
  } finally { await r.close(); }
});

test("headers that change plain request framing or encoding are reserved in every case", () => {
  for (const name of ["content-encoding", "te", "upgrade", "expect", "trailer", "keep-alive"])
    for (const variant of [name, name.toUpperCase()]) expect(() => otel.parseOtelHeaders(`${variant}=HEADER_MARKER`)).toThrow("invalid OpenTelemetry headers");
});

test("the gauge helper never recreates state folders or writes during uninstall", () => {
  const home = scratch("otel-gauge-uninstall"), dir = join(home, ".local/state/routr"), file = join(dir, "service-instance-id");
  expect(() => otel.otelGaugeInstanceId({ home })).toThrow(); expect(readdirSync(home)).toEqual([]);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "uninstalling"), String(process.pid));
  expect(() => otel.otelGaugeInstanceId({ home })).toThrow(); expect(existsSync(file)).toBe(false);
  expect(readdirSync(dir)).toEqual(["uninstalling"]);
});

test("files disappearing between a sweep listing and stat are skipped for temp files, markers and claims", async () => {
  for (const kind of ["temp", "marker", "claim"]) {
    const r = await receiver((req, res) => res.end("{}"));
    try {
      const f = install(r.endpoint); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
      const base = join(f.root, "traces/1-12345678-00000000-0000-0000-0000-000000000099.json");
      const file = kind === "temp" ? `${base}.tmp.1` : kind === "claim" ? `${base}.sending` : join(f.root, "drops/00000000-0000-0000-0000-000000000099.json");
      writeFileSync(file, kind === "marker" ? '{"code":"ceiling"}' : "{}"); let disappeared = false;
      await otel.sendOtel({ ...f.opts, stat: (path) => {
        if (path === file && !disappeared) { disappeared = true; unlinkSync(file); throw Object.assign(new Error("vanished"), { code: "ENOENT" }); }
        return lstatSync(path);
      } });
      expect(disappeared).toBe(true); expect(r.requests).toHaveLength(1); expect(otel.otelStatus(f.config, {}, f.opts).queued_files).toBe(0);
    } finally { await r.close(); }
  }
});

test("an off sender takes one final sweep-only pass for a batch written while its lock was releasing", async () => {
  const f = install(); otel.prepareOtel(f.opts); otel.otelSession(f.config, {}, f.opts).queue("traces", {});
  writeJsonAtomic(f.configPath, {}); let late = false, releases = 0;
  await otel.sendOtel({ ...f.opts, release: (lock) => {
    unlinkSync(lock); releases++;
    if (!late) { late = true; writeJsonAtomic(join(f.root, "traces/1-12345678-00000000-0000-0000-0000-000000000001.json"), {}); }
  } });
  expect(releases).toBe(2); expect(readdirSync(join(f.root, "traces"))).toEqual([]);
  expect(otel.otelStatus({}, {}, f.opts).dropped_by_code.consent).toBe(2);
});

test("Windows uninstall uses a distinct kept-binary result and matching messages for the actual keep decision", async () => {
  for (const running of [false, true]) {
    const home = scratch("otel-win-uninstall-result"), binary = join(home, "Different-Spelling.exe"), said = []; writeFileSync(binary, "fixture");
    const r = await uninstall(["--yes"], { home, binary, platform: "win32", senderStatus: () => running, print: (s) => said.push(s) });
    expect(r.ok).toBe(true); expect(r.kept_files).toBeUndefined();
    if (running) {
      expect(r.kept_binary).toBe(binary); expect(existsSync(binary)).toBe(true);
      expect(said.some((s) => s.includes(binary) && s.includes("sender"))).toBe(true);
      expect(said.join("\n")).not.toContain("routr is uninstalled");
    } else { expect(r.kept_binary).toBeUndefined(); expect(existsSync(binary)).toBe(false); }
  }
});

test("declining uninstall still prints that nothing was removed", () => {
  const home = scratch("otel-uninstall-declined");
  const code = `Object.defineProperty(process.stdin, "isTTY", { value: true }); process.argv = [process.execPath, ${JSON.stringify(SCRIPT)}, "uninstall"]; await import(${JSON.stringify(SCRIPT)});`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { env: cliEnv(home, { PATH: home }), stdin: Buffer.from("n\n") });
  expect(r.exitCode).toBe(0); expect(r.stdout.toString()).toContain("nothing was removed");
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
