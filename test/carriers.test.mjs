// The W3C trace-context carriers routr hands on to the workers it starts: which it takes, the transport limits, and
// the two environments (a harness read gets none; a worker start gets the checked ones, its adapter's own keys winning).
import { expect, test } from "bun:test";
import { CARRIERS, carriersFrom, carrierValues, carrierWithheld, harnessEnv, redactCarriers, savedCarriers, workerEnv } from "../src/lib/runtime.mjs";

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
  expect(savedCarriers({ TRACEPARENT: { toString: () => TP }, TRACESTATE: "a\x1bb", BAGGAGE: "" })).toEqual({ carriers: {}, withheld: ["TRACEPARENT", "TRACESTATE", "BAGGAGE"] });
  // Only an absent key is absent: one present that is not a non-empty string (null, empty, a number) is withheld and named.
  for (const v of [null, "", 0, false, undefined]) expect([v, savedCarriers({ BAGGAGE: v, TRACEPARENT: TP })]).toEqual([v, { carriers: { TRACEPARENT: TP }, withheld: ["BAGGAGE"] }]);
  expect(workerEnv({ BAGGAGE: null, TRACEPARENT: TP }, {}, { PATH: "/bin" })).toEqual({ PATH: "/bin", TRACEPARENT: TP });
});

test("smoke:carriers' own values are hostile but valid, exactly at each limit, and its checks find a value changed by a byte; the agent half uses short markers ps shows whole", async () => {
  const { agentCarriers, fixtureCommand, HOSTILE, hostileCarriers, missingIn, missingInText } = await import("../scripts/smoke-carriers.mjs");
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
  // The agent half: short markers ps shows unambiguously, valid for routr, each found whole in /proc or ps text.
  const marks = agentCarriers("t1");
  expect(carriersFrom(marks)).toEqual({ carriers: marks, withheld: [] });
  for (const v of Object.values(marks)) expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(marks.TRACEPARENT).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(agentCarriers().TRACEPARENT).not.toBe(agentCarriers().TRACEPARENT);
  const proc = ["PATH=/bin", ...Object.entries(marks).map(([k, v]) => `${k}=${v}`), ""].join("\0");
  expect(missingInText(proc, marks)).toEqual([]);
  expect(missingInText(proc.replace(`BAGGAGE=${marks.BAGGAGE}`, `BAGGAGE=${marks.BAGGAGE}x`), marks)).toEqual(["BAGGAGE"]);
  const ps = `/usr/local/bin/claude PATH=/bin ${Object.entries(marks).map(([k, v]) => `${k}=${v}`).join(" ")} TERM=xterm\n`;
  expect(missingInText(ps, marks)).toEqual([]);
  // Whole entries only: a longer value, or the marker under another name, is not the carrier.
  expect(missingInText(ps.replace(`TRACEPARENT=${marks.TRACEPARENT}`, `TRACEPARENT=${marks.TRACEPARENT}0`), marks)).toEqual(["TRACEPARENT"]);
  expect(missingInText(ps.replace("TRACESTATE=", "XTRACESTATE="), marks)).toEqual(["TRACESTATE"]);
  expect(missingInText("", marks)).toEqual(CARRIERS);
  // What it types starts the fixture only: the runtime and the script, quoted for the pane's shell, never a carrier.
  expect(fixtureCommand("posix", "/opt/bun", "/tmp/a b/fixture.cjs")).toBe("/opt/bun '/tmp/a b/fixture.cjs'");
  expect(fixtureCommand("powershell", "C:\\bun.exe", "C:\\it's\\fixture.cjs")).toBe("& 'C:\\bun.exe' 'C:\\it''s\\fixture.cjs'");
});

test("pane text leaves routr with every carrier value routr holds replaced, withheld ones too, even wrapped across lines", () => {
  const env = { TRACEPARENT: TP, TRACESTATE: "", BAGGAGE: "k=v,\tz=1 2", OTHER: "kept" };
  // The values present, within routr's limits or not; an empty one is not a value.
  expect(carrierValues(env)).toEqual([TP, "k=v,\tz=1 2"]);
  expect(carrierValues({ BAGGAGE: "a\x1bb".repeat(3000) })).toEqual(["a\x1bb".repeat(3000)]);
  expect(carrierValues({ traceparent: TP }, { platform: "win32" })).toEqual([TP]);
  expect(carrierValues({ traceparent: TP }, { platform: "linux" })).toEqual([]);
  const values = carrierValues(env);
  expect(redactCarriers(`$ env\nTRACEPARENT=${TP}\nBAGGAGE=k=v,\tz=1 2\nkept\nSource it? [y/N]`, values))
    .toBe("$ env\nTRACEPARENT=<carrier>\nBAGGAGE=<carrier>\nkept\nSource it? [y/N]");
  // A pane wraps a long line at its width, and a terminal may show a TAB as spaces.
  expect(redactCarriers(`TRACEPARENT=${TP.slice(0, 20)}\n${TP.slice(20, 40)}\r\n${TP.slice(40)} done`, values)).toBe("TRACEPARENT=<carrier> done");
  expect(redactCarriers("BAGGAGE=k=v,    z=1 2", values)).toBe("BAGGAGE=<carrier>");
  expect(redactCarriers("nothing here", values)).toBe("nothing here");
  expect(redactCarriers("x", [])).toBe("x");
  expect(redactCarriers(null, values)).toBe(null);
  // A value with regular-expression characters is matched as itself.
  expect(redactCarriers("a.*b and aXXb", ["a.*b"])).toBe("<carrier> and aXXb");
});

test("smoke:carriers reads an agent's environment only once the process is the harness, by its argv0 or its executable", async () => {
  const { argv0Of, isHarness } = await import("../scripts/smoke-carriers.mjs");
  expect(argv0Of("/Users/u/.local/bin/claude --dangerously-skip-permissions\n")).toBe("/Users/u/.local/bin/claude");
  expect(argv0Of("claude\0--resume\0x\0", { proc: true })).toBe("claude");
  expect(argv0Of("")).toBe(null);
  const installed = "/Users/u/.local/share/claude/versions/2.1.310";
  expect(isHarness({ argv0: "claude" }, { installed })).toBe(true);
  expect(isHarness({ argv0: "/Users/u/.local/bin/claude" }, { installed })).toBe(true);
  expect(isHarness({ argv0: installed }, { installed })).toBe(true); // started by its resolved path
  expect(isHarness({ argv0: "node", exe: installed }, { installed })).toBe(true);
  // A wrapper, a shell or a helper in front of it is not it.
  for (const argv0 of ["sh", "/usr/bin/env", "node", "claude-wrapper", "/opt/claude/bin/node", null]) expect([argv0, isHarness({ argv0 }, { installed })]).toEqual([argv0, false]);
  expect(isHarness({ argv0: "node", exe: "/usr/bin/node" }, { installed: null })).toBe(false);
});

test("smoke:carriers closes every pane it made, even when a shell stops at a question, and fails naming a pane it could not close", async () => {
  const { smokeCarriers } = await import("../scripts/smoke-carriers.mjs");
  const calls = [], lines = [];
  const herdr = async (a) => {
    calls.push(a);
    if (a[1] === "split") return { ok: true, data: { result: { pane: { pane_id: `w1:p${calls.filter((c) => c[1] === "split").length + 6}` } } } };
    if (a[1] === "process-info") return { ok: true, data: { result: { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: "zsh", cwd: "/" }] } } } };
    if (a[1] === "read") return { ok: true, data: { result: { text: "found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)" } } };
    if (a[1] === "close") return { ok: false, code: "herdr_refused", why: "herdr refused pane close (herdr_refused)", data: {} };
    throw new Error(`unexpected ${a.join(" ")}`);
  };
  const failed = await smokeCarriers({ herdr, git: async () => ({ code: 1 }), env: { HERDR_ENV: "1" }, log: (l) => lines.push(l) });
  expect(failed).toBeGreaterThan(0);
  expect(calls.filter((a) => a[1] === "close")).toEqual([["pane", "close", "w1:p7"]]);
  expect(lines.join("\n")).toContain("the pane's shell: The shell asked a question before its prompt");
  expect(lines.join("\n")).toContain("could not close pane w1:p7");
  expect(lines.join("\n")).not.toContain("routr-smoke-"); // never a carrier value
  expect(await smokeCarriers({ herdr, env: {}, log: () => {} })).toBe(1); // outside herdr: nothing done
});

test("smoke:carriers' worktree half leaves one carrier out, and expects it empty in the pane, whatever herdr's server has", async () => {
  const { hostileCarriers, leftOut, missingIn } = await import("../scripts/smoke-carriers.mjs");
  const sent = hostileCarriers();
  const { passed, expected } = leftOut(sent);
  expect(Object.keys(passed)).toEqual(["TRACEPARENT", "BAGGAGE"]);
  expect(expected).toEqual({ ...passed, TRACESTATE: "" });
  // The server's own value showing through is a failure; so is the variable missing altogether.
  expect(missingIn({ ...passed, TRACESTATE: "" }, expected)).toEqual([]);
  expect(missingIn({ ...passed, TRACESTATE: "server=1" }, expected)).toEqual(["TRACESTATE"]);
  expect(missingIn(passed, expected)).toEqual(["TRACESTATE"]);
});

test("smoke:carriers' worktree half runs routr's worktree steps in a throwaway repository, reads the new pane's shell, and removes the worktree", async () => {
  const { smokeCarriers } = await import("../scripts/smoke-carriers.mjs");
  const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tree = realpathSync.native(mkdtempSync(join(tmpdir(), "routr-smoke-tree-")));
  const calls = [], gits = [], lines = [];
  let envs = {};
  const ok = (result) => ({ ok: true, data: { result } });
  const herdr = async (a) => {
    calls.push(a);
    // The first half's pane stops at a shell question; the worktree's pane is at a prompt in the worktree.
    if (a[1] === "split" && a[2] === "--current") return ok({ pane: { pane_id: "w1:p7" } });
    if (a[0] === "worktree" && a[1] === "create") return ok({ root_pane: { pane_id: "w5:p1" }, worktree: { path: tree }, workspace: { workspace_id: "w5" } });
    if (a[1] === "split" && a[2] === "w5:p1") {
      // As herdr: each --env sets the pane's shell variable, an empty value included.
      envs = Object.fromEntries(a.flatMap((x, i) => (a[i - 1] === "--env" ? [[x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]] : [])));
      return ok({ pane: { pane_id: "w5:p2" } });
    }
    if (a[1] === "close") return ok({});
    if (a[1] === "list") return ok({ panes: [{ pane_id: "w5:p2" }] });
    if (a[1] === "process-info") return ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: "zsh", cwd: a[3] === "w5:p2" ? tree : "/" }] } });
    if (a[1] === "read") return ok({ text: a[2] === "w5:p2" ? "chris % " : "found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)" });
    if (a[1] === "run" && a[2] === "w5:p2") {
      // The fixture, played: it writes the shell's environment where its script says.
      const script = a[3].match(/'([^']+\.cjs)'|(\S+\.cjs)/).slice(1).find(Boolean);
      const out = JSON.parse(readFileSync(script, "utf8").match(/writeFileSync\(("[^"]+")/)[1]);
      writeFileSync(out, JSON.stringify({ PATH: "/bin", ...envs }));
      return ok({});
    }
    if (a[0] === "worktree" && a[1] === "remove") return ok({});
    throw new Error(`unexpected ${a.join(" ")}`);
  };
  try {
    const failed = await smokeCarriers({ herdr, git: async (dir, a) => { gits.push([dir, ...a]); return { code: 0 }; }, env: { HERDR_ENV: "1" }, log: (l) => lines.push(l) });
    expect(failed).toBe(1); // the first half's shell question only
    expect(lines.join("\n")).toContain("worktree pane, posix shell, one carrier empty: ok");
    // The repository is a throwaway one in the smoke's own temporary folder, never the checkout it runs from.
    const repo = gits[0][0];
    expect(repo).toContain("routr-smoke-carriers-");
    expect(repo).not.toBe(process.cwd());
    expect(gits.map((g) => g[1])).toEqual(["init", "-c"]);
    // routr's own steps, in order: worktree create in that repository, the root split with the carriers, the root closed.
    const at = (pred) => calls.findIndex(pred);
    expect(calls[at((a) => a[0] === "worktree")].slice(0, 4)).toEqual(["worktree", "create", "--cwd", repo]);
    expect(at((a) => a[2] === "w5:p1" && a[1] === "split")).toBeLessThan(at((a) => a[1] === "close" && a[2] === "w5:p1"));
    expect(envs.TRACESTATE).toBe("");
    expect(envs.TRACEPARENT.length).toBe(512);
    // Torn down: the worktree with its workspace, never its pane alone; the repository with the temporary folder.
    expect(calls.at(-1)).toEqual(["worktree", "remove", "--workspace", "w5"]);
    expect(calls.some((a) => a[1] === "close" && a[2] === "w5:p2")).toBe(false);
    expect(existsSync(repo)).toBe(false);
    expect(lines.join("\n")).not.toContain("routr-smoke-"); // never a carrier value
  } finally { rmSync(tree, { recursive: true, force: true }); }
});
