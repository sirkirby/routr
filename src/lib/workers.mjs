// The commands for headless workers (headless.mjs): launch's start outside herdr, and `wait`, `send`, `workers`,
// `stop` and `cleanup --worker`. Each talks to a worker's holder only through its channel (channel.mjs) and reads what
// the holder wrote; none stops a process by a saved id. Answers carry report paths, never worker text.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, generations, probe, removeEndpoint, writeSecret } from "./channel.mjs";
import { FORMAT, groupAlive, HEADLESS_KINDS, headlessArgv, readState, readWorker, reserve, runDir, WORKERS_DIR } from "./headless.mjs";
import { HARNESSES, notReady } from "./harnesses.mjs";
import { loadConfig } from "./config.mjs";
import { readTask } from "./advice-file.mjs";
import { displayCommand, doNext, runNext } from "./next.mjs";
import { answer } from "./output.mjs";
import { OFF } from "./wording.mjs";
import { spawnSelf, writeJsonAtomic } from "./runtime.mjs";

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const CLOSING = "Finish with the report block from the worker guide, starting with the line `VERDICT: done | partial | blocked`.";
// A lead's sandbox carries over to what it starts (prototype p36, 2026-10-22): inside Claude Code's Bash sandbox a
// worker could not write routr's state folder or reach api.anthropic.com, and inside Codex's (workspace-write) it could
// not write that folder and `claude` said "Not logged in", its Keychain hidden. Each says it is there.
const SANDBOXES = [["SANDBOX_RUNTIME", "Claude Code's Bash sandbox"], ["CODEX_SANDBOX", "Codex's sandbox"]];
export const sandboxOf = (env) => SANDBOXES.find(([k]) => env[k])?.[1] ?? null;
const SANDBOXED = (which) => `this command runs inside ${which}, and a worker started from there cannot write routr's state or reach its provider; run routr launch outside the sandbox (in Claude Code, as a command the sandbox does not wrap; in Codex, with sandbox_mode danger-full-access or an approved escalation)`;

// Every name a worker can be given, the folders that exist: the holder writes state, launch the worker file.
const names = () => { try { return readdirSync(WORKERS_DIR()).filter((n) => NAME.test(n)).sort(); } catch { return []; } };
const ago = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null; };

// Why a holder did not come up, in routr's words (the holder records a fixed code when it cannot open its channel).
const NOT_STARTED = (p) => p.released?.why === "path_too_long" ? "the worker's socket path would be longer than this system allows (your home folder's path is too long); headless workers cannot run from this home"
  : p.released?.why === "channel_not_bound" ? "the worker's process could not open its channel"
  : `the worker's process did not start (${p.state})`;
// Start the next holder of a worker (launch, or send to an idle one) and wait until its channel answers.
async function becomeHolder(name, { spawn = spawnSelf, timeoutMs = 15000 } = {}) {
  if (!spawn(["workers", "--hold", name])) return { state: "not_started" };
  const until = Date.now() + timeoutMs;
  let p;
  while (Date.now() < until) { p = await probe(runDir(name)); if (p.state === "alive") return p; await sleep(150); }
  return p ?? { state: "not_started" };
}
const ask = async (name, p, op, extra = {}, ms = 5000) => {
  const c = await connect(runDir(name), p.gen, p.ready.endpoint);
  try { return await c.request(op, extra, ms); } finally { c.close(); }
};

// What one worker looks like to a lead: its state from the holder, checked against whether the holder still answers.
// `lost`: the holder said a turn was running and no longer answers; the harness may still run (its process group).
export async function view(name, { check = true } = {}) {
  const w = readWorker(name);
  if (!w) return null;
  const st = readState(name) ?? {};
  let state = st.state ?? "starting";
  let channel = null;
  if (check) {
    channel = (await probe(runDir(name))).state;
    if (["working", "waiting", "starting"].includes(state) && ["dead", "abandoned", "released", "none"].includes(channel)) state = channel === "released" ? state : "lost";
    if (channel === "unreachable") state = "unreachable";
  }
  const last = st.turns?.at(-1);
  return { name, kind: w.kind, model: w.model, effort: w.effort ?? null, cwd: w.cwd, state, turn: st.turn ?? 0,
    seconds_since_event: ago(st.last_event_at ?? st.updated_at), last_tool: st.last_tool ?? null, tasks: st.tasks ?? 0, queued: st.queued ?? 0,
    session: st.session_id ?? null, report: last?.report ?? null, ...(state === "lost" && groupAlive(st.harness_pgid) ? { harness_group: st.harness_pgid } : {}),
    turns: (st.turns ?? []).map((t) => ({ turn: t.turn, outcome: t.outcome ?? "running", report: t.report ?? null, delivered: t.delivered ?? 0 })) };
}

// ---- launch, outside herdr -----------------------------------------------------------------------------------------
// Called by launch once the arguments, task and advice are checked: refuses what headless cannot do, reserves the
// name, starts the holder and hands it the prompt over the channel. `out` is launch's answer, filled in place.
export async function launchHeadless(o, out, { prompt, env, settings, ready, spawn }) {
  const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail });
  if (!HEADLESS_KINDS.includes(o.kind)) throw new Error(`outside herdr, routr launch starts ${HEADLESS_KINDS.map((k) => HARNESSES[k].label).join(", ")} workers only; run the lead inside herdr for a ${HARNESSES[o.kind].label} worker`);
  for (const f of ["pane", "direction", "worktree", "base", "copy"]) if (o[f] != null) throw new Error(`--${f} needs herdr; outside herdr a worker runs headless in --cwd`);
  if (prompt == null) throw new Error("outside herdr a worker starts with its task: pass --task-file (or --task) and --advice");
  const sandbox = sandboxOf(env);
  if (sandbox) throw new Error(SANDBOXED(sandbox));
  const loaded = settings(), config = loaded.config ?? loaded;
  out.warnings.push(...(loaded.notes ?? []));
  if (config.subscriptions[o.kind]?.enabled === false) throw new Error(OFF.launch(HARNESSES[o.kind].label, o.kind));
  const signedOut = await ready(o.kind);
  if (signedOut) throw new Error(`${HARNESSES[o.kind].label} cannot take work: ${signedOut}`);
  const argv = headlessArgv({ kind: o.kind, model: o.model, effort: o.effort });
  out.start = { executable: HARNESSES[o.kind].executable, argv, env: {} };
  out.ran.push(displayCommand([HARNESSES[o.kind].executable, ...argv]));
  let dir;
  try { dir = reserve(o.name); }
  catch (e) {
    if (e?.code === "EEXIST") throw new Error(`a worker named ${o.name} exists; finish it with routr cleanup --worker ${o.name}, or choose another --name`);
    if (e?.code === "EPERM" || e?.code === "EACCES") throw new Error(SANDBOXED("a sandbox or a folder routr cannot write"));
    throw e;
  }
  const w = { format: FORMAT, id: randomUUID().replace(/-/g, ""), name: o.name, kind: o.kind, model: o.model, effort: o.effort ?? null, cwd: out.cwd, created_at: new Date().toISOString() };
  writeFileSync(join(dir, "worker.json"), JSON.stringify(w) + "\n", { mode: 0o600 });
  writeSecret(dir);
  out.worker = { name: o.name, backend: "headless", run: dir, session: null };
  step("reserve", true, `Made ${dir} for ${o.name}`);
  const p = await becomeHolder(o.name, { spawn });
  if (p.state !== "alive") {
    // Nothing started: the folder holds only what this launch wrote.
    if (!["starting", "unreachable"].includes(p.state)) { try { rmSync(dir, { recursive: true, force: true }); } catch {} out.worker = null; }
    throw new Error(NOT_STARTED(p));
  }
  step("holder", true, `The worker's process answers on its channel (generation ${p.gen})`);
  let r;
  try { r = await ask(o.name, p, "start", { text: prompt }, 45000); } catch (e) { r = { code: "unknown", why: e?.code ?? "no_answer" }; }
  out.prompt_chars = prompt.length;
  if (r.code === "prompted") {
    out.worker.session = r.session ?? null;
    step("prompt", true, r.session ? `${HARNESSES[o.kind].label} took the task (session ${r.session})` : `${HARNESSES[o.kind].label} took the task; it has not named its session yet`);
    out.ok = true; out.state = "prompted";
    out.next.push(runNext("Wait for this worker's turn to end (it returns earlier when any worker you wait on finishes); then read its report.", ["routr", "wait", "--name", o.name]));
    return;
  }
  step("prompt", false, `The worker did not start its task (${r.why ?? r.code})`);
  throw new Error(r.code === "unknown" ? "the task was handed to the worker's process, which did not answer; run routr workers before launching it again"
    : `${HARNESSES[o.kind].label} ended before it started the task; the worker's report, if it wrote one, is in ${dir}`);
}

// ---- wait ------------------------------------------------------------------------------------------------------------
// Returns once a worker it waits on has a turn it has not reported yet, has failed, stopped or been lost, or at the
// timeout (still running). The default fits inside a lead's own shell-tool limit (Claude Code's is 2 minutes).
export function parseNamed(args, cmd, values, flags = []) {
  const o = { names: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, "");
    if (args[i].startsWith("--") && flags.includes(key)) { o[key] = true; continue; }
    if (!args[i].startsWith("--") || !values.includes(key)) throw new Error(`Unknown ${cmd} option: ${args[i]}`);
    if (!args[i + 1]?.trim() || /^-\S/.test(args[i + 1])) throw new Error(`--${key} requires a value`);
    if (key === "name") { if (!NAME.test(args[i + 1])) throw new Error("--name must match [a-z][a-z0-9_-]{0,31}"); o.names.push(args[++i]); continue; }
    if (Object.hasOwn(o, key)) throw new Error(`Repeated ${cmd} option: --${key}`);
    o[key] = args[++i];
  }
  return o;
}
const SEEN = (name) => join(runDir(name), "seen.json");
const seenTurn = (name) => { try { return JSON.parse(readFileSync(SEEN(name), "utf8")).turn ?? 0; } catch { return 0; } };
const SETTLED = new Set(["idle", "failed", "stopped", "lost", "no_task", "unreachable"]);

export async function waitCommand(args, { now = () => Date.now(), pause = sleep } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: [], next: [], state: "failed", workers: [] };
  try {
    const o = parseNamed(args, "wait", ["name", "timeout"]);
    const timeout = o.timeout == null ? 90000 : Number(o.timeout);
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 600000) throw new Error("--timeout must be milliseconds, at most 600000");
    // Unnamed: every worker still running, or with a turn this wait has not reported yet.
    const watched = o.names.length ? o.names : names().filter((n) => { const s = readState(n); return s && (["working", "waiting", "starting"].includes(s.state) || (s.turns ?? []).some((t) => t.turn > seenTurn(n) && t.outcome)); });
    for (const n of watched) if (!readWorker(n)) throw new Error(`no headless worker named ${n}; routr workers lists them`);
    if (!watched.length) { out.ok = true; out.state = "none"; out.headline = "routr: no headless worker to wait on"; return out; }
    const deadline = now() + timeout;
    let views = [], lastCheck = 0;
    for (;;) {
      const check = now() - lastCheck >= 5000;
      if (check) lastCheck = now();
      views = (await Promise.all(watched.map((n) => view(n, { check })))).filter(Boolean);
      const news = views.filter((v) => v.turns.some((t) => t.turn > seenTurn(v.name) && t.outcome !== "running") || (SETTLED.has(v.state) && v.state !== "idle" && seenTurn(v.name) < v.turn + 1));
      const running = views.some((v) => ["working", "waiting", "starting"].includes(v.state));
      if (news.length || !running || now() >= deadline) break;
      await pause(Math.min(500, Math.max(0, deadline - now())));
    }
    const done = [];
    for (const v of views) {
      const fresh = v.turns.filter((t) => t.turn > seenTurn(v.name) && t.outcome !== "running");
      out.workers.push({ ...v, turns: fresh });
      if (fresh.length || (SETTLED.has(v.state) && v.state !== "idle")) {
        done.push(v);
        try { writeJsonAtomic(SEEN(v.name), { turn: SETTLED.has(v.state) && v.state !== "idle" ? v.turn + 1 : Math.max(...fresh.map((t) => t.turn)) }); } catch {}
      }
    }
    out.ok = true;
    const running = views.filter((v) => ["working", "waiting", "starting"].includes(v.state));
    out.state = done.length ? "finished" : running.length ? "running" : "idle";
    out.headline = done.length ? `routr: ${done.map((v) => `${v.name} ${v.state === "idle" || v.state === "waiting" ? "finished a turn" : v.state}`).join("; ")}`
      : running.length ? `routr: still running: ${running.map((v) => v.name).join(", ")}` : `routr: nothing running: ${views.map((v) => `${v.name} ${v.state}`).join(", ")}`;
    for (const v of done) {
      const fresh = out.workers.find((x) => x.name === v.name).turns;
      for (const t of fresh) if (t.report) out.next.push(doNext(`Read ${v.name}'s report for turn ${t.turn}, then take a first read of it against the task you gave.`, `routr check --brief <task-file> --report ${t.report}`));
      if (v.state === "lost") out.next.push(doNext(`${v.name}'s process ended without settling${v.harness_group ? `, and its harness may still be running (process group ${v.harness_group})` : ""}: run routr workers, and stop or clean it up once nothing of it runs.`));
      if (v.tasks) out.next.push(doNext(`${v.name} still has ${v.tasks} background command${v.tasks > 1 ? "s" : ""} running; it may start another turn by itself when ${v.tasks > 1 ? "they end" : "it ends"}.`));
    }
    const still = views.filter((v) => ["working", "waiting", "starting"].includes(v.state));
    if (still.length) out.next.push(runNext("Wait for the workers still running.", ["routr", "wait", ...still.flatMap((v) => ["--name", v.name])]));
  } catch (e) { out.error = String(e?.message ?? e); out.headline = `routr: wait failed: ${out.error}`; }
  return answer(out);
}

// ---- send ------------------------------------------------------------------------------------------------------------
// A correction or follow-up for a worker launched with advice: into the running turn where the harness takes it, or as
// the next turn of the same session (a new holder resumes it). New work is a new launch with its own advice.
const SENT = { handed_to_harness: "written to the running worker's input (not yet proven read)", queued: "queued: it runs as the worker's next turn",
  prompted: "the worker resumed its session with it as the next turn" };
export async function sendCommand(args, { env = process.env, settings = () => loadConfig(), ready = notReady, spawn } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: [], next: [], state: "failed", name: null };
  try {
    const o = parseNamed(args, "send", ["name", "task", "task-file"]);
    if (o.names.length !== 1) throw new Error("send takes one --name");
    if ((o.task == null) === (o["task-file"] == null)) throw new Error("Use one of --task and --task-file");
    const name = out.name = o.names[0], w = readWorker(name);
    if (!w) throw new Error(`no headless worker named ${name}; routr workers lists them`);
    const text = o["task-file"] != null ? readTask(resolve(o["task-file"])) : o.task;
    if (!text?.trim()) throw new Error("The message must not be empty");
    const sandbox = sandboxOf(env);
    const loaded = settings(), config = loaded.config ?? loaded;
    out.warnings.push(...(loaded.notes ?? []));
    if (config.subscriptions[w.kind]?.enabled === false) throw new Error(OFF.launch(HARNESSES[w.kind].label, w.kind));
    const message = `${text.trim()}\n\n${CLOSING}`;
    let p = await probe(runDir(name)), r;
    const deliver = async (op) => { try { return await ask(name, p, op, { text: message }, op === "send" ? 5000 : 45000); } catch (e) { return { code: "unknown", why: e?.code ?? "no_answer" }; } };
    if (p.state === "alive") r = await deliver("send");
    if (p.state !== "alive" || (r?.code === "refused" && r.why === "ended")) {
      if (p.state === "unreachable" || p.state === "starting") throw new Error(`${name}'s process does not answer; run routr workers, and wait or stop it before sending`);
      if (groupAlive(readState(name)?.harness_pgid) && p.state !== "released") throw new Error(`${name}'s process ended without settling and its harness may still run; stop what runs before sending`);
      if (sandbox) throw new Error(SANDBOXED(sandbox));
      const signedOut = await ready(w.kind);
      if (signedOut) throw new Error(`${HARNESSES[w.kind].label} cannot take work: ${signedOut}`);
      if (!readState(name)?.session_id) throw new Error(`${name} has no session to resume; launch the work again`);
      // A holder that has just ended still answers for a moment: let it go first.
      for (let i = 0; i < 20 && p.state === "alive"; i++) { await sleep(150); p = await probe(runDir(name)); }
      p = await becomeHolder(name, { spawn });
      if (p.state !== "alive") throw new Error(`${name}: ${NOT_STARTED(p)}`);
      r = await deliver("send");
    }
    out.message = { code: r.code, ...(r.why ? { why: r.why } : {}) };
    if (!SENT[r.code]) { out.state = r.code === "unknown" ? "unknown" : "refused"; out.headline = `routr: ${name} did not take the message (${r.why ?? r.code})`;
      if (r.code === "unknown") out.next.push(doNext(`Whether ${name} got the message is not known; run routr workers before sending it again.`));
      return out; }
    out.ok = true; out.state = r.code === "prompted" ? "resumed" : r.code === "queued" ? "queued" : "delivered";
    out.headline = `routr: ${name}: ${SENT[r.code]}`;
    out.next.push(runNext("Wait for this worker's turn to end.", ["routr", "wait", "--name", name]));
  } catch (e) { out.error = String(e?.message ?? e); out.headline = `routr: send failed: ${out.error}`; }
  return answer(out);
}

// ---- workers ---------------------------------------------------------------------------------------------------------
export async function workersCommand(args) {
  const out = { ok: false, headline: "", unavailable: [], warnings: [], next: [], workers: [] };
  try {
    const o = parseNamed(args, "workers", ["name"]);
    for (const n of o.names.length ? o.names : names()) { const v = await view(n); if (v) out.workers.push((({ turns, ...rest }) => rest)(v)); else if (o.names.length) throw new Error(`no headless worker named ${n}`); }
    out.ok = true;
    out.headline = out.workers.length ? `routr: ${out.workers.map((v) => `${v.name} ${v.state}`).join(", ")}` : "routr: no headless workers";
  } catch (e) { out.error = String(e?.message ?? e); out.headline = `routr: workers failed: ${out.error}`; }
  return answer(out);
}

// ---- stop ------------------------------------------------------------------------------------------------------------
export async function stopCommand(args) {
  const out = { ok: false, headline: "", unavailable: [], warnings: [], next: [], state: "failed", name: null };
  try {
    const o = parseNamed(args, "stop", ["name"]);
    if (o.names.length !== 1) throw new Error("stop takes one --name");
    const name = out.name = o.names[0];
    if (!readWorker(name)) throw new Error(`no headless worker named ${name}; routr workers lists them`);
    const p = await probe(runDir(name));
    if (p.state === "alive") {
      let r; try { r = await ask(name, p, "stop", {}, 15000); } catch (e) { r = { code: "unknown" }; }
      out.ok = r.code === "stopped"; out.state = r.code === "stopped" ? "stopped" : r.code === "still_exiting" ? "still_exiting" : "unknown";
      out.headline = out.ok ? `routr: stopped ${name}` : `routr: ${name} was told to stop and has not finished exiting`;
      if (!out.ok) out.next.push(runNext("Look again in a moment.", ["routr", "workers", "--name", name]));
    } else if (["released", "none", "abandoned"].includes(p.state)) {
      out.ok = true; out.state = "absent"; out.headline = `routr: ${name} is not running`;
    } else {
      const pg = readState(name)?.harness_pgid;
      out.state = p.state === "dead" ? "lost" : "unreachable";
      out.headline = p.state === "dead" ? `routr: ${name}'s process is gone${groupAlive(pg) ? `, and its harness may still be running (process group ${pg})` : ""}` : `routr: ${name}'s process does not answer`;
      out.warnings.push("routr stops a worker only through its own process, never by a saved process id: it cannot see whether the harness is still running");
      out.next.push(doNext(groupAlive(pg) ? `Look at process group ${pg} (ps -g ${pg}) and stop it yourself if it is this worker's, then run routr cleanup --worker ${name}.` : `Run routr cleanup --worker ${name} once you are sure nothing of it runs.`));
    }
    if (out.ok) out.next.push(runNext("Remove its run folder and reports once you have what you need from them.", ["routr", "cleanup", "--worker", name]));
  } catch (e) { out.error = String(e?.message ?? e); out.headline = `routr: stop failed: ${out.error}`; }
  return answer(out);
}

// ---- cleanup --worker ------------------------------------------------------------------------------------------------
// Removes a headless worker's run folder (its reports with it) once nothing of it runs. Its git work, in --cwd, is the
// lead's to integrate: cleanup touches no repository here.
export async function cleanupWorker(name, { dryRun = false } = {}, out) {
  const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail });
  const refuse = (why, next) => { out.ok = false; out.state = "refused"; out.headline = `routr: kept ${name}: ${why}`; out.next.push(...[].concat(next)); step("refused", false, why); return out; };
  out.worker = name;
  const w = readWorker(name);
  if (!w) {
    if (existsSync(runDir(name))) return refuse("its folder is not one routr's launch wrote", doNext(`Look at ${runDir(name)} yourself.`));
    out.ok = true; out.state = "absent"; out.headline = `routr: nothing to remove: no worker ${name}`; return out;
  }
  const p = await probe(runDir(name));
  if (["alive", "starting"].includes(p.state)) return refuse(`${name} is still running`, [runNext("Wait for it to finish.", ["routr", "wait", "--name", name]), doNext(`Or stop it first: routr stop --name ${name}`)]);
  if (p.state === "unreachable") return refuse(`${name}'s process does not answer, so whether it runs is not known`, runNext("Look at it.", ["routr", "workers", "--name", name]));
  const pg = readState(name)?.harness_pgid;
  if (p.state === "dead" && groupAlive(pg)) return refuse(`${name}'s harness may still be running (process group ${pg})`, doNext(`Look at process group ${pg} and stop it if it is this worker's, then run cleanup again.`));
  if (dryRun) { out.ok = true; out.state = "planned"; out.headline = `routr: would remove ${runDir(name)}`; step("plan", true, `Would remove ${runDir(name)} and its reports`); return out; }
  for (const n of generations(runDir(name))) { try { removeEndpoint(w.id, JSON.parse(readFileSync(join(runDir(name), `gen-${n}.ready`), "utf8")).endpoint); } catch {} }
  rmSync(runDir(name), { recursive: true, force: true });
  step("remove", true, `Removed ${runDir(name)} and its reports`);
  out.ok = true; out.state = "removed"; out.headline = `routr: removed worker ${name}`;
  out.warnings.push(`${name} worked in ${w.cwd}: its changes there are yours to check and keep`);
  return out;
}
