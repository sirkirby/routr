// The pane backend: a worker run interactively by its harness in a herdr pane, which the lead then follows through herdr.
// The whole lifecycle of one launch into a pane: its shell, its split or worktree, adopting an agent already there, the
// start and the prompt; what a launch that stopped part way leaves, and what to do about it.
import { warning } from "./warnings.mjs";
import { inputNeeded, launchCarriers } from "./traces.mjs";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configOf } from "./config.mjs";
import { configEnv, HARNESSES, privateConfigCopy } from "./harnesses.mjs";
import { displayCommand, doNext, runNext, templateCommand } from "./next.mjs";
import { OFF } from "./wording.mjs";
import { clean, CMD_PATH, cmdTypable, FISH_PATH, fishTypable, HERDR_PS_QUOTE, herdrTypable, deadline, paneText, paneView, promptReadArgs, SHELLS, shellFamily, splitArgs, splitPane, waitForShell, worktreeArgs, worktreePane } from "./herdr.mjs";
import { callHerdr, processError, processSteps, stateWords } from "./process-boundary.mjs";
import { launchFailed, STARTUP_INPUT } from "./launch-answer.mjs";
import { carrierValues, paneEnv, redactCarriers } from "./worker-env.mjs";
import { realPath } from "./state-files.mjs";

export const command = (args) => displayCommand(["herdr", ...args]);
// The command log is printed and may be stored by whoever called launch: it carries the prompt's length, never its
// text (the brief must not be printed, logged, or stored).
const PANE_WITHHELD = "withheld: the prompt was already submitted, so the pane shows the task. Read the pane yourself.";
export const promptForLog = (args) => command(args.map((a, i) => (args[0] === "agent" && args[1] === "prompt" && i === 3 ? `<prompt: ${String(a).length} chars>` : a)));
// Polling repeats the same read; record it once with a count so the result stays readable.
function logCommand(log, text) {
  const last = log.at(-1);
  if (last === text) { log[log.length - 1] = `${text}  (x2)`; return log; }
  const m = typeof last === "string" && last.match(/^(.*)  \(x(\d+)\)$/);
  if (m && m[1] === text) { log[log.length - 1] = `${m[1]}  (x${Number(m[2]) + 1})`; return log; }
  log.push(text); return log;
}

// Known once the pane's shell has been seen; until then, this platform's usual shell.
export const usualShell = () => (process.platform === "win32" ? "powershell" : "posix");
// A pane worker's environment (worker-env's paneEnv): the carriers this launch holds, and its plan's subagent
// fallbacks, less the names the harness adapter sets for itself.
export const paneEnvOf = (o, out, env, p, privateDir) => paneEnv({ pane: o.pane, found: launchCarriers(env), plan: p.env, adapter: configEnv(o.kind, privateDir), account: o.account?.env }, out);
// A harness with a private config folder (the registry's `privateConfig`) is started by the pane's own shell where that
// shell can remove the folder when it exits (SHELLS' `privateStart`), not by herdr's agent start; herdr then learns its
// name after (shellStarted). Everywhere else herdr starts it.
export const shellStarted = (o, shell) => Boolean(HARNESSES[o.kind]?.privateConfig && SHELLS[shell].privateStart);
export const paneStartArgs = (o, shell, p, privateDir, pane, timeout) => shellStarted(o, shell)
  ? ["pane", "run", pane, SHELLS[shell].privateStart(HARNESSES[o.kind].privateConfig.variable, privateDir, p.executable, p.argv)]
  : ["agent", "start", o.name, "--kind", o.kind, "--pane", pane, "--timeout", String(timeout), "--", ...p.argv];
// The line that gives the pane's shell the folder first, where the shell cannot start the harness itself (Windows).
export const paneConfigEnvArgs = (o, shell, privateDir, pane) => (HARNESSES[o.kind]?.privateConfig && SHELLS[shell].privateEnv
  ? ["pane", "run", pane, SHELLS[shell].privateEnv(HARNESSES[o.kind].privateConfig.variable, privateDir)] : null);
export const panePromptArgs = (prompt, pane, timeout) => ["agent", "prompt", pane, prompt, "--wait", "--until", "working",
  "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(timeout)];

// The pane commands a dry run reports, built at the pane boundary beside the commands a real launch executes.
export function paneDryRunPlan(o, out, { env, p, privateDir, prompt, shell = usualShell() }) {
  const startArgs = (pane, timeout) => paneStartArgs(o, shell, p, privateDir, pane, timeout);
  const promptArgs = (pane, timeout) => panePromptArgs(prompt, pane, timeout);
  const pane = o.pane ?? "<new-pane>", { carried, extraEnv, split = { shownEnv: extraEnv }, unset = [] } = paneEnvOf(o, out, env, p, privateDir);
  return [
    ...(o.worktree ? [command(worktreeArgs(out.cwd, o.worktree, o.base)), command(splitArgs("right", "<worktree-path>", carried, { pane: "<root-pane>", shown: true, env: split.shownEnv })), command(["pane", "close", "<root-pane>"])] : []),
    ...(!o.pane && !o.worktree ? [...(!o.direction ? [command(["pane", "current", "--current"]), command(["pane", "layout", "--current"])] : []), command(splitArgs(o.direction ?? "<right-if-wide-else-down>", out.cwd, carried, { shown: true, env: split.shownEnv }))] : []),
    command(["pane", "read", pane, "--source", "visible"]),
    command(["pane", "process-info", "--pane", pane]),
    ...(o.pane ? [command(["pane", "run", pane, SHELLS[shell].cd(out.cwd)]),
      command(["pane", "read", pane, "--source", "visible"]), command(["pane", "process-info", "--pane", pane])] : []),
    ...(paneConfigEnvArgs(o, shell, privateDir, pane) ? [command(paneConfigEnvArgs(o, shell, privateDir, pane))] : []),
    ...unset.map((name) => command(["pane", "run", pane, SHELLS[shell].unset(name)])),
    command(startArgs(pane, Math.min(o.timeout, 30000))),
    command(["pane", "read", pane, "--source", "visible"]),
    command(["agent", "wait", pane, "--timeout", String(Math.min(1000, o.timeout))]),
    command(["pane", "read", pane, "--source", "visible"]),
    command(["agent", "get", pane]),
    ...(HARNESSES[o.kind].privateConfig ? [command(["agent", "rename", pane, o.name])] : []),
    ...(prompt ? [promptForLog(promptArgs(pane, Math.max(1, Math.min(Math.floor(o.timeout / 2), 30000)))), command(["agent", "get", pane])] : []),
  ];
}

// Fills `out`, launch's answer, in place; its failures end here. Answers what launch needs to say next: `attempted` (a start
// or a prompt was tried), `submitted` (the prompt was), `adopted` (an agent already in the pane took it) and `cleanup` (how
// this worker is finished, when anything of it is left).
export async function launchPane(args, o, out, { run, sleep, now, env, ready, settings, cursorConfigSource, prompt, p, planFor, privateDir, checkListed }) {
  const privateConfig = HARNESSES[o.kind]?.privateConfig;
  const safeRun = async (args, ms) => processSteps(out, await callHerdr(run, args, ms));
  const step = (step, ok, detail) => out.steps.push({ step, ok, detail });
  // Every screen launch returns goes through here: a shell's startup line can print the trace-context carriers
  // routr holds (found, generated, passed or withheld). The generated launch parent belongs to the same
  // redaction set.
  const hidden = [...carrierValues(env), ...Object.values(launchCarriers(env).carriers)], shown = (text) => redactCarriers(text, hidden);
  let configDir, createdPane = false, startAttempted = false, touchedPane = false, promptAttempted = false, unconfirmed = false;
  let cleanupArgs = null, adopted = false;
  // The same launch, into the pane it stopped in: it carries on from the shell, or adopts the agent already
  // running there. A runnable command only when the task comes from a file: an inline --task is never printed
  // (it is the brief), so then the orchestrator is told to give it again (a placeholder in its place would
  // have been sent as the task).
  const rerun = () => {
    const keep = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--continue") continue;
      if (["--worktree", "--base", "--direction", "--pane", "--cwd", "--copy", "--task"].includes(args[i])) { i++; continue; }
      keep.push(args[i]);
    }
    // An extra account's rerun carries routr's own --continue: launch refuses --pane for it anywhere else.
    const again = ["routr", "launch", ...keep, "--pane", out.pane, "--cwd", out.cwd, ...(o.account ? ["--continue"] : [])];
    return o.task != null ? doNext("Repeat the same launch with your --task given again.", templateCommand([...again, "--task", "<your-task>"]))
      : runNext("Continue this launch after resolving the pane's input.", again);
  };
  const resumeSteps = () => out.pane ? [doNext(STARTUP_INPUT, templateCommand(["herdr", "pane", "send-keys", out.pane, "<keys>"])), rerun()] : [];
  // Something in the pane needs an answer that routr does not give: a shell's own question, a harness's startup
  // question, an agent that has not started. The orchestrator gets what the pane shows (withheld once the task has been
  // sent: it shows the brief), herdr's reading when there is one, and `next`: how to carry on once it has answered.
  // It decides, and asks the user only for what is not its to answer (a password, a sign-in, a folder it did not make).
  const needsInput = (code, why, text, more = {}) => {
    inputNeeded(code);
    out.ok = false; out.state = "needs_input";
    const { next: instruction, ...detail } = more;
    out.needs_input = { why, ...detail };
    out.screen = promptAttempted ? PANE_WITHHELD : shown(text ?? null);
    out.next.push(...(instruction == null ? resumeSteps() : Array.isArray(instruction) ? instruction : [doNext(instruction)]));
    step("needs_input", false, why); return out;
  };
  const lifecycle = async () => {
    let shell = usualShell(), fish = false;
    const startArgs = (pane, timeout) => paneStartArgs(o, shell, p, privateDir, pane, timeout);
    const promptArgs = (pane, timeout) => panePromptArgs(prompt, pane, timeout);
    const { carried, extraEnv, fallbacks: fallbackEnv, split = { env: extraEnv }, unset = [] } = paneEnvOf(o, out, env, p, privateDir);
    // The user turned this subscription off: it gets no work, launched by hand or not.
    const loaded = settings(), config = configOf(loaded);
    out.warnings.push(...(loaded.notes ?? []));
    if (config.subscriptions[o.kind]?.enabled === false) throw new Error(OFF.launch(HARNESSES[o.kind].label, o.kind));
    // A harness that is not signed in would wait at its own sign-in in a pane nobody watches: refuse before any pane.
    const signedOut = await ready(o.account ?? o.kind);
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
      const r = await waitForShell({ ...pane(), read: readPane, unwrapped: readLines }, { sleep, now, remaining, cwd: expectedCwd, refuseBusy: Boolean(o.pane && !expectedCwd),
        onShell: (name) => { shell = shellFamily(name); fish = /^fish(\.exe)?$/i.test(String(name ?? "")); } });
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
        adopted = true;
        if (o["subagent-model"] || o["subagent-effort"]) {
          if (!Object.keys(fallbackEnv).length) out.warnings.push(warning("subagent_fallback_not_passed", "This launch passed no subagent fallback to the already running agent; it keeps the settings it started with."));
          out.start = { executable: null, argv: [], env: {} };
        }
        step("adopt", true, `${o.kind} is already running in ${out.pane}, ${status}, in ${out.cwd}: launch sends it the task (its model and effort are the ones it runs; not changed)`);
      }
    }
    if (!adopted) await checkListed();
    // Check the private copy (Cursor's) before creating a pane; never fall back to its account config. A missing file
    // here fails with the file system's own error (a pane launch's error policy), and the folder is removed below too.
    if (privateConfig && !adopted) {
      configDir = privateDir;
      privateConfigCopy(o.kind, configDir, { ...(cursorConfigSource ? { from: cursorConfigSource } : {}), failed: (e) => e });
      step("cursor_config", true, `Private config at ${configDir}; the pane's shell removes it when ${HARNESSES[o.kind].label} (or the shell) exits`);
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
      p = planFor(out.cwd); out.start = { ...out.start, argv: p.argv };
      out.worktree = { branch: o.worktree, ...(o.base ? { base: o.base } : {}), path: w.worktree.path, workspace: w.workspace?.workspace_id ?? null };
      // How this worker is finished: never by closing its pane, which closes the workspace and leaves the worktree.
      cleanupArgs = ["routr", "cleanup", "--cwd", repoCwd, "--worktree", o.worktree];
      step("worktree", true, `Created ${out.cwd} on branch ${o.worktree}${o.base ? ` from ${o.base}` : ""}, workspace ${out.worktree.workspace}, root pane ${root}`);
      // A worktree holds tracked files only. --copy brings named untracked files or folders (a local config, test data)
      // across from the main checkout, at the same relative path.
      // The same copy as a headless worktree's (copyInto): never over a file the commit has, never through a link.
      const { copyInto } = o.copy?.length ? await import("./worktree.mjs") : {};
      for (const rel of o.copy ?? []) {
        const from = join(repoCwd, rel);
        if (!existsSync(from)) { out.warnings.push(warning("copy_missing", `--copy ${rel}: not found in ${repoCwd}; skipped`)); continue; }
        try { copyInto(from, out.cwd, rel); }
        catch (e) { throw new Error(`launch created the worktree ${out.cwd} but did not copy into it (${e?.message ?? e}); no agent was started. Remove the worktree with ${displayCommand(cleanupArgs)}`); }
        step("copy", true, `Copied ${rel} into the worktree`);
      }
      // The worker gets a pane of launch's own, with its carriers, never the root pane herdr opened (worktreePane);
      // cleanup --worktree finds the workspace whichever pane is left in it.
      let opened;
      try { opened = await worktreePane(herdrCall, root, out.cwd, carried, split); }
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
      out.pane = await splitPane(herdrCall, direction, out.cwd, carried, split);
      createdPane = true;
      step("split", true, `Created ${out.pane}, ${direction}`);
    }
    // A pane given with --pane may be a worktree's own: cleanup then says to clean up the worktree instead.
    cleanupArgs ??= ["routr", "cleanup", "--pane", out.pane];
    // Every folder this launch will type into a cmd shell is checked as soon as the shell is known, so a refusal comes
    // before anything is typed, not between a `cd` and the variable.
    const typable = () => {
      if (shell === "cmd" && !cmdTypable(...(o.pane ? [out.cwd] : []), ...(privateConfig ? [privateDir] : []))) throw new Error(CMD_PATH);
      // What herdr types for us: the harness's command, as planned for this worker's folder (`agent start`).
      if (!shellStarted(o, shell) && !herdrTypable(shell, p.argv)) throw new Error(HERDR_PS_QUOTE);
      if (fish && !fishTypable(...(o.pane ? [out.cwd] : []), ...(privateConfig ? [privateDir] : []), ...p.argv)) throw new Error(FISH_PATH);
    };
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
    const configEnvArgs = paneConfigEnvArgs(o, shell, privateDir, out.pane);
    if (configEnvArgs && !adopted) {
      await call(configEnvArgs);
      await pause();
      stop = await shellReady(out.cwd); if (stop) return stop;
      step("cursor_env", true, `Set ${privateConfig.variable} in the pane's ${shell} shell`);
    }
    for (const name of adopted ? [] : unset) {
      await call(["pane", "run", out.pane, SHELLS[shell].unset(name, fish)]);
      await pause();
      stop = await shellReady(out.cwd); if (stop) return stop;
      step("unset_env", true, `Removed ${name} from the pane's ${shell} shell`);
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
      if (shellStarted(o, shell)) await call(["agent", "rename", out.pane, o.name]);
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
  };
  try {
    await lifecycle();
  } catch (e) {
    launchFailed(out, e, promptAttempted);
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
      try { rmSync(configDir, { recursive: true, force: true }); step("cleanup_config", true, `Removed unused ${HARNESSES[o.kind].label} config`); }
      catch (e) { out.warnings.push(warning("cursor_config_left", `Could not remove unused ${HARNESSES[o.kind].label} config ${configDir}`)); }
    }
    if (createdPane && !out.ok) { out.warnings.push(warning("pane_left", `Pane ${out.pane} was left alive`)); if (out.state !== "needs_input") out.next.push(doNext(`Inspect pane ${out.pane} before closing it or retrying`)); }
    if (configDir && startAttempted && !out.ok) { out.warnings.push(warning("cursor_config_retained", `${HARNESSES[o.kind].label} config ${configDir} is retained for a possible running worker`)); out.next.push(doNext(`Remove the private ${HARNESSES[o.kind].label} config ${configDir} if the launch command did not run`)); }
    if (promptAttempted && out.state !== "prompted") { out.warnings.push(warning("prompt_uncertain", "Prompt may have been submitted")); out.next.push(doNext(`Inspect pane ${out.pane} before retrying`)); }
  }
  return { attempted: startAttempted || promptAttempted, submitted: promptAttempted, adopted, cleanup: cleanupArgs };
}
