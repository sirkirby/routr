import { adviceForLaunch, commandTrace, completeLaunch, launchCarriers } from "./traces.mjs";
import { takeLeadSession } from "./trace-context.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configOf, loadConfig, oneReading } from "./config.mjs";
import { HARNESSES, kindError, notReady, plan, MODEL_REQUIRED } from "./harnesses.mjs";
import { dispatchAdvice, matchAdvice, readAdvice, readTask, savedDecisionFailures } from "./advice-file.mjs";
import { doNext, launchNext, runNext } from "./next.mjs";
import { CLOSING } from "./wording.mjs";
import { BRANCH, runHerdr, SHELLS, splitArgs, worktreeArgs } from "./herdr.mjs";
import { answer } from "./output.mjs";
import { recordLaunch } from "./launch-history.mjs";
import { projectName } from "./ledger.mjs";
import { fallbackAdvice } from "./output.mjs";
import { executionFor } from "./backends.mjs";
import { launchFailed } from "./launch-answer.mjs";
import { command, fallbackEnvOf, launchPane, paneCarriers, paneFallbacks, panePromptArgs, paneStartArgs, promptForLog, usualShell } from "./backend-pane.mjs";
import { client } from "./hc.mjs";
import { home, NAME_RULE, selfCommand, WORKER_NAME, spawnSelf } from "./runtime.mjs";

// The worker guide a launch prompt points at. From source it sits beside this file; a compiled binary has no files
// around it, so it points at the installed skill (written by the installer or `routr skill install`).
const besideSource = fileURLToPath(new URL("../../skills/routr/references/worker.md", import.meta.url));
export const WORKER_GUIDE = () => existsSync(besideSource) ? besideSource : join(home(), ".agents/skills/routr/references/worker.md");
// The first words of every launch prompt.
export const PROMPT_OPENING = "You are a routr worker.";
// `rules` is the lead's process text (what the worker may and may not do, how to report, git steps): the worker reads it
// after the task, and routr never does. Only the task is the work that `dispatch` and `--advice` judge. (Measured
// 2026-09-26: 18 of 36 real tasks carried such text, 5 to 38% of each, and it moved Jev's readings.)
export function composePrompt(task, guide = WORKER_GUIDE(), rules = null) {
  return `${PROMPT_OPENING} Your first action, before any other tool call, is to read the routr worker guide at ${guide}. It is mandatory for this task: it says how to size each subagent before you spawn it and the exact report format the orchestrator parses.\n\n${task}${rules ? `\n\n${rules.trim()}` : ""}\n\n${CLOSING}`;
}

export function parseLaunchArgs(args) {
  const lead = takeLeadSession(args); args = lead.args;
  const o = { timeout: 120000, dryRun: false, ...(lead.lead ? { "lead-session": lead.lead } : {}), ...(lead.warnings.length ? { leadWarnings: lead.warnings } : {}) };
  const values = ["kind", "name", "cwd", "model", "effort", "subagent-model", "subagent-effort", "pane", "worktree", "base", "direction", "task", "task-file", "rules-file", "timeout", "advice"];
  // PowerShell's IsSingleQuote/IsDoubleQuote (CharTraits.cs): ASCII quotes and U+2018–U+201E, but not U+201F.
  // Herdr encodes the command for the pane's shell; refuse these on all paths so the same launch stays portable.
  const choices = ["model", "effort", "subagent-model", "subagent-effort"];
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
    if (choices.includes(key) && /['"\u2018-\u201e]/.test(args[i + 1])) throw new Error(`--${key} must not contain quote characters recognized by PowerShell (ASCII quotes or U+2018–U+201E)`);
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
  if (!WORKER_NAME.test(o.name ?? "")) throw new Error(`--name must match ${NAME_RULE}`);
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
  cursorConfigSource = join(home(), ".cursor", "cli-config.json"), tempRoot = tmpdir(), models = (kind) => HARNESSES[kind].models?.(), spawn = spawnSelf, hc = client, self = selfCommand } = {}) {
  const out = { ok: false, state: "failed", kind: null, name: null, pane: null, cwd: resolve("."), model: null, effort: null,
    ran: [], next: [], start: { executable: null, argv: [], env: {} }, steps: [], warnings: [], prompt_chars: null, unavailable: [] };
  const step = (step, ok, detail) => out.steps.push({ step, ok, detail });
  // Where this launch runs (backends.mjs): what the trace says, whatever becomes of the launch, a refusal of its arguments too.
  let backend = executionFor(env), outcome = { attempted: false, submitted: false, adopted: false, cleanup: null }, recordOptions = null, planned = false, advised = null;
  // `next` is built once the launch has its identity (launch, below): its record template carries it.
  const finish = (launchId) => {
    out.next = launchNext(out.next, { record: recordOptions, cleanup: outcome.cleanup, adopted: outcome.adopted, launchId,
      attempted: outcome.attempted, planned, submitted: outcome.submitted, failed: out.state === "failed" });
  };
  const done = () => ({ out, backend, finish, adopted: outcome.adopted, advised });
  try {
    const o = parseLaunchArgs(args);
    out.warnings.push(...(o.leadWarnings ?? []));
    Object.assign(out, { kind: o.kind ?? null, name: o.name, pane: o.pane ?? null, cwd: resolve(o.cwd ?? "."), model: o.model ?? null, effort: o.effort ?? null });
    if (!statSync(out.cwd).isDirectory()) throw new Error("--cwd must be a directory");
    const privateDir = join(tempRoot, `routr-cursor-${randomUUID()}`);
    // A harness that names its folder in its command (Antigravity's --add-dir) is planned for the worktree: a
    // placeholder until herdr has made it, then planned again for its path (issue #22: it was given the main checkout,
    // where a worker launched into its own worktree would have written).
    const planFor = (cwd) => plan({ ...o, cwd, cursorConfigDir: privateDir, subagentModel: o["subagent-model"], subagentEffort: o["subagent-effort"] });
    const p = planFor(o.worktree ? "<worktree-path>" : out.cwd);
    Object.assign(out, { start: { executable: p.executable, argv: p.argv, env: p.env }, warnings: [...out.warnings, ...p.warnings.filter((w) => !w.startsWith("Plan only:"))] });
    if (!o.model) out.next.push(doNext("Choose --model before launching"));
    if (o.kind === "kiro" && o.effort && o.effort !== "auto") out.next.push(doNext("Check the model’s /effort panel in the pane"));
    const task = o["task-file"] != null ? readTask(resolve(o["task-file"])) : o.task;
    if (task != null && !task.trim()) throw new Error("The task must not be empty");
    const rules = o["rules-file"] != null ? readFileSync(resolve(o["rules-file"]), "utf8") : null;
    if (rules != null && !rules.trim()) throw new Error("The rules file must not be empty");
    const prompt = task == null ? null : composePrompt(task, WORKER_GUIDE(), rules);
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
        out.advice.matches = true; adviceForLaunch(advice.id); advised = advice;
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
    if (o.dryRun) {
      const shell = usualShell();
      const startArgs = (pane, timeout) => paneStartArgs(o, shell, p, privateDir, pane, timeout), promptArgs = (pane, timeout) => panePromptArgs(prompt, pane, timeout);
      const pane = o.pane ?? "<new-pane>", carried = paneCarriers(o, out, launchCarriers(env)), extraEnv = paneFallbacks(o, out, fallbackEnvOf(o, p, privateDir));
      out.would_run = [
        ...(o.worktree ? [command(worktreeArgs(out.cwd, o.worktree, o.base)), command(splitArgs("right", "<worktree-path>", carried, { pane: "<root-pane>", shown: true, env: extraEnv })), command(["pane", "close", "<root-pane>"])] : []),
        ...(!o.pane && !o.worktree ? [...(!o.direction ? [command(["pane", "current", "--current"]), command(["pane", "layout", "--current"])] : []), command(splitArgs(o.direction ?? "<right-if-wide-else-down>", out.cwd, carried, { shown: true, env: extraEnv }))] : []),
        command(["pane", "read", pane, "--source", "visible"]),
        command(["pane", "process-info", "--pane", pane]),
        ...(o.pane ? [command(["pane", "run", pane, SHELLS[shell].cd(out.cwd)]),
          command(["pane", "read", pane, "--source", "visible"]), command(["pane", "process-info", "--pane", pane])] : []),
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
      return done();
    }
    // A harness that runs its default model on an id it does not know, without a word (Kiro), is checked against its
    // own list of ids before any pane or headless worker. Kept until the harness refuses an unknown id itself.
    const checkListed = async () => {
      if (!HARNESSES[o.kind].unknownModelRunsDefault) return;
      let ids; try { ids = await models(o.kind); } catch { ids = null; }
      if (ids?.length && !ids.includes(o.model)) throw new Error(`${HARNESSES[o.kind].executable} does not list --model ${o.model}, and ${o.kind} runs its default model on an id it does not know. Its ids: \`${HARNESSES[o.kind].list}\``);
      if (ids?.length) step("model", true, `${o.model} is in ${o.kind}'s own list`);
      else if (backend !== "headless") { out.unavailable.push({ part: "model list", subscription: o.kind, code: "unreadable", why: `The ${o.kind} model list could not be read. Its model footer confirms which model started.` }); out.next.push(doNext(`Look at the model footer in ${backend === "pane" ? "the pane" : "its terminal"} before trusting the model choice`)); }
      else { out.unavailable.push({ part: "model list", subscription: o.kind, code: "unreadable", why: `The ${o.kind} model list could not be read, so whether ${o.kind} runs this --model is not known: a headless worker shows no model footer.` }); out.next.push(doNext(`If the model choice matters, launch again once \`${HARNESSES[o.kind].list}\` answers, or use --model auto.`)); }
    };
    // Outside herdr the worker runs headless: its own process holds the harness, and the lead waits on it with routr wait
    // instead of reading a pane. Kiro's ACP mode takes an id it does not list too (session/new reports it as its model;
    // p40): checked once the subscription is on and signed in (asking a signed-out harness anything can open its sign-in),
    // before anything is written.
    if (backend === "headless") outcome = await (await import("./backend-headless.mjs")).launchHeadless(o, out, { prompt, env, settings, ready, spawn, checkListed });
    // In a core terminal the harness runs for a person to see, in a tab of its own, and the lead follows it with hc.
    else if (backend === "terminal") outcome = await (await import("./backend-terminal.mjs")).launchTerminal(o, out, { prompt, env, settings, ready, checkListed, hc, self, sleep, now });
    else outcome = await launchPane(args, o, out, { run, sleep, now, env, ready, settings, cursorConfigSource, prompt, p, planFor, privateDir, checkListed });
  } catch (e) {
    launchFailed(out, e, false);
  } finally {
    const inTerminal = out.worker?.backend === "terminal" ? `in terminal ${out.worker.terminal}` : null;
    out.headline = out.state === "planned" ? `routr: planned ${out.kind} launch, nothing ran${out.error ? `; a real launch would refuse: ${out.error}` : ""}`
      : out.state === "prompted" ? `routr: ${out.name} (${out.kind}) took its task${inTerminal ? ` ${inTerminal}` : out.worker ? ", running headless" : ` in pane ${out.pane}`}`
      : out.state === "ready" ? `routr: ${out.name} is ready in pane ${out.pane}; no task sent`
      : out.state === "needs_input" ? `routr: ${out.name} needs input ${inTerminal ?? `in pane ${out.pane}`}: ${out.needs_input.why}`
      : `routr: launch failed: ${out.error}`;
    // Return paths share this finally block: put the envelope first even for early refusals and planned launches.
    const ordered = answer(out); for (const key of Object.keys(out)) delete out[key]; Object.assign(out, ordered);
  }
  return done();
}

// One identity per launch, made here, whether or not anything is exported: its trace's `routr.launch.id` (a `--pane`
// recovery rerun links to the launch it finishes, with its own id), its history record, its answer's `launch_id` and its
// record template's `--launch`.
export function launch(args, opts = {}) {
  const lead = takeLeadSession(args); args = [...lead.args, ...(lead.lead ? ["--lead-session", lead.lead] : [])];
  const settings = oneReading(opts.settings), made = randomUUID();
  return commandTrace("launch", () => ({ config: configOf(settings()), ...opts, cwd: args.includes("--cwd") ? args[args.indexOf("--cwd") + 1] : undefined, lead: lead.lead, launchId: made }), async () => { const { out: r, backend, finish, adopted, advised } = await launchBody(args, { ...opts, settings }); r.warnings.push(...lead.warnings);
    // A worker that took its task, or was left ready for one, counts toward the user's launch share (shares.mjs). A dry
    // run, a refusal and a failed start count nothing; a --pane rerun that finishes a failed launch counts once. A terminal
    // worker stopped at a question has its task and goes on once answered: no rerun will count it later.
    const took = r.state === "prompted" || r.state === "ready" || (r.state === "needs_input" && r.worker?.backend === "terminal");
    try { await completeLaunch(r, opts.run ?? runHerdr, { rerun: args.includes("--pane"), backend }); } catch {}
    // Its history record: the decision as checked fields, never the task. An adopted pane's agent kept its own model and
    // effort, which launch cannot know. The project is the repository the worker's folder is in (its worktree's).
    r.launch_id = null;
    if (took) {
      r.launch_id = made;
      recordLaunch(r.launch_id, { subscription: r.kind, model: adopted ? null : r.model, effort: adopted ? null : r.effort,
        id: advised?.id, advised: advised && { level: advised.level, sure: advised.sure, between: advised.between, work_type: advised.work_type, high_risk: advised.high_risk, fallback: fallbackAdvice(advised),
          facts: Object.fromEntries(Object.entries(advised.facts ?? {}).map(([k, f]) => [k, f?.p])) },
        project: projectName(r.worktree?.path ?? r.cwd), backend, name: r.name }, { home: opts.home });
    }
    finish(r.launch_id); return r; });
}
