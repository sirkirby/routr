import { expect, test } from "bun:test";
import * as otel from "../src/lib/otel.mjs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ids, install, points, receiver } from "./fixtures/otel-signals.mjs";

test("logs encode eventName, empty body, severity and correlation using shared resource/scope/AnyValue", () => {
  const body = otel.encodeLogs([{ ...ids, eventName: "routr.warning", timeUnixNano: 1544712660000000000n, severityNumber: 13, severityText: "WARN", attributes: { "routr.warning.code": "prompt_uncertain" } }]);
  expect(body.resourceLogs[0].resource.attributes).toEqual(otel.otlpAttributes(otel.otelResource()));
  expect(body.resourceLogs[0].scopeLogs[0]).toEqual({ scope: otel.otlpScope(), logRecords: [{ ...ids, timeUnixNano: "1544712660000000000", observedTimeUnixNano: "1544712660000000000", flags: 0, severityNumber: 13, severityText: "WARN", eventName: "routr.warning", attributes: [{ key: "routr.warning.code", value: { stringValue: "prompt_uncertain" } }] }] });
});

test("the custom headroom Gauge encodes a double including endpoints, string nanos, unit 1 and exact dimensions", () => {
  for (const value of [0, 0.25, 1]) {
    const body = otel.encodeHeadroom([{ subscription: "claude", window: "five_hour", value, time: 1544712660000 }], { resource: { "service.instance.id": "gauge" } });
    expect(body.resourceMetrics[0]).toEqual({ resource: { attributes: [{ key: "service.instance.id", value: { stringValue: "gauge" } }] }, scopeMetrics: [{ scope: otel.otlpScope(), metrics: [{ name: "routr.subscription.headroom", unit: "1", gauge: { dataPoints: [{ timeUnixNano: "1544712660000000000", asDouble: value, attributes: [{ key: "routr.subscription", value: { stringValue: "claude" } }, { key: "routr.usage.window", value: { stringValue: "five_hour" } }] }] } }] }] });
  }
});

test("the sender folds latest per stream, persists watermarks across restarts, and sends resets on the same install stream", async () => {
  await receiver(async (endpoint, requests) => {
    const f = install(endpoint), obs = { subscription: "claude", window: "five_hour", value: 0.2, time: 1000 };
    for (const o of [obs, { ...obs, time: 2000, value: 0.4 }, { ...obs, time: 1500 }, { ...obs, window: "seven_day", value: 1 }]) f.queue.queue("metrics", o);
    await otel.sendOtel(f.opts);
    expect(requests.map((r) => r.url)).toEqual(["/prefix/v1/metrics"]);
    expect(points(requests).map((p) => [p.timeUnixNano, p.asDouble]).sort()).toEqual([["1000000000", 1], ["2000000000", 0.4]]);
    const id = requests[0].body.resourceMetrics[0].resource.attributes.find((a) => a.key === "service.instance.id").value.stringValue;
    expect(id).toBe(otel.otelGaugeInstanceId(f.opts)); expect(id).not.toBe(otel.otelResource()["service.instance.id"]);
    for (const time of [1000, 2000]) f.queue.queue("metrics", { ...obs, time });
    await otel.sendOtel(f.opts); expect(requests).toHaveLength(1); expect(readdirSync(join(f.root, "metrics"))).toEqual([]);
    f.queue.queue("metrics", { ...obs, time: 3000, value: 1 }); await otel.sendOtel(f.opts);
    expect(points(requests).at(-1)).toMatchObject({ timeUnixNano: "3000000000", asDouble: 1 });
    expect(requests[1].body.resourceMetrics[0].resource).toEqual(requests[0].body.resourceMetrics[0].resource);
  });
});


test("logs encode observedTimeUnixNano and the causing span's flags", () => {
  const body = otel.encodeLogs([{ ...ids, flags: 1, eventName: "routr.warning", timeUnixNano: 1700000000000000000n, observedTimeUnixNano: 1700000000000000000n, severityNumber: 13, severityText: "WARN", attributes: {} }]);
  expect(body.resourceLogs[0].scopeLogs[0].logRecords[0]).toMatchObject({ timeUnixNano: "1700000000000000000", observedTimeUnixNano: "1700000000000000000", flags: 1 });
});
