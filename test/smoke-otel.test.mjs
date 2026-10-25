import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encodeTraces } from "../src/lib/otel.mjs";
import { checkSmokeTraces, fixtureHarness, fixturePaneRun, smokeParent } from "../scripts/smoke-otel.mjs";

const span = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "1234567890abcdef", parentSpanId: "00f067aa0ba902b7", flags: 1, name: "routr usage", kind: 1, startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: {} };
const batch = (s = span) => encodeTraces([s], { schemaUrl: "https://opentelemetry.io/schemas/1.44.0" });
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
