// Headless workers outside herdr: launch, wait, send, workers, stop, cleanup --worker, the holder and its channel. A fake
// `claude` stands in for Claude Code's stream-json mode, with the behaviours measured in prototypes p34 and p36.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { claim, connect, endpointFor, generations, ownEndpoint, probe, serve, SOCKET_DIR, writeSecret } from "../src/lib/channel.mjs";
import { ADAPTERS, agyReader, codexReader, kiroReader, readEvent } from "../src/lib/headless.mjs";
import { unmakeWorktree, view } from "../src/lib/workers.mjs";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { worktreesFromGit } from "../src/lib/cleanup.mjs";
import { callGit } from "../src/lib/process-boundary.mjs";
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
  if (ended && !tasks) leave();
}
process.stdin.on("data", async (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const t = JSON.parse(l).message.content; if (busy) mid.push(t); else await turn(t); } });
// FAKE_HOLD_EXIT: once its input closes, it stays until the test writes the gate file (a Claude slow to exit).
const leave = async () => { if (process.env.FAKE_HOLD_EXIT) for (let i = 0; i < 400 && !fs.existsSync(process.env.FAKE_GATE); i++) await sleep(50); process.exit(0); };
process.stdin.on("end", () => { ended = true; if (!busy && !tasks) leave(); });
`;
// Codex's app-server, as measured (p38): initialize, thread/start or thread/resume, turn/start answered at once and then
// turn/started, items, agentMessage phases, turn/completed; turn/steer joins the running turn and is refused once it has
// ended; closing its input ends it. It writes each request's method and settings, never its text, to FAKE_RPC, and a
// client's answer to a request of its own to FAKE_ANSWERS. Words in the text: HOLD, FAIL, CRASH, MCP as above; ASK sends
// a question request first; the model "nosuch" is refused.
const FAKE_CODEX = `
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "login") { console.error("Logged in using ChatGPT"); process.exit(0); }
if (a[0] !== "app-server") process.exit(0);
if (process.env.FAKE_ARGV) fs.appendFileSync(process.env.FAKE_ARGV, JSON.stringify(["codex", ...a]) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
const log = (m, p) => process.env.FAKE_RPC && fs.appendFileSync(process.env.FAKE_RPC, JSON.stringify({ method: m, ...Object.fromEntries(Object.entries(p ?? {}).filter(([k]) => k !== "input")) }) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let thread = null, turn = null, n = 0, steered = 0, buf = "", busy = false, ended = false;
async function run(id, text) {
  if (text.includes("CRASH")) process.exit(3);
  busy = true; turn = "turn-" + (++n); steered = 0;
  out({ id, result: { turn: { id: turn, items: [], status: "inProgress" } } });
  out({ method: "turn/started", params: { threadId: thread, turn: { id: turn, items: [], status: "inProgress" } } });
  out({ method: "item/started", params: { threadId: thread, turnId: turn, startedAtMs: 0, item: { type: text.includes("MCP") ? "mcpToolCall" : "commandExecution", id: "c", command: "an argument" } } });
  if (text.includes("ASK")) out({ id: 900, method: "item/tool/requestUserInput", params: { threadId: thread, turnId: turn, questions: [] } });
  if (text.includes("HOLD")) for (let i = 0; i < 400 && !fs.existsSync(process.env.FAKE_GATE); i++) await sleep(50);
  out({ method: "item/completed", params: { threadId: thread, turnId: turn, completedAtMs: 0, item: { type: "agentMessage", id: "m1", phase: "commentary", text: "COMMENTARY-not-the-report" } } });
  out({ method: "item/completed", params: { threadId: thread, turnId: turn, completedAtMs: 0, item: { type: "agentMessage", id: "m2", phase: "final_answer", text: "VERDICT: done\\nSUMMARY: turn with " + steered + " steered messages" } } });
  const t = turn; turn = null; busy = false;
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: t, items: [], status: text.includes("FAIL") ? "failed" : "completed" } } });
  if (ended) process.exit(0);
}
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const e = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (e.id != null && !e.method) { if (process.env.FAKE_ANSWERS) fs.appendFileSync(process.env.FAKE_ANSWERS, JSON.stringify(e) + "\\n"); continue; }
  log(e.method, e.params);
  const p = e.params ?? {};
  if (e.method === "initialize") out({ id: e.id, result: { userAgent: "fake" } });
  else if (e.method === "thread/start") { if (p.model === "nosuch") out({ id: e.id, error: { code: -32600, message: "model not found" } }); else { thread = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"; out({ id: e.id, result: { thread: { id: thread } } }); } }
  else if (e.method === "thread/resume") { thread = p.threadId; out({ id: e.id, result: { thread: { id: thread } } }); }
  else if (e.method === "turn/start") run(e.id, p.input[0].text);
  else if (e.method === "turn/steer") { if (turn && p.expectedTurnId === turn) { steered++; out({ id: e.id, result: { turnId: turn } }); } else out({ id: e.id, error: { code: -32600, message: "no active turn to steer" } }); }
} });
process.stdin.on("end", () => { ended = true; if (!busy) process.exit(0); });
`;
// Antigravity's stream-json, as measured (p39): init with the conversation, step_update steps (a tool's name), result
// with the response; a line written while a turn runs waits and runs as the next turn in the same process; closing
// stdin ends it once no turn runs. HOLD, FAIL, CRASH, MCP as above.
const FAKE_AGY = `
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "models") { console.log("gemini-3.8-flash-low"); process.exit(0); }
if (!a.includes("--input-format")) process.exit(0);
if (process.env.FAKE_ARGV) fs.appendFileSync(process.env.FAKE_ARGV, JSON.stringify(["agy", ...a]) + "\\n");
const conv = a.includes("--conversation") ? a[a.indexOf("--conversation") + 1] : "a67fd46b-3c80-4ed3-bf70-dc822b03ba83";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = "", busy = false, ended = false, n = 0, inited = false; const waiting = [];
async function turn(text) {
  if (text.includes("CRASH")) process.exit(3);
  busy = true; n++;
  if (!inited) { inited = true; out({ event: "init", conversation_id: conv, init: { model: "m", cwd: process.cwd(), tools: [] } }); }
  out({ event: "step_update", step_update: { conversation_id: conv, step_index: 0, state: "DONE", step_type: "user_input" } });
  out({ event: "step_update", step_update: { conversation_id: conv, step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: text.includes("MCP") ? "call_mcp_tool" : "run_command", tool_info: { command: "an argument" } } });
  if (text.includes("HOLD")) for (let i = 0; i < 400 && !fs.existsSync(process.env.FAKE_GATE); i++) await sleep(50);
  out({ event: "result", result: { conversation_id: conv, status: text.includes("FAIL") ? "ERROR" : "SUCCESS", response: "VERDICT: done\\nSUMMARY: turn " + n + " of this process", num_turns: n } });
  busy = false;
  if (waiting.length) return turn(waiting.shift());
  if (ended) process.exit(0);
}
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const e = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const t = e.message.content; if (busy) waiting.push(t); else turn(t); } });
process.stdin.on("end", () => { if (process.env.FAKE_EOF) fs.appendFileSync(process.env.FAKE_EOF, JSON.stringify({ turns: n, busy, waiting: waiting.length }) + "\\n"); ended = true; if (!busy) process.exit(0); });
`;
// Kiro's ACP mode, as measured (p40): initialize, session/new or session/load (which replays the session's history as
// updates first), session/prompt answered at the turn's end with a stopReason, text in agent_message_chunk updates, a
// second prompt while one runs refused ("Prompt already in progress"); closing stdin ends it. It writes each prompt's
// arrival (never its text) to FAKE_RPC. HOLD, FAIL, CRASH, ASK as above.
const FAKE_KIRO = `
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "whoami") { console.log(JSON.stringify({ email: "user@example.com" })); process.exit(0); }
if (a[0] === "chat" && a.includes("--list-models")) { console.log(JSON.stringify({ models: [{ model_id: "auto" }, { model_id: "claude-sonnet-5" }] })); process.exit(0); }
if (a[0] !== "acp") process.exit(0);
if (process.env.FAKE_ARGV) fs.appendFileSync(process.env.FAKE_ARGV, JSON.stringify(["kiro-cli", ...a]) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
const log = (o) => process.env.FAKE_RPC && fs.appendFileSync(process.env.FAKE_RPC, JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = "b7cad7ce-3a91-46bd-8a45-3af4a23b39b5";
let buf = "", busy = false, ended = false, n = 0;
const up = (update) => out({ method: "session/update", params: { sessionId: SID, update } });
async function prompt(id, text) {
  if (text.includes("CRASH")) process.exit(3);
  busy = true; n++;
  up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me look first." } });
  up({ sessionUpdate: "tool_call", toolCallId: "t" + n, title: "Running: an argument", kind: "execute", rawInput: { command: "an argument" } });
  out({ method: "_kiro.dev/metadata", params: { sessionId: SID, contextUsagePercentage: 1 } });
  if (text.includes("ASK")) out({ id: 900, method: "session/request_permission", params: { sessionId: SID } });
  if (text.includes("HOLD")) for (let i = 0; i < 400 && !fs.existsSync(process.env.FAKE_GATE); i++) await sleep(50);
  if (text.includes("DIE")) process.exit(0);
  up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "THOUGHT-not-the-report" } });
  for (const part of ["VERDICT: done\\nSUMMARY: kiro ", "turn " + n]) up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
  busy = false;
  out({ id, result: { stopReason: text.includes("FAIL") ? "refusal" : "end_turn" } });
  if (ended) process.exit(0);
}
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const e = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (e.id != null && !e.method) { if (process.env.FAKE_ANSWERS) fs.appendFileSync(process.env.FAKE_ANSWERS, JSON.stringify(e) + "\\n"); continue; }
  const p = e.params ?? {};
  if (e.method === "initialize") out({ id: e.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (e.method === "session/new") { log({ method: e.method, cwd: p.cwd }); out({ id: e.id, result: { sessionId: SID, models: { currentModelId: a[a.indexOf("--model") + 1] } } }); }
  else if (e.method === "session/load") { log({ method: e.method, sessionId: p.sessionId, cwd: p.cwd }); if (process.env.FAKE_LOAD_DIE) process.exit(0); const ms = Number(process.env.FAKE_LOAD_MS ?? 0); if (ms) { const id = e.id; setTimeout(() => { up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED-not-the-report" } }); out({ id, result: {} }); }, ms); continue; } up({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "an old prompt" } }); up({ sessionUpdate: "tool_call", toolCallId: "old", kind: "edit" }); up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED-not-the-report" } }); out({ id: e.id, result: {} }); }
  else if (e.method === "session/prompt") { log({ method: e.method, busy, tag: (p.prompt[0].text.match(/TAG-\\w+/) ?? [null])[0] }); if (busy) out({ id: e.id, error: { code: -32603, message: "Internal error", data: "Prompt already in progress" } }); else prompt(e.id, p.prompt[0].text); }
} });
process.stdin.on("end", () => { ended = true; if (!busy) process.exit(0); });
`;
const BRIEF = "PRIVATE-BRIEF-7f3a: rename foo to bar in x.js. Check: grep bar x.js.";
const SENT = "PRIVATE-SEND-91c2: also rename baz.";

function world(over = {}) {
  const home = shortHome(), bin = join(home, "bin"), work = join(home, "work"), inputs = join(home, "inputs");
  for (const d of [bin, work, inputs]) mkdirSync(d, { recursive: true });
  fakeExecutable(bin, "claude", FAKE_CLAUDE);
  fakeExecutable(bin, "codex", FAKE_CODEX);
  fakeExecutable(bin, "agy", FAKE_AGY);
  fakeExecutable(bin, "kiro-cli", FAKE_KIRO);
  const gate = join(home, "gate"), linger = join(home, "linger");
  // git's own folder too: launch --worktree and cleanup run it, as they would for a person.
  const env = cliEnv(home, { PATH: [bin, dirname(process.execPath), dirname(Bun.which("git") ?? "git")].join(delimiter), FAKE_ARGV: join(home, "argv.jsonl"), FAKE_RPC: join(home, "rpc.jsonl"), FAKE_ANSWERS: join(home, "answers.jsonl"), FAKE_EOF: join(home, "eof.jsonl"), FAKE_GATE: gate, FAKE_LINGER: linger, ...over });
  for (const k of Object.keys(env)) if (/^(HERDR_|CLAUDECODE$|CLAUDE_CODE_SESSION|SANDBOX_RUNTIME$|CODEX_SANDBOX)/.test(k)) delete env[k];
  const outputs = [];
  const run = (args, extra = {}) => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: work, env: { ...env, ...extra }, stdin: "ignore" });
    const text = r.stdout.toString(); outputs.push(text, r.stderr.toString());
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  const task = (text, name = "task.md") => { const f = join(inputs, name); writeFileSync(f, text); return f; };
  const advise = (file) => { const a = join(home, `${file.split(/[\\/]/).pop()}.advice.json`); writeFileSync(a, JSON.stringify(run(["dispatch", "--task-file", file]))); return a; };
  const launchW = (name, file, more = [], extra, kind = "claude", model) => run(["launch", "--kind", kind, "--name", name, "--model", model ?? { codex: "gpt-6-luna", agy: "gemini-3.8-flash-low", kiro: "auto" }[kind] ?? "haiku", "--task-file", file, "--advice", advise(file), ...more], extra);
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
  expect(w.run(["cleanup", "--worker", "w1", "--cwd", w.work]).error).toBe("--worker takes no --cwd: the worker's run folder says where its worktree is");
}, 90000);

// No brief or message text in any file under the home but the test's own inputs and the reports.
const noBriefInFiles = (w) => {
  for (const f of filesUnder(w.home).filter((x) => !x.startsWith("inputs") && !x.split(/[\\/]/).includes("reports") && !x.startsWith("bin"))) {
    const text = readFileSync(join(w.home, f), "utf8");
    for (const m of ["PRIVATE-BRIEF", "PRIVATE-SEND"]) expect([f, m, text.includes(m)]).toEqual([f, m, false]);
  }
};
const rpcs = (w) => { try { return readFileSync(join(w.home, "rpc.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x)); } catch { return []; } };

test("a headless Codex worker: its app-server, a message steered into the running turn, wait, a follow-up that resumes its thread", async () => {
  const w = world(), file = w.task(`${BRIEF} HOLD`);
  const l = w.launch("c1", file, ["--effort", "low"], undefined, "codex");
  expect([l.ok, l.state, l.headline]).toEqual([true, "prompted", "routr: c1 (codex) took its task, running headless"]);
  expect(l.worker).toEqual({ name: "c1", backend: "headless", run: w.runDir("c1"), session: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" });
  expect(l.start.argv).toEqual(["app-server", "-c", "check_for_update_on_startup=false"]);
  // Its settings go in the protocol: the worker's folder, what --yolo is in a pane, the model, the effort; the brief
  // only as turn input.
  expect(rpcs(w).map((r) => r.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
  expect(rpcs(w)[2]).toEqual({ method: "thread/start", cwd: l.cwd, model: "gpt-6-luna", approvalPolicy: "never", sandbox: "danger-full-access" });
  expect(rpcs(w)[3]).toEqual({ method: "turn/start", threadId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", effort: "low" });
  const s = w.run(["send", "--name", "c1", "--task", SENT]);
  expect([s.ok, s.state, s.message.code, s.headline]).toEqual([true, "delivered", "accepted", "routr: c1: taken by the running worker (into its running turn, or as its next)"]);
  expect(rpcs(w).at(-1)).toEqual({ method: "turn/steer", threadId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", expectedTurnId: "turn-1" });
  expect(w.run(["workers"]).workers[0]).toMatchObject({ name: "c1", kind: "codex", state: "working", turn: 1, last_tool: "commandExecution" });
  w.release();
  const done = w.run(["wait", "--name", "c1", "--timeout", "20000"]);
  expect(done.workers[0].turns).toEqual([{ turn: 1, outcome: "finished", report: join(w.runDir("c1"), "reports", "turn-1.md"), delivered: 1 }]);
  // The report is the turn's final answer, not its commentary.
  expect(readFileSync(done.workers[0].turns[0].report, "utf8")).toBe("VERDICT: done\nSUMMARY: turn with 1 steered messages");
  await w.settled("c1");
  expect(w.state("c1")).toMatchObject({ state: "idle", harness_pid: null });
  // Idle: a new app-server resumes the thread with the follow-up as its next turn.
  const again = w.run(["send", "--name", "c1", "--task", SENT]);
  expect([again.state, again.message?.code]).toEqual(["resumed", "prompted"]);
  expect(rpcs(w).filter((r) => r.method === "thread/resume")).toEqual([{ method: "thread/resume", threadId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", cwd: l.cwd, model: "gpt-6-luna", approvalPolicy: "never", sandbox: "danger-full-access" }]);
  expect(w.run(["wait", "--name", "c1", "--timeout", "20000"]).workers[0].turns).toMatchObject([{ turn: 2, outcome: "finished", delivered: 0 }]);
  await w.settled("c1");
  for (const o of w.outputs) for (const m of ["PRIVATE-BRIEF", "PRIVATE-SEND"]) expect([m, o.includes(m)]).toEqual([m, false]);
  noBriefInFiles(w);
  expect(w.run(["cleanup", "--worker", "c1"])).toMatchObject({ ok: true, state: "removed" });
}, 60000);

test("Codex: a question it asks is declined and the turn goes on; a model it lacks fails the launch", async () => {
  const w = world();
  expect(w.launch("c2", w.task(`${BRIEF} HOLD ASK MCP`), [], undefined, "codex").state).toBe("prompted");
  expect(await until(() => w.state("c2").last_tool === "mcp")).toBe(true);
  // Its question was answered with an error: declined, and the turn went on.
  const answers = join(w.home, "answers.jsonl");
  expect(await until(() => existsSync(answers))).toBe(true);
  expect(readFileSync(answers, "utf8").trim().split("\n").map((x) => JSON.parse(x))).toEqual([{ jsonrpc: "2.0", id: 900, error: { code: -32601, message: "routr does not answer this for a headless worker" } }]);
  w.release();
  w.run(["wait", "--name", "c2", "--timeout", "20000"]);
  await w.settled("c2");
  expect(w.state("c2").turns.map((t) => t.outcome)).toEqual(["finished"]);
  const bad = w.run(["launch", "--kind", "codex", "--name", "c3", "--model", "nosuch", "--task-file", w.task(BRIEF, "b.md"), "--advice", w.advise(w.task(BRIEF, "b.md"))]);
  expect([bad.ok, bad.state, bad.error]).toEqual([false, "failed", "Launch failed after prompt submission: Codex refused the task (harness_refused)"]);
  await w.settled("c3");
  expect(w.state("c3")).toMatchObject({ state: "failed", turns: [expect.objectContaining({ outcome: "failed" })] });
  for (const n of ["c2", "c3"]) w.run(["cleanup", "--worker", n]);
}, 60000);

// One Codex process, driven line by line: what routr writes, and what it makes of the answers.
function codexPipe() {
  const c = new EventEmitter(), sent = [];
  c.stdin = new Writable({ write(chunk, _e, cb) { sent.push(...chunk.toString().trim().split("\n").map((x) => JSON.parse(x))); cb(); } });
  const events = [];
  const h = ADAPTERS.codex.connect(c, { cwd: "/w", model: "m", effort: null, session: null, emit: (e) => events.push(e) });
  const answer = async (result, error) => { await Bun.sleep(5); const q = sent.filter((x) => x.id != null && x.method).at(-1); h.line(JSON.stringify({ jsonrpc: "2.0", id: q.id, ...(error ? { error } : { result }) })); };
  return { c, h, sent, events, answer };
}

test("Codex: steering follows the turn Codex names; a steer once the turn has ended goes in as the next turn; a lost answer is not known, never resent", async () => {
  const { c, h, sent, events, answer } = codexPipe();
  const methods = () => sent.filter((x) => x.method).map((x) => x.method);
  const note = (method, params) => h.line(JSON.stringify({ jsonrpc: "2.0", method, params }));
  const began = h.begin("the task");
  // A message during startup waits for the task's turn, then joins it.
  const early = h.send("early");
  await answer({ userAgent: "x" }); await answer({ thread: { id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" } }); await answer({ turn: { id: "t1", status: "inProgress" } });
  expect([await began, events]).toEqual([true, [{ session: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" }]]);
  await answer({ turnId: "t1" });
  expect([await early, sent.at(-1).params.expectedTurnId]).toEqual([{ code: "accepted", next: false }, "t1"]);
  // The turn has just ended, and routr has not read that yet: the steer is refused, and the message starts the next turn.
  const late = h.send("late");
  await answer(null, { code: -32600, message: "no active turn to steer" }); await answer({ turn: { id: "t2", status: "inProgress" } });
  expect(await late).toEqual({ code: "accepted", next: true });
  expect(methods()).toEqual(["initialize", "initialized", "thread/start", "turn/start", "turn/steer", "turn/steer", "turn/start"]);
  // Between turns, straight to turn/start; a turn Codex announces before its start is answered is the one steered.
  expect(note("turn/completed", { turn: { id: "t2", status: "completed" } })).toEqual({ result: { failed: false, text: null }, id: "t2" });
  const next = h.send("next");
  await Bun.sleep(5); note("turn/started", { turn: { id: "t3" } }); await answer({ turn: { id: "t3", status: "inProgress" } });
  expect([await next, methods().at(-1)]).toEqual([{ code: "accepted", next: true }, "turn/start"]);
  const steer = h.send("steer"); await answer(null, { code: -32600, message: "expected turn t9, found t3" });
  expect([sent.at(-1).params.expectedTurnId, await steer]).toEqual(["t3", { code: "refused", why: "harness_refused" }]);
  // Handed to it, and it ended before answering: not known whether it took it.
  const lost = h.send("lost"); await Bun.sleep(5); c.emit("close");
  expect(await lost).toEqual({ code: "unknown", why: "no_reply" });
  expect(await h.send("after")).toBe(null); // never written: its input is gone
  // A thread it would not start: refused, and nothing said about a session; a send then is refused too.
  const r = codexPipe(), b = r.h.begin("x");
  await r.answer({ userAgent: "x" }); await r.answer(null, { code: -32600, message: "model not found" });
  expect([await b, r.events, await r.h.send("y")]).toEqual(["refused", [], { code: "refused", why: "not_started" }]);
});

test("a headless Antigravity worker: its stream-json mode, a message queued as its next turn, a follow-up that continues its conversation", async () => {
  const w = world(), file = w.task(`${BRIEF} HOLD`);
  const l = w.launch("a1", file, [], undefined, "agy");
  expect([l.ok, l.state, l.headline]).toEqual([true, "prompted", "routr: a1 (agy) took its task, running headless"]);
  expect(l.worker.session).toBe("a67fd46b-3c80-4ed3-bf70-dc822b03ba83");
  // As in a pane: its permissions, the worker's folder, the model id; the brief only on stdin.
  expect(l.start.argv).toEqual(["--print=", "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions", "--add-dir", l.cwd, "--model", "gemini-3.8-flash-low"]);
  expect(await until(() => w.state("a1").last_tool === "run_command")).toBe(true);
  // Mid-turn, the holder keeps the message: it runs as turn 2 of the same process, and is counted there.
  const s = w.run(["send", "--name", "a1", "--task", SENT]);
  expect([s.ok, s.state, s.message]).toEqual([true, "queued", { code: "queued", why: "next_turn" }]);
  w.release();
  expect(await until(() => w.state("a1").turns?.length === 2 && w.state("a1").turns[1].outcome === "finished")).toBe(true);
  const done = w.run(["wait", "--name", "a1", "--timeout", "20000"]);
  expect(done.workers[0].turns.map((t) => [t.turn, t.outcome, t.delivered])).toEqual([[1, "finished", 0], [2, "finished", 1]]);
  expect(readFileSync(done.workers[0].turns[1].report, "utf8")).toBe("VERDICT: done\nSUMMARY: turn 2 of this process");
  await w.settled("a1");
  // Idle: a new process continues the conversation.
  expect(w.run(["send", "--name", "a1", "--task", SENT]).state).toBe("resumed");
  const argv = readFileSync(join(w.home, "argv.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x)).filter((x) => x[0] === "agy");
  expect(argv.at(-1).slice(-2)).toEqual(["--conversation", "a67fd46b-3c80-4ed3-bf70-dc822b03ba83"]);
  expect(w.run(["wait", "--name", "a1", "--timeout", "20000"]).workers[0].turns).toMatchObject([{ turn: 3, outcome: "finished" }]);
  await w.settled("a1");
  for (const o of w.outputs) for (const m of ["PRIVATE-BRIEF", "PRIVATE-SEND"]) expect([m, o.includes(m)]).toEqual([m, false]);
  noBriefInFiles(w);
  // Two corrections in one turn: two turns of their own, one message each, and its input open until the last has run.
  rmSync(w.gate, { force: true }); rmSync(join(w.home, "eof.jsonl"), { force: true });
  expect(w.launch("a3", w.task(`${BRIEF} HOLD`, "q.md"), [], undefined, "agy").state).toBe("prompted");
  for (const t of [SENT, `${SENT} again`]) expect(w.run(["send", "--name", "a3", "--task", t]).state).toBe("queued");
  w.release();
  expect(await until(() => w.state("a3").turns?.length === 3 && w.state("a3").turns.every((t) => t.outcome === "finished"))).toBe(true);
  expect(w.state("a3").turns.map((t) => t.delivered)).toEqual([0, 1, 1]);
  await w.settled("a3");
  expect(readFileSync(join(w.home, "eof.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x))).toEqual([{ turns: 3, busy: false, waiting: 0 }]);
  // A failed turn, and an MCP tool by its fixed name.
  const f = w.launch("a2", w.task(`${BRIEF} FAIL MCP`, "f.md"), [], undefined, "agy");
  expect(f.state).toBe("prompted");
  await w.settled("a2");
  expect(w.state("a2")).toMatchObject({ state: "failed", last_tool: "mcp", turns: [expect.objectContaining({ outcome: "failed" })] });
  // In its own worktree: the folder it is given is the worktree's, as shown. An --effort it would refuse writes nothing.
  repo(w);
  expect(w.launch("a4", w.task(BRIEF, "e.md"), ["--worktree", "work/a4", "--effort", "high"], undefined, "agy").error).toBe("agy encodes effort in --model; omit --effort (agy 1.2.11 refuses one that disagrees with the id)");
  expect(existsSync(w.runDir("a4"))).toBe(false);
  const t = w.launch("a4", w.task(BRIEF, "e.md"), ["--worktree", "work/a4"], undefined, "agy");
  expect(t.state).toBe("prompted");
  const ran = readFileSync(join(w.home, "argv.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x)).filter((x) => x[0] === "agy").at(-1);
  expect([t.start.argv[t.start.argv.indexOf("--add-dir") + 1], ran[ran.indexOf("--add-dir") + 1], t.cwd]).toEqual([t.worktree.path, t.worktree.path, t.worktree.path]);
  await w.settled("a4");
  for (const n of ["a1", "a2", "a3", "a4"]) expect(w.run(["cleanup", "--worker", n]).state).toBe("removed");
}, 60000);

test("Antigravity's stream as routr reads it: the conversation, turns it starts for queued messages, fixed tool names, the response", () => {
  const read = agyReader(), j = (o) => read(JSON.stringify(o));
  expect(j({ event: "init", conversation_id: "a67fd46b-3c80-4ed3-bf70-dc822b03ba83", init: {} })).toEqual({ turn: true, session: "a67fd46b-3c80-4ed3-bf70-dc822b03ba83" });
  expect(j({ event: "step_update", step_update: { step_type: "user_input", state: "DONE" } })).toEqual({ activity: true });
  for (const [name, tool] of [["run_command", "run_command"], ["call_mcp_tool", "mcp"], ["something_new", "other"]]) expect(j({ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: name } })).toEqual({ tool });
  expect(j({ event: "result", result: { status: "SUCCESS", response: "the answer" } })).toEqual({ result: { failed: false, text: "the answer" } });
  // The first step after a result is the next turn: a message it had queued.
  expect(j({ event: "step_update", step_update: { step_type: "user_input", state: "DONE" } })).toEqual({ turn: true, activity: true });
  expect(j({ event: "result", result: { status: "ERROR" } })).toEqual({ result: { failed: true, text: null } });
  expect([read("not json"), j({ event: "something" })]).toEqual([null, null]);
});

test("a headless Kiro worker: its ACP mode, a message held for its next turn, a follow-up that loads its session", async () => {
  const w = world(), file = w.task(`${BRIEF} HOLD ASK`);
  const l = w.launch("k1", file, [], undefined, "kiro");
  expect([l.ok, l.state, l.headline]).toEqual([true, "prompted", "routr: k1 (kiro) took its task, running headless"]);
  expect([l.worker.session, l.start.argv]).toEqual(["b7cad7ce-3a91-46bd-8a45-3af4a23b39b5", ["acp", "--trust-tools=*", "--model", "auto"]]);
  expect(l.steps.find((s) => s.step === "model")).toMatchObject({ ok: true });
  expect(await until(() => w.state("k1").last_tool === "execute")).toBe(true);
  // Its permission request was declined, and the turn went on.
  expect(await until(() => existsSync(join(w.home, "answers.jsonl")))).toBe(true);
  // Mid-turn, Kiro takes no prompt: the holder keeps the message, and it runs as turn 2, in the same process.
  const s = w.run(["send", "--name", "k1", "--task", SENT]);
  expect([s.ok, s.state, s.message, s.headline]).toEqual([true, "queued", { code: "queued", why: "next_turn" }, "routr: k1: queued: it runs as the worker's next turn, once the running one ends"]);
  w.release();
  expect(await until(() => w.state("k1").turns?.length === 2 && w.state("k1").turns[1].outcome === "finished")).toBe(true);
  expect(w.state("k1").turns.map((t) => [t.turn, t.outcome, t.delivered])).toEqual([[1, "finished", 0], [2, "finished", 1]]);
  // Never a second prompt while one ran; the report is the text after its last tool call, not its thoughts.
  expect(rpcs(w).filter((r) => r.method === "session/prompt").map((r) => r.busy)).toEqual([false, false]);
  expect(readFileSync(w.state("k1").turns[1].report, "utf8")).toBe("VERDICT: done\nSUMMARY: kiro turn 2");
  await w.settled("k1");
  // Idle: a new process loads the session; what it replays is not this run's.
  expect(w.run(["send", "--name", "k1", "--task", SENT]).state).toBe("resumed");
  expect(w.run(["wait", "--name", "k1", "--timeout", "20000"]).workers[0].turns.at(-1)).toMatchObject({ turn: 3, outcome: "finished" });
  expect(rpcs(w).filter((r) => r.method === "session/load")).toEqual([{ method: "session/load", sessionId: "b7cad7ce-3a91-46bd-8a45-3af4a23b39b5", cwd: l.cwd }]);
  expect(readFileSync(w.state("k1").turns[2].report, "utf8")).toBe("VERDICT: done\nSUMMARY: kiro turn 1");
  await w.settled("k1");
  for (const o of w.outputs) for (const m of ["PRIVATE-BRIEF", "PRIVATE-SEND"]) expect([m, o.includes(m)]).toEqual([m, false]);
  noBriefInFiles(w);
  // A model Kiro does not list is refused before anything is written; a failed turn is failed.
  expect(w.launch("k2", w.task(BRIEF, "m.md"), [], undefined, "kiro", "nosuch").error).toStartWith("kiro-cli does not list --model nosuch");
  expect(existsSync(w.runDir("k2"))).toBe(false);
  expect(w.launch("k3", w.task(`${BRIEF} FAIL`, "f.md"), [], undefined, "kiro").state).toBe("prompted");
  await w.settled("k3");
  expect(w.state("k3")).toMatchObject({ state: "failed", turns: [expect.objectContaining({ outcome: "failed", report: expect.any(String) })] });
  for (const n of ["k1", "k3"]) expect(w.run(["cleanup", "--worker", n]).state).toBe("removed");
}, 60000);

test("Kiro: a stop drops the messages it holds and says so; held messages outlive an exit, each its own turn, in order", async () => {
  const w = world(), gate = () => w.release();
  // Stop with two held: nothing more goes in, and stop says how many were dropped.
  expect(w.launch("k4", w.task(`${BRIEF} HOLD`), [], undefined, "kiro").state).toBe("prompted");
  for (const t of ["one", "two"]) expect(w.run(["send", "--name", "k4", "--task", `${SENT} TAG-${t}`]).state).toBe("queued");
  const stopped = w.run(["stop", "--name", "k4"]);
  expect([stopped.state, stopped.warnings]).toEqual(["stopped", ["2 queued messages were dropped by the stop and never reached k4: send them again with routr send if they still apply"]]);
  gate(); await w.settled("k4");
  expect(rpcs(w).filter((r) => r.method === "session/prompt").length).toBe(1);
  // Kiro exits mid-turn with two held: a new process loads the session and runs each, in the order sent, counted.
  rmSync(w.gate, { force: true }); rmSync(join(w.home, "rpc.jsonl"), { force: true });
  expect(w.launch("k5", w.task(`${BRIEF} HOLD DIE`, "d.md"), [], undefined, "kiro").state).toBe("prompted");
  for (const t of ["first", "second"]) expect(w.run(["send", "--name", "k5", "--task", `${SENT} TAG-${t}`]).state).toBe("queued");
  gate();
  expect(await until(() => w.state("k5").turns?.length === 3 && w.state("k5").turns.every((t) => t.outcome && t.outcome !== "running"), 20000)).toBe(true);
  await w.settled("k5");
  expect(w.state("k5").turns.map((t) => [t.outcome, t.delivered])).toEqual([["no_finish", 0], ["finished", 1], ["finished", 1]]);
  expect(rpcs(w).filter((r) => r.method === "session/prompt").map((r) => r.tag)).toEqual([null, "TAG-first", "TAG-second"]);
  expect(rpcs(w).filter((r) => r.method === "session/load").length).toBe(1);
  for (const n of ["k4", "k5"]) expect(w.run(["cleanup", "--worker", n]).state).toBe("removed");
}, 60000);

test("Kiro: a message sent while a resumed process starts runs after the ones held before it; a resume that dies starting loses none", async () => {
  const w = world({ FAKE_LOAD_MS: "1500" });
  expect(w.launch("k6", w.task(`${BRIEF} HOLD DIE`), [], undefined, "kiro").state).toBe("prompted");
  for (const t of ["first", "second"]) expect(w.run(["send", "--name", "k6", "--task", `${SENT} TAG-${t}`]).state).toBe("queued");
  w.release();
  // The first process exits; the new one is loading the session: a newer message waits behind the older ones.
  expect(await until(() => rpcs(w).some((r) => r.method === "session/load"))).toBe(true);
  expect(w.run(["send", "--name", "k6", "--task", `${SENT} TAG-third`]).state).toBe("queued");
  expect(await until(() => w.state("k6").turns?.length === 4 && w.state("k6").turns.every((t) => t.outcome && t.outcome !== "running"), 20000)).toBe(true);
  await w.settled("k6");
  expect(rpcs(w).filter((r) => r.method === "session/prompt").map((r) => r.tag)).toEqual([null, "TAG-first", "TAG-second", "TAG-third"]);
  expect(w.state("k6").turns.map((t) => [t.outcome, t.delivered])).toEqual([["no_finish", 0], ["finished", 1], ["finished", 1], ["finished", 1]]);
  // A resume that dies before it takes its task: each held message gets a turn of its own, none dropped silently.
  const d = world({ FAKE_LOAD_DIE: "1" });
  expect(d.launch("k7", d.task(`${BRIEF} HOLD DIE`), [], undefined, "kiro").state).toBe("prompted");
  for (const t of ["first", "second"]) expect(d.run(["send", "--name", "k7", "--task", `${SENT} TAG-${t}`]).state).toBe("queued");
  d.release();
  expect(await until(() => d.state("k7").turns?.length === 3, 20000)).toBe(true);
  await d.settled("k7");
  expect([d.state("k7").turns.map((t) => [t.outcome, t.delivered]), d.state("k7").queued]).toEqual([[["no_finish", 0], ["no_finish", 1], ["not_started", 1]], 0]);
  for (const [x, n] of [[w, "k6"], [d, "k7"]]) expect(x.run(["cleanup", "--worker", n]).state).toBe("removed");
}, 60000);

test("Kiro's ACP output as routr reads it: replies, its own requests, fixed tool kinds, the text after its last tool call, nothing while a session loads", () => {
  const r = kiroReader(), up = (update) => r.read(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update } }));
  expect(r.read(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }))).toEqual({ reply: { id: 2, result: { stopReason: "end_turn" }, error: null } });
  expect(r.read(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/request_permission", params: {} }))).toEqual({ request: 9 });
  expect(up({ sessionUpdate: "agent_message_chunk", content: { text: "I will look." } })).toEqual({ activity: true });
  for (const [kind, tool] of [["execute", "execute"], ["edit", "edit"], ["something_new", "other"]]) expect(up({ sessionUpdate: "tool_call", kind })).toEqual({ tool });
  up({ sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } });
  up({ sessionUpdate: "agent_message_chunk", content: { text: "the " } }); up({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } });
  expect(r.take()).toBe("the answer");
  r.loading(true);
  expect(up({ sessionUpdate: "agent_message_chunk", content: { text: "old" } })).toBe(null);
  r.loading(false);
  expect([r.take(), r.read(JSON.stringify({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params: {} })), r.read("not json")]).toEqual(["", null, null]);
});

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

test("a message sent while Claude is exiting is queued, and runs as the next turn on the same session", async () => {
  const w = world({ FAKE_HOLD_EXIT: "1" });
  expect(w.launch("q1", w.task(BRIEF)).state).toBe("prompted");
  expect(w.run(["wait", "--name", "q1", "--timeout", "20000"]).workers[0].turns.map((t) => t.turn)).toEqual([1]);
  // Its input is closed and it has not exited yet: the holder keeps the message for the next Claude.
  await until(() => w.state("q1").state === "waiting", 3000);
  expect(w.run(["send", "--name", "q1", "--task", SENT])).toMatchObject({ ok: true, state: "queued", message: { code: "queued" } });
  w.release(); // the first Claude exits; the holder starts the next on the same session
  const next = w.run(["wait", "--name", "q1", "--timeout", "20000"]);
  expect(next.workers[0].turns).toMatchObject([{ turn: 2, outcome: "finished" }]);
  expect(w.state("q1").turns.map((t) => t.outcome)).toEqual(["finished", "finished"]);
  await w.settled("q1");
  w.run(["cleanup", "--worker", "q1"]);
}, 60000);

// A repository for a worker's worktree: one commit, and an untracked file a launch may --copy.
function repo(w) {
  const g = (...a) => { const r = Bun.spawnSync([Bun.which("git"), "-C", w.work, ...a], { env: { ...w.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); return r.stdout.toString().trim(); };
  g("init", "-q", "-b", "main"); writeFileSync(join(w.work, "x.js"), "let foo = 1;\n"); g("add", "x.js"); g("commit", "-q", "-m", "init");
  writeFileSync(join(w.work, ".env.local"), "LOCAL=1\n");
  return g;
}

test("outside herdr, a worker gets its own worktree, and cleanup --worker removes it only once nothing of the work would be lost", async () => {
  const w = world(), g = repo(w);
  const l = w.launch("t1", w.task(BRIEF), ["--worktree", "work/t1", "--copy", ".env.local"]);
  expect([l.ok, l.state]).toEqual([true, "prompted"]);
  const path = l.worktree.path;
  expect(l.worktree).toEqual({ branch: "work/t1", path, workspace: null });
  expect(path.startsWith(join(realpathSync.native(w.home), ".local", "share", "routr", "worktrees"))).toBe(true);
  expect([l.cwd, existsSync(join(path, "x.js")), readFileSync(join(path, ".env.local"), "utf8")]).toEqual([path, true, "LOCAL=1\n"]);
  expect(g("branch", "--list", "work/t1")).toContain("work/t1");
  expect(w.run(["workers", "--name", "t1"]).workers[0].cwd).toBe(path);
  w.run(["wait", "--name", "t1", "--timeout", "20000"]);
  await w.settled("t1");
  // A file the worker made keeps the worktree, and the worker's run folder with it.
  writeFileSync(join(path, "new.txt"), "work\n");
  const kept = w.run(["cleanup", "--worker", "t1"]);
  expect([kept.ok, kept.state]).toEqual([false, "refused"]);
  expect(kept.headline).toMatch(/^routr: kept t1: 1 untracked file in .+ that the main checkout does not hold as they are$/); // git's form of the path
  expect([existsSync(path), existsSync(w.runDir("t1"))]).toEqual([true, true]);
  rmSync(join(path, "new.txt"));
  // The copy it was given, unchanged, goes with it; the branch is kept unless --delete-branch.
  expect(w.run(["cleanup", "--worker", "t1", "--dry-run"])).toMatchObject({ ok: true, state: "planned", headline: `routr: would remove ${w.runDir("t1")} and ${path}` });
  const done = w.run(["cleanup", "--worker", "t1", "--delete-branch"]);
  expect([done.ok, done.state, done.branch]).toEqual([true, "removed", { name: "work/t1", deleted: true }]);
  expect(done.warnings.filter((x) => x.startsWith("cleanup cannot see a command t1 started that left Claude Code's process group or detached itself"))).toHaveLength(1);
  expect([existsSync(path), existsSync(w.runDir("t1")), g("branch", "--list", "work/t1")]).toEqual([false, false, ""]);
  // A branch that exists is refused before anything is written.
  g("branch", "taken");
  expect(w.launch("t2", w.task(BRIEF), ["--worktree", "taken"]).error).toBe(`branch taken exists in ${realpathSync.native(w.work)}; choose a new branch for the worker`);
  expect(existsSync(w.runDir("t2"))).toBe(false);
}, 60000);

test("a launch that stops before its worker starts removes the worktree and branch it made", async () => {
  const w = world(), g = repo(w), file = w.task(BRIEF), advice = w.advise(file);
  const saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = w.home;
  try {
    const r = await launch(["--kind", "claude", "--name", "t3", "--model", "m", "--task-file", file, "--advice", advice, "--cwd", w.work, "--worktree", "work/t3", "--copy", ".env.local"],
      { env: {}, settings: () => cfg(), ready: async () => null, spawn: () => false });
    expect([r.state, r.error, r.worker, r.warnings]).toEqual(["failed", "the worker's process did not start (not_started)", null, []]);
  } finally { [process.env.HOME, process.env.USERPROFILE] = saved; }
  expect([g("branch", "--list", "work/t3"), g("worktree", "list").split("\n").length, existsSync(w.runDir("t3"))]).toEqual(["", 1, false]);
}, 60000);

test("a launch that stops early takes back a copied folder too, and never copies through a link in the worktree", async () => {
  const w = world(), g = repo(w), file = w.task(BRIEF), advice = w.advise(file);
  mkdirSync(join(w.work, "fixtures", "deep"), { recursive: true });
  writeFileSync(join(w.work, "fixtures", "deep", "a.json"), "{}\n");
  mkdirSync(join(w.work, "fixtures", "empty", "deeper"), { recursive: true });
  const saved = [process.env.HOME, process.env.USERPROFILE], here = process.cwd();
  process.env.HOME = process.env.USERPROFILE = w.home;
  const go = (branch, more) => launch(["--kind", "claude", "--name", "c1", "--model", "m", "--task-file", file, "--advice", advice, "--cwd", w.work, "--worktree", branch, ...more],
    { env: {}, settings: () => cfg(), ready: async () => null, spawn: () => false });
  try {
    // Run from the source checkout: the folders it took back are the worktree's, never the same names here.
    process.chdir(w.work);
    const r = await go("work/c1", ["--copy", "fixtures"]);
    expect([r.state, r.warnings]).toEqual(["failed", []]);
    expect([g("branch", "--list", "work/c1"), g("worktree", "list").split("\n").length]).toEqual(["", 1]);
    expect([existsSync(join(w.work, "fixtures", "empty", "deeper")), existsSync(join(w.work, "fixtures", "deep", "a.json"))]).toEqual([true, true]);
    if (POSIX) {
      // A folder that is a link in the commit the worktree starts from: nothing is copied through it, and the launch
      // leaves nothing.
      const outside = join(w.home, "outside"); mkdirSync(outside);
      symlinkSync(outside, join(w.work, "cfg")); g("add", "cfg"); g("commit", "-q", "-m", "link");
      unlinkSync(join(w.work, "cfg")); mkdirSync(join(w.work, "cfg")); writeFileSync(join(w.work, "cfg", "local.json"), "{}\n");
      const l = await go("work/c2", ["--copy", "cfg/local.json"]);
      expect([l.state, l.error]).toEqual(["failed", expect.stringContaining("is a link or not a folder; nothing is copied through it")]);
      expect([existsSync(join(outside, "local.json")), g("branch", "--list", "work/c2")]).toEqual([false, ""]);
      // A copied folder that is a link: taken back as a link, and nothing behind it is walked or removed.
      const behind = join(w.home, "behind"); mkdirSync(join(behind, "empty", "deeper"), { recursive: true });
      symlinkSync(behind, join(w.work, "linked"));
      const k = await go("work/c3", ["--copy", "linked"]);
      expect([k.state, k.warnings, g("branch", "--list", "work/c3")]).toEqual(["failed", [], ""]);
      expect(existsSync(join(behind, "empty", "deeper"))).toBe(true);
    }
  } finally { [process.env.HOME, process.env.USERPROFILE] = saved; process.chdir(here); }
}, 60000);

test("cleanup --worker keeps a worktree that took the place of the one launch made, or a folder git does not list", async () => {
  const w = world(), g = repo(w);
  const l = w.launch("r1", w.task(BRIEF), ["--worktree", "work/r1"]);
  expect(l.state).toBe("prompted");
  w.run(["wait", "--name", "r1", "--timeout", "20000"]);
  await w.settled("r1");
  g("worktree", "remove", l.worktree.path); g("worktree", "add", "-q", "-b", "other", l.worktree.path);
  const kept = w.run(["cleanup", "--worker", "r1"]);
  expect([kept.state, kept.headline]).toEqual(["refused", `routr: kept r1: the worktree at ${l.worktree.path} is on branch other, not on work/r1: it is not the one launch made`]);
  expect(existsSync(l.worktree.path)).toBe(true);
  // Made again at the same path on the worker's own branch: another folder, so not the one launch made either.
  g("worktree", "remove", l.worktree.path); g("worktree", "add", "-q", l.worktree.path, "work/r1");
  const again = w.run(["cleanup", "--worker", "r1"]);
  expect([again.state, again.headline]).toEqual(["refused", `routr: kept r1: the worktree at ${l.worktree.path} was made again since launch: it is not the one launch made`]);
  // A plain folder at that path, not a worktree git lists, is not known to be the worker's either.
  g("worktree", "remove", l.worktree.path); mkdirSync(l.worktree.path); writeFileSync(join(l.worktree.path, "notes.txt"), "mine\n");
  const plain = w.run(["cleanup", "--worker", "r1"]);
  expect([plain.state, plain.headline]).toEqual(["refused", `routr: kept r1: git lists no worktree at ${l.worktree.path}, yet a folder is there: routr cannot tell it is the one launch made`]);
  expect([existsSync(join(l.worktree.path, "notes.txt")), existsSync(w.runDir("r1"))]).toEqual([true, true]);
  rmSync(l.worktree.path, { recursive: true });
  expect(w.run(["cleanup", "--worker", "r1"]).state).toBe("removed");
}, 60000);

test("a launch whose worktree git did not make leaves a branch of that name alone: it may be another command's", async () => {
  const w = world(), g = repo(w), start = g("rev-parse", "HEAD");
  g("branch", "raced");
  const out = { warnings: [] };
  await unmakeWorktree({ added: false, branch: "raced", source: w.work, start, path: join(w.home, "wt"), files: [], dirs: [] }, out);
  expect([g("rev-parse", "raced"), out.warnings]).toEqual([start, [`Branch raced exists in ${w.work}, but git did not make this launch's worktree, so whose branch it is cannot be told; it was left`]]);
  const none = { warnings: [] };
  await unmakeWorktree({ added: false, branch: "never", source: w.work, start, path: join(w.home, "wt"), files: [], dirs: [] }, none);
  expect(none.warnings).toEqual([]);
});

test("outside herdr, cleanup lists and removes worktrees through git, and says what it cannot see", () => {
  const w = world(), g = repo(w);
  const wt = join(w.home, "wt one"); g("worktree", "add", "-q", "-b", "side", wt);
  const list = w.run(["cleanup", "--cwd", w.work]);
  expect([list.ok, list.state, list.worktrees.map((x) => [x.branch, x.removable])]).toEqual([true, "listed", [["side", true]]]);
  expect(list.warnings).toContain("Outside herdr, cleanup cannot see whether anything runs in a worktree's folder: it checks git's state only");
  expect(w.run(["cleanup", "--cwd", w.work, "--path", wt, "--delete-branch"])).toMatchObject({ ok: true, state: "removed", branch: { name: "side", deleted: true } });
  expect(existsSync(wt)).toBe(false);
});

test("git's worktree list, read as herdr's: the main checkout, branches, detached, prunable, bare, a path with spaces", async () => {
  const sha = "a".repeat(40);
  const text = [`worktree /repo`, `HEAD ${sha}`, `branch refs/heads/main`, ``, `worktree /wt/a b`, `HEAD ${sha}`, `branch refs/heads/work/x`, ``,
    `worktree /wt/det`, `HEAD ${sha}`, `detached`, ``, `worktree /wt/gone`, `HEAD ${sha}`, `branch refs/heads/old`, `prunable gitdir file points to non-existent location`, ``].join("\n");
  expect(worktreesFromGit(text)).toEqual({ source: { source_checkout_path: "/repo" }, worktrees: [
    { path: "/repo", branch: "main", is_detached: false, is_prunable: false, is_linked_worktree: false, open_workspace_id: null },
    { path: "/wt/a b", branch: "work/x", is_detached: false, is_prunable: false, is_linked_worktree: true, open_workspace_id: null },
    { path: "/wt/det", branch: null, is_detached: true, is_prunable: false, is_linked_worktree: true, open_workspace_id: null },
    { path: "/wt/gone", branch: "old", is_detached: false, is_prunable: true, is_linked_worktree: true, open_workspace_id: null }] });
  const bare = `worktree /repo.git\nbare\n\nworktree /wt/x\nHEAD ${sha}\nbranch refs/heads/x\n`;
  expect(worktreesFromGit(bare).worktrees.map((x) => [x.path, x.is_linked_worktree])).toEqual([["/repo.git", false], ["/wt/x", true]]);
  // The boundary takes a bare repository's record, and a top folder whose name ends in a space, as they are.
  expect((await callGit(async () => ({ out: bare, code: 0 }), "/repo.git", ["worktree", "list", "--porcelain"])).ok).toBe(true);
  expect((await callGit(async () => ({ out: "/repos/project \n", code: 0 }), "/x", ["rev-parse", "--show-toplevel"])).out).toBe("/repos/project \n");
});

test("after a failed turn, wait reports the failure once, then the turn a follow-up resumes", async () => {
  const w = world();
  expect(w.launch("f1", w.task(`${BRIEF} FAIL`)).state).toBe("prompted");
  const first = w.run(["wait", "--name", "f1", "--timeout", "20000"]);
  expect(first.workers[0].turns).toMatchObject([{ turn: 1, outcome: "failed" }]);
  await w.settled("f1");
  // The worker's failed state is said once: with its turn, or by the next wait, never twice.
  const later = [w.run(["wait", "--name", "f1", "--timeout", "2000"]), w.run(["wait", "--name", "f1", "--timeout", "1000"])];
  expect([first, ...later].filter((r) => r.headline === "routr: f1 failed").length).toBe(1);
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
  expect(go(["--kind", "cursor"]).error).toBe("outside herdr, routr launch starts Claude Code, Codex, Antigravity and Kiro workers only; run the lead inside herdr for a Cursor worker");
  expect(go(["--kind", "claude", "--pane", "w1:p1"]).error).toBe("--pane needs herdr; outside herdr a worker runs headless, with no pane");
  expect(go(["--kind", "claude", "--worktree", "b"]).error).toStartWith("--worktree needs a git repository: git found none at");
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
    // Kiro's model list is read only once it is on and signed in: asking a signed-out harness can open its sign-in.
    const kiro = ["--kind", "kiro", "--name", "r3", "--model", "auto", "--task-file", file, "--advice", advice, "--cwd", w.work];
    let asked = 0; const models = async () => { asked++; return ["auto"]; };
    await launch(kiro, { ...deps, models, ready: async () => "not signed in: run `kiro-cli login`" });
    await launch(kiro, { ...deps, models, settings: () => cfg({ subscriptions: { kiro: { enabled: false } } }) });
    expect(asked).toBe(0);
    expect((await launch([...kiro.slice(0, 5), "nosuch", ...kiro.slice(6)], { ...deps, models })).error).toStartWith("kiro-cli does not list --model nosuch");
    expect([asked, existsSync(w.runDir("r3"))]).toEqual([1, false]);
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
  afterAll(() => { try { process.kill(Number(readFileSync(w.linger, "utf8")), "SIGKILL"); } catch {} }); // never left running
  expect(w.launch("g1", w.task(`${BRIEF} LINGER`)).state).toBe("prompted");
  w.run(["wait", "--name", "g1", "--timeout", "20000"]);
  await w.settled("g1");
  const st = w.state("g1");
  expect([st.state, Number.isInteger(st.harness_pgid)]).toEqual(["idle", true]);
  expect(w.run(["cleanup", "--worker", "g1"]).headline).toBe(`routr: kept g1: g1's harness may still be running (process group ${st.harness_pgid})`);
  expect(w.run(["send", "--name", "g1", "--task", "x"]).error).toStartWith("g1's harness may still be running");
  // stop does not signal a group whose Claude has gone (the id may be someone else's by then): it says so.
  expect(w.run(["stop", "--name", "g1"])).toMatchObject({ ok: false, state: "lost" });
  process.kill(Number(readFileSync(w.linger, "utf8")), "SIGKILL");
  await until(() => { try { process.kill(-st.harness_pgid, 0); return false; } catch { return true; } });
  expect(w.run(["cleanup", "--worker", "g1"])).toMatchObject({ ok: true, state: "removed" });
}, 60000);

test("Codex's app-server as routr reads it: replies, its own requests, turns, fixed item names, the final answer as the report", () => {
  const read = codexReader(), n = (method, params) => read(JSON.stringify({ jsonrpc: "2.0", method, params }));
  expect(read(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { turnId: "t" } }))).toEqual({ reply: { id: 3, result: { turnId: "t" }, error: null } });
  expect(read(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "item/commandExecution/requestApproval", params: {} }))).toEqual({ request: 7 });
  expect(n("turn/started", { turn: { id: "t" } })).toEqual({ turn: true, id: "t" });
  for (const [type, tool] of [["commandExecution", "commandExecution"], ["fileChange", "fileChange"], ["mcpToolCall", "mcp"], ["somethingNew", "other"]]) expect(n("item/started", { item: { type, command: "an argument" } })).toEqual({ tool });
  expect(n("item/started", { item: { type: "agentMessage" } })).toEqual({ activity: true });
  n("item/completed", { item: { type: "agentMessage", phase: "final_answer", text: "the answer" } });
  n("item/completed", { item: { type: "agentMessage", phase: "commentary", text: "more narration" } });
  expect(n("turn/completed", { turn: { id: "t", status: "completed" } })).toEqual({ result: { failed: false, text: "the answer" }, id: "t" });
  // No phase (a model that marks none): its last message. Interrupted or failed: a failed turn.
  n("turn/started", {}); n("item/completed", { item: { type: "agentMessage", text: "one" } }); n("item/completed", { item: { type: "agentMessage", text: "two" } });
  expect(n("turn/completed", { turn: { status: "interrupted" } })).toEqual({ result: { failed: true, text: "two" }, id: null });
  // Commentary and partial answers are never the report: interrupted after them, the turn has none.
  n("turn/started", { turn: { id: "u" } }); n("item/completed", { item: { type: "agentMessage", phase: "commentary", text: "I am looking at the brief" } });
  n("item/completed", { item: { type: "agentMessage", phase: "partial_answer", text: "so far" } });
  expect(n("turn/completed", { turn: { id: "u", status: "interrupted" } })).toEqual({ result: { failed: true, text: null }, id: "u" });
  expect([read("not json"), n("thread/tokenUsage/updated", {})]).toEqual([null, null]);
});

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
  // A report over 1 MB of UTF-8 is cut there, back to a whole character (here the cut falls inside an é); one under it
  // is kept exactly as written, a replacement character at its end included.
  const long = readEvent(JSON.stringify({ type: "result", result: "x" + "é".repeat(700000) })).result.text;
  expect([Buffer.byteLength(long), long.endsWith("é"), long.includes("\uFFFD")]).toEqual([1024 * 1024 - 1, true, false]);
  expect(readEvent(JSON.stringify({ type: "result", result: "ok\uFFFD" })).result.text).toBe("ok\uFFFD");
  for (const l of ["not json", "null", JSON.stringify({ type: "rate_limit_event" }), JSON.stringify({ type: "system", subtype: "hook_started" })]) expect(readEvent(l)).toBeNull();
});

test("the channel: one claimant per generation, and nothing for a peer that has not proved the secret", async () => {
  const home = shortHome(), saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const dir = join(home, "run"); mkdirSync(dir, { mode: 0o700 }); writeSecret(dir);
    // routr never leaves a claim half written; one with no readable pid is not routr's, and nothing is assumed of it.
    writeFileSync(join(dir, "gen-1.claim"), "");
    expect((await probe(dir)).state).toBe("unreachable");
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

test("a worker is lost only when its channel and its state are of one generation", async () => {
  const home = shortHome(), saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const dir = join(home, ".local", "state", "routr", "workers", "v1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "worker.json"), JSON.stringify({ format: 1, id: "abcdef0123456789", name: "v1", kind: "claude", model: "m", cwd: home }));
    const gone = Bun.spawnSync([process.execPath, "-e", ""]).pid; // a process that has exited
    const state = (gen) => writeFileSync(join(dir, "state.json"), JSON.stringify({ gen, state: "working", turn: 1, turns: [{ turn: 1 }] }));
    // The state is generation 2's; the channel only shows generation 1, released: the two never agree, so nothing is
    // concluded from the channel.
    writeFileSync(join(dir, "gen-1.claim"), JSON.stringify({ pid: gone, at: 0 }));
    writeFileSync(join(dir, "gen-1.ready"), JSON.stringify({ endpoint: "x", pid: gone }));
    writeFileSync(join(dir, "gen-1.released"), JSON.stringify({ at: 0 }));
    state(2);
    expect((await view("v1")).state).toBe("working");
    // No generation at all beside a running state: still not lost.
    for (const f of ["gen-1.claim", "gen-1.ready", "gen-1.released"]) rmSync(join(dir, f));
    expect((await view("v1")).state).toBe("working");
    // One generation, claimed by a process that is gone and never bound: lost.
    writeFileSync(join(dir, "gen-2.claim"), JSON.stringify({ pid: gone, at: 0 }));
    expect((await view("v1")).state).toBe("lost");
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
