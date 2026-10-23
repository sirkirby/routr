// Headless workers: a worker that runs its harness's own headless mode on the user's sign-in, outside herdr, with one
// routr process (the holder) owning it. The holder starts as a numbered generation of its worker (channel.mjs), binds
// the channel before it starts the harness and closes it only after the harness has exited, and is the only writer of
// the worker's state. It lives while a turn runs or one is waiting, and exits once the harness has. All five harnesses:
// Claude Code, Codex, Antigravity, Kiro and Cursor; each harness's part is an adapter below. Claude, measured as prototypes p34 (2026-10-21) and p36 (2026-10-22,
// Claude Code 2.1.307), routr-lab:
//   - `claude -p --input-format stream-json --output-format stream-json` takes the brief on stdin and a message the
//     lead sends mid-turn into the running turn. The brief never touches routr's disk or a process's arguments.
//   - Claude has no question box there (AskUserQuestion is absent under -p): told to ask, it asks in text and ends the
//     turn. So a headless Claude never waits for input; its report carries the question.
//   - A command it ran with run_in_background keeps it alive after `result`, even with stdin closed, and when that
//     command ends Claude starts a turn by itself (a second init and result). So stdin stays open while
//     `background_tasks_changed` lists a task, and every turn, the harness's own included, gets an outcome.
//   - Its tool commands run in process groups of their own: SIGTERM to Claude ends them, SIGKILL leaves them running.
//     The harness leads its own group, which stop signals with SIGTERM first.
//   - With its holder gone, Claude keeps working until its next write fails. That is what a dead generation may leave
//     running; the next holder refuses to resume while its group still has members.
// Codex, measured as p38 (2026-10-22, codex-cli 0.163.0): its app-server (JSON-RPC on stdio) is the documented way to
// steer a running turn. The brief goes in `turn/start`; `turn/steer` joins the running turn, and after the turn has
// ended it is refused (-32600 "no active turn to steer"), so the message starts the next turn instead; a later turn
// in the same process is another `turn/start`; closing its input ends it at once (exit 0, 16 ms); a new app-server
// resumes the thread (`thread/resume`) with its context. With approvalPolicy never it asked the client nothing.
// Antigravity, measured as p39 (2026-10-22, agy 1.4.5): `agy --print= --input-format stream-json --output-format
// stream-json` runs a turn for each `{"event":"user",...}` line on stdin; one written while a turn runs waits and runs as
// the next turn in the same process (it does not join the running one). `init` names the conversation, `step_update`
// steps name their tool, `result` holds the turn's response and status. Closing stdin ends it (exit 0, 128 ms), and
// `--conversation <id>` continues the conversation in a new process with its context.
// Kiro, measured as p40 (2026-10-22, kiro-cli 2.33.1): `kiro-cli acp` speaks the Agent Client Protocol (JSON-RPC on
// stdio): `session/new`, then `session/prompt`, answered when the turn ends (`stopReason`), its text streamed as
// `agent_message_chunk` updates. A second prompt while one runs is refused ("Prompt already in progress"), so a message
// sent mid-turn waits in the holder and goes in as the next turn, in the same process. Closing stdin ends it (exit 0,
// 154 ms); `session/load` continues the session in a new process, after replaying its history as updates.
// Cursor, measured as p41 (2026-10-22, cursor-agent 2026.10.22): `cursor-agent -p --output-format stream-json` reads
// its prompt from stdin to the end, so a turn is a process: the task is written and the input closed. Its stream is
// Claude-like (`system/init` with the session, `assistant` messages, `tool_call` started/completed, `result`), but
// `result.result` joins every assistant message of the turn, so the report is the last one. `--resume <session>`
// continues it in a new process with its context. It runs on a private copy of its config, as in a pane.
// Worker text reaches one place, the report file of each turn (owner-only, removed by cleanup); only its path leaves
// routr. Nothing else of the harness's output is kept: its stderr is not read, and a tool is shown by a fixed name.
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claim, endpointFor, markReady, markReleased, privateDir, probe, removeEndpoint, serve } from "./channel.mjs";
import { HARNESSES, plan } from "./harnesses.mjs";
import { harnessEnv, installedAt, lockIsStale, probe as collect, start, STATE_DIR, stop, UNINSTALL_LOCK, writeJsonAtomic } from "./runtime.mjs";
import { besidesHelper, groupMembers } from "./process-boundary.mjs";

export const FORMAT = 1;
export const WORKERS_DIR = () => join(STATE_DIR(), "workers");
export const runDir = (name) => join(WORKERS_DIR(), name);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
// What launch wrote: { format, id, name, kind, model, effort, cwd, created_at }. Never the brief, never the environment.
export const readWorker = (name) => { const w = readJson(join(runDir(name), "worker.json")); return w?.format === FORMAT && w.name === name ? w : null; };
// What the holder wrote last (headless.mjs is its only writer).
export const readState = (name) => readJson(join(runDir(name), "state.json"));
export const reportPath = (name, turn) => join(runDir(name), "reports", `turn-${turn}.md`);
const STREAM = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
const message = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

// Claude's tool names as it sends them; any other tool is `other`, an MCP server's is `mcp`. Never a title or argument.
const TOOLS = new Set(["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "LS", "Task", "Agent", "WebFetch", "WebSearch", "TodoWrite",
  "NotebookEdit", "NotebookRead", "ToolSearch", "Monitor", "Skill", "BashOutput", "KillShell", "ExitPlanMode"]);
const toolName = (n) => (typeof n !== "string" ? "other" : TOOLS.has(n) ? n : n.startsWith("mcp__") ? "mcp" : "other");
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPORT_MAX = 1024 * 1024; // bytes of UTF-8
// A report over REPORT_MAX is cut there, back to the start of the character the cut fell in; one under it is kept whole.
const cut = (text) => {
  const b = Buffer.from(text);
  if (b.length <= REPORT_MAX) return text;
  let end = REPORT_MAX;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--; // b[end] continues a character: start it after the cut instead
  return b.subarray(0, end).toString();
};
// One line of Claude's stream, as what routr knows how to say: the session, a turn starting, a tool, how many
// background tasks are running, a turn's end. Anything else is ignored.
export function readEvent(line) {
  let e; try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e !== "object") return null;
  if (e.type === "system" && e.subtype === "init") return { turn: true, ...(SESSION_ID.test(e.session_id) ? { session: e.session_id } : {}) };
  if (e.type === "system" && e.subtype === "background_tasks_changed") return { tasks: Array.isArray(e.tasks) ? e.tasks.length : 0 };
  if (e.type === "assistant") { const t = (e.message?.content ?? []).filter((c) => c?.type === "tool_use").at(-1); return t ? { tool: toolName(t.name) } : { activity: true }; }
  if (e.type === "result") return { result: { failed: e.is_error === true, text: typeof e.result === "string" ? cut(e.result) : null } };
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Antigravity's tool names as its `init` listed them (agy 1.4.5); its MCP tool is `mcp`, any other `other`.
const AGY_TOOLS = new Set(["ask_custom_permission", "ask_permission", "ask_question", "browser_subagent", "command_status", "define_subagent", "find_by_name",
  "generate_image", "grep_search", "invoke_subagent", "list_dir", "manage_subagents", "manage_task", "multi_replace_file_content", "notebook_edit",
  "notebook_execution", "read_url_content", "replace_file_content", "run_command", "search_web", "sed_file", "send_command_input", "view_file", "wait",
  "write_to_file"]);
// One line of Antigravity's stream: the conversation and a turn starting (init, or the first step after a turn's
// result: a message it queued), a tool, a turn's end with its response.
export function agyReader() {
  let between = true;
  return (line) => {
    let e; try { e = JSON.parse(line); } catch { return null; }
    if (!e || typeof e !== "object") return null;
    if (e.event === "init") { between = false; return { turn: true, ...(UUID.test(e.conversation_id ?? "") ? { session: e.conversation_id } : {}) }; }
    if (e.event === "step_update") {
      const s = e.step_update ?? {}, start = between; between = false;
      const tool = s.step_type === "tool" && s.state === "ACTIVE" ? (s.tool_name === "call_mcp_tool" ? "mcp" : AGY_TOOLS.has(s.tool_name) ? s.tool_name : "other") : null;
      return { ...(start ? { turn: true } : {}), ...(tool ? { tool } : { activity: true }) };
    }
    if (e.event === "result") { between = true; const r = e.result ?? {}; return { result: { failed: r.status !== "SUCCESS", text: typeof r.response === "string" ? cut(r.response) : null } }; }
    return null;
  };
}

// Kiro's tool kinds (the Agent Client Protocol's); any other is `other`.
const KIRO_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch"]);
// One line of Kiro's ACP output: a reply or a request of its own, or a session update read as what routr knows how to
// say. The turn's report is the text it wrote after its last tool call; its thoughts are not kept. Updates while a
// session loads (its history, replayed) are not this run's: `loading` says so. Kiro's own notifications are ignored.
export function kiroReader() {
  let text = "", loading = false;
  return {
    loading: (on) => { loading = on; },
    take: () => { const t = text; text = ""; return t; },
    read: (line) => {
      let e; try { e = JSON.parse(line); } catch { return null; }
      if (!e || typeof e !== "object") return null;
      const rp = rpcLine(e);
      if (rp) return rp;
      if (e.method !== "session/update" || loading) return null;
      const u = e.params?.update ?? {};
      if (u.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") { text += u.content.text; return { activity: true }; }
      if (u.sessionUpdate === "tool_call") { text = ""; return { tool: KIRO_KINDS.has(u.kind) ? u.kind : "other" }; }
      return { activity: true };
    },
  };
}

// Cursor's tools as its `tool_call` names them (`shellToolCall`; measured); its MCP tool is `mcp`, any other `other`.
const CURSOR_TOOLS = new Map([["shellToolCall", "shell"], ["mcpToolCall", "mcp"]]);
// One line of Cursor's stream: the session and a turn starting, a tool, a turn's end. The report is the turn's last
// assistant message (its `result` joins them all), else that result.
export function cursorReader() {
  let last = null;
  return (line) => {
    let e; try { e = JSON.parse(line); } catch { return null; }
    if (!e || typeof e !== "object") return null;
    if (e.type === "system" && e.subtype === "init") { last = null; return { turn: true, ...(UUID.test(e.session_id ?? "") ? { session: e.session_id } : {}) }; }
    if (e.type === "assistant") {
      const text = (e.message?.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
      if (text) last = text;
      return { activity: true };
    }
    if (e.type === "tool_call" && e.subtype === "started") { const k = Object.keys(e.tool_call ?? {}).find((x) => x.endsWith("ToolCall")); return { tool: CURSOR_TOOLS.get(k) ?? "other" }; }
    if (e.type === "result") { const text = last ?? (typeof e.result === "string" ? e.result : null); last = null; return { result: { failed: e.is_error === true, text: text ? cut(text) : null } }; }
    return null;
  };
}

// Codex's item types as it sends them; an MCP server's tool is `mcp`, anything else `other`.
const CODEX_ITEMS = new Set(["commandExecution", "fileChange", "webSearch", "imageView", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "sleep", "imageGeneration", "contextCompaction"]);
const READY_MS = 30000;
// One line of the Codex app-server's output, for one connection: a reply to one of its requests, a request of its own,
// or a notification read as what routr knows how to say. The turn's report is its final answer (agentMessage phase
// final_answer), else its last agentMessage that marks no phase (a model that marks none). Commentary and partial
// answers are never a report: a turn interrupted after them has none (from the review of a68ca2e).
export function codexReader() {
  let final = null, last = null;
  return (line) => {
    let e; try { e = JSON.parse(line); } catch { return null; }
    if (!e || typeof e !== "object") return null;
    const rp = rpcLine(e);
    if (rp) return rp;
    const p = e.params ?? {};
    if (e.method === "turn/started") { final = last = null; return { turn: true, id: typeof p.turn?.id === "string" ? p.turn.id : null }; }
    if (e.method === "item/started" && typeof p.item?.type === "string") {
      const t = p.item.type;
      if (t === "agentMessage" || t === "reasoning" || t === "userMessage") return { activity: true };
      return { tool: t === "mcpToolCall" ? "mcp" : CODEX_ITEMS.has(t) ? t : "other" };
    }
    if (e.method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string") {
      if (p.item.phase === "final_answer") final = p.item.text; else if (p.item.phase == null) last = p.item.text;
      return { activity: true };
    }
    if (e.method === "turn/completed") { const text = final ?? last; final = last = null; return { result: { failed: p.turn?.status !== "completed", text: text ? cut(text) : null }, id: typeof p.turn?.id === "string" ? p.turn.id : null }; }
    return null;
  };
}

// Write one line to a process's input: true once it has gone through, false when the input is closed or the write
// failed (the harness never got it).
const writeLine = (c, line) => new Promise((resolve) => {
  if (!c || c.stdin.destroyed || c.stdin.writableEnded) return resolve(false);
  try { c.stdin.write(line, (err) => resolve(!err)); } catch { resolve(false); }
});

// One JSON-RPC peer on a harness's stdio (Codex's app-server, Kiro's ACP): requests matched to their replies by id,
// and what is known without a reply: `not_written` (it never got it: its input had closed, or the write failed) or
// `no_reply` (handed to it, and it ended before answering: whether it acted on it is not known). A request of the
// harness's own (an approval, a question, a tool call) is answered with a JSON-RPC error, which declines it.
const rpcLine = (e) => (e.id != null && !e.method ? { reply: { id: e.id, result: e.result ?? null, error: e.error ?? null } } : e.id != null && typeof e.method === "string" ? { request: e.id } : null);
function rpcPipe(c) {
  let id = 0, closed = false;
  const waiting = new Map();
  const open = () => !closed && !c.stdin.writableEnded && !c.stdin.destroyed;
  const out = (o) => writeLine(c, JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  // `written`: told once whether the request went in.
  const rpc = (method, params, { written } = {}) => new Promise((resolve) => {
    if (!open()) { written?.(false); return resolve({ error: { code: "not_written" } }); }
    const i = ++id; waiting.set(i, resolve);
    out({ id: i, method, params }).then((ok) => { written?.(ok); if (!ok && waiting.delete(i)) resolve({ error: { code: "not_written" } }); });
  });
  c.on("close", () => { closed = true; for (const r of waiting.values()) r({ error: { code: "no_reply" } }); waiting.clear(); });
  const outcome = (r) => (r.result ? "ok" : ["not_written", "no_reply"].includes(r.error?.code) ? r.error.code : "refused");
  // A reply or a request of its own, taken here: true. Anything else is the reader's.
  const take = (ev) => {
    if (ev?.reply) { const r = waiting.get(ev.reply.id); if (r) { waiting.delete(ev.reply.id); r(ev.reply); } return true; }
    if (ev?.request != null) { out({ id: ev.request, error: { code: -32601, message: "routr does not answer this for a headless worker" } }); return true; }
    return false;
  };
  return { out, rpc, outcome, open, take };
}
const readyWithin = (ready) => Promise.race([ready, new Promise((r) => setTimeout(() => r("late"), READY_MS).unref?.())]);

// What each harness needs to run headless. `argv` starts it; `connect(c, o)` binds one process of it:
//   begin(text): the task (or a resumed session's next message) in; true once it is in, false when it never got it,
//     "refused" when the harness answered no (a model it does not have, a session it cannot resume)
//   send(text, inTurn): a message while it runs: { code, next } once it took it (next: it starts the next turn rather
//     than joining this one); { code: "refused" | "unknown", why } when it said no, or ended before saying (whether it
//     took it is then not known, so it is never sent again on its own); null when it never got it (its input closed)
//   line(l): one line of its output as an event (session, turn, tool, tasks, activity, result), or null
//   open(): whether it can take more input; done(): nothing more to say to it, so it ends
export const ADAPTERS = {
  claude: {
    argv: ({ model, effort, session }) => [...STREAM, ...plan({ kind: "claude", model, effort }).argv, ...(session ? ["--resume", session] : [])],
    connect: (c) => {
      const put = (text) => writeLine(c, message(text));
      // Claude decides whether a message joins the running turn or starts the next: the holder counts it either way.
      return { begin: put, send: async (text) => ((await put(text)) ? { code: "handed_to_harness", next: null } : null), line: readEvent,
        open: () => !c.stdin.writableEnded && !c.stdin.destroyed, done: () => c.stdin.end() };
    },
  },
  codex: {
    // Its permissions are the protocol's (approvalPolicy never, sandbox danger-full-access: what --yolo is in a pane).
    // No --dangerously-bypass-hook-trust: the app-server takes no such flag, and skips a hook the user has not trusted,
    // silently (p37 item 9). The model and effort go in the protocol too.
    argv: () => ["app-server", "-c", "check_for_update_on_startup=false"],
    connect: (c, { cwd, model, effort, session, emit }) => {
      let thread = session ?? null, turn = null, ready = null;
      const ended = new Set(), { out, rpc, outcome, open, take } = rpcPipe(c);
      const read = codexReader();
      const opts = { cwd, model, approvalPolicy: "never", sandbox: "danger-full-access" };
      // The running turn, as the app-server says it (turn/started, turn/completed) and as turn/start answered it, never
      // one it has said has ended.
      const startTurn = async (text) => {
        const r = await rpc("turn/start", { threadId: thread, input: [{ type: "text", text }], ...(effort ? { effort } : {}) });
        const k = outcome(r);
        if (k !== "ok") return k;
        if (typeof r.result.turn?.id !== "string") return "refused";
        if (!ended.has(r.result.turn.id)) turn = r.result.turn.id;
        return "ok";
      };
      const answerFor = (k) => (k === "not_written" ? null : k === "no_reply" ? { code: "unknown", why: "no_reply" } : { code: "refused", why: "harness_refused" });
      return {
        begin: (text) => (ready = (async () => {
          const go = (k) => (k === "refused" ? "refused" : false); // not written, or ended before answering: not started
          const init = await rpc("initialize", { clientInfo: { name: "routr", version: "0" } });
          if (outcome(init) !== "ok") return go(outcome(init));
          if (!(await out({ method: "initialized", params: {} }))) return false;
          const th = thread ? await rpc("thread/resume", { threadId: thread, ...opts }) : await rpc("thread/start", opts);
          if (outcome(th) !== "ok") return go(outcome(th));
          const tid = th.result.thread?.id;
          if (typeof tid !== "string" || !UUID.test(tid)) return "refused";
          thread = tid;
          const k = await startTurn(text);
          if (k !== "ok") return go(k);
          emit({ session: thread }); return true;
        })()),
        // Once the task's turn has started: into the running turn; when there is none, or Codex says the turn has just
        // ended ("no active turn"), the next turn in this process. Any other no is a refusal. The wait for that turn is
        // bounded under send's own (45 s), so a sender is never told "not known" about a message that then goes in.
        send: async (text) => {
          if ((await readyWithin(ready)) !== true) return { code: "refused", why: "not_started" };
          if (turn) {
            const r = await rpc("turn/steer", { threadId: thread, expectedTurnId: turn, input: [{ type: "text", text }] });
            const k = outcome(r);
            if (k === "ok") return { code: "accepted", next: false };
            if (k !== "refused" || !/no active turn/i.test(r.error?.message ?? "")) return answerFor(k);
          }
          const k = await startTurn(text);
          return k === "ok" ? { code: "accepted", next: true } : answerFor(k);
        },
        // Its own requests (approvals, questions, tool calls): none came with approvalPolicy never (p37, p38).
        line: (l) => {
          const ev = read(l);
          if (take(ev)) return ev.request != null ? { activity: true } : null;
          if (ev?.turn && ev.id) turn = ev.id;
          if (ev?.result) { if (ev.id) ended.add(ev.id); if (!ev.id || ev.id === turn) turn = null; }
          return ev;
        },
        open, done: () => c.stdin.end(),
      };
    },
  },
  agy: {
    // As in a pane: --dangerously-skip-permissions, --add-dir the worker's folder, the model id (its effort in it).
    // `--print=`: bare -p takes the next word as its prompt (p37).
    argv: ({ model, effort, session, cwd }) => ["--print=", "--input-format", "stream-json", "--output-format", "stream-json",
      ...plan({ kind: "agy", model, effort, cwd }).argv, ...(session ? ["--conversation", session] : [])],
    connect: (c) => {
      const put = (text) => writeLine(c, JSON.stringify({ event: "user", message: { content: text } }) + "\n");
      // A message sent while a turn runs waits in the holder for that turn to end, and runs as a turn of its own (one
      // per line, its help says, and measured: two corrections were two turns).
      return { queues: true, begin: put, send: async (text) => ((await put(text)) ? { code: "handed_to_harness", next: true } : null), line: agyReader(),
        open: () => !c.stdin.writableEnded && !c.stdin.destroyed, done: () => c.stdin.end() };
    },
  },
  kiro: {
    // As in a pane: --trust-tools=*, the model, the effort; `acp` in place of `chat`.
    argv: ({ model, effort }) => ["acp", ...plan({ kind: "kiro", model, effort }).argv.filter((a) => a !== "chat")],
    connect: (c, { cwd, session, emit }) => {
      const { rpc, outcome, open, take } = rpcPipe(c), r = kiroReader();
      let sid = session ?? null, ready = null, running = false;
      // One prompt: in once written (a turn of its own starts then), answered when that turn ends.
      const prompt = (text) => new Promise((went) => {
        running = true; r.take();
        rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] }, { written: (ok) => { if (ok) emit({ turn: true }); went(ok); } }).then((a) => {
          running = false;
          const k = outcome(a);
          // It ended mid-turn (the holder's finish says so), or never got the prompt (no turn started for it).
          if (k === "no_reply" || k === "not_written") return;
          const said = r.take();
          emit({ result: { failed: k !== "ok" || a.result?.stopReason !== "end_turn", text: k === "ok" && said ? cut(said) : null } });
        });
      });
      const go = (k) => (k === "refused" ? "refused" : false);
      return {
        // A message sent while a turn runs waits in the holder for that turn to end, and runs as a turn of its own.
        queues: true,
        begin: (text) => (ready = (async () => {
          const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
          if (outcome(init) !== "ok") return go(outcome(init));
          let s;
          if (sid) { r.loading(true); s = await rpc("session/load", { sessionId: sid, cwd, mcpServers: [] }); r.loading(false); }
          else s = await rpc("session/new", { cwd, mcpServers: [] });
          if (outcome(s) !== "ok") return go(outcome(s));
          if (!sid) { if (typeof s.result.sessionId !== "string" || !UUID.test(s.result.sessionId)) return "refused"; sid = s.result.sessionId; }
          if (!(await prompt(text))) return false;
          emit({ session: sid }); return true;
        })()),
        // Between turns only: Kiro takes no prompt while one runs ("Prompt already in progress"), so the holder keeps
        // a message until the running turn ends.
        send: async (text) => {
          if ((await readyWithin(ready)) !== true) return { code: "refused", why: "not_started" };
          if (running) return null; // never asked while a turn runs: the holder keeps the message (as when its input closed)
          return (await prompt(text)) ? { code: "handed_to_harness", next: true } : null;
        },
        line: (l) => { const ev = r.read(l); return take(ev) ? (ev.request != null ? { activity: true } : null) : ev; },
        open, done: () => c.stdin.end(),
      };
    },
  },
  cursor: {
    // As in a pane: --yolo --trust and the model id (its effort in it), on the run folder's private config copy.
    argv: ({ model, effort, session }) => ["-p", "--output-format", "stream-json", ...plan({ kind: "cursor", model, effort }).argv, ...(session ? ["--resume", session] : [])],
    env: (dir) => ({ CURSOR_CONFIG_DIR: join(dir, "cursor-config") }),
    connect: (c) => {
      // The task in, and the input closed: Cursor starts once it has read to the end. A message while it runs waits in
      // the holder, and runs as the next turn, in a new process resuming the session (one turn each).
      const begin = async (text) => { const ok = await writeLine(c, text); if (ok) try { c.stdin.end(); } catch {} return ok; };
      return { queues: true, begin, send: async () => null, line: cursorReader(), open: () => false, done: () => {} };
    },
  },
};
// The harnesses that can run headless.
export const HEADLESS_KINDS = Object.keys(ADAPTERS);
export const headlessArgv = ({ kind = "claude", model, effort, session, cwd }) => ADAPTERS[kind].argv({ model, effort, session, cwd });

// Whether a process group still has members, every one counted (POSIX). Windows: never known here (the holder's job
// took the tree with it).
export const groupHasMembers = (pgid) => {
  if (!Number.isInteger(pgid) || pgid <= 1 || process.platform === "win32") return false;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
};
// Whether anything of a `kind` harness still runs in a process group: its members, read with the system's ps, less
// the harness's own long-lived helper and the processes measured under it. Cursor's worker-server (measured 2026-10-22,
// cursor-agent 2026.10.22: one per project folder, started in the group of the turn that first needs it, reused by later
// turns, outliving them; references/harnesses.md, "Cursor headless") is told by its exact command line in the install
// its own command resolves into, and only the language server under it is: anything else under it counts (from the
// review of 62749a5: a path suffix, or every descendant, could hide the worker's own command). ps not answering in
// time, output routr cannot read, no install found: every member counts.
export const groupAlive = async (pgid, kind, { members = listGroup, installed = installedAt, timeoutMs = 5000 } = {}) => {
  if (!groupHasMembers(pgid)) return false;
  const helper = HARNESSES[kind]?.helper, exe = helper && installed(HARNESSES[kind].executable);
  if (!exe) return true;
  let timer;
  const m = await Promise.race([members(pgid, timeoutMs), new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); })]);
  clearTimeout(timer);
  return !m?.length || besidesHelper(m, helper.command(exe), helper.children).length > 0;
};
// Whether nothing of it runs there any more, looked at again for up to `ms`: something of a harness may still be
// exiting as it closes (measured 2026-10-22: a Cursor turn's group held a process in its exit, shown as "(node)", for
// under 100 ms after cursor-agent closed, so every correction queued behind that turn ended not started). Each look is
// bounded by what is left of `ms`, and none blocks the holder's answers.
export const groupGone = async (pgid, kind, { ms = 2000, every = 100, ...o } = {}) => {
  for (const end = Date.now() + ms; ;) {
    if (!(await groupAlive(pgid, kind, { ...o, timeoutMs: Math.max(1, Math.min(1000, end - Date.now())) }))) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, every));
  }
};
// The system's own ps, by its path where it has one (macOS and Linux both: /bin/ps), not whichever is first on PATH.
const PS = existsSync("/bin/ps") ? "/bin/ps" : "ps";
// Only a listing it finished counts (from the review of c9b049a: one that exited non-zero may stop part way).
export const listGroup = async (pgid, timeoutMs, { ps = PS } = {}) => {
  const r = await collect(ps, ["-A", "-o", "pid=,ppid=,pgid=,command="], { timeoutMs, separate: true });
  return r?.code === 0 ? groupMembers(r.out, pgid) : null;
};

// The holder: `routr workers --hold <name>`, started detached by launch or send. Exits on its own; never prints.
// `run` starts the harness (runtime's start); a test passes a fake.
export async function hold(name, { run = start, noTaskMs = 30000, startMs = 30000 } = {}) {
  const dir = runDir(name), w = readWorker(name);
  if (!w) return;
  const p = await probe(dir);
  if (["alive", "starting", "unreachable"].includes(p.state)) return; // another holder has it, or may
  const prior = readJson(join(dir, "state.json")) ?? {};
  // A harness an earlier generation started may still be working (its holder was killed, or a tool command outlived
  // it): never start a second Claude on its session while that group has members.
  if (await groupAlive(prior.harness_pgid, w.kind)) return;
  const n = p.gen + 1;
  if (!claim(dir, n)) return;
  if (p.state === "dead") removeEndpoint(w.id, p.ready?.endpoint);
  const turns = (prior.turns ?? []).map((t) => (t.outcome ? t : { ...t, outcome: "no_finish", ended_at: new Date().toISOString() })); // a lost turn ends here
  let st = { format: FORMAT, turn: 0, ...prior, turns, gen: n, holder_pid: process.pid, harness_pid: null, harness_pgid: null, tasks: 0, queued: 0 };
  let lastWrite = 0, later = null;
  // Every write of the state says whether it reached the disk: the ones that record what this holder started must.
  // Activity alone is written at most once a second: one that comes sooner is written when that second is up, so a
  // long turn's last tool is not held back until the turn ends.
  const save = (patch = {}, { quiet = false } = {}) => {
    st = { ...st, ...patch };
    const now = Date.now();
    if (quiet && now - lastWrite < 1000) { later ??= setTimeout(() => { later = null; save(); }, 1000 - (now - lastWrite)); return true; }
    if (later) { clearTimeout(later); later = null; }
    lastWrite = now; st.updated_at = new Date(now).toISOString();
    try { writeJsonAtomic(join(dir, "state.json"), st); return true; } catch { return false; }
  };
  const queue = [];
  let child = null, conn = null, inTurn = false, stopping = null, stopAsked = false, settled = false, server = null, endpoint = null, started = null, answering = 0;
  // Messages written to the harness between turns: counted on the turn they start, once it starts it. `sending`: messages
  // on their way in, which keep its input open until their answer is back.
  let pending = 0, sending = 0, refusing = null;
  const turnRow = () => st.turns.at(-1);
  const setRow = (patch) => ({ turns: [...st.turns.slice(0, -1), { ...turnRow(), ...patch }] });
  // One more message written into turn `n`, whether or not that turn is still running.
  const addDelivered = (n) => save({ turns: st.turns.map((t) => (t.turn === n ? { ...t, delivered: (t.delivered ?? 0) + 1 } : t)) });
  // A harness that runs each message as a turn of its own (`queues`: Antigravity) starts one turn per waiting message;
  // the others take every message written between turns into the one turn they start.
  // `carried`: messages the turn's own prompt carries (a resume that runs them), counted on it too.
  const beginTurn = (carried = 0) => { inTurn = true; const taken = conn?.queues ? Math.min(1, pending) : pending; pending -= taken; const delivered = taken + carried; save({ turn: st.turn + 1, turns: [...st.turns, { turn: st.turn + 1, started_at: new Date().toISOString(), delivered }], state: "working" }); };
  const endTurn = (outcome, text) => {
    if (!inTurn) return;
    inTurn = false;
    let report = null;
    if (text) { try { mkdirSync(join(dir, "reports"), { recursive: true, mode: 0o700 }); writeFileSync(reportPath(name, st.turn), text, { mode: 0o600 }); report = reportPath(name, st.turn); } catch {} }
    save({ ...setRow({ outcome, report, ended_at: new Date().toISOString() }), state: child ? "waiting" : st.state });
  };
  // Nothing more to say to it: close its input, so it ends once its background commands have. Not while a message it
  // was given has yet to start its turn, or one is on its way in.
  const maybeClose = () => { if (conn && child && !inTurn && !pending && !sending && !queue.length && !st.tasks && conn.open()) conn.done(); };
  // Leave once the harness has gone and nothing waits: the outcome stays in state.json, the generation says it ended.
  // A process group that still has members (a tool command that outlived Claude) stays recorded, and blocks a resume
  // and cleanup until it is empty.
  const settle = () => {
    if (settled) return; settled = true;
    const last = turnRow();
    const pg = groupHasMembers(st.harness_pgid) ? st.harness_pgid : null;
    save({ state: stopAsked ? "stopped" : last?.outcome === "finished" ? "idle" : st.turn ? "failed" : "no_task", harness_pid: null, harness_pgid: pg, holder_pid: null, queued: 0 });
    markReleased(dir, n, { harness_exited: true, ...(pg ? { group_left: pg } : {}) });
    try { server?.close(); } catch {}
    removeEndpoint(w.id, endpoint);
    // Exit once every request being answered has had its reply written (a stop's answer above all), at most 3 s on.
    const leave = (t = 0) => (answering && t < 3000 ? setTimeout(() => leave(t + 25), 25) : setTimeout(() => process.exit(0), 50));
    leave();
  };

  // One harness process: the turn is counted before it starts, so a start that fails still gives that message an
  // outcome. Everything it reports is bound to that process, and it is finished on `close`, once its output is read.
  // `carried`: how many lead messages `text` holds (a resume of queued ones), counted on its turn.
  const runHarness = (text, session, { carried = 0 } = {}) => {
    started = new Promise((resolve) => {
      let answered = false, finished = false, taskIn = false;
      const answer = (r) => { if (!answered) { answered = true; resolve(r); } };
      beginTurn(carried);
      let c, h;
      try {
        c = run(HARNESSES[w.kind].executable, headlessArgv({ kind: w.kind, model: w.model, effort: w.effort, session, cwd: w.cwd }),
          { cwd: w.cwd, env: { ...harnessEnv(), ...(ADAPTERS[w.kind].env?.(dir) ?? {}) }, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
      } catch { endTurn("not_started", null); answer({ code: "failed", why: "harness_not_started" }); return settle(); }
      child = c;
      // What it says, as events: bound to this process, and ignored once it has finished.
      const onEvent = (ev) => {
        if (!ev || finished) return;
        if (ev.turn && !inTurn) beginTurn(); // a turn the harness started itself
        if (ev.session) { save({ session_id: ev.session }); answer({ code: "prompted", session: ev.session }); }
        if (ev.tasks != null) save({ tasks: ev.tasks });
        if (ev.tool) save({ last_tool: ev.tool, last_event_at: new Date().toISOString() }, { quiet: true });
        if (ev.activity) save({ last_event_at: new Date().toISOString() }, { quiet: true });
        // A turn the harness started without saying so (no init seen) still gets its outcome.
        if (ev.result && !inTurn) beginTurn();
        // A turn it ended as failed once stop was asked (Codex: interrupted) was stopped.
        if (ev.result) endTurn(ev.result.failed ? (stopAsked ? "stopped" : "failed") : "finished", ev.result.text);
        if (ev.result) nextHeld(); // a harness that queues: the next message the holder keeps, as a turn of its own
        if (ev.result || ev.tasks === 0) maybeClose();
      };
      conn = h = ADAPTERS[w.kind].connect(c, { cwd: w.cwd, model: w.model, effort: w.effort, session, emit: onEvent });
      const finish = (why) => {
        if (finished) return; finished = true;
        // Messages it took between turns, and no turn started for them: they get one (one each, for a harness that
        // queues), ended with this process.
        if (pending && !inTurn) beginTurn();
        endTurn(stopAsked ? "stopped" : why, null);
        while (pending) { beginTurn(); endTurn(stopAsked ? "stopped" : why, null); }
        answer({ code: "failed", why: "harness_ended" });
        if (child === c) { child = null; conn = null; }
        // A message that arrived after its input closed: the next turn, on the same session, unless something of the
        // last Claude is still running in its group (never two on one session); then the message's turn is not started.
        // A harness that queues runs them one turn each, in the order they came (the first now, the rest as each turn
        // ends, from the same queue); the others take them as one. Not when this process ended before it took its
        // task (a resume would end the same way) or something of it still runs: then each gets a turn, not started.
        // Without a session (it ended during its first start) there is nothing to resume: they get their turns too.
        // Messages that come meanwhile join the queue; a stop meanwhile settles the holder itself.
        const decide = (resumable) => {
          if (settled) return;
          if (queue.length && !stopAsked) {
            const each = h.queues;
            if (resumable) {
              // Counted as the messages they are (a message holds paragraphs of its own: from the review of 420d69c).
              const taken = each ? queue.splice(0, 1) : queue.splice(0);
              save({ queued: queue.length });
              runHarness(taken.join("\n\n"), st.session_id, { carried: taken.length }); return;
            }
            const all = queue.splice(0); save({ queued: 0 });
            for (let i = 0; i < (each ? all.length : 1); i++) { beginTurn(each ? 1 : all.length); endTurn("not_started", null); }
          }
          settle();
        };
        if (queue.length && !stopAsked && taskIn && st.session_id) groupGone(st.harness_pgid, w.kind).then(decide);
        else decide(false);
      };
      c.on("error", () => { if (c.pid == null) finish("not_started"); });
      c.on("close", () => finish("no_finish"));
      c.stdin.on("error", () => {});
      if (!c.pid) return finish("not_started");
      // What this holder started is on disk before the task goes in, or the task does not go in: it is stopped, and
      // the holder stays until it has closed.
      if (!save({ harness_pid: c.pid, harness_pgid: process.platform === "win32" ? null : c.pid, state: "working", ...(session ? {} : { session_id: null }) })) {
        refusing = "state_not_written"; stop(c, { group: true }); answer({ code: "failed", why: "state_not_written" }); return;
      }
      let buf = "";
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!finished) onEvent(h.line(l)); }
      });
      // A harness that answered no (a model or session it does not have) ends that turn failed, and is let go.
      h.begin(text).then((r) => {
        if (finished) return; // it ended first: finish has answered
        if (r === true) taskIn = true;
        else if (r === "refused") { endTurn("failed", null); answer({ code: "failed", why: "harness_refused" }); if (h.open()) h.done(); }
        else { stop(c, { group: true }); answer({ code: "failed", why: "task_not_written" }); }
      });
      // Not named its session in time: "prompted" only once the task is in (Claude: written; Codex: its turn started),
      // else not known (from the review of a68ca2e: Codex may still be starting, the brief not yet sent).
      setTimeout(() => answer(taskIn ? { code: "prompted", session: null } : { code: "unknown", why: "not_started_in_time" }), startMs).unref?.();
    });
    return started;
  };

  // stop: SIGTERM to the harness's group, then SIGKILL to it after the grace while Claude is still there (runtime's
  // stop; signalled only while Claude is unreaped, so the group id is still its own). Anything of the group left once
  // Claude has gone is not signalled again (its id may be someone else's by then): it is reported, and recorded.
  // Messages the holder still keeps are dropped, and counted in the answer.
  let dropped = 0;
  const stopAll = () => {
    if (!stopAsked) dropped = queue.length;
    stopAsked = true; queue.length = 0; save({ queued: 0 });
    return (stopping ??= (async () => {
      const c = child;
      // No harness running: between its exit and what the holder does next, its group may still have members (from
      // the review of 62749a5: reported stopped without a look).
      if (!c) { const gone = await groupGone(st.harness_pgid, w.kind); settle(); return { code: gone ? "stopped" : "still_exiting", dropped }; }
      const closed = new Promise((r) => c.once("close", r));
      stop(c, { group: true });
      const gone = await Promise.race([closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 6000))]);
      return { code: gone && await groupGone(process.platform === "win32" ? null : c.pid, w.kind) ? "stopped" : "still_exiting", dropped };
    })());
  };

  // One message into a harness that queues, between its turns: counted as waiting before it goes in, so the turn it
  // starts takes it even when that turn begins before the write is acknowledged; taken back if it never got it.
  const handOver = async (text) => {
    const c = conn;
    if (!c?.open()) return null;
    pending++; sending++;
    let r; try { r = await c.send(text, false); } finally { sending--; }
    if (r?.code !== "handed_to_harness") pending = Math.max(0, pending - 1);
    return r;
  };
  // The turn after a turn: the oldest message the holder keeps. One it never got goes back to the front (it resumes
  // with the rest once the harness exits); one it refused, or ended before answering, gets a turn of its own, not run.
  const nextHeld = async () => {
    if (!conn?.queues || inTurn || pending || sending || stopAsked || !queue.length || !conn.open()) return;
    const t = queue.shift(); save({ queued: queue.length });
    const r = await handOver(t);
    if (r?.code === "handed_to_harness") return;
    if (!r) { if (!stopAsked) { queue.unshift(t); save({ queued: queue.length }); } return; }
    beginTurn(1); endTurn(r.code === "unknown" ? "no_finish" : "not_started", null);
    nextHeld();
  };

  const handle = async (op, m) => { answering++; try { return await answerOp(op, m); } finally { answering--; } };
  const answerOp = async (op, m) => {
    if (op === "ping") return { code: "ok", gen: n, state: st.state ?? null, queued: queue.length };
    if (op === "stop") return stopAll();
    if (op !== "start" && op !== "send") return { code: "refused", why: "unknown_op" };
    if (typeof m.text !== "string" || !m.text.trim()) return { code: "refused", why: "empty" };
    if (stopAsked || refusing) return { code: "refused", why: refusing ?? "stopping" };
    if (settled) return { code: "refused", why: "ended" }; // the sender starts the next generation
    if (!child && !started) {
      if (op === "send" && !st.session_id) return { code: "refused", why: "no_session" }; // a follow-up is not a task
      return runHarness(m.text, op === "send" ? st.session_id : null);
    }
    // A harness that queues (each message a turn of its own): while a turn runs, or messages already wait, the holder
    // keeps it, in order, and hands it over when its turn comes (nextHeld); between turns it goes in now. One queue,
    // the holder's, for every message not yet handed over: a stop drops them all and counts them, an exit resumes
    // them in order (from the review of 19031d3: two lists reordered and lost messages).
    if (child && conn?.open() && conn.queues) {
      if (inTurn || pending || sending || queue.length) {
        if (queue.length >= 8) return { code: "refused", why: "queue_full" };
        queue.push(m.text); save({ queued: queue.length });
        return { code: "queued", why: "next_turn" };
      }
      const r = await handOver(m.text);
      if (r) { maybeClose(); return { code: r.code, ...(r.why ? { why: r.why } : {}) }; }
    }
    // Into the running harness while its input is open: counted on the running turn, or, between turns (or when the
    // harness says it starts the next one), on the turn it starts. A message it did not take changes no turn.
    else if (child && conn?.open()) {
      // The turn it goes into: the running one, or the next. Decided now, counted once it is in, which may be after the
      // harness has started that next turn.
      const into = inTurn ? st.turn : null, before = st.turn, c = conn;
      sending++;
      let r; try { r = await c.send(m.text, inTurn); } finally { sending--; }
      // It said no, or ended before saying: no turn counts it, and it is not queued (it may have taken it).
      if (r && (r.code === "refused" || r.code === "unknown")) { maybeClose(); return { code: r.code, why: r.why }; }
      if (r) {
        if (r.next !== true && into != null) addDelivered(into);
        else if (st.turn > before) addDelivered(before + 1);
        else pending++;
        maybeClose();
        return { code: r.code };
      }
      maybeClose();
      // Never got it, yet its input is open: nothing would drain a queue before it exits, so it is refused.
      if (conn === c && c.open()) return { code: "refused", why: "not_written" };
    }
    // Its input has closed (it is finishing): the next turn, on the same session, once it has exited. Asked again
    // after the write: the holder may have ended or been told to stop meanwhile.
    if (settled) return { code: "refused", why: "ended" };
    if (stopAsked) return { code: "refused", why: "stopping" };
    if (queue.length >= 8) return { code: "refused", why: "queue_full" };
    queue.push(m.text); save({ queued: queue.length });
    return { code: "queued" };
  };

  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => { stopAll(); });
  try {
    endpoint = endpointFor(w.id, n);
    server = await serve(dir, n, endpoint, handle);
  } catch (e) { save({ state: st.turn ? st.state : "no_task" }); markReleased(dir, n, { harness_exited: true, why: e?.code === "path_too_long" ? "path_too_long" : "channel_not_bound" }); return; }
  save({ state: st.turn ? "waiting" : "starting" });
  markReady(dir, n, { endpoint, pid: process.pid, at: Date.now() });
  // Started for a task that never came (the launch or send that started it failed first): say so and go.
  setTimeout(() => { if (!started && !stopping) settle(); }, noTaskMs).unref?.();
}

// The run folder of a new worker, reserved by its name: made whole, owner-only, or refused when one exists.
// Made first, then the uninstall lock looked at: uninstall takes its lock first, then looks for run folders, so one of
// the two always sees the other.
export function reserve(name, { beforeBackout = () => {} } = {}) {
  privateDir(WORKERS_DIR());
  mkdirSync(runDir(name), { mode: 0o700 }); // not recursive: EEXIST when that name is taken
  const made = statSync(runDir(name));
  let held = false;
  try { held = existsSync(UNINSTALL_LOCK()) && !lockIsStale(UNINSTALL_LOCK()); } catch { held = existsSync(UNINSTALL_LOCK()); }
  if (held) {
    beforeBackout(); // a test acts here: as if this call paused while uninstall and another launch ran
    // Only the folder this call made, and only while it is empty: uninstall may have removed it meanwhile and a new
    // launch of the same name made its own (from #104's review), which a late backout must not touch.
    try { const now = statSync(runDir(name)); if (now.ino === made.ino && now.dev === made.dev) rmdirSync(runDir(name)); } catch {}
    try { rmdirSync(WORKERS_DIR()); } catch {} // only if empty: leave nothing that would keep uninstall's folder
    throw new Error("routr is being uninstalled on this machine: no worker can start now");
  }
  return runDir(name);
}
