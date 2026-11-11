// The headless backend: a worker run by its harness's own headless mode, under routr's holder (headless.mjs). Starting
// one, and its adapter for the worker module: what looking at one, sending to one, stopping one and finishing one do.
// Each talks to a worker's holder only through its channel (channel.mjs) and reads what the holder wrote; none stops a
// process by a saved id. The holder's replies and the channel's codes are classified here, into a closed list, and
// nothing else of them leaves. Answers carry report paths, never worker text.
import { warning } from "./warnings.mjs";
import { launchCarriers, currentLaunch } from "./traces.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, generations, MESSAGE_MAX, probe, removeEndpoint, socketPathFits, writeSecret } from "./channel.mjs";
import { groupAlive, HEADLESS_KINDS, headlessArgv } from "./headless.mjs";
import { newRecord, recordStore, unreadableWhy } from "./worker-record.mjs";
import { planWorktree } from "./worktree.mjs";
import { makePrivateConfig, refuseInputs, refuseSandbox, refuseSettings, refuseTaken, takeRun, worktreeRecord } from "./worker-start.mjs";
import { HARNESSES, savedAccount, subagentDefaults, workerAccount } from "./harnesses.mjs";
import { displayCommand, doNext, runNext } from "./next.mjs";
import { launchFailed } from "./launch-answer.mjs";
import { accountShownEnv, CARRIERS, carrierWithheld, FORWARDED, launchCarrierWarnings, savedCarriers } from "./worker-env.mjs";
import { readJsonFile } from "./state-files.mjs";
import { count } from "./wording.mjs";
import { spawnSelf } from "./processes.mjs";

export const RUNNING = new Set(["working", "waiting", "starting"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOO_BIG = `the message is over ${MESSAGE_MAX / 1024 / 1024} MB, more than a worker's channel takes; shorten it or point the worker at a file`;

const ago = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null; };
const size = (text) => Buffer.byteLength(JSON.stringify(text));
// What the holder wrote last (headless.mjs is its only writer), as readJsonFile reads it, from the run folder it was given.
const stateAt = (dir) => readJsonFile(join(dir, "state.json"));
// A refusal: its words, and what a person does next. The worker module carries both to the command's answer.
const refusal = (message, next = []) => Object.assign(new Error(message), { next });

// Why a holder did not come up, in routr's words (the holder records a fixed code when it cannot open its channel).
const NOT_STARTED = (p) => p.state === "unreadable" ? p.why : p.released?.why === "path_too_long" ? "the worker's socket path would be longer than this system allows (your home folder's path is too long); headless workers cannot run from this home"
  : p.released?.why === "channel_not_bound" ? "the worker's process could not open its channel"
  : p.state === "starting" ? "the worker's process is still starting and has not answered on its channel yet"
  : p.state === "unreachable" ? "the worker's process does not answer on its channel"
  : `the worker's process did not start (${p.state})`;
const PATH_TOO_LONG = NOT_STARTED({ released: { why: "path_too_long" } });

// The same, for a probe that could not read one of its holder's markers (channel.mjs's `unreadable`).
const markerWhy = (name, p) => unreadableWhy(name, p.unreadable.file, p.unreadable.code);
// Start the next holder of a worker (launch, or send to an idle one) and wait until its channel answers. Under the lock.
async function becomeHolder(store, name, { spawn = spawnSelf, timeoutMs = 15000, assertOwned = () => {} } = {}) {
  const dir = store.runDir(name), before = generations(dir).at(-1) ?? 0;
  assertOwned();
  if (!spawn(["workers", "--hold", name])) return { state: "not_started" };
  const until = Date.now() + timeoutMs;
  let p;
  // Alive, or a new generation that has already ended (it could not open its channel): either is the answer.
  while (Date.now() < until) { p = await probe(dir); if (p.gen > before && ["alive", "released"].includes(p.state)) return p; await sleep(150); }
  // A holder never starts over a worker file it cannot read: say that, not the last generation's state.
  const rec = store.read(name), st = stateAt(dir);
  if (rec.unreadable || st.unreadable) return { state: "unreadable", why: unreadableWhy(name, rec.unreadable ? "worker.json" : "state.json", rec.unreadable ?? st.unreadable) };
  return p ?? { state: "not_started" };
}
const ask = async (dir, p, op, extra = {}, ms = 5000) => {
  const c = await connect(dir, p.gen, p.ready.endpoint);
  try { return await c.request(op, extra, ms); } finally { c.close(); }
};

const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0]);

// ---- launch, outside herdr -----------------------------------------------------------------------------------------
// Called by launch once the arguments, task and advice are checked. Every refusal comes before anything is written or
// started; then it reserves the name, starts the holder and hands it the prompt over the channel, all within --timeout.
// `out` is launch's answer, filled in place. Its failures end here, as a pane's do, and it answers what the launch did.
export async function launchHeadless(o, out, ctx) {
  const submitted = () => out.steps.some((s) => s.step === "prompt");
  try { await startWorker(o, out, ctx); }
  catch (e) { launchFailed(out, e, submitted()); }
  if (submitted() && out.state !== "prompted") { out.warnings.push(warning("prompt_uncertain", "Prompt may have been submitted")); out.next.push(runNext("Look at the worker before retrying.", ["routr", "workers", "--name", out.name])); }
  return { attempted: out.steps.some((s) => s.step === "holder") || submitted(), submitted: submitted(), adopted: false, cleanup: out.worker ? ["routr", "cleanup", "--worker", o.name] : null };
}
async function startWorker(o, out, { prompt, env, settings, ready, spawn, checkListed = async () => {} }) {
  const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail });
  const defaults = { kind: o.kind, subagentModel: o["subagent-model"], subagentEffort: o["subagent-effort"] };
  const subagents = subagentDefaults(defaults);
  if (!HEADLESS_KINDS.includes(o.kind)) throw new Error(`outside herdr, routr launch starts ${andList(HEADLESS_KINDS.map((k) => HARNESSES[k].label))} workers only; run the lead inside herdr for a ${HARNESSES[o.kind].label} worker`);
  refuseInputs(o, prompt, { where: "outside herdr", runs: "runs headless" });
  if (size(prompt) > MESSAGE_MAX) throw new Error(TOO_BIG);
  refuseSandbox(env);
  refuseTaken(o.name);
  if (!socketPathFits()) throw new Error(PATH_TOO_LONG);
  const plannedTree = o.worktree ? await planWorktree(o, out.cwd) : null;
  const config = await refuseSettings(o, out, { settings, ready, checkListed });
  const until = Date.now() + o.timeout, left = () => Math.max(1000, until - Date.now());
  // Checked now, so a flag the harness would refuse is refused before anything is written; shown once the worker's
  // folder is known (Antigravity's --add-dir names it).
  headlessArgv({ ...defaults, model: o.model, effort: o.effort, cwd: plannedTree?.path ?? out.cwd });
  // What this launch wrote, and nothing started: removed again if launch stops before a holder answers.
  const { dir, wt, unreserve } = await takeRun(o, out, plannedTree);
  try {
    const argv = headlessArgv({ ...defaults, model: o.model, effort: o.effort, cwd: out.cwd });
    // The trace-context carriers in launch's environment, within routr's limits, are saved with the worker: every turn
    // gets these, whoever starts its holder later (a `send` from another environment). Shown by name only;
    // CURSOR_CONFIG_DIR, the run folder's, is not listed.
    // An extra account is saved with the worker too (savedAccount), and its variable shown: every turn runs on it.
    const found = launchCarriers(env), launchTrace = currentLaunch(config, env);
    out.warnings.push(...launchCarrierWarnings(found));
    out.start = { executable: HARNESSES[o.kind].executable, argv, env: { ...accountShownEnv(o.account?.env), ...subagents.env, ...Object.fromEntries(Object.keys(found.carriers).map((k) => [k, FORWARDED])) } };
    out.ran.push(displayCommand([HARNESSES[o.kind].executable, ...argv]));
    recordStore().write(dir, newRecord({ name: o.name, kind: o.kind, model: o.model, effort: o.effort, cwd: out.cwd, carriers: found.carriers, ...savedAccount(o.account),
      subagent_model: o["subagent-model"] || null, subagent_effort: o["subagent-effort"] || null, launch: launchTrace, worktree: worktreeRecord(wt).worktree }, { backend: "headless" }));
    writeSecret(dir);
    makePrivateConfig(o.kind, dir);
  } catch (e) { await unreserve(); throw e; }
  out.worker = { name: o.name, backend: "headless", run: dir, session: null };
  step("reserve", true, `Made ${dir} for ${o.name}`);
  const store = recordStore(), p = await store.lock(o.name, (assertOwned) => becomeHolder(store, o.name, { spawn, timeoutMs: Math.min(15000, left()), assertOwned }));
  if (p.state !== "alive") {
    if (!["starting", "unreachable"].includes(p.state)) await unreserve();
    else out.next.push(runNext("Look at the worker before launching it again.", ["routr", "workers", "--name", o.name]));
    throw new Error(NOT_STARTED(p));
  }
  step("holder", true, `The worker's process answers on its channel (generation ${p.gen})`);
  let r;
  // Never less than the holder's own 30 seconds for Claude to name its session, whatever --timeout leaves.
  try { r = await ask(dir, p, "start", { text: prompt }, Math.max(35000, Math.min(45000, left()))); } catch (e) { r = { code: "unknown", why: e?.code ?? "no_answer" }; }
  out.prompt_chars = prompt.length;
  if (r.code === "prompted") {
    out.worker.session = r.session ?? null;
    step("prompt", true, r.session ? `${HARNESSES[o.kind].label} started the task's turn (session ${r.session})` : `The task was written to ${HARNESSES[o.kind].label}'s input; it has not named its session yet`);
    out.ok = true; out.state = "prompted";
    out.next.push(runNext("Wait for this worker's turn to end (it returns earlier when any worker you wait on finishes); then read its report.", ["routr", "wait", "--name", o.name]));
    return;
  }
  step("prompt", false, `The worker did not start its task (${r.why ?? r.code})`);
  throw new Error(r.code === "unknown" && r.why === "not_started_in_time" ? `${HARNESSES[o.kind].label} had not started the task's turn after 30 seconds, and whether it will is not known; run routr workers before launching it again`
    : r.code === "unknown" ? "the task was handed to the worker's process, which did not answer; run routr workers before launching it again"
    : r.why === "harness_refused" ? `${HARNESSES[o.kind].label} refused the task (${r.why})` : `${HARNESSES[o.kind].label} ended before it started the task (${r.why ?? r.code})`);
}

// ---- the adapter: what the worker commands do to a headless worker --------------------------------------------------
// Each operation takes `me`, the worker as the worker module found it: { name, dir, record, unreadable, still, damaged },
// and `ctx`, what the commands gave the module: { env, ready, spawn, store }. `record` is null only where `unreadable` is set.

// The holder's replies to a message, and the codes its channel fails with: a closed list. Anything else is one fixed
// code, so no text from outside reaches an answer.
const OTHER = "unrecognised";
const SEND_CODES = new Set(["handed_to_harness", "accepted", "queued", "prompted", "refused", "unknown", "failed"]);
const SEND_WHYS = new Set([
  // the holder's own (headless.mjs)
  "empty", "ended", "harness_ended", "harness_not_started", "harness_refused", "next_turn", "no_reply", "no_session", "not_started",
  "not_started_in_time", "not_written", "queue_full", "state_not_written", "stopping", "task_not_written", "unknown_op",
  // no answer at all, and the channel's (channel.mjs) and the system's socket codes
  "no_answer", "bad_hello", "bad_request", "client_refused", "failed", "frame_too_large", "frame_unreadable", "handshake_timeout", "no_secret",
  "not_private", "path_too_long", "proto_mismatch", "refused", "server_unproven", "unproven",
  "EACCES", "ECLOSED", "ECONNREFUSED", "ECONNRESET", "ENAMETOOLONG", "ENOENT", "ENOTSOCK", "EPERM", "EPIPE", "ETIMEDOUT"]);
const closed = (set, v) => (v == null ? undefined : set.has(v) ? v : OTHER);
// A reply as routr can say it: its code and reason from the lists above, and nothing else of it.
export const sentCode = (r) => { const code = closed(SEND_CODES, r?.code) ?? OTHER, why = closed(SEND_WHYS, r?.why); return { code, ...(why ? { why } : {}) }; };
const SENT = { handed_to_harness: () => "written to the running worker's input (not yet proven read)",
  accepted: () => "taken by the running worker (into its running turn, or as its next)",
  queued: (label, why) => (why === "next_turn" ? "queued: it runs as the worker's next turn, once the running one ends" : `queued: it runs as the worker's next turn, in a new ${label} process on the same session`),
  prompted: () => "the worker resumed its session with it as the next turn" };
// What a send said, for the command to answer: { state, ok, message, said, next }.
export function sentAs(name, kind, reply) {
  const message = sentCode(reply), { code, why } = message;
  if (SENT[code]) return { state: code === "prompted" ? "resumed" : code === "queued" ? "queued" : "delivered", ok: true, message,
    said: `${name}: ${SENT[code](HARNESSES[kind]?.label ?? kind, why)}`, next: [runNext("Wait for this worker's turn to end.", ["routr", "wait", "--name", name])] };
  if (code === "unknown") return { state: "unknown", ok: false, message, said: `whether ${name} took the message is not known (${why ?? "no_answer"})`,
    next: [runNext(`Whether ${name} got the message is not known: look at it before sending it again.`, ["routr", "workers", "--name", name])] };
  return { state: "refused", ok: false, message, said: `${name} did not take the message (${why ?? code})`, next: [] };
}

// What a stop found, said: { state, ok, said, warnings, next }. `p` is the probe; `read`, what its state file says (an
// unreadable record is read as unreadable too); `left`, whether the harness's recorded group still has members; `reply`,
// what a holder that answered said to being asked to stop.
export function stoppedAs(me, { p, read, pgid, left, reply }) {
  const { name } = me, warnings = [], next = [];
  if (read.unreadable) return { state: "unknown", ok: false, said: unreadableWhy(name, me.unreadable ? "worker.json" : "state.json", read.unreadable), warnings, next: me.damaged() };
  if (p.state === "alive") {
    const code = reply?.code, ok = code === "stopped";
    if (!ok) next.push(runNext("Look again in a moment.", ["routr", "workers", "--name", name]));
    // Messages it had queued and never sent: dropped by the stop. The lead sends them again if they still apply.
    const dropped = reply?.dropped;
    if (Number.isInteger(dropped) && dropped > 0) warnings.push(warning("messages_dropped", `${count(dropped, "queued message")} ${dropped === 1 ? "was" : "were"} dropped by the stop and never reached ${name}: send ${dropped === 1 ? "it" : "them"} again with routr send if ${dropped === 1 ? "it still applies" : "they still apply"}`));
    return { state: ["stopped", "still_exiting"].includes(code) ? code : "unknown", ok, said: ok ? `stopped ${name}` : `${name} was told to stop and has not finished exiting`, warnings, next };
  }
  if (["released", "none", "abandoned"].includes(p.state) && !left) return { state: "absent", ok: true, said: `${name} is not running`, warnings, next };
  if (p.unreadable) next.push(...me.damaged());
  const said = p.unreadable ? markerWhy(name, p) : p.state === "unreachable" ? `${name}'s process does not answer`
    : `${name}'s process is gone${left ? `, and its harness may still be running (process group ${pgid})` : ""}`;
  warnings.push(warning("process_unseen", "routr stops a worker only through its own process, never by a saved process id: it cannot see whether the harness is still running"));
  next.push(doNext(left ? `Look at process group ${pgid} (${lookAt(pgid)}) and stop it yourself if it is this worker's, then clean the worker up.` : "Clean the worker up once you are sure nothing of it runs."));
  return { state: p.state === "unreachable" ? "unreachable" : "lost", ok: false, said, warnings, next };
}
// A process group's members with their command lines, on this system (pgrep's -a lists ancestors on macOS).
export const lookAt = (pg) => (process.platform === "darwin" ? `pgrep -lf -g ${pg}` : `pgrep -a -g ${pg}`);

export const headless = {
  // A run folder a holder has claimed a generation in: what decides where a worker whose record cannot be read runs.
  owns: (dir) => generations(dir).length > 0,
  follows: () => null,

  // What one worker looks like to a lead: its state from the holder, checked against whether the holder still answers.
  // `lost`: the holder said a turn was running and no longer answers. `harness_group`: a process group it recorded that
  // still has members (a killed holder's Claude, or a tool command that outlived it).
  async look(me, { check = true } = {}) {
    const { name, dir, record: w } = me;
    // The channel first, then the state: a holder that ends between the two has written its last state by the time
    // its generation reads released.
    // The channel says something about the state only when both are of one generation: read again when they are not (a
    // holder ended and the next began in between), and when they never agree, take neither as lost or unreachable.
    // A state it could not read is shown as `unreadable`, never as one not written yet (`starting`).
    let channel = null, unread = false;
    const load = () => { const r = stateAt(dir); unread = Boolean(r.unreadable); return r.value ?? {}; };
    let st = load();
    for (let i = 0; i < 3 && check; i++) {
      const p = await probe(dir);
      st = load();
      if (p.gen === (st.gen ?? 0)) { channel = p.state; break; }
    }
    let state = unread ? "unreadable" : st.state ?? "starting";
    if (RUNNING.has(state) && ["dead", "abandoned"].includes(channel)) state = "lost";
    if (channel === "unreachable") state = "unreachable";
    const reported = (st.turns ?? []).filter((t) => t.report).at(-1);
    // The carriers the holder withheld from its harness (its worker.json changed since launch), by name only.
    const withheld = Array.isArray(st.carriers_withheld) ? CARRIERS.filter((n) => st.carriers_withheld.includes(n)) : [];
    return { next: [], view: { name, kind: w.kind, model: w.model, effort: w.effort ?? null, cwd: w.cwd, state, gen: st.gen ?? 0, turn: st.turn ?? 0,
      seconds_since_event: ago(st.last_event_at ?? st.updated_at), last_tool: st.last_tool ?? null, tasks: st.tasks ?? 0, queued: st.queued ?? 0,
      session: st.session_id ?? null, report: reported?.report ?? null, ...(withheld.length ? { carriers_withheld: withheld } : {}), ...(!RUNNING.has(state) && await groupAlive(st.harness_pgid, w.kind) ? { harness_group: st.harness_pgid } : {}),
      turns: (st.turns ?? []).map((t) => ({ turn: t.turn, outcome: t.outcome ?? "running", report: t.report ?? null, delivered: t.delivered ?? 0 })) } };
  },
  // Whether a wait with no names watches it: running, or with a finished turn past `reported`. One whose state cannot be
  // read just now is watched: it may be running.
  pending(me, reported) { const r = stateAt(me.dir), s = r.value; return Boolean(r.unreadable || (s && (RUNNING.has(s.state) || (s.turns ?? []).some((t) => t.turn > reported && t.outcome)))); },

  // A holder this send starts gives its harness the carriers saved with the worker, checked again: any withheld is said.
  beforeSend: (me) => savedCarriers(me.record.carriers).withheld.map(carrierWithheld),
  limit: (message) => (size(message) > MESSAGE_MAX ? TOO_BIG : null),
  // A correction or follow-up into a worker: into the running turn where the harness takes it, or as the next turn of the
  // same session (a new holder resumes it). What stops it is thrown, with what to do next.
  async send(me, message, { env, ready, spawn, store }) {
    const { name, dir, record: w } = me;
    // The worker it was asked for, by its run id: one cleaned up and launched again under that name meanwhile is not it.
    // Still the worker it was asked for: "replaced" only when its record says so; one it cannot read is said as that.
    const same = () => { const r = me.still(); if (r.unreadable) throw refusal(unreadableWhy(name, "worker.json", r.unreadable), me.damaged()); return r === "same"; };
    let p = await probe(dir), r;
    const hand = async (op, ms) => {
      if (!same()) throw refusal(`${name} was cleaned up and launched again meanwhile; nothing was sent`);
      try { return await ask(dir, p, op, { text: message }, ms); } catch (e) { return { code: "unknown", why: e?.code ?? "no_answer" }; }
    };
    // A running worker answers at once, or within the 30 s its harness may take to start the task's turn (Codex).
    if (p.state === "alive") r = await hand("send", 45000);
    if (p.state !== "alive" || (r?.code === "refused" && r.why === "ended")) {
      // A new holder: everything a launch checks before it starts one.
      if (p.unreadable) throw refusal(markerWhy(name, p), me.damaged());
      if (["unreachable", "starting"].includes(p.state)) throw refusal(`${name}'s process does not answer; run routr workers, and wait or stop it before sending`);
      // Its session and process group come from its state: one that cannot be read is neither "no session" nor "no group".
      const read = stateAt(dir);
      if (read.unreadable) throw refusal(unreadableWhy(name, "state.json", read.unreadable), me.damaged());
      const st = read.value ?? {};
      if (await groupAlive(st.harness_pgid, w.kind)) throw refusal(`${name}'s harness may still be running (process group ${st.harness_pgid}); stop what runs of it before sending`);
      refuseSandbox(env);
      if (!st.session_id) throw refusal(`${name} has no session to resume; launch the work again`);
      const signedOut = await ready(workerAccount(w) ?? w.kind);
      if (signedOut) throw refusal(`${HARNESSES[w.kind].label} cannot take work: ${signedOut}`);
      // A holder that has just ended still answers for a moment: let it go first.
      for (let i = 0; i < 20 && p.state === "alive"; i++) { await sleep(150); p = await probe(dir); }
      p = await store.lock(name, async (assertOwned) => {
        const r = me.still();
        if (r.unreadable) return { state: "unreadable", why: unreadableWhy(name, "worker.json", r.unreadable) };
        if (r !== "same") return { state: "replaced" };
        return becomeHolder(store, name, { spawn, assertOwned });
      });
      if (p.state === "replaced") throw refusal(`${name} was cleaned up and launched again meanwhile; nothing was sent`);
      if (p.state === "unreadable" || p.unreadable) throw refusal(p.unreadable ? markerWhy(name, p) : p.why, me.damaged());
      if (p.state !== "alive") throw refusal(`${name}: ${NOT_STARTED(p)}`);
      r = await hand("send", 45000);
    }
    return sentAs(name, w.kind, r);
  },

  // What a stop finds, and, for a holder that answers, what it said to being asked. A running holder is asked to stop
  // whatever its files say. Otherwise, with its record unreadable, what its harness is, and so what of it runs, is not
  // known either. Whether its harness's group still runs is in its state: one that cannot be read leaves that unknown.
  async stop(me) {
    const p = await probe(me.dir);
    const read = p.state === "alive" ? { value: {} } : me.unreadable ? { unreadable: me.unreadable } : stateAt(me.dir), pgid = read.value?.harness_pgid;
    const left = p.state === "alive" || read.unreadable ? false : await groupAlive(pgid, me.record.kind);
    let reply;
    if (!read.unreadable && p.state === "alive") try { reply = await ask(me.dir, p, "stop", {}, 15000); } catch { reply = { code: "unknown" }; }
    return stoppedAs(me, { p, read, pgid, left, reply });
  },

  // Why it cannot be finished yet: its holder, its state or a process group it recorded. Null when nothing of it runs.
  async end(me) {
    const { name, dir, record: w } = me, held = (why, next) => ({ why, next });
    const p = await probe(dir);
    if (["alive", "starting"].includes(p.state)) return held(`${name} is still running`, [runNext("Wait for it to finish.", ["routr", "wait", "--name", name]), runNext("Or stop it first.", ["routr", "stop", "--name", name])]);
    if (p.unreadable) return held(markerWhy(name, p), me.damaged());
    if (p.state === "unreachable") return held(`${name}'s process does not answer, so whether it runs is not known`, runNext("Look at it.", ["routr", "workers", "--name", name]));
    const read = stateAt(dir);
    if (read.unreadable) return held(unreadableWhy(name, "state.json", read.unreadable), me.damaged());
    const pg = read.value?.harness_pgid;
    if (await groupAlive(pg, w.kind)) return held(`${name}'s harness may still be running (process group ${pg})`, doNext(`Look at process group ${pg} and stop it if it is this worker's, then run cleanup again.`));
    return null;
  },
  // Its channel's endpoints, each one this run made, before its folder goes.
  release(me, assertOwned) {
    for (const n of generations(me.dir)) { assertOwned(); try { removeEndpoint(me.record.id, JSON.parse(readFileSync(join(me.dir, `gen-${n}.ready`), "utf8")).endpoint); } catch {} }
  },
};
