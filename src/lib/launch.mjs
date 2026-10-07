import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { HARNESSES, kindError, notReady, plan } from "./harnesses.mjs";
import { briefSha } from "./ledger.mjs";
import { OFF } from "./wording.mjs";
import { BRANCH, clean, deadline, paneText, paneView, quote, runHerdr, SHELLS, shellFamily, waitForShell } from "./herdr.mjs";
import { home } from "./runtime.mjs";

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
  return `${PROMPT_OPENING} Your first action, before any other tool call, is to read the routr worker guide at ${guide}. It is mandatory for this task: it says how to size each subagent before you spawn it and the exact report format the orchestrator parses.\n\n${task}${rules ? `\n\n${rules.trim()}` : ""}\n\nFinish with the report block from the worker guide, starting with the line \`VERDICT: done | partial | blocked\`.`;
}

const command = (args) => ["herdr", ...args].map(quote).join(" ");
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
  const o = { trust: "ask", timeout: 120000, dryRun: false };
  const values = ["kind", "name", "cwd", "model", "effort", "pane", "worktree", "base", "direction", "task", "task-file", "rules-file", "trust", "timeout", "advice"];
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
  // A branch, tag, commit, or one relative to them (main~2, HEAD^): whatever git names, never an option or a range.
  if (o.base && (!/^[A-Za-z0-9][A-Za-z0-9._\/@^~-]{0,200}$/.test(o.base) || o.base.includes(".."))) throw new Error("--base must name one commit: a branch, tag, or commit id");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(o.name ?? "")) throw new Error("--name must match [a-z][a-z0-9_-]{0,31}");
  if (!["ask", "auto"].includes(o.trust)) throw new Error("--trust must be ask or auto");
  if (o.direction && !["right", "down"].includes(o.direction)) throw new Error("--direction must be right or down");
  if (o.task != null && o["task-file"] != null) throw new Error("Use only one of --task and --task-file");
  if (o["rules-file"] != null && o.task == null && o["task-file"] == null) throw new Error("--rules-file goes with a task: pass --task-file (or --task) too");
  o.timeout = Number(o.timeout);
  if (!Number.isSafeInteger(o.timeout) || o.timeout <= 0) throw new Error("--timeout must be a positive integer in milliseconds");
  return o;
}

// Inject transport and time for tests; no test needs a live pane.
// `ready(kind)`: null when the harness is signed in, or why not (harnesses.mjs). `settings()`: the user's config.
export async function launch(args, { run = runHerdr, sleep = (ms) => Bun.sleep(ms), now = () => performance.now(), env = process.env, ready = notReady, settings = () => loadConfig().config,
  cursorConfigSource = join(home(), ".cursor", "cli-config.json"), tempRoot = tmpdir(), models = (kind) => HARNESSES[kind].models?.() } = {}) {
  const out = { ok: false, state: "failed", kind: null, name: null, pane: null, cwd: resolve("."), model: null, effort: null,
    command: [], argv: [], env: {}, steps: [], warnings: [], needs_input: null, prompt_chars: null };
  const step = (step, ok, detail) => out.steps.push({ step, ok, detail });
  let configDir, createdPane = false, startAttempted = false, touchedPane = false, promptAttempted = false, unconfirmed = false;
  // Something in the pane needs an answer that routr does not give: a shell's own question, a harness's startup
  // question, an agent that has not started. The orchestrator gets what the pane shows (withheld once the task has been
  // sent: it shows the brief), herdr's reading when there is one, and `then`: how to carry on once it has answered.
  // It decides, and asks the user only for what is not its to answer (a password, a sign-in, a folder it did not make).
  let then = () => null;
  const needsInput = (why, text, more = {}) => {
    out.ok = false; out.state = "needs_input";
    out.needs_input = { why, screen: promptAttempted ? PANE_WITHHELD : text ?? null, pane: out.pane, ...more, then: more.then ?? then() };
    step("needs_input", false, why); return out;
  };
  try {
    const o = parseLaunchArgs(args);
    // Kept so the launch lines of older guides still work; routr answers no startup question now.
    if (args.includes("--trust")) out.warnings.push("--trust is no longer used: routr passes each harness's own flags so it asks nothing at startup, and reports any question it asks anyway");
    Object.assign(out, { kind: o.kind ?? null, name: o.name, pane: o.pane ?? null, cwd: resolve(o.cwd ?? "."), model: o.model ?? null, effort: o.effort ?? null });
    // The same launch, into the pane it stopped in: it carries on from the shell, or adopts the agent already running
    // there. A runnable command only when the task comes from a file: an inline --task is never printed (it is the
    // brief), so then the orchestrator is told to give it again (from the review of #48: a placeholder in its place
    // would have been sent as the task).
    then = () => {
      if (!out.pane) return null;
      const keep = [];
      for (let i = 0; i < args.length; i++) {
        if (["--worktree", "--base", "--direction", "--pane", "--cwd", "--trust", "--copy", "--task"].includes(args[i])) { i++; continue; }
        keep.push(args[i]);
      }
      const again = ["routr", "launch", ...keep, "--pane", out.pane, "--cwd", out.cwd].map(quote).join(" ");
      return `Answer it in the pane (herdr pane send-keys ${out.pane} <keys>), then run ${o.task != null ? `the same launch with your --task given again: ${again} --task <your task>` : again}`;
    };
    if (!statSync(out.cwd).isDirectory()) throw new Error("--cwd must be a directory");
    const privateDir = join(tempRoot, `routr-cursor-${randomUUID()}`);
    const p = plan({ ...o, cwd: out.cwd, cursorConfigDir: privateDir });
    Object.assign(out, { argv: p.argv, env: p.env, warnings: [...out.warnings, ...p.warnings] });
    const task = o["task-file"] != null ? readFileSync(resolve(o["task-file"]), "utf8") : o.task;
    if (task != null && !task.trim()) throw new Error("The task must not be empty");
    const rules = o["rules-file"] != null ? readFileSync(resolve(o["rules-file"]), "utf8") : null;
    if (rules != null && !rules.trim()) throw new Error("The rules file must not be empty");
    const prompt = task == null ? null : composePrompt(task, WORKER_GUIDE, rules);
    out.prompt_chars = prompt?.length ?? null;
    // The advice must be about the task the worker gets. Of 42 dispatch calls in the maintainer's ledger (2026-09-26),
    // at least 12 were given a summary or a part of the task, and routr's facts then described that text instead
    // (one summary said the paths were "in the task file", so routr read that the brief named no place to work).
    if (o.advice != null && task != null) {
      let adv = null; try { adv = JSON.parse(readFileSync(resolve(o.advice), "utf8")); } catch (e) { out.warnings.push(`--advice ${o.advice}: could not read it (${e.message}); nothing was compared`); }
      if (adv) {
        const matches = adv.brief_sha === briefSha(task);
        out.advice = { file: o.advice, matches };
        if (!matches) out.warnings.push("The advice in --advice was given on a different text than this task, so its facts and level describe that text, not what the worker receives. Ask routr about the task itself: routr dispatch < <the task file>.");
      }
    }
    // Known once the pane's shell has been seen; until then, this platform's usual shell.
    let shell = process.platform === "win32" ? "powershell" : "posix";
    const startArgs = (pane, timeout) => o.kind === "cursor" && SHELLS[shell].cursor
      ? ["pane", "run", pane, SHELLS[shell].cursor(privateDir, p.executable, p.argv)]
      : ["agent", "start", o.name, "--kind", o.kind, "--pane", pane, "--timeout", String(timeout), "--", ...p.argv];
    const promptArgs = (pane, timeout) => ["agent", "prompt", pane, prompt, "--wait", "--until", "working",
      "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(timeout)];
    const worktreeArgs = () => ["worktree", "create", "--cwd", out.cwd, "--branch", o.worktree, ...(o.base ? ["--base", o.base] : []), "--no-focus"];
    if (o.dryRun) {
      const pane = o.pane ?? "<new-pane>";
      out.planned_command = [
        ...(o.worktree ? [command(worktreeArgs())] : []),
        ...(!o.pane && !o.worktree ? [...(!o.direction ? [command(["pane", "current", "--current"]), command(["pane", "layout", "--current"])] : []), command(["pane", "split", "--current", "--direction", o.direction ?? "<right-if-wide-else-down>", "--cwd", out.cwd, "--no-focus"])] : []),
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
      step("plan", true, "No commands executed or files written. Pane ids, geometry, polling, timeouts and shell questions are resolved at launch.");
      return { ...out, ok: true, state: "planned" };
    }
    if (env.HERDR_ENV !== "1") throw new Error("Launch requires HERDR_ENV=1 inside a Herdr pane");
    // The user turned this subscription off: it gets no work, launched by hand or not.
    if (settings().subscriptions[o.kind]?.enabled === false) throw new Error(OFF.launch(HARNESSES[o.kind].label, o.kind));
    // A harness that is not signed in would wait at its own sign-in in a pane nobody watches: refuse before any pane.
    const signedOut = await ready(o.kind);
    if (signedOut) throw new Error(`${HARNESSES[o.kind].label} cannot take work: ${signedOut}`);
    const remaining = deadline(o.timeout, now, "Launch readiness timeout");
    const call = async (a, tolerate = false) => {
      const ms = remaining();
      logCommand(out.command, command(a));
      const r = await run(a, ms);
      if (!r.ok && !tolerate) throw new Error(r.data?.error?.message ?? JSON.stringify(r.data));
      return r;
    };
    const pane = () => paneView(call, out.pane); // the pane id is known only once it is split or adopted
    const readPane = async () => { touchedPane = true; return pane().read(); };
    const pause = async () => sleep(Math.min(250, remaining()));
    let shellCwd = null;
    const shellReady = async (expectedCwd) => {
      const r = await waitForShell({ ...pane(), read: readPane }, { sleep, now, remaining, cwd: expectedCwd, refuseBusy: Boolean(o.pane && !expectedCwd),
        onShell: (name) => { shell = shellFamily(name); } });
      if (!r.ok) return needsInput(r.why, r.text);
      shellCwd = r.cwd;
      step("shell_ready", true, `Interactive ${shell} shell in ${r.cwd}`); return null;
    };
    // --pane may name a pane where the agent asked for is already running (the `then` of an earlier launch that stopped
    // at its startup question): launch adopts it and sends the task. A pane running another agent is refused; a pane
    // with no agent goes through the shell as before.
    // What herdr makes of the question the agent stopped at: its rule and the version of its rules for this harness,
    // plus what the registry knows about that harness's startup questions. This extra reading gets its own short
    // allowance and can never turn needs_input into failed (from the review of #47).
    // `agent get` gives herdr's last state, `agent explain` reads the screen now, and right after a question is answered
    // the two can disagree. Seen 2026-10-05 (Codex, rules 2026.10.01.1): the orchestrator answered Codex's folder trust
    // and ran `then` at once; get still said blocked, explain said idle (osc_title_idle), and launch reported a ready
    // agent as "waiting at a question", naming the idle rule as the question. So a block counts only when explain reads
    // it blocked too (or cannot be read).
    const explain = async () => {
      const a = ["agent", "explain", out.pane, "--json"];
      logCommand(out.command, command(a));
      let x = null; try { x = (await run(a, 2000)).data; } catch {}
      return { reads: x?.state ?? x?.result?.state, rule: x?.matched_rule?.id ?? x?.result?.matched_rule?.id, rules: x?.manifest_version ?? x?.result?.manifest_version };
    };
    const blockedAtStart = (h, text, { reads, rule, rules } = {}) => {
      const disagreed = typeof reads === "string" && reads !== "blocked";
      // A rule matched for another state is not the question's reason, so it is not given as one.
      const reading = disagreed ? ` (herdr's state says blocked, but its rules read the screen as ${reads}${rule ? ` by ${rule}` : ""}${rules ? `, rules ${rules}` : ""})`
        : rule ? ` (herdr reads it as ${rule}${rules ? `, rules ${rules}` : ""})` : "";
      return needsInput(`${h.label} is waiting at a question before it can start${reading}.`, text,
        { herdr: { state: "blocked", ...(rule && !disagreed ? { rule } : {}), ...(disagreed ? { explained: reads } : {}), ...(rules ? { rules } : {}) }, ...(h.startup ? { note: h.startup } : {}) });
    };
    // Only an idle agent of that kind, in that folder, is adopted (from the review of #48): one elsewhere would get a
    // task meant for --cwd, and a working one would get a second task when it finished. launch never waits on an agent
    // it did not start, and decides from one reading, now: herdr's `agent wait` can see such an agent work and finish
    // inside one wait (it matches idle, done, and blocked), and so can any later read, so waiting for one read unknown
    // or working to become idle could hand a busy worker a second task (from the reviews of this change). A refusal
    // costs the orchestrator one more run of `then`. The screen on a refusal is extra: a read that fails or runs out of
    // time leaves it out rather than turning the refusal into failed.
    let adopted = false, stop = null;
    if (o.pane) {
      const occupant = (await call(["agent", "get", out.pane], true)).data?.result?.agent;
      if (occupant?.agent) {
        const screen = async () => { try { return await readPane(); } catch { return null; } };
        const other = { then: "Choose another pane, or leave --pane off" };
        const notWaiting = async (state) => needsInput(`The ${o.kind} in the pane is ${state}, not waiting for a task`, await screen(), { then: `Wait until it is idle (herdr agent wait ${out.pane} --until idle), then run the same launch again` });
        if (occupant.agent !== o.kind) return needsInput(`The pane runs ${occupant.agent}, not ${o.kind}`, await screen(), other);
        const where = occupant.foreground_cwd ?? occupant.cwd;
        const same = (() => { try { return realpathSync(where) === realpathSync(out.cwd); } catch { return false; } })();
        if (!same) return needsInput(`The ${o.kind} in the pane works in ${where ?? "a folder herdr does not report"}, not ${out.cwd}`, await screen(), other);
        let status = occupant.agent_status ?? "in a state herdr does not report";
        if (status === "blocked") {
          // herdr's state may be stale (above): its live reading decides, once. Idle (or done) is a block already answered.
          const x = await explain();
          if (x.reads === "blocked" || typeof x.reads !== "string") return blockedAtStart(HARNESSES[o.kind], await screen(), x);
          if (!["idle", "done"].includes(x.reads)) return notWaiting(x.reads);
          step("explain", true, `herdr's state said blocked, but its rules read the screen as ${x.reads}${x.rule ? ` by ${x.rule}` : ""}: the question was answered`);
          status = x.reads;
        }
        if (!["idle", "done"].includes(status)) return notWaiting(status);
        // Pane-run agents such as Cursor have unknown (null/absent) readiness; only explicit false vetoes idle/done.
        if (occupant.interactive_ready === false && occupant.agent_status !== "blocked") return notWaiting(`${status} but not ready for input`);
        adopted = true; step("adopt", true, `${o.kind} is already running in ${out.pane}, ${status}, in ${out.cwd}: launch sends it the task (its model and effort are the ones it runs; not changed)`);
      }
    }
    // A harness that runs its default model on an id it does not know, without a word (Kiro), is checked against its
    // own list of ids before any pane. Kept until the harness refuses an unknown id itself.
    if (!adopted && HARNESSES[o.kind].unknownModelRunsDefault) {
      const ids = await models(o.kind);
      if (ids?.length && !ids.includes(o.model)) throw new Error(`${HARNESSES[o.kind].executable} does not list --model ${o.model}, and ${o.kind} runs its default model on an id it does not know. Its ids: \`${HARNESSES[o.kind].list}\``);
      if (ids?.length) step("model", true, `${o.model} is in ${o.kind}'s own list`);
      else out.warnings.push(`Could not read ${o.kind}'s model list (\`${HARNESSES[o.kind].list}\`), so --model ${o.model} was not checked: ${o.kind} runs its default model on an id it does not know. Look at its footer in the pane`);
    }
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
      const r = await call(worktreeArgs());
      const w = r.data?.result;
      if (!r.ok || typeof w?.root_pane?.pane_id !== "string" || typeof w?.worktree?.path !== "string") {
        throw new Error(`Could not create worktree ${o.worktree}: ${r.data?.error?.message ?? r.data?.error?.code ?? "unexpected Herdr response"}`);
      }
      out.pane = w.root_pane.pane_id; out.cwd = w.worktree.path;
      out.worktree = { branch: o.worktree, ...(o.base ? { base: o.base } : {}), path: w.worktree.path, workspace: w.workspace?.workspace_id ?? null };
      // How this worker is finished: never by closing its pane, which closes the workspace and leaves the worktree.
      out.cleanup = ["routr", "cleanup", "--cwd", repoCwd, "--worktree", o.worktree].map(quote).join(" ");
      step("worktree", true, `Created ${out.cwd} on branch ${o.worktree}${o.base ? ` from ${o.base}` : ""}, workspace ${out.worktree.workspace}, pane ${out.pane}`);
      // A worktree holds tracked files only. --copy brings named untracked files or folders (a local config, test data)
      // across from the main checkout, at the same relative path.
      for (const rel of o.copy ?? []) {
        const from = join(repoCwd, rel), to = join(out.cwd, rel);
        if (!existsSync(from)) { out.warnings.push(`--copy ${rel}: not found in ${repoCwd}; skipped`); continue; }
        mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true });
        step("copy", true, `Copied ${rel} into the worktree`);
      }
    }
    if (!out.pane) {
      let direction = o.direction;
      if (!direction) {
        const current = (await call(["pane", "current", "--current"])).data.result.pane;
        const layout = (await call(["pane", "layout", "--current"])).data.result.layout;
        const rect = layout.panes.find((p) => p.pane_id === current.pane_id)?.rect;
        if (!rect) throw new Error("Caller pane geometry is unavailable");
        direction = rect.width > rect.height ? "right" : "down";
      }
      const r = await call(["pane", "split", "--current", "--direction", direction, "--cwd", out.cwd, "--no-focus"]);
      out.pane = r.data.result.pane.pane_id;
      if (typeof out.pane !== "string" || !out.pane) throw new Error("Herdr split returned no pane id");
      createdPane = true;
      step("split", true, `Created ${out.pane}, ${direction}`);
    }
    // A pane given with --pane may be a worktree's own: cleanup then says to clean up the worktree instead.
    out.cleanup ??= `routr cleanup --pane ${quote(out.pane)}`;
    // A pane we split already opened in --cwd; one adopted from the caller must be checked before we type `cd`.
    if (o.pane && !adopted) {
      stop = await shellReady(); if (stop) return stop;
      // Only when the shell is elsewhere: a `cd` runs the shell's directory hooks again, and a hook that asks (a dotenv
      // plugin) would ask again every time the `then` of a launch was run (seen 2026-09-28).
      const same = (() => { try { return realpathSync(shellCwd) === realpathSync(out.cwd); } catch { return false; } })();
      if (!same) { await call(["pane", "run", out.pane, SHELLS[shell].cd(out.cwd)]); await pause(); }
    }
    if (!adopted) { stop = await shellReady(out.cwd); if (stop) return stop; }
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
    const awaitReady = async (text) => {
      const h = HARNESSES[o.kind];
      const left = () => { try { return remaining(); } catch { return 0; } };
      let disagreed = null; // { text, reading } while herdr's state says blocked and its explain reads another state
      for (;;) {
        try {
          const waited = await call(["agent", "wait", out.pane, "--timeout", String(Math.min(1000, remaining()))], true);
          if (!waited.ok && !["timeout", "agent_not_found", "agent_not_ready"].includes(waited.data?.error?.code)) throw new Error(waited.data?.error?.message ?? "Agent wait failed");
          text = await readPane();
          const got = await call(["agent", "get", out.pane], true);
          if (!got.ok && got.data?.error?.code !== "agent_not_found") throw new Error(got.data?.error?.message ?? "Agent inspection failed");
          const agent = got.data?.result?.agent;
          // Close only a pane this launch made: one passed in with --pane may hold someone else's work (from the review of #48).
          if (agent && agent.agent !== o.kind) return needsInput(`The pane runs ${agent.agent}, not ${o.kind}`, text, { then: createdPane ? `Close the pane this launch made (herdr pane close ${out.pane}) and launch again` : "Leave that pane; choose another, or leave --pane off" });
          if (agent?.agent_status === "blocked") {
            const x = await explain();
            if (x.reads === "blocked" || typeof x.reads !== "string") return blockedAtStart(h, text, x);
            disagreed = { text, reading: x };
          // herdr's state has moved on, or there is no agent any more: no disagreement left to report. A vanished agent
          // kept the old one, and the deadline reported a block it no longer saw instead of failing (from the final review).
          } else disagreed = null;
          // Pane-run agents such as Cursor have unknown (null/absent) readiness; only explicit false vetoes idle/done.
          if (got.ok && waited.ok && ["idle", "done"].includes(agent?.agent_status) && agent.interactive_ready !== false) break;
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
      logCommand(out.command, promptForLog(a));
      promptAttempted = true;
      let r = await run(a, Math.min(remaining(), submitMs + Math.min(1000, Math.floor((budget - submitMs) / 2))));
      const quiet = !r.ok && ["agent_prompt_stalled", "timeout"].includes(r.data?.error?.code);
      if (quiet) {
        step("prompt_wait", true, "Sent once; herdr has not seen the agent start yet, so launch waits on its state and sends nothing again");
        const w = ["agent", "wait", out.pane, "--until", "working", "--until", "blocked", "--timeout", String(Math.max(1, remaining() - 500))];
        logCommand(out.command, command(w));
        r = await run(w, Math.max(1, remaining()));
      }
      // The outcome is decided by this one read. It gets its own short allowance, not what is left of the launch
      // timeout, so a wait that used that up cannot turn needs_input into failed (from the verification of #46). No
      // pane read follows: once the task is sent the pane may show the brief, and launch never prints it.
      logCommand(out.command, command(["agent", "get", out.pane]));
      const got = await run(["agent", "get", out.pane], 2000);
      if (!got.ok) throw new Error(got.data?.error?.message ?? JSON.stringify(got.data));
      const agent = got.data?.result?.agent;
      const status = agent?.agent_status ?? "unknown";
      const sent = { then: `The task was sent: do not launch it again. Read the pane (herdr agent read ${out.pane}): answer a question it asks; press Enter if the task sits unsent in its input box (herdr agent send-keys ${out.pane} enter); send it with herdr agent prompt only if it never arrived` };
      if (agent?.agent !== o.kind) { unconfirmed = true; return needsInput("Cannot confirm the prompted agent's identity", null, sent); }
      if (status === "blocked") {
        step("prompt", r.ok, `Submitted ${prompt.length} characters; the agent is asking something`);
        return needsInput("The worker is asking a question or an approval right after its prompt", null, { ...sent, herdr: { state: "blocked" } });
      }
      // Working is always a start. Idle or done count when herdr's wait (the prompt's own, or the one after a quiet
      // prompt) saw the agent working first: a short task can finish before this read (from the review of #46).
      if (status === "working" || (r.ok && ["idle", "done"].includes(status))) {
        step("prompt", true, `Submitted ${prompt.length} characters; the agent settled at ${status}`);
        out.state = "prompted";
        return null;
      }
      step("prompt", false, `Sent once; the agent never started (${status}): ${JSON.stringify(r.data)}`);
      return needsInput(`The task was sent once and the agent has not started within the timeout (${status}); launch never sends it twice.`, null, { ...sent, herdr: { state: status } });
    };
    let text = null;
    if (!adopted) {
      const startCommand = startArgs(out.pane, Math.min(30000, remaining()));
      startAttempted = true;
      const started = await call(startCommand, true);
      step("start", started.ok, started.ok ? "Herdr accepted the launch" : JSON.stringify(started.data));
      text = await readPane();
      const startError = started.data?.error?.code;
      if (!started.ok && !["agent_not_ready", "timeout"].includes(startError)) {
        throw new Error(started.data?.error?.message ?? "Agent start failed");
      }
      stop = await awaitReady(text); if (stop) return stop;
      step("ready", true, "herdr reports the agent ready for input");
    }
    out.state = "ready"; out.ok = true;
    if (prompt) stop = await submitPrompt();
    // The name the orchestrator will use for an adopted agent, given once the task is in (whatever herdr then reports),
    // so a rename that hangs cannot take the submission's time (from the verification of d47051e: it used all of
    // --timeout, and the task was never sent). Its own short allowance, like explain's; a failure costs only the name.
    // Not when the outcome read could not confirm the agent it prompted: the pane may hold another agent by then, and
    // the name would go to it (from the final review).
    if (adopted && !unconfirmed) {
      const a = ["agent", "rename", out.pane, o.name];
      logCommand(out.command, command(a));
      let renamed = null; try { renamed = await run(a, 2000); } catch {}
      if (!renamed?.ok) out.warnings.push(`Could not rename the adopted agent to ${o.name}: address it by its pane, ${out.pane}`);
    }
    if (stop) return stop;
  } catch (e) {
    out.ok = false; out.state = "failed"; step("failed", false, String(e?.message ?? e));
    // The harness may have exited with its own complaint (a model id it does not accept, a login it wants). That
    // message is on the pane and nowhere else, and without it the orchestrator only learns that something timed out.
    if (out.pane && touchedPane && promptAttempted) out.pane_text = PANE_WITHHELD; // sent: the pane may show the brief, so it is not read
    else if (out.pane && touchedPane) {
      try {
        const a = ["pane", "read", out.pane, "--source", "recent-unwrapped", "--lines", "40"];
        logCommand(out.command, command(a));
        const tail = clean(paneText((await run(a, 1000)).data))
          .split("\n").filter((l) => l.trim()).slice(-8).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l)).join("\n");
        if (tail) out.pane_text = tail;
      } catch {}
    }
  } finally {
    // No launch was attempted, so a failed new pane and an unused config cannot belong to a worker.
    if (createdPane && !startAttempted && out.state === "failed") {
      const a = ["pane", "close", out.pane];
      logCommand(out.command, command(a));
      try {
        const closed = await run(a, 1000);
        step("cleanup_pane", closed.ok, closed.ok ? `Closed unused pane ${out.pane}` : "Could not close unused pane");
        if (closed.ok) { createdPane = false; delete out.cleanup; }
      } catch (e) { step("cleanup_pane", false, String(e?.message ?? e)); }
    }
    if (configDir && !startAttempted) {
      try { rmSync(configDir, { recursive: true, force: true }); step("cleanup_config", true, "Removed unused Cursor config"); }
      catch (e) { out.warnings.push(`Could not remove ${configDir}: ${e.message}`); }
    }
    if (createdPane && !out.ok) out.warnings.push(`Pane ${out.pane} was left alive; inspect it before closing or retrying.`);
    if (configDir && startAttempted && !out.ok) out.warnings.push(`Cursor config ${configDir} is retained for a possible running worker; remove it if the launch command did not execute.`);
    if (promptAttempted && out.state !== "prompted") out.warnings.push("Prompt may have been submitted; inspect the pane before retrying.");
  }
  return out;
}
