// The W3C trace-context carriers routr hands on to the workers it starts: which it takes, the transport limits, and
// the two environments (a harness read gets none; a worker start gets the checked ones, its adapter's own keys winning).
import { expect, test } from "bun:test";
import { CARRIERS, carriersFrom, carrierWithheld, harnessEnv, savedCarriers, workerEnv } from "../src/lib/runtime.mjs";

const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const at = (n) => "a".repeat(n);

test("the three carriers are the W3C trace-context names, read as found; an empty one is absent", () => {
  expect(CARRIERS).toEqual(["TRACEPARENT", "TRACESTATE", "BAGGAGE"]);
  expect(carriersFrom({ PATH: "/bin" })).toEqual({ carriers: {}, withheld: [] });
  expect(carriersFrom({ TRACEPARENT: "", TRACESTATE: "", BAGGAGE: "" })).toEqual({ carriers: {}, withheld: [] });
  // Values are opaque: kept byte for byte, never parsed, trimmed or checked against the W3C grammar.
  const odd = { TRACEPARENT: " not-a-traceparent ", TRACESTATE: "k=v,\tx=\"y\"", BAGGAGE: "a=%2C;p=1,b=c d!&'" };
  expect(carriersFrom({ ...odd, OTHER: "x" })).toEqual({ carriers: odd, withheld: [] });
});

test("names are matched case-insensitively on Windows only, as Windows' environment is", () => {
  const env = { traceparent: TP, Baggage: "k=v" };
  expect(carriersFrom(env, { platform: "win32" })).toEqual({ carriers: { TRACEPARENT: TP, BAGGAGE: "k=v" }, withheld: [] });
  expect(carriersFrom(env, { platform: "linux" })).toEqual({ carriers: {}, withheld: [] });
  expect(carriersFrom(env, { platform: "darwin" })).toEqual({ carriers: {}, withheld: [] });
});

test("transport limits: a size at each limit goes, one byte over is withheld; tabs pass, control and non-ASCII characters do not", () => {
  const limits = { TRACEPARENT: 512, TRACESTATE: 512, BAGGAGE: 8192 };
  for (const [name, max] of Object.entries(limits)) {
    expect(carriersFrom({ [name]: at(max) })).toEqual({ carriers: { [name]: at(max) }, withheld: [] });
    expect(carriersFrom({ [name]: at(max + 1) })).toEqual({ carriers: {}, withheld: [name] });
  }
  expect(carriersFrom({ TRACESTATE: "a=1,\tb=2" }).carriers).toEqual({ TRACESTATE: "a=1,\tb=2" });
  expect(carriersFrom({ BAGGAGE: " ~" }).carriers).toEqual({ BAGGAGE: " ~" }); // 0x20 and 0x7E, the ends of the range
  for (const bad of ["a\rb", "a\nb", "a\x1b[31mb", "café", " ", "a\x7fb", "a\0b"]) {
    // One carrier out of its limits is withheld alone: the others still go.
    expect(carriersFrom({ TRACEPARENT: TP, TRACESTATE: bad, BAGGAGE: "k=v" })).toEqual({ carriers: { TRACEPARENT: TP, BAGGAGE: "k=v" }, withheld: ["TRACESTATE"] });
  }
  // A multi-byte character counts as what it is: never as a short string slipping under a byte limit.
  expect(carriersFrom({ TRACEPARENT: "é".repeat(200) }).withheld).toEqual(["TRACEPARENT"]);
});

test("a withheld carrier's warning names it and its limit, never its value", () => {
  for (const name of CARRIERS) {
    const w = carrierWithheld(name);
    expect(w).toContain(name);
    expect(w).toContain("not passed");
    expect(carrierWithheld(name)).toBe(w); // fixed: the value is never an input
  }
  expect(carrierWithheld("BAGGAGE")).toContain("8192");
});

test("a harness read gets no carrier, in any case; a worker start gets the checked ones, and its adapter's own keys win", () => {
  const env = { PATH: "/bin", TRACEPARENT: TP, TRACESTATE: "k=v", BAGGAGE: "b=1", traceparent: TP, Baggage: "b=2", OTEL_SERVICE_NAME: "kept" };
  expect(harnessEnv(env)).toEqual({ PATH: "/bin", OTEL_SERVICE_NAME: "kept" });
  // Sets the present carriers, leaves absent ones out, and starts from the harness environment (the caller's own dropped).
  expect(workerEnv({ TRACEPARENT: TP }, {}, env)).toEqual({ PATH: "/bin", OTEL_SERVICE_NAME: "kept", TRACEPARENT: TP });
  expect(workerEnv(undefined, {}, env)).toEqual({ PATH: "/bin", OTEL_SERVICE_NAME: "kept" });
  expect(workerEnv({ TRACEPARENT: TP, BAGGAGE: "b=3" }, { CURSOR_CONFIG_DIR: "/c", BAGGAGE: "adapter" }, env))
    .toEqual({ PATH: "/bin", OTEL_SERVICE_NAME: "kept", TRACEPARENT: TP, BAGGAGE: "adapter", CURSOR_CONFIG_DIR: "/c" });
  // What it is given goes through the same limits again: an unchecked object is never spread into a child's environment.
  expect(workerEnv({ TRACEPARENT: "a\nb", TRACESTATE: 7, BAGGAGE: "k=v", LD_PRELOAD: "/evil.so" }, {}, { PATH: "/bin" })).toEqual({ PATH: "/bin", BAGGAGE: "k=v" });
});

test("carriers saved with a worker are checked again on every load: unknown keys ignored, a non-string or out-of-limit value withheld", () => {
  expect(savedCarriers(undefined)).toEqual({ carriers: {}, withheld: [] }); // a worker made before carriers were saved
  for (const v of [null, "TRACEPARENT", 7, [TP], true]) expect(savedCarriers(v)).toEqual({ carriers: {}, withheld: [] });
  expect(savedCarriers({ TRACEPARENT: TP, NODE_OPTIONS: "--require /evil.js", traceparent: "x", __proto__: { BAGGAGE: "inherited" } }))
    .toEqual({ carriers: { TRACEPARENT: TP }, withheld: [] });
  expect(savedCarriers({ TRACEPARENT: 7, TRACESTATE: at(513), BAGGAGE: "k=v" })).toEqual({ carriers: { BAGGAGE: "k=v" }, withheld: ["TRACEPARENT", "TRACESTATE"] });
  expect(savedCarriers({ TRACEPARENT: { toString: () => TP }, TRACESTATE: "a\x1bb", BAGGAGE: "" })).toEqual({ carriers: {}, withheld: ["TRACEPARENT", "TRACESTATE"] });
});

test("smoke:carriers' own values are hostile but valid, exactly at each limit, and its checks find a value changed by a byte", async () => {
  const { fixtureCommand, HOSTILE, hostileCarriers, missingIn, missingInText } = await import("../scripts/smoke-carriers.mjs");
  const sent = hostileCarriers("t");
  expect(carriersFrom(sent)).toEqual({ carriers: sent, withheld: [] });
  expect(Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, v.length]))).toEqual({ TRACEPARENT: 512, TRACESTATE: 512, BAGGAGE: 8192 });
  for (const c of ["%", "\"", "&", "!", ";", ",", "=", "\t", " "]) expect([c, HOSTILE.includes(c)]).toEqual([c, true]);
  for (const v of Object.values(sent)) expect(v).toContain(HOSTILE);
  expect(new Set(Object.values(hostileCarriers())).size).toBe(3);
  // The fixture's environment: exact, or each carrier that differs by a byte (or is missing) named.
  expect(missingIn({ ...sent, PATH: "/bin" }, sent)).toEqual([]);
  expect(missingIn({ ...sent, TRACESTATE: sent.TRACESTATE.slice(0, -1), BAGGAGE: undefined }, sent)).toEqual(["TRACESTATE", "BAGGAGE"]);
  expect(missingIn(null, sent)).toEqual(CARRIERS);
  // An agent's environment, as /proc/<pid>/environ and as `ps eww <pid>` print it.
  const proc = ["PATH=/bin", ...Object.entries(sent).map(([k, v]) => `${k}=${v}`), ""].join("\0");
  expect(missingInText(proc, sent, { proc: true })).toEqual([]);
  expect(missingInText(proc.replace(sent.BAGGAGE, sent.BAGGAGE.slice(1)), sent, { proc: true })).toEqual(["BAGGAGE"]);
  const ps = `  PID TT  STAT   TIME COMMAND\n 4242 s001 S+  0:01.00 claude PATH=/bin ${Object.entries(sent).map(([k, v]) => `${k}=${v}`).join(" ")} TERM=xterm\n`;
  expect(missingInText(ps, sent)).toEqual([]);
  expect(missingInText(ps.replace(`TRACEPARENT=${sent.TRACEPARENT}`, `TRACEPARENT=${sent.TRACEPARENT}x`), sent)).toEqual(["TRACEPARENT"]);
  // What it types starts the fixture only: the runtime and the script, quoted for the pane's shell, never a carrier.
  expect(fixtureCommand("posix", "/opt/bun", "/tmp/a b/fixture.cjs")).toBe("/opt/bun '/tmp/a b/fixture.cjs'");
  expect(fixtureCommand("powershell", "C:\\bun.exe", "C:\\it's\\fixture.cjs")).toBe("& 'C:\\bun.exe' 'C:\\it''s\\fixture.cjs'");
});
