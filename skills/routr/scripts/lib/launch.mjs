import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { HARNESSES, plan } from "./harness.mjs";

// The worker guide a launch prompt points at. From source it sits beside this file; a compiled binary has no files
// around it, so it points at the installed skill (written by the installer or `routr skill install`).
const besideSource = fileURLToPath(new URL("../../references/worker.md", import.meta.url));
export const WORKER_GUIDE = existsSync(besideSource) ? besideSource : join(homedir(), ".agents/skills/routr/references/worker.md");
export function composePrompt(task, guide = WORKER_GUIDE) {
  return `You are a routr worker. Your first action, before any other tool call, is to read the routr worker guide at ${guide}. It is mandatory for this task: it says how to size each subagent before you spawn it and the exact report format the orchestrator parses.\n\n${task}\n\nFinish with the report block from the worker guide, starting with the line \`VERDICT: done | partial | blocked\`.`;
}

export const quote = (s) => /^[a-zA-Z0-9_./:=@+-]+$/.test(s) ? s : `'${String(s).replaceAll("'", "'\\''")}'`;
const command = (args) => ["herdr", ...args].map(quote).join(" ");
// Polling repeats the same read; record it once with a count so the result stays readable.
export function logCommand(log, text) {
  const last = log.at(-1);
  if (last === text) { log[log.length - 1] = `${text}  (x2)`; return log; }
  const m = typeof last === "string" && last.match(/^(.*)  \(x(\d+)\)$/);
  if (m && m[1] === text) { log[log.length - 1] = `${m[1]}  (x${Number(m[2]) + 1})`; return log; }
  log.push(text); return log;
}
const clean = (text) => stripVTControlCharacters(text).replaceAll("\r\n", "\n").split("\n")
  .map((line) => {
    const chars = []; let cursor = 0;
    for (const char of line) {
      if (char === "\r") cursor = 0;
      else if (char === "\b") cursor = Math.max(0, cursor - 1);
      else chars[cursor++] = char;
    }
    return chars.join("");
  }).join("\n").trimEnd();

// Reads are JSON in the API; some CLI releases print the text directly.
export function paneText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") throw new Error("Herdr returned no pane text");
  if (value.error || value.ok === false) throw new Error("Herdr pane read failed");
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join("\n");
  if (Object.hasOwn(value, "result")) return paneText(value.result);
  for (const key of ["text", "content", "output", "lines", "screen", "snapshot", "read", "pane"]) {
    if (value[key] == null) continue;
    if (Array.isArray(value[key]) && value[key].every((v) => typeof v === "string")) return value[key].join("\n");
    try { return paneText(value[key]); } catch {}
  }
  throw new Error("Unrecognized Herdr pane-read response");
}

export function shellPrompt(text) {
  const lines = clean(text).split("\n");
  const last = lines.at(-1)?.trim() ?? "";
  // Only the current line counts: answered questions remain in scrollback.
  if (/source it\?/i.test(lines.slice(-3).join("\n")) && /\[y\].*\[n\]/i.test(last)) return "dotenv";
  if (/[?？]\s*(?:\([^\n]*\)|\[[^\n]*\])?\s*$/.test(last)
    || /(?:\[[yn](?:es)?\/[yn](?:o)?\]|\([yn](?:es)?\/[yn](?:o)?\)|:)\s*$/i.test(last)
    || /^(?:>|quote>|dquote>|heredoc>)$/.test(last)) return "question";
  if (/\d(?:\.\d+)?%$/.test(last)) return "unrecognized"; // A stalled progress meter is not a zsh prompt.
  if (/^(?:.*\s)?[❯❱➜λ\uE0B0\uE0B1]$/.test(last) || /(?:^|\S.*)[\s]*[$%#]$/.test(last)) return "ready";
  return last ? "unrecognized" : "waiting";
}

// Settling is additional evidence, not permission to type into arbitrary stable output.
export const promptSettled = (text, previous) => {
  const screen = clean(text).trim();
  return !!screen && typeof previous === "string" && screen === clean(previous).trim();
};

export function trustDialog(text) {
  const t = clean(text).replace(/^[│┃][ \t]?|[ \t]*[│┃]$/gm, "");
  // Use the last question, never an affirmative option or a historical status message.
  const questions = [...t.matchAll(/^\s*(?:(?:Do you trust|Trust (?:this|the))\b[^\n]*|[^\n]*\b(?:folder|directory|project|workspace)\b[^\n]*\btrust\s*\?)[ \t]*$/gmi)];
  const question = questions.at(-1);
  if (!question) return null;
  const below = t.slice(question.index + question[0].length);
  // A later input prompt means the question has already scrolled past.
  if (shellPrompt(below) === "ready") return null;
  const matches = [...below.matchAll(/^[ \t]*([❯›>→▶]?)[ \t]*(\d+)[.)][ \t]+(.+)$/gm)];
  const options = matches
    .map((m) => ({ number: m[2], text: m[3].trim(), selected: !!m[1] }));
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

export function parseLaunchArgs(args) {
  const o = { trust: "ask", timeout: 120000, dryRun: false };
  const values = ["kind", "name", "cwd", "model", "effort", "pane", "direction", "task", "task-file", "trust", "timeout"];
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || (!values.includes(key) && key !== "dry-run")) throw new Error(`Unknown launch option: ${args[i]}`);
    if (seen.has(key)) throw new Error(`Repeated launch option: --${key}`);
    seen.add(key);
    if (key === "dry-run") { o.dryRun = true; continue; }
    if (!args[i + 1]?.trim() || /^-\S/.test(args[i + 1])) throw new Error(`--${key} requires a value`);
    if (args[i + 1].includes("\0")) throw new Error(`--${key} must not contain NUL`);
    o[key] = args[++i];
  }
  if (!Object.hasOwn(HARNESSES, o.kind)) throw new Error("--kind must be claude, codex, cursor, or agy");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(o.name ?? "")) throw new Error("--name must match [a-z][a-z0-9_-]{0,31}");
  if (!["ask", "auto"].includes(o.trust)) throw new Error("--trust must be ask or auto");
  if (o.direction && !["right", "down"].includes(o.direction)) throw new Error("--direction must be right or down");
  if (o.task != null && o["task-file"] != null) throw new Error("Use only one of --task and --task-file");
  o.timeout = Number(o.timeout);
  if (!Number.isSafeInteger(o.timeout) || o.timeout <= 0) throw new Error("--timeout must be a positive integer in milliseconds");
  return o;
}

export function runHerdr(args, timeout) {
  return new Promise((done, reject) => {
    const child = spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (s) => { stdout += s; });
    child.stderr.on("data", (s) => { stderr += s; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Math.max(1, Math.min(timeout, 2147483647)));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let data;
      if (timedOut) return done({ ok: false, data: { error: { code: "timeout", message: "Herdr command timed out" } } });
      try { data = JSON.parse(code === 0 ? stdout : stderr || stdout); }
      catch { data = code === 0 ? stdout : { error: { code: "herdr_failed", message: (stderr || stdout || "Herdr timed out").trim() } }; }
      done({ ok: code === 0 && !data?.error, data });
    });
  });
}

// Inject transport and time for tests; no test needs a live pane.
export async function launch(args, { run = runHerdr, sleep = (ms) => Bun.sleep(ms), now = () => performance.now(), env = process.env,
  cursorConfigSource = join(homedir(), ".cursor", "cli-config.json"), tempRoot = tmpdir() } = {}) {
  const out = { ok: false, state: "failed", kind: null, name: null, pane: null, cwd: resolve("."), model: null, effort: null,
    command: [], argv: [], env: {}, steps: [], warnings: [], needs_human: null, prompt_chars: null };
  const step = (step, ok, detail) => out.steps.push({ step, ok, detail });
  let configDir, createdPane = false, startAttempted = false, touchedPane = false, promptAttempted = false;
  const human = (why, text) => {
    out.ok = false; out.state = "needs_human"; out.needs_human = { why, pane_text: text }; step("needs_human", false, why); return out;
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
    const prompt = task == null ? null : composePrompt(task);
    out.prompt_chars = prompt?.length ?? null;
    // Keep the private config while Cursor runs, then remove it even on an ordinary signal/exit.
    const cursorCommand = ["env", `CURSOR_CONFIG_DIR=${privateDir}`, "sh", "-c",
      `trap 'rm -rf -- "$CURSOR_CONFIG_DIR"' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; ${[p.executable, ...p.argv].map(quote).join(" ")}`].map(quote).join(" ");
    const startArgs = (pane, timeout) => o.kind === "cursor"
      ? ["pane", "run", pane, cursorCommand]
      : ["agent", "start", o.name, "--kind", o.kind, "--pane", pane, "--timeout", String(timeout), "--", ...p.argv];
    const promptArgs = (pane, timeout) => ["agent", "prompt", pane, prompt, "--wait", "--until", "working",
      "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(timeout)];
    if (o.dryRun) {
      const pane = o.pane ?? "<new-pane>";
      out.planned_command = [
        ...(!o.pane ? [...(!o.direction ? [command(["pane", "current", "--current"]), command(["pane", "layout", "--current"])] : []), command(["pane", "split", "--current", "--direction", o.direction ?? "<right-if-wide-else-down>", "--cwd", out.cwd, "--no-focus"])] : []),
        command(["pane", "read", pane, "--source", "visible"]),
        command(["pane", "process-info", "--pane", pane]),
        ...(o.pane ? [command(["pane", "run", pane, `cd -- ${quote(out.cwd)}`]),
          command(["pane", "read", pane, "--source", "visible"]), command(["pane", "process-info", "--pane", pane])] : []),
        command(startArgs(pane, Math.min(o.timeout, 30000))),
        command(["pane", "read", pane, "--source", "visible"]),
        command(["agent", "wait", pane, "--timeout", String(Math.min(1000, o.timeout))]),
        command(["pane", "read", pane, "--source", "visible"]),
        command(["agent", "get", pane]),
        ...(o.kind === "cursor" ? [command(["agent", "rename", pane, o.name])] : []),
        ...(prompt ? [command(promptArgs(pane, Math.max(1, Math.min(Math.floor(o.timeout / 2), 30000)))), command(["agent", "get", pane])] : []),
      ];
      step("plan", true, "No commands executed or files written. Pane ids, geometry, polling, timeouts, shell questions and trust options are resolved at launch.");
      return { ...out, ok: true, state: "planned" };
    }
    if (env.HERDR_ENV !== "1") throw new Error("Launch requires HERDR_ENV=1 inside a Herdr pane");
    const began = now();
    const remaining = () => {
      const ms = Math.floor(o.timeout - (now() - began));
      if (!Number.isFinite(ms) || ms <= 0) throw new Error("Launch readiness timeout");
      return ms;
    };
    const call = async (a, tolerate = false) => {
      const ms = remaining();
      logCommand(out.command, command(a));
      const r = await run(a, ms);
      if (!r.ok && !tolerate) throw new Error(r.data?.error?.message ?? JSON.stringify(r.data));
      return r;
    };
    const readPane = async () => {
      touchedPane = true;
      return paneText((await call(["pane", "read", out.pane, "--source", "visible"])).data);
    };
    const pause = async () => sleep(Math.min(250, remaining()));
    const shellReady = async (expectedCwd) => {
      let answers = 0, answered = false, answeredAt = null, previous = null;
      for (;;) {
        const text = await readPane();
        const info = (await call(["pane", "process-info", "--pane", out.pane])).data.result.process_info;
        const processes = info.foreground_processes ?? [];
        const shell = processes.find((p) => p.pid === info.shell_pid);
        if (processes.some((p) => p.pid !== info.shell_pid)) {
          if (o.pane && !expectedCwd) return human("Pane has a foreground process; refusing to type shell input", text);
          previous = null;
          await pause(); continue; // New shells and directory hooks can run short foreground commands.
        }
        if (!shell) { previous = null; await pause(); continue; }
        const state = shellPrompt(text);
        if (state === "dotenv") {
          if (!answered) {
            if (++answers > 3) return human("Shell repeated the dotenv question", text);
            await call(["pane", "send-keys", out.pane, "n", "enter"]);
            out.warnings.push("Answered no to the shell's dotenv Source it? question.");
            step("shell_answer", true, "dotenv: sent n, enter"); answered = true;
            answeredAt = now();
          }
          if (now() - answeredAt >= 5000) return human("Shell did not clear the dotenv question after answering", text);
        } else {
          answered = false;
          if (state === "question") return human("Unrecognized shell question", text);
          // Even a recognized prompt must settle while the shell remains in the foreground.
          const atPrompt = state === "ready" && promptSettled(text, previous);
          if (atPrompt) {
            if (expectedCwd && realpathSync(shell.cwd) !== realpathSync(expectedCwd)) return human("Shell is at a prompt in the wrong directory", text);
            step("shell_ready", true, `Interactive shell in ${shell.cwd}`); return null;
          }
        }
        previous = text;
        await pause();
      }
    };
    // Check Cursor's copy before creating a pane; never fall back to its account config.
    if (o.kind === "cursor") {
      configDir = privateDir;
      mkdirSync(configDir, { mode: 0o700 });
      copyFileSync(cursorConfigSource, join(configDir, "cli-config.json"));
      chmodSync(join(configDir, "cli-config.json"), 0o600);
      step("cursor_config", true, `Private config at ${configDir}; the launch shell removes it when Cursor exits`);
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
      await call(["pane", "run", out.pane, `cd -- ${quote(out.cwd)}`]);
      await pause();
    }
    stop = await shellReady(out.cwd); if (stop) return stop;
    const startCommand = startArgs(out.pane, Math.min(30000, remaining()));
    startAttempted = true;
    const started = await call(startCommand, true);
    step("start", started.ok, started.ok ? "Herdr accepted the launch" : JSON.stringify(started.data));
    let text = await readPane(); // Codex's trust dialog can be reported as idle.
    const startError = started.data?.error?.code;
    if (!started.ok && !["agent_not_ready", "timeout"].includes(startError)) {
      throw new Error(started.data?.error?.message ?? "Agent start failed");
    }
    let answeredTrust = null, trustAnsweredAt = null;
    for (;;) {
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
      if (trustDialog(text)) continue;
      const got = await call(["agent", "get", out.pane], true);
      if (!got.ok && got.data?.error?.code !== "agent_not_found") throw new Error(got.data?.error?.message ?? "Agent inspection failed");
      const agent = got.data?.result?.agent;
      if (agent && agent.agent !== o.kind) return human("The pane contains a different agent kind", text);
      if (agent?.agent_status === "blocked") return human("Agent is waiting at an unrecognized question or approval", text);
      // Pane-run agents such as Cursor have unknown (null/absent) readiness; only explicit false vetoes idle/done.
      if (got.ok && waited.ok && ["idle", "done"].includes(agent?.agent_status) && agent.interactive_ready !== false) break;
      await pause();
    }
    if (o.kind === "cursor") await call(["agent", "rename", out.pane, o.name]);
    step("ready", true, "Herdr wait settled and the pane has no folder-trust dialog");
    out.state = "ready"; out.ok = true;
    if (prompt) {
      // Reserve time to inspect the result. A prompt is never retried after uncertain submission.
      const budget = remaining();
      if (budget < 2) throw new Error("No time left to submit and verify the prompt");
      const submitMs = Math.min(30000, Math.floor(budget / 2));
      const a = promptArgs(out.pane, submitMs);
      logCommand(out.command, command(a));
      promptAttempted = true;
      const r = await run(a, Math.min(budget, submitMs + Math.min(1000, Math.floor((budget - submitMs) / 2))));
      const got = await call(["agent", "get", out.pane]);
      const agent = got.data?.result?.agent;
      const status = agent?.agent_status ?? "unknown";
      if (agent?.agent !== o.kind) return human("Cannot confirm the prompted agent's identity", await readPane());
      if (status === "blocked") {
        step("prompt", r.ok, r.ok ? `Submitted ${prompt.length} characters; the agent is asking something` : JSON.stringify(r.data));
        return human("The worker is blocked on a question or approval right after its prompt", await readPane());
      } else if ((r.ok && ["working", "idle", "done"].includes(status))
        || (!r.ok && r.data?.error?.code === "timeout" && status === "working")) {
        step("prompt", true, `Submitted ${prompt.length} characters; the agent settled at ${status}`);
        out.state = "prompted";
      } else {
        step("prompt", false, `Could not confirm the worker started (${status}): ${JSON.stringify(r.data)}`);
        out.ok = false; out.state = "failed";
      }
    }
  } catch (e) {
    out.ok = false; out.state = "failed"; step("failed", false, String(e?.message ?? e));
    // The harness may have exited with its own complaint (a model id it does not accept, a login it wants). That
    // message is on the pane and nowhere else, and without it the orchestrator only learns that something timed out.
    if (out.pane && touchedPane) {
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
