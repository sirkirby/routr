// The terminal backend: a worker run interactively by its harness in a herdr-core terminal, a tab in the Herdr app, so the
// person sees the real harness and the lead reads it with hc, as it reads a pane with herdr. routr starts it (`launch`),
// follows it through hc (`wait`, `send`, `stop`) and ends it (`cleanup --worker`); its report stays on the terminal. Its
// adapter for the worker module owns those operations; `follows(op)` keeps watch, and Cursor wait, on the terminal.
// hc runs routr's own runner in the terminal, never the harness: core gives a terminal its server's environment, not
// its caller's (measured 2026-11-03), so the runner is what gives the harness the environment launch decided on.
import { warning } from "./warnings.mjs";
import { launchCarriers, currentLaunch, inputNeeded } from "./traces.mjs";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sentAs } from "./backend-headless.mjs";
import { amend, newRecord, readRecordAt, recordStore, runDir, WORKER_LABEL } from "./worker-record.mjs";
import { planWorktree } from "./worktree.mjs";
import { makePrivateConfig, refuseInputs, refuseSandbox, refuseSettings, refuseTaken, takeRun, worktreeRecord } from "./worker-start.mjs";
import { HARNESSES, privateConfigDir, subagentDefaults, terminalPlan } from "./harnesses.mjs";
import { displayCommand, doNext, runNext, templateCommand } from "./next.mjs";
import { launchFailed, STARTUP_INPUT } from "./launch-answer.mjs";
import { actHc, client, getTerminal, isAddress, isFinished, statusKind, statusWord, turnOf } from "./hc.mjs";
import { leadTerminal, openTerminal } from "./core-tab.mjs";
import { configLocations, FORWARDED, launchCarrierWarnings, terminalEnv } from "./worker-env.mjs";
import { processAlive, readJsonFile, writeJsonAtomic } from "./state-files.mjs";
import { start } from "./processes.mjs";

const PROMPT_FILE = "prompt.md", RUN_FILE = "run.json", MESSAGE_FILE = "message";
const pausing = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 250;
// A harness that has run this long and sent core no report at all is taken to be at a question it reports nothing for,
// not still starting. Measured 2026-11-04 in core terminals, two starts each: Claude Code, Codex and Antigravity first
// reported within 1 s, Kiro V3 with its folder trusted within 2 s; Kiro at its folder question sent nothing for 46 s.
const SILENT_MS = 20000;
const WHERE = { where: "in a herdr-core terminal", runs: "runs in a terminal of its own" };
// The first message: where the task is, never the task. hc keeps a terminal's argv and `ps` shows a harness's (p50).
export const firstMessage = (file) => `Your task is in ${file}. Read that whole file now and do what it says.`;
const nextMessage = (file) => `Your message is in ${file}. Read that whole file now and do what it says.`;
// For a harness that reports no status: core's own convention, and the only way such a worker can say it finished
// (measured with Cursor, 3 of 3 within 14 s; what the lead reads is the text typed into its terminal).
export const reportToLead = (lead) => `When you are done, or stuck, send your whole report to the lead by running this shell command, with your report in place of the placeholder: hc send ${lead} "<your report>". The lead cannot see how you are doing in any other way.`;
const TERMINAL_FOLLOWED = (w) => `${w.name} runs in ${w.terminal ? `terminal ${w.terminal}` : "a herdr-core terminal"}: follow it with hc`;
const addressOf = (w) => w.terminal ?? w.terminal_name;
const HC_WHY = { not_available: "hc did not answer", refused: "hc refused", not_found: "hc does not know this terminal", unreadable: "hc gave an answer routr cannot read" };
// What launch, and every worker command, tells a lead to do with hc.
const hcFor = (word, w) => ["hc", word, addressOf(w)];
const messageStep = (w) => doNext("Send it a message with hc; end a correction by asking again for the report block.", templateCommand([...hcFor("send", w), "<message>"]));
const readStep = (w) => runNext("Read what its terminal shows.", [...hcFor("read", w), "--lines", "200"]);
const followSteps = (w) => (HARNESSES[w.kind]?.noStatus
  ? [doNext(`${HARNESSES[w.kind].label} reports no status, so hc wait says nothing of it: it sends you its report with hc send when it is done or stuck, typed into your terminal.`), readStep(w), messageStep(w)]
  : [runNext("Wait until its status leaves working (at most 90 seconds, as your shell tool allows: run it again). A turn above 0 then means its turn is done.", [...hcFor("wait", w), "--timeout", "90", "--json"]), readStep(w), messageStep(w)]);
// Where a terminal worker's terminal is, as hc and its runner say: the one reading `workers` shows and `cleanup --worker`
// acts on. `in_terminal`: live, this worker's (its label carries the record's id), `terminal` its answer. `finished`:
// its program ended and the terminal is still listed. `gone`: hc does not know it and its runner recorded an end or is
// no longer running (a closed tab, a core that lost it). `unknown`, with `why` and `next`: hc did not answer or answered
// what routr cannot read, the address now names another terminal or one on another core, or the runner is still there
// though hc does not know its terminal. Only hc's own "no such terminal" can make one gone: a refusal for any other
// reason, or an answer that is not a terminal, is unknown. Looked at, never signalled. `ms` bounds the hc call. `dir` is
// its run folder.
async function observeTerminal(w, dir, { hc = client, ms } = {}) {
  const ref = addressOf(w), look = doNext(`Look at it with hc from the terminal that launched it (hc ls --all), then run cleanup again.`);
  const got = await getTerminal(ref, hc, ms);
  const code = got.ok && (!got.data || typeof got.data !== "object" || Array.isArray(got.data)) ? "unreadable" : got.code;
  if (code && code !== "not_found") return { state: "unknown", why: `${HC_WHY[code]}, so whether ${w.name}'s terminal runs is not known`, next: look };
  if (!got.ok) {
    // Gone, or in a core this hc does not reach. Only the runner can tell those apart: it wrote how the harness ended,
    // and while nothing says so and its process is there, the worker may be running.
    const read = runRecord(w.name, dir), ran = read.value;
    if (read.unreadable) return { state: "unknown", why: `${w.name}'s ${RUN_FILE} could not be read just now (${read.unreadable}), so whether it runs is not known: try again in a moment`, next: look };
    if (ran && !ran.ended_at && Number.isInteger(ran.pid) && processAlive(ran.pid)) return { state: "unknown", why: `hc does not find ${w.name}'s terminal, yet its process ${ran.pid} is there: it may be in another core`, next: look };
    return { state: "gone" };
  }
  const t = got.data;
  // Addresses last on one core only, and a name can be used again: the id launch labelled it with is what makes it this worker's.
  if (t.labels?.[WORKER_LABEL] !== w.id) return { state: "unknown", foreign: true, why: `terminal ${ref} does not carry ${w.name}'s id, so it is not this worker's, or not on this core`, next: doNext(`Look at ${ref} with hc. Run cleanup from the core that started ${w.name}; if that core has gone, make sure nothing of it runs, then remove ${dir} and its worktree yourself.`) };
  return { state: isFinished(t) ? "finished" : "in_terminal", terminal: t };
}

// An action follows the terminal that `observeTerminal` checked, never its reusable name. The record is checked too:
// replacing a worker between that look and the action does not let the old action reach the new worker.
const checkedTarget = (me, t) => {
  const same = me.still();
  if (same !== "same") return { why: same?.unreadable ? `${me.name}'s worker record could not be read just now` : `${me.name} was cleaned up and launched again meanwhile` };
  return { target: isAddress(t.address) ? t.address : addressOf(me.record) };
};
const lookAgain = (name) => [runNext("Look again in a moment.", ["routr", "workers", "--name", name])];

// hc's JSON error kind is an outside boundary. Only `blocked` is meaningful here: hc deliberately refuses to paste
// into a program at a question. Every other failure is the same unknown result, and none of hc's text leaves this file.
async function sendToTerminal(target, pointer, hc) {
  const r = await hc("hc", ["send", target, pointer, "--json"], 15000);
  if (r == null) return { code: "unknown" };
  let body;
  try { body = JSON.parse(r.out); } catch { return { code: "unknown" }; }
  if (r.code === 0 && body && typeof body === "object" && Number.isSafeInteger(body.turn) && body.turn >= 0) return { code: "handed_to_harness" };
  if (r.code !== 0 && body?.error?.kind === "blocked") return { code: "refused", why: "refused" };
  return { code: "unknown" };
}

// The harness has the pointer to its task from the moment it starts, so as in a pane once a task is sent, launch reads no
// screen and returns none: it may show the brief. The lead reads the terminal itself.
const WITHHELD = "withheld: the worker has its task from the start, so its terminal may show it. Read the terminal yourself.";

// ---- launch --------------------------------------------------------------------------------------------------------
// Fills `out`, launch's answer, in place; its failures end here. Answers what launch needs to say next.
export async function launchTerminal(o, out, ctx) {
  const seen = { opened: false };
  try { await startTerminal(o, out, ctx, seen); }
  catch (e) { launchFailed(out, e, seen.opened); }
  return { attempted: seen.opened, submitted: seen.opened, adopted: false, cleanup: out.worker ? ["routr", "cleanup", "--worker", o.name] : null };
}
async function startTerminal(o, out, { prompt, env, settings, ready, checkListed, hc = client, self, sleep = pausing, now = () => Date.now() }, seen) {
  const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail });
  const h = HARNESSES[o.kind], defaults = { kind: o.kind, subagentModel: o["subagent-model"], subagentEffort: o["subagent-effort"] };
  // Every refusal comes before anything is written, hc's too: without the lead's terminal there is nowhere to open a tab.
  refuseInputs(o, prompt, WHERE);
  refuseSandbox(env);
  refuseTaken(o.name);
  const plannedTree = o.worktree ? await planWorktree(o, out.cwd) : null;
  const config = await refuseSettings(o, out, { settings, ready, checkListed });
  const until = now() + o.timeout;
  const lead = await leadTerminal(env, hc);
  if (lead.code) throw new Error(`${HC_WHY[lead.code]} when asked about this terminal, so no worker was started (${lead.code})`);
  // The run folder by its path, and the record's id to check there: the terminal's HOME is the core's, which may not be this one.
  const id = randomUUID().replace(/-/g, ""), program = self(["workers", "--run", runDir(o.name), "--id", id]);
  if (!program) throw new Error("routr cannot find its own program to run in the worker's terminal");
  const { dir, wt, unreserve } = await takeRun(o, out, plannedTree);
  let w;
  const store = recordStore(), save = (patch) => { w = amend(w, patch); store.write(dir, w); };
  const file = join(dir, PROMPT_FILE);
  const text = h.noStatus ? `${prompt}\n\n${reportToLead(lead.address)}` : prompt;
  const found = launchCarriers(env), locations = configLocations(env);
  let shown;
  try {
    const launchTrace = currentLaunch(config, env);
    out.warnings.push(...launchCarrierWarnings(found));
    shown = terminalPlan(planOf({ kind: o.kind, model: o.model, effort: o.effort ?? null, cwd: out.cwd, subagent_model: o["subagent-model"], subagent_effort: o["subagent-effort"] }, dir), firstMessage(file));
    out.start = { executable: h.executable, argv: shown.argv, env: { ...subagentDefaults(defaults).env, ...Object.fromEntries([...Object.keys(found.carriers), ...Object.keys(locations)].map((k) => [k, FORWARDED])) } };
    out.ran.push(displayCommand([h.executable, ...shown.argv]));
    out.prompt_chars = text.length;
    writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    makePrivateConfig(o.kind, dir);
    w = newRecord({ id, name: o.name, kind: o.kind, model: o.model, effort: o.effort, cwd: out.cwd, carriers: found.carriers,
      subagent_model: o["subagent-model"] || null, subagent_effort: o["subagent-effort"] || null, launch: launchTrace, worktree: worktreeRecord(wt).worktree },
    { backend: "terminal", terminal_name: o.name, config: locations });
    save({});
  } catch (e) { await unreserve(); throw e; }
  out.worker = { name: o.name, backend: "terminal", run: dir, terminal: null };
  step("reserve", true, `Made ${dir} for ${o.name}`);
  // The space label is core's and the program routr's own: the log says what they are.
  out.ran.push(displayCommand(["hc", "run", "--bg", "--json", "--name", o.name, "--cwd", out.cwd, "--outlive-parent", "--no-notify", ...(lead.space ? ["--label", "herdr.space=<lead's space>", "--label", `herdr.tab=routr-${id}`] : []), "--label", `${WORKER_LABEL}=${id}`, "--", "routr", "workers", "--run", dir, "--id", id]));
  const opened = await openTerminal({ name: o.name, id, cwd: out.cwd, lead, argv: program, labels: [`${WORKER_LABEL}=${id}`], trying: (name) => save({ terminal_name: name }), run: hc, pause: sleep });
  if (opened.code === "refused" || opened.code === "not_found") { await unreserve(); throw new Error(`hc refused to start the worker's terminal (${opened.code}); nothing was started, and what launch made is gone`); }
  // No answer, or one it cannot read: a terminal may be there, so what launch made stays for cleanup to finish.
  if (opened.code) { out.next.push(runNext("Look for its terminal before launching it again.", ["hc", "ls"])); throw new Error(`${HC_WHY[opened.code]} when asked to start the worker's terminal, so whether it runs is not known (${opened.code})`); }
  seen.opened = true;
  out.worker.terminal = opened.terminal;
  save({ terminal: opened.terminal, terminal_name: opened.name });
  step("terminal", true, opened.tab ? `${o.name} runs in a tab of its own (${opened.terminal})` : `${o.name} runs in terminal ${opened.terminal}`);

  // Ready means its status says working, or its turn has gone by. A harness that reports none counts once its process runs.
  const follow = followSteps(w);
  const needsInput = async (code, why, more = {}) => {
    inputNeeded(code);
    out.ok = false; out.state = "needs_input";
    const startup = h.core?.startup ?? h.startup;
    out.needs_input = { why, ...more, ...(startup ? { note: startup } : {}) };
    out.screen = WITHHELD;
    out.next.push(readStep(w), doNext(`${STARTUP_INPUT} Once it is answered the worker goes on by itself: do not launch it again.`, templateCommand(["hc", "keys", opened.terminal, "<keys>"])), ...follow);
    step("needs_input", false, why);
  };
  const started = (detail) => { out.ok = true; out.state = "prompted"; step("prompt", true, detail); out.next.push(...follow); };
  const ended = (detail) => { out.screen = WITHHELD; out.next.push(readStep(w)); throw new Error(`${h.label} ended before it started the task (${detail})`); };
  let quietSince = null; // when this launch first saw the harness running with nothing reported
  for (;;) {
    const left = until - now(), got = await getTerminal(opened.terminal, hc, Math.max(1000, Math.min(10000, left)));
    const ran = runRecord(o.name, dir).value;
    if (got.ok) {
      const t = got.data, word = statusWord(t), turn = turnOf(t);
      if (word === "working" || word === "done" || turn > 0) return started(`${h.label} started the task's turn (status ${word ?? "none"}, turn ${turn})`);
      if (isFinished(t)) return ended(Number.isInteger(t.exit_code) ? `exit code ${t.exit_code}` : "its terminal finished");
      if (word === "blocked") { const kind = statusKind(t); return needsInput("startup_question", `${h.label} is waiting at a question before it can start.`, { hc: { state: "blocked", ...(kind ? { kind } : {}) } }); }
      if (word === "error") return ended("it reported an error");
      if (h.noStatus && Number.isInteger(ran?.harness_pid) && ran.ended_at == null) return started(`${h.label} is running; it reports no status, so whether it read its task is not known`);
      // `reported` is core's own (hc 0.1.17 schema); a core without it never ends the wait early.
      if (!h.noStatus && t.reported === false && Number.isInteger(ran?.harness_pid) && ran.ended_at == null) {
        quietSince ??= now();
        if (now() - quietSince >= SILENT_MS) return needsInput("start_unconfirmed", `${h.label} has run for ${SILENT_MS / 1000} seconds without reporting any status: it is most likely waiting at a question it reports no status for.`, { hc: { state: null, reported: false } });
      }
    } else if (got.code === "not_found") return ended("its terminal is gone");
    if (ran?.ended_at) return ended(ran.not_started ? `it could not start: ${ran.not_started}` : `exit code ${ran.exit_code}`);
    if (left <= 0) return needsInput("start_unconfirmed", `${h.label} has not reported working within the timeout: it may be waiting at a question it reports no status for, or still starting.`, { hc: { state: got.ok ? statusWord(got.data) : null } });
    await sleep(Math.min(POLL_MS, Math.max(1, left)));
  }
}

// ---- the runner: `routr workers --run <name>`, the program in the worker's terminal -----------------------------------
const planOf = (w, dir) => ({ kind: w.kind, model: w.model, effort: w.effort ?? undefined, cwd: w.cwd, subagentModel: w.subagent_model, subagentEffort: w.subagent_effort, cursorConfigDir: privateConfigDir(w.kind, dir) });
// What the runner wrote: when it started the harness, and how that ended. Launch and cleanup read it.
export const runRecord = (name, dir = runDir(name)) => readJsonFile(join(dir, RUN_FILE));
// `dir`: the run folder launch made, by its path, and `id`: the id launch gave its record, checked there. The terminal's
// HOME is the core's, so this process cannot find that folder from a name. Reads the record, builds the environment, starts the harness on this terminal, waits, records its exit, exits with its
// code. Says only fixed lines of its own, on stderr: the screen is the person's. `begin` starts the process (the
// processes module's start); a test passes a fake.
export async function runWorker(dir, id, { env = process.env, begin = start, say = (s) => process.stderr.write(`${s}\n`), on = (sig, fn) => process.on(sig, fn), now = () => new Date().toISOString() } = {}) {
  const w = readRecordAt(dir);
  if (w?.backend !== "terminal" || w.id !== id) { say(`routr: ${dir} does not hold the terminal worker launch started; nothing was started`); return 2; }
  const name = w.name, file = join(dir, RUN_FILE), began = { pid: process.pid, started_at: now() };
  // One runner per worker: a second start of it would be a second harness on the same work.
  try { writeFileSync(file, JSON.stringify(began) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (e) { say(e?.code === "EEXIST" ? `routr: ${name} was started before; nothing was started now` : `routr: ${name}'s run folder could not be written (${typeof e?.code === "string" ? e.code : "write_failed"}); nothing was started`); return 2; }
  const record = (patch) => { try { writeJsonAtomic(file, { ...began, ...patch }, { mkdir: false, mode: 0o600 }); } catch {} };
  const notStarted = (code) => { record({ ended_at: now(), not_started: code }); say(`routr: ${HARNESSES[w.kind]?.label ?? w.kind} did not start (${code})`); return 127; };
  let child;
  try {
    const p = terminalPlan(planOf(w, dir), firstMessage(join(dir, PROMPT_FILE)));
    // The terminal is the harness's: on Windows a hidden start would take its console from it.
    child = begin(p.executable, p.argv, { stdio: "inherit", cwd: w.cwd, env: terminalEnv({ carriers: w.carriers, config: w.config, adapter: p.env }, env), visible: true });
  } catch (e) { return notStarted(typeof e?.code === "string" ? e.code : "start_failed"); }
  if (Number.isInteger(child.pid)) { began.harness_pid = child.pid; record({}); }
  // `hc kill` is hangup, then terminate, then kill: this process stays until the harness has had each. An interrupt
  // typed at the terminal is the harness's own.
  for (const sig of ["SIGHUP", "SIGTERM"]) on(sig, () => { try { child.kill(sig); } catch {} });
  on("SIGINT", () => {});
  return new Promise((done) => {
    let over = false;
    child.on("error", (e) => { if (!over) { over = true; done(notStarted(typeof e?.code === "string" ? e.code : "start_failed")); } });
    child.on("exit", (code, signal) => {
      if (over) return; over = true;
      record({ ended_at: now(), exit_code: code ?? null, signal: signal ?? null });
      done(code ?? 128 + (constants.signals[signal] ?? 0));
    });
  });
}

// Ends the worker's terminal, checked first to be its own and not at work, so its worktree and run folder can go through
// cleanup's checks with nothing writing to them. Answers why it cannot, or null. A dry run looks and ends nothing.
async function endTerminal(w, dir, { dryRun = false, out, assertOwned = () => {}, hc = client, pause = pausing }) {
  const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail }), ref = addressOf(w);
  const look = doNext(`Look at it with hc from the terminal that launched it (hc ls --all), then run cleanup again.`);
  const seen = await observeTerminal(w, dir, { hc });
  if (seen.state === "unknown") return { why: seen.foreign ? `${seen.why}: routr ended nothing and kept everything` : seen.why, next: seen.next };
  if (seen.state === "gone") { step("terminal", true, `${w.name}'s terminal is gone`); return null; }
  const t = seen.terminal;
  // What was checked is what is acted on: its address, not a name that could resolve again.
  const target = isAddress(t.address) ? t.address : ref;
  if (!isFinished(t)) {
    const word = statusWord(t);
    if (["working", "blocked"].includes(word)) return { why: `${w.name} is ${word === "blocked" ? "waiting at a question" : "working"} in terminal ${ref}`, next: [runNext("Wait for it to finish.", [...hcFor("wait", w), "--timeout", "90", "--json"]), doNext(`Answer it or let it finish before cleanup; to give up on its work, end it first with hc kill ${ref}.`)] };
    if (word == null && HARNESSES[w.kind]?.noStatus) out.warnings.push(warning("terminal_status_unknown", `${HARNESSES[w.kind].label} reports no status, so routr cannot see whether it is still working in ${ref}: it ${dryRun ? "would end" : "ended"} it all the same`));
    if (dryRun) { step("plan", true, `Would end terminal ${target}`); return null; }
    assertOwned();
    out.ran.push(displayCommand(["hc", "kill", target]));
    const killed = await actHc(["kill", target], hc, 15000);
    if (!killed.ok && killed.code !== "not_found") return { why: `${HC_WHY[killed.code]} when asked to end terminal ${target} (${killed.code}), so it may still be running`, next: look };
    step("terminal", true, `Ended terminal ${target}`);
  } else if (dryRun) { step("plan", true, `Would remove finished terminal ${target}`); return null; }
  // `rm` takes a finished terminal only: it refuses one still finishing for a moment. One that stays costs only a line in hc ls.
  assertOwned();
  out.ran.push(displayCommand(["hc", "rm", target]));
  for (let i = 0; ; i++) {
    const rm = await actHc(["rm", target], hc);
    if (rm.ok || rm.code === "not_found") { step("terminal_removed", true, `Removed terminal ${target}`); return null; }
    if (i >= 8) { out.warnings.push(warning("terminal_left", `Terminal ${target} has ended, but hc did not remove it (${rm.code}): hc rm ${target} removes it`)); return null; }
    await pause(250);
  }
}

// ---- the adapter: what the worker commands do to a terminal worker ---------------------------------------------------
// `me` and `ctx` as the worker module gives them (backend-headless.mjs says what each holds). Only watch stays on the
// worker's own terminal. Cursor also stays there for wait because it reports no status; send and stop need none.
const FOLLOWED = { watch: () => [] };
export const terminal = {
  // The runner's record in the run folder: what decides where a worker whose record cannot be read runs.
  owns: (dir) => existsSync(join(dir, RUN_FILE)),
  follows: (me, op) => {
    const w = me.record;
    if (!w) return null;
    if (op === "wait" && HARNESSES[w.kind]?.noStatus) return { why: TERMINAL_FOLLOWED(w), next: followSteps(w) };
    return FOLLOWED[op] ? { why: TERMINAL_FOLLOWED(w), next: FOLLOWED[op](w) } : null;
  },
  // In `workers`: its record, and where its terminal is (observeTerminal). A finished or gone one is finished with
  // cleanup --worker, never by removing its worktree: its record would stay, and so would its row there.
  async look(me, { ms } = {}, { hc } = {}) {
    const w = me.record, seen = await observeTerminal(w, me.dir, { ...(hc ? { hc } : {}), ms }), status = seen.terminal ? statusWord(seen.terminal) : null;
    // `workers` supplies a bound for its hc read and keeps its existing terminal row. Wait has no bound here: give it
    // the same shape as a headless view, with one report-less turn for each turn hc counted. A question is idle rather
    // than pending; the fixed status word still says blocked. Terminal end and disappearance use existing notices.
    if (ms == null) {
      const turn = seen.terminal ? turnOf(seen.terminal) : 0;
      const state = seen.state === "unknown" ? "unreachable" : seen.state === "gone" ? "lost" : seen.state === "finished" ? "stopped"
        : status === "working" ? "working" : status === "error" ? "failed" : "idle";
      return { view: { name: w.name, kind: w.kind, model: w.model, effort: w.effort ?? null, cwd: w.cwd, state, gen: 0, turn,
        seconds_since_event: null, last_tool: null, tasks: 0, queued: 0, session: null, report: null,
        ...(seen.state === "in_terminal" ? { status } : {}), ...(seen.why ? { why: seen.why } : {}),
        turns: Array.from({ length: turn }, (_, i) => ({ turn: i + 1, outcome: "finished", report: null, delivered: 0 })) },
      next: [readStep(w)] };
    }
    const view = { name: w.name, kind: w.kind, model: w.model, effort: w.effort ?? null, cwd: w.cwd, backend: "terminal", terminal: w.terminal ?? null, state: seen.state,
      ...(seen.state === "in_terminal" ? { status } : {}), ...(seen.why ? { why: seen.why } : {}) };
    const next = seen.state === "in_terminal" ? followSteps(w)
      : seen.state === "unknown" ? [seen.next]
      : [runNext(`${w.name}'s terminal ${seen.state === "gone" ? "is gone" : "has finished"}: finish the worker, which removes its worktree through its checks and then its record.`, ["routr", "cleanup", "--worker", w.name])];
    return { view, next };
  },
  // A status-reporting terminal may be working or have an unseen hc turn; look decides which. Cursor cannot be asked.
  pending: (me) => !HARNESSES[me.record?.kind]?.noStatus,
  async send(me, message, { hc = client } = {}) {
    const w = me.record, seen = await observeTerminal(w, me.dir, { hc });
    if (seen.state !== "in_terminal") return sentAs(w.name, w.kind, seen.state === "finished" || seen.state === "gone"
      ? { code: "refused", why: "ended" } : { code: "unknown" });
    const checked = checkedTarget(me, seen.terminal);
    if (!checked.target) return sentAs(w.name, w.kind, { code: "unknown" });
    const file = join(me.dir, `${MESSAGE_FILE}-${randomUUID().replace(/-/g, "")}.md`);
    writeFileSync(file, message, { flag: "wx", mode: 0o600 });
    return sentAs(w.name, w.kind, await sendToTerminal(checked.target, nextMessage(file), hc));
  },
  async stop(me, { hc = client } = {}) {
    const w = me.record, seen = await observeTerminal(w, me.dir, { hc }), base = { warnings: [], next: [] };
    if (["finished", "gone"].includes(seen.state)) return { state: "absent", ok: true, said: `${w.name} is not running`, ...base };
    if (seen.state === "unknown") return { state: "unknown", ok: false, said: `whether ${w.name}'s terminal runs is not known`, warnings: [], next: [seen.next] };
    const checked = checkedTarget(me, seen.terminal);
    if (!checked.target) return { state: "unknown", ok: false, said: `${checked.why}; nothing was stopped`, warnings: [], next: lookAgain(w.name) };
    const killed = await actHc(["kill", checked.target], hc, 15000);
    if (killed.ok) return { state: "stopped", ok: true, said: `stopped ${w.name}`, ...base };
    if (killed.code === "not_found") return { state: "absent", ok: true, said: `${w.name} is not running`, ...base };
    return { state: "unknown", ok: false, said: `${w.name} was told to stop and has not finished exiting`, warnings: [], next: lookAgain(w.name) };
  },
  end: (me, opts, { hc } = {}) => endTerminal(me.record, me.dir, { ...opts, ...(hc ? { hc } : {}) }),
  // Nothing of a terminal worker outlives its terminal but its run folder.
  release: () => {},
};
