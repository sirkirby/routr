// Headless workers outside herdr: launch, wait, send, workers, stop, cleanup --worker, the holder and its channel. A fake
// `claude` stands in for Claude Code's stream-json mode, with the behaviours measured in prototypes p34 and p36.
import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { claim, connect, endpointFor, generations, ownEndpoint, probe, serve, SOCKET_DIR, writeSecret } from "../src/lib/channel.mjs";
import { prepareOtel } from "../src/lib/otel.mjs";
import { TRACE_ATTRIBUTES } from "../src/lib/traces.mjs";
import { ADAPTERS, agyReader, codexReader, cursorReader, groupAlive, groupGone, kiroReader, listGroup, readEvent } from "../src/lib/headless.mjs";
import { unmakeWorktree, view } from "../src/lib/workers.mjs";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { worktreesFromGit } from "../src/lib/cleanup.mjs";
import { besidesHelper, callGit, groupMembers } from "../src/lib/process-boundary.mjs";
import { HARNESSES } from "../src/lib/harnesses.mjs";
import { launch } from "../src/lib/launch.mjs";
import { CARRIERS, harnessEnv, installedAt, start, stop } from "../src/lib/runtime.mjs";
import { cfg, cliEnv, CONFIG_ENV, fakeExecutable, LEAD_ENV, scratch, SCRIPT } from "./helpers.mjs";

// A worker's socket lives under its home, and macOS caps a socket path at 103 bytes: the test scratch folder under
// macOS's long tmpdir would be refused (path_too_long, tested below). So these homes sit in /tmp there, removed after.
const homes = [];
const shortHome = () => { const h = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rw-")); homes.push(h); return h; };
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
const POSIX = process.platform !== "win32";
// What the check saw when it held, not a second look: a state file being replaced can read empty for a moment on Windows,
// and asking again then failed a test whose condition had held (seen in CI on e123e50).
const until = async (ok, ms = 10000) => { for (let t = 0; t < ms; t += 50) { if (ok()) return true; await Bun.sleep(50); } return Boolean(ok()); };

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
const leave = async () => { if (process.env.FAKE_HOLD_EXIT) for (let i = 0; i < 400 && !fs.existsSync(process.env.FAKE_EXIT_GATE ?? process.env.FAKE_GATE); i++) await sleep(50); process.exit(0); };
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
let thread = null, turn = null, n = 0, steered = 0, buf = "", busy = false, ended = false, nextSteer = null, starting = false, held = null;
async function run(id, text) {
  if (text.includes("CRASH")) process.exit(3);
  // FAKE_REPLY_GATE: a later turn runs at once, its start answered only once the gate is written; a start that comes
  // meanwhile is refused just after that answer (or at once, with FAKE_REPLY_REFUSE_FIRST).
  const gate = () => fs.existsSync(process.env.FAKE_REPLY_GATE);
  if (process.env.FAKE_REPLY_GATE && n > 0 && !gate()) {
    // FAKE_REPLY_REFUSE_FIRST: refused at once instead, before the held answer goes.
    if (held) { if (!process.env.FAKE_REPLY_REFUSE_FIRST) { while (!gate()) await sleep(50); await sleep(300); } return out({ id, error: { code: -32600, message: "a turn is already starting" } }); }
    held = id; fs.writeFileSync(process.env.FAKE_REPLY_GATE + "-pending", "");
  }
  if (process.env.FAKE_START_GATE && n > 0) {
    // FAKE_START_SWAP: a second start while one waits refuses the waiting one and waits in its place.
    if (starting && !process.env.FAKE_START_SWAP) return out({ id, error: { code: -32600, message: "a turn is already starting" } });
    if (starting) { out({ id: starting, error: { code: -32600, message: "superseded" } }); fs.writeFileSync(process.env.FAKE_START_PENDING + "-swapped", ""); }
    starting = id; fs.writeFileSync(process.env.FAKE_START_PENDING, "");
    for (let i = 0; i < 400 && starting === id && !fs.existsSync(process.env.FAKE_START_GATE); i++) await sleep(50);
    if (starting !== id) return;
    starting = false;
  }
  busy = true; turn = "turn-" + (++n); steered = 0;
  const reply = { id, result: { turn: { id: turn, items: [], status: "inProgress" } } };
  if (held === id) (async () => { while (!gate()) await sleep(50); out(reply); held = null; })(); else out(reply);
  out({ method: "turn/started", params: { threadId: thread, turn: { id: turn, items: [], status: "inProgress" } } });
  out({ method: "item/started", params: { threadId: thread, turnId: turn, startedAtMs: 0, item: { type: text.includes("MCP") ? "mcpToolCall" : "commandExecution", id: "c", command: "an argument" } } });
  if (text.includes("ASK")) out({ id: 900, method: "item/tool/requestUserInput", params: { threadId: thread, turnId: turn, questions: [] } });
  if (text.includes("HOLD")) for (let i = 0; i < 400 && !nextSteer && !fs.existsSync(process.env.FAKE_GATE); i++) await sleep(50);
  out({ method: "item/completed", params: { threadId: thread, turnId: turn, completedAtMs: 0, item: { type: "agentMessage", id: "m1", phase: "commentary", text: "COMMENTARY-not-the-report" } } });
  out({ method: "item/completed", params: { threadId: thread, turnId: turn, completedAtMs: 0, item: { type: "agentMessage", id: "m2", phase: "final_answer", text: "VERDICT: done\\nSUMMARY: turn with " + steered + " steered messages" } } });
  const t = turn; turn = null; busy = false;
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: t, items: [], status: text.includes("FAIL") ? "failed" : "completed" } } });
  if (nextSteer) { out({ id: nextSteer, error: { code: -32600, message: "no active turn to steer" } }); nextSteer = null; }
  if (ended && !held) process.exit(0);
}
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const e = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (e.id != null && !e.method) { if (process.env.FAKE_ANSWERS) fs.appendFileSync(process.env.FAKE_ANSWERS, JSON.stringify(e) + "\\n"); continue; }
  log(e.method, { ...e.params, ...(process.env.FAKE_TRACE_RPC ? { trace: e.trace, worker: a.includes("check_for_update_on_startup=false"), request: e.id != null } : {}) });
  const p = e.params ?? {};
  if (e.method === "initialize") out({ id: e.id, result: { userAgent: "fake" } });
  else if (e.method === "thread/start") { if (p.model === "nosuch") out({ id: e.id, error: { code: -32600, message: "model not found" } }); else { thread = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"; out({ id: e.id, result: { thread: { id: thread } } }); } }
  else if (e.method === "thread/resume") { thread = p.threadId; out({ id: e.id, result: { thread: { id: thread } } }); }
  else if (e.method === "turn/start") run(e.id, p.input[0].text);
  else if (e.method === "turn/steer") { if (process.env.FAKE_STEER_NEXT && turn) { nextSteer = e.id; continue; } if (turn && p.expectedTurnId === turn) { steered++; out({ id: e.id, result: { turnId: turn } }); } else out({ id: e.id, error: { code: -32600, message: "no active turn to steer" } }); }
} });
// FAKE_HOLD_EXIT: once its input closes, it stays until the test writes FAKE_EXIT_GATE, as Claude's fake does.
process.stdin.on("end", () => { ended = true; if (!busy) { const leave = () => (held || (process.env.FAKE_HOLD_EXIT && !fs.existsSync(process.env.FAKE_EXIT_GATE)) ? setTimeout(leave, 50) : process.exit(0)); leave(); } });
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
  else if (e.method === "session/new") { log({ method: e.method, cwd: p.cwd, _meta: p._meta }); if (process.env.FAKE_NEW_DIE) { setTimeout(() => process.exit(0), 1500); continue; } out({ id: e.id, result: { sessionId: SID, models: { currentModelId: a[a.indexOf("--model") + 1] } } }); }
  else if (e.method === "session/load") { log({ method: e.method, sessionId: p.sessionId, cwd: p.cwd, _meta: p._meta }); if (process.env.FAKE_LOAD_DIE) process.exit(0); const ms = Number(process.env.FAKE_LOAD_MS ?? 0); if (ms) { const id = e.id; setTimeout(() => { up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED-not-the-report" } }); out({ id, result: {} }); }, ms); continue; } up({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "an old prompt" } }); up({ sessionUpdate: "tool_call", toolCallId: "old", kind: "edit" }); up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED-not-the-report" } }); out({ id: e.id, result: {} }); }
  else if (e.method === "session/prompt") { log({ method: e.method, _meta: p._meta, busy, tag: (p.prompt[0].text.match(/TAG-\\w+/) ?? [null])[0] }); if (busy) out({ id: e.id, error: { code: -32603, message: "Internal error", data: "Prompt already in progress" } }); else prompt(e.id, p.prompt[0].text); }
} });
process.stdin.on("end", () => { ended = true; if (!busy) process.exit(0); });
`;
// Cursor's -p stream-json, as measured (p41): it reads its prompt to EOF, then system/init (the session), user,
// assistant messages, tool_call started/completed, and a result whose `result` joins every assistant message; it exits
// after. --resume continues a session. Like Cursor it rewrites the config in CURSOR_CONFIG_DIR (FAKE_RPC logs where).
// HOLD, FAIL as above.
const FAKE_CURSOR = `
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2);
if (a[0] === "status") { console.log("\\u2713 Logged in as user@example.com"); process.exit(0); }
if (a[0] === "models") { console.log("grok-4.7-medium-fast - Grok"); process.exit(0); }
if (!a.includes("-p")) process.exit(0);
if (process.env.FAKE_ARGV) fs.appendFileSync(process.env.FAKE_ARGV, JSON.stringify(["cursor-agent", ...a]) + "\\n");
const dir = process.env.CURSOR_CONFIG_DIR;
if (process.env.FAKE_RPC) fs.appendFileSync(process.env.FAKE_RPC, JSON.stringify({ method: "cursor", config_dir: dir ?? null, has_config: !!dir && fs.existsSync(path.join(dir, "cli-config.json")) }) + "\\n");
if (dir) fs.writeFileSync(path.join(dir, "cli-config.json"), JSON.stringify({ model: { modelId: "rewritten-by-cursor" } }));
const sid = a.includes("--resume") ? a[a.indexOf("--resume") + 1] : "680aee64-2595-41b4-8d06-f7bfd483dab9";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let text = "";
process.stdin.on("data", (d) => (text += d));
process.stdin.on("end", async () => {
  // Like Cursor's worker-server: started by the first turn in its group, as <install>/<v>/node <install>/<v>/index.js
  // worker-server, it outlives it (HELPER, once). LINGER: a command of its own left in its group, as for Claude.
  const { spawn } = require("node:child_process"), h = process.env.FAKE_HELPER;
  if (text.includes("HELPER") && process.platform !== "win32" && !fs.existsSync(path.join(h, "pids"))) spawn(path.join(h, "node"), [path.join(h, "index.js"), "worker-server"], { stdio: "ignore" }).unref();
  if (text.includes("LINGER")) spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.env.FAKE_LINGER, String(process.pid)); setInterval(() => {}, 1000)"], { stdio: "ignore" }).unref();
  out({ type: "system", subtype: "init", session_id: sid, apiKeySource: "login", model: "m" });
  out({ type: "user", message: { role: "user", content: [{ type: "text", text: "echo" }] }, session_id: sid });
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Let me look first." }] }, session_id: sid });
  out({ type: "tool_call", subtype: "started", call_id: "c", tool_call: { shellToolCall: { args: { command: "an argument" } } }, session_id: sid });
  if (text.includes("HOLD")) for (let i = 0; i < 400 && !fs.existsSync(process.env.FAKE_GATE); i++) await sleep(50);
  out({ type: "tool_call", subtype: "completed", call_id: "c", tool_call: { shellToolCall: {} }, session_id: sid });
  const tag = (text.match(/TAG-\\w+/) ?? ["none"])[0], final = "VERDICT: done\\nSUMMARY: cursor " + tag;
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: final }] }, session_id: sid });
  out({ type: "result", subtype: "success", is_error: text.includes("FAIL"), result: "Let me look first." + final, session_id: sid });
  // Like Cursor: something of it still exiting just after it closes (TRAIL: a child that outlives it by 300 ms).
  if (text.includes("TRAIL")) require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore" }).unref();
  process.exit(0);
});
`;
// The fake worker-server: it starts a language server as Cursor's does (STRAY: anything else too), and they stay.
const FAKE_HELPER = `
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process"), h = process.env.FAKE_HELPER;
const kids = [spawn(path.join(h, "node"), [path.join(h, "node_modules", ".bin", "typescript-language-server"), "--stdio"], { stdio: "ignore" })];
if (process.env.FAKE_HELPER_STRAY) kids.push(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
fs.writeFileSync(path.join(h, "pids"), JSON.stringify([process.pid, ...kids.map((k) => k.pid)]));
setInterval(() => {}, 1000);
`;
const BRIEF = "PRIVATE-BRIEF-7f3a: rename foo to bar in x.js. Check: grep bar x.js.";
const SENT = "PRIVATE-SEND-91c2: also rename baz.";

function world(over = {}) {
  const home = shortHome(), bin = join(home, "bin"), work = join(home, "work"), inputs = join(home, "inputs");
  for (const d of [bin, work, inputs]) mkdirSync(d, { recursive: true });
  // The child's own entries, by the names it has them under: on Windows process.env[k] finds a variable under any case,
  // so looking each name up would record one variable under both its spellings.
  const recordEnv = `if (process.env.FAKE_ENV) { const names = new Set(${JSON.stringify([...Object.keys(LEAD_ENV), ...Object.keys(LEAD_ENV).map((k) => k.toLowerCase()), ...Object.keys(CONFIG_ENV), ...CARRIERS, ...CARRIERS.map((k) => k.toLowerCase())])}); require("node:fs").appendFileSync(process.env.FAKE_ENV, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => names.has(k))) }) + "\\n"); }\n`;
  fakeExecutable(bin, "claude", recordEnv + FAKE_CLAUDE);
  fakeExecutable(bin, "codex", recordEnv + FAKE_CODEX);
  fakeExecutable(bin, "agy", recordEnv + FAKE_AGY);
  fakeExecutable(bin, "kiro-cli", recordEnv + FAKE_KIRO);
  fakeExecutable(bin, "cursor-agent", recordEnv + FAKE_CURSOR);
  // Cursor's layout: the command on PATH resolves to <install>/bin/cursor-agent here, so its versions are <install>/<v>.
  const helper = join(realpathSync.native(home), "v1");
  mkdirSync(join(helper, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(helper, "index.js"), FAKE_HELPER); writeFileSync(join(helper, "node_modules", ".bin", "typescript-language-server"), "setInterval(() => {}, 1000);\n");
  if (POSIX) symlinkSync(process.execPath, join(helper, "node"));
  const gate = join(home, "gate"), linger = join(home, "linger");
  // git's own folder too: launch --worktree and cleanup run it, as they would for a person.
  const env = cliEnv(home, { PATH: [bin, dirname(process.execPath), dirname(Bun.which("git") ?? "git")].join(delimiter), FAKE_ARGV: join(home, "argv.jsonl"), FAKE_RPC: join(home, "rpc.jsonl"), FAKE_ANSWERS: join(home, "answers.jsonl"), FAKE_EOF: join(home, "eof.jsonl"), FAKE_GATE: gate, FAKE_LINGER: linger, FAKE_HELPER: helper, ...over });
  for (const k of Object.keys(env)) if (/^(HERDR_|CLAUDECODE$|CLAUDE_CODE_SESSION|SANDBOX_RUNTIME$|CODEX_SANDBOX)/.test(k)) delete env[k];
  // The machine's own trace context never reaches a test's routr: only what a test gives.
  for (const k of Object.keys(env)) if (/^(TRACEPARENT|TRACESTATE|BAGGAGE)$/i.test(k) && !Object.hasOwn(over, k)) delete env[k];
  // Inject sandbox markers only in the holder: the public launch correctly refuses a genuinely sandboxed lead.
  const entry = over.FAKE_HOLDER_ENV || over.FAKE_TRACE_WRITES ? join(home, "routr.mjs") : SCRIPT;
  if (over.FAKE_HOLDER_ENV) writeFileSync(entry, `if (process.argv.includes("--hold")) Object.assign(process.env, JSON.parse(process.env.FAKE_HOLDER_ENV)); await import(${JSON.stringify(SCRIPT)});\n`);
  if (over.FAKE_TRACE_WRITES) writeFileSync(entry, `
    import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { writeJsonAtomic, start, harnessEnv } from ${JSON.stringify(new URL("../src/lib/runtime.mjs", import.meta.url).href)};
    import { fileURLToPath } from "node:url";
    if (process.argv.includes("--hold")) {
      process.env.FAKE_HOLDER_TRACE = "1";
      const { hold, runDir, ADAPTERS } = await import(${JSON.stringify(new URL("../src/lib/headless.mjs", import.meta.url).href)});
      if (process.env.FAKE_REJECT_HANDOVER) {
        const connect = ADAPTERS.agy.connect;
        ADAPTERS.agy.connect = (c, o) => {
          const h = connect(c, o); let rejected = false;
          return { ...h, send: async (...args) => {
            if (!rejected) {
              rejected = true; writeFileSync(join(process.env.HOME, "rejected-context.json"), JSON.stringify(o.turnCarriers()));
              const file = join(process.env.HOME, ".config/routr/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
              config.otel.consent = "a".repeat(32); writeFileSync(file, JSON.stringify(config));
              return { code: "refused", why: "harness_refused" };
            }
            return h.send(...args);
          } };
        };
      }
      const name = process.argv[process.argv.indexOf("--hold") + 1];
      await hold(name, { otel: { spawn: () => false, write: (file, body, opts) => {
        if (body.resourceSpans) {
          const state = JSON.parse(readFileSync(join(runDir(name), "state.json"), "utf8")), turn = state.turns.at(-1);
          appendFileSync(join(process.env.HOME, "emissions.jsonl"), JSON.stringify({ outcome: turn.outcome ?? null, report: turn.report != null && existsSync(turn.report) }) + "\\n");
        }
        writeJsonAtomic(file, body, opts);
      } } });
    } else if (["launch", "send"].includes(process.argv[2])) {
      const spawn = (args) => { const c = start(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: "ignore", env: harnessEnv() }); c.on("error", () => {}); c.unref(); return true; };
      const result = process.argv[2] === "launch"
        ? await (await import(${JSON.stringify(new URL("../src/lib/launch.mjs", import.meta.url).href)})).launch(process.argv.slice(3), { spawn })
        : await (await import(${JSON.stringify(new URL("../src/lib/workers.mjs", import.meta.url).href)})).sendCommand(process.argv.slice(3), { spawn });
      console.log(JSON.stringify(result));
    } else await import(${JSON.stringify(new URL("../src/routr.mjs", import.meta.url).href)});
  `);
  const outputs = [];
  const run = (args, extra = {}) => {
    const r = Bun.spawnSync([process.execPath, entry, ...args], { cwd: work, env: { ...env, ...extra }, stdin: "ignore" });
    const text = r.stdout.toString(); outputs.push(text, r.stderr.toString());
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  const task = (text, name = "task.md") => { const f = join(inputs, name); writeFileSync(f, text); return f; };
  const advise = (file) => { const a = join(home, `${file.split(/[\\/]/).pop()}.advice.json`); writeFileSync(a, JSON.stringify(run(["dispatch", "--task-file", file]))); return a; };
  const launchW = (name, file, more = [], extra, kind = "claude", model) => run(["launch", "--kind", kind, "--name", name, "--model", model ?? { codex: "gpt-6-luna", agy: "gemini-3.8-flash-low", kiro: "auto", cursor: "grok-4.7-medium-fast" }[kind] ?? "haiku", "--task-file", file, "--advice", advise(file), ...more], extra);
  const runDir = (name) => join(home, ".local", "state", "routr", "workers", name);
  const state = (n) => { try { return JSON.parse(readFileSync(join(runDir(n), "state.json"), "utf8")); } catch { return {}; } };
  const settled = (n) => until(() => !["working", "waiting", "starting"].includes(state(n).state));
  const helperPids = () => { try { return JSON.parse(readFileSync(join(helper, "pids"), "utf8")); } catch { return []; } };
  // Every process run from this world's helper folder too, recorded or not.
  const killHelper = () => { for (const pid of helperPids()) try { process.kill(pid, "SIGKILL"); } catch {} if (POSIX) Bun.spawnSync(["pkill", "-9", "-f", helper]); };
  return { home, work, gate, linger, inputs, env, run, helperPids, killHelper, outputs, task, advise, launch: launchW, runDir, state, settled, release: () => writeFileSync(gate, "") };
}
const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map(String).filter((f) => { try { return statSync(join(dir, f)).isFile(); } catch { return false; } });

// A worker's state that is there and cannot be read is never taken for one not written yet: no command answers "no
// session" or "nothing runs" from it, and no holder starts over it (one that did would write over its session).
test("a worker state routr cannot read is unknown to every command, never absent, and no holder starts over it", async () => {
  const w = world(), name = "u1", dir = w.runDir(name);
  expect(w.launch(name, w.task(BRIEF)).ok).toBe(true);
  expect(await w.settled(name)).toBe(true);
  expect(await until(() => existsSync(join(dir, "gen-1.released")))).toBe(true);
  const keep = (f) => readFileSync(join(dir, f), "utf8"), put = (f, text) => writeFileSync(join(dir, f), text);
  const good = keep("state.json"), record = keep("worker.json"), released = keep("gen-1.released"), ready = keep("gen-1.ready"), broken = '{"format":1,"turn":';
  expect(JSON.parse(good).session_id).toBeTruthy();
  expect(w.run(["wait", "--timeout", "300"]).state).toBe("finished"); // its turn is reported: nothing new after this
  const why = (file) => `${name}'s ${file} could not be read just now (not_json), so what it is doing is not known: try again in a moment`;
  const damaged = expect.objectContaining({ kind: "do", why: expect.stringContaining(`If it stays unreadable, it is damaged and routr will not act on ${name}`) });
  // Its state, then its record: each unknown, never absent.
  for (const [file, more] of [["state.json", {}], ["worker.json", { kind: null }]]) {
    put(file, broken);
    expect([file, w.run(["workers", "--name", name]).workers[0]]).toEqual([file, expect.objectContaining({ name, state: "unreadable", ...more })]);
    for (const named of [["--name", name], []]) expect(w.run(["wait", ...named, "--timeout", "300"])).toMatchObject({ ok: true, state: "running", headline: `routr: still running: ${name} (its state could not be read)` });
    const sent = w.run(["send", "--name", name, "--task", SENT]);
    expect([file, sent.ok, sent.error, sent.next]).toEqual([file, false, why(file), expect.arrayContaining([damaged])]);
    const stopped = w.run(["stop", "--name", name]);
    expect([file, stopped.ok, stopped.state, stopped.headline, stopped.next]).toEqual([file, false, "unknown", `routr: ${why(file)}`, expect.arrayContaining([damaged])]);
    const kept = w.run(["cleanup", "--worker", name]);
    expect([file, kept.state, kept.headline, kept.next]).toEqual([file, "refused", `routr: kept ${name}: ${why(file)}`, expect.arrayContaining([damaged])]);
    // A holder asked to start (as send or launch would) leaves it as it is and claims nothing.
    w.run(["workers", "--hold", name]);
    expect([keep(file), existsSync(join(dir, "gen-2.claim"))]).toEqual([broken, false]);
    put(file, file === "state.json" ? good : record);
  }
  // A released marker that is there and cannot be read says neither that it ended nor that it did not.
  put("gen-1.released", "{");
  const marker = why("gen-1.released");
  const unstopped = w.run(["stop", "--name", name]);
  expect([unstopped.ok, unstopped.state, unstopped.headline, unstopped.next]).toEqual([false, "unreachable", `routr: ${marker}`, expect.arrayContaining([damaged])]);
  const unkept = w.run(["cleanup", "--worker", name]);
  expect([unkept.state, unkept.headline, unkept.next]).toEqual(["refused", `routr: kept ${name}: ${marker}`, expect.arrayContaining([damaged])]);
  expect(w.run(["send", "--name", name, "--task", SENT])).toMatchObject({ ok: false, error: marker });
  put("gen-1.released", released);
  // So is a claim with no ready or released marker beside it.
  const claim = keep("gen-1.claim");
  for (const f of ["gen-1.ready", "gen-1.released"]) rmSync(join(dir, f));
  put("gen-1.claim", "{");
  expect(w.run(["stop", "--name", name])).toMatchObject({ ok: false, state: "unreachable", headline: `routr: ${why("gen-1.claim")}` });
  put("gen-1.claim", claim); put("gen-1.ready", ready); put("gen-1.released", released);
  // A readable release is the holder's word, whatever its ready marker now holds.
  put("gen-1.ready", "{");
  expect(w.run(["stop", "--name", name])).toMatchObject({ ok: true, state: "absent" });
  put("gen-1.ready", ready);
  expect(w.run(["cleanup", "--worker", name]).state).toBe("removed");
}, 90000);

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

test("Kiro: a correction queued while its first start fails is not lost: it gets a turn of its own, not started", async () => {
  // The fake answers session/new never, and exits 1.5 s in: no session is ever named. The launch runs meanwhile.
  const w = world({ FAKE_NEW_DIE: "1" }), file = w.task(BRIEF);
  const p = Bun.spawn([process.execPath, SCRIPT, "launch", "--kind", "kiro", "--name", "k8", "--model", "auto", "--task-file", file, "--advice", w.advise(file)], { cwd: w.work, env: w.env, stdout: "pipe", stderr: "pipe" });
  expect(await until(() => w.state("k8").state === "working")).toBe(true);
  expect(w.run(["send", "--name", "k8", "--task", `${SENT} TAG-early`]).state).toBe("queued");
  await p.exited;
  await w.settled("k8");
  expect([w.state("k8").turns.map((t) => [t.outcome, t.delivered]), w.state("k8").queued]).toEqual([[["no_finish", 0], ["not_started", 1]], 0]);
  w.run(["cleanup", "--worker", "k8"]);
}, 60000);

test("Claude: a queued message of several paragraphs is counted once on the turn that resumes it", async () => {
  const w = world({ FAKE_HOLD_EXIT: "1" });
  expect(w.launch("q2", w.task(BRIEF)).state).toBe("prompted");
  // Claude has finished its turn and is slow to exit: its input is closed, so the message waits for the next process.
  expect(await until(() => w.state("q2").turns?.[0]?.outcome === "finished")).toBe(true);
  expect(w.run(["send", "--name", "q2", "--task", "First paragraph.\n\nSecond paragraph.\n\nThird."]).state).toBe("queued");
  w.release();
  expect(await until(() => w.state("q2").turns?.length === 2 && w.state("q2").turns[1].outcome === "finished", 20000)).toBe(true);
  await w.settled("q2");
  expect(w.state("q2").turns.map((t) => t.delivered)).toEqual([0, 1]);
  w.run(["cleanup", "--worker", "q2"]);
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

test("a headless Cursor worker: one process a turn on a private config copy, corrections resumed as turns of their own, in order, past Cursor's own worker-server", async () => {
  const w = world(), userConfig = join(w.home, ".cursor", "cli-config.json"), dotfile = join(w.home, "dotfiles", "cli-config.json");
  afterAll(w.killHelper);
  // On macOS and Linux, a config that is a link into a dotfiles folder (copied as a link).
  for (const d of [dirname(userConfig), dirname(dotfile)]) mkdirSync(d, { recursive: true });
  writeFileSync(POSIX ? dotfile : userConfig, JSON.stringify({ model: { modelId: "the-user's" } }));
  if (POSIX) symlinkSync(dotfile, userConfig);
  const dotMode = statSync(POSIX ? dotfile : userConfig).mode & 0o777;
  const l = w.launch("u1", w.task(`${BRIEF} HOLD HELPER TRAIL`), [], undefined, "cursor");
  expect([l.ok, l.state, l.headline, l.worker.session]).toEqual([true, "prompted", "routr: u1 (cursor) took its task, running headless", "680aee64-2595-41b4-8d06-f7bfd483dab9"]);
  expect(l.start.argv).toEqual(["-p", "--output-format", "stream-json", "--yolo", "--trust", "--model", "grok-4.7-medium-fast"]);
  // Its own copy, in the run folder: what Cursor rewrites there never reaches the user's.
  const conf = join(w.runDir("u1"), "cursor-config");
  expect(await until(() => rpcs(w).some((r) => r.method === "cursor"))).toBe(true);
  expect(rpcs(w).find((r) => r.method === "cursor")).toEqual({ method: "cursor", config_dir: conf, has_config: true });
  if (POSIX) expect([lstatSync(join(conf, "cli-config.json")).isSymbolicLink(), statSync(join(conf, "cli-config.json")).mode & 0o077, statSync(dotfile).mode & 0o777]).toEqual([false, 0, dotMode]);
  expect(await until(() => w.state("u1").last_tool === "shell")).toBe(true);
  // Mid-turn: the holder keeps both messages; each runs as a turn of its own, resuming the session, in order.
  for (const t of ["first", "second"]) {
    const s = w.run(["send", "--name", "u1", "--task", `${SENT} TAG-${t}`]);
    expect([s.state, s.headline]).toEqual(["queued", "routr: u1: queued: it runs as the worker's next turn, in a new Cursor process on the same session"]);
  }
  w.release();
  expect(await until(() => w.state("u1").turns?.length === 3 && w.state("u1").turns.every((t) => t.outcome === "finished"), 20000)).toBe(true);
  await w.settled("u1");
  expect(w.state("u1").turns.map((t) => t.delivered)).toEqual([0, 1, 1]);
  expect(w.state("u1").turns.map((t) => readFileSync(t.report, "utf8"))).toEqual(["VERDICT: done\nSUMMARY: cursor none", "VERDICT: done\nSUMMARY: cursor TAG-first", "VERDICT: done\nSUMMARY: cursor TAG-second"]);
  const runs = readFileSync(join(w.home, "argv.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x)).filter((x) => x[0] === "cursor-agent");
  expect(runs.map((x) => x.includes("--resume") ? x[x.indexOf("--resume") + 1] : null)).toEqual([null, "680aee64-2595-41b4-8d06-f7bfd483dab9", "680aee64-2595-41b4-8d06-f7bfd483dab9"]);
  expect(JSON.parse(readFileSync(userConfig, "utf8"))).toEqual({ model: { modelId: "the-user's" } });
  for (const o of w.outputs) for (const m of ["PRIVATE-BRIEF", "PRIVATE-SEND"]) expect([m, o.includes(m)]).toEqual([m, false]);
  noBriefInFiles(w);
  // The worker-server, and what it started, still run in the first turn's group: they are Cursor's, not the worker.
  if (POSIX) expect(w.helperPids().map((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } })).toEqual([true, true]);
  const listed = w.run(["workers", "--name", "u1"]).workers[0];
  expect(listed.harness_group).toBeUndefined();
  const c = w.run(["cleanup", "--worker", "u1"]);
  expect([c.state, c.warnings.includes(`Cursor's own worker-server for ${listed.cwd} may still be running, as after a cursor-agent run there: it is Cursor's, and routr leaves it`)]).toEqual(["removed", true]);
  w.killHelper();
  expect(existsSync(conf)).toBe(false);
  // No config of its own to copy: refused, and nothing is left behind.
  rmSync(userConfig);
  const none = w.launch("u2", w.task(BRIEF, "n.md"), [], undefined, "cursor");
  expect([none.ok, none.error, existsSync(w.runDir("u2"))]).toEqual([false, `Cursor has no config at ${userConfig}: sign in with \`cursor-agent\` first`, false]);
}, 60000);

// cleanup --worker until it removes the worker, never once more after (until asks its check again at the end).
const removedOnce = async (w, name) => { let done = false; return until(() => done || (done = w.run(["cleanup", "--worker", name]).state === "removed")); };

test("a Cursor turn that leaves a command in its group: a stop in the wait after it says still_exiting and drops the queue; one under its worker-server blocks too", async () => {
  if (!POSIX) return; // process groups: macOS and Linux
  const w = world(), userConfig = join(w.home, ".cursor", "cli-config.json");
  afterAll(() => { try { process.kill(Number(readFileSync(w.linger, "utf8")), "SIGKILL"); } catch {} });
  mkdirSync(dirname(userConfig), { recursive: true }); writeFileSync(userConfig, "{}");
  expect(w.launch("u5", w.task(`${BRIEF} HOLD LINGER`), [], undefined, "cursor").state).toBe("prompted");
  expect(w.run(["send", "--name", "u5", "--task", `${SENT} TAG-late`]).state).toBe("queued");
  w.release();
  // Its turn ends and Cursor exits; the holder looks at the group for up to 2 s, with the message still kept.
  expect(await until(() => w.state("u5").turns?.[0]?.outcome === "finished" && existsSync(w.linger))).toBe(true);
  await Bun.sleep(400);
  const s = w.run(["stop", "--name", "u5"]);
  expect([s.state, s.warnings.some((x) => x.startsWith("1 queued message was dropped"))]).toEqual(["still_exiting", true]);
  await w.settled("u5");
  expect(w.state("u5").turns.map((t) => t.outcome)).toEqual(["finished"]);
  expect(w.run(["cleanup", "--worker", "u5"]).state).toBe("refused");
  process.kill(Number(readFileSync(w.linger, "utf8")), "SIGKILL");
  expect(await removedOnce(w, "u5")).toBe(true);

  // Something under the worker-server that is not its language server counts as the worker's: the correction is not
  // resumed, and cleanup refuses until it has gone.
  const x = world({ FAKE_HELPER_STRAY: "1" }), conf = join(x.home, ".cursor", "cli-config.json");
  afterAll(x.killHelper);
  mkdirSync(dirname(conf), { recursive: true }); writeFileSync(conf, "{}");
  expect(x.launch("u6", x.task(`${BRIEF} HOLD HELPER`), [], undefined, "cursor").state).toBe("prompted");
  expect(x.run(["send", "--name", "u6", "--task", `${SENT} TAG-x`]).state).toBe("queued");
  x.release();
  expect(await until(() => x.state("u6").turns?.length === 2, 20000)).toBe(true);
  await x.settled("u6");
  expect(x.state("u6").turns.map((t) => t.outcome)).toEqual(["finished", "not_started"]);
  expect(x.run(["cleanup", "--worker", "u6"]).state).toBe("refused");
  x.killHelper();
  expect(await removedOnce(x, "u6")).toBe(true);
}, 60000);

test("Cursor's stream as routr reads it: the session, fixed tool names, the last assistant message as the report", () => {
  const read = cursorReader(), j = (o) => read(JSON.stringify(o));
  expect(j({ type: "system", subtype: "init", session_id: "680aee64-2595-41b4-8d06-f7bfd483dab9" })).toEqual({ turn: true, session: "680aee64-2595-41b4-8d06-f7bfd483dab9" });
  expect(j({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }] } })).toEqual({ activity: true });
  for (const [k, tool] of [["shellToolCall", "shell"], ["mcpToolCall", "mcp"], ["somethingNewToolCall", "other"]]) expect(j({ type: "tool_call", subtype: "started", tool_call: { [k]: {} } })).toEqual({ tool });
  j({ type: "assistant", message: { content: [{ type: "text", text: "the answer" }] } });
  expect(j({ type: "result", is_error: false, result: "Looking.the answer" })).toEqual({ result: { failed: false, text: "the answer" } });
  expect(j({ type: "result", is_error: true, result: "only this" })).toEqual({ result: { failed: true, text: "only this" } });
  expect([read("not json"), j({ type: "thinking", subtype: "delta" })]).toEqual([null, null]);
});

test("what of a process group counts as the worker still running: everything but its harness's own helper, in its install, and the language server under it", async () => {
  const exe = "/x/.local/share/cursor-agent/versions/2026.10.22-27dcf5f/cursor-agent", v = "/x/.local/share/cursor-agent/versions";
  const { command, children } = HARNESSES.cursor.helper, helper = command(exe), pg = 400;
  const ps = [
    `  400     1   400 ${v}/2026.10.22-27dcf5f/node ${v}/2026.10.22-27dcf5f/index.js worker-server`,
    "  401   400   400 npm exec typescript-language-server --stdio    ",
    "  402   401   400 node /x/.npm/_npx/9/node_modules/.bin/typescript-language-server --stdio",
    "  500     1   500 /bin/sleep 60", ""].join("\n");
  const members = groupMembers(ps, pg);
  expect(members.map((m) => m.pid)).toEqual([400, 401, 402]);
  expect(besidesHelper(members, helper, children)).toEqual([]);
  // What still counts : a command a turn left, and what it started; anything else under the helper; a
  // worker-server outside the install, or with its node and script from two versions.
  const more = (rows) => groupMembers(ps + rows.join("\n"), pg);
  expect(besidesHelper(more(["  410     1   400 /bin/sh -c npm run dev", "  411   410   400 node server.js"]), helper, children).map((m) => m.pid)).toEqual([410, 411]);
  expect(besidesHelper(more(["  412   400   400 /bin/sh -c npm test", "  413   412   400 node /w/node_modules/.bin/typescript-language-server --stdio"]), helper, children).map((m) => m.pid)).toEqual([412, 413]);
  expect(besidesHelper(more(["  414     1   400 /repo/test/fixtures/cursor-agent/versions/v1/node /repo/test/fixtures/cursor-agent/versions/v1/index.js worker-server"]), helper, children).map((m) => m.pid)).toEqual([414]);
  expect(besidesHelper(more([`  415     1   400 ${v}/a/node ${v}/b/index.js worker-server`]), helper, children).map((m) => m.pid)).toEqual([415]);
  // A line it cannot read: nothing of the group is told apart.
  expect([groupMembers(ps + "garbage", pg), groupMembers("", pg)]).toEqual([null, []]);
  if (!POSIX) return;
  // On a live group: no helper for the harness, ps not answering or unreadable, an empty listing, no install found:
  // every member counts. Only the helper and its language server, in the install, do not.
  const c = start(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const live = (rows) => async () => rows.map((r) => ({ ...r, pid: r.pid === 400 ? c.pid : r.pid, ppid: r.ppid === 400 ? c.pid : r.ppid }));
    const o = (m, installed = () => exe) => ({ members: m, installed });
    expect(await Promise.all([groupAlive(c.pid, "claude", o(live(members))), groupAlive(c.pid, "cursor", o(live(members))), groupAlive(c.pid, "cursor", o(async () => null)),
      groupAlive(c.pid, "cursor", o(async () => [])), groupAlive(c.pid, "cursor", o(live(members), () => null)), groupAlive(c.pid, "cursor"), groupAlive(null, "cursor")]))
      .toEqual([true, false, true, true, true, true, false]);
    // A listing ps did not finish : nothing of it is read. One it finished is.
    const fake = join(scratch("ps-"), "ps"), line = `${c.pid} 1 ${c.pid} /x/whatever`;
    writeFileSync(fake, `#!/bin/sh\necho "${line}"\nexit 1\n`, { mode: 0o755 });
    expect(await listGroup(c.pid, 2000, { ps: fake })).toBeNull();
    writeFileSync(fake, `#!/bin/sh\necho "${line}"\n`, { mode: 0o755 });
    expect(await listGroup(c.pid, 2000, { ps: fake })).toEqual([{ pid: c.pid, ppid: 1, command: "/x/whatever" }]);
    // Where the command on PATH is: not told when a relative or empty entry comes before it.
    expect([installedAt("sh", { env: { PATH: "/nowhere:/bin" } }), installedAt("sh", { env: { PATH: "tools:/bin" } }), installedAt("sh", { env: { PATH: ":/bin" } })])
      .toEqual([realpathSync.native("/bin/sh"), null, null]);
    // A look that does not answer is bounded by what is left of the wait, and counts as running.
    const t0 = Date.now();
    expect(await groupGone(c.pid, "cursor", { ms: 300, members: () => new Promise(() => {}), installed: () => exe })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  } finally { stop(c, { group: true }); }
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

test("every headless adapter removes every lead session name on its initial and resumed turns, keeping sign-in and config", async () => {
  for (const kind of Object.keys(ADAPTERS)) {
    const w = world({ FAKE_HOLDER_ENV: JSON.stringify({ CODEX_SANDBOX: "lead-session", codex_sandbox: "lead-session" }) }), log = join(w.home, "env.jsonl");
    if (kind === "cursor") { mkdirSync(join(w.home, ".cursor")); writeFileSync(join(w.home, ".cursor", "cli-config.json"), "{}"); }
    Object.assign(w.env, LEAD_ENV, Object.fromEntries(Object.entries(LEAD_ENV).map(([k, v]) => [k.toLowerCase(), v])), CONFIG_ENV, { FAKE_ENV: log });
    delete w.env.CODEX_SANDBOX; delete w.env.codex_sandbox;
    try {
      const launched = w.launch("env", w.task(BRIEF), [], undefined, kind);
      expect([kind, launched.state, launched.error]).toEqual([kind, "prompted", undefined]);
      expect(w.run(["wait", "--name", "env", "--timeout", "20000"]).state).toBe("finished");
      expect(await w.settled("env")).toBe(true);
      expect(w.run(["send", "--name", "env", "--task-file", w.task(SENT, "more.md")]).state).toBe("resumed");
      expect(w.run(["wait", "--name", "env", "--timeout", "20000"]).state).toBe("finished");
      expect(await w.settled("env")).toBe(true);
      const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const turns = rows.filter(({ argv }) => kind === "codex" ? argv[0] === "app-server" : kind === "kiro" ? argv[0] === "acp" : kind === "agy" ? argv.includes("--print=") : argv.includes("-p"));
      expect(turns).toHaveLength(2);
      if (kind === "cursor") expect(rows.filter(({ argv }) => argv[0] === "status").length).toBeGreaterThan(0);
      for (const row of rows) {
        const { env } = row;
        for (const k of Object.keys(LEAD_ENV)) { expect(env).not.toHaveProperty(k); expect(env).not.toHaveProperty(k.toLowerCase()); }
        const config = { ...CONFIG_ENV };
        // Cursor deliberately replaces the config location for its worker, while every other setting passes intact.
        if (kind === "cursor" && turns.includes(row)) config.CURSOR_CONFIG_DIR = join(w.runDir("env"), "cursor-config");
        expect(env).toEqual(config);
      }
    } finally { w.run(["stop", "--name", "env"]); w.run(["cleanup", "--worker", "env"]); }
  }
}, 90000);

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

// Trace-context carriers for headless workers: launch saves the ones within routr's limits with the worker, and every
// turn gets those, whoever starts the holder: detached holders inherit no carriers, and must read the launch's
// carriers from worker.json, not the sender's.
const LAUNCHED = { TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-CARRIER_HL_TP-01", TRACESTATE: "k=CARRIER_HL_TS,\tz=\"%PATH%\"", BAGGAGE: "a=CARRIER_HL_BG;p=1,b=c d!&'" };
const turnsOf = (kind, rows) => rows.filter(({ argv }) => kind === "codex" ? argv[0] === "app-server" && argv.includes("check_for_update_on_startup=false") : kind === "kiro" ? argv[0] === "acp" : kind === "agy" ? argv.includes("--print=") : kind === "claude" ? argv.includes("--input-format") : argv.includes("-p") && argv.includes("--trust"));
const carriersIn = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => /^(traceparent|tracestate|baggage)$/i.test(k)));

test("every headless adapter's turns get the launch's carriers, a process per turn or a long-lived one, and a holder send restarts gets the launch's, not the sender's", async () => {
  for (const kind of Object.keys(ADAPTERS)) {
    const w = world(LAUNCHED), log = join(w.home, "env.jsonl");
    if (kind === "cursor") { mkdirSync(join(w.home, ".cursor")); writeFileSync(join(w.home, ".cursor", "cli-config.json"), "{}"); }
    w.env.FAKE_ENV = log; w.env.FAKE_TRACE_RPC = "1";
    try {
      // HOLD: a message sent mid-turn goes to the running harness (or, for a harness that queues, its next turn in the
      // same process; Cursor's a new process of its own).
      const l = w.launch("tc", w.task(`${BRIEF} HOLD`), [], undefined, kind);
      expect([kind, l.state, l.error]).toEqual([kind, "prompted", undefined]);
      expect([kind, l.start.env]).toEqual([kind, { TRACEPARENT: "<forwarded>", TRACESTATE: "<forwarded>", BAGGAGE: "<forwarded>" }]);
      expect(JSON.parse(readFileSync(join(w.runDir("tc"), "worker.json"), "utf8")).carriers).toEqual(LAUNCHED);
      expect(w.run(["send", "--name", "tc", "--task", SENT], { BAGGAGE: "sender=mid-turn" }).ok).toBe(true);
      w.release();
      expect(w.run(["wait", "--name", "tc", "--timeout", "20000"]).state).toBe("finished");
      expect(await w.settled("tc")).toBe(true);
      // Idle: the sender's own carriers differ, and the holder it starts resumes with the launch's.
      const resumed = w.run(["send", "--name", "tc", "--task-file", w.task(SENT, "more.md")], { TRACEPARENT: "00-sender-01", BAGGAGE: "sender=resume" });
      expect([kind, resumed.state, resumed.error]).toEqual([kind, "resumed", undefined]);
      expect(w.run(["wait", "--name", "tc", "--timeout", "20000"]).state).toBe("finished");
      expect(await w.settled("tc")).toBe(true);
      const rows = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)), turns = turnsOf(kind, rows);
      expect([kind, turns.length >= 2]).toEqual([kind, true]);
      for (const t of turns) expect([kind, carriersIn(t.env)]).toEqual([kind, LAUNCHED]);
      if (["codex", "kiro"].includes(kind)) for (const r of rpcs(w)) { expect(r).not.toHaveProperty("trace"); expect(r).not.toHaveProperty("_meta"); }
      // A harness read (its sign-in status, a model list) is not a worker: none.
      for (const r of rows.filter((x) => !turns.includes(x))) expect([kind, carriersIn(r.env)]).toEqual([kind, {}]);
      expect(w.state("tc").carriers_withheld).toBeUndefined();
      // No value in any file routr wrote in the run folder but worker.json, which keeps them.
      for (const f of filesUnder(w.runDir("tc")).filter((f) => f !== "worker.json" && !f.split(/[\\/]/).includes("reports"))) {
        expect([kind, f, readFileSync(join(w.runDir("tc"), f), "utf8").includes("CARRIER_HL")]).toEqual([kind, f, false]);
      }
      // A worker stopped while it runs, then cleaned up: those outputs are checked below with the rest.
      rmSync(w.gate, { force: true });
      expect([kind, w.launch("tr", w.task(`${BRIEF} HOLD`, "running.md"), [], undefined, kind).state]).toEqual([kind, "prompted"]);
      expect([kind, w.run(["workers", "--name", "tr"]).workers[0].state]).toEqual([kind, "working"]);
      expect([kind, w.run(["stop", "--name", "tr"]).state]).toEqual([kind, "stopped"]);
    } finally { for (const n of ["tc", "tr"]) { w.run(["stop", "--name", n]); w.run(["cleanup", "--worker", n]); } }
    // Every command's whole output, teardown included: no value.
    expect(w.outputs.length).toBeGreaterThan(20);
    for (const o of w.outputs) expect([kind, /CARRIER_HL|sender=/.test(o)]).toEqual([kind, false]);
  }
}, 180000);

test("a headless worker's saved carriers are checked on every load: a bad one is withheld and said, an older worker gets none", async () => {
  const w = world({ TRACEPARENT: LAUNCHED.TRACEPARENT, BAGGAGE: "a=\x1b[2J" }), log = join(w.home, "env.jsonl");
  w.env.FAKE_ENV = log;
  try {
    const l = w.launch("tb", w.task(BRIEF));
    // Launch withholds the one outside routr's limits, says so by name, and lists only the one it passes.
    expect([l.state, l.start.env]).toEqual(["prompted", { TRACEPARENT: "<forwarded>" }]);
    expect(l.warnings).toContain("BAGGAGE was not passed to the worker: routr passes it only when it is at most 8192 bytes of printable ASCII or tabs");
    expect(JSON.parse(readFileSync(join(w.runDir("tb"), "worker.json"), "utf8")).carriers).toEqual({ TRACEPARENT: LAUNCHED.TRACEPARENT });
    w.run(["wait", "--name", "tb", "--timeout", "20000"]); expect(await w.settled("tb")).toBe(true);
    // worker.json changed since: unknown keys ignored, a non-string and a control character withheld, the rest used.
    const file = join(w.runDir("tb"), "worker.json"), saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, carriers: { TRACEPARENT: 7, TRACESTATE: "a\x1bb", BAGGAGE: "k=v", NODE_OPTIONS: "--require /x.js" } }));
    const s = w.run(["send", "--name", "tb", "--task", SENT]);
    expect(s.state).toBe("resumed");
    expect(s.warnings.filter((x) => /TRACE|BAGGAGE/.test(x))).toEqual(["TRACEPARENT", "TRACESTATE"].map((n) => expect.stringContaining(`${n} was not passed to the worker`)));
    w.run(["wait", "--name", "tb", "--timeout", "20000"]); expect(await w.settled("tb")).toBe(true);
    // The detached holder has no output: it records the names, and workers and wait show them.
    expect(w.state("tb").carriers_withheld).toEqual(["TRACEPARENT", "TRACESTATE"]);
    expect(w.run(["workers", "--name", "tb"]).workers[0].carriers_withheld).toEqual(["TRACEPARENT", "TRACESTATE"]);
    let turns = turnsOf("claude", readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)));
    expect(turns.map((t) => carriersIn(t.env))).toEqual([{ TRACEPARENT: LAUNCHED.TRACEPARENT }, { BAGGAGE: "k=v" }]);
    expect(turns.at(-1).env).not.toHaveProperty("NODE_OPTIONS");
    // A worker launched before carriers were saved has none, whatever the sender's environment holds.
    delete saved.carriers; writeFileSync(file, JSON.stringify(saved));
    expect(w.run(["send", "--name", "tb", "--task", SENT], { ...LAUNCHED }).state).toBe("resumed");
    w.run(["wait", "--name", "tb", "--timeout", "20000"]); expect(await w.settled("tb")).toBe(true);
    turns = turnsOf("claude", readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)));
    expect(carriersIn(turns.at(-1).env)).toEqual({});
    expect(w.state("tb").carriers_withheld).toBeUndefined();
    expect(w.run(["workers", "--name", "tb"]).workers[0]).not.toHaveProperty("carriers_withheld");
    // Only an absent key is absent: one saved as null (or empty) is withheld and named, not skipped without a word.
    writeFileSync(file, JSON.stringify({ ...saved, carriers: { TRACEPARENT: LAUNCHED.TRACEPARENT, BAGGAGE: null, TRACESTATE: "" } }));
    const n = w.run(["send", "--name", "tb", "--task", SENT]);
    expect(n.state).toBe("resumed");
    expect(n.warnings.filter((x) => /TRACE|BAGGAGE/.test(x))).toEqual(["TRACESTATE", "BAGGAGE"].map((c) => expect.stringContaining(`${c} was not passed to the worker`)));
    w.run(["wait", "--name", "tb", "--timeout", "20000"]); expect(await w.settled("tb")).toBe(true);
    expect(w.run(["workers", "--name", "tb"]).workers[0].carriers_withheld).toEqual(["TRACESTATE", "BAGGAGE"]);
    turns = turnsOf("claude", readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)));
    expect(carriersIn(turns.at(-1).env)).toEqual({ TRACEPARENT: LAUNCHED.TRACEPARENT });
  } finally { w.run(["stop", "--name", "tb"]); w.run(["cleanup", "--worker", "tb"]); }
}, 60000);

// Hold the sender lock ourselves: queue assertions never start a sender or contact an endpoint.
const wireAttrs = (s) => Object.fromEntries(s.attributes.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? (value.intValue == null ? value.doubleValue : Number(value.intValue))]));
function traceWorld(over = {}) {
  const w = world({ ROUTR_OTEL: "1", OTEL_SDK_DISABLED: "false", FAKE_TRACE_RPC: "1", ...over });
  const configPath = join(w.home, ".config/routr/config.json"), config = cfg({ auto_update: false, subscriptions: {}, otel: { endpoint: "http://127.0.0.1:4318", consent: "1234567890abcdef1234567890abcdef" } });
  mkdirSync(dirname(configPath), { recursive: true }); writeFileSync(configPath, JSON.stringify(config));
  prepareOtel({ home: w.home });
  const dir = join(w.home, ".cache/routr/otel/traces");
  writeFileSync(join(w.home, ".cache/routr/otel/sender.lock"), JSON.stringify({ pid: process.pid, token: "fixture" }));
  const batches = () => readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
  const logs = () => readdirSync(join(w.home, ".cache/routr/otel/logs")).filter((n) => n.endsWith(".json")).flatMap((n) => JSON.parse(readFileSync(join(w.home, ".cache/routr/otel/logs", n))).resourceLogs[0].scopeLogs[0].logRecords);
  return { ...w, config, configPath, batches, logs, spans: () => batches().flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans) };
}

test("the holder queues one safe invoke_agent span when a turn ends, before its process exits", async () => {
  const w = traceWorld({ TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", BAGGAGE: "BAGGAGE_PRIVATE_MARKER", FAKE_HOLD_EXIT: "1" });
  w.env.FAKE_EXIT_GATE = join(w.home, "exit-gate");
  try {
    expect(w.launch("traced", w.task(`${BRIEF} HOLD`)).state).toBe("prompted");
    expect(w.run(["send", "--name", "traced", "--task", SENT]).ok).toBe(true);
    w.release();
    expect(await until(() => w.spans().some((s) => s.name === "invoke_agent traced"))).toBe(true);
    expect(w.state("traced").harness_pid).toBeGreaterThan(0);
    const spans = w.spans(), launch = spans.find((s) => s.name === "routr launch"), turn = spans.find((s) => s.name === "invoke_agent traced");
    expect(turn).toMatchObject({ kind: 3, traceId: launch.traceId, parentSpanId: launch.spanId });
    expect(wireAttrs(turn)).toMatchObject({ "gen_ai.operation.name": "invoke_agent", "gen_ai.provider.name": "anthropic", "gen_ai.agent.name": "traced", "gen_ai.conversation.id": "11111111-2222-3333-4444-555555555555", "routr.model": "haiku", "routr.turn": 1, "routr.turn.outcome": "finished", "routr.turn.messages": 2 });
    expect(turn.status).toBeUndefined();
    expect(wireAttrs(turn)).not.toHaveProperty("gen_ai.request.model");
    for (const a of turn.attributes) expect(TRACE_ATTRIBUTES[a.key]).toBeDefined();
    expect(JSON.stringify(w.batches())).not.toMatch(/PRIVATE-BRIEF|PRIVATE-SEND|BAGGAGE_PRIVATE_MARKER/);
    expect(w.spans().filter((s) => s.name === "invoke_agent traced")).toHaveLength(1);
    const logs = w.logs().filter((l) => l.eventName === "routr.worker.state");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => wireAttrs(l)["routr.worker.state.from"] === "working" && wireAttrs(l)["routr.worker.state.to"] === "waiting")).toBe(true);
    for (const l of logs) {
      expect(l).toMatchObject({ severityNumber: 9, severityText: "INFO", traceId: turn.traceId, spanId: turn.spanId });
      expect(l.body).toBeUndefined(); expect(wireAttrs(l)["routr.turn"]).toBe(1);
    }
    expect(JSON.stringify(w.logs())).not.toMatch(/PRIVATE-BRIEF|PRIVATE-SEND|BAGGAGE_PRIVATE_MARKER/);

  } finally { w.release(); writeFileSync(w.env.FAKE_EXIT_GATE, ""); w.run(["stop", "--name", "traced"]); await w.settled("traced"); w.run(["cleanup", "--worker", "traced"]); }
}, 30000);

const spanCarrier = (s) => `00-${s.traceId}-${s.spanId}-01`;
test("every adapter gets the causing process span and the current turn through its protocol channel", async () => {
  for (const kind of Object.keys(ADAPTERS)) {
    const inherited = { TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", TRACESTATE: "vendor=STATE_PRIVATE", BAGGAGE: "k=BAGGAGE_PRIVATE" };
    const w = traceWorld(inherited); w.env.FAKE_ENV = join(w.home, "env.jsonl");
    if (kind === "cursor") { mkdirSync(join(w.home, ".cursor")); writeFileSync(join(w.home, ".cursor/cli-config.json"), "{}"); }
    try {
      const l = w.launch("channels", w.task(`${BRIEF} HOLD`), [], undefined, kind);
      expect([kind, l.state, l.error]).toEqual([kind, "prompted", undefined]);
      expect(w.run(["send", "--name", "channels", "--task", SENT]).ok).toBe(true);
      w.release(); expect(await w.settled("channels")).toBe(true);
      const beforeResume = ["agy", "kiro", "cursor"].includes(kind) ? 2 : 1;
      expect(w.spans().filter((s) => s.name === "invoke_agent channels")).toHaveLength(beforeResume);
      expect(w.run(["send", "--name", "channels", "--task", SENT], { TRACEPARENT: "bad-sender", BAGGAGE: "sender=PRIVATE" }).ok).toBe(true);
      expect(await w.settled("channels")).toBe(true);
      const spans = w.spans(), launched = spans.find((s) => s.name === "routr launch"), turns = spans.filter((s) => s.name === "invoke_agent channels").sort((a, b) => wireAttrs(a)["routr.turn"] - wireAttrs(b)["routr.turn"]);
      expect(turns).toHaveLength(beforeResume + 1);
      for (const [i, t] of turns.entries()) {
        expect(t).toMatchObject({ traceId: launched.traceId, parentSpanId: launched.spanId, kind: 3 });
        expect(wireAttrs(t)).toMatchObject({ "routr.turn": i + 1, "routr.turn.outcome": "finished", "routr.turn.messages": i === 0 && beforeResume === 1 ? 2 : 1, "gen_ai.provider.name": { claude: "anthropic", codex: "openai", cursor: "cursor", agy: "gcp.gen_ai", kiro: "kiro" }[kind] });
        expect(t.status).toBeUndefined(); expect(wireAttrs(t)).not.toHaveProperty("gen_ai.request.model");
      }
      const processes = turnsOf(kind, readFileSync(w.env.FAKE_ENV, "utf8").trim().split("\n").map(JSON.parse));
      expect([kind, processes.map((p) => p.argv)]).toEqual([kind, Array.from({ length: kind === "cursor" ? 3 : 2 }, () => expect.any(Array))]);
      expect(carriersIn(processes[0].env)).toEqual({ ...inherited, TRACEPARENT: spanCarrier(kind === "cursor" ? turns[0] : launched) });
      expect(carriersIn(processes.at(-1).env)).toEqual({ ...inherited, TRACEPARENT: spanCarrier(turns.at(-1)) });
      if (kind === "cursor") expect(processes.map((p) => p.env.TRACEPARENT)).toEqual(turns.map(spanCarrier));
      const rpc = existsSync(join(w.home, "rpc.jsonl")) ? readFileSync(join(w.home, "rpc.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
      if (kind === "codex") {
        const starts = rpc.filter((r) => r.method === "turn/start");
        expect(starts.map((r) => r.trace)).toEqual(turns.map((t) => ({ traceparent: spanCarrier(t), tracestate: inherited.TRACESTATE })));
        expect(rpc.find((r) => r.method === "turn/steer").trace).toEqual(starts[0].trace);
        let process = -1;
        for (const r of rpc.filter((r) => r.worker && r.request)) {
          if (r.method === "initialize") process++;
          const turn = process === 0 ? turns[0] : turns.at(-1);
          expect([r.method, r.trace]).toEqual([r.method, { traceparent: spanCarrier(turn), tracestate: inherited.TRACESTATE }]);
        }
        expect(process).toBe(1);
        for (const r of rpc) if (!r.worker) expect(r.trace).toBeUndefined();
      }
      if (kind === "kiro") {
        expect(rpc.filter((r) => r.method === "session/prompt").map((r) => r._meta)).toEqual(turns.map((t) => ({ traceparent: spanCarrier(t), tracestate: inherited.TRACESTATE, baggage: inherited.BAGGAGE })));
        expect(rpc.find((r) => r.method === "session/new")._meta.traceparent).toBe(spanCarrier(launched));
        expect(rpc.find((r) => r.method === "session/load")._meta.traceparent).toBe(spanCarrier(turns.at(-1)));
      }
      const resources = w.batches().filter((b) => b.resourceSpans[0].scopeSpans[0].spans[0].name === "invoke_agent channels").map((b) => wireAttrs({ attributes: b.resourceSpans[0].resource.attributes })["service.instance.id"]);
      expect(new Set(resources).size).toBe(2); // first holder's turns share an id; a resumed holder is a different process
      const launchResource = w.batches().find((b) => b.resourceSpans[0].scopeSpans[0].spans[0].name === "routr launch");
      expect(resources).not.toContain(wireAttrs({ attributes: launchResource.resourceSpans[0].resource.attributes })["service.instance.id"]);
      expect(JSON.stringify(w.batches())).not.toMatch(/PRIVATE-BRIEF|PRIVATE-SEND|STATE_PRIVATE|BAGGAGE_PRIVATE|sender=PRIVATE/);
      expect(JSON.stringify(w.batches())).not.toContain(w.home);
      expect(JSON.stringify(w.batches())).not.toContain(JSON.stringify(w.home).slice(1, -1));
    } finally { w.release(); w.run(["stop", "--name", "channels"]); await w.settled("channels"); w.run(["cleanup", "--worker", "channels"]); }
  }
}, 120000);

test("failed adapter turns have a fixed error code, with no report or reply text in holder batches", async () => {
  for (const kind of Object.keys(ADAPTERS)) {
    const w = traceWorld();
    if (kind === "cursor") { mkdirSync(join(w.home, ".cursor")); writeFileSync(join(w.home, ".cursor/cli-config.json"), "{}"); }
    try {
      expect(w.launch("failure", w.task(`${BRIEF} FAIL`), [], undefined, kind).ok).toBe(true);
      expect(await w.settled("failure")).toBe(true);
      const turns = w.spans().filter((s) => s.name === "invoke_agent failure");
      expect(turns).toHaveLength(1);
      expect(turns[0].status).toEqual({ code: 2 });
      expect(wireAttrs(turns[0])).toMatchObject({ "routr.turn.outcome": "failed", "error.type": "failed", "routr.turn.messages": 1 });
      expect(turns[0].events).toBeUndefined();
      expect(Object.keys(wireAttrs(turns[0])).filter((k) => k.startsWith("gen_ai.usage."))).toEqual([]);
      for (const t of w.state("failure").turns) if (t.report) expect(JSON.stringify(w.batches())).not.toContain(readFileSync(t.report, "utf8"));
    } finally { w.run(["stop", "--name", "failure"]); await w.settled("failure"); w.run(["cleanup", "--worker", "failure"]); }
  }
}, 120000);

test("Codex starting a fast next turn in the same process uses its own request context and counts the taken message", async () => {
  const w = traceWorld({ FAKE_STEER_NEXT: "1" }); w.env.FAKE_ENV = join(w.home, "env.jsonl");
  try {
    expect(w.launch("fast", w.task(`${BRIEF} HOLD`), [], undefined, "codex").ok).toBe(true);
    expect(w.run(["send", "--name", "fast", "--task", SENT]).ok).toBe(true);
    expect(await w.settled("fast")).toBe(true);
    const turns = w.spans().filter((s) => s.name === "invoke_agent fast").sort((a, b) => wireAttrs(a)["routr.turn"] - wireAttrs(b)["routr.turn"]);
    expect(turns.map((t) => wireAttrs(t)["routr.turn.messages"])).toEqual([1, 1]);
    const rpc = readFileSync(join(w.home, "rpc.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.worker && r.request);
    expect(rpc.map((r) => [r.method, r.trace])).toEqual([
      ["initialize", { traceparent: spanCarrier(turns[0]) }], ["thread/start", { traceparent: spanCarrier(turns[0]) }],
      ["turn/start", { traceparent: spanCarrier(turns[0]) }], ["turn/steer", { traceparent: spanCarrier(turns[0]) }],
      ["turn/start", { traceparent: spanCarrier(turns[1]) }],
    ]);
    expect(turnsOf("codex", readFileSync(w.env.FAKE_ENV, "utf8").trim().split("\n").map(JSON.parse))).toHaveLength(1);
  } finally { w.release(); w.run(["stop", "--name", "fast"]); await w.settled("fast"); w.run(["cleanup", "--worker", "fast"]); }
}, 30000);

test("a holder started with export off reads fresh consent for its later automatic turn", async () => {
  const w = traceWorld(); w.env.FAKE_ENV = join(w.home, "env.jsonl");
  try {
    expect(w.launch("toggle", w.task(BRIEF)).ok).toBe(true); expect(await w.settled("toggle")).toBe(true);
    writeFileSync(w.configPath, JSON.stringify({ ...w.config, otel: undefined }));
    expect(w.run(["send", "--name", "toggle", "--task", `${SENT} HOLD BACKGROUND`]).ok).toBe(true);
    writeFileSync(w.configPath, JSON.stringify(w.config)); w.release();
    expect(await w.settled("toggle")).toBe(true);
    const turns = w.spans().filter((s) => s.name === "invoke_agent toggle").sort((a, b) => wireAttrs(a)["routr.turn"] - wireAttrs(b)["routr.turn"]);
    expect(turns.map((s) => wireAttrs(s)["routr.turn"])).toEqual([1, 3]);
    expect(wireAttrs(turns[1])["routr.turn.messages"]).toBe(0);
    const launched = w.spans().find((s) => s.name === "routr launch");
    for (const t of turns) expect(t).toMatchObject({ traceId: launched.traceId, parentSpanId: launched.spanId });
    const processes = turnsOf("claude", readFileSync(w.env.FAKE_ENV, "utf8").trim().split("\n").map(JSON.parse));
    // The process started with export off keeps the saved launch context, even when a later turn is recorded.
    expect(processes.map((p) => p.env.TRACEPARENT)).toEqual([spanCarrier(launched), spanCarrier(launched)]);
  } finally { w.release(); w.run(["stop", "--name", "toggle"]); await w.settled("toggle"); w.run(["cleanup", "--worker", "toggle"]); }
}, 30000);

test("revoked consent or a failed holder queue write cannot change a completed turn", async () => {
  for (const mode of ["consent", "off", "write"]) {
    const w = traceWorld();
    try {
      expect(w.launch("silent", w.task(`${BRIEF} HOLD`)).ok).toBe(true);
      if (mode === "consent") writeFileSync(w.configPath, JSON.stringify({ ...w.config, otel: { ...w.config.otel, consent: "a".repeat(32) } }));
      if (mode === "off") writeFileSync(w.configPath, JSON.stringify({ ...w.config, otel: undefined }));
      if (mode === "write") rmSync(join(w.home, ".cache/routr/otel/traces"), { recursive: true });
      w.release(); expect(await w.settled("silent")).toBe(true);
      expect(w.state("silent")).toMatchObject({ state: "idle", turns: [expect.objectContaining({ outcome: "finished" })] });
      expect(readFileSync(w.state("silent").turns[0].report, "utf8")).toContain("VERDICT: done");
      if (mode !== "write") expect(w.spans().filter((s) => s.name === "invoke_agent silent")).toEqual([]);
    } finally { w.release(); w.run(["stop", "--name", "silent"]); await w.settled("silent"); w.run(["cleanup", "--worker", "silent"]); }
  }
}, 90000);

test("workers launched with export off record independent root turns after opt-in and give resumed processes their turn context", async () => {
  for (const kind of Object.keys(ADAPTERS)) {
    const saved = { TRACEPARENT: "invalid-off-parent", TRACESTATE: "vendor=PRIVATE_STATE", BAGGAGE: "a=PRIVATE_BAGGAGE" };
    const w = traceWorld(saved); w.env.FAKE_ENV = join(w.home, "env.jsonl");
    if (kind === "cursor") { mkdirSync(join(w.home, ".cursor")); writeFileSync(join(w.home, ".cursor/cli-config.json"), "{}"); }
    writeFileSync(w.configPath, JSON.stringify({ ...w.config, otel: undefined }));
    try {
      expect([kind, w.launch("roots", w.task(BRIEF), [], undefined, kind).ok]).toEqual([kind, true]);
      expect(await w.settled("roots")).toBe(true);
      expect(JSON.parse(readFileSync(join(w.runDir("roots"), "worker.json"), "utf8"))).not.toHaveProperty("launch");
      expect(w.spans()).toEqual([]);
      writeFileSync(w.configPath, JSON.stringify(w.config));
      for (const text of [`${SENT} HOLD`, SENT]) {
        expect(w.run(["send", "--name", "roots", "--task", text], { TRACEPARENT: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01" }).ok).toBe(true);
        w.release(); expect(await w.settled("roots")).toBe(true);
      }
      const turns = w.spans().filter((s) => s.name === "invoke_agent roots").sort((a, b) => wireAttrs(a)["routr.turn"] - wireAttrs(b)["routr.turn"]);
      expect([kind, turns.length]).toEqual([kind, 2]);
      expect(turns.map((s) => wireAttrs(s)["routr.turn"])).toEqual([2, 3]);
      expect(new Set(turns.map((s) => s.traceId)).size).toBe(2);
      for (const t of turns) {
        expect(t.parentSpanId).toBeUndefined(); expect(t.flags).toBe(1);
        expect(t.traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736"); expect(t.traceId).not.toBe("a".repeat(32));
        expect(wireAttrs(t)).not.toHaveProperty("routr.launch.id");
        expect(wireAttrs(t)).toMatchObject({ "routr.turn.outcome": "finished", "routr.turn.messages": 1 });
      }
      const processes = turnsOf(kind, readFileSync(w.env.FAKE_ENV, "utf8").trim().split("\n").map(JSON.parse));
      expect(processes).toHaveLength(3); expect(carriersIn(processes[0].env)).toEqual(saved);
      expect(processes.slice(1).map((p) => carriersIn(p.env))).toEqual(turns.map((s) => ({ TRACEPARENT: spanCarrier(s), BAGGAGE: saved.BAGGAGE })));
      expect(JSON.stringify(w.batches())).not.toMatch(/PRIVATE-BRIEF|PRIVATE-SEND|PRIVATE_STATE|PRIVATE_BAGGAGE/);
    } finally { w.release(); w.run(["stop", "--name", "roots"]); await w.settled("roots"); w.run(["cleanup", "--worker", "roots"]); }
  }
}, 60000);

test("an unsampled launch saves its sampling decision and every adapter keeps it through export off and on", async () => {
  for (const kind of Object.keys(ADAPTERS)) {
    const saved = { TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00", TRACESTATE: "vendor=PRIVATE_STATE", BAGGAGE: "a=PRIVATE_BAGGAGE" };
    const w = traceWorld(saved); w.env.FAKE_ENV = join(w.home, "env.jsonl");
    if (kind === "cursor") { mkdirSync(join(w.home, ".cursor")); writeFileSync(join(w.home, ".cursor/cli-config.json"), "{}"); }
    try {
      expect(w.launch("unsampled", w.task(BRIEF), [], undefined, kind).ok).toBe(true); expect(await w.settled("unsampled")).toBe(true);
      const worker = JSON.parse(readFileSync(join(w.runDir("unsampled"), "worker.json"), "utf8"));
      expect(worker.launch).toEqual({ sampled: false }); expect(w.spans()).toEqual([]);
      for (const on of [false, true]) {
        writeFileSync(w.configPath, JSON.stringify({ ...w.config, otel: on ? w.config.otel : undefined }));
        expect(w.run(["send", "--name", "unsampled", "--task", SENT], { TRACEPARENT: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01" }).ok).toBe(true);
        expect(await w.settled("unsampled")).toBe(true);
      }
      expect(w.spans().filter((s) => s.name.startsWith("invoke_agent "))).toEqual([]);
      if (["codex", "kiro"].includes(kind)) for (const r of rpcs(w)) { expect(r).not.toHaveProperty("trace"); expect(r).not.toHaveProperty("_meta"); }
      const processes = turnsOf(kind, readFileSync(w.env.FAKE_ENV, "utf8").trim().split("\n").map(JSON.parse));
      expect(processes).toHaveLength(3);
      for (const p of processes) expect(carriersIn(p.env)).toEqual(saved);
    } finally { w.run(["stop", "--name", "unsampled"]); await w.settled("unsampled"); w.run(["cleanup", "--worker", "unsampled"]); }
  }
}, 60000);

test("an initially off holder preserves an unsampled saved parent for its later automatic turn", async () => {
  const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00", w = traceWorld({ TRACEPARENT: parent });
  w.env.FAKE_ENV = join(w.home, "env.jsonl");
  writeFileSync(w.configPath, JSON.stringify({ ...w.config, otel: undefined }));
  try {
    expect(w.launch("later-root", w.task(`${BRIEF} HOLD BACKGROUND`)).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(w.runDir("later-root"), "worker.json"), "utf8"))).not.toHaveProperty("launch");
    writeFileSync(w.configPath, JSON.stringify(w.config)); w.release(); expect(await w.settled("later-root")).toBe(true);
    const turns = w.spans().filter((s) => s.name === "invoke_agent later-root");
    expect(turns).toHaveLength(0);
    const processes = turnsOf("claude", readFileSync(w.env.FAKE_ENV, "utf8").trim().split("\n").map(JSON.parse));
    expect(processes).toHaveLength(1); expect(processes[0].env.TRACEPARENT).toBe(parent);
  } finally { w.release(); w.run(["stop", "--name", "later-root"]); await w.settled("later-root"); w.run(["cleanup", "--worker", "later-root"]); }
}, 30000);

function observedTraceWorld(over = {}) {
  const w = traceWorld({ FAKE_TRACE_WRITES: "1", ...over }), git = Bun.which("git");
  fakeExecutable(join(w.home, "bin"), "git", `
    const fs = require("node:fs"), cp = require("node:child_process"), a = process.argv.slice(2);
    if (process.env.FAKE_HOLDER_TRACE) {
      fs.appendFileSync(${JSON.stringify(join(w.home, "git-reads.jsonl"))}, JSON.stringify(a) + "\\n");
      if (a.includes("--show-toplevel")) console.log(${JSON.stringify(realpathSync.native(w.work) + "\n" + join(realpathSync.native(w.work), ".git"))});
      else if (a.includes("remote.origin.url")) console.log("https://example.test/owner/repo.git");
      else if (a.includes("symbolic-ref")) console.log("fixture");
      else process.exit(1);
    } else { const r = cp.spawnSync(${JSON.stringify(git)}, a, { stdio: "inherit" }); process.exit(r.status ?? 1); }
  `);
  return w;
}

test("the holder saves the report and outcome before it queues each finished turn", async () => {
  const w = observedTraceWorld();
  try {
    expect(w.launch("ordered", w.task(`${BRIEF} BACKGROUND`)).ok).toBe(true); expect(await w.settled("ordered")).toBe(true);
    const emitted = readFileSync(join(w.home, "emissions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(emitted).toEqual([{ outcome: "finished", report: true }, { outcome: "finished", report: true }]);
  } finally { w.run(["stop", "--name", "ordered"]); await w.settled("ordered"); w.run(["cleanup", "--worker", "ordered"]); }
}, 30000);

test("a holder computes git identity once for multiple turns in its process", async () => {
  const w = observedTraceWorld();
  try {
    expect(w.launch("identity", w.task(`${BRIEF} BACKGROUND`)).ok).toBe(true); expect(await w.settled("identity")).toBe(true);
    const reads = readFileSync(join(w.home, "git-reads.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(reads).toHaveLength(3);
    const turns = w.spans().filter((s) => s.name === "invoke_agent identity");
    expect(turns).toHaveLength(2);
    for (const t of turns) expect(wireAttrs(t)).toMatchObject({ "vcs.repository.url.full": "https://example.test/owner/repo", "vcs.ref.head.name": "fixture", "routr.cwd": "." });
  } finally { w.run(["stop", "--name", "identity"]); await w.settled("identity"); w.run(["cleanup", "--worker", "identity"]); }
}, 30000);

test("a failed hand-over discards its prepared span before the next turn captures fresh consent", async () => {
  const w = observedTraceWorld({ FAKE_REJECT_HANDOVER: "1" });
  try {
    expect(w.launch("retry-context", w.task(`${BRIEF} HOLD`), [], undefined, "agy").ok).toBe(true);
    for (const text of [SENT, `${SENT} TAG-next`]) expect(w.run(["send", "--name", "retry-context", "--task", text]).ok).toBe(true);
    w.release(); expect(await w.settled("retry-context")).toBe(true);
    const turns = w.spans().filter((s) => s.name === "invoke_agent retry-context");
    expect(turns.map((s) => wireAttrs(s)["routr.turn"]).sort()).toEqual([2, 3]);
    expect(wireAttrs(turns.find((s) => wireAttrs(s)["routr.turn"] === 2))["routr.turn.outcome"]).toBe("not_started");
    expect(wireAttrs(turns.find((s) => wireAttrs(s)["routr.turn"] === 3))["routr.turn.outcome"]).toBe("finished");
    const rejected = JSON.parse(readFileSync(join(w.home, "rejected-context.json"), "utf8")).TRACEPARENT;
    expect(rejected).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    expect(turns.map(spanCarrier)).not.toContain(rejected);
  } finally { w.release(); w.run(["stop", "--name", "retry-context"]); await w.settled("retry-context"); w.run(["cleanup", "--worker", "retry-context"]); }
}, 30000);

test("an export-off holder reads no git identity until its first generated turn", async () => {
  for (const enable of [false, true]) {
    const w = observedTraceWorld(), reads = () => existsSync(join(w.home, "git-reads.jsonl")) ? readFileSync(join(w.home, "git-reads.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
    writeFileSync(w.configPath, JSON.stringify({ ...w.config, otel: undefined }));
    try {
      expect(w.launch("lazy", w.task(`${BRIEF} HOLD BACKGROUND`)).ok).toBe(true);
      expect(reads()).toEqual([]);
      if (enable) writeFileSync(w.configPath, JSON.stringify(w.config));
      w.release(); expect(await w.settled("lazy")).toBe(true);
      expect(reads()).toHaveLength(enable ? 3 : 0);
      expect(w.spans().filter((s) => s.name === "invoke_agent lazy")).toHaveLength(enable ? 1 : 0);
    } finally { w.release(); w.run(["stop", "--name", "lazy"]); await w.settled("lazy"); w.run(["cleanup", "--worker", "lazy"]); }
  }
}, 30000);

test("a failed earlier Codex send keeps the prepared turn context a later pending send carries", async () => {
  const w = traceWorld({ FAKE_STEER_NEXT: "1", FAKE_START_SWAP: "1" });
  w.env.FAKE_START_GATE = join(w.home, "start-gate"); w.env.FAKE_START_PENDING = join(w.home, "start-pending");
  let peer;
  try {
    expect(w.launch("swapped", w.task(`${BRIEF} HOLD`), [], undefined, "codex").ok).toBe(true);
    const p = await probe(w.runDir("swapped")); peer = await connect(w.runDir("swapped"), p.gen, p.ready.endpoint);
    const first = peer.request("send", { text: SENT }, 10000); first.catch(() => {});
    expect(await until(() => existsSync(w.env.FAKE_START_PENDING))).toBe(true);
    const prepared = rpcs(w).filter((r) => r.worker && r.method === "turn/start").at(-1).trace;
    const second = peer.request("send", { text: `${SENT} second` }, 10000); second.catch(() => {});
    // The earlier send fails while the later one, carrying the same context, still waits for its turn.
    expect(await first).toMatchObject({ code: "refused", why: "harness_refused" });
    expect(existsSync(`${w.env.FAKE_START_PENDING}-swapped`)).toBe(true);
    expect(rpcs(w).filter((r) => r.worker && r.method === "turn/start").at(-1).trace).toEqual(prepared);
    writeFileSync(w.env.FAKE_START_GATE, "");
    expect(await second).toMatchObject({ code: "accepted" }); peer.close(); peer = null;
    expect(await w.settled("swapped")).toBe(true);
    const turns = w.spans().filter((s) => s.name === "invoke_agent swapped").sort((a, b) => wireAttrs(a)["routr.turn"] - wireAttrs(b)["routr.turn"]);
    expect(turns).toHaveLength(2);
    expect(spanCarrier(turns[1])).toBe(prepared.traceparent);
    expect(turns.map((s) => wireAttrs(s)["routr.turn.messages"])).toEqual([1, 1]);
  } finally { writeFileSync(w.env.FAKE_START_GATE, ""); w.release(); peer?.close(); w.run(["stop", "--name", "swapped"]); await w.settled("swapped"); w.run(["cleanup", "--worker", "swapped"]); }
}, 30000);

test("each fake harness that queues or prompts finishes a turn whose input ended before the turn did", async () => {
  // Input closed while the turn still runs: the harness ends the turn, then exits cleanly.
  const dir = scratch("fake-eof"), gate = join(dir, "gate");
  const cases = [["codex", FAKE_CODEX, ["app-server"], { id: 1, method: "turn/start", params: { input: [{ text: "HOLD" }] } }, "turn/completed"],
    ["agy", FAKE_AGY, ["--print=", "--input-format", "stream-json"], { event: "user", message: { content: "HOLD" } }, "\"result\""],
    ["kiro", FAKE_KIRO, ["acp"], { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "HOLD" }] } }, "stopReason"]];
  for (const [name, code, args, line, done] of cases) {
    const script = join(dir, `${name}.cjs`); writeFileSync(script, code); rmSync(gate, { force: true });
    const p = Bun.spawn([process.execPath, script, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, FAKE_GATE: gate } });
    p.stdin.write(JSON.stringify(line) + "\n"); p.stdin.end();
    await Bun.sleep(300); writeFileSync(gate, "");
    expect([name, await p.exited, await new Response(p.stderr).text()]).toEqual([name, 0, ""]);
    expect([name, (await new Response(p.stdout).text()).includes(done)]).toEqual([name, true]);
  }
}, 30000);

test("an earlier request's late success keeps only the context it carried, not the next turn's", async () => {
  // The first send starts turn 2 and its reply comes only after turn 2 has ended and a second send, carrying turn 3's
  // context, is waiting; that one fails, after the first's success or before it. The third send's turn must not get
  // the failed send's context. With nothing left to run, the holder closes Codex's input once both have answered; Codex
  // is held there until the third send is queued for the next process (once it has exited, the holder has ended and
  // refuses, and routr send starts the next generation: seen on CI 2026-10-26 as a flaky "refused").
  for (const refuseFirst of [false, true]) {
  const w = traceWorld({ FAKE_STEER_NEXT: "1", FAKE_HOLD_EXIT: "1", ...(refuseFirst ? { FAKE_REPLY_REFUSE_FIRST: "1" } : {}) }); w.env.FAKE_REPLY_GATE = join(w.home, "reply-gate");
  w.env.FAKE_EXIT_GATE = join(w.home, "exit-gate");
  const starts = () => rpcs(w).filter((r) => r.worker && r.method === "turn/start");
  let peer;
  try {
    expect(w.launch("late", w.task(`${BRIEF} HOLD`), [], undefined, "codex").ok).toBe(true);
    const p = await probe(w.runDir("late")); peer = await connect(w.runDir("late"), p.gen, p.ready.endpoint);
    const first = peer.request("send", { text: SENT }, 20000); first.catch(() => {});
    expect(await until(() => existsSync(`${w.env.FAKE_REPLY_GATE}-pending`))).toBe(true);
    const state = () => { try { return JSON.parse(readFileSync(join(w.runDir("late"), "state.json"), "utf8")); } catch { return {}; } };
    expect(await until(() => state().turns?.[1]?.outcome)).toBeTruthy();
    const second = peer.request("send", { text: `${SENT} second` }, 20000); second.catch(() => {});
    expect(await until(() => starts().length === 3)).toBe(true);
    const failed = starts().at(-1).trace;
    if (refuseFirst) expect(await second).toMatchObject({ code: "refused" });
    writeFileSync(w.env.FAKE_REPLY_GATE, "");
    expect(await first).toMatchObject({ code: "accepted" });
    if (!refuseFirst) expect(await second).toMatchObject({ code: "refused" });
    expect((await peer.request("send", { text: `${SENT} third` }, 20000)).code).toBe("queued"); peer.close(); peer = null;
    writeFileSync(w.env.FAKE_EXIT_GATE, "");
    expect(await w.settled("late")).toBe(true);
    const turns = w.spans().filter((s) => s.name === "invoke_agent late").sort((a, b) => wireAttrs(a)["routr.turn"] - wireAttrs(b)["routr.turn"]);
    expect(turns).toHaveLength(3);
    expect([refuseFirst, spanCarrier(turns[2])]).not.toEqual([refuseFirst, failed.traceparent]);
    expect(spanCarrier(turns[2])).toBe(starts().at(-1).trace.traceparent);
  } finally { writeFileSync(w.env.FAKE_REPLY_GATE, ""); writeFileSync(w.env.FAKE_EXIT_GATE, ""); w.release(); peer?.close(); w.run(["stop", "--name", "late"]); await w.settled("late"); w.run(["cleanup", "--worker", "late"]); }
  }
}, 80000);

test("a refused concurrent Codex send preserves the first send's prepared turn context", async () => {
  const w = traceWorld({ FAKE_STEER_NEXT: "1" });
  w.env.FAKE_START_GATE = join(w.home, "start-gate"); w.env.FAKE_START_PENDING = join(w.home, "start-pending");
  let peer;
  try {
    expect(w.launch("pending", w.task(`${BRIEF} HOLD`), [], undefined, "codex").ok).toBe(true);
    const p = await probe(w.runDir("pending")); peer = await connect(w.runDir("pending"), p.gen, p.ready.endpoint);
    const first = peer.request("send", { text: SENT }, 10000); first.catch(() => {});
    expect(await until(() => existsSync(w.env.FAKE_START_PENDING))).toBe(true);
    const prepared = rpcs(w).filter((r) => r.worker && r.method === "turn/start").at(-1).trace;
    expect(await peer.request("send", { text: `${SENT} second` }, 10000)).toMatchObject({ code: "refused", why: "harness_refused" });
    writeFileSync(w.env.FAKE_START_GATE, "");
    expect(await first).toMatchObject({ code: "accepted" }); peer.close(); peer = null;
    expect(await w.settled("pending")).toBe(true);
    const turns = w.spans().filter((s) => s.name === "invoke_agent pending").sort((a, b) => wireAttrs(a)["routr.turn"] - wireAttrs(b)["routr.turn"]);
    expect(turns).toHaveLength(2);
    expect(spanCarrier(turns[1])).toBe(prepared.traceparent);
    expect(turns.map((s) => wireAttrs(s)["routr.turn.messages"])).toEqual([1, 1]);
  } finally { writeFileSync(w.env.FAKE_START_GATE, ""); w.release(); peer?.close(); w.run(["stop", "--name", "pending"]); await w.settled("pending"); w.run(["cleanup", "--worker", "pending"]); }
}, 30000);
