import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { HARNESSES, kindError, notReady, plan } from "./harnesses.mjs";
import { briefSha } from "./ledger.mjs";
import { OFF } from "./wording.mjs";
import { clean, deadline, paneText, paneView, quote, runHerdr, SHELLS, shellFamily, shellPrompt, waitForShell } from "./herdr.mjs";
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

// The menu below the last line on screen that `isQuestion` accepts: numbered options ("› 1. Yes, continue"), or else
// the lines that START with Yes or No, numbered by order, so a tip or a status line can never be taken for one. Null
// when there is no such question, or when a later input prompt (or `answered`) shows it has already scrolled past.
function menuAfter(text, isQuestion, answered) {
  const t = clean(text).replace(/^[│┃][ \t]?|[ \t]*[│┃]$/gm, "");
  // Each line is judged with the two above it too, so a question the pane wrapped still reads as one sentence.
  const lines = [...t.matchAll(/^[^\n]*$/gm)];
  const question = lines.filter((m, i) => isQuestion(m[0], lines.slice(Math.max(0, i - 2), i + 1).map((x) => x[0]).join(" "))).at(-1);
  if (!question) return null;
  const below = t.slice(question.index + question[0].length);
  if (shellPrompt(below) === "ready" || answered?.test(below)) return null;
  let matches = [...below.matchAll(/^[ \t]*([❯›>→▶]?)[ \t]*(\d+)[.)][ \t]+(.+)$/gm)];
  let options = matches.map((m) => ({ number: m[2], text: m[3].trim(), selected: !!m[1] }));
  if (!options.length) {
    matches = [...below.matchAll(/^[ \t]*([❯›>→▶]?)[ \t]*((?:Yes|No)\b[^\n]*)$/gmi)];
    options = matches.map((m, i) => ({ number: String(i + 1), text: m[2].trim(), selected: !!m[1] }));
  }
  return { options, matches, below };
}

// A folder-trust question: the last one on screen, never an affirmative option or a historical status message.
// The question, however the pane wraps it: Claude Code 2.1.283 (2026-09-26) asks "Quick safety check: Is this a
// project you created or one you trust? (Like your own code, …)", and a narrow pane puts "project" and "trust?" on
// different lines. So: "trust?" on the line, and what is trusted (folder, project, …) in the same SENTENCE, read across
// the two lines above: nearby prose about a project beside an unrelated "Can we trust?" is not it (from the
// verification of #41).
const TRUST_OPENS = /^\s*(?:Do you trust|Trust (?:this|the))\b/i, TRUSTED = /\b(?:folder|directory|project|workspace)\b/i;
const trustQuestion = (line, near) => {
  if (TRUST_OPENS.test(line)) return true;
  const at = near.search(/\btrust\s*\?/i);
  if (at < 0 || !/\btrust\s*\?/i.test(line)) return false;
  const sentence = near.slice(0, at).split(/[.!?](?:\s|$)/).at(-1); // from the last sentence end before "trust?"
  return TRUSTED.test(sentence);
};
export function trustDialog(text) {
  const menu = menuAfter(text, trustQuestion);
  if (!menu) return null;
  const { options, matches, below } = menu;
  const affirmative = options.filter((o) => /^(?:yes(?:$|,?\s+(?:I trust\b|continue\b|trust\b))|trust (?:this|the)\b)/i.test(o.text)
    && !/\b(?:don't|do not|no)\b/i.test(o.text));
  const yes = affirmative.length === 1 ? options.indexOf(affirmative[0]) : -1;
  const selected = options.findIndex((o) => o.selected);
  const ordered = options.every((o, i) => !i || Number(o.number) === Number(options[i - 1].number) + 1);
  // Text between options may be a wrapped label or another menu. Do not guess arrow counts across it.
  const contiguous = matches.every((m, i) => !i || !below.slice(matches[i - 1].index + matches[i - 1][0].length, m.index).trim());
  const keys = yes < 0 || options.filter((o) => o.selected).length !== 1 || !ordered || !contiguous ? null : [
    ...Array(Math.abs(yes - selected)).fill(yes < selected ? "up" : "down"), "enter",
  ];
  return { options, affirmative: yes < 0 ? null : options[yes], keys };
}

// A harness's confirmation of the permissive mode routr asked for (Kiro's trust-all-tools warning). Answered whatever
// `--trust` says: it is about the flags routr passed, not the folder. `keys` MOVES to the answer, or is ["enter"] once
// the answer is selected: Kiro dropped an arrow sent in the same burst as enter and took "No, exit" (measured).
export function permissiveConfirm(text, confirm) {
  if (!confirm) return null;
  const menu = menuAfter(text, (line) => confirm.question.test(line), confirm.answered);
  if (!menu) return null;
  const options = menu.options.map(({ text, selected }) => ({ text, selected }));
  const answer = options.findIndex((o) => confirm.answer.test(o.text)), selected = options.findIndex((o) => o.selected);
  if (answer < 0 || selected < 0 || options.filter((o) => o.selected).length !== 1 || options.filter((o) => confirm.answer.test(o.text)).length !== 1) return { options, keys: null };
  return { options, answer: options[answer].text, keys: answer === selected ? ["enter"] : Array(Math.abs(answer - selected)).fill(answer < selected ? "up" : "down") };
}

export function parseLaunchArgs(args) {
  const o = { trust: "ask", timeout: 120000, dryRun: false };
  const values = ["kind", "name", "cwd", "model", "effort", "pane", "worktree", "direction", "task", "task-file", "rules-file", "trust", "timeout", "advice"];
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
  for (const c of o.copy ?? []) if (isAbsolute(c) || c.split(/[\\/]/).includes("..")) throw new Error("--copy takes paths inside the repository, relative to --cwd");
  if (o.worktree && !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,80}$/.test(o.worktree)) throw new Error("--worktree must be a plain branch name");
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
  cursorConfigSource = join(home(), ".cursor", "cli-config.json"), tempRoot = tmpdir() } = {}) {
  const out = { ok: false, state: "failed", kind: null, name: null, pane: null, cwd: resolve("."), model: null, effort: null,
    command: [], argv: [], env: {}, steps: [], warnings: [], needs_human: null, prompt_chars: null };
  const step = (step, ok, detail) => out.steps.push({ step, ok, detail });
  let configDir, createdPane = false, startAttempted = false, touchedPane = false, promptAttempted = false;
  const human = (why, text) => {
    out.ok = false; out.state = "needs_human"; out.needs_human = { why, pane_text: promptAttempted ? PANE_WITHHELD : text }; step("needs_human", false, why); return out;
  };
  try {
    const o = parseLaunchArgs(args);
    Object.assign(out, { kind: o.kind ?? null, name: o.name, pane: o.pane ?? null, cwd: resolve(o.cwd ?? "."), model: o.model ?? null, effort: o.effort ?? null });
    if (!statSync(out.cwd).isDirectory()) throw new Error("--cwd must be a directory");
    const privateDir = join(tempRoot, `routr-cursor-${randomUUID()}`);
    const p = plan({ ...o, cwd: out.cwd, cursorConfigDir: privateDir });
    Object.assign(out, { argv: p.argv, env: p.env, warnings: p.warnings });
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
    if (o.dryRun) {
      const pane = o.pane ?? "<new-pane>";
      out.planned_command = [
        ...(o.worktree ? [command(["worktree", "create", "--cwd", out.cwd, "--branch", o.worktree, "--no-focus"])] : []),
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
      step("plan", true, "No commands executed or files written. Pane ids, geometry, polling, timeouts, shell questions and trust options are resolved at launch.");
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
    const shellReady = async (expectedCwd) => {
      const r = await waitForShell({ ...pane(), read: readPane }, { sleep, now, remaining, cwd: expectedCwd, refuseBusy: Boolean(o.pane && !expectedCwd),
        onShell: (name) => { shell = shellFamily(name); },
        onAnswer: () => { out.warnings.push("Answered no to the shell's dotenv Source it? question."); step("shell_answer", true, "dotenv: sent n, enter"); } });
      if (!r.ok) return human(r.why, r.text);
      step("shell_ready", true, `Interactive ${shell} shell in ${r.cwd}`); return null;
    };
    // Check Cursor's copy before creating a pane; never fall back to its account config.
    if (o.kind === "cursor") {
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
      const r = await call(["worktree", "create", "--cwd", out.cwd, "--branch", o.worktree, "--no-focus"]);
      const w = r.data?.result;
      if (!r.ok || typeof w?.root_pane?.pane_id !== "string" || typeof w?.worktree?.path !== "string") {
        throw new Error(`Could not create worktree ${o.worktree}: ${r.data?.error?.message ?? r.data?.error?.code ?? "unexpected Herdr response"}`);
      }
      out.pane = w.root_pane.pane_id; out.cwd = w.worktree.path;
      out.worktree = { branch: o.worktree, path: w.worktree.path, workspace: w.workspace?.workspace_id ?? null };
      step("worktree", true, `Created ${out.cwd} on branch ${o.worktree}, workspace ${out.worktree.workspace}, pane ${out.pane}`);
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
    // A pane we split already opened in --cwd; one adopted from the caller must be checked before we type `cd`.
    let stop = null;
    if (o.pane) {
      stop = await shellReady(); if (stop) return stop;
      await call(["pane", "run", out.pane, SHELLS[shell].cd(out.cwd)]);
      await pause();
    }
    stop = await shellReady(out.cwd); if (stop) return stop;
    if (o.kind === "cursor" && SHELLS[shell].cursorEnv) {
      await call(["pane", "run", out.pane, SHELLS[shell].cursorEnv(privateDir)]);
      await pause();
      stop = await shellReady(out.cwd); if (stop) return stop;
      step("cursor_env", true, `Set CURSOR_CONFIG_DIR in the pane's ${shell} shell`);
    }
    // After the start: answer the harness's own permissive-mode confirmation, the folder trust (as --trust says), wait
    // until the agent is ready, and check it took the model. Returns null when ready, or what needs a person.
    const awaitReady = async (text) => {
      let answeredTrust = null, trustAnsweredAt = null, moves = 0, confirmedAt = null;
      const h = HARNESSES[o.kind];
      for (;;) {
        // Kiro shows it idle and ready while it asks (measured), so the screen is the only sign.
        const ask = permissiveConfirm(text, h.confirm);
        if (ask) {
          if (!ask.keys) return human("Cannot identify the options of the harness's permissive-mode confirmation", text);
          if (ask.keys[0] !== "enter") {
            // Moved, then read again: the answer is pressed only once the screen shows it selected.
            if (++moves > 3) return human("The selection in the permissive-mode confirmation did not move", text);
            await call(["pane", "send-keys", out.pane, ...ask.keys]);
          } else if (confirmedAt == null) {
            await call(["pane", "send-keys", out.pane, "enter"]);
            step("confirm", true, `Selected "${ask.answer}" (this session only; never "don't ask again")`);
            out.warnings.push(`Accepted ${o.kind}'s permissive-mode confirmation for this session: ${ask.answer}`);
            confirmedAt = now();
          } else if (now() - confirmedAt >= 5000) return human("The permissive-mode confirmation did not clear after answering", text);
          await pause(); text = await readPane(); continue;
        }
        const trust = trustDialog(text);
        if (trust) {
          if (o.trust === "ask") return human("Folder trust requires a human decision (--trust ask)", text);
          if (!trust.keys) return human("Cannot identify the selected and affirmative folder-trust options", text);
          const signature = JSON.stringify(trust.options.map(({ number, text }) => ({ number, text })));
          if (answeredTrust && answeredTrust !== signature) return human("A different folder-trust menu appeared after answering; inspect before sending more keys", text);
          if (!answeredTrust) {
            await call(["pane", "send-keys", out.pane, ...trust.keys]);
            step("trust", true, `Selected ${trust.affirmative.number}. ${trust.affirmative.text}; sent ${trust.keys.join(", ")}`);
            out.warnings.push(`Accepted folder trust: ${trust.affirmative.text}`);
            answeredTrust = signature; trustAnsweredAt = now();
          }
          if (now() - trustAnsweredAt >= 5000) return human("Folder trust did not clear after answering", text);
          await pause(); text = await readPane(); continue;
        }
        // Even after start succeeds, wait and then inspect the actual UI before prompting.
        const waited = await call(["agent", "wait", out.pane, "--timeout", String(Math.min(1000, remaining()))], true);
        if (!waited.ok && !["timeout", "agent_not_found", "agent_not_ready"].includes(waited.data?.error?.code)) throw new Error(waited.data?.error?.message ?? "Agent wait failed");
        text = await readPane();
        if (trustDialog(text) || permissiveConfirm(text, h.confirm)) continue;
        const got = await call(["agent", "get", out.pane], true);
        if (!got.ok && got.data?.error?.code !== "agent_not_found") throw new Error(got.data?.error?.message ?? "Agent inspection failed");
        const agent = got.data?.result?.agent;
        if (agent && agent.agent !== o.kind) return human("The pane contains a different agent kind", text);
        if (agent?.agent_status === "blocked") return human("Agent is waiting at an unrecognized question or approval", text);
        // Pane-run agents such as Cursor have unknown (null/absent) readiness; only explicit false vetoes idle/done.
        if (got.ok && waited.ok && ["idle", "done"].includes(agent?.agent_status) && agent.interactive_ready !== false) break;
        await pause();
      }
      if (o.kind === "cursor" && SHELLS[shell].cursor) await call(["agent", "rename", out.pane, o.name]); // pane-run: herdr did not get the name
      if (h.showsModel) {
        // Kiro runs its default on a model id it does not know, and says so only by leaving the id out of its footer.
        const shownBy = now() + 3000;
        while (!h.showsModel(clean(text), o.model)) {
          if (now() >= shownBy) throw new Error(`${h.executable} did not take --model ${o.model}: the screen does not show it, and ${o.kind} runs its default model on an id it does not know. Close this pane; list the ids with \`${h.list}\``);
          await pause(); text = await readPane();
        }
        step("model", true, `The screen shows ${o.model}`);
      }
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
      // timeout, so a wait that used that up cannot turn needs_human into failed (from the verification of #46). No
      // pane read follows: once the task is sent the pane may show the brief, and launch never prints it.
      logCommand(out.command, command(["agent", "get", out.pane]));
      const got = await run(["agent", "get", out.pane], 2000);
      if (!got.ok) throw new Error(got.data?.error?.message ?? JSON.stringify(got.data));
      const agent = got.data?.result?.agent;
      const status = agent?.agent_status ?? "unknown";
      if (agent?.agent !== o.kind) return human("Cannot confirm the prompted agent's identity", null);
      if (status === "blocked") {
        step("prompt", r.ok, `Submitted ${prompt.length} characters; the agent is asking something`);
        return human("The worker is blocked on a question or approval right after its prompt", null);
      }
      // Working is always a start. Idle or done count when herdr's wait (the prompt's own, or the one after a quiet
      // prompt) saw the agent working first: a short task can finish before this read (from the review of #46).
      if (status === "working" || (r.ok && ["idle", "done"].includes(status))) {
        step("prompt", true, `Submitted ${prompt.length} characters; the agent settled at ${status}`);
        out.state = "prompted";
        return null;
      }
      step("prompt", false, `Sent once; the agent never started (${status}): ${JSON.stringify(r.data)}`);
      return human(`The task was sent once and the agent has not started within the timeout (${status}). Look at the pane: it may still be starting, the task may sit unsent in its input box (press Enter there), or it never arrived (send it by hand). launch never sends it twice.`, null);
    };
    const startCommand = startArgs(out.pane, Math.min(30000, remaining()));
    startAttempted = true;
    const started = await call(startCommand, true);
    step("start", started.ok, started.ok ? "Herdr accepted the launch" : JSON.stringify(started.data));
    let text = await readPane(); // Codex's trust dialog can be reported as idle.
    const startError = started.data?.error?.code;
    if (!started.ok && !["agent_not_ready", "timeout"].includes(startError)) {
      throw new Error(started.data?.error?.message ?? "Agent start failed");
    }
    stop = await awaitReady(text); if (stop) return stop;
    step("ready", true, "Herdr wait settled and the pane has no folder-trust dialog");
    out.state = "ready"; out.ok = true;
    if (prompt) { stop = await submitPrompt(); if (stop) return stop; }
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
        if (closed.ok) createdPane = false;
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
