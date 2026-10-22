// Headless workers outside herdr: launch, wait, send, workers, stop, cleanup --worker, the holder and its channel. A fake
// `claude` stands in for Claude Code's stream-json mode, with the behaviours measured in prototypes p34 and p36.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { claim, connect, endpointFor, generations, ownEndpoint, probe, serve, SOCKET_DIR, writeSecret } from "../src/lib/channel.mjs";
import { readEvent } from "../src/lib/headless.mjs";
import { launch } from "../src/lib/launch.mjs";
import { harnessEnv, start, stop } from "../src/lib/runtime.mjs";
import { cfg, cliEnv, fakeExecutable, scratch, SCRIPT } from "./helpers.mjs";

// A worker's socket lives under its home, and macOS caps a socket path at 103 bytes: the test scratch folder under
// macOS's long tmpdir would be refused (path_too_long, tested below). So these homes sit in /tmp there, removed after.
const homes = [];
const shortHome = () => { const h = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rw-")); homes.push(h); return h; };
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
const POSIX = process.platform !== "win32";
const until = async (ok, ms = 10000) => { for (let t = 0; t < ms && !ok(); t += 50) await Bun.sleep(50); return ok(); };

// Claude Code's stream-json, as measured: init (with the session), tool_use, background_tasks_changed, result; a
// message on stdin mid-turn joins the running turn; with stdin closed it exits once no background task runs, and a
// background task's end starts a turn of its own. Words in the brief pick a behaviour: HOLD keeps the turn open until
// the test writes the gate file, FAIL ends it with an error, CRASH exits before any event, BACKGROUND leaves a task
// running, MCP uses an MCP tool, LINGER leaves a process in Claude's group that ignores SIGTERM.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "auth") { console.log('{"loggedIn": true, "authMethod": "claude.ai"}'); process.exit(0); }
if (!a.includes("--input-format")) process.exit(0); // any other read (usage) finds nothing
if (process.env.FAKE_ARGV) fs.appendFileSync(process.env.FAKE_ARGV, JSON.stringify(a) + "\\n");
const sid = a.includes("--resume") ? a[a.indexOf("--resume") + 1] : "11111111-2222-3333-4444-555555555555";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "", busy = false, tasks = 0, ended = false, mcp = false; const mid = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(text) {
  if (text.includes("CRASH")) process.exit(3);
  busy = true; mcp ||= text.includes("MCP"); out({ type: "system", subtype: "init", session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: mcp ? "mcp__srv__tool" : "Bash", input: { command: "an argument" } }] } });
  if (text.includes("LINGER")) { const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.env.FAKE_LINGER, String(process.pid)); setInterval(() => {}, 1000)"], { stdio: "ignore" }).unref(); }
  if (text.includes("HOLD")) for (let i = 0; i < 400 && !fs.existsSync(process.env.FAKE_GATE); i++) await sleep(50);
  if (text.includes("BACKGROUND")) { tasks = 1; out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t" }] }); }
  out({ type: "result", subtype: "success", is_error: text.includes("FAIL"), result: "VERDICT: done\\nSUMMARY: turn with " + mid.length + " mid-turn messages" });
  busy = false;
  if (text.includes("BACKGROUND")) { await sleep(500); tasks = 0; out({ type: "system", subtype: "background_tasks_changed", tasks: [] }); await turn("the background task ended"); }
  if (ended && !tasks) process.exit(0);
}
process.stdin.on("data", async (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const t = JSON.parse(l).message.content; if (busy) mid.push(t); else await turn(t); } });
process.stdin.on("end", () => { ended = true; if (!busy && !tasks) process.exit(0); });
`;
const BRIEF = "PRIVATE-BRIEF-7f3a: rename foo to bar in x.js. Check: grep bar x.js.";
const SENT = "PRIVATE-SEND-91c2: also rename baz.";

function world(over = {}) {
  const home = shortHome(), bin = join(home, "bin"), work = join(home, "work"), inputs = join(home, "inputs");
  for (const d of [bin, work, inputs]) mkdirSync(d, { recursive: true });
  fakeExecutable(bin, "claude", FAKE_CLAUDE);
  const gate = join(home, "gate"), linger = join(home, "linger");
  const env = cliEnv(home, { PATH: bin + delimiter + dirname(process.execPath), FAKE_ARGV: join(home, "argv.jsonl"), FAKE_GATE: gate, FAKE_LINGER: linger, ...over });
  for (const k of Object.keys(env)) if (/^(HERDR_|CLAUDECODE$|CLAUDE_CODE_SESSION|SANDBOX_RUNTIME$|CODEX_SANDBOX)/.test(k)) delete env[k];
  const outputs = [];
  const run = (args, extra = {}) => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: work, env: { ...env, ...extra }, stdin: "ignore" });
    const text = r.stdout.toString(); outputs.push(text, r.stderr.toString());
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  const task = (text, name = "task.md") => { const f = join(inputs, name); writeFileSync(f, text); return f; };
  const advise = (file) => { const a = join(home, `${file.split(/[\\/]/).pop()}.advice.json`); writeFileSync(a, JSON.stringify(run(["dispatch", "--task-file", file]))); return a; };
  const launchW = (name, file, more = [], extra) => run(["launch", "--kind", "claude", "--name", name, "--model", "haiku", "--task-file", file, "--advice", advise(file), ...more], extra);
  const runDir = (name) => join(home, ".local", "state", "routr", "workers", name);
  const state = (n) => { try { return JSON.parse(readFileSync(join(runDir(n), "state.json"), "utf8")); } catch { return {}; } };
  const settled = (n) => until(() => !["working", "waiting", "starting"].includes(state(n).state));
  return { home, work, gate, linger, inputs, env, run, outputs, task, advise, launch: launchW, runDir, state, settled, release: () => writeFileSync(gate, "") };
}
const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map(String).filter((f) => { try { return statSync(join(dir, f)).isFile(); } catch { return false; } });

test("a headless Claude worker: launch, a message mid-turn, wait, a follow-up that resumes its session, stop and cleanup", async () => {
  const w = world(), file = w.task(`${BRIEF} HOLD`);
  const l = w.launch("w1", file);
  expect([l.ok, l.state, l.headline]).toEqual([true, "prompted", "routr: w1 (claude) took its task, running headless"]);
  expect(l.worker).toEqual({ name: "w1", backend: "headless", run: w.runDir("w1"), session: "11111111-2222-3333-4444-555555555555" });
  expect(l.start.argv.slice(0, 6)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  expect(l.next.map((n) => n.argv ?? n.template)).toEqual([["routr", "wait", "--name", "w1"], expect.stringContaining("routr record --advice"), ["routr", "cleanup", "--worker", "w1"]]);
  // The turn is held open: the message goes into it, and a short wait times out with it still running.
  const s = w.run(["send", "--name", "w1", "--task", SENT]);
  expect([s.ok, s.state, s.message.code]).toEqual([true, "delivered", "handed_to_harness"]);
  expect(w.run(["workers"]).workers[0]).toMatchObject({ name: "w1", state: "working", turn: 1, last_tool: "Bash", report: null });
  expect(w.run(["wait", "--timeout", "300"])).toMatchObject({ ok: true, state: "running", headline: "routr: still running: w1", next: [{ kind: "run", argv: ["routr", "wait", "--name", "w1"] }] });
  w.release();
  const done = w.run(["wait", "--name", "w1", "--timeout", "20000"]);
  expect([done.ok, done.state, done.headline]).toEqual([true, "finished", "routr: w1 finished a turn"]);
  expect(done.workers[0].turns).toEqual([{ turn: 1, outcome: "finished", report: join(w.runDir("w1"), "reports", "turn-1.md"), delivered: 1 }]);
  expect(done.next[0]).toMatchObject({ kind: "do", template: expect.stringContaining("routr check --brief <task-file> --report") });
  expect(readFileSync(done.workers[0].turns[0].report, "utf8")).toContain("turn with 1 mid-turn messages");
  // A wait after that reports nothing twice; an idle worker is not running, and stop says so.
  await w.settled("w1");
  expect(w.run(["wait", "--name", "w1", "--timeout", "2000"])).toMatchObject({ ok: true, state: "idle", headline: "routr: nothing running: w1 idle" });
  expect(w.run(["stop", "--name", "w1"])).toMatchObject({ ok: true, state: "absent" });
  // Idle: a follow-up starts the next holder, which resumes the same session.
  const again = w.run(["send", "--name", "w1", "--task-file", w.task(SENT, "more.md")]);
  expect([again.state, again.message?.code, again.error]).toEqual(["resumed", "prompted", undefined]);
  const resumed = readFileSync(join(w.home, "argv.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x)).at(-1);
  expect(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2)).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
  expect(w.run(["wait", "--name", "w1", "--timeout", "20000"]).workers[0].turns.map((t) => t.turn)).toEqual([2]);
  expect(w.state("w1")).toMatchObject({ gen: 2, turn: 2 });
  // cleanup keeps a running worker; stop ends it through its own process.
  rmSync(w.gate, { force: true });
  expect(w.launch("w2", w.task(`${BRIEF} HOLD`, "slow.md")).state).toBe("prompted");
  expect(w.run(["cleanup", "--worker", "w2"])).toMatchObject({ ok: false, state: "refused", headline: "routr: kept w2: w2 is still running",
    next: [{ kind: "run", argv: ["routr", "wait", "--name", "w2"] }, { kind: "run", argv: ["routr", "stop", "--name", "w2"] }] });
  expect(w.run(["stop", "--name", "w2"])).toMatchObject({ ok: true, state: "stopped", headline: "routr: stopped w2" });
  expect(w.state("w2")).toMatchObject({ state: "stopped", turns: [expect.objectContaining({ outcome: "stopped" })] });
  expect(w.run(["wait", "--name", "w2", "--timeout", "2000"])).toMatchObject({ state: "finished", headline: "routr: w2 stopped" });
  await w.settled("w1");
  expect(w.run(["cleanup", "--worker", "w1", "--dry-run"])).toMatchObject({ ok: true, state: "planned", name: "w1" });
  for (const n of ["w1", "w2"]) expect(w.run(["cleanup", "--worker", n])).toMatchObject({ ok: true, state: "removed", name: n });
  expect(existsSync(w.runDir("w1"))).toBe(false);
  expect(w.run(["cleanup", "--worker", "w1"])).toMatchObject({ ok: true, state: "absent" });
  expect(w.run(["cleanup", "--worker", "w1", "--cwd", w.work]).error).toBe("--worker takes no --cwd or --delete-branch: a headless worker's run folder is all it removes");
}, 90000);

test("the brief and messages reach the harness on stdin only: never an answer, an argument, or a file but the reports", async () => {
  const w = world(), l = w.launch("p1", w.task(`${BRIEF} HOLD`));
  expect(l.state).toBe("prompted");
  const dir = w.runDir("p1"), secret = readFileSync(join(dir, "secret"), "utf8");
  expect(w.run(["send", "--name", "p1", "--task", SENT]).state).toBe("delivered");
  w.release();
  w.run(["wait", "--name", "p1", "--timeout", "20000"]);
  w.run(["workers"]);
  await w.settled("p1");
  w.run(["send", "--name", "p1", "--task", SENT]);
  w.run(["wait", "--name", "p1", "--timeout", "20000"]);
  await w.settled("p1");
  w.run(["stop", "--name", "p1"]);
  // Every answer and every stderr, and every file under the home but the test's own inputs and the reports.
  for (const o of w.outputs) for (const m of ["PRIVATE-BRIEF", "PRIVATE-SEND", secret]) expect([m.slice(0, 13), o.includes(m)]).toEqual([m.slice(0, 13), false]);
  const files = filesUnder(w.home).filter((f) => !f.startsWith("inputs") && !f.split(/[\\/]/).includes("reports") && !f.startsWith("bin"));
  expect(files).toEqual(expect.arrayContaining([join(".local", "state", "routr", "workers", "p1", "state.json"), "argv.jsonl"]));
  for (const f of files) {
    const text = readFileSync(join(w.home, f), "utf8");
    for (const m of ["PRIVATE-BRIEF", "PRIVATE-SEND"]) expect([f, m, text.includes(m)]).toEqual([f, m, false]);
    if (!f.endsWith("secret")) expect([f, text.includes(secret)]).toEqual([f, false]);
  }
  if (POSIX) {
    expect(statSync(dir).mode & 0o077).toBe(0);
    for (const f of ["secret", "worker.json", join("reports", "turn-1.md")]) expect([f, statSync(join(dir, f)).mode & 0o077]).toEqual([f, 0]);
  }
  w.run(["cleanup", "--worker", "p1"]);
}, 60000);

test("a turn the harness starts itself, after a background command ends, is waited on like any other", async () => {
  const w = world();
  expect(w.launch("bg", w.task(`${BRIEF} BACKGROUND MCP`)).state).toBe("prompted");
  const seen = [];
  for (let i = 0; i < 3 && seen.length < 2; i++) seen.push(...w.run(["wait", "--name", "bg", "--timeout", "20000"]).workers[0].turns.map((t) => [t.turn, t.outcome]));
  expect(seen).toEqual([[1, "finished"], [2, "finished"]]);
  expect(w.state("bg").last_tool).toBe("mcp");
  await w.settled("bg");
  expect(w.state("bg").state).toBe("idle");
  w.run(["cleanup", "--worker", "bg"]);
}, 60000);

test("after a failed turn, wait reports the failure once, then the turn a follow-up resumes", async () => {
  const w = world();
  expect(w.launch("f1", w.task(`${BRIEF} FAIL`)).state).toBe("prompted");
  const first = w.run(["wait", "--name", "f1", "--timeout", "20000"]);
  expect(first.workers[0].turns).toMatchObject([{ turn: 1, outcome: "failed" }]);
  await w.settled("f1");
  // The worker's failed state is said once: with its turn, or by the next wait, never twice.
  const later = [w.run(["wait", "--name", "f1", "--timeout", "2000"]), w.run(["wait", "--name", "f1", "--timeout", "1000"])];
  expect([first, ...later].filter((r) => r.headline === "routr: f1 failed").length).toBeLessThanOrEqual(1);
  expect(later[1]).toMatchObject({ state: "idle" });
  expect(w.run(["send", "--name", "f1", "--task", "try again"]).state).toBe("resumed");
  const second = w.run(["wait", "--name", "f1", "--timeout", "20000"]);
  expect(second.workers[0].turns).toMatchObject([{ turn: 2, outcome: "finished" }]);
  await w.settled("f1");
  w.run(["cleanup", "--worker", "f1"]);
}, 60000);

test("a harness that ends before its session leaves a failed worker that send will not resume", async () => {
  const w = world();
  const l = w.launch("c1", w.task(`${BRIEF} CRASH`));
  expect([l.ok, l.state, l.error]).toEqual([false, "failed", "Launch failed after prompt submission: Claude Code ended before it started the task (harness_ended)"]);
  expect(l.next.map((n) => n.argv ?? n.template)).toEqual(expect.arrayContaining([["routr", "workers", "--name", "c1"], ["routr", "cleanup", "--worker", "c1"]]));
  await w.settled("c1");
  expect(w.state("c1")).toMatchObject({ state: "failed", session_id: null, turns: [expect.objectContaining({ outcome: "no_finish" })] });
  expect(w.run(["send", "--name", "c1", "--task", "again"]).error).toBe("c1 has no session to resume; launch the work again");
  expect(w.run(["send", "--name", "nobody", "--task", "x"]).error).toBe("no headless worker named nobody; routr workers lists them");
  w.run(["cleanup", "--worker", "c1"]);
}, 60000);

test("outside herdr, launch refuses what a headless worker cannot do, before it writes or starts anything", async () => {
  const w = world(), file = w.task(BRIEF), advice = w.advise(file);
  const go = (args, extra) => w.run(["launch", "--name", "r1", "--model", "m", "--task-file", file, "--advice", advice, ...args], extra);
  expect(go(["--kind", "codex"]).error).toBe("outside herdr, routr launch starts Claude Code workers only; run the lead inside herdr for a Codex worker");
  expect(go(["--kind", "claude", "--worktree", "b"]).error).toBe("--worktree needs herdr; outside herdr a worker runs headless in --cwd");
  expect(w.run(["launch", "--kind", "claude", "--name", "r1", "--model", "m"]).error).toBe("outside herdr a worker starts with its task: pass --task-file (or --task) and --advice");
  for (const [k, which] of [["SANDBOX_RUNTIME", "Claude Code's Bash sandbox"], ["CODEX_SANDBOX", "Codex's sandbox"]]) expect(go(["--kind", "claude"], { [k]: "1" }).error).toStartWith(`this command runs inside ${which}`);
  expect(w.run(["workers"], { SANDBOX_RUNTIME: "1" }).warnings[0]).toStartWith("this command runs inside Claude Code's Bash sandbox, which may keep it from reaching");
  // Called in-process for the seams: signed out, the subscription off, and a holder that never starts.
  const saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = w.home;
  try {
    const args = ["--kind", "claude", "--name", "r2", "--model", "m", "--task-file", file, "--advice", advice, "--cwd", w.work];
    const deps = { env: {}, settings: () => cfg(), ready: async () => null, spawn: () => false };
    expect((await launch(args, { ...deps, ready: async () => "not signed in: run `claude auth login`" })).error).toBe("Claude Code cannot take work: not signed in: run `claude auth login`");
    expect((await launch(args, { ...deps, settings: () => cfg({ subscriptions: { claude: { enabled: false } } }) })).error).toContain("turned off");
    const never = await launch(args, deps);
    expect([never.state, never.error, never.worker]).toEqual(["failed", "the worker's process did not start (not_started)", null]);
  } finally { [process.env.HOME, process.env.USERPROFILE] = saved; }
  expect(existsSync(w.runDir("r1"))).toBe(false);
  expect(existsSync(w.runDir("r2"))).toBe(false);
  expect(w.run(["wait"])).toMatchObject({ ok: true, state: "none" });
});

test.skipIf(!POSIX)("a home whose socket path would be too long is refused before anything is written", () => {
  const w = world({ HOME: join(scratch("long"), "h".repeat(80)) });
  const r = w.launch("w1", w.task(BRIEF));
  expect([r.ok, r.state]).toEqual([false, "failed"]);
  expect(r.error).toContain("the worker's socket path would be longer than this system allows");
  expect(existsSync(join(w.env.HOME, ".local", "state", "routr", "workers", "w1"))).toBe(false);
}, 30000);

test.skipIf(!POSIX)("a holder killed mid-turn reads as lost, and cleanup keeps the worker while its harness's group lives", async () => {
  const w = world();
  expect(w.launch("k1", w.task(`${BRIEF} HOLD`)).state).toBe("prompted");
  const st = w.state("k1");
  process.kill(st.holder_pid, "SIGKILL");
  await Bun.sleep(200);
  expect(w.run(["workers", "--name", "k1"]).workers[0]).toMatchObject({ state: "lost", harness_group: st.harness_pgid });
  expect(w.run(["cleanup", "--worker", "k1"])).toMatchObject({ state: "refused", headline: `routr: kept k1: k1's harness may still be running (process group ${st.harness_pgid})` });
  expect(w.run(["send", "--name", "k1", "--task", "x"]).error).toStartWith("k1's harness may still be running");
  expect(w.run(["stop", "--name", "k1"])).toMatchObject({ ok: false, state: "lost" });
  expect(w.run(["wait", "--name", "k1", "--timeout", "5000"])).toMatchObject({ state: "finished", headline: "routr: k1 lost" });
  try { process.kill(-st.harness_pgid, "SIGKILL"); } catch {}
  await until(() => { try { process.kill(-st.harness_pgid, 0); return false; } catch { return true; } });
  expect(w.run(["cleanup", "--worker", "k1"])).toMatchObject({ ok: true, state: "removed" });
}, 60000);

test.skipIf(!POSIX)("a process left in Claude's group after it exits keeps the worker from being resumed or removed", async () => {
  const w = world();
  expect(w.launch("g1", w.task(`${BRIEF} LINGER`)).state).toBe("prompted");
  w.run(["wait", "--name", "g1", "--timeout", "20000"]);
  await w.settled("g1");
  const st = w.state("g1");
  expect([st.state, Number.isInteger(st.harness_pgid)]).toEqual(["idle", true]);
  expect(w.run(["cleanup", "--worker", "g1"]).headline).toBe(`routr: kept g1: g1's harness may still be running (process group ${st.harness_pgid})`);
  expect(w.run(["send", "--name", "g1", "--task", "x"]).error).toStartWith("g1's harness may still be running");
  process.kill(Number(readFileSync(w.linger, "utf8")), "SIGKILL");
  await until(() => { try { process.kill(-st.harness_pgid, 0); return false; } catch { return true; } });
  expect(w.run(["cleanup", "--worker", "g1"])).toMatchObject({ ok: true, state: "removed" });
}, 60000);

test("Claude's stream as routr reads it: the session, turns, fixed tool names, background tasks, the turn's end", () => {
  const sid = "a85913d2-fe70-4450-8c5b-4ae162e7a5df";
  expect(readEvent(JSON.stringify({ type: "system", subtype: "init", session_id: sid, cwd: "/x", tools: [] }))).toEqual({ turn: true, session: sid });
  expect(readEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "not an id" }))).toEqual({ turn: true });
  expect(readEvent(JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b", description: "a private title" }] }))).toEqual({ tasks: 1 });
  expect(readEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "rm secret" } }] } }))).toEqual({ tool: "Bash" });
  expect(readEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__myco__search" }] } }))).toEqual({ tool: "mcp" });
  expect(readEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "SomethingNew" }] } }))).toEqual({ tool: "other" });
  expect(readEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } }))).toEqual({ activity: true });
  expect(readEvent(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "VERDICT: done" }))).toEqual({ result: { failed: false, text: "VERDICT: done" } });
  expect(readEvent(JSON.stringify({ type: "result", is_error: true }))).toEqual({ result: { failed: true, text: null } });
  for (const l of ["not json", "null", JSON.stringify({ type: "rate_limit_event" }), JSON.stringify({ type: "system", subtype: "hook_started" })]) expect(readEvent(l)).toBeNull();
});

test("the channel: one claimant per generation, and nothing for a peer that has not proved the secret", async () => {
  const home = shortHome(), saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const dir = join(home, "run"); mkdirSync(dir, { mode: 0o700 }); writeSecret(dir);
    // A claim not yet written (exclusive create, then the write) is a holder starting, never an abandoned one.
    writeFileSync(join(dir, "gen-1.claim"), "");
    expect((await probe(dir)).state).toBe("starting");
    rmSync(join(dir, "gen-1.claim"));
    expect([claim(dir, 1), claim(dir, 1), generations(dir)]).toEqual([true, false, [1]]);
    const endpoint = endpointFor("abcdef0123456789", 1);
    expect([ownEndpoint("abcdef0123456789", endpoint), ownEndpoint("abcdef0123456789", `${SOCKET_DIR()}X${endpoint.split(/[\\/]/).pop()}`), ownEndpoint("ffffffff01234567", endpoint)]).toEqual([true, false, false]);
    const server = await serve(dir, 1, endpoint, async (op, m) => ({ code: "ok", op, text: m.text }));
    const c = await connect(dir, 1, endpoint);
    expect(await c.request("send", { text: "hi" })).toMatchObject({ t: "res", code: "ok", op: "send", text: "hi" });
    c.close();
    expect(await connect(dir, 1, endpoint, { secret: "wrong" }).then(() => "connected", (e) => e.code)).toBe("server_unproven");
    expect(await connect(dir, 2, endpoint).then(() => "connected", (e) => e.code)).toBe("server_unproven"); // another generation's proof
    // Malformed handshakes get a fixed code and leave the server answering: an old protocol, a proof of the right
    // length in characters but not in bytes.
    const raw = (lines) => new Promise((r) => { const s = net.createConnection(endpoint); let got = ""; s.setEncoding("utf8");
      s.on("connect", () => { for (const l of lines) s.write(JSON.stringify(l) + "\n"); }); s.on("data", (d) => { got += d; }); s.on("close", () => r(got)); s.on("error", () => r(got)); setTimeout(() => { s.destroy(); r(got); }, 3000); });
    expect(await raw([{ t: "hello", v: 0, nc: "a".repeat(32) }])).toContain('"proto_mismatch"');
    expect(await raw([{ t: "hello", v: 1, nc: "a".repeat(32) }, { t: "proof", pc: "é".repeat(64) }])).toContain('"unproven"');
    const again = await connect(dir, 1, endpoint);
    expect((await again.request("ping")).code).toBe("ok");
    again.close(); server.close();
  } finally { [process.env.HOME, process.env.USERPROFILE] = saved; }
});

test("a harness gets none of the lead's session variables, and keeps its sign-in settings", () => {
  const env = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_PID: "1", CODEX_THREAD_ID: "c", HERDR_PANE_ID: "p",
    CLAUDE_CODE_OAUTH_TOKEN: "kept", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_HOME: "/c" };
  expect(harnessEnv(env)).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "kept", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_HOME: "/c" });
});

test.skipIf(!POSIX)("stop with group: true ends what a detached child started in its group, SIGTERM first", async () => {
  const dir = scratch("group"), pidFile = join(dir, "grandchild");
  const code = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1000);`;
  const child = start(process.execPath, ["-e", code], { stdio: "ignore", detached: true });
  await until(() => existsSync(pidFile));
  const g = Number(readFileSync(pidFile, "utf8"));
  const exited = new Promise((r) => child.once("exit", r));
  stop(child, { group: true });
  await exited;
  expect(await until(() => { try { process.kill(g, 0); return false; } catch { return true; } }, 3000)).toBe(true);
});
