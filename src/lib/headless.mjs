// Headless workers: a worker that runs its harness's own headless mode on the user's sign-in, outside herdr, with one
// routr process (the holder) owning it. The holder starts as a numbered generation of its worker (channel.mjs), binds
// the channel before it starts the harness and closes it only after the harness has exited, and is the only writer of
// the worker's state. It lives while a turn runs or one is waiting, and exits once the harness has. Claude Code only
// for now. Measured as prototypes p34 (2026-10-21) and p36 (2026-10-22, Claude Code 2.1.307), routr-lab:
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
// Worker text reaches one place, the report file of each turn (owner-only, removed by cleanup); only its path leaves
// routr. Nothing else of the harness's output is kept: its stderr is not read, and a tool is shown by a fixed name.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claim, endpointFor, markReady, markReleased, privateDir, probe, removeEndpoint, serve } from "./channel.mjs";
import { HARNESSES, plan } from "./harnesses.mjs";
import { harnessEnv, start, STATE_DIR, stop, writeJsonAtomic } from "./runtime.mjs";

export const FORMAT = 1;
export const WORKERS_DIR = () => join(STATE_DIR(), "workers");
export const runDir = (name) => join(WORKERS_DIR(), name);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
// What launch wrote: { format, id, name, kind, model, effort, cwd, created_at }. Never the brief, never the environment.
export const readWorker = (name) => { const w = readJson(join(runDir(name), "worker.json")); return w?.format === FORMAT && w.name === name ? w : null; };
// What the holder wrote last (headless.mjs is its only writer).
export const readState = (name) => readJson(join(runDir(name), "state.json"));
export const reportPath = (name, turn) => join(runDir(name), "reports", `turn-${turn}.md`);
// The harnesses that can run headless, and how. Claude Code only, so far.
export const HEADLESS_KINDS = ["claude"];
const STREAM = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
export const headlessArgv = ({ kind = "claude", model, effort, session }) => [...STREAM, ...plan({ kind, model, effort }).argv, ...(session ? ["--resume", session] : [])];
const message = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

// Claude's tool names as it sends them; any other tool is `other`, an MCP server's is `mcp`. Never a title or argument.
const TOOLS = new Set(["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "LS", "Task", "Agent", "WebFetch", "WebSearch", "TodoWrite",
  "NotebookEdit", "NotebookRead", "ToolSearch", "Monitor", "Skill", "BashOutput", "KillShell", "ExitPlanMode"]);
const toolName = (n) => (typeof n !== "string" ? "other" : TOOLS.has(n) ? n : n.startsWith("mcp__") ? "mcp" : "other");
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPORT_MAX = 1024 * 1024;
// One line of Claude's stream, as what routr knows how to say: the session, a turn starting, a tool, how many
// background tasks are running, a turn's end. Anything else is ignored.
export function readEvent(line) {
  let e; try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e !== "object") return null;
  if (e.type === "system" && e.subtype === "init") return { turn: true, ...(SESSION_ID.test(e.session_id) ? { session: e.session_id } : {}) };
  if (e.type === "system" && e.subtype === "background_tasks_changed") return { tasks: Array.isArray(e.tasks) ? e.tasks.length : 0 };
  if (e.type === "assistant") { const t = (e.message?.content ?? []).filter((c) => c?.type === "tool_use").at(-1); return t ? { tool: toolName(t.name) } : { activity: true }; }
  if (e.type === "result") return { result: { failed: e.is_error === true, text: typeof e.result === "string" ? e.result.slice(0, REPORT_MAX) : null } };
  return null;
}

// Whether a process group still has members (POSIX). Windows: never known here (the holder's job took the tree with it).
export const groupAlive = (pgid) => { if (!Number.isInteger(pgid) || pgid <= 1 || process.platform === "win32") return false; try { process.kill(-pgid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };

// The holder: `routr workers --hold <name>`, started detached by launch or send. Exits on its own; never prints.
// `run` starts the harness (runtime's start); a test passes a fake.
export async function hold(name, { run = start, noTaskMs = 30000, startMs = 30000 } = {}) {
  const dir = runDir(name), w = readWorker(name);
  if (!w) return;
  const p = await probe(dir);
  if (["alive", "starting", "unreachable"].includes(p.state)) return; // another holder has it, or may
  const prior = readJson(join(dir, "state.json")) ?? {};
  // A dead generation's harness may still be working, blind: never start a second Claude on its session.
  if (p.state === "dead" && groupAlive(prior.harness_pgid)) return;
  const n = p.gen + 1;
  if (!claim(dir, n)) return;
  if (p.state === "dead") removeEndpoint(w.id, p.ready?.endpoint);
  let st = { format: FORMAT, turn: 0, turns: [], ...prior, gen: n, holder_pid: process.pid, harness_pid: null, harness_pgid: null, tasks: 0, queued: 0 };
  let lastWrite = 0;
  const save = (patch = {}, { quiet = false } = {}) => {
    st = { ...st, ...patch };
    const now = Date.now();
    if (quiet && now - lastWrite < 1000) return; // activity alone is written at most once a second
    lastWrite = now; st.updated_at = new Date(now).toISOString();
    try { writeJsonAtomic(join(dir, "state.json"), st); } catch {}
  };
  const queue = [];
  let child = null, inTurn = false, stopping = null, settled = false, server = null, endpoint = null, started = null;
  const turnRow = () => st.turns.at(-1);
  const beginTurn = () => { inTurn = true; save({ turn: st.turn + 1, turns: [...st.turns, { turn: st.turn + 1, started_at: new Date().toISOString(), delivered: 0 }], state: "working" }); };
  const endTurn = (outcome, text) => {
    if (!inTurn) return;
    inTurn = false;
    let report = null;
    if (text) { try { mkdirSync(join(dir, "reports"), { recursive: true, mode: 0o700 }); writeFileSync(reportPath(name, st.turn), text, { mode: 0o600 }); report = reportPath(name, st.turn); } catch {} }
    save({ turns: [...st.turns.slice(0, -1), { ...turnRow(), outcome, report, ended_at: new Date().toISOString() }], state: child ? "waiting" : st.state });
  };
  const write = (text) => {
    if (!inTurn) beginTurn(); else save({ turns: [...st.turns.slice(0, -1), { ...turnRow(), delivered: (turnRow().delivered ?? 0) + 1 }] });
    child.stdin.write(message(text));
  };
  // Leave once the harness has gone and nothing waits: the outcome stays in state.json, the generation says it ended.
  const settle = () => {
    if (settled) return; settled = true;
    const last = turnRow();
    save({ state: stopping ? "stopped" : last?.outcome === "finished" ? "idle" : st.turn ? "failed" : "no_task", harness_pid: null, holder_pid: null, queued: 0 });
    markReleased(dir, n, { harness_exited: !child || child.exitCode != null || child.signalCode != null });
    try { server?.close(); } catch {}
    removeEndpoint(w.id, endpoint);
    setTimeout(() => process.exit(0), 50).unref?.();
  };

  const runHarness = (text, session) => {
    started = new Promise((resolve) => {
      let answered = false;
      const answer = (r) => { if (!answered) { answered = true; resolve(r); } };
      try {
        child = run(HARNESSES[w.kind].executable, headlessArgv({ kind: w.kind, model: w.model, effort: w.effort, session }),
          { cwd: w.cwd, env: harnessEnv(), stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
      } catch { child = null; answer({ code: "failed", why: "harness_not_started" }); return settle(); }
      save({ harness_pid: child.pid, harness_pgid: process.platform === "win32" ? null : child.pid, state: "working", ...(session ? {} : { session_id: null }) });
      child.on("error", () => answer({ code: "failed", why: "harness_not_started" }));
      child.stdin.on("error", () => {});
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const ev = readEvent(buf.slice(0, i)); buf = buf.slice(i + 1);
          if (!ev) continue;
          if (ev.turn && !inTurn) beginTurn(); // a turn the harness started itself
          if (ev.session) { save({ session_id: ev.session }); answer({ code: "prompted", session: ev.session }); }
          if (ev.tasks != null) save({ tasks: ev.tasks });
          if (ev.tool) save({ last_tool: ev.tool, last_event_at: new Date().toISOString() }, { quiet: true });
          if (ev.activity) save({ last_event_at: new Date().toISOString() }, { quiet: true });
          if (ev.result) {
            endTurn(ev.result.failed ? "failed" : "finished", ev.result.text);
            // Nothing more to say to it: close its input so it ends once its background commands have.
            if (!queue.length && !st.tasks && !child.stdin.writableEnded) child.stdin.end();
          }
          if (ev.tasks === 0 && !inTurn && !queue.length && !child.stdin.writableEnded) child.stdin.end();
        }
      });
      child.on("exit", () => {
        endTurn(stopping ? "stopped" : "no_finish", null);
        answer({ code: "failed", why: "harness_ended" });
        child = null;
        // A message that arrived after its input closed: the next turn, on the same session.
        if (queue.length && !stopping && st.session_id) { const next = queue.splice(0).join("\n\n"); save({ queued: 0 }); runHarness(next, st.session_id); return; }
        settle();
      });
      write(text);
      setTimeout(() => answer({ code: "prompted", session: null }), startMs).unref?.();
    });
    return started;
  };

  const stopAll = () => (stopping ??= (async () => {
    queue.length = 0;
    if (child) {
      const c = child, exited = new Promise((r) => c.once("exit", r));
      stop(c, { group: true });
      const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 6000))]);
      if (!gone) return { code: "still_exiting" };
      return { code: "stopped" };
    }
    settle(); return { code: "stopped" };
  })());

  const handle = async (op, m) => {
    if (op === "ping") return { code: "ok", gen: n, state: st.state ?? null, queued: queue.length };
    if (op === "stop") return stopAll();
    if (op !== "start" && op !== "send") return { code: "refused", why: "unknown_op" };
    if (typeof m.text !== "string" || !m.text.trim()) return { code: "refused", why: "empty" };
    if (stopping) return { code: "refused", why: "stopping" };
    if (settled) return { code: "refused", why: "ended" }; // the sender starts the next generation
    if (!child && !started) return runHarness(m.text, op === "send" || m.resume ? st.session_id : null);
    if (child && !child.stdin.writableEnded) { write(m.text); return { code: "handed_to_harness" }; }
    if (queue.length >= 8) return { code: "refused", why: "queue_full" };
    queue.push(m.text); save({ queued: queue.length });
    return { code: "queued" };
  };

  for (const s of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(s, () => { stopAll(); });
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
export function reserve(name) {
  privateDir(WORKERS_DIR());
  mkdirSync(runDir(name), { mode: 0o700 }); // not recursive: EEXIST when that name is taken
  return runDir(name);
}
