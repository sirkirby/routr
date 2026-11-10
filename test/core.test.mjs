// Workers in herdr-core: what a harness keeps of a core terminal, `routr watch`, and doctor. No hc and no harness run.
import { expect, test } from "bun:test";
import { changes, statusReport } from "../src/lib/watch.mjs";
import { KINDS, HARNESSES } from "../src/lib/harnesses.mjs";
import { harnessEnv } from "../src/lib/runtime.mjs";

test("a harness never takes itself for the lead's core terminal, and HC_SESSION, which chooses a core, stays", () => {
  const kept = harnessEnv({ HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/s", HC_SCOPE: "x", HC_SESSION: "mine" });
  expect(kept).toEqual({ HC_SESSION: "mine" });
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
  expect(changes(v({ last_tool: "Read", tasks: 1 }), seen)).toEqual(["working, turn 1, Read, 1 background command"]);
  expect(changes(v({ last_tool: "Read", tasks: 0 }), seen)).toEqual(["working, turn 1, Read"]);
  const ended = v({ state: "idle", last_tool: "Read", turns: [{ turn: 1, outcome: "finished", report: "/r/turn-1.md" }] });
  expect(changes(ended, seen, "12:00:00")).toEqual(["12:00:00  turn 1 ended (finished): report at /r/turn-1.md", "12:00:00  idle, turn 1"]);
  expect(changes(ended, seen)).toEqual([]);
  expect(changes(v({ state: "unreadable", turns: [] }), seen)).toEqual([]);
});

test("doctor sends an app user to neither the older herdr nor its skill, and says what the app gives", async () => {
  const { nextSteps, render } = await import("../src/lib/doctor.mjs");
  const r = (core, herdr) => ({ runtime: "routr 0.0.0-dev (from source)", from_source: true, core, herdr, skill: [], harnesses: {}, decision: [],
    config: { path: "/c.json", exists: true, subscriptions: [], off: [], problems: [], notes: [] }, auto_update: { on: false, why_off: "running from source" }, next_steps: [] });
  const none = { path: null, inside_terminal: false }, app = { path: "/bin/hc", inside_terminal: true }, installed = { path: "/bin/hc", inside_terminal: false };
  const told = (x, platform = "darwin") => nextSteps(x, { platform }).filter((s) => /herdr/i.test(s));
  // Neither: both ways to see workers are named.
  expect(told(r(none, { path: null, skill: false }))[0]).toContain("https://herdr.dev/download/");
  // Terminal herdr without its skill still needs it for panes; with the app it does not.
  expect(told(r(none, { path: "/bin/herdr", skill: false }))[0]).toContain("skills add herdrdev/herdr");
  expect(told(r(app, { path: "/bin/herdr", skill: false }))).toEqual([]);
  // A lead in herdr uses panes and needs the skill, whatever else is installed.
  const inHerdr = r(installed, { path: "/bin/herdr", skill: false, inside_session: true });
  expect(told(inHerdr)[0]).toContain("skills add herdrdev/herdr");
  expect(render(inHerdr)).toContain("herdr skill not found");
  // With the app and no herdr, nothing asks for it, except Cursor's usage on Windows.
  expect(told(r(app, { path: null, skill: false }))).toEqual([]);
  expect(told(r(app, { path: null, skill: false }), "win32")).toEqual([expect.stringContaining("Cursor's usage")]);
  expect(told(r(none, { path: null, skill: false }))[0]).not.toContain("Cursor's usage");
  expect(told(r(none, { path: null, skill: false }), "win32")[0]).toContain("Cursor's usage");
  const inApp = render(r(app, { path: null, skill: false }), { platform: "darwin" });
  expect(inApp).not.toContain("Cursor's usage");
  expect(render(r(app, { path: null, skill: false }), { platform: "win32" })).toContain("Cursor's usage");
  expect(inApp).toContain("a tab of its own in the Herdr app");
  expect(inApp).toContain("The Herdr app does not need it otherwise");
  expect(inApp).not.toContain("herdr skill");
  expect(render(r(installed, { path: "/bin/herdr", skill: false }))).toContain("a lead in the Herdr app shows each worker");
  expect(render(r(none, { path: null, skill: false }))).toContain("Without it, workers run headless");
});
