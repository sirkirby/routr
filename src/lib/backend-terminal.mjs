// The terminal backend: a worker run interactively by its harness in a herdr-core terminal, a tab in the Herdr app, so the
// person sees the real harness and the lead follows it with hc, as it follows a pane with herdr. routr starts it (`launch`)
// and ends it (`cleanup --worker`); what a finished turn is, and where its report is, stay the lead's (design, step 2).
// hc runs routr's own runner in the terminal, never the harness: core gives a terminal its server's environment, not
// its caller's (measured 2026-11-03), so the runner is what gives the harness the environment launch decided on.
import { warning } from "./warnings.mjs";
import { launchCarriers, launchCarrierWarnings, currentLaunch, inputNeeded } from "./traces.mjs";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORMAT, readWorker, runDir } from "./worker-record.mjs";
import { planWorktree } from "./worktree.mjs";
import { cursorConfigOf, privateCursorConfig, refuseInputs, refuseSandbox, refuseSettings, refuseTaken, takeRun, worktreeRecord } from "./worker-start.mjs";
import { HARNESSES, subagentDefaults, terminalPlan } from "./harnesses.mjs";
import { displayCommand, doNext, runNext, templateCommand } from "./next.mjs";
import { launchFailed, STARTUP_INPUT } from "./launch-answer.mjs";
import { actHc, client, getTerminal, isFinished, readTerminal, statusKind, statusWord, turnOf } from "./hc.mjs";
import { leadTerminal, openTerminal } from "./core-tab.mjs";
import { clean } from "./herdr.mjs";
import { carrierValues, configLocations, FORWARDED, processAlive, readJsonFile, redactCarriers, start, terminalEnv, writeJsonAtomic } from "./runtime.mjs";

const PROMPT_FILE = "prompt.md", RUN_FILE = "run.json";
const pausing = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 250;
const WHERE = { where: "in a herdr-core terminal", runs: "runs in a terminal of its own" };
// The first message: where the task is, never the task. hc keeps a terminal's argv and `ps` shows a harness's (p50).
export const firstMessage = (file) => `Your task is in ${file}. Read that whole file now and do what it says.`;
// For a harness that reports no status: core's own convention, and the only way such a worker can say it finished
// (measured with Cursor, 3 of 3 within 14 s; what the lead reads is the text typed into its terminal).
export const reportToLead = (lead) => `When you are done, or stuck, send your whole report to the lead by running this shell command, with your report in place of the placeholder: hc send ${lead} "<your report>". The lead cannot see how you are doing in any other way.`;
export const TERMINAL_FOLLOWED = (w) => `${w.name} runs in ${w.terminal ? `terminal ${w.terminal}` : "a herdr-core terminal"}: follow it with hc`;
const addressOf = (w) => w.terminal ?? w.terminal_name;
const HC_WHY = { not_available: "hc did not answer", refused: "hc refused", not_found: "hc does not know this terminal", unreadable: "hc gave an answer routr cannot read" };
// What launch, and every worker command, tells a lead to do with hc.
const hcFor = (word, w) => ["hc", word, addressOf(w)];
export const messageStep = (w) => doNext("Send it a message with hc; end a correction by asking again for the report block.", templateCommand([...hcFor("send", w), "<message>"]));
export const stopStep = (w) => runNext("End its program with hc.", hcFor("kill", w));
const readStep = (w) => runNext("Read what its terminal shows.", [...hcFor("read", w), "--lines", "200"]);
export const followSteps = (w) => (HARNESSES[w.kind]?.noStatus
  ? [doNext(`${HARNESSES[w.kind].label} reports no status, so hc wait says nothing of it: it sends you its report with hc send when it is done or stuck, typed into your terminal.`), readStep(w), messageStep(w)]
  : [runNext("Wait until its status leaves working (at most 90 seconds, as your shell tool allows: run it again). A turn above 0 then means its turn is done.", [...hcFor("wait", w), "--timeout", "90", "--json"]), readStep(w), messageStep(w)]);
// A terminal worker in `workers`: what its record says. hc knows the rest.
export const terminalRow = (w) => ({ name: w.name, kind: w.kind, model: w.model, effort: w.effort ?? null, cwd: w.cwd, backend: "terminal", terminal: w.terminal ?? null, state: "in_terminal" });

// A screen launch may return: before the worker has its task's text, and never with it. A harness that read its prompt
// file and stopped before routr saw it working could show it, so a screen holding a run of the prompt is withheld.
const WITHHELD = "withheld: it shows part of the task. Read the terminal yourself.";
const quotes = (screen, prompt) => {
  const flat = (s) => s.replace(/\s+/g, ""), shown = flat(screen), text = flat(prompt);
  for (let i = 0; i + 32 <= text.length; i += 16) if (shown.includes(text.slice(i, i + 32))) return true;
  return false;
};
const screenOf = (text, prompt, hidden) => {
  if (text == null) return null;
  const tail = clean(text).split("\n").filter((l) => l.trim()).slice(-40).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l)).join("\n");
  return quotes(tail, prompt) ? WITHHELD : redactCarriers(tail, hidden);
};

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
  const program = self(["workers", "--run", o.name]);
  if (!program) throw new Error("routr cannot find its own program to run in the worker's terminal");
  const { dir, wt, unreserve } = await takeRun(o, out, plannedTree);
  let w;
  const save = (patch) => { w = { ...w, ...patch }; writeJsonAtomic(join(dir, "worker.json"), w, { mkdir: false, mode: 0o600 }); }; // whole: a reader never sees it half written
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
    if (o.kind === "cursor") privateCursorConfig(dir);
    w = { format: FORMAT, id: randomUUID().replace(/-/g, ""), name: o.name, backend: "terminal", kind: o.kind, model: o.model, effort: o.effort ?? null, cwd: out.cwd, created_at: new Date().toISOString(), carriers: found.carriers,
      terminal_name: o.name, config: locations,
      ...(o["subagent-model"] ? { subagent_model: o["subagent-model"] } : {}), ...(o["subagent-effort"] ? { subagent_effort: o["subagent-effort"] } : {}),
      ...(launchTrace ? { launch: launchTrace } : {}), ...worktreeRecord(wt) };
    save({});
  } catch (e) { await unreserve(); throw e; }
  out.worker = { name: o.name, backend: "terminal", run: dir, terminal: null };
  step("reserve", true, `Made ${dir} for ${o.name}`);
  // The space label is core's and the program routr's own: the log says what they are.
  out.ran.push(displayCommand(["hc", "run", "--bg", "--json", "--name", o.name, "--cwd", out.cwd, "--outlive-parent", "--no-notify", ...(lead.space ? ["--label", "herdr.space=<lead's space>", "--label", `herdr.tab=routr-${w.id}`] : []), "--", "routr", "workers", "--run", o.name]));
  const opened = await openTerminal({ name: o.name, id: w.id, cwd: out.cwd, lead, argv: program, trying: (name) => save({ terminal_name: name }), run: hc, pause: sleep });
  if (opened.code === "refused" || opened.code === "not_found") { await unreserve(); throw new Error(`hc refused to start the worker's terminal (${opened.code}); nothing was started, and what launch made is gone`); }
  // No answer, or one it cannot read: a terminal may be there, so what launch made stays for cleanup to finish.
  if (opened.code) { out.next.push(runNext("Look for its terminal before launching it again.", ["hc", "ls"])); throw new Error(`${HC_WHY[opened.code]} when asked to start the worker's terminal, so whether it runs is not known (${opened.code})`); }
  seen.opened = true;
  out.worker.terminal = opened.terminal;
  save({ terminal: opened.terminal, terminal_name: opened.name });
  step("terminal", true, opened.tab ? `${o.name} runs in a tab of its own (${opened.terminal})` : `${o.name} runs in terminal ${opened.terminal}`);

  // Ready means its status says working, or its turn has gone by. A harness that reports none counts once its process runs.
  const hidden = [...carrierValues(env), ...Object.values(found.carriers)];
  const screen = async () => screenOf(await readTerminal(opened.terminal, hc), text, hidden);
  const follow = followSteps(w);
  const needsInput = async (code, why, more = {}) => {
    inputNeeded(code);
    out.ok = false; out.state = "needs_input";
    out.needs_input = { why, ...more, ...(h.startup ? { note: h.startup } : {}) };
    out.screen = await screen();
    out.next.push(doNext(`${STARTUP_INPUT} Once it is answered the worker goes on by itself: do not launch it again.`, templateCommand(["hc", "keys", opened.terminal, "<keys>"])), ...follow);
    step("needs_input", false, why);
  };
  const started = (detail) => { out.ok = true; out.state = "prompted"; step("prompt", true, detail); out.next.push(...follow); };
  const ended = async (detail) => { out.screen = await screen(); throw new Error(`${h.label} ended before it started the task (${detail})`); };
  for (;;) {
    const left = until - now(), got = await getTerminal(opened.terminal, hc, Math.max(1000, Math.min(10000, left)));
    const ran = runRecord(o.name).value;
    if (got.ok) {
      const t = got.data, word = statusWord(t), turn = turnOf(t);
      if (word === "working" || word === "done" || turn > 0) return started(`${h.label} started the task's turn (status ${word ?? "none"}, turn ${turn})`);
      if (isFinished(t)) return ended(Number.isInteger(t.exit_code) ? `exit code ${t.exit_code}` : "its terminal finished");
      if (word === "blocked") { const kind = statusKind(t); return needsInput("startup_question", `${h.label} is waiting at a question before it can start.`, { hc: { state: "blocked", ...(kind ? { kind } : {}) } }); }
      if (word === "error") return ended("it reported an error");
      if (h.noStatus && Number.isInteger(ran?.harness_pid) && ran.ended_at == null) return started(`${h.label} is running; it reports no status, so whether it read its task is not known`);
    } else if (got.code === "not_found") return ended("its terminal is gone");
    if (ran?.ended_at) return ended(ran.not_started ? `it could not start: ${ran.not_started}` : `exit code ${ran.exit_code}`);
    if (left <= 0) return needsInput("start_unconfirmed", `${h.label} has not reported working within the timeout: it may be waiting at a question it reports no status for, or still starting.`, { hc: { state: got.ok ? statusWord(got.data) : null } });
    await sleep(Math.min(POLL_MS, Math.max(1, left)));
  }
}

// ---- the runner: `routr workers --run <name>`, the program in the worker's terminal -----------------------------------
const planOf = (w, dir) => ({ kind: w.kind, model: w.model, effort: w.effort ?? undefined, cwd: w.cwd, subagentModel: w.subagent_model, subagentEffort: w.subagent_effort, cursorConfigDir: cursorConfigOf(dir) });
// What the runner wrote: when it started the harness, and how that ended. Launch and cleanup read it.
const runFile = (name) => join(runDir(name), RUN_FILE);
export const runRecord = (name) => readJsonFile(runFile(name));
// Reads the record, builds the environment, starts the harness on this terminal, waits, records its exit, exits with its
// code. Says only fixed lines of its own, on stderr: the screen is the person's. `begin` starts the process (runtime's
// start); a test passes a fake.
export async function runWorker(name, { env = process.env, begin = start, say = (s) => process.stderr.write(`${s}\n`), on = (sig, fn) => process.on(sig, fn), now = () => new Date().toISOString() } = {}) {
  const w = readWorker(name);
  if (w?.backend !== "terminal") { say(`routr: ${name} is not a terminal worker`); return 2; }
  const began = { pid: process.pid, started_at: now() };
  // One runner per worker: a second start of it would be a second harness on the same work.
  try { writeFileSync(runFile(name), JSON.stringify(began) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (e) { say(e?.code === "EEXIST" ? `routr: ${name} was started before; nothing was started now` : `routr: ${name}'s run folder could not be written (${typeof e?.code === "string" ? e.code : "write_failed"}); nothing was started`); return 2; }
  const record = (patch) => { try { writeJsonAtomic(runFile(name), { ...began, ...patch }, { mkdir: false, mode: 0o600 }); } catch {} };
  const dir = runDir(name), notStarted = (code) => { record({ ended_at: now(), not_started: code }); say(`routr: ${HARNESSES[w.kind]?.label ?? w.kind} did not start (${code})`); return 127; };
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

// ---- cleanup --worker -------------------------------------------------------------------------------------------------
// Ends the worker's terminal, checked first to be its own and not at work, so its worktree and run folder can go through
// cleanup's checks with nothing writing to them. Answers why it cannot, or null. A dry run looks and ends nothing.
export async function endTerminal(w, { dryRun = false, out, assertOwned = () => {}, hc = client, pause = pausing }) {
  const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail }), ref = addressOf(w);
  const look = doNext(`Look at it with hc from the terminal that launched it (hc ls --all), then run cleanup again.`);
  const got = await getTerminal(ref, hc);
  if (["not_available", "unreadable"].includes(got.code)) return { why: `${HC_WHY[got.code]}, so whether ${w.name}'s terminal runs is not known`, next: look };
  if (!got.ok) {
    // Gone, or in a core this hc does not reach. Only the runner can tell those apart: it wrote how the harness ended,
    // and while nothing says so and its process is there, the worker may be running. Looked at, never signalled.
    const read = runRecord(w.name), ran = read.value;
    if (read.unreadable) return { why: `${w.name}'s ${RUN_FILE} could not be read just now (${read.unreadable}), so whether it runs is not known: try again in a moment`, next: look };
    if (ran && !ran.ended_at && Number.isInteger(ran.pid) && processAlive(ran.pid)) return { why: `hc does not find ${w.name}'s terminal, yet its process ${ran.pid} is there: it may be in another core`, next: look };
    step("terminal", true, `${w.name}'s terminal is gone`);
    return null;
  }
  const t = got.data;
  // Addresses last on one core only, so an address on another may be anyone's: never ended on the address alone.
  if (t.name !== w.terminal_name) return { why: `terminal ${ref} is not ${w.name}'s now (another name): routr ends only its own`, next: doNext(`Look at ${ref} with hc; remove ${runDir(w.name)} and its worktree yourself if nothing of them is needed.`) };
  if (!isFinished(t)) {
    const word = statusWord(t);
    if (["working", "blocked"].includes(word)) return { why: `${w.name} is ${word === "blocked" ? "waiting at a question" : "working"} in terminal ${ref}`, next: [runNext("Wait for it to finish.", [...hcFor("wait", w), "--timeout", "90", "--json"]), doNext(`Answer it or let it finish before cleanup; to give up on its work, end it first with hc kill ${ref}.`)] };
    if (word == null && HARNESSES[w.kind]?.noStatus) out.warnings.push(warning("terminal_status_unknown", `${HARNESSES[w.kind].label} reports no status, so routr cannot see whether it is still working in ${ref}: it ${dryRun ? "would end" : "ended"} it all the same`));
    if (dryRun) { step("plan", true, `Would end terminal ${ref}`); return null; }
    assertOwned();
    out.ran.push(displayCommand(["hc", "kill", ref]));
    const killed = await actHc(["kill", ref], hc, 15000);
    if (!killed.ok && killed.code !== "not_found") return { why: `${HC_WHY[killed.code]} when asked to end terminal ${ref} (${killed.code}), so it may still be running`, next: look };
    step("terminal", true, `Ended terminal ${ref}`);
  } else if (dryRun) { step("plan", true, `Would remove finished terminal ${ref}`); return null; }
  // `rm` takes a finished terminal only: it refuses one still finishing for a moment. One that stays costs only a line in hc ls.
  assertOwned();
  out.ran.push(displayCommand(["hc", "rm", ref]));
  for (let i = 0; ; i++) {
    const rm = await actHc(["rm", ref], hc);
    if (rm.ok || rm.code === "not_found") { step("terminal_removed", true, `Removed terminal ${ref}`); return null; }
    if (i >= 8) { out.warnings.push(warning("terminal_left", `Terminal ${ref} has ended, but hc did not remove it (${rm.code}): hc rm ${ref} removes it`)); return null; }
    await pause(250);
  }
}
