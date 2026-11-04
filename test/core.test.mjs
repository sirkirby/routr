// Workers in herdr-core: which path a lead takes, what routr asks of `hc`, and `routr watch`. No hc and no harness run.
import { expect, test } from "bun:test";
import { inCore, showWorker } from "../src/lib/core.mjs";
import { changes, statusReport } from "../src/lib/watch.mjs";
import { KINDS, HARNESSES } from "../src/lib/harnesses.mjs";
import { harnessEnv } from "../src/lib/runtime.mjs";

test("a pane wins, a core terminal comes next, and anything else is plain headless", () => {
  expect(inCore({ HC_TERMINAL_ID: "t7" })).toBe(true);
  expect(inCore({ HC_TERMINAL_ID: "t7", HERDR_ENV: "1" })).toBe(false);
  expect(inCore({ HERDR_ENV: "1" })).toBe(false);
  expect(inCore({})).toBe(false);
  expect(inCore({ HC_TERMINAL_ID: "" })).toBe(false);
});

test("a harness never takes itself for the lead's core terminal, and HC_SESSION, which chooses a core, stays", () => {
  const kept = harnessEnv({ HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/s", HC_SCOPE: "x", HC_SESSION: "mine" });
  expect(kept).toEqual({ HC_SESSION: "mine" });
});

// What `hc` and `herdr-app` are asked, answering as they were seen to (p50).
const fake = (answers = {}) => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    const a = answers[args[0]];
    if (a !== undefined) return typeof a === "function" ? a(calls) : a;
    if (args[0] === "get") return { code: 0, out: JSON.stringify({ address: "t3", labels: { "herdr.space": "sp1", "herdr.tab": "tb1" } }) };
    if (args[0] === "run") return { code: 0, out: JSON.stringify({ address: "t9", name: "routr-w1" }) };
    return { code: 0, out: "{}" };
  };
  return { run, calls };
};
const show = (f, over = {}) => showWorker({ name: "w1", id: "abc", cwd: "/work", env: { HC_TERMINAL_ID: "t3", LEAD: "kept" }, run: f.run, self: (a) => ["/bin/routr", ...a], pause: async () => {}, ...over });

test("a lead in the app gets a tab named for its worker, in its own space, running watch and nothing of the brief", async () => {
  const f = fake();
  expect(await show(f)).toEqual({ terminal: "t9", tab: "routr-abc" });
  expect(f.calls.map((c) => [c.cmd, c.args[0]])).toEqual([["hc", "get"], ["hc", "run"], ["herdr-app", "do"]]);
  expect(f.calls[0].args).toEqual(["get", "t3", "--json"]);
  expect(f.calls[1].args).toEqual(["run", "--bg", "--json", "--name", "routr-w1", "--cwd", "/work", "--outlive-parent", "--no-notify", "--rm",
    "--label", "herdr.space=sp1", "--label", "herdr.tab=routr-abc", "--", "/bin/routr", "watch", "--name", "w1"]);
  expect(f.calls[2].args).toEqual(["do", "tab.rename", "--id", "routr-abc", "--name", "w1"]);
});

test("a long worker name still fits hc's limit", async () => {
  const f = fake(), name = "a".repeat(32);
  await show(f, { name });
  expect(f.calls[1].args[f.calls[1].args.indexOf("--name") + 1]).toBe(`routr-${"a".repeat(26)}`);
});

test("off the app there is no label to give, and nothing to name", async () => {
  const f = fake({ get: { code: 0, out: JSON.stringify({ address: "t3", labels: {} }) } });
  expect(await show(f)).toEqual({ terminal: "t9", tab: null });
  expect(f.calls.map((c) => c.args[0])).toEqual(["get", "run"]);
  expect(f.calls[1].args).not.toContain("--label");
});

test("a tab the app has not adopted yet is named again; one that never lands costs only its name", async () => {
  let tries = 0;
  const late = fake({ do: () => ({ code: ++tries < 3 ? 1 : 0, out: "" }) });
  expect(await show(late)).toEqual({ terminal: "t9", tab: "routr-abc" });
  expect(tries).toBe(3);
  const never = fake({ do: null });
  expect(await show(never)).toEqual({ terminal: "t9", tab: "routr-abc" });
  expect(never.calls.filter((c) => c.cmd === "herdr-app").length).toBe(6);
});

test("hc missing, refusing or unreadable is a code, and nothing further is asked", async () => {
  for (const [answers, code, calls] of [[{ get: null }, "not_available", 1], [{ get: { code: 3, out: "" } }, "refused", 1], [{ get: { code: 0, out: "no" } }, "unreadable", 1],
    [{ run: { code: 1, out: "" } }, "refused", 2], [{ run: { code: 0, out: "{}" } }, "unreadable", 2]]) {
    const f = fake(answers);
    expect(await show(f)).toEqual({ code });
    expect(f.calls.length).toBe(calls);
  }
  const f = fake();
  expect(await show(f, { self: () => null })).toEqual({ code: "not_available" });
});

const decoded = (s) => Object.fromEntries(s.slice("\x1b]7501;".length, -2).split(":").map((f) => f.split("=", 2)));
test("a worker's state reads as program status, in core's encoding, under its harness's own name", () => {
  for (const [state, status] of [["starting", "working"], ["working", "working"], ["waiting", "working"], ["idle", "done"], ["stopped", "idle"], ["failed", "error"], ["no_task", "error"], ["lost", "error"], ["unreachable", "error"]]) {
    const s = statusReport({ name: "w1", kind: "cursor", state });
    expect(s.startsWith("\x1b]7501;")).toBe(true);
    expect(s.endsWith("\x1b\\")).toBe(true);
    expect(decoded(s).state).toBe(status);
    expect(decoded(s).app).toBe("cursor");
    expect(Buffer.from(s.split("title=")[1].slice(0, -2), "base64").toString()).toBe("w1");
  }
  // It may be running: the last report stands.
  expect(statusReport({ name: "w1", kind: "cursor", state: "unreadable" })).toBeNull();
  for (const k of KINDS) expect(typeof HARNESSES[k].app).toBe("string");
});

test("watch says each change once, and only fixed words and paths", () => {
  const seen = { turns: new Set(), state: null, turn: null, tool: null };
  const v = (o) => ({ name: "w1", kind: "claude", state: "working", turn: 1, tasks: 0, last_tool: null, turns: [{ turn: 1, outcome: "running", report: null }], ...o });
  expect(changes(v({ state: "starting", turn: 0, turns: [] }), seen)).toEqual(["starting"]);
  expect(changes(v({}), seen)).toEqual(["working, turn 1"]);
  expect(changes(v({}), seen)).toEqual([]);
  expect(changes(v({ last_tool: "Bash" }), seen)).toEqual(["working, turn 1, Bash"]);
  expect(changes(v({ last_tool: "Bash" }), seen)).toEqual([]);
  expect(changes(v({ last_tool: "Read", tasks: 2 }), seen)).toEqual(["working, turn 1, Read, 2 background commands"]);
  const ended = v({ state: "idle", last_tool: "Read", turns: [{ turn: 1, outcome: "finished", report: "/r/turn-1.md" }] });
  expect(changes(ended, seen, "12:00:00")).toEqual(["12:00:00  turn 1 ended (finished): report at /r/turn-1.md", "12:00:00  idle, turn 1"]);
  expect(changes(ended, seen)).toEqual([]);
  expect(changes(v({ state: "unreadable", turns: [] }), seen)).toEqual([]);
});
