// The headless backend: a worker run by its harness's own headless mode, under routr's holder (headless.mjs). Starting
// one, and what the worker commands do to one: `view`, `deliver`, `stopWorker` and `cleanupWorker`. Each talks to a
// worker's holder only through its channel (channel.mjs) and reads what the holder wrote; none stops a process by a saved
// id. Answers carry report paths, never worker text.
import { warning } from "./warnings.mjs";
import { launchCarriers, launchCarrierWarnings, currentLaunch } from "./traces.mjs";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, generations, MESSAGE_MAX, probe, removeEndpoint, socketPathFits, writeSecret } from "./channel.mjs";
import { groupAlive, HEADLESS_KINDS, headlessArgv, stateOf } from "./headless.mjs";
import { FORMAT, readWorker, runDir, unreadableWhy, WORKERS_DIR, workerOf } from "./worker-record.mjs";
import { git, planWorktree } from "./worktree.mjs";
import { privateCursorConfig, refuseInputs, refuseSandbox, refuseSettings, refuseTaken, sandboxOf, takeRun, worktreeRecord } from "./worker-start.mjs";
import { HARNESSES, subagentDefaults } from "./harnesses.mjs";
import { displayCommand, doNext, runNext } from "./next.mjs";
import { launchFailed } from "./launch-answer.mjs";
import { inCore, presentWorker } from "./presenter-watch.mjs";
import { CARRIERS, FORWARDED, folderId, lockIsStale, lockOwned, lockToken, realOr, releaseFileLock, spawnSelf, takeLock, writeJsonAtomic } from "./runtime.mjs";

export const RUNNING = new Set(["working", "waiting", "starting"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sandboxOf };
export const TOO_BIG = `the message is over ${MESSAGE_MAX / 1024 / 1024} MB, more than a worker's channel takes; shorten it or point the worker at a file`;

const ago = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null; };
export const size = (text) => Buffer.byteLength(JSON.stringify(text));

// Why a holder did not come up, in routr's words (the holder records a fixed code when it cannot open its channel).
const NOT_STARTED = (p) => p.state === "unreadable" ? p.why : p.released?.why === "path_too_long" ? "the worker's socket path would be longer than this system allows (your home folder's path is too long); headless workers cannot run from this home"
  : p.released?.why === "channel_not_bound" ? "the worker's process could not open its channel"
  : p.state === "starting" ? "the worker's process is still starting and has not answered on its channel yet"
  : p.state === "unreachable" ? "the worker's process does not answer on its channel"
  : `the worker's process did not start (${p.state})`;
const PATH_TOO_LONG = NOT_STARTED({ released: { why: "path_too_long" } });

// Starting a holder and removing a run folder go through one lock per worker, so cleanup can never delete a folder
// a send is starting a new holder in. Taken over only when its taker has gone (runtime's lock).
async function locked(name, fn) {
  const file = join(WORKERS_DIR(), `${name}.lock`);
  let took = false;
  for (let i = 0; i < 50 && !(took = takeLock(file, lockIsStale)); i++) await sleep(100);
  const token = lockToken(file);
  // Checks await channels and git. A lock at entry is insufficient: fence the action with this token too.
  const assertOwned = () => { if (!took || !lockOwned(file, token)) throw new Error(`the worker lock for ${name} is held by another routr command; run it again in a moment`); };
  try { assertOwned(); return await fn(assertOwned); } finally { if (took) releaseFileLock(file, token); }
}
// A worker file that stays unreadable (its permissions, or damage), and routr acts on none of the worker: what a person does then.
export const damagedNext = (name, w = null) => [runNext("Look again in a moment.", ["routr", "workers", "--name", name]),
  doNext(`If it stays unreadable, routr will not act on ${name}: check the file's permissions, or whether it is damaged; then make sure nothing of it still runs${w?.worktree ? `, finish its worktree with ${displayCommand(["routr", "cleanup", "--cwd", w.worktree.source, "--path", w.worktree.path])}` : ""}, keep what you need from ${runDir(name)}, then remove that folder yourself.`)];
// The same, for a probe that could not read one of its holder's markers (channel.mjs's `unreadable`).
export const markerWhy = (name, p) => unreadableWhy(name, p.unreadable.file, p.unreadable.code);
// Start the next holder of a worker (launch, or send to an idle one) and wait until its channel answers. Under the lock.
async function becomeHolder(name, { spawn = spawnSelf, timeoutMs = 15000, assertOwned = () => {} } = {}) {
  const before = generations(runDir(name)).at(-1) ?? 0;
  assertOwned();
  if (!spawn(["workers", "--hold", name])) return { state: "not_started" };
  const until = Date.now() + timeoutMs;
  let p;
  // Alive, or a new generation that has already ended (it could not open its channel): either is the answer.
  while (Date.now() < until) { p = await probe(runDir(name)); if (p.gen > before && ["alive", "released"].includes(p.state)) return p; await sleep(150); }
  // A holder never starts over a worker file it cannot read: say that, not the last generation's state.
  const rec = workerOf(name), st = stateOf(name);
  if (rec.unreadable || st.unreadable) return { state: "unreadable", why: unreadableWhy(name, rec.unreadable ? "worker.json" : "state.json", rec.unreadable ?? st.unreadable) };
  return p ?? { state: "not_started" };
}
const ask = async (name, p, op, extra = {}, ms = 5000) => {
  const c = await connect(runDir(name), p.gen, p.ready.endpoint);
  try { return await c.request(op, extra, ms); } finally { c.close(); }
};

// What one worker looks like to a lead: its state from the holder, checked against whether the holder still answers.
// `lost`: the holder said a turn was running and no longer answers. `harness_group`: a process group it recorded that
// still has members (a killed holder's Claude, or a tool command that outlived it).
export async function view(name, { check = true } = {}) {
  const rec = workerOf(name), w = rec.worker;
  // A record it cannot read is shown, as `unreadable`, with nothing it would have said: never left out as no worker.
  if (rec.unreadable) return { name, kind: null, model: null, effort: null, cwd: null, state: "unreadable", gen: 0, turn: 0, seconds_since_event: null,
    last_tool: null, tasks: 0, queued: 0, session: null, report: null, turns: [] };
  if (!w) return null;
  // The channel first, then the state: a holder that ends between the two has written its last state by the time
  // its generation reads released.
  // The channel says something about the state only when both are of one generation: read again when they are not (a
  // holder ended and the next began in between), and when they never agree, take neither as lost or unreachable.
  // A state it could not read is shown as `unreadable`, never as one not written yet (`starting`).
  let channel = null, unread = false;
  const load = () => { const r = stateOf(name); unread = Boolean(r.unreadable); return r.value ?? {}; };
  let st = load();
  for (let i = 0; i < 3 && check; i++) {
    const p = await probe(runDir(name));
    st = load();
    if (p.gen === (st.gen ?? 0)) { channel = p.state; break; }
  }
  let state = unread ? "unreadable" : st.state ?? "starting";
  if (RUNNING.has(state) && ["dead", "abandoned"].includes(channel)) state = "lost";
  if (channel === "unreachable") state = "unreachable";
  const reported = (st.turns ?? []).filter((t) => t.report).at(-1);
  // The carriers the holder withheld from its harness (its worker.json changed since launch), by name only.
  const withheld = Array.isArray(st.carriers_withheld) ? CARRIERS.filter((n) => st.carriers_withheld.includes(n)) : [];
  return { name, kind: w.kind, model: w.model, effort: w.effort ?? null, cwd: w.cwd, state, gen: st.gen ?? 0, turn: st.turn ?? 0,
    seconds_since_event: ago(st.last_event_at ?? st.updated_at), last_tool: st.last_tool ?? null, tasks: st.tasks ?? 0, queued: st.queued ?? 0,
    session: st.session_id ?? null, report: reported?.report ?? null, ...(withheld.length ? { carriers_withheld: withheld } : {}), ...(!RUNNING.has(state) && await groupAlive(st.harness_pgid, w.kind) ? { harness_group: st.harness_pgid } : {}),
    turns: (st.turns ?? []).map((t) => ({ turn: t.turn, outcome: t.outcome ?? "running", report: t.report ?? null, delivered: t.delivered ?? 0 })) };
}

// Whether a wait with no names watches this worker: running, or with a finished turn past `reported`. One whose state
// cannot be read just now is watched: it may be running.
export const worthWatching = (name, reported) => { const r = stateOf(name), s = r.value; return r.unreadable || workerOf(name).unreadable || (s && (RUNNING.has(s.state) || (s.turns ?? []).some((t) => t.turn > reported && t.outcome))); };

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
    const found = launchCarriers(env), launchTrace = currentLaunch(config, env);
    out.warnings.push(...launchCarrierWarnings(found));
    out.start = { executable: HARNESSES[o.kind].executable, argv, env: { ...subagents.env, ...Object.fromEntries(Object.keys(found.carriers).map((k) => [k, FORWARDED])) } };
    out.ran.push(displayCommand([HARNESSES[o.kind].executable, ...argv]));
    const w = { format: FORMAT, id: randomUUID().replace(/-/g, ""), name: o.name, kind: o.kind, model: o.model, effort: o.effort ?? null, cwd: out.cwd, created_at: new Date().toISOString(), carriers: found.carriers,
      ...(o["subagent-model"] ? { subagent_model: o["subagent-model"] } : {}), ...(o["subagent-effort"] ? { subagent_effort: o["subagent-effort"] } : {}),
      ...(launchTrace ? { launch: launchTrace } : {}),
      ...worktreeRecord(wt) };
    writeJsonAtomic(join(dir, "worker.json"), w, { mkdir: false, mode: 0o600 }); // whole: a reader never sees it half written
    writeSecret(dir);
    if (o.kind === "cursor") privateCursorConfig(dir);
  } catch (e) { await unreserve(); throw e; }
  out.worker = { name: o.name, backend: "headless", run: dir, session: null };
  step("reserve", true, `Made ${dir} for ${o.name}`);
  const p = await locked(o.name, (assertOwned) => becomeHolder(o.name, { spawn, timeoutMs: Math.min(15000, left()), assertOwned }));
  if (p.state !== "alive") {
    if (!["starting", "unreachable"].includes(p.state)) await unreserve();
    else out.next.push(runNext("Look at the worker before launching it again.", ["routr", "workers", "--name", o.name]));
    throw new Error(NOT_STARTED(p));
  }
  step("holder", true, `The worker's process answers on its channel (generation ${p.gen})`);
  let r;
  // Never less than the holder's own 30 seconds for Claude to name its session, whatever --timeout leaves.
  try { r = await ask(o.name, p, "start", { text: prompt }, Math.max(35000, Math.min(45000, left()))); } catch (e) { r = { code: "unknown", why: e?.code ?? "no_answer" }; }
  out.prompt_chars = prompt.length;
  if (r.code === "prompted") {
    out.worker.session = r.session ?? null;
    step("prompt", true, r.session ? `${HARNESSES[o.kind].label} started the task's turn (session ${r.session})` : `The task was written to ${HARNESSES[o.kind].label}'s input; it has not named its session yet`);
    out.ok = true; out.state = "prompted";
    if (inCore(env)) await presentWorker({ name: o.name, id: readWorker(o.name)?.id ?? randomUUID().replace(/-/g, ""), cwd: out.cwd, env, out });
    out.next.push(runNext("Wait for this worker's turn to end (it returns earlier when any worker you wait on finishes); then read its report.", ["routr", "wait", "--name", o.name]));
    return;
  }
  step("prompt", false, `The worker did not start its task (${r.why ?? r.code})`);
  throw new Error(r.code === "unknown" && r.why === "not_started_in_time" ? `${HARNESSES[o.kind].label} had not started the task's turn after 30 seconds, and whether it will is not known; run routr workers before launching it again`
    : r.code === "unknown" ? "the task was handed to the worker's process, which did not answer; run routr workers before launching it again"
    : r.why === "harness_refused" ? `${HARNESSES[o.kind].label} refused the task (${r.why})` : `${HARNESSES[o.kind].label} ended before it started the task (${r.why ?? r.code})`);
}

// A correction or follow-up into a worker: into the running turn where the harness takes it, or as the next turn of the
// same session (a new holder resumes it). Answers the holder's reply; what stops it is thrown, with `out.next` saying what
// to do next.
export async function deliver(name, w, message, { out, env, ready, spawn }) {
  // The worker it was asked for, by its run id: one cleaned up and launched again under that name meanwhile is not it.
  // Still the worker it was asked for: "replaced" only when its record says so; one it cannot read is said as that.
  const identity = () => { const r = workerOf(name); return r.unreadable ? { unreadable: r.unreadable } : { same: r.worker?.id === w.id }; };
  const same = () => { const r = identity(); if (r.unreadable) { out.next.push(...damagedNext(name, w)); throw new Error(unreadableWhy(name, "worker.json", r.unreadable)); } return r.same; };
  let p = await probe(runDir(name)), r;
  const hand = async (op, ms) => {
    if (!same()) throw new Error(`${name} was cleaned up and launched again meanwhile; nothing was sent`);
    try { return await ask(name, p, op, { text: message }, ms); } catch (e) { return { code: "unknown", why: e?.code ?? "no_answer" }; }
  };
  // A running worker answers at once, or within the 30 s its harness may take to start the task's turn (Codex).
  if (p.state === "alive") r = await hand("send", 45000);
  if (p.state !== "alive" || (r?.code === "refused" && r.why === "ended")) {
    // A new holder: everything a launch checks before it starts one.
    if (p.unreadable) { out.next.push(...damagedNext(name, w)); throw new Error(markerWhy(name, p)); }
    if (["unreachable", "starting"].includes(p.state)) throw new Error(`${name}'s process does not answer; run routr workers, and wait or stop it before sending`);
    // Its session and process group come from its state: one that cannot be read is neither "no session" nor "no group".
    const read = stateOf(name);
    if (read.unreadable) { out.next.push(...damagedNext(name, w)); throw new Error(unreadableWhy(name, "state.json", read.unreadable)); }
    const st = read.value ?? {};
    if (await groupAlive(st.harness_pgid, w.kind)) throw new Error(`${name}'s harness may still be running (process group ${st.harness_pgid}); stop what runs of it before sending`);
    refuseSandbox(env);
    if (!st.session_id) throw new Error(`${name} has no session to resume; launch the work again`);
    const signedOut = await ready(w.kind);
    if (signedOut) throw new Error(`${HARNESSES[w.kind].label} cannot take work: ${signedOut}`);
    // A holder that has just ended still answers for a moment: let it go first.
    for (let i = 0; i < 20 && p.state === "alive"; i++) { await sleep(150); p = await probe(runDir(name)); }
    p = await locked(name, async (assertOwned) => {
      const r = identity();
      if (r.unreadable) return { state: "unreadable", why: unreadableWhy(name, "worker.json", r.unreadable) };
      if (!r.same) return { state: "replaced" };
      return becomeHolder(name, { spawn, assertOwned });
    });
    if (p.state === "replaced") throw new Error(`${name} was cleaned up and launched again meanwhile; nothing was sent`);
    if (p.state === "unreadable" || p.unreadable) { out.next.push(...damagedNext(name, w)); throw new Error(p.unreadable ? markerWhy(name, p) : p.why); }
    if (p.state !== "alive") throw new Error(`${name}: ${NOT_STARTED(p)}`);
    r = await hand("send", 45000);
  }
  return r;
}

// What a stop finds, and, for a holder that answers, what it said to being asked: `channel`, the holder's; `read`, what its
// files say; `pgid`, the harness's process group they recorded; `left`, whether that group still has anything of it. A
// running holder is asked to stop whatever its files say. Otherwise, with its record unreadable, what its harness is, and
// so what of it runs, is not known either. Whether its harness's group still runs is in its state: one that cannot be
// read leaves that unknown.
export async function stopWorker(name, rec) {
  const p = await probe(runDir(name));
  const read = p.state === "alive" ? { value: {} } : rec.unreadable ? rec : stateOf(name), pgid = read.value?.harness_pgid;
  const left = p.state === "alive" || read.unreadable ? false : await groupAlive(pgid, rec.worker.kind);
  if (read.unreadable || p.state !== "alive") return { channel: p, read, pgid, left };
  let reply; try { reply = await ask(name, p, "stop", {}, 15000); } catch { reply = { code: "unknown" }; }
  return { channel: p, read, pgid, left, reply };
}

// ---- cleanup --worker ------------------------------------------------------------------------------------------------
// Why a headless worker cannot be removed yet: its holder, its state or a process group it recorded. Null when nothing of it runs.
async function holderLeft(name, w) {
  const held = (why, next) => ({ why, next });
  const p = await probe(runDir(name));
  if (["alive", "starting"].includes(p.state)) return held(`${name} is still running`, [runNext("Wait for it to finish.", ["routr", "wait", "--name", name]), runNext("Or stop it first.", ["routr", "stop", "--name", name])]);
  if (p.unreadable) return held(markerWhy(name, p), damagedNext(name, w));
  if (p.state === "unreachable") return held(`${name}'s process does not answer, so whether it runs is not known`, runNext("Look at it.", ["routr", "workers", "--name", name]));
  const read = stateOf(name);
  if (read.unreadable) return held(unreadableWhy(name, "state.json", read.unreadable), damagedNext(name, w));
  const pg = read.value?.harness_pgid;
  if (await groupAlive(pg, w.kind)) return held(`${name}'s harness may still be running (process group ${pg})`, doNext(`Look at process group ${pg} and stop it if it is this worker's, then run cleanup again.`));
  return null;
}
// Removes a headless worker's run folder (its reports with it) once nothing of it runs, under the lock a new holder is
// started under. A worktree launch made for it goes first, through cleanup's own checks (nothing uncommitted, no file
// the worker made, no commit no branch holds), and the run folder stays when cleanup keeps the worktree. Without one,
// its work, in its folder, is the lead's to integrate: cleanup touches no repository.
// A terminal worker has no holder: its terminal is ended instead (backend-terminal.mjs), and the worktree and run folder
// then go through the same checks.
export async function cleanupWorker(name, { dryRun = false, deleteBranch = false } = {}, out, { hc, env = {} } = {}) {
  const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail });
  const refuse = (why, next) => { out.ok = false; out.state = "refused"; out.headline = `routr: kept ${name}: ${why}`; out.next.push(...[].concat(next)); step("refused", false, why); return out; };
  out.name = name;
  const rec = workerOf(name);
  if (rec.unreadable) return refuse(unreadableWhy(name, "worker.json", rec.unreadable), damagedNext(name));
  if (!rec.worker) {
    if (existsSync(runDir(name))) return refuse("its folder is not one routr's launch wrote", doNext(`Look at ${runDir(name)} yourself.`));
    out.ok = true; out.state = "absent"; out.headline = `routr: nothing to remove: no worker ${name}`; return out;
  }
  return locked(name, async (assertOwned) => {
    // Read again under the lock: it may have changed while cleanup waited for it.
    const again = workerOf(name), w = again.worker;
    if (!w) return refuse(again.unreadable ? unreadableWhy(name, "worker.json", again.unreadable) : "its record changed while cleanup waited", damagedNext(name));
    const held = w.backend === "terminal" ? await (await import("./backend-terminal.mjs")).endTerminal(w, { dryRun, out, assertOwned, ...(hc ? { hc } : {}) }) : await holderLeft(name, w);
    if (held) return refuse(held.why, held.next);
    if (w.worktree) {
      const { cleanup, worktreesFromGit } = await import("./cleanup.mjs");
      // The worktree at that path must still be this worker's: on its branch. One put there since is someone else's.
      const listed = await git(w.worktree.source, ["worktree", "list", "--porcelain"]);
      const there = listed.ok ? worktreesFromGit(listed.out).worktrees.find((x) => x.is_linked_worktree && realOr(x.path) === realOr(w.worktree.path)) : null;
      if (!listed.ok) return refuse(`git could not list the worktrees of ${w.worktree.source} (${listed.code})`, runNext("Look at them.", ["git", "-C", w.worktree.source, "worktree", "list"]));
      const finish = doNext(`Look at ${w.worktree.path}; finish it with routr cleanup --cwd ${w.worktree.source} --path ${w.worktree.path} if it should go.`);
      // A detached one may still be the worker's own (it checked out a commit): never removed on that guess either.
      if (there?.is_detached && folderId(w.worktree.path) === w.worktree.folder) return refuse(`the worktree at ${w.worktree.path} is detached, no longer on ${w.worktree.branch}: what it holds is not checked`, finish);
      if (there && there.branch !== w.worktree.branch) return refuse(`the worktree at ${w.worktree.path} is ${there.branch ? `on branch ${there.branch}` : "detached"}, not on ${w.worktree.branch}: it is not the one launch made`, finish);
      if (there && folderId(w.worktree.path) !== w.worktree.folder) return refuse(`the worktree at ${w.worktree.path} was made again since launch: it is not the one launch made`, finish);
      // Through git, as launch made it; in herdr-core with core's terminals checked too, but for this worker's own.
      const core = env.HERDR_ENV !== "1" && env.HC_TERMINAL_ID ? { HC_TERMINAL_ID: env.HC_TERMINAL_ID } : {};
      const r = await cleanup(["--cwd", w.worktree.source, "--path", w.worktree.path, ...(deleteBranch ? ["--delete-branch"] : []), ...(dryRun ? ["--dry-run"] : [])], { env: core, assertOwned, ...(hc ? { hc } : {}), ownWorker: w.id });
      out.ran.push(...r.ran); out.unavailable.push(...r.unavailable);
      // The worker's own process and its harness's process group were checked above; what that cannot see is said here.
      const label = HARNESSES[w.kind]?.label ?? "the harness";
      out.warnings.push(...r.warnings.filter((x) => !/cannot see whether anything runs/.test(x)),
        warning("detached_unseen", `cleanup cannot see a command ${name} started that left ${label}'s process group or detached itself${process.platform === "win32" ? ` (on Windows, anything once ${label} has ended)` : ""}: stop any such command before cleanup`));
      const why = r.steps.find((x) => x.step === "refused")?.detail;
      if (!["removed", "absent", "planned"].includes(r.state)) return refuse(r.state === "failed" ? `its worktree could not be checked (${r.error})` : why ?? r.headline, r.next);
      // git lists no worktree there, yet a folder is: whose it is cannot be told, so it and the worker's record stay.
      if (r.state === "absent" && existsSync(w.worktree.path)) return refuse(`git lists no worktree at ${w.worktree.path}, yet a folder is there: routr cannot tell it is the one launch made`, doNext(`Look at ${w.worktree.path}; remove it yourself if nothing in it is needed, then run cleanup again.`));
      out.worktree = r.worktree ?? { path: w.worktree.path, branch: w.worktree.branch };
      if (r.branch) out.branch = r.branch;
      for (const s of r.steps) out.steps.push(s);
    }
    const helper = HARNESSES[w.kind]?.helper;
    if (helper) out.warnings.push(helper.left(w.cwd));
    if (dryRun) { out.ok = true; out.state = "planned"; out.headline = `routr: would remove ${runDir(name)}${w.worktree ? ` and ${w.worktree.path}` : ""}`; step("plan", true, `Would remove ${runDir(name)} and its reports`); return out; }
    assertOwned();
    for (const n of generations(runDir(name))) { assertOwned(); try { removeEndpoint(w.id, JSON.parse(readFileSync(join(runDir(name), `gen-${n}.ready`), "utf8")).endpoint); } catch {} }
    assertOwned();
    rmSync(runDir(name), { recursive: true, force: true });
    step("remove", true, `Removed ${runDir(name)} and its reports`);
    out.ok = true; out.state = "removed"; out.headline = `routr: removed worker ${name}`;
    if (!w.worktree) out.warnings.push(warning("work_kept", `${name} worked in ${w.cwd}: its changes there are yours to check and keep`));
    return out;
  });
}
