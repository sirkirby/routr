import { expect, test } from "bun:test";
import * as otel from "../src/lib/otel.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cliEnv, scratch, SCRIPT } from "./helpers.mjs";
import { ROUTR_VERSION } from "../src/lib/version.mjs";

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
