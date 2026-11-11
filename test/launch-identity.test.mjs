// A launch's identity: its id and what a valid one is, the two rules that decide what a launch is, what the launch
// history and the launch index share, and every launch outcome driven end to end with fakes, its answer, history and
// index read together. No herdr, hc or harness runs here.
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cfg, scratch } from "./helpers.mjs";
import { countsTowardShare, findableByRerun, isLaunchId, launchIdOfFile, newLaunchId, storeWritable, sweepLaunches, takesOver } from "../src/lib/launch-identity.mjs";
import { launch } from "../src/lib/launch.mjs";
import { readHistory } from "../src/lib/launch-history.mjs";
import { LaunchIndex } from "../src/lib/launch-index.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { prepareOtel } from "../src/lib/otel.mjs";

test("a launch id is a lowercase random UUID, and a store's file is named for one", () => {
  const id = newLaunchId();
  expect(isLaunchId(id)).toBe(true);
  expect(newLaunchId()).not.toBe(id);
  for (const bad of [id.toUpperCase(), "019a1aaa-1234-7123-8123-123456789abc", "12345678-1234-4123-7123-123456789abc", `${id}.json`, ` ${id}`, "", null, undefined, 1, [id], { toString: () => id }])
    expect(isLaunchId(bad)).toBe(false);
  expect(launchIdOfFile(`${id}.json`)).toBe(id);
  for (const name of [id, `${id}.json.tmp`, `x${id}.json`, "keep.json", `${id.toUpperCase()}.json`, null]) expect(launchIdOfFile(name)).toBeNull();
});

// Every outcome launch can end in, on every backend, as a plain launch and as a `--pane` rerun that found the launch it
// finishes. `started`: a worker is there (a pane or a worker record), which every outcome past a start has.
const STATES = ["planned", "failed", "ready", "prompted", "needs_input"], BACKENDS = ["pane", "terminal", "headless"];
const started = (state) => ["ready", "prompted", "needs_input"].includes(state);
test("each outcome × backend × rerun: whether it counts toward the share, and whether a rerun can find it", () => {
  const expected = {
    //                       counts: pane, terminal, headless     findable: plain, rerun
    planned:     { counts: [false, false, false], findable: [false, false] },
    failed:      { counts: [false, false, false], findable: [false, false] },
    ready:       { counts: [true, true, true], findable: [true, true] },
    prompted:    { counts: [true, true, true], findable: [true, true] },
    // A pane worker at a question has an index entry and no launch_id: the rerun that finishes it counts.
    needs_input: { counts: [false, true, false], findable: [true, false] },
  };
  for (const state of STATES) for (const [b, backend] of BACKENDS.entries()) for (const [r, finishes] of [false, true].entries()) {
    const row = { state, backend, started: started(state), finishes };
    expect([state, backend, finishes, countsTowardShare(row), findableByRerun(row)]).toEqual([state, backend, finishes, expected[state].counts[b], expected[state].findable[r]]);
    // Only a rerun that delivered its task takes over; one turned away leaves the original's entry.
    expect(takesOver(row)).toBe(finishes && ["ready", "prompted"].includes(state));
  }
  // Nothing is findable without a started worker, whatever its state says.
  for (const state of STATES) for (const finishes of [false, true]) expect(findableByRerun({ state, started: false, finishes })).toBe(false);
});

test("the stores' sweep removes only expired files named for a launch, and stops for uninstall or a linked folder", () => {
  const home = scratch("identity-sweep"), state = join(home, ".local/state/routr"), dir = join(state, "store");
  expect(storeWritable(home)).toBe(false); // no state folder yet
  mkdirSync(dir, { recursive: true });
  expect(storeWritable(home)).toBe(true);
  const old = newLaunchId(), fresh = newLaunchId(), folder = newLaunchId();
  // (No uppercase name here: macOS and Windows folders ignore case; launchIdOfFile is checked above.)
  for (const n of [`${old}.json`, `${fresh}.json`, "keep.json", `${fresh}.json.tmp`]) writeFileSync(join(dir, n), "{}");
  mkdirSync(join(dir, `${folder}.json`));
  const asked = [];
  sweepLaunches(dir, home, (n) => { asked.push(n); return n !== `${fresh}.json`; });
  // Asked only of its own names; a folder named like one is never removed.
  expect(asked.sort()).toEqual([`${folder}.json`, `${fresh}.json`, `${old}.json`].sort());
  expect(readdirSync(dir).sort()).toEqual([`${folder}.json`, `${fresh}.json`, `${fresh}.json.tmp`, "keep.json"].sort());
  // An expiry reading that throws removes nothing and stops nothing.
  sweepLaunches(dir, home, () => { throw new Error("unreadable"); });
  expect(readdirSync(dir)).toContain(`${fresh}.json`);
  // A linked folder is not the store's.
  const linked = join(state, "linked"); symlinkSync(dir, linked, "junction");
  sweepLaunches(linked, home, () => true);
  expect(readdirSync(dir)).toContain(`${fresh}.json`);
  // Uninstall: nothing removed, and a sweep it overtakes stops at the next file.
  writeFileSync(join(state, "uninstalling"), "{}");
  expect(storeWritable(home)).toBe(false);
  sweepLaunches(dir, home, () => true);
  expect(readdirSync(dir)).toContain(`${fresh}.json`);
});

test("an uninstall that begins during a sweep stops it before its next removal", () => {
  const home = scratch("identity-overtaken"), state = join(home, ".local/state/routr"), dir = join(state, "store");
  mkdirSync(dir, { recursive: true });
  const ids = [newLaunchId(), newLaunchId()];
  for (const id of ids) writeFileSync(join(dir, `${id}.json`), "{}");
  let first = true;
  sweepLaunches(dir, home, () => { if (first) { first = false; return true; } writeFileSync(join(state, "uninstalling"), "{}"); return true; });
  expect(readdirSync(dir)).toHaveLength(1);
});

// ---- every launch outcome, end to end: its answer, its history and its index ----------------------------------------
const attrs = (s) => Object.fromEntries(s.attributes.map(({ key, value }) => [key, value.stringValue ?? value.boolValue]));
const TASK = "Rename the parser's private helper. Verify with bun test. IDENTITY_BRIEF_MARKER";
// One home with OpenTelemetry export on, so the launch index is written; the history and the run folders live there too.
function world() {
  const home = scratch("identity"), configPath = join(home, "config.json");
  const config = cfg({ subscriptions: {}, otel: { endpoint: "http://127.0.0.1:4318", consent: "1234567890abcdef1234567890abcdef" } });
  writeFileSync(configPath, JSON.stringify(config)); prepareOtel({ home }); mkdirSync(join(home, ".local/state/routr"), { recursive: true });
  const advice = join(home, "advice.json");
  writeFileSync(advice, JSON.stringify({ id: "abc12345", brief_sha: briefSha(TASK), mode: "dispatch", level: "standard" }));
  const traces = join(home, ".cache/routr/otel/traces"), index = new LaunchIndex({ home });
  const spans = () => readdirSync(traces).filter((n) => n.endsWith(".json")).flatMap((n) => JSON.parse(readFileSync(join(traces, n), "utf8")).resourceSpans[0].scopeSpans[0].spans).filter((s) => s.name === "routr launch");
  let tick = 1800000000000;
  const otel = { home, configPath, now: () => tick++, spawn: () => true };
  // Each launch's answer, its history and index as they are after it, and the id its trace carries.
  const go = async (args, opts) => {
    const before = new Set(spans().map((s) => s.spanId)), prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = home; // run folders, as launch writes them
    let r; try { r = await launch(args, { settings: () => ({ config }), otel, home, ready: async () => null, models: async () => null, ...opts }); }
    finally { Object.assign(process.env, prior); }
    const span = spans().find((s) => !before.has(s.spanId));
    return { r, history: readHistory({ home }).records, entries: index.entries(), traced: span ? attrs(span)["routr.launch.id"] : null };
  };
  return { home, advice, go, task: (...more) => ["--task", TASK, "--advice", advice, ...more] };
}
const template = (r) => r.next.find((n) => n.template?.startsWith("routr record"))?.template ?? "";

// A herdr pane: a shell that may ask a question at startup, then an agent that may be busy. `s` is changed between launches.
const paneHerdr = (s) => async (a) => {
  const ok = (result) => ({ ok: true, data: { result } });
  if (a[0] === "pane" && a[1] === "get") return ok({ pane: { pane_id: "w1:p2", terminal_id: "term-1" } });
  if (a[1] === "split") return ok({ pane: { pane_id: "w1:p2" } });
  if (a[1] === "read") return ok({ text: s.started ? "Welcome\n❯" : s.question ? "Load the project environment? [y/N]" : "user % " });
  if (a[1] === "process-info") return ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, cwd: process.cwd() }] } });
  if (a[1] === "start") { s.started = true; return ok({}); }
  if (a[0] === "agent" && a[1] === "get") return s.started ? ok({ agent: { agent: "claude", agent_status: s.busy ? "working" : "idle", interactive_ready: true, cwd: process.cwd() } }) : { ok: false, data: { error: { code: "agent_not_found" } } };
  return ok({});
};
const paneOpts = (s) => { let ticks = 0; return { env: { HERDR_ENV: "1" }, run: paneHerdr(s), now: () => ticks, sleep: async (ms) => { ticks += ms; } }; };
const paneArgs = ["--kind", "claude", "--name", "worker", "--model", "sonnet"], newPane = [...paneArgs, "--direction", "right"], rerunPane = [...paneArgs, "--pane", "w1:p2", "--cwd", process.cwd()];

test("planned and failed launches have no id, no history and no index entry, on every backend", async () => {
  const w = world();
  const planned = await w.go([...newPane, ...w.task("--dry-run")], { env: { HERDR_ENV: "1" }, run: () => { throw new Error("a dry run called herdr"); } });
  const failedPane = await w.go([...newPane, ...w.task()], { env: { HERDR_ENV: "1" }, run: async () => ({ ok: false }) });
  const failedTerminal = await w.go([...paneArgs, ...w.task()], { env: { HC_TERMINAL_ID: "t3" }, hc: async () => ({ code: 1, out: "" }), self: (a) => ["/bin/routr", ...a] });
  const failedHeadless = await w.go([...paneArgs, ...w.task()], { env: {}, spawn: () => false });
  for (const [state, o] of [["planned", planned], ["failed", failedPane], ["failed", failedTerminal], ["failed", failedHeadless]]) {
    expect([o.r.state, o.r.launch_id, o.history, o.entries]).toEqual([state, null, [], []]);
    expect(template(o.r)).not.toContain("--launch");
  }
});

test("a pane launch: prompted and ready count and are findable; needs_input is findable only, and the rerun that finishes it counts", async () => {
  const w = world();
  // Prompted: one id in its answer, its template, its history record, its trace and its index entry.
  const p = await w.go([...newPane, ...w.task()], paneOpts({}));
  expect(p.r.state).toBe("prompted");
  expect(isLaunchId(p.r.launch_id)).toBe(true);
  expect(template(p.r)).toContain(`--launch ${p.r.launch_id}`);
  expect(p.history.map((h) => [h.launch_id, h.backend, h.id])).toEqual([[p.r.launch_id, "pane", "abc12345"]]);
  expect([p.traced, p.entries.map((e) => [e.launch_id, e.backend, e.advice_id, e.pane_id, Boolean(e.finished_at)])]).toEqual([p.r.launch_id, [[p.r.launch_id, "pane", "abc12345", "w1:p2", false]]]);

  // Ready, with no task: counts and is indexed, with no advice.
  const r = await w.go(newPane, paneOpts({}));
  expect(r.r.state).toBe("ready");
  expect(isLaunchId(r.r.launch_id)).toBe(true);
  expect(r.history.map((h) => h.launch_id)).toEqual([p.r.launch_id, r.r.launch_id]);
  expect(r.entries.find((e) => e.launch_id === r.r.launch_id)).toMatchObject({ launch_id: r.traced, advice_id: null, backend: "pane" });
  for (const id of [p.r.launch_id, r.r.launch_id]) new LaunchIndex({ home: w.home }).finish(id);

  // Needs input at a shell question: no launch_id and no history record, but an index entry under its trace's id.
  const s = { question: true }, q = await w.go([...newPane, ...w.task()], paneOpts(s));
  expect([q.r.state, q.r.launch_id, q.history.length]).toEqual(["needs_input", null, 2]);
  expect(template(q.r)).not.toContain("--launch");
  const waiting = q.entries.find((e) => !e.finished_at);
  expect(waiting).toMatchObject({ launch_id: q.traced, advice_id: "abc12345", pane_id: "w1:p2", terminal_id: "term-1" });

  // The question answered and the agent up: a rerun that is turned away (the agent busy) delivers nothing and changes nothing.
  Object.assign(s, { question: false, started: true, busy: true });
  const away = await w.go([...rerunPane, ...w.task()], paneOpts(s));
  expect([away.r.state, away.r.launch_id, away.history.length]).toEqual(["needs_input", null, 2]);
  expect(away.entries).toEqual(q.entries);

  // The rerun that finishes it: its own id, counted once, and the waiting entry ends as its own takes over.
  s.busy = false;
  const done = await w.go([...rerunPane, ...w.task()], paneOpts(s));
  expect(done.r.state).toBe("prompted");
  expect(isLaunchId(done.r.launch_id)).toBe(true);
  expect(done.r.launch_id).not.toBe(waiting.launch_id);
  expect(done.history.map((h) => h.launch_id)).toEqual([p.r.launch_id, r.r.launch_id, done.r.launch_id]);
  expect(done.entries.find((e) => e.launch_id === waiting.launch_id).finished_at).toEqual(expect.any(String));
  expect(done.entries.filter((e) => !e.finished_at).map((e) => e.launch_id)).toEqual([done.r.launch_id]);
  expect(done.traced).toBe(done.r.launch_id);
  // No store holds the brief.
  for (const dir of ["launch-counts", "launches"]) for (const f of readdirSync(join(w.home, ".local/state/routr", dir))) expect(readFileSync(join(w.home, ".local/state/routr", dir, f), "utf8")).not.toContain("IDENTITY_BRIEF_MARKER");
});

// A herdr-core terminal: the lead in t3, the worker's terminal t9 at `status` once started.
const terminalHc = (status) => {
  let label = null;
  const answer = (o) => ({ code: 0, out: JSON.stringify(o) });
  return async (cmd, a) => {
    if (a[0] === "run") label = a.find((v) => v.startsWith("routr.worker="))?.slice("routr.worker=".length);
    return cmd === "herdr-app" ? answer({}) : a[0] === "get" && a[1] === "t3" ? answer({ address: "t3", labels: {} })
      : a[0] === "get" ? answer({ address: "t9", name: "traced", state: "live", labels: { "routr.worker": label }, status, turn: status.state === "done" ? 1 : 0 })
      : a[0] === "run" ? answer({ address: "t9" }) : answer({});
  };
};
test("a terminal launch counts and is findable whether it took its task or stopped at a question", async () => {
  const w = world(), opts = (status) => ({ env: { HC_TERMINAL_ID: "t3" }, hc: terminalHc(status), self: (a) => ["/bin/routr", ...a], sleep: async () => {} });
  const p = await w.go(["--kind", "claude", "--name", "traced", "--model", "sonnet", ...w.task()], opts({ state: "done" }));
  const q = await w.go(["--kind", "claude", "--name", "asking", "--model", "sonnet", ...w.task()], opts({ state: "blocked", kind: "question" }));
  expect([p.r.state, q.r.state]).toEqual(["prompted", "needs_input"]);
  for (const o of [p, q]) {
    expect(isLaunchId(o.r.launch_id)).toBe(true);
    expect(template(o.r)).toContain(`--launch ${o.r.launch_id}`);
    expect(o.history.find((h) => h.launch_id === o.r.launch_id)).toMatchObject({ backend: "terminal", name: o.r.name });
    expect(o.entries.find((e) => e.launch_id === o.traced)).toMatchObject({ backend: "terminal", pane_id: null });
    // The worker record keeps the launch its trace carries.
    expect(JSON.parse(readFileSync(join(w.home, ".local/state/routr/workers", o.r.name, "worker.json"), "utf8")).launch.launch_id).toBe(o.traced);
  }
  expect(existsSync(join(w.home, ".local/state/routr/launches"))).toBe(true);
});
