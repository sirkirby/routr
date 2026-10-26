import { warning } from "./warnings.mjs";
import { inputNeeded, commandTrace, launchCarriers, launchCarrierWarnings, adviceForLaunch, completeLaunch } from "./traces.mjs";
import { takeLeadSession } from "./trace-context.mjs";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { HARNESSES, kindError, notReady, plan, MODEL_REQUIRED } from "./harnesses.mjs";
import { dispatchAdvice, matchAdvice, readAdvice, readTask, savedDecisionFailures } from "./advice-file.mjs";
import { displayCommand, doNext, launchNext, runNext, templateCommand } from "./next.mjs";
import { CLOSING, OFF } from "./wording.mjs";
import { BRANCH, clean, CMD_PATH, cmdTypable, deadline, paneText, paneView, promptReadArgs, runHerdr, SHELLS, shellFamily, splitArgs, splitPane, waitForShell, worktreeArgs, worktreePane } from "./herdr.mjs";
import { answer } from "./output.mjs";
import { callHerdr, processError, processSteps, stateWords } from "./process-boundary.mjs";
import { CARRIERS, carrierValues, ensureParent, FORWARDED, home, realPath, redactCarriers, spawnSelf } from "./runtime.mjs";
import orchestratorGuide from "../../skills/routr/references/orchestrator.md" with { type: "text" };

// The guide is the source of this instruction, embedded at build time just like the installed skills.
const STARTUP_INPUT = orchestratorGuide.match(/<!-- startup-input -->\s*([\s\S]*?)\s*<!-- \/startup-input -->/)[1].replace(/\s*\n\s*/g, " ");

// The worker guide a launch prompt points at. From source it sits beside this file; a compiled binary has no files
// around it, so it points at the installed skill (written by the installer or `routr skill install`).
const besideSource = fileURLToPath(new URL("../../skills/routr/references/worker.md", import.meta.url));
export const WORKER_GUIDE = existsSync(besideSource) ? besideSource : join(home(), ".agents/skills/routr/references/worker.md");
// The first words of every launch prompt.
export const PROMPT_OPENING = "You are a routr worker.";
// `rules` is the lead's process text (what the worker may and may not do, how to report, git steps): the worker reads it
// after the task, and routr never does. Only the task is the work that `dispatch` and `--advice` judge. (Measured
// 2026-09-26: 18 of 36 real tasks carried such text, 5 to 38% of each, and it moved Jev's readings.)
export function composePrompt(task, guide = WORKER_GUIDE, rules = null) {
  return `${PROMPT_OPENING} Your first action, before any other tool call, is to read the routr worker guide at ${guide}. It is mandatory for this task: it says how to size each subagent before you spawn it and the exact report format the orchestrator parses.\n\n${task}${rules ? `\n\n${rules.trim()}` : ""}\n\n${CLOSING}`;
}

const command = (args) => displayCommand(["herdr", ...args]);
// Trace-context carriers reach only a pane launch splits (herdr's `pane split --env`), beside the caller or in a new
// worktree. In an existing pane (--pane, an adopted agent) this fixed warning says the launch passed none: never that the
// worker has none (a --pane rerun into a pane routr split already has them in its shell), and never with a value.
const PASSED_NONE = (names) => `This launch passed none of ${names.join(", ")} to the worker: an existing pane keeps the environment its shell, or the agent already running there, started with, and routr never types a carrier into a shell`;
// The command log is printed and may be stored by whoever called launch: it carries the prompt's length, never its
// text (the brief must not be printed, logged, or stored).
const PANE_WITHHELD = "withheld: the prompt was already submitted, so the pane shows the task. Read the pane yourself.";
const promptForLog = (args) => command(args.map((a, i) => (args[0] === "agent" && args[1] === "prompt" && i === 3 ? `<prompt: ${String(a).length} chars>` : a)));
// Polling repeats the same read; record it once with a count so the result stays readable.
export function logCommand(log, text) {
  const last = log.at(-1);
  if (last === text) { log[log.length - 1] = `${text}  (x2)`; return log; }
  const m = typeof last === "string" && last.match(/^(.*)  \(x(\d+)\)$/);
  if (m && m[1] === text) { log[log.length - 1] = `${m[1]}  (x${Number(m[2]) + 1})`; return log; }
  log.push(text); return log;
}

export function parseLaunchArgs(args) {
  const lead = takeLeadSession(args); args = lead.args;
  const o = { timeout: 120000, dryRun: false, ...(lead.lead ? { "lead-session": lead.lead } : {}), ...(lead.warnings.length ? { leadWarnings: lead.warnings } : {}) };
  const values = ["kind", "name", "cwd", "model", "effort", "pane", "worktree", "base", "direction", "task", "task-file", "rules-file", "timeout", "advice"];
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || (!values.includes(key) && key !== "dry-run" && key !== "copy")) throw new Error(`Unknown launch option: ${args[i]}`);
    if (key === "copy") {
      if (!args[i + 1]?.trim() || /^-\S/.test(args[i + 1])) throw new Error("--copy requires a path");
      (o.copy ??= []).push(args[++i]); continue;
    }
    if (seen.has(key)) throw new Error(`Repeated launch option: --${key}`);
    seen.add(key);
    if (key === "dry-run") { o.dryRun = true; continue; }
    if (!args[i + 1]?.trim() || /^-\S/.test(args[i + 1])) throw new Error(`--${key} requires a value`);
    if (args[i + 1].includes("\0")) throw new Error(`--${key} must not contain NUL`);
    o[key] = args[++i];
  }
  if (!Object.hasOwn(HARNESSES, o.kind)) throw kindError();
  if (o.worktree && o.pane) throw new Error("--worktree creates its own pane; do not pass --pane with it");
  if (o.copy && !o.worktree) throw new Error("--copy only makes sense with --worktree");
  if (o.base && !o.worktree) throw new Error("--base goes with --worktree: it is the commit the worktree's branch starts from");
  for (const c of o.copy ?? []) if (isAbsolute(c) || c.split(/[\\/]/).includes("..")) throw new Error("--copy takes paths inside the repository, relative to --cwd");
  if (o.worktree && !BRANCH.test(o.worktree)) throw new Error("--worktree must be a plain branch name");
  // A branch, tag, commit, or one relative to them (main~2, HEAD^): never an option or a range (a..b, HEAD^@, HEAD^-1).
  if (o.base && (!/^[A-Za-z0-9][A-Za-z0-9._\/@^~-]{0,200}$/.test(o.base) || o.base.includes("..") || /\^[-@!]/.test(o.base))) throw new Error("--base must name one commit: a branch, tag, or commit id");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(o.name ?? "")) throw new Error("--name must match [a-z][a-z0-9_-]{0,31}");
  if (o.direction && !["right", "down"].includes(o.direction)) throw new Error("--direction must be right or down");
  if (o.task != null && o["task-file"] != null) throw new Error("Use only one of --task and --task-file");
  if (o["rules-file"] != null && o.task == null && o["task-file"] == null) throw new Error("--rules-file goes with a task: pass --task-file (or --task) too");
  o.timeout = Number(o.timeout);
  if (!Number.isSafeInteger(o.timeout) || o.timeout <= 0) throw new Error("--timeout must be a positive integer in milliseconds");
  return o;
}

// Inject transport and time for tests; no test needs a live pane.
// `ready(kind)`: null when the harness is signed in, or why not (harnesses.mjs). `settings()`: the user's config.
async function launchBody(args, { run = runHerdr, sleep = (ms) => Bun.sleep(ms), now = () => performance.now(), env = process.env, ready = notReady, settings = () => loadConfig(),
  cursorConfigSource = join(home(), ".cursor", "cli-config.json"), tempRoot = tmpdir(), models = (kind) => HARNESSES[kind].models?.(), spawn = spawnSelf } = {}) {
  const safeRun = async (args, ms) => processSteps(out, await callHerdr(run, args, ms));
  const out = { ok: false, state: "failed", kind: null, name: null, pane: null, cwd: resolve("."), model: null, effort: null,
    ran: [], next: [], start: { executable: null, argv: [], env: {} }, steps: [], warnings: [], prompt_chars: null, unavailable: [] };
  const step = (step, ok, detail) => out.steps.push({ step, ok, detail });
  // Every screen launch returns goes through here: a shell's startup line can print the trace-context carriers
  // routr holds (found, generated, passed or withheld). The generated launch parent belongs to the same
  // redaction set.
  const hidden = [...carrierValues(env), ...Object.values(launchCarriers(env).carriers)], shown = (text) => redactCarriers(text, hidden);
  let configDir, createdPane = false, startAttempted = false, touchedPane = false, promptAttempted = false, unconfirmed = false;
  // Something in the pane needs an answer that routr does not give: a shell's own question, a harness's startup
  // question, an agent that has not started. The orchestrator gets what the pane shows (withheld once the task has been
  // sent: it shows the brief), herdr's reading when there is one, and `next`: how to carry on once it has answered.
  // It decides, and asks the user only for what is not its to answer (a password, a sign-in, a folder it did not make).
  let resumeSteps = () => [], rerun = () => null, recordOptions = null, cleanupArgs = null, adopted = false, planned = false;
  const needsInput = (code, why, text, more = {}) => {
    inputNeeded(code);
    out.ok = false; out.state = "needs_input";
    const { next: instruction, ...detail } = more;
    out.needs_input = { why, ...detail };
    out.screen = promptAttempted ? PANE_WITHHELD : shown(text ?? null);
    out.next.push(...(instruction == null ? resumeSteps() : Array.isArray(instruction) ? instruction : [doNext(instruction)]));
    step("needs_input", false, why); return out;
  };
  try {
    const o = parseLaunchArgs(args);
    out.warnings.push(...(o.leadWarnings ?? []));
    Object.assign(out, { kind: o.kind ?? null, name: o.name, pane: o.pane ?? null, cwd: resolve(o.cwd ?? "."), model: o.model ?? null, effort: o.effort ?? null });
    // The same launch, into the pane it stopped in: it carries on from the shell, or adopts the agent already
    // running there. A runnable command only when the task comes from a file: an inline --task is never printed
    // (it is the brief), so then the orchestrator is told to give it again (a placeholder in its place would
    // have been sent as the task).
    rerun = () => {
      const keep = [];
      for (let i = 0; i < args.length; i++) {
        if (["--worktree", "--base", "--direction", "--pane", "--cwd", "--copy", "--task"].includes(args[i])) { i++; continue; }
        keep.push(args[i]);
      }
      const again = ["routr", "launch", ...keep, "--pane", out.pane, "--cwd", out.cwd];
      return o.task != null ? doNext("Repeat the same launch with your --task given again.", templateCommand([...again, "--task", "<your-task>"]))
        : runNext("Continue this launch after resolving the pane's input.", again);
    };
    resumeSteps = () => out.pane ? [doNext(STARTUP_INPUT, templateCommand(["herdr", "pane", "send-keys", out.pane, "<keys>"])), rerun()] : [];
    if (!statSync(out.cwd).isDirectory()) throw new Error("--cwd must be a directory");
    const privateDir = join(tempRoot, `routr-cursor-${randomUUID()}`);
    const p = plan({ ...o, cwd: out.cwd, cursorConfigDir: privateDir });
    Object.assign(out, { start: { executable: p.executable, argv: p.argv, env: p.env }, warnings: [...out.warnings, ...p.warnings.filter((w) => !w.startsWith("Plan only:"))] });
    if (!o.model) out.next.push(doNext("Choose --model before launching"));
    if (o.kind === "kiro" && o.effort && o.effort !== "auto") out.next.push(doNext("Check the model’s /effort panel in the pane"));
    const task = o["task-file"] != null ? readTask(resolve(o["task-file"])) : o.task;
    if (task != null && !task.trim()) throw new Error("The task must not be empty");
    const rules = o["rules-file"] != null ? readFileSync(resolve(o["rules-file"]), "utf8") : null;
    if (rules != null && !rules.trim()) throw new Error("The rules file must not be empty");
    const prompt = task == null ? null : composePrompt(task, WORKER_GUIDE, rules);
    out.prompt_chars = prompt?.length ?? null;
    // Observed 2026-10-18: reviewers launched on a standing model choice without dispatch were later recorded with
    // another worker's advice. No escape flag: fallback dispatch still answers, while model and effort stay the lead's.
    let adviceProblem = null;
    if (task != null) {
      let problem = null;
      try {
        if (!o.advice) throw new Error("No advice file was supplied for this task. Run routr dispatch on the exact task and save what it prints, then launch with --advice <advice file>. Dispatch answers even when its decision model is unavailable.");
        const advice = dispatchAdvice(readAdvice(resolve(o.advice)));
        out.advice = { file: o.advice, matches: false };
        matchAdvice(advice, task);
        out.advice.matches = true; adviceForLaunch(advice.id);
        out.unavailable.push(...savedDecisionFailures(advice));
        recordOptions = { ...o, advice: resolve(o.advice), ...(o["task-file"] ? { "task-file": resolve(o["task-file"]) } : {}) };
      } catch (e) { problem = e.message; }
      if (problem) {
        if (o["task-file"]) out.next.push(runNext("Dispatch the exact task and save stdout as the advice file.",
          ["routr", "dispatch", "--task-file", resolve(o["task-file"])], resolve(`${o["task-file"]}.advice.json`)));
        else out.next.push(doNext("Save your exact inline task to a file, fill this dispatch template and save its stdout as advice, then launch with --advice; never borrow another worker's advice.", "routr dispatch --task-file <task-file>"));
        if (!o.dryRun) throw new Error(problem);
        adviceProblem = problem;
      }
    }
    // Known once the pane's shell has been seen; until then, this platform's usual shell.
    let shell = process.platform === "win32" ? "powershell" : "posix";
    // The carriers this launch hands on: a pane it splits (beside the caller, or in a worktree) gets the ones within
    // routr's limits, with a warning for each withheld; an existing pane gets none, said once. Only names and FORWARDED
    // reach the output.
    const found = launchCarriers(env);
    const paneCarriers = () => {
      if (!o.pane) {
        out.warnings.push(...launchCarrierWarnings(found));
        out.start.env = { ...out.start.env, ...Object.fromEntries(Object.keys(found.carriers).map((k) => [k, FORWARDED])) };
        return found.carriers;
      }
      const present = CARRIERS.filter((n) => Object.hasOwn(found.carriers, n) || found.withheld.includes(n));
      if (present.length) out.warnings.push(warning("carriers_not_passed", found.launchSpan
        ? "This launch did not pass its routr launch span or carriers to the worker: an existing pane keeps the environment its shell, or the agent already running there, started with, and routr never types a carrier into a shell"
        : PASSED_NONE(present)));
      return {};
    };
    const startArgs = (pane, timeout) => o.kind === "cursor" && SHELLS[shell].cursor
      ? ["pane", "run", pane, SHELLS[shell].cursor(privateDir, p.executable, p.argv)]
      : ["agent", "start", o.name, "--kind", o.kind, "--pane", pane, "--timeout", String(timeout), "--", ...p.argv];
    const promptArgs = (pane, timeout) => ["agent", "prompt", pane, prompt, "--wait", "--until", "working",
      "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(timeout)];
    if (o.dryRun) {
      const pane = o.pane ?? "<new-pane>", carried = paneCarriers();
      out.would_run = [
        ...(o.worktree ? [command(worktreeArgs(out.cwd, o.worktree, o.base)), command(splitArgs("right", "<worktree-path>", carried, { pane: "<root-pane>", shown: true })), command(["pane", "close", "<root-pane>"])] : []),
        ...(!o.pane && !o.worktree ? [...(!o.direction ? [command(["pane", "current", "--current"]), command(["pane", "layout", "--current"])] : []), command(splitArgs(o.direction ?? "<right-if-wide-else-down>", out.cwd, carried, { shown: true }))] : []),
        command(promptReadArgs(pane)),
        command(["pane", "process-info", "--pane", pane]),
        ...(o.pane ? [command(["pane", "run", pane, SHELLS[shell].cd(out.cwd)]),
          command(promptReadArgs(pane)), command(["pane", "process-info", "--pane", pane])] : []),
        ...(o.kind === "cursor" && SHELLS[shell].cursorEnv ? [command(["pane", "run", pane, SHELLS[shell].cursorEnv(privateDir)])] : []),
        command(startArgs(pane, Math.min(o.timeout, 30000))),
        command(["pane", "read", pane, "--source", "visible"]),
        command(["agent", "wait", pane, "--timeout", String(Math.min(1000, o.timeout))]),
        command(["pane", "read", pane, "--source", "visible"]),
        command(["agent", "get", pane]),
        ...(o.kind === "cursor" ? [command(["agent", "rename", pane, o.name])] : []),
        ...(prompt ? [promptForLog(promptArgs(pane, Math.max(1, Math.min(Math.floor(o.timeout / 2), 30000)))), command(["agent", "get", pane])] : []),
      ];
      step("plan", true, "No worker commands executed or worker files written. Pane ids, geometry, polling, timeouts and shell questions are resolved at launch. Environment, subscription settings and sign-in are not checked.");
      const problems = [!o.model && MODEL_REQUIRED, adviceProblem].filter(Boolean);
      planned = true; out.ok = !problems.length; out.state = "planned";
      if (problems.length) out.error = problems.join("; ");
      return out;
    }
    // A harness that runs its default model on an id it does not know, without a word (Kiro), is checked against its
    // own list of ids before any pane or headless worker. Kept until the harness refuses an unknown id itself.
    const checkListed = async () => {
      if (!HARNESSES[o.kind].unknownModelRunsDefault) return;
      let ids; try { ids = await models(o.kind); } catch { ids = null; }
      if (ids?.length && !ids.includes(o.model)) throw new Error(`${HARNESSES[o.kind].executable} does not list --model ${o.model}, and ${o.kind} runs its default model on an id it does not know. Its ids: \`${HARNESSES[o.kind].list}\``);
      if (ids?.length) step("model", true, `${o.model} is in ${o.kind}'s own list`);
      else if (env.HERDR_ENV === "1") { out.unavailable.push({ part: "model list", subscription: o.kind, code: "unreadable", why: `The ${o.kind} model list could not be read. Its model footer confirms which model started.` }); out.next.push(doNext("Look at the model footer in the pane before trusting the model choice")); }
      else { out.unavailable.push({ part: "model list", subscription: o.kind, code: "unreadable", why: `The ${o.kind} model list could not be read, so whether ${o.kind} runs this --model is not known: a headless worker shows no model footer.` }); out.next.push(doNext(`If the model choice matters, launch again once \`${HARNESSES[o.kind].list}\` answers, or use --model auto.`)); }
    };
    // Outside herdr the worker runs headless (workers.mjs): its own process holds the harness, and the lead waits on it
    // with routr wait instead of reading a pane.
    if (env.HERDR_ENV !== "1") {
      // Kiro's ACP mode takes an id it does not list too (session/new reports it as its model; p40): checked once the
      // subscription is on and signed in (asking a signed-out harness anything can open its sign-in), before anything
      // is written.
      try { await (await import("./workers.mjs")).launchHeadless(o, out, { prompt, env, settings, ready, spawn, checkListed }); }
      finally {
        startAttempted = out.steps.some((s) => s.step === "holder");
        promptAttempted = out.steps.some((s) => s.step === "prompt");
        if (out.worker) cleanupArgs = ["routr", "cleanup", "--worker", o.name];
      }
      return out;
    }
    const carried = paneCarriers();
    // The user turned this subscription off: it gets no work, launched by hand or not.
    const loaded = settings(), config = loaded.config ?? loaded;
    out.warnings.push(...(loaded.notes ?? []));
    if (config.subscriptions[o.kind]?.enabled === false) throw new Error(OFF.launch(HARNESSES[o.kind].label, o.kind));
    // A harness that is not signed in would wait at its own sign-in in a pane nobody watches: refuse before any pane.
    const signedOut = await ready(o.kind);
    if (signedOut) throw new Error(`${HARNESSES[o.kind].label} cannot take work: ${signedOut}`);
    const remaining = deadline(o.timeout, now, "Launch readiness timeout");
    // `shown`: the command as the log may carry it, when it differs from what runs (a split's carriers).
    const call = async (a, tolerate = false, shown = a) => {
      const ms = remaining();
      logCommand(out.ran, command(shown));
      const r = await safeRun(a, ms);
      if (!r.ok && !tolerate) throw processError(r);
      return r;
    };
    const pane = () => paneView(call, out.pane); // the pane id is known only once it is split or adopted
    const herdrCall = (a, shown, tolerate = false) => call(a, tolerate, shown); // as herdr.mjs's splitPane takes it
    const readPane = async () => { touchedPane = true; return pane().read(); };
    const readLines = async () => { touchedPane = true; return pane().unwrapped(); };
    const pause = async () => sleep(Math.min(250, remaining()));
    let shellCwd = null;
    const shellReady = async (expectedCwd) => {
      const r = await waitForShell({ ...pane(), unwrapped: readLines }, { sleep, now, remaining, cwd: expectedCwd, refuseBusy: Boolean(o.pane && !expectedCwd),
        onShell: (name) => { shell = shellFamily(name); } });
      if (!r.ok) return needsInput("shell_not_ready", r.why, r.text);
      shellCwd = r.cwd;
      step("shell_ready", true, `Interactive ${shell} shell in ${r.cwd}`); return null;
    };
    // --pane may name a pane where the agent asked for is already running (recovery from an earlier startup
    // question): launch adopts it and sends the task. A pane running another agent is refused; a pane with no
    // agent goes through the shell as before. What herdr makes of the question the agent stopped at: its rule
    // and the version of its rules for this harness, plus what the registry knows about that harness's startup
    // questions. This extra reading gets its own short allowance and can never turn needs_input into failed.
    // `agent get` gives herdr's last state, `agent explain` reads the screen now, and right after a question is
    // answered the two can disagree. Seen 2026-10-05 (Codex, rules 2026.10.01.1): the orchestrator answered
    // Codex's folder trust and repeated launch at once; get still said blocked, explain said idle
    // (osc_title_idle), and launch reported a ready agent as "waiting at a question", naming the idle rule as
    // the question. So a block counts only when explain reads it blocked too (or cannot be read).
    const explain = async () => {
      const a = ["agent", "explain", out.pane, "--json"];
      logCommand(out.ran, command(a));
      let x = null; try { x = (await safeRun(a, 2000)).data; } catch {}
      return { reads: x?.state ?? x?.result?.state, rule: x?.matched_rule?.id ?? x?.result?.matched_rule?.id, rules: x?.manifest_version ?? x?.result?.manifest_version };
    };
    const blockedAtStart = (h, text, { reads, rule, rules } = {}) => {
      const disagreed = typeof reads === "string" && reads !== "blocked";
      // A rule matched for another state is not the question's reason, so it is not given as one.
      const reading = disagreed ? ` (herdr's state says blocked, but its rules read the screen as ${stateWords(reads)}${rule ? ` by ${rule}` : ""}${rules ? `, rules ${rules}` : ""})`
        : rule ? ` (herdr reads it as ${rule}${rules ? `, rules ${rules}` : ""})` : "";
      return needsInput("startup_question", `${h.label} is waiting at a question before it can start${reading}.`, text,
        { herdr: { state: "blocked", ...(rule && !disagreed ? { rule } : {}), ...(disagreed ? { explained: reads } : {}), ...(rules ? { rules } : {}) }, ...(h.startup ? { note: h.startup } : {}) });
    };
    // Only an idle agent of that kind, in that folder, is adopted : one elsewhere would get a task meant for --cwd,
    // and a working one would get a second task when it finished. launch never waits on an agent it did not
    // start, and decides from one reading, now: herdr's `agent wait` can see such an agent work and finish
    // inside one wait (it matches idle, done, and blocked), and so can any later read, so waiting for one read
    // unknown or working to become idle could hand a busy worker a second task. A refusal costs the
    // orchestrator one more launch. The screen on a refusal is extra: a read that fails or runs out of time
    // leaves it out rather than turning the refusal into failed.
    let stop = null;
    if (o.pane) {
      const occupant = (await call(["agent", "get", out.pane], true)).data?.result?.agent;
      if (occupant?.agent) {
        const screen = async () => { try { return await readPane(); } catch { return null; } };
        const other = { next: "Choose another pane, or leave --pane off" };
        const notWaiting = async (state) => needsInput("worker_busy", `The ${o.kind} in the pane is ${stateWords(state)}, not waiting for a task`, await screen(), { next: [runNext("Wait until this worker is idle before repeating the launch.", ["herdr", "agent", "wait", out.pane, "--until", "idle"]), rerun()] });
        if (occupant.agent !== o.kind) return needsInput("wrong_harness", `The pane runs ${occupant.agent}, not ${o.kind}`, await screen(), other);
        const where = occupant.foreground_cwd ?? occupant.cwd;
        const same = (() => { try { return realPath(where) === realPath(out.cwd); } catch { return false; } })();
        if (!same) return needsInput("wrong_folder", `The ${o.kind} in the pane works in ${where ?? "a folder herdr does not report"}, not ${out.cwd}`, await screen(), other);
        let status = occupant.agent_status ?? "unknown";
        if (status === "blocked") {
          // herdr's state may be stale (above): its live reading decides, once. Idle (or done) is a block already answered.
          const x = await explain();
          if (x.reads === "blocked" || typeof x.reads !== "string") return blockedAtStart(HARNESSES[o.kind], await screen(), x);
          if (!["idle", "done"].includes(x.reads)) return await notWaiting(x.reads);
          step("explain", true, `herdr's state said blocked, but its rules read the screen as ${x.reads}${x.rule ? ` by ${x.rule}` : ""}: the question was answered`);
          status = x.reads;
        }
        if (!["idle", "done"].includes(status)) return await notWaiting(status);
        // Pane-run agents such as Cursor have unknown (null/absent) readiness; only explicit false vetoes idle/done.
        if (occupant.interactive_ready === false && occupant.agent_status !== "blocked") return await notWaiting(`${status} but not ready for input`);
        adopted = true; step("adopt", true, `${o.kind} is already running in ${out.pane}, ${status}, in ${out.cwd}: launch sends it the task (its model and effort are the ones it runs; not changed)`);
      }
    }
    if (!adopted) await checkListed();
    // Check Cursor's copy before creating a pane; never fall back to its account config.
    if (o.kind === "cursor" && !adopted) {
      configDir = privateDir;
      mkdirSync(configDir, { mode: 0o700 });
      copyFileSync(cursorConfigSource, join(configDir, "cli-config.json"));
      chmodSync(join(configDir, "cli-config.json"), 0o600);
      step("cursor_config", true, `Private config at ${configDir}; the pane's shell removes it when Cursor (or the shell) exits`);
    }
    const repoCwd = out.cwd;
    if (!out.pane && o.worktree) {
      // The rule for workers: each gets its own git worktree. herdr opens it as a workspace NESTED under the repository
      // in the sidebar, so the lead's tab stays clean and even a read-only worker cannot touch the main checkout.
      // --base starts its branch at another commit (stacked work, a reviewer of one commit); herdr takes it as is.
      const r = await call(worktreeArgs(out.cwd, o.worktree, o.base));
      const w = r.data?.result;
      if (!r.ok || typeof w?.root_pane?.pane_id !== "string" || typeof w?.worktree?.path !== "string") {
        throw new Error("herdr worktree create returned an answer routr cannot read (herdr_invalid_response)");
      }
      const root = w.root_pane.pane_id; out.cwd = w.worktree.path;
      out.worktree = { branch: o.worktree, ...(o.base ? { base: o.base } : {}), path: w.worktree.path, workspace: w.workspace?.workspace_id ?? null };
      // How this worker is finished: never by closing its pane, which closes the workspace and leaves the worktree.
      cleanupArgs = ["routr", "cleanup", "--cwd", repoCwd, "--worktree", o.worktree];
      step("worktree", true, `Created ${out.cwd} on branch ${o.worktree}${o.base ? ` from ${o.base}` : ""}, workspace ${out.worktree.workspace}, root pane ${root}`);
      // A worktree holds tracked files only. --copy brings named untracked files or folders (a local config, test data)
      // across from the main checkout, at the same relative path.
      for (const rel of o.copy ?? []) {
        const from = join(repoCwd, rel), to = join(out.cwd, rel);
        if (!existsSync(from)) { out.warnings.push(warning("copy_missing", `--copy ${rel}: not found in ${repoCwd}; skipped`)); continue; }
        ensureParent(to); cpSync(from, to, { recursive: true });
        step("copy", true, `Copied ${rel} into the worktree`);
      }
      // The worker gets a pane of launch's own, with its carriers, never the root pane herdr opened (worktreePane);
      // cleanup --worktree finds the workspace whichever pane is left in it.
      let opened;
      try { opened = await worktreePane(herdrCall, root, out.cwd, carried); }
      catch (e) { throw new Error(`launch created the worktree ${out.cwd} but could not open the worker's pane in it (${e?.message ?? e}); remove the worktree with ${displayCommand(cleanupArgs)}`); }
      out.pane = opened.pane;
      step("split", true, `Created ${out.pane}, right of ${root}, in the worktree`);
      // A root pane left open makes the worker's pane one of two in its workspace, and cleanup --pane (which a later
      // --pane rerun would give) closes a pane that is not a worktree's only one: the worktree would be left
      // behind. Nothing runs yet, so the launch ends here, and its cleanup is the worktree's.
      if (!opened.closed) throw new Error(`launch created the worktree ${out.cwd} but could not close ${root}, the shell pane herdr opened with it, so its workspace has an extra shell pane; no agent was started. Remove the worktree with ${displayCommand(cleanupArgs)}`);
      step("close_root", true, `Closed ${root}, the shell pane herdr opened with the worktree`);
    } else if (!out.pane) {
      let direction = o.direction;
      if (!direction) {
        const current = (await call(["pane", "current", "--current"])).data.result.pane;
        const layout = (await call(["pane", "layout", "--current"])).data.result.layout;
        const rect = layout.panes.find((p) => p.pane_id === current.pane_id)?.rect;
        if (!rect) throw new Error("Caller pane geometry is unavailable");
        direction = rect.width > rect.height ? "right" : "down";
      }
      out.pane = await splitPane(herdrCall, direction, out.cwd, carried);
      createdPane = true;
      step("split", true, `Created ${out.pane}, ${direction}`);
    }
    // A pane given with --pane may be a worktree's own: cleanup then says to clean up the worktree instead.
    cleanupArgs ??= ["routr", "cleanup", "--pane", out.pane];
    // Every folder this launch will type into a cmd shell is checked as soon as the shell is known, so a refusal comes
    // before anything is typed, not between a `cd` and the variable.
    const typable = () => { if (shell === "cmd" && !cmdTypable(...(o.pane ? [out.cwd] : []), ...(o.kind === "cursor" ? [privateDir] : []))) throw new Error(CMD_PATH); };
    // A pane we split already opened in --cwd; one adopted from the caller must be checked before we type `cd`.
    if (o.pane && !adopted) {
      stop = await shellReady(); if (stop) return stop;
      typable();
      // Only when the shell is elsewhere: a `cd` runs the shell's directory hooks again, and a hook that asks (a dotenv
      // plugin) would ask again every time launch was retried (seen 2026-09-28).
      const same = (() => { try { return realPath(shellCwd) === realPath(out.cwd); } catch { return false; } })();
      if (!same) { await call(["pane", "run", out.pane, SHELLS[shell].cd(out.cwd)]); await pause(); }
    }
    if (!adopted) { stop = await shellReady(out.cwd); if (stop) return stop; typable(); }
    if (o.kind === "cursor" && SHELLS[shell].cursorEnv && !adopted) {
      await call(["pane", "run", out.pane, SHELLS[shell].cursorEnv(privateDir)]);
      await pause();
      stop = await shellReady(out.cwd); if (stop) return stop;
      step("cursor_env", true, `Set CURSOR_CONFIG_DIR in the pane's ${shell} shell`);
    }
    // After the start: wait until herdr says the agent is ready, and check it took the model. routr answers no question
    // a harness asks at startup: it passes each harness's own flags so none is asked (the registry), and when one is
    // asked anyway herdr reports the agent blocked, and the orchestrator gets herdr's reading of it and the screen.
    // (Screen patterns for trust dialogs broke with harness releases: Claude Code 2.1.284 reversed its options and
    // dropped their numbers, 2026-09-28.) Returns null when ready, or what needs a person. Only for an agent this launch
    // started: it has no task of its own, so waiting through its start cannot hand it a second one. A blocked state
    // whose explain reads another state is herdr catching up (above), so the wait goes on; if the two still disagree
    // when the time runs out, inside a call or between calls, the block is reported from the readings already taken.
    // Two readings, not one, before a task is sent: a harness whose startup (its session hooks, under load) is still
    // running can read ready once and drop a task pasted into it (seen 2026-10-11: Claude in a new worktree never
    // received a 3,783-character task that herdr's prompt reported stalled). And herdr can briefly see no agent while a
    // harness started through a wrapper (Cursor's) hands over to its own process: agent_not_running is waited through
    // for a moment, and fails the launch only if it lasts (seen the same day under heavy load; three quiet relaunches
    // did not show it).
    const SETTLE_MS = 1500, GONE_GRACE_MS = 5000;
    const awaitReady = async (text) => {
      const h = HARNESSES[o.kind];
      const left = () => { try { return remaining(); } catch { return 0; } };
      let disagreed = null; // { text, reading } while herdr's state says blocked and its explain reads another state
      let readySince = null, goneSince = null;
      for (;;) {
        try {
          const waited = await call(["agent", "wait", out.pane, "--timeout", String(Math.min(1000, remaining()))], true);
          const code = waited.data?.error?.code;
          if (!waited.ok && code === "agent_not_running") {
            // A question read before it went is no longer what the pane shows: the exit is (an old blocked reading was
            // reported at the deadline instead of the harness's own message).
            goneSince ??= now(); disagreed = null; readySince = null;
            if (now() - goneSince > GONE_GRACE_MS) throw new Error("The agent is no longer running (herdr_refused)");
            await pause(); continue;
          }
          if (!waited.ok && !["timeout", "agent_not_found", "agent_not_ready"].includes(code)) throw processError(waited);
          goneSince = null;
          text = await readPane();
          const got = await call(["agent", "get", out.pane], true);
          if (!got.ok && got.data?.error?.code !== "agent_not_found") throw processError(got);
          const agent = got.data?.result?.agent;
          // Close only a pane this launch made: one passed in with --pane may hold someone else's work.
          if (agent && agent.agent !== o.kind) return needsInput("wrong_harness", `The pane runs ${agent.agent}, not ${o.kind}`, text, { next: createdPane ? `Close the pane this launch made (herdr pane close ${out.pane}) and launch again` : "Leave that pane; choose another, or leave --pane off" });
          if (agent?.agent_status === "blocked") {
            const x = await explain();
            if (x.reads === "blocked" || typeof x.reads !== "string") return blockedAtStart(h, text, x);
            disagreed = { text, reading: x };
          // Herdr's state has moved on, or there is no agent any more: no disagreement left to report. A vanished agent
          // kept the old one, and the deadline reported a block it no longer saw instead of failing.
          } else disagreed = null;
          // Pane-run agents such as Cursor have unknown (null/absent) readiness; only explicit false vetoes idle/done.
          if (got.ok && waited.ok && ["idle", "done"].includes(agent?.agent_status) && agent.interactive_ready !== false) {
            readySince ??= now();
            if (now() - readySince >= SETTLE_MS) break;
          } else readySince = null;
          await pause();
        } catch (e) {
          if (disagreed && left() <= 0) return blockedAtStart(h, disagreed.text, disagreed.reading);
          throw e;
        }
      }
      // pane-run: herdr did not get the name.
      if (o.kind === "cursor" && SHELLS[shell].cursor) await call(["agent", "rename", out.pane, o.name]);
      return null;
    };
    // Submit the task once and let herdr say whether the worker took it. herdr sends the text and Enter as one
    // submission, in the pane's paste mode, and reports the agent's lifecycle state; its own rule is that a stalled or
    // timed-out prompt does not prove the task was not delivered, so it is never sent again and no key is pressed for
    // it. A harness can hold a task until it has finished starting (Codex queued one behind "Waiting for startup",
    // 2026-09-28), and a slow link delays everything, so a prompt with no activity yet is waited on, by state, for the
    // rest of the launch timeout. Reading the screen for traces of the task, and resending or pressing Enter on what it
    // showed, sent a task twice into Codex's box the same day: that is no longer done.
    const submitPrompt = async () => {
      // Reserve time to inspect the result.
      const budget = remaining();
      if (budget < 2) throw new Error("No time left to submit and verify the prompt");
      const submitMs = Math.min(30000, Math.floor(budget / 2));
      const a = promptArgs(out.pane, submitMs);
      logCommand(out.ran, promptForLog(a));
      promptAttempted = true;
      let r = await safeRun(a, Math.min(remaining(), submitMs + Math.min(1000, Math.floor((budget - submitMs) / 2))));
      if (!r.ok && r.code === "herdr_unreachable" && r.data?.error?.code !== "timeout") throw processError(r);
      const quiet = !r.ok && ["agent_prompt_stalled", "timeout"].includes(r.data?.error?.code);
      if (quiet) {
        step("prompt_wait", true, "Sent once; herdr has not seen the agent start yet, so launch waits on its state and sends nothing again");
        const w = ["agent", "wait", out.pane, "--until", "working", "--until", "blocked", "--timeout", String(Math.max(1, remaining() - 500))];
        logCommand(out.ran, command(w));
        r = await safeRun(w, Math.max(1, remaining()));
      }
      // The outcome is decided by this one read. It gets its own short allowance, not what is left of the launch
      // timeout, so a wait that used that up cannot turn needs_input into failed (from the verification of #46). No
      // pane read follows: once the task is sent the pane may show the brief, and launch never prints it.
      logCommand(out.ran, command(["agent", "get", out.pane]));
      const got = await safeRun(["agent", "get", out.pane], 2000);
      if (!got.ok) throw processError(got);
      const agent = got.data?.result?.agent;
      const status = agent?.agent_status ?? "unknown";
      // The task is wrapped (opening, rules, closing) by launch, so a task that never arrived is sent again by launch
      // too, adopting the agent already in the pane: the orchestrator has no copy of the wrapped text to prompt with.
      const again = rerun();
      const sent = { next: [
        doNext("The task was sent: read the pane before answering a question or deciding whether it arrived.", templateCommand(["herdr", "agent", "read", out.pane])),
        doNext("Press Enter only if the task sits unsent in the input box; inspect the pane first.", templateCommand(["herdr", "agent", "send-keys", out.pane, "enter"])),
        doNext("Do not launch it again while the task may be there. If the input box is empty and the agent never started, it never arrived: send it with the same launch template.", again.kind === "run" ? templateCommand(again.argv) : again.template)] };
      if (agent?.agent !== o.kind) { unconfirmed = true; return needsInput("identity_unknown", "Cannot confirm the prompted agent's identity", null, sent); }
      if (status === "blocked") {
        step("prompt", r.ok, `Submitted ${prompt.length} characters; the agent is asking something`);
        return needsInput("worker_question", "The worker is asking a question or an approval right after its prompt", null, { ...sent, herdr: { state: "blocked" } });
      }
      // Working is always a start. Idle or done count when herdr's wait (the prompt's own, or the one after a quiet
      // prompt) saw the agent working first: a short task can finish before this read.
      if (status === "working" || (r.ok && ["idle", "done"].includes(status))) {
        step("prompt", true, `Submitted ${prompt.length} characters; the agent settled at ${status}`);
        out.state = "prompted";
        return null;
      }
      step("prompt", false, `Sent once; the agent never started (${stateWords(status)})`);
      return needsInput("start_unconfirmed", `The task was sent once and the agent has not started within the timeout (${stateWords(status)}); launch never sends it twice.`, null, { ...sent, herdr: { state: status } });
    };
    let text = null;
    if (!adopted) {
      const startCommand = startArgs(out.pane, Math.min(30000, remaining()));
      startAttempted = true;
      const started = await call(startCommand, true);
      step("start", started.ok, started.ok ? "Herdr accepted the launch" : started.why);
      text = await readPane();
      const startError = started.data?.error?.code;
      if (!started.ok && !["agent_not_ready", "timeout"].includes(startError)) {
        throw processError(started);
      }
      stop = await awaitReady(text); if (stop) return stop;
      step("ready", true, "herdr reports the agent ready for input");
    }
    out.state = "ready"; out.ok = true;
    if (prompt) stop = await submitPrompt();
    // The name the orchestrator will use for an adopted agent, given once the task is in (whatever herdr then
    // reports), so a rename that hangs cannot take the submission's time (from the verification of d47051e: it
    // used all of --timeout, and the task was never sent). Its own short allowance, like explain's; a failure
    // costs only the name. Not when the outcome read could not confirm the agent it prompted: the pane may hold
    // another agent by then, and the name would go to it.
    if (adopted && !unconfirmed) {
      const a = ["agent", "rename", out.pane, o.name];
      logCommand(out.ran, command(a));
      let renamed = null; try { renamed = await safeRun(a, 2000); } catch {}
      if (!renamed?.ok) { out.warnings.push(warning("rename_failed", `Could not rename the adopted agent to ${o.name}`)); out.next.push(doNext(`Address this worker by its pane, ${out.pane}`)); }
    }
    if (stop) return stop;
  } catch (e) {
    out.ok = false; out.state = "failed"; out.error = `${promptAttempted ? "Launch failed after prompt submission: " : ""}${String(e?.message ?? e)}`; step("failed", false, out.error);
    // The harness may have exited with its own complaint (a model id it does not accept, a login it wants). That
    // message is on the pane and nowhere else, and without it the orchestrator only learns that something timed out.
    if (out.pane && touchedPane && promptAttempted) out.screen = PANE_WITHHELD; // sent: the pane may show the brief, so it is not read
    else if (out.pane && touchedPane) {
      try {
        const a = promptReadArgs(out.pane);
        logCommand(out.ran, command(a));
        const tail = shown(clean(paneText((await safeRun(a, 1000)).data)))
          .split("\n").filter((l) => l.trim()).slice(-8).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l)).join("\n");
        if (tail) out.screen = tail;
      } catch {}
    }
  } finally {
    // No launch was attempted, so a failed new pane and an unused config cannot belong to a worker.
    if (createdPane && !startAttempted && out.state === "failed") {
      const a = ["pane", "close", out.pane];
      logCommand(out.ran, command(a));
      try {
        const closed = await safeRun(a, 1000);
        step("cleanup_pane", closed.ok, closed.ok ? `Closed unused pane ${out.pane}` : "Could not close unused pane");
        if (closed.ok) { createdPane = false; cleanupArgs = null; }
      } catch { step("cleanup_pane", false, "Could not close unused pane (herdr_unreachable)"); }
    }
    if (configDir && !startAttempted) {
      try { rmSync(configDir, { recursive: true, force: true }); step("cleanup_config", true, "Removed unused Cursor config"); }
      catch (e) { out.warnings.push(warning("cursor_config_left", `Could not remove unused Cursor config ${configDir}`)); }
    }
    if (createdPane && !out.ok) { out.warnings.push(warning("pane_left", `Pane ${out.pane} was left alive`)); if (out.state !== "needs_input") out.next.push(doNext(`Inspect pane ${out.pane} before closing it or retrying`)); }
    if (configDir && startAttempted && !out.ok) { out.warnings.push(warning("cursor_config_retained", `Cursor config ${configDir} is retained for a possible running worker`)); out.next.push(doNext(`Remove the private Cursor config ${configDir} if the launch command did not run`)); }
    if (promptAttempted && out.state !== "prompted") { out.warnings.push(warning("prompt_uncertain", "Prompt may have been submitted")); out.next.push(out.worker ? runNext("Look at the worker before retrying.", ["routr", "workers", "--name", out.name]) : doNext(`Inspect pane ${out.pane} before retrying`)); }
    out.headline = out.state === "planned" ? `routr: planned ${out.kind} launch, nothing ran${out.error ? `; a real launch would refuse: ${out.error}` : ""}`
      : out.state === "prompted" ? `routr: ${out.name} (${out.kind}) took its task${out.worker ? ", running headless" : ` in pane ${out.pane}`}`
      : out.state === "ready" ? `routr: ${out.name} is ready in pane ${out.pane}; no task sent`
      : out.state === "needs_input" ? `routr: ${out.name} needs input in pane ${out.pane}: ${out.needs_input.why}`
      : `routr: launch failed: ${out.error}`;
    // Return paths share this finally block: put the envelope first even for early refusals and planned launches.
    const ordered = answer(out); for (const key of Object.keys(out)) delete out[key]; Object.assign(out, ordered);
    out.next = launchNext(out.next, { record: recordOptions, cleanup: cleanupArgs, adopted,
      attempted: startAttempted || promptAttempted, planned, submitted: promptAttempted, failed: out.state === "failed" });
  }
  return out;
}

export function launch(args, opts = {}) {
  const lead = takeLeadSession(args); args = [...lead.args, ...(lead.lead ? ["--lead-session", lead.lead] : [])];
  return commandTrace("launch", () => { const loaded = (opts.settings ?? (() => loadConfig()))(); return { config: loaded.config ?? loaded, ...opts, cwd: args.includes("--cwd") ? args[args.indexOf("--cwd") + 1] : undefined, lead: lead.lead }; }, async () => { const r = await launchBody(args, opts); r.warnings.push(...lead.warnings); try { await completeLaunch(r, opts.run ?? runHerdr, { rerun: args.includes("--pane") }); } catch {} return r; });
}
