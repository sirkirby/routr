// Headless workers outside herdr: launch, wait, send, workers, stop, cleanup --worker, the holder and its channel. A fake
// `claude` stands in for Claude Code's stream-json mode, with the behaviours measured in prototypes p34 and p36.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { claim, connect, endpointFor, generations, probe, serve, writeSecret } from "../src/lib/channel.mjs";
import { readEvent } from "../src/lib/headless.mjs";
import { harnessEnv, start, stop } from "../src/lib/runtime.mjs";
import { cliEnv, fakeExecutable, scratch, SCRIPT } from "./helpers.mjs";

// A worker's socket lives under its home, and macOS caps a socket path at 103 bytes: the test scratch folder under
// macOS's long tmpdir would be refused (path_too_long, tested below). So these homes sit in /tmp there, removed after.
const homes = [];
const shortHome = () => { const h = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rw-")); homes.push(h); return h; };
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
const POSIX = process.platform !== "win32";

// Claude Code's stream-json, as measured: init (with the session), tool_use, background_tasks_changed, result; a
// message on stdin mid-turn joins the running turn; with stdin closed it exits once no background task runs, and a
// background task's end starts a turn of its own. Words in the brief pick a behaviour.
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
  busy = true; mcp ||= text.includes("MCP"); out({ type: "system", subtype: "init", session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: mcp ? "mcp__srv__tool" : "Bash", input: { command: "an argument" } }] } });
  if (text.includes("SLOW")) await sleep(2500);
  if (text.includes("BACKGROUND")) { tasks = 1; out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t" }] }); }
  out({ type: "result", subtype: "success", is_error: false, result: "VERDICT: done\\nSUMMARY: turn with " + mid.length + " mid-turn messages" });
  busy = false;
  if (text.includes("BACKGROUND")) { await sleep(1000); tasks = 0; out({ type: "system", subtype: "background_tasks_changed", tasks: [] }); await turn("the background task ended"); }
  if (ended && !tasks) process.exit(0);
}
process.stdin.on("data", async (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const t = JSON.parse(l).message.content; if (busy) mid.push(t); else await turn(t); } });
process.stdin.on("end", () => { ended = true; if (!busy && !tasks) process.exit(0); });
`;
const BRIEF = "PRIVATE-BRIEF-7f3a: rename foo to bar in x.js. Check: grep bar x.js.";

function world(over = {}) {
  const home = shortHome(), bin = join(home, "bin"), work = join(home, "work"), argv = join(home, "argv.jsonl");
  for (const d of [bin, work]) mkdirSync(d, { recursive: true });
  fakeExecutable(bin, "claude", FAKE_CLAUDE);
  const env = cliEnv(home, { PATH: bin + delimiter + dirname(process.execPath), FAKE_ARGV: argv, ...over });
  for (const k of Object.keys(env)) if (/^(HERDR_|CLAUDECODE$|CLAUDE_CODE_SESSION|SANDBOX_RUNTIME$|CODEX_SANDBOX)/.test(k)) delete env[k];
  const run = (args, extra = {}) => { const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: work, env: { ...env, ...extra }, stdin: "ignore" });
    const text = r.stdout.toString(); outputs.push(text); try { return JSON.parse(text); } catch { return { raw: text, err: r.stderr.toString() }; } };
  const outputs = [];
  const task = (text, name = "task.md") => { const f = join(home, name); writeFileSync(f, text); return f; };
  const advise = (file) => { const a = join(home, `${file.split(/[\\/]/).pop()}.advice.json`); writeFileSync(a, JSON.stringify(run(["dispatch", "--task-file", file]))); return a; };
  const launch = (name, file, more = [], extra) => run(["launch", "--kind", "claude", "--name", name, "--model", "haiku", "--task-file", file, "--advice", advise(file), ...more], extra);
  const runDir = (name) => join(home, ".local", "state", "routr", "workers", name);
  return { home, work, argv, run, outputs, task, advise, launch, runDir, state: (n) => JSON.parse(readFileSync(join(runDir(n), "state.json"), "utf8")) };
}
const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile());

test("a headless Claude worker: launch, a message mid-turn, wait, a follow-up that resumes its session, stop and cleanup", async () => {
  const w = world(), file = w.task(`${BRIEF} SLOW`);
  const l = w.launch("w1", file);
  expect([l.ok, l.state, l.headline]).toEqual([true, "prompted", "routr: w1 (claude) took its task, running headless"]);
  expect(l.worker).toEqual({ name: "w1", backend: "headless", run: w.runDir("w1"), session: "11111111-2222-3333-4444-555555555555" });
  expect(l.start.argv.slice(0, 6)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  expect(l.next.map((n) => n.argv ?? n.template)).toEqual([["routr", "wait", "--name", "w1"], expect.stringContaining("routr record --advice"), ["routr", "cleanup", "--worker", "w1"]]);
  // While the slow turn runs: the message goes into it.
  const s = w.run(["send", "--name", "w1", "--task", "also rename baz"]);
  expect([s.ok, s.state, s.message.code]).toEqual([true, "delivered", "handed_to_harness"]);
  expect(w.run(["workers"]).workers[0]).toMatchObject({ name: "w1", state: "working", turn: 1, last_tool: "Bash" });
  const done = w.run(["wait", "--name", "w1", "--timeout", "20000"]);
  expect([done.ok, done.state, done.headline]).toEqual([true, "finished", "routr: w1 finished a turn"]);
  expect(done.workers[0].turns).toEqual([{ turn: 1, outcome: "finished", report: join(w.runDir("w1"), "reports", "turn-1.md"), delivered: 1 }]);
  expect(readFileSync(done.workers[0].turns[0].report, "utf8")).toContain("turn with 1 mid-turn messages");
  // A wait after that reports nothing twice.
  for (let i = 0; i < 40 && w.state("w1").state !== "idle"; i++) await Bun.sleep(100);
  expect(w.run(["wait", "--name", "w1", "--timeout", "2000"])).toMatchObject({ ok: true, state: "idle", headline: "routr: nothing running: w1 idle" });
  // Idle: a follow-up starts the next holder, which resumes the same session.
  const again = w.run(["send", "--name", "w1", "--task-file", w.task("one more change", "more.md")]);
  expect([again.state, again.message.code]).toEqual(["resumed", "prompted"]);
  const resumed = readFileSync(w.argv, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  expect(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2)).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
  expect(w.run(["wait", "--name", "w1", "--timeout", "20000"]).workers[0].turns.map((t) => t.turn)).toEqual([2]);
  expect(w.state("w1")).toMatchObject({ gen: 2, turn: 2 });
  // cleanup keeps a running worker; stop ends it through its own process.
  const slow = w.launch("w2", w.task(`${BRIEF} SLOW`, "slow.md"));
  expect(slow.state).toBe("prompted");
  expect(w.run(["cleanup", "--worker", "w2"])).toMatchObject({ ok: false, state: "refused", headline: "routr: kept w2: w2 is still running" });
  expect(w.run(["stop", "--name", "w2"])).toMatchObject({ ok: true, state: "stopped", headline: "routr: stopped w2" });
  expect(w.state("w2")).toMatchObject({ state: "stopped", turns: [expect.objectContaining({ outcome: "stopped" })] });
  for (let i = 0; i < 40 && w.state("w1").state !== "idle"; i++) await Bun.sleep(100);
  for (const n of ["w1", "w2"]) expect(w.run(["cleanup", "--worker", n])).toMatchObject({ ok: true, state: "removed" });
  expect(existsSync(w.runDir("w1"))).toBe(false);
  expect(w.run(["cleanup", "--worker", "w1"])).toMatchObject({ ok: true, state: "absent" });
  // The brief went to the harness on stdin only: never in its arguments, never in any answer.
  expect(readFileSync(w.argv, "utf8")).not.toContain("PRIVATE-BRIEF");
  for (const o of w.outputs) expect(o).not.toContain("PRIVATE-BRIEF");
}, 90000);

test("nothing of the brief is written in a worker's run folder but its reports, which only the owner can read", async () => {
  const w = world(), l = w.launch("w1", w.task(`${BRIEF} SLOW`));
  expect(l.state).toBe("prompted");
  w.run(["wait", "--name", "w1", "--timeout", "20000"]);
  const dir = w.runDir("w1"), files = filesUnder(dir);
  expect(files).toEqual(expect.arrayContaining(["worker.json", "state.json", "secret", "gen-1.claim", "gen-1.ready", join("reports", "turn-1.md")]));
  for (const f of files.filter((f) => !f.startsWith("reports"))) expect([f, readFileSync(join(dir, f), "utf8").includes("PRIVATE-BRIEF")]).toEqual([f, false]);
  if (POSIX) {
    expect(statSync(dir).mode & 0o077).toBe(0);
    for (const f of ["secret", "worker.json", join("reports", "turn-1.md")]) expect([f, statSync(join(dir, f)).mode & 0o077]).toEqual([f, 0]);
  }
  for (let i = 0; i < 40 && w.state("w1").state !== "idle"; i++) await Bun.sleep(100);
  w.run(["cleanup", "--worker", "w1"]);
}, 60000);

test("a turn the harness starts itself, after a background command ends, is waited on like any other", async () => {
  const w = world();
  expect(w.launch("bg", w.task(`${BRIEF} BACKGROUND MCP`)).state).toBe("prompted");
  const first = w.run(["wait", "--name", "bg", "--timeout", "20000"]);
  expect(first.workers[0].turns.map((t) => [t.turn, t.outcome])).toEqual([[1, "finished"]]);
  // The holder kept the harness's input open while the task ran, so the harness could start its own turn.
  const second = first.workers[0].turns.length === 1 ? w.run(["wait", "--name", "bg", "--timeout", "20000"]) : first;
  expect(second.workers[0].turns.map((t) => [t.turn, t.outcome])).toEqual([[2, "finished"]]);
  expect(w.state("bg").last_tool).toBe("mcp");
  for (let i = 0; i < 40 && w.state("bg").state !== "idle"; i++) await Bun.sleep(100);
  expect(w.state("bg").state).toBe("idle");
  w.run(["cleanup", "--worker", "bg"]);
}, 60000);

test("outside herdr, launch refuses what a headless worker cannot do, before it starts anything", () => {
  const w = world(), file = w.task(BRIEF), advice = w.advise(file);
  const go = (args, extra) => w.run(["launch", "--name", "r1", "--model", "m", "--task-file", file, "--advice", advice, ...args], extra);
  expect(go(["--kind", "codex"]).error).toBe("outside herdr, routr launch starts Claude Code workers only; run the lead inside herdr for a Codex worker");
  expect(go(["--kind", "claude", "--worktree", "b"]).error).toBe("--worktree needs herdr; outside herdr a worker runs headless in --cwd");
  expect(w.run(["launch", "--kind", "claude", "--name", "r1", "--model", "m"]).error).toBe("outside herdr a worker starts with its task: pass --task-file (or --task) and --advice");
  for (const [k, which] of [["SANDBOX_RUNTIME", "Claude Code's Bash sandbox"], ["CODEX_SANDBOX", "Codex's sandbox"]]) expect(go(["--kind", "claude"], { [k]: "1" }).error).toStartWith(`this command runs inside ${which}`);
  expect(existsSync(w.runDir("r1"))).toBe(false);
  expect(w.run(["wait"])).toMatchObject({ ok: true, state: "none" });
});

test.skipIf(!POSIX)("a home whose socket path would be too long is refused with that reason, and leaves nothing behind", () => {
  const w = world({ HOME: join(scratch("long"), "h".repeat(80)) });
  const r = w.launch("w1", w.task(BRIEF));
  expect([r.ok, r.state]).toEqual([false, "failed"]);
  expect(r.error).toContain("the worker's socket path would be longer than this system allows");
}, 30000);

test.skipIf(!POSIX)("a holder killed mid-turn reads as lost, and cleanup keeps the worker while its harness's group lives", async () => {
  const w = world();
  expect(w.launch("k1", w.task(`${BRIEF} SLOW`)).state).toBe("prompted");
  const st = w.state("k1");
  process.kill(st.holder_pid, "SIGKILL");
  await Bun.sleep(200);
  const seen = w.run(["workers", "--name", "k1"]).workers[0];
  expect(seen.state).toBe("lost");
  const kept = w.run(["cleanup", "--worker", "k1"]);
  if (seen.harness_group) expect(kept).toMatchObject({ state: "refused", headline: `routr: kept k1: k1's harness may still be running (process group ${st.harness_pgid})` });
  expect(w.run(["wait", "--name", "k1", "--timeout", "5000"])).toMatchObject({ state: "finished", headline: "routr: k1 lost" });
  try { process.kill(-st.harness_pgid, "SIGKILL"); } catch {}
  await Bun.sleep(300);
  expect(w.run(["cleanup", "--worker", "k1"])).toMatchObject({ ok: true, state: "removed" });
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

test("the channel: one claimant per generation, and neither side says anything to a peer that has not proved the secret", async () => {
  const home = shortHome(), saved = process.env.HOME;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const dir = join(home, "run"); mkdirSync(dir, { mode: 0o700 }); writeSecret(dir);
    expect([claim(dir, 1), claim(dir, 1), generations(dir)]).toEqual([true, false, [1]]);
    const endpoint = endpointFor("abcdef0123456789", 1);
    const server = await serve(dir, 1, endpoint, async (op, m) => ({ code: "ok", op, text: m.text }));
    const c = await connect(dir, 1, endpoint);
    expect(await c.request("send", { text: "hi" })).toMatchObject({ t: "res", code: "ok", op: "send", text: "hi" });
    c.close();
    expect(await connect(dir, 1, endpoint, { secret: "wrong" }).then(() => "connected", (e) => e.code)).toBe("server_unproven");
    expect(await connect(dir, 2, endpoint).then(() => "connected", (e) => e.code)).toBe("server_unproven"); // another generation's proof
    // No generation file names this endpoint yet: probe finds the claim and a live claimant.
    expect((await probe(dir)).state).toBe("starting");
    server.close();
  } finally { process.env.HOME = saved; process.env.USERPROFILE = saved; }
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
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await Bun.sleep(50);
  const g = Number(readFileSync(pidFile, "utf8"));
  const exited = new Promise((r) => child.once("exit", r));
  stop(child, { group: true });
  await exited; await Bun.sleep(200);
  expect(() => process.kill(g, 0)).toThrow();
});
