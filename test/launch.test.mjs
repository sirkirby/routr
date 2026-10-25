// launch.mjs, herdr.mjs, harnesses.mjs: starting a worker in a herdr pane
import { expect, test } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { plan } from "../src/lib/harnesses.mjs";
import { composePrompt, launch as rawLaunch, parseLaunchArgs, WORKER_GUIDE } from "./contract.mjs";
import { paneText, promptSettled, quote, runHerdr, shellPrompt } from "../src/lib/herdr.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { displayCommand, templateCommand } from "../src/lib/next.mjs";
import { EventEmitter } from "node:events";
import { herdrError, herdrOK, SCRATCH, scratch, SCRIPT, shellInfo } from "./helpers.mjs";
// Every task launch keeps testing its original behavior, with advice on exactly the task it sends.
function matchingAdvice(args) {
  if (args.includes("--advice")) return args;
  const ti = args.indexOf("--task"), fi = args.indexOf("--task-file");
  let task;
  try { task = fi >= 0 ? readFileSync(args[fi + 1], "utf8") : ti >= 0 ? args[ti + 1] : null; } catch { return args; }
  if (task == null) return args;
  const advice = join(scratch("matching-advice"), "advice.json");
  writeFileSync(advice, JSON.stringify({ mode: "dispatch", id: "test-advice", brief_sha: briefSha(task), fallback: true }));
  return [...args, "--advice", advice];
}
const launch = (args, deps) => rawLaunch(matchingAdvice(args), deps);
const instructions = (r) => r.next.map((n) => n.kind === "do" ? `${n.why} ${n.template ?? ""}` : n.command ?? JSON.stringify(n.argv)).join(" ");
const cleanupStep = (r) => r.next.find((n) => n.kind === "run" && n.argv[1] === "cleanup");
test("launch plans use each harness's measured permissions and model syntax", () => {
  expect(plan({ kind: "claude", model: "sonnet", effort: "medium" }).argv)
    .toEqual(["--dangerously-skip-permissions", "--model", "sonnet", "--effort", "medium"]);
  expect(plan({ kind: "codex", model: "gpt-5.6-sol", effort: "high" }).argv)
    .toEqual(["--yolo", "--dangerously-bypass-hook-trust", "-c", "check_for_update_on_startup=false", "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=high"]);
  expect(plan({ kind: "cursor", model: "composer-2.5", cursorConfigDir: "/private/config" }))
    .toMatchObject({ executable: "cursor-agent", argv: ["--yolo", "--trust", "--model", "composer-2.5"], env: { CURSOR_CONFIG_DIR: "/private/config" } });
  expect(plan({ kind: "agy", model: "gemini-3.8-flash-low", cwd: "/work" }).argv)
    .toEqual(["--dangerously-skip-permissions", "--add-dir", "/work", "--model", "gemini-3.8-flash-low"]);
  expect(plan({ kind: "kiro", model: "claude-haiku-4.5" })).toMatchObject({ executable: "kiro-cli", argv: ["chat", "--trust-tools=*", "--model", "claude-haiku-4.5"], env: {} });
});

test("Kiro's effort: auto passes no flag (the model decides, nothing remembered); a level is passed and its side effect said", () => {
  const auto = plan({ kind: "kiro", model: "auto", effort: "auto" });
  expect(auto.argv).toEqual(["chat", "--trust-tools=*", "--model", "auto"]);
  expect(auto.warnings.join(" ")).not.toContain("remembers");
  const high = plan({ kind: "kiro", model: "claude-opus-4.8", effort: "high" });
  expect(high.argv).toEqual(["chat", "--trust-tools=*", "--model", "claude-opus-4.8", "--effort", "high"]);
  expect(high.warnings.join(" ")).toContain("remembers --effort as the user's default for claude-opus-4.8");
  expect(plan({ kind: "claude", model: "sonnet", effort: "auto" }).argv).toContain("auto"); // only Kiro reads auto as "no flag"
});

test("agy rejects separate effort, even when it agrees with the model suffix", () => {
  for (const effort of ["low", "high"]) expect(() => plan({ kind: "agy", model: "gemini-3.8-flash-low", effort, cwd: "/work" })).toThrow("omit --effort");
  expect(() => plan({ kind: "agy", model: "gemini-3.8-flash-low" })).toThrow("--add-dir");
  expect(() => plan({ kind: "cursor", model: "composer-2.5", effort: "low" })).toThrow("no separate --effort");
});

test("a model is required except when only planning; unknown kinds are rejected", () => {
  expect(() => plan({ kind: "claude" })).toThrow("--model is required");
  expect(plan({ kind: "claude", dryRun: true }).warnings).toHaveLength(1);
  expect(() => plan({ kind: "toString", model: "x" })).toThrow("--kind must be claude, codex, cursor, agy, or kiro");
});

test("launch prompt preserves the required opening, task with verification, and closing verbatim", () => {
  const task = "TASK\nFix the parser. Work only in /work.\n\nHOW TO VERIFY\nbun test";
  const prompt = composePrompt(task);
  const doc = readFileSync(new URL("../skills/routr/references/orchestrator.md", import.meta.url), "utf8");
  const opening = doc.match(/       You are a routr worker\.[\s\S]*?orchestrator parses\./)[0].trim().replace(/\s*\n\s*/g, " ").replace("~/.agents/skills/routr/references/worker.md", WORKER_GUIDE);
  expect(isAbsolute(WORKER_GUIDE)).toBe(true);
  expect(prompt).toBe(`${opening}\n\n${task}\n\nFinish with the report block from the worker guide, starting with the line \`VERDICT: done | partial | blocked\`.`);
});

test("--rules-file goes to the worker after the task, and only the task is compared with the advice", async () => {
  const { briefSha } = await import("../src/lib/ledger.mjs");
  expect(composePrompt("Do X.", "/g.md", "Do not push.\n")).toBe(composePrompt("Do X.\n\nDo not push.", "/g.md"));
  expect(composePrompt("Do X.", "/g.md", null)).toBe(composePrompt("Do X.", "/g.md"));
  const dir = scratch("rules-file"), task = join(dir, "task.md"), rules = join(dir, "rules.md"), advice = join(dir, "advice.json");
  writeFileSync(task, "Fix the flaky retry test in src/retry.mjs.\n"); writeFileSync(rules, "Do not edit anything outside src/. Commit on your branch; never push.\n");
  writeFileSync(advice, JSON.stringify({ mode: "dispatch", id: "advice-test", brief_sha: briefSha("Fix the flaky retry test in src/retry.mjs.") }));
  const r = await launch([...launchArgs, "--task-file", task, "--rules-file", rules, "--advice", advice, "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); } });
  expect(r.advice).toEqual({ file: advice, matches: true }); // the rules are not part of what routr judged
  expect(r.prompt_chars).toBe(composePrompt(readFileSync(task, "utf8"), WORKER_GUIDE, readFileSync(rules, "utf8")).length);
  expect(() => parseLaunchArgs([...launchArgs, "--rules-file", rules])).toThrow("--rules-file goes with a task");
  writeFileSync(rules, "  \n");
  expect((await launch([...launchArgs, "--task-file", task, "--rules-file", rules, "--dry-run"])).steps.at(-1).detail).toContain("The rules file must not be empty");
});

test("shell detection tells a question, a clean prompt, and unfinished startup apart; no plugin is known by name", () => {
  expect(shellPrompt("found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver) ")).toBe("question");
  for (const text of ["chris@host repo % ", "user@host:~/repo$ ", "❯ ", "\x1b[32m❯\x1b[0m ", "root #", "found '.env' file. Source it? ([y]es/[N]o)\n❯ "])
    expect(shellPrompt(text)).toBe("ready");
  expect(shellPrompt("")).toBe("waiting");
  expect(shellPrompt("Install the plugin? [y/N]")).toBe("question");
  expect(shellPrompt(" dev@workstation  ~/Repos/routr  ↱ routr-skill ")).toBe("ready");
  expect(shellPrompt("> ")).toBe("question");
  for (const text of ["Loading...", "❯ bun test", "100% complete"])
    expect(shellPrompt(text)).toBe("unrecognized");
});

test("shell output that merely ends like a prompt never counts on its own", () => {
  // Found by an audit of this code: these come from the shell itself, so no foreground process gives them away.
  for (const text of ["Downloading plugins 45%", "nvm: installed 100%", "plugin cache rebuilt: 12 files $"])
    expect(promptSettled(text, "something else")).toBe(false);
  expect(promptSettled("Downloading plugins 45%", "Downloading plugins 45%")).toBe(true); // settled: the launcher then also requires an idle shell
});

test("an unrecognized prompt counts only once it has stopped changing", () => {
  const powerline = " dev@workstation  ~/Repos/routr  ↱ routr-skill ";
  expect(promptSettled(powerline, powerline.trim())).toBe(true);   // same line twice: settled
  expect(promptSettled(powerline, "Loading...")).toBe(false);       // still changing
  expect(promptSettled("", "")).toBe(false);                        // nothing on the line is never a prompt
});

// Claude Code 2.1.284's folder trust, read from a herdr pane (2026-09-28): routr no longer parses it, herdr reports it
// blocked. It differs from 2.1.283's (numbered, "Yes" first): screen patterns for it did not last one release.
const claudeTrust = " Accessing workspace:\n /private/tmp/work\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not,\n take a moment to review what's in this folder first.\n Claude Code'll be able to read, edit, and execute files here.\n Security guide\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel";

test("pane reads extract text from JSON without mistaking envelope fields for pane contents", () => {
  expect(paneText({ id: "cli:pane:read", result: { text: claudeTrust, type: "pane_read" } })).toBe(claudeTrust);
  expect(paneText({ result: { snapshot: { lines: ["hello", "❯"] } } })).toBe("hello\n❯");
  expect(paneText("❯")).toBe("❯");
  expect(() => paneText({ result: { type: "unknown" } })).toThrow("Unrecognized");
});

test("launch --advice refuses when the advice was given on a different text than the task it sends", async () => {
  const { briefSha } = await import("../src/lib/ledger.mjs");
  const dir = scratch("launch-advice"), task = join(dir, "task.md"), advice = join(dir, "advice.json");
  writeFileSync(task, "Fix the flaky retry test in src/retry.mjs.\n");
  const go = (a) => launch([...launchArgs, "--task-file", task, "--advice", a, "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); } });
  writeFileSync(advice, JSON.stringify({ mode: "dispatch", id: "advice-test", brief_sha: briefSha("Fix the flaky retry test in src/retry.mjs.") })); // dispatch trims, as launch does
  const same = await go(advice);
  expect(same.advice).toEqual({ file: advice, matches: true });
  expect(same.warnings.join(" ")).not.toContain("different text");
  writeFileSync(advice, JSON.stringify({ mode: "dispatch", id: "advice-test", brief_sha: briefSha("Retry test: see the task file for paths.") })); // a summary, as leads wrote 8 times
  const other = await go(advice);
  expect(other.advice).toEqual({ file: advice, matches: false });
  expect(other.error).toContain("was given on a different text than this task");
  const unread = await go(join(dir, "missing.json"));
  expect(unread.error).toContain("could not read it");
  expect(unread.advice).toBeUndefined();
});

test("launch options are validated before any pane operation", () => {
  const base = ["--kind", "claude", "--name", "worker"];
  for (const extra of [["--timeout", "0"], ["--timeout", "NaN"], ["--trust", "yes"], ["--direction", "left"], ["--task", "a", "--task-file", "b"], ["--model"], ["--bogus"], ["--name", "duplicate"]])
    expect(() => parseLaunchArgs([...base, ...extra])).toThrow();
  expect(parseLaunchArgs(base)).toMatchObject({ timeout: 120000, dryRun: false });
  expect(quote("a'$(touch /tmp/no);`whoami`\n")).toBe("'a'\\''$(touch /tmp/no);`whoami`\n'");
});

// A herdr session with one shell pane. `dotenv`: the user's shell asks its plugin's question first (routr answers none).
function fakeHerdr({ kind = "claude", trust = null, notReady = false, foreground = false, stuck = false, dotenv = false, reply = () => undefined } = {}) {
  let stage = "shell", ticks = 0;
  const calls = [];
  const ok = (result) => ({ ok: true, data: { result } });
  const deps = {
    // Tests start no harness: a model list read would run the real CLI (Kiro's opened its sign-in in a browser).
    models: async () => { throw new Error("a test must pass models() itself; the real one starts the harness"); },
    env: { HERDR_ENV: "1" }, now: () => ticks, sleep: async (ms) => { ticks += ms; }, ready: async () => null,
    run: async (a, ms) => {
      calls.push(a);
      const override = await reply(a, ms);
      if (override !== undefined) return override;
      if (a[0] === "pane" && a[1] === "current") return ok({ pane: { pane_id: "w1:p1" } });
      if (a[1] === "layout") return ok({ layout: { panes: [{ pane_id: "w1:p1", rect: { width: 100, height: 40 } }] } });
      if (a[1] === "split") return ok({ pane: { pane_id: "w1:p2" } });
      if (a[1] === "read") return ok({ text: stage === "shell" ? (dotenv ? "found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)" : "chris % ") : stage === "trust" ? trust : "Welcome\n❯" });
      if (a[1] === "process-info") return ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: foreground ? 2 : 1, cwd: process.cwd() }] } });
      if (a[1] === "send-keys") throw new Error(`launch pressed ${a.slice(3).join(" ")}; it answers no question`);
      if (a[1] === "run") return ok({});
      if (a[1] === "close" || a[1] === "rename") return ok({});
      if (a[1] === "start") {
        stage = trust ? "trust" : "starting";
        return notReady ? { ok: false, data: { error: { code: "agent_not_ready", message: "blocked on startup" } } } : ok({});
      }
      // A question at startup: herdr reports the agent blocked, and explains it with its own rule.
      if (a[1] === "wait") { if (stage === "trust") return { ok: false, data: { error: { code: "agent_not_ready", message: "blocked during startup" } } }; if (!stuck) stage = "ready"; return ok({}); }
      // As herdr: a pane with no agent in it yet has none to get.
      if (a[1] === "get" && stage === "shell") return { ok: false, data: { error: { code: "agent_not_found", message: "no agent" } } };
      if (a[1] === "get") return ok({ agent: { agent: kind, agent_status: stage === "ready" ? "idle" : stage === "trust" ? "blocked" : "unknown", interactive_ready: stage === "ready" } });
      if (a[1] === "explain") return { ok: true, data: { agent: kind, state: "blocked", matched_rule: { id: "live_blocked_form" }, manifest_version: "2026.09.11.1" } };
      if (a[1] === "prompt") { expect(stage).toBe("ready"); expect(a).toContain("--wait"); return ok({}); }
      throw new Error(`Unexpected command ${a.join(" ")}`);
    },
  };
  return { calls, deps };
}

const launchArgs = ["--kind", "claude", "--name", "worker", "--model", "sonnet"];

test("startup waits for the shell, recovers agent_not_ready, then prompts", async () => {
  const f = fakeHerdr({ notReady: true });
  const r = await launch([...launchArgs, "--task", "Fix the parser. Verify with bun test."], f.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w1:p2" });
  expect(r.steps.map((s) => s.step).indexOf("ready")).toBeLessThan(r.steps.map((s) => s.step).indexOf("prompt"));
});

test("startup next uses the guide's trust rule and leaves an unauthorized question waiting", async () => {
  const f = fakeHerdr({ trust: claudeTrust, notReady: true });
  const r = await launch([...launchArgs, "--task", "Task"], f.deps);
  const instruction = r.next.find((n) => n.template?.startsWith("herdr pane send-keys "));
  expect(instruction?.why).toContain("Accept folder trust only for a directory you created or a worktree of the repository the user already has you working in");
  expect(instruction.why).toContain("otherwise ask the user and leave the pane waiting");
  expect(instruction.why).toContain('the default answer can be "No, exit"');
  expect(instruction.why).toContain("Read the pane and its options before sending keys");
  expect(instruction.why).toContain("secret or sign-in");
  const guide = readFileSync(new URL("../skills/routr/references/orchestrator.md", import.meta.url), "utf8");
  const rule = guide.match(/<!-- startup-input -->\s*([\s\S]*?)\s*<!-- \/startup-input -->/)?.[1].replace(/\s*\n\s*/g, " ");
  expect(instruction.why).toBe(rule);
  expect(r.state).toBe("needs_input");
  expect(f.calls.some((a) => ["send-keys", "prompt", "close"].includes(a[1]))).toBe(false);
});

test("a question at startup is never answered: herdr's reading and the screen go to the orchestrator, with what the registry knows", async () => {
  // The retired routr --trust flag is refused; harness startup still stops at a question.
  for (const extra of [[]]) {
    const f = fakeHerdr({ trust: claudeTrust, notReady: true });
    const r = await launch([...launchArgs, ...extra, "--task", "Task"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "needs_input", screen: claudeTrust, needs_input: { herdr: { state: "blocked", rule: "live_blocked_form", rules: "2026.09.11.1" } } });
    expect(r.needs_input.why).toContain("herdr reads it as live_blocked_form, rules 2026.09.11.1");
    expect(r.needs_input.note).toContain("trusted the repository in Claude"); // Claude's own way to be asked no more
    // How to carry on: the same launch into this pane, which adopts the agent once the question is answered.
    expect(instructions(r)).toContain("--pane w1:p2");
    // An inline brief is never repeated; the do template is clearly marked for the orchestrator to fill.
    expect(instructions(r)).toContain("with your --task given again");
    expect(r.next.find((n) => n.template?.includes("--task <your-task>")).template).toMatch(/--task <your-task>$/);
    expect(instructions(r)).not.toContain("'Task'");
    expect(f.calls.some((a) => a[1] === "prompt")).toBe(false);
    expect(f.calls.filter((a) => a[1] === "send-keys")).toHaveLength(0);
    expect(() => parseLaunchArgs([...launchArgs, "--trust", "auto"])).toThrow("Unknown launch option: --trust");
  }
  // Herdr's explanation is extra; when it errors, throws, or comes back in another shape, the confirmed block is
  // still reported as needs_input, with the screen and the registry's note.
  for (const explain of [() => herdrError("invalid_request"), () => { throw new Error("herdr went away"); }, () => herdrOK({ nothing: true })]) {
    const f = fakeHerdr({ trust: claudeTrust, notReady: true, reply: (a) => (a[1] === "explain" ? explain() : undefined) });
    const r = await launch([...launchArgs, "--task", "Task"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "needs_input", screen: claudeTrust, needs_input: { herdr: { state: "blocked" } } });
    expect(r.needs_input.note).toContain("trusted the repository in Claude");
    expect(r.needs_input.why).not.toContain("herdr reads it as");
  }
});


test("an existing occupied pane receives no input and is never closed", async () => {
  const f = fakeHerdr({ foreground: true });
  const r = await launch([...launchArgs, "--pane", "w1:p9"], f.deps);
  expect(r.state).toBe("needs_input");
  expect(f.calls.every((a) => ["get", "read", "process-info"].includes(a[1]))).toBe(true); // looks, never types
});

test("startup timeout fails without ever prompting or closing the pane", async () => {
  const f = fakeHerdr({ stuck: true });
  const r = await launch([...launchArgs, "--timeout", "1500", "--task", "Task"], f.deps);
  expect(r.state).toBe("failed");
  expect(r.steps.at(-1).detail).toContain("timeout");
  expect(f.calls.some((a) => ["prompt", "close"].includes(a[1]))).toBe(false);
});

test("dry runs perform no transport calls, including for Cursor isolation", async () => {
  for (const [kind, model] of [["claude", "sonnet"], ["codex", "gpt-5.6-sol"], ["cursor", "composer-2.5"], ["agy", "gemini-3.8-flash-low"]]) {
    const r = await launch(["--kind", kind, "--name", "t", "--model", model, "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); } });
    expect(r).toMatchObject({ ok: true, state: "planned", pane: null, ran: [] });
    expect(r.would_run.length).toBeGreaterThan(0);
    if (kind === "cursor") expect(existsSync(r.start.env.CURSOR_CONFIG_DIR)).toBe(false);
  }
});

test("task files are read and wrapped before any launch operation", async () => {
  const file = `${import.meta.dir}/../package.json`;
  const r = await launch([...launchArgs, "--task-file", file, "--dry-run"]);
  expect(r.state).toBe("planned");
  expect(r.prompt_chars).toBe(composePrompt(readFileSync(file, "utf8")).length);
  const missing = await launch([...launchArgs, "--task-file", "/does-not-exist", "--dry-run"]);
  expect(missing).toMatchObject({ ok: false, state: "failed", ran: [] });
});

test("launch CLI emits one JSON object for invalid input and preserves --version", () => {
  const result = Bun.spawnSync(["bun", SCRIPT, "launch", ...launchArgs, "--timeout", "bad"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString()).state).toBe("failed");
  const version = Bun.spawnSync(["bun", SCRIPT, "--version"]);
  expect(version.exitCode).toBe(0);
  expect(version.stdout.toString().trim()).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

test("launch rejects missing kinds, flag values, empty values, NUL, and every repeated option", () => {
  for (const args of [[], ["--name", "worker"], ["--kind", "toString", "--name", "worker"], ["--kind", "claude"]])
    expect(() => parseLaunchArgs(args)).toThrow();
  for (const option of ["kind", "name", "cwd", "model", "effort", "pane", "direction", "task", "task-file", "timeout"]) {
    for (const value of ["-h", "--bogus", "", "  ", "a\0b"])
      expect(() => parseLaunchArgs([`--${option}`, value, ...launchArgs])).toThrow();
    expect(() => parseLaunchArgs([`--${option}`, "value", `--${option}`, "again", ...launchArgs])).toThrow("Repeated");
  }
  expect(() => parseLaunchArgs([...launchArgs, "--dry-run", "--dry-run"])).toThrow("Repeated");
  for (const value of ["-1", "1.5", "Infinity", "9007199254740992"])
    expect(() => parseLaunchArgs([...launchArgs, "--timeout", value])).toThrow();
  expect(parseLaunchArgs([...launchArgs, "--task", "- Fix this\n- Run tests"]).task).toStartWith("- Fix");
});

test("preflight failures never read an adopted pane, even for dry runs or outside Herdr", async () => {
  for (const args of [
    ["--kind", "claude", "--name", "worker"],
    [...launchArgs, "--cwd", "/does-not-exist", "--dry-run"],
    [...launchArgs, "--task-file", "/does-not-exist", "--dry-run"],
    [...launchArgs],
  ]) {
    const f = fakeHerdr(); f.deps.env = {};
    const r = await launch([...args, "--pane", "w1:p9"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "failed", ran: [] });
    expect(f.calls).toEqual([]);
  }
});

test("launch dispatch cannot be intercepted by a --version option or task value", () => {
  for (const suffix of [["--version"], ["--task", "--version"]]) {
    const r = Bun.spawnSync(["bun", SCRIPT, "launch", ...launchArgs, ...suffix]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ ok: false, state: "failed", ran: [] });
  }
});

test("terminal normalization handles CRLF, redraws, backspaces, and shell input questions", () => {
  for (const text of ["old output\r\n\x1b[32m❯\x1b[0m ", "Loading...\r❯         ", "❯x\b "])
    expect(shellPrompt(text)).toBe("ready");
  expect(shellPrompt("Loading...\r❯")).toBe("unrecognized"); // CR moves the cursor; it does not erase a line.
  expect(shellPrompt("❯x\b")).toBe("unrecognized");
  expect(promptSettled("Loading...\r❯         ", "❯")).toBe(true);
  for (const text of ["Continue [y/N]", "Continue (yes/no)", "Password:", "quote>", "heredoc>"])
    expect(shellPrompt(text)).toBe("question");
  expect(paneText({ text: "envelope", result: { text: "actual pane" } })).toBe("actual pane");
  expect(paneText(["hello", "❯"])).toBe("hello\n❯");
  expect(() => paneText({ error: { message: "failed" }, text: "stale pane" })).toThrow();
  expect(() => paneText({ text: "envelope", result: {} })).toThrow();
});

test("stable arbitrary shell text and partial input never authorize a launch", async () => {
  for (const text of ["Loading...", "Downloading plugins 45%", "❯ bun test", "Password:", "> "]) {
    const f = fakeHerdr({ reply: (a) => a[1] === "read" ? herdrOK({ text }) : undefined });
    const r = await launch([...launchArgs, "--pane", "w1:p9", "--timeout", "1000"], f.deps);
    expect(r.ok).toBe(false);
    expect(f.calls.some((a) => ["send-keys", "run", "start", "close"].includes(a[1]))).toBe(false);
  }
});

test("shell questions receive no keys without evidence that the shell is foreground", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "process-info" ? shellInfo([]) : undefined });
  const r = await launch([...launchArgs, "--pane", "w1:p9", "--timeout", "1000"], f.deps);
  expect(r.ok).toBe(false);
  expect(f.calls.some((a) => ["send-keys", "start", "run"].includes(a[1]))).toBe(false);
});

test("a long shell startup respects --timeout instead of an unrelated 240-poll cap", async () => {
  let polls = 0;
  const f = fakeHerdr({ reply: (a) => a[1] === "process-info" && ++polls <= 245 ? shellInfo([{ pid: 2 }]) : undefined });
  const r = await launch([...launchArgs, "--timeout", "70000"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "ready" });
  expect(f.deps.now()).toBeGreaterThan(60000);
});

test("worktree launch waits through unreadable shell processes, including the second poll", async () => {
  let polls = 0;
  const f = fakeHerdr({ reply: (a) => {
    if (a[0] === "worktree") return herdrOK({ root_pane: { pane_id: "w1:p2" }, worktree: { path: process.cwd() } });
    if (a[1] === "process-info" && [2, 3, 4].includes(++polls)) return herdrOK({ process_info: {} });
    if (a[1] === "start") expect(polls).toBe(6); // a fresh pair of settled, readable prompt observations
  } });
  expect(await launch([...launchArgs, "--worktree", "worker"], f.deps)).toMatchObject({ ok: true, state: "ready" });
  expect(f.calls.some((a) => a[1] === "start")).toBe(true);
});

test("unreadable shell processes wait until the launch deadline, say why, and authorize no typing", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "process-info" ? herdrOK({ process_info: {} }) : undefined });
  const r = await launch([...launchArgs, "--timeout", "1000"], f.deps);
  expect(r).toMatchObject({ ok: false, state: "failed", error: expect.stringContaining("pane's processes could not be read") });
  expect(f.deps.now()).toBe(1000);
  expect(f.calls.some((a) => ["run", "send-text", "send-keys", "start", "prompt"].includes(a[1]))).toBe(false);
});

test("shell readiness still stops immediately when herdr is unreachable, refuses, or loses the pane", async () => {
  for (const code of ["server_not_running", "boom", "pane_not_found"]) {
    const f = fakeHerdr({ reply: (a) => a[1] === "process-info" ? herdrError(code) : undefined });
    const r = await launch([...launchArgs, "--timeout", "1000"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "failed", error: expect.stringContaining(code === "server_not_running" ? "herdr_unreachable" : "herdr_refused") });
    expect(f.deps.now()).toBe(0);
    expect(f.calls.some((a) => ["run", "send-text", "send-keys", "start", "prompt"].includes(a[1]))).toBe(false);
  }
});

test("shell readiness reports its deadline when a herdr call consumes the remaining time", async () => {
  for (const unreadable of [false, true]) for (const op of ["read", "process-info"]) {
    let polls = 0;
    const f = fakeHerdr({ reply: async (a, ms) => {
      if (a[1] === op && polls >= 1 && f.deps.now() < 1000) { await f.deps.sleep(ms); return herdrError("timeout"); }
      if (a[1] === "process-info") { polls++; return unreadable ? herdrOK({ process_info: {} }) : shellInfo([{ pid: 2 }]); }
    } });
    const r = await launch([...launchArgs, "--timeout", "1000"], f.deps);
    expect(r.error).toBe(unreadable ? "The pane's processes could not be read before the shell readiness deadline" : "Launch readiness timeout");
    expect(f.deps.now()).toBe(1000);
    expect(f.calls.some((a) => ["run", "send-text", "send-keys", "start", "prompt"].includes(a[1]))).toBe(false);
  }
});

test("shell readiness starts no herdr read with less than 50 ms left, before either call", async () => {
  for (const unreadable of [false, true]) for (const op of ["read", "process-info"]) {
    let polls = 0, shortCalls = 0, advanced = false;
    const f = fakeHerdr({ reply: async (a, ms) => {
      if (["read", "process-info"].includes(a[1]) && ms < 50) shortCalls++;
      if (a[1] === "process-info") { polls++; return unreadable ? herdrOK({ process_info: {} }) : shellInfo([{ pid: 2 }]); }
      if (a[1] === "read" && polls === 1 && op === "process-info" && !advanced) { advanced = true; await f.deps.sleep(20); }
    } });
    const r = await launch([...launchArgs, "--timeout", op === "process-info" ? "310" : "280"], f.deps);
    expect(r.error).toBe(unreadable ? "The pane's processes could not be read before the shell readiness deadline" : "Launch readiness timeout");
    expect(shortCalls).toBe(0);
    expect(polls).toBe(1);
    expect(f.deps.now()).toBe(op === "process-info" ? 270 : 250);
  }
});

test("shell readiness preserves early herdr timeouts and non-timeout failures even at its deadline", async () => {
  for (const [code, elapsed] of [["timeout", 20], ["server_not_running", 1000], ["boom", 1000]]) {
    const f = fakeHerdr({ reply: async (a) => {
      if (a[1] === "process-info") { await f.deps.sleep(elapsed); return herdrError(code); }
    } });
    const r = await launch([...launchArgs, "--timeout", "1000"], f.deps);
    expect(r.error).toContain(code === "boom" ? "herdr_refused" : "herdr_unreachable");
    expect(f.deps.now()).toBe(elapsed);
  }
});

test("a prompt must settle again after an intervening foreground command", async () => {
  let polls = 0;
  const f = fakeHerdr({ reply: (a) => {
    if (a[1] === "read" && !f.calls.some((c) => c[1] === "start")) return herdrOK({ text: "❯" });
    if (a[1] === "process-info") return shellInfo(++polls === 2 ? [{ pid: 2 }] : undefined);
    if (a[1] === "start") { expect(polls).toBe(4); return herdrOK(); }
  } });
  expect((await launch(launchArgs, f.deps)).ok).toBe(true);
});

test("a fixed prompt line does not hide changing startup output above it", async () => {
  expect(promptSettled("Loading 2\n❯", "Loading 1\n❯")).toBe(false);
  let reads = 0, started = false;
  const f = fakeHerdr({ reply: (a) => {
    if (a[1] === "read" && !started) return herdrOK({ text: `Loading ${Math.min(++reads, 3)}\n❯` });
    if (a[1] === "start") { started = true; expect(reads).toBe(4); return herdrOK(); }
  } });
  expect((await launch(launchArgs, f.deps)).ok).toBe(true);
});

test("a question the user's shell asks at startup is not answered: its screen goes to the orchestrator with how to carry on", async () => {
  const f = fakeHerdr({ dotenv: true }), task = join(scratch("shell-question"), "task.md");
  writeFileSync(task, "Task");
  const r = await launch([...launchArgs, "--task-file", task], f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_input", screen: expect.stringContaining("Source it?") });
  expect(r.needs_input.why).toContain("asked a question");
  expect(instructions(r)).toContain("herdr pane send-keys w1:p2");
  expect(r.next.find((n) => n.kind === "run" && n.argv[1] === "launch").argv).toContain(task);
  expect(f.calls.some((a) => ["send-keys", "start", "prompt"].includes(a[1]))).toBe(false);
});

test("a pane adopted at a shell already in --cwd gets no cd: its directory hooks (a dotenv plugin) would ask again", async () => {
  const here = fakeHerdr();
  const r = await launch([...launchArgs, "--pane", "w1:p9", "--cwd", process.cwd()], here.deps);
  expect(r).toMatchObject({ ok: true, state: "ready" });
  expect(here.calls.some((a) => a[1] === "run")).toBe(false);
  const elsewhere = fakeHerdr();
  await launch([...launchArgs, "--pane", "w1:p9", "--cwd", SCRATCH], elsewhere.deps);
  expect(elsewhere.calls.some((a) => a[1] === "run" && a[3].includes("cd"))).toBe(true); // still moved when it is not there
});

test("an agent of another kind in a pane launch did not make is never offered for closing", async () => {
  let started = false;
  const f = fakeHerdr({ reply: (a) => { if (a[1] === "start") started = true; if (a[1] === "get" && started) return herdrOK({ agent: { agent: "codex", agent_status: "idle" } }); } });
  const passed = await launch([...launchArgs, "--pane", "w1:p9", "--cwd", process.cwd()], f.deps);
  expect(instructions(passed)).toContain("Leave that pane; choose another, or leave --pane off");
  started = false;
  const made = await launch(launchArgs, fakeHerdr({ reply: (a) => { if (a[1] === "start") started = true; if (a[1] === "get" && started) return herdrOK({ agent: { agent: "codex", agent_status: "idle" } }); } }).deps);
  expect(instructions(made)).toContain("Close the pane this launch made (herdr pane close w1:p2)");
});

test("--pane adopts only an idle agent of the kind asked for, in --cwd; anything else goes back with the screen", async () => {
  const here = process.cwd();
  // An adopted agent is not waited on, so the fake's own "ready" stage (set by a wait) never comes: the prompt is taken here.
  const taking = (reply) => (a) => (a[1] === "prompt" ? herdrOK({}) : reply(a));
  const occupying = (agent, extra = {}) => fakeHerdr({ reply: taking((a) => (a[1] === "get" && a[2] === "w1:p9" ? herdrOK({ agent: { agent: "claude", agent_status: "idle", interactive_ready: true, cwd: here, ...agent } }) : undefined)), ...extra });
  const args = [...launchArgs, "--pane", "w1:p9", "--cwd", here, "--task", "Task"];
  // The `next` of a launch that stopped at a startup question: the agent is running, idle, the question answered.
  const adopt = occupying({});
  const r = await launch(args, adopt.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w1:p9" });
  expect(r.steps.map((st) => st.step)).toContain("adopt");
  expect(adopt.calls.some((a) => ["start", "run", "send-keys", "wait"].includes(a[1]))).toBe(false); // no shell, no second agent, no wait
  // Another kind, another folder, a working or a blocked agent are never sent the task.
  for (const [agent, why] of [[{ agent: "codex" }, "The pane runs codex, not claude"], [{ cwd: SCRATCH }, `works in ${SCRATCH}`],
    [{ agent_status: "working" }, "is working, not waiting for a task"], [{ agent_status: "blocked" }, "is waiting at a question"],
    [{ agent_status: "idle", interactive_ready: false }, "is idle but not ready for input, not waiting for a task"]]) {
    const f = occupying(agent);
    const x = await launch(args, f.deps);
    expect([why, x.state]).toEqual([why, "needs_input"]);
    expect(x.needs_input.why).toContain(why);
    expect(f.calls.some((a) => ["start", "prompt", "send-keys", "rename"].includes(a[1]))).toBe(false);
  }
  // A rename that fails is said, with the pane to address instead.
  const unnamed = fakeHerdr({ reply: taking((a) => (a[1] === "get" && a[2] === "w1:p9" ? herdrOK({ agent: { agent: "claude", agent_status: "idle", cwd: here } }) : a[1] === "rename" ? herdrError("name_taken") : undefined)) });
  const u = await launch(args, unnamed.deps);
  expect(u.state).toBe("prompted");
  expect(instructions(u)).toContain("Address this worker by its pane, w1:p9");
  // Cursor too: its later rename (for one launch started) is not repeated for an adopted agent.
  const cursor = fakeHerdr({ kind: "cursor", reply: taking((a) => (a[1] === "get" && a[2] === "w1:p9" ? herdrOK({ agent: { agent: "cursor", agent_status: "idle", cwd: here } }) : a[1] === "rename" ? herdrError("name_taken") : undefined)) });
  const c = await launch(["--kind", "cursor", "--name", "worker", "--model", "composer-2.5", "--pane", "w1:p9", "--cwd", here, "--task", "Task"], cursor.deps);
  expect(c.state).toBe("prompted");
  expect(cursor.calls.filter((a) => a[1] === "rename")).toHaveLength(1);
});

// Seen 2026-10-05 (Codex, herdr rules 2026.10.01.1): the orchestrator answered Codex's folder trust and followed `next` at
// once. herdr's `agent get` still said blocked while `agent explain` already read idle (osc_title_idle), and launch
// reported a ready agent as "waiting at a question". herdr is replayed here by its lifecycle state alone: `gets` is
// what `agent get` says, in order (the last one repeats), `explains` what `agent explain` reads.
const codexTrust = "> You are in /private/tmp/work\n  Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit";
const explained = (state, rule) => ({ ok: true, data: { agent: "codex", state, matched_rule: rule ? { id: rule } : null, manifest_version: "2026.10.01.1" } });
// `cost`: what each herdr command takes on the fake clock; `reads`: what a pane read answers, when not the screen.
const codexPane = (gets, explains, { cost = 0, reads } = {}) => {
  let prompted = false;
  const next = (list) => (list.length > 1 ? list.shift() : list[0]);
  const f = fakeHerdr({ kind: "codex", reply: async (a) => {
    if (cost) await f.deps.sleep(cost);
    if (a[1] === "prompt") { prompted = true; return herdrOK({}); }
    if (a[1] === "get" && a[2] === "w1:p2") { const s = prompted ? "working" : next(gets); return herdrOK({ agent: { agent: "codex", agent_status: s, cwd: process.cwd(), interactive_ready: s === "idle" } }); }
    if (a[1] === "explain") return next(explains);
    if (a[1] === "read" && reads) return reads;
  } });
  return f;
};
const adoptArgs = ["--kind", "codex", "--name", "review", "--model", "gpt-6.1-sol", "--task", "Task", "--pane", "w1:p2", "--cwd", process.cwd()];

test("the `next` of a startup question adopts the agent at once when herdr's live reading is idle, and never waits on it", async () => {
  const dir = scratch("adopt-ready"), task = join(dir, "task.md");
  writeFileSync(task, "Review the parser for hidden state.\n");
  const codex = ["--kind", "codex", "--name", "review", "--model", "gpt-6.1-sol", "--effort", "high", "--task-file", task];
  // 1. The first launch stops at the trust question: herdr reads it blocked, by trust_directory.
  const first = fakeHerdr({ kind: "codex", trust: codexTrust, notReady: true, reply: (a) => (a[1] === "explain" ? explained("blocked", "trust_directory") : undefined) });
  const stopped = await launch(codex, first.deps);
  expect(stopped).toMatchObject({ state: "needs_input", needs_input: { herdr: { state: "blocked", rule: "trust_directory" } } });
  expect(stopped.needs_input.note).toContain("trusted the repository in Codex"); // Codex's own way to be asked no more
  // 2. The orchestrator answers it (herdr pane send-keys w1:p2 enter) and follows `next` at once: herdr's state still says
  // blocked, its explain (the live reading) says idle. The block is stale: the agent is adopted as idle.
  // The follow-up carries exact argv, independent of path quoting on each platform.
  const resume = stopped.next.find((n) => n.kind === "run" && n.argv[1] === "launch");
  expect(resume.argv.slice(0, codex.length + 2)).toEqual(["routr", "launch", ...codex]);
  expect(resume.argv.slice(-4)).toEqual(["--pane", "w1:p2", "--cwd", process.cwd()]);
  const again = [...codex, "--pane", "w1:p2", "--cwd", process.cwd()];
  for (const reads of ["idle", "done"]) {
    const stale = codexPane(["blocked"], [explained(reads, `osc_title_${reads}`)]);
    const r = await launch(again, stale.deps);
    expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w1:p2" });
    expect(r.steps.map((s) => s.step)).toEqual(["explain", "adopt", "prompt"]);
    expect(stale.calls.filter((a) => a[1] === "get")).toHaveLength(2); // the one reading, and the prompt's outcome
    expect(stale.calls.some((a) => ["wait", "start", "run", "send-keys"].includes(a[1]))).toBe(false); // nothing waited on, no key pressed
  }
  // herdr reads it idle outright: no explain, no wait.
  const idle = codexPane(["idle"], [explained("blocked", "trust_directory")]);
  const i = await launch(again, idle.deps);
  expect(i.steps.map((s) => s.step)).toEqual(["adopt", "prompt"]);
  expect(idle.calls.some((a) => ["explain", "wait"].includes(a[1]))).toBe(false);
  // Still blocked by both readings: the question goes back, with herdr's rule, and nothing is sent.
  const blocked = codexPane(["blocked"], [explained("blocked", "trust_directory")]);
  const b = await launch(again, blocked.deps);
  expect(b).toMatchObject({ state: "needs_input", needs_input: { herdr: { state: "blocked", rule: "trust_directory", rules: "2026.10.01.1" } } });
  expect(b.needs_input.why).toContain("herdr reads it as trust_directory");
  expect(blocked.calls.some((a) => ["prompt", "send-keys", "rename", "wait"].includes(a[1]))).toBe(false);
});

// From the verification of d47051e: an adopted agent's rename ran before the task with all of --timeout, and one that
// hung left no time to submit it (failed, nothing sent). The rename now follows the submission, on its own allowance.
test("an adopted agent's rename that hangs costs only the name: the task is sent first", async () => {
  const f = fakeHerdr({ kind: "codex", reply: async (a, ms) => {
    if (a[1] === "rename") { await f.deps.sleep(ms); return herdrError("timeout"); } // uses everything it is given
    if (a[1] === "prompt") return herdrOK({});
    if (a[1] === "get" && a[2] === "w1:p2") return herdrOK({ agent: { agent: "codex", agent_status: "idle", interactive_ready: true, cwd: process.cwd() } });
  } });
  const r = await launch([...adoptArgs, "--timeout", "5000"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted" });
  expect(r.warnings.join(" ")).toContain("Could not rename the adopted agent to review");
  expect(instructions(r)).toContain("Address this worker by its pane, w1:p2");
  const order = f.calls.map((a) => a[1]);
  expect(order.filter((c) => c === "prompt")).toHaveLength(1);
  expect(order.indexOf("rename")).toBeGreaterThan(order.indexOf("prompt"));
});

// Waiting on an agent launch did not start (unknown, or working, to idle) could hand a busy worker a second
// task, since one wait can see it work and finish. An adopted agent is decided from one reading.
test("an adopted agent that herdr does not read idle is refused from one reading, never waited on", async () => {
  for (const [gets, explains, state] of [[["unknown", "idle"], [explained("idle")], "unknown"], [["working", "idle"], [explained("idle")], "working"],
    [["blocked", "idle"], [explained("working", "osc_title_working")], "working"], [["blocked", "idle"], [explained("unknown")], "unknown"]]) {
    const f = codexPane(gets, explains);
    const r = await launch(adoptArgs, f.deps);
    expect([gets[0], state, r.state]).toEqual([gets[0], state, "needs_input"]);
    expect(r.needs_input.why).toContain(`is ${state === "unknown" ? "in a state routr does not know" : state}, not waiting for a task`);
    expect(instructions(r)).toContain("herdr agent wait w1:p2 --until idle");
    expect(f.calls.some((a) => ["wait", "prompt", "send-keys", "rename"].includes(a[1]))).toBe(false);
  }
  // The screen is extra: a read that fails or runs out of time leaves it out, and the refusal stands.
  const slow = codexPane(["working"], [explained("idle")], { reads: herdrError("timeout") });
  const s = await launch(adoptArgs, slow.deps);
  expect(s).toMatchObject({ state: "needs_input", screen: null });
  expect(s.needs_input.why).toContain("is working, not waiting for a task");
});

// An agent launch started itself has no task yet, so its start is waited through: a stale block (get blocked,
// explain idle) is not a question, and if the two readings still disagree when the time runs out, wherever it
// runs out (inside a call, with each command taking time), the block is reported, not a timeout.
test("for an agent launch started, a stale block is waited through, and a disagreement at the deadline is needs_input", async () => {
  const codex = ["--kind", "codex", "--name", "review", "--model", "gpt-6.1-sol", "--task", "Task"];
  for (const gets of [["blocked", "idle"], ["working", "working", "idle"]]) {
    const f = codexPane(gets, [explained("idle", "osc_title_idle")]);
    const r = await launch(codex, f.deps);
    expect(r).toMatchObject({ state: "prompted" });
    expect(r.steps.map((s) => s.step)).toEqual(["split", "shell_ready", "start", "ready", "prompt"]);
  }
  // Long enough for the start (about ten commands) to finish at the highest cost; the loop's end then falls anywhere.
  for (const cost of [0, 100, 170, 333]) for (const timeout of [6000, 6200, 6333, 7111]) {
    const f = codexPane(["blocked"], [explained("idle", "osc_title_idle")], { cost });
    const r = await launch([...codex, "--timeout", String(timeout)], f.deps);
    expect([cost, timeout, r.state]).toEqual([cost, timeout, "needs_input"]);
    expect(r.needs_input.herdr).toEqual({ state: "blocked", explained: "idle", rules: "2026.10.01.1" });
    expect(r.needs_input.why).toContain("its rules read the screen as idle by osc_title_idle");
    expect(f.calls.some((a) => a[1] === "prompt")).toBe(false);
  }
  // A timeout with no disagreement as the last reading is still a timeout.
  const slow = codexPane(["blocked", "unknown"], [explained("idle", "osc_title_idle")], { cost: 100 });
  const late = await launch([...codex, "--timeout", "6200"], slow.deps);
  expect(late).toMatchObject({ state: "failed" });
  expect(slow.calls.some((a) => a[1] === "explain")).toBe(true); // it did see the disagreement, then herdr moved on
  expect(late.steps.at(-1).detail).toContain("Launch readiness timeout");
});

// The saved disagreement (get blocked, explain idle) was cleared only when an agent was read, so an agent that
// then vanished left it standing, and the deadline reported a block nobody saw any more as needs_input.
test("an agent that vanishes after a stale block lets the readiness timeout fail, not report the old block", async () => {
  const codex = ["--kind", "codex", "--name", "review", "--model", "gpt-6.1-sol", "--task", "Task", "--timeout", "6000"];
  let gets = 0;
  const f = fakeHerdr({ kind: "codex", reply: async (a) => {
    if (a[1] === "get" && a[2] === "w1:p2") return ++gets === 1 ? herdrOK({ agent: { agent: "codex", agent_status: "blocked", cwd: process.cwd() } }) : herdrError("agent_not_found");
    if (a[1] === "explain") return explained("idle", "osc_title_idle");
  } });
  const r = await launch(codex, f.deps);
  expect(f.calls.some((a) => a[1] === "explain")).toBe(true); // the disagreement was seen
  expect(r).toMatchObject({ state: "failed" });
  expect(r.steps.at(-1).detail).toContain("Launch readiness timeout");
});

// An adopted agent was renamed after its task even when the outcome read found another agent in the pane (or
// none), so the name could go to someone else's agent. The rename now needs the identity confirmed.
test("an adopted agent is not renamed when the outcome read cannot confirm it is the agent prompted", async () => {
  for (const after of [herdrOK({ agent: { agent: "claude", agent_status: "working", cwd: process.cwd() } }), herdrOK({})]) {
    let prompted = false;
    const f = fakeHerdr({ kind: "codex", reply: async (a) => {
      if (a[1] === "prompt") { prompted = true; return herdrOK({}); }
      if (a[1] === "get" && a[2] === "w1:p2") return prompted ? after : herdrOK({ agent: { agent: "codex", agent_status: "idle", interactive_ready: true, cwd: process.cwd() } });
    } });
    const r = await launch(adoptArgs, f.deps);
    expect(r).toMatchObject({ state: "needs_input" });
    expect(r.needs_input.why).toContain("Cannot confirm the prompted agent's identity");
    expect(f.calls.filter((a) => a[1] === "prompt")).toHaveLength(1);
    expect(f.calls.some((a) => a[1] === "rename")).toBe(false);
  }
});

test("a settled shell in the wrong directory is reported rather than started", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "process-info" ? shellInfo([{ pid: 1, cwd: "/" }]) : undefined });
  const r = await launch(launchArgs, f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_input" });
  expect(r.needs_input.why).toContain("wrong directory");
  expect(f.calls.some((a) => a[1] === "start")).toBe(false);
});

// Kiro CLI 2.24.1 started with --trust-tools=* goes straight to its prompt (2026-09-28): no confirmation to answer.
const kiroReady = (model) => `────────\nkiro_default · ${model ? `${model} · ` : ""}◔ 1%        /private/tmp/work\n›  ask a question or describe a task ↵`;

function fakeKiro({ model = "glm-5", shown = model } = {}) {
  const f = fakeHerdr({ kind: "kiro", reply: (a) => {
    if (a[1] === "read" && f.calls.some((c) => c[1] === "start")) return herdrOK({ text: kiroReady(shown) });
  } });
  return f;
}

test("Kiro: a model id it does not list is refused before any pane, from its own list, not its screen", async () => {
  const f = fakeKiro();
  const listed = { ...f.deps, models: async () => ["auto", "glm-5"] };
  const r = await launch(["--kind", "kiro", "--name", "worker", "--model", "not-a-model", "--task", "Task"], listed);
  expect(r).toMatchObject({ ok: false, state: "failed" });
  expect(r.steps.at(-1).detail).toContain("does not list --model not-a-model");
  expect(r.steps.at(-1).detail).toContain("kiro-cli chat --list-models");
  expect(f.calls).toHaveLength(0); // no pane, no worktree
  const ok = await launch(["--kind", "kiro", "--name", "worker", "--model", "glm-5", "--task", "Task"], { ...fakeKiro().deps, models: async () => ["auto", "glm-5"] });
  expect(ok).toMatchObject({ ok: true, state: "prompted" });
  // A list that cannot be read is said, never passed over in silence.
  const unread = await launch(["--kind", "kiro", "--name", "worker", "--model", "glm-5", "--task", "Task"], { ...fakeKiro().deps, models: async () => null });
  expect(unread.unavailable).toContainEqual(expect.objectContaining({ part: "model list", subscription: "kiro" }));
});

test("fatal start, wait, and inspection errors cannot be masked by UI or polled forever", async () => {
  for (const op of ["start", "wait", "get"]) {
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === op) return herdrError("invalid_request");
      if (op === "start" && a[1] === "read" && f.calls.some((c) => c[1] === "start")) return herdrOK({ text: claudeTrust });
    } });
    const r = await launch(launchArgs, f.deps);
    expect(r).toMatchObject({ ok: false, state: "failed" });
    expect(f.calls.filter((a) => a[1] === op)).toHaveLength(1);
    expect(f.calls.some((a) => a[1] === "prompt" || (a[1] === "send-keys" && a[3] !== "n"))).toBe(false);
    expect(r.ran.length).toBe(f.calls.length); // Includes the diagnostic read.
  }
});

test("explicitly false interactive readiness cannot authorize prompt submission", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "get" ? herdrOK({ agent: { agent: "claude", agent_status: "idle", interactive_ready: false } }) : undefined });
  const r = await launch([...launchArgs, "--timeout", "1000", "--task", "Task"], f.deps);
  expect(r.ok).toBe(false);
  expect(f.calls.some((a) => a[1] === "prompt")).toBe(false);
});

for (const readiness of [undefined, null, false]) test(`Cursor idle readiness ${readiness} is handled after pane run`, async () => {
  const root = scratch("cursor-readiness");
  const source = join(root, "source.json");
  writeFileSync(source, '{"model":"original"}');
  try {
    let started = false;
    const f = fakeHerdr({ kind: "cursor", reply: (a) => {
      if (a[1] === "run") started = true;
      if (started && a[1] === "read") return herdrOK({ text: "Welcome to Cursor\n❯" });
      if (a[1] === "get") return herdrOK({ agent: { agent: "cursor", agent_status: "idle",
        ...(readiness === undefined ? {} : { interactive_ready: readiness }) } });
    } });
    const r = await launch(["--kind", "cursor", "--name", "worker", "--model", "composer-2.5", "--timeout", "4000", "--task", "Task"],
      { ...f.deps, cursorConfigSource: source, tempRoot: root });
    const ready = readiness !== false;
    expect(started).toBe(true);
    expect(r).toMatchObject({ ok: ready, state: ready ? "prompted" : "failed" });
    expect(f.calls.filter((a) => a[1] === "prompt")).toHaveLength(ready ? 1 : 0);
    expect(f.calls.some((a) => a[1] === "rename")).toBe(ready);
    if (!ready) expect(r.steps.find((s) => s.step === "failed").detail).toContain("timeout");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prompt results distinguish blocked, unknown, wrong-agent, refusal, and observed work", async () => {
  for (const { status, response, kind = "claude", expected } of [
    { status: "blocked", response: herdrOK(), expected: "needs_input" },
    { status: "blocked", response: herdrError("agent_blocked"), expected: "needs_input" },
    { status: "unknown", response: herdrOK(), expected: "needs_input" },
    { status: "working", response: herdrError("agent_prompt_stalled"), expected: "prompted" }, // it started after all
    { status: "working", response: herdrError("timeout"), expected: "prompted" },
    { status: "idle", response: herdrError("timeout"), expected: "needs_input" },
    { status: "done", response: herdrOK(), expected: "prompted" },
    { status: "working", response: herdrOK(), kind: "codex", expected: "needs_input" },
  ]) {
    let submitted = false;
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === "prompt") { submitted = true; return response; }
      // As herdr: a wait for working or blocked answers OK only once the agent reaches one of them.
      if (a[1] === "wait" && submitted) return ["working", "blocked"].includes(status) ? herdrOK({}) : herdrError("timeout");
      if (a[1] === "get" && submitted) return herdrOK({ agent: { agent: kind, agent_status: status } });
    } });
    const r = await launch([...launchArgs, "--task", "Task"], f.deps);
    expect(r.state).toBe(expected);
    expect(r.ok).toBe(expected === "prompted");
    expect(f.calls.filter((a) => a[1] === "prompt")).toHaveLength(1);
    if (expected !== "prompted") expect(instructions(r)).toContain("before retrying");
    if (response.data.error?.code === "agent_blocked") expect(r.steps.find((s) => s.step === "prompt").ok).toBe(false);
  }
});

test("prompt waits request activity and reserve deadline budget for the status read", async () => {
  let submitted = false;
  const f = fakeHerdr({ reply: async (a, ms) => {
    if (a[1] === "prompt") {
      submitted = true;
      expect(a.slice(4, -2)).toEqual(["--wait", "--until", "working", "--until", "idle", "--until", "done", "--until", "blocked"]);
      expect(ms).toBeLessThanOrEqual(4000 - f.deps.now());
      expect(Number(a.at(-1))).toBeLessThan(ms);
      await f.deps.sleep(ms);
      return herdrError("timeout");
    }
    if (a[1] === "get" && submitted) return herdrOK({ agent: { agent: "claude", agent_status: "working" } });
    expect(ms).toBeGreaterThan(0);
  } });
  const r = await launch([...launchArgs, "--timeout", "4000", "--task", "Task"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted" });
  expect(f.deps.now()).toBeLessThan(4000);
});

test("transport failures after prompt submission return JSON and warn against retrying", async () => {
  for (const failed of ["prompt", "get"]) {
    let submitted = false;
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === "prompt") submitted = true;
      if (submitted && a[1] === failed) throw new Error("connection lost");
    } });
    const r = await launch([...launchArgs, "--task", "Task"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "failed" });
    expect(r.warnings.join(" ")).toContain("Prompt may have been submitted");
    expect(f.calls.filter((a) => a[1] === "prompt")).toHaveLength(1);
  }
});

test("deadline boundaries and large safe timeouts never pass zero or negative durations", async () => {
  for (const timeout of ["1", "9007199254740991"]) {
    const f = fakeHerdr({ reply: (_a, ms) => { expect(Number.isSafeInteger(ms) && ms > 0).toBe(true); } });
    const clock = f.deps.now;
    f.deps.now = () => Number.MAX_SAFE_INTEGER - 100 + clock();
    const r = await launch([...launchArgs, "--timeout", timeout], f.deps);
    expect(r.state).toBe(timeout === "1" ? "failed" : "ready");
  }
});

test("failure before start closes only newly created panes and reports cleanup failure", async () => {
  for (const adopted of [false, true]) for (const closeOK of [false, true]) {
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === "process-info") throw new Error("inspection failed");
      if (a[1] === "close") return closeOK ? herdrOK() : herdrError("close_failed");
    } });
    const r = await launch([...launchArgs, ...(adopted ? ["--pane", "w1:p9"] : [])], f.deps);
    expect(r.ok).toBe(false);
    expect(f.calls.filter((a) => a[1] === "close")).toHaveLength(adopted ? 0 : 1);
    if (!adopted) {
      expect(r.steps.find((s) => s.step === "cleanup_pane").ok).toBe(closeOK);
      expect(r.warnings.join(" ").includes("left alive")).toBe(!closeOK);
    }
  }
});

// The next two tests stand in for cursor-agent and herdr with /bin/sh stubs, so they run on macOS and Linux only.
// `routr launch` has not been run against herdr on Windows at all (docs/evidence.md).
const unixOnly = test.skipIf(process.platform === "win32");

unixOnly("Cursor removes configs on pre-start failure and on worker exit without changing the source", async () => {
  const root = scratch("cursor-launch");
  const source = join(root, "source.json");
  writeFileSync(source, '{"model":"original"}');
  const args = ["--kind", "cursor", "--name", "worker", "--model", "composer-2.5"];
  try {
    for (const missing of [true, false]) {
      const f = fakeHerdr({ reply: (a) => a[1] === "split" ? herdrError("split_failed") : undefined });
      const r = await launch(args, { ...f.deps, cursorConfigSource: missing ? join(root, "missing") : source, tempRoot: root });
      expect(r.ok).toBe(false);
      expect(existsSync(r.start.env.CURSOR_CONFIG_DIR)).toBe(false);
      expect(readdirSync(root)).toEqual(["source.json"]);
      if (missing) expect(f.calls).toHaveLength(0);
    }
    const bin = join(root, "bin"); mkdirSync(bin);
    // This executable is a shell stub, never an agent. It proves the actual wrapper's exit cleanup.
    const stub = join(bin, "cursor-agent");
    writeFileSync(stub, '#!/bin/sh\nprintf modified > "$CURSOR_CONFIG_DIR/cli-config.json"\nexit 7\n'); chmodSync(stub, 0o755);
    let started = false, privateDir;
    const f = fakeHerdr({ kind: "cursor", reply: (a) => {
      if (a[1] === "run") {
        started = true;
        privateDir = join(root, readdirSync(root).find((name) => name.startsWith("routr-cursor-")));
        expect(statSync(privateDir).mode & 0o777).toBe(0o700);
        expect(statSync(join(privateDir, "cli-config.json")).mode & 0o777).toBe(0o600);
        const result = Bun.spawnSync(["sh", "-c", a[3]], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
        expect(result.exitCode).toBe(7);
        return herdrOK();
      }
      if (started && a[1] === "read") return herdrOK({ text: "❯" });
    } });
    const r = await launch(args, { ...f.deps, cursorConfigSource: source, tempRoot: root });
    expect(r.state).toBe("ready");
    expect(existsSync(privateDir)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe('{"model":"original"}');
    expect(f.calls.some((a) => a[1] === "rename")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dry-run plans include geometry and shell checks, and skip geometry for explicit direction", async () => {
  const r = await launch([...launchArgs, "--dry-run"]);
  expect(r.would_run.some((s) => s.includes("pane current --current"))).toBe(true);
  expect(r.would_run.some((s) => s.includes("pane process-info --pane"))).toBe(true);
  const explicit = await launch([...launchArgs, "--direction", "down", "--dry-run"]);
  expect(explicit.would_run.some((s) => /pane (current|layout)/.test(s))).toBe(false);
});

unixOnly("transport timeouts return a timeout code, even if the subprocess printed JSON", async () => {
  const root = scratch("herdr-stub");
  try {
    const executable = join(root, "herdr");
    writeFileSync(executable, '#!/bin/sh\nprintf \'{"result":{}}\'\nexec sleep 30\n'); chmodSync(executable, 0o755);
    const modulePath = new URL("../src/lib/herdr.mjs", import.meta.url).href;
    const result = Bun.spawnSync(["bun", "-e", `import { runHerdr } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await runHerdr([], 50)));`],
      { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, data: { error: { code: "timeout" } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// RunHerdr answered only on `close`, so a client that held its pipes after the kill (on Windows herdr behind
// cmd.exe, where the kill reaches cmd.exe alone) kept the call pending past its timeout. The timeout now
// answers by itself; only the child is killed (never its tree: it may have started the user's herdr server).
test("a herdr call answers at its timeout even when the killed client never closes its pipes", async () => {
  const child = new EventEmitter(), pipe = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  Object.assign(child, { stdout: pipe(), stderr: pipe(), signals: [], unrefd: false, kill(sig) { child.signals.push(sig); }, unref() { child.unrefd = true; } });
  const seen = [];
  const call = runHerdr(["agent", "get", "w1:p2"], 50, { via: (...a) => { seen.push(a); child.stdout.emit("data", '{"result":{}}'); return child; } });
  const r = await Promise.race([call, Bun.sleep(1000).then(() => "still pending")]);
  expect(r).toMatchObject({ ok: false, code: "herdr_unreachable", data: { error: { code: "timeout" } } });
  expect(seen.map(([cmd]) => cmd)).toEqual(["herdr"]);
  expect([child.signals, child.stdout.destroyed, child.stderr.destroyed, child.unrefd]).toEqual([["SIGKILL"], true, true, true]);
  child.emit("close", 0); // a late close changes nothing
  expect(await call).toMatchObject({ ok: false, data: { error: { code: "timeout" } } });
});

// herdr 0.9.5 types into a pane and answers nothing (exit 0, empty stdout): through the transport as the CLI gives it.
test("through the transport, typing into a pane succeeds on exit 0 with no output; a failed exit, older JSON and other commands are as before", async () => {
  const child = (out, err, code) => (...a) => {
    const c = new EventEmitter(), pipe = () => Object.assign(new EventEmitter(), { destroy() {} });
    Object.assign(c, { stdout: pipe(), stderr: pipe(), kill() {}, unref() {} });
    setTimeout(() => { if (out) c.stdout.emit("data", out); if (err) c.stderr.emit("data", err); c.emit("close", code); }, 5);
    return c;
  };
  const call = (args, out, err, code) => runHerdr(args, 1000, { via: child(out, err, code) });
  for (const a of [["pane", "run", "w1:p1", "echo hi"], ["pane", "send-text", "w1:p1", "x"], ["pane", "send-keys", "w1:p1", "enter"], ["--session", "s", "pane", "run", "w1:p1", "x"]]) {
    expect([a.join(" "), await call(a, "", "", 0)]).toEqual([a.join(" "), { ok: true, data: { result: {} } }]);
    expect([a.join(" "), await call(a, '{"id":"cli:pane:run","result":{}}', "", 0)]).toEqual([a.join(" "), { ok: true, data: { result: {} } }]);
    expect([a.join(" "), (await call(a, "", "error: no such pane", 1)).ok]).toEqual([a.join(" "), false]);
  }
  expect((await call(["pane", "split", "w1:p1"], "", "", 0)).code).toBe("herdr_unreachable");
});

test("launch --copy is repeatable, needs --worktree, and refuses paths outside the repository", async () => {
  const { parseLaunchArgs } = await import("./contract.mjs");
  const base = ["--kind", "codex", "--name", "w", "--model", "m"];
  expect(parseLaunchArgs([...base, "--worktree", "b", "--copy", ".env.test", "--copy", "fixtures"]).copy).toEqual([".env.test", "fixtures"]);
  expect(() => parseLaunchArgs([...base, "--copy", "x"])).toThrow("--worktree");
  expect(() => parseLaunchArgs([...base, "--worktree", "b", "--copy", "../secrets"])).toThrow("inside the repository");
  expect(() => parseLaunchArgs([...base, "--worktree", "b", "--copy", "/etc/passwd"])).toThrow("inside the repository");
});

test("launch --base starts the worktree's branch at that commit, and every launch says how to clean it up", async () => {
  const base = ["--kind", "codex", "--name", "w", "--model", "m"];
  expect(parseLaunchArgs([...base, "--worktree", "review-x", "--base", "main~2"]).base).toBe("main~2");
  expect(() => parseLaunchArgs([...base, "--base", "main"])).toThrow("goes with --worktree");
  for (const bad of ["--upload-pack=x", "-x", "a..b", "a b", "main:x", "HEAD^@", "HEAD^-1", "HEAD^!"]) expect(() => parseLaunchArgs([...base, "--worktree", "b", "--base", bad])).toThrow();
  const plan = await launch([...base, "--cwd", process.cwd(), "--worktree", "stacked", "--base", "feat/one", "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); } });
  expect(plan.would_run[0]).toBe(displayCommand(["herdr", "worktree", "create", "--cwd", process.cwd(), "--branch", "stacked", "--base", "feat/one", "--no-focus"]));
  // A worktree launch: herdr gets --base as given, and the result names the one command that finishes the worker.
  const f = fakeHerdr({ reply: (a) => a[0] === "worktree" ? herdrOK({ root_pane: { pane_id: "w5:p1" }, worktree: { path: process.cwd() }, workspace: { workspace_id: "w5" } }) : undefined });
  const r = await launch([...launchArgs, "--cwd", "/", "--worktree", "stacked", "--base", "feat/one"], f.deps);
  expect(f.calls[0]).toEqual(["worktree", "create", "--cwd", resolve("/"), "--branch", "stacked", "--base", "feat/one", "--no-focus"]);
  expect(cleanupStep(r)?.argv).toEqual(["routr", "cleanup", "--cwd", resolve("/"), "--worktree", "stacked"]);
  expect(r).toMatchObject({ ok: true, pane: "w1:p2", worktree: { branch: "stacked", base: "feat/one", path: process.cwd(), workspace: "w5" } });
  // A split pane is closed by cleanup; a relaunch into a pane gets the pane's line (cleanup redirects a worktree's own).
  expect(cleanupStep(await launch(launchArgs, fakeHerdr().deps))?.command).toBe("routr cleanup --pane w1:p2");
  const kept = await launch([...launchArgs, "--task", "Task"], fakeHerdr({ reply: (a) => a[1] === "start" ? herdrError("boom") : undefined }).deps);
  expect(kept).toMatchObject({ state: "failed" });
  expect(kept.next.some((n) => n.template?.startsWith("routr record "))).toBe(true);
  expect(cleanupStep(kept)?.command).toBe("routr cleanup --pane w1:p2"); // a start was tried: the pane stays
  const closed = await launch(launchArgs, fakeHerdr({ reply: (a) => a[1] === "process-info" ? herdrError("boom") : undefined }).deps);
  expect(closed.steps.map((s) => s.step)).toContain("cleanup_pane"); expect(cleanupStep(closed)).toBeUndefined(); // closed by launch
});

test("Windows shell prompts count as ready; a bare continuation prompt still does not", () => {
  for (const text of ["PS C:\\Users\\chris>", "PS C:\\Users\\chris\\AppData\\Local\\Temp\\routr-wintest> ", "C:\\Users\\chris>", "Windows PowerShell\nCopyright (C) Microsoft\n\nPS D:\\work\\my repo>"])
    expect(shellPrompt(text)).toBe("ready");
  expect(shellPrompt("> ")).toBe("question");
  expect(shellPrompt(">> ")).not.toBe("ready");
  expect(shellPrompt("Do you want to continue? C:\\temp>no")).not.toBe("ready");
});

test("launch never puts the brief in its result: not in the command log, not in a dry run", async () => {
  const { launch } = await import("./contract.mjs");
  const secret = "REFACTOR-THE-PAYMENTS-LEDGER-7731";
  const r = await launch(["--kind", "codex", "--name", "w", "--cwd", process.cwd(), "--worktree", "b", "--model", "m", "--task", `Do this: ${secret}`, "--dry-run"]);
  expect(r.prompt_chars).toBeGreaterThan(secret.length);
  expect(JSON.stringify(r)).not.toContain(secret);
  expect(r.would_run.join("\n")).toContain("<prompt: ");
});

test("launch types each shell's own syntax: Cursor's private config is set and removed in PowerShell and cmd too", async () => {
  const { SHELLS, shellFamily } = await import("../src/lib/herdr.mjs");
  expect(["zsh", "bash", "fish", undefined].map(shellFamily)).toEqual(["posix", "posix", "posix", "posix"]);
  expect(["powershell.exe", "pwsh", "cmd.exe", "CMD"].map(shellFamily)).toEqual(["powershell", "powershell", "cmd", "cmd"]);
  const dir = "C:\\Users\\u\\AppData\\Local\\Temp\\routr-cursor-1";
  // Windows shells only set the variable; herdr then starts Cursor itself, because it cannot see a Cursor a shell started.
  expect(SHELLS.powershell.cursor).toBeUndefined();
  // The line without the hidden startup ($si) was run on Windows 11: the watcher appeared, and the folder was gone once
  // the shell exited. The startup with ShowWindow = 0 is the documented way to hide its console; not yet confirmed there.
  expect(SHELLS.powershell.cursorEnv(dir)).toBe(`$env:CURSOR_CONFIG_DIR='${dir}'; $w = 'powershell -NoProfile -WindowStyle Hidden -Command "Wait-Process -Id ' + $PID + '; Remove-Item -LiteralPath ''${dir}'' -Recurse -Force -ErrorAction SilentlyContinue"'; $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); $si.ShowWindow = 0; ([wmiclass]'Win32_Process').Create($w, $null, $si) | Out-Null`);
  expect(SHELLS.cmd.cursorEnv(dir)).toBe(`set "CURSOR_CONFIG_DIR=${dir}"`);
  expect(SHELLS.cmd.cd("C:\\a b")).toBe('cd /d "C:\\a b"');
  expect(SHELLS.posix.cursor("/tmp/x", "cursor-agent", ["--trust"])).toMatch(/^env CURSOR_CONFIG_DIR=\/tmp\/x sh -c 'trap .*cursor-agent --trust'$/);
  expect(SHELLS.posix.cd("/a b")).toBe("cd -- '/a b'");
});

// PowerShell's tokenizer opens and closes a single-quoted string at any of five characters, the ASCII ' and U+2018 to
// U+201B, and reads two of them in a row as the second one. A model of that, to read each typed line back to its path.
const PS_QUOTES = "'\u2018\u2019\u201A\u201B";
const psString = (line, at) => {
  expect(PS_QUOTES).toContain(line[at]);
  let value = "";
  for (let i = at + 1; i < line.length; i++) {
    if (!PS_QUOTES.includes(line[i])) { value += line[i]; continue; }
    if (i + 1 === line.length || !PS_QUOTES.includes(line[i + 1])) return { value, end: i + 1 };
    value += line[++i];
  }
  throw new Error(`Unterminated string in ${line}`);
};
// What each line hands PowerShell: the folder of `cd`, the variable `cursorEnv` sets, and the folder its watcher removes,
// read from the -Command text the watcher process gets once $w is built (with some pid for $PID).
const psPaths = (cd, env) => {
  const set = "Set-Location -LiteralPath ";
  expect(cd.startsWith(set)).toBe(true);
  const at = psString(cd, set.length);
  expect(at.end).toBe(cd.length);
  const head = "$env:CURSOR_CONFIG_DIR=";
  expect(env.startsWith(head)).toBe(true);
  const variable = psString(env, head.length);
  const w = "; $w = ";
  expect(env.slice(variable.end, variable.end + w.length)).toBe(w);
  const left = psString(env, variable.end + w.length);
  const pid = " + $PID + ";
  expect(env.slice(left.end, left.end + pid.length)).toBe(pid);
  const right = psString(env, left.end + pid.length);
  expect(env.slice(right.end)).toStartWith("; $si = ");
  const inner = (`${left.value}1${right.value}`).match(/ -Command "(.*)"$/)?.[1];
  const remove = "Remove-Item -LiteralPath ";
  const from = inner.indexOf(remove) + remove.length;
  const watched = psString(inner, from);
  expect(inner.slice(watched.end)).toBe(" -Recurse -Force -ErrorAction SilentlyContinue");
  return { cd: at.value, env: variable.value, watcher: watched.value };
};
const QUOTED_PATHS = ["C:\\it's here", ...[..."\u2018\u2019\u201A\u201B"].map((q) => `C:\\Users\\Chris${q}s`),
  "C:\\it's Chris\u2019s", "C:\\''\u2018\u2019 end'", "C:\\plain"];

test("a folder path typed into PowerShell reaches it exactly: ' and the four smart quotes are doubled, again inside the watcher", async () => {
  const { SHELLS } = await import("../src/lib/herdr.mjs");
  const ps = SHELLS.powershell;
  expect(ps.cd("C:\\it's here")).toBe("Set-Location -LiteralPath 'C:\\it''s here'");
  for (const q of "\u2018\u2019\u201A\u201B") expect(ps.cd(`C:\\Chris${q}s`)).toBe(`Set-Location -LiteralPath 'C:\\Chris${q}${q}s'`);
  expect(ps.cd("C:\\it's Chris\u2019s")).toBe("Set-Location -LiteralPath 'C:\\it''s Chris\u2019\u2019s'");
  // The watcher's path sits in a string inside a string: quoted for the inner one, then each quote doubled for the outer.
  const dir = "C:\\Temp\\it's Chris\u2019s";
  expect(ps.cursorEnv(dir)).toBe(`$env:CURSOR_CONFIG_DIR='C:\\Temp\\it''s Chris\u2019\u2019s'; $w = 'powershell -NoProfile -WindowStyle Hidden -Command "Wait-Process -Id ' + $PID + '; Remove-Item -LiteralPath ''C:\\Temp\\it''''s Chris\u2019\u2019\u2019\u2019s'' -Recurse -Force -ErrorAction SilentlyContinue"'; $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); $si.ShowWindow = 0; ([wmiclass]'Win32_Process').Create($w, $null, $si) | Out-Null`);
  for (const path of QUOTED_PATHS) expect(psPaths(ps.cd(path), ps.cursorEnv(path))).toEqual({ cd: path, env: path, watcher: path });
});

// PowerShell's own parser, where it is installed (the Windows CI job has pwsh): each line is parsed, never run. $w is
// rebuilt from its parsed parts, the way the line would build it, and the watcher's -Command text is parsed in turn.
const PWSH = Bun.which("pwsh");
const PARSE_TYPED = `$ErrorActionPreference = 'Stop'
function Parse($text) { $e = $null; $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$e); if ($e.Count) { throw $e[0].Message }; $ast }
function PathOf($ast, $name) {
  $c = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq $name }, $true)
  $el = $c.CommandElements
  for ($i = 0; $i -lt $el.Count; $i++) { if ($el[$i] -is [System.Management.Automation.Language.CommandParameterAst] -and $el[$i].ParameterName -eq 'LiteralPath') { return $el[$i + 1].Value } }
}
$sets = (Parse $env:ROUTR_TYPED_ENV).FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)
$variable = ($sets | Where-Object { $_.Left.Extent.Text -eq '$env:CURSOR_CONFIG_DIR' }).Right.Expression.Value
$w = ($sets | Where-Object { $_.Left.Extent.Text -eq '$w' }).Right
$parts = $w.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $n -is [System.Management.Automation.Language.VariableExpressionAst] }, $true) | Sort-Object { $_.Extent.StartOffset }
$line = -join ($parts | ForEach-Object { if ($_ -is [System.Management.Automation.Language.VariableExpressionAst]) { '1' } else { $_.Value } })
if ($line -notmatch ' -Command "(.*)"$') { throw 'no -Command' }
[pscustomobject]@{ cd = (PathOf (Parse $env:ROUTR_TYPED_CD) 'Set-Location'); env = $variable; watcher = (PathOf (Parse $Matches[1]) 'Remove-Item') } | ConvertTo-Json -Compress -EscapeHandling EscapeNonAscii`;

test.skipIf(!PWSH)("PowerShell itself parses each typed line back to the exact folder path, the watcher's too", async () => {
  const { SHELLS } = await import("../src/lib/herdr.mjs");
  for (const path of QUOTED_PATHS) {
    const r = Bun.spawnSync([PWSH, "-NoProfile", "-NonInteractive", "-Command", PARSE_TYPED],
      { env: { ...process.env, ROUTR_TYPED_CD: SHELLS.powershell.cd(path), ROUTR_TYPED_ENV: SHELLS.powershell.cursorEnv(path) } });
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual({ cd: path, env: path, watcher: path });
  }
}, 60000);

test("a folder path with % or ! is never typed into cmd: it would expand even inside quotes", async () => {
  const { CMD_PATH, SHELLS } = await import("../src/lib/herdr.mjs");
  expect(CMD_PATH).toBe("A cmd shell expands % and ! in a folder path even inside quotes, so routr will not type this one into it. Use a folder whose path has neither, or a pane running PowerShell.");
  for (const path of ["C:\\100%", "C:\\%PATH%", "C:\\hi!", "C:\\!x!"]) {
    expect(() => SHELLS.cmd.cd(path)).toThrow(CMD_PATH);
    expect(() => SHELLS.cmd.cursorEnv(path)).toThrow(CMD_PATH);
  }
  expect(SHELLS.cmd.cd("C:\\it's ^&")).toBe('cd /d "C:\\it\'s ^&"');
});

test("launch refuses a cmd pane before typing anything when a folder it would type there holds % or !", async () => {
  const { CMD_PATH } = await import("../src/lib/herdr.mjs");
  const cmdShell = (cwd) => (a) => a[1] === "process-info" ? herdrOK({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: "cmd.exe", cwd }] } }) : undefined;
  // --pane: the shell is elsewhere, so launch would `cd` to the work folder.
  const work = scratch("cmd-100%");
  const f = fakeHerdr({ reply: cmdShell(process.cwd()) });
  const r = await launch([...launchArgs, "--pane", "w1:p1", "--cwd", work, "--task", "Task"], f.deps);
  expect(r).toMatchObject({ ok: false, state: "failed", error: CMD_PATH });
  expect(f.calls.some((a) => ["run", "send-text", "send-keys", "start", "prompt"].includes(a[1]))).toBe(false);
  // Cursor: its private folder would be typed into the variable, and the temporary folder holds a !.
  const root = scratch("cmd-bang!"), source = join(root, "source.json");
  writeFileSync(source, '{"model":"original"}');
  const c = fakeHerdr({ kind: "cursor", reply: cmdShell(process.cwd()) });
  const rc = await launch(["--kind", "cursor", "--name", "worker", "--model", "composer-2.5", "--task", "Task"], { ...c.deps, cursorConfigSource: source, tempRoot: root });
  expect(rc).toMatchObject({ ok: false, state: "failed", error: CMD_PATH });
  expect(c.calls.some((a) => ["run", "send-text", "send-keys", "start", "prompt"].includes(a[1]))).toBe(false);
  expect(c.calls.some((a) => a[1] === "close")).toBe(true); // the unused pane goes
  expect(readdirSync(root)).toEqual(["source.json"]);
  // Cursor into the caller's pane, its shell elsewhere: the work folder is safe and the private folder is not. The refusal
  // comes before the `cd`, not between it and the variable, and the caller's pane stays.
  for (const name of ["cmd-pct%", "cmd-bang!"]) {
    const temp = scratch(name), config = join(temp, "source.json");
    writeFileSync(config, '{"model":"original"}');
    const p = fakeHerdr({ kind: "cursor", reply: cmdShell(SCRATCH) });
    const rp = await launch(["--kind", "cursor", "--name", "worker", "--model", "composer-2.5", "--pane", "w1:p1", "--cwd", process.cwd(), "--task", "Task"],
      { ...p.deps, cursorConfigSource: config, tempRoot: temp });
    expect(rp).toMatchObject({ ok: false, state: "failed", error: CMD_PATH, pane: "w1:p1" });
    expect(p.calls.some((a) => ["run", "send-text", "send-keys", "start", "prompt", "close"].includes(a[1]))).toBe(false);
    expect(readdirSync(temp)).toEqual(["source.json"]); // the unused private config is removed
  }
});

test("waitForShell: ready at a settled prompt; stops at any question, a busy adopted pane, or the wrong folder", async () => {
  const { waitForShell } = await import("../src/lib/herdr.mjs");
  const here = process.cwd();
  const pane = (screens, { busy = false } = {}) => {
    const pressed = [];
    return { pressed, read: async () => screens.length > 1 ? screens.shift() : screens[0], keys: async (...k) => { pressed.push(k); },
      info: async () => ({ shell_pid: 1, foreground_processes: busy ? [{ pid: 1, name: "zsh", cwd: here }, { pid: 2 }] : [{ pid: 1, name: "zsh", cwd: here }] }) };
  };
  let t = 0;
  const time = { sleep: async (ms) => { t += ms; }, now: () => t, remaining: () => 60000 };
  expect(await waitForShell(pane(["chris % "]), time)).toEqual({ ok: true, name: "zsh", cwd: here }); // settles on the second read
  // Any question, a plugin's or anything else: returned with the screen, never answered.
  for (const q of ["found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)", "Overwrite? [y/N]"]) {
    const p = pane([q]);
    expect(await waitForShell(p, time)).toMatchObject({ ok: false, why: "The shell asked a question before its prompt", text: q });
    expect(p.pressed).toEqual([]);
  }
  expect(await waitForShell(pane(["chris % "], { busy: true }), { ...time, refuseBusy: true })).toMatchObject({ ok: false, why: expect.stringContaining("foreground process") });
  expect(await waitForShell(pane(["chris % "]), { ...time, cwd: SCRATCH })).toMatchObject({ ok: false, why: "Shell is at a prompt in the wrong directory" });
});

test("launch refuses a harness that is not signed in, before any herdr call", async () => {
  const f = fakeHerdr({ kind: "kiro" });
  const r = await launch(["--kind", "kiro", "--name", "worker", "--model", "auto", "--task", "Task"], { ...f.deps, ready: async () => "not signed in: kiro-cli login" });
  expect(r).toMatchObject({ ok: false, state: "failed" });
  expect(r.steps.at(-1).detail).toBe("Kiro cannot take work: not signed in: kiro-cli login");
  expect(f.calls).toEqual([]);
  expect(r.next.some((n) => n.template?.startsWith("routr record "))).toBe(false);
});

test("launch refuses a subscription the user turned off, before any herdr call", async () => {
  const f = fakeHerdr({ kind: "codex" });
  const r = await launch(["--kind", "codex", "--name", "worker", "--model", "m", "--task", "Task"], { ...f.deps, settings: () => ({ subscriptions: { codex: { enabled: false } } }) });
  expect(r.steps.at(-1).detail).toBe("Codex is turned off in your settings: turn it on with routr setup --enable codex");
  expect(f.calls).toEqual([]);
  expect(r.next.some((n) => n.template?.startsWith("routr record "))).toBe(false);
});

test("a pane whose folder is gone is a person's call, not a crash; no process information is waited out", async () => {
  const { waitForShell } = await import("../src/lib/herdr.mjs");
  let t = 0, infos = 0;
  const time = { sleep: async (ms) => { t += ms; }, now: () => t, remaining: () => 60000 };
  const pane = { read: async () => "chris % ", keys: async () => {}, info: async () => (++infos < 3 ? undefined : { shell_pid: 1, foreground_processes: [{ pid: 1, name: "zsh", cwd: "/no/such/folder-routr" }] }) };
  expect(await waitForShell(pane, { ...time, cwd: SCRATCH })).toMatchObject({ ok: false, why: expect.stringContaining("folder is gone") });
  expect(infos).toBeGreaterThan(2); // the empty answers were waited out, not a TypeError
  const noCwd = { read: async () => "chris % ", keys: async () => {}, info: async () => ({ shell_pid: 1, foreground_processes: [{ pid: 1, name: "zsh" }] }) };
  expect(await waitForShell(noCwd, { ...time, cwd: SCRATCH })).toMatchObject({ ok: false, why: "The pane's shell did not say which folder it is in" });
});
// The task is sent once, and herdr's lifecycle state says whether the worker took it: never a second send, never a key
// pressed on what the screen seems to show. 2026-09-28: Codex held a task behind "Waiting for startup" and herdr said the
// prompt stalled; the old screen-reading path sent it again into the same box. Codex then started it on its own.
test("a prompt herdr says stalled is never sent again: launch waits on the agent's state, and a person decides the rest", async () => {
  const drive = async (after, kind = "codex") => {
    let prompts = 0, keys = 0, waited = null;
    const f = fakeHerdr({ kind, reply: (a) => {
      if (a[1] === "prompt") { prompts++; return herdrError("agent_prompt_stalled"); }
      if (a[1] === "send-keys" && prompts) { keys++; return herdrOK({}); }
      if (a[1] === "wait" && prompts) { waited = a; return after === "never" ? herdrError("timeout") : herdrOK({ agent: { agent_status: after } }); }
      if (a[1] === "get" && prompts) return herdrOK({ agent: { agent: kind, agent_status: after === "never" ? "idle" : after, interactive_ready: true } });
    } });
    const r = await launch(["--kind", kind, "--name", "worker", "--model", kind === "codex" ? "gpt-6-sol" : "sonnet", "--task", "Task"], f.deps);
    return { r, prompts, keys, waited };
  };
  const late = await drive("working"); // queued behind its startup, then started on its own
  expect(late).toMatchObject({ prompts: 1, keys: 0, r: { ok: true, state: "prompted" } });
  expect(late.r.steps.some((st) => st.step === "prompt_wait")).toBe(true);
  expect(late.waited.slice(3, 7)).toEqual(["--until", "working", "--until", "blocked"]);
  const never = await drive("never"); // sent once, never started: a person looks, launch sends nothing more
  expect(never).toMatchObject({ prompts: 1, keys: 0, r: { ok: false, state: "needs_input" } });
  expect(never.r.needs_input.why).toContain("never sends it twice");
  expect(never.r.screen).not.toContain("Task"); // the brief is never printed
  const asks = await drive("blocked", "claude"); // it took the task and now asks something
  expect(asks).toMatchObject({ prompts: 1, keys: 0, r: { state: "needs_input" } });
});

test("a worker seen starting counts even if it is done by the status read; the wait leaves time for the reads after it; the brief stays off the output", async () => {
  // Seen working by the wait, finished by the time launch reads its state: it took the task.
  let prompts = 0;
  const quick = fakeHerdr({ kind: "codex", reply: (a) => {
    if (a[1] === "prompt") { prompts++; return herdrError("agent_prompt_stalled"); }
    if (a[1] === "wait" && prompts) return herdrOK({ agent: { agent_status: "working" } });
    if (a[1] === "get" && prompts) return herdrOK({ agent: { agent: "codex", agent_status: "done", interactive_ready: true } });
  } });
  expect(await launch(["--kind", "codex", "--name", "w", "--model", "gpt-6-sol", "--task", "Task"], quick.deps)).toMatchObject({ ok: true, state: "prompted" });
  // A wait that uses all the time it is given: launch still reads the state and the pane, and ends as needs_input.
  const brief = "Rotate the production signing key in vault/prod";
  let sent = false, given = null, left = null, paneRead = false;
  const slow = fakeHerdr({ kind: "codex", reply: async (a, ms) => {
    if (a[1] === "prompt") { sent = true; return herdrError("agent_prompt_stalled"); }
    if (a[1] === "wait" && sent) { given = ms; left = 30000 - slow.deps.now(); await slow.deps.sleep(ms); return herdrError("timeout"); }
    // The status read takes time too, after the wait used all of its own: still needs_input, never failed.
    if (a[1] === "get" && sent) { await slow.deps.sleep(Math.min(ms, 1500)); return herdrOK({ agent: { agent: "codex", agent_status: "idle", interactive_ready: true } }); }
    if (a[1] === "read" && sent) { paneRead = true; return herdrOK({ text: `› ${brief}\n  Waiting for startup` }); }
  } });
  const r = await launch(["--kind", "codex", "--name", "w", "--model", "gpt-6-sol", "--timeout", "30000", "--task", brief], slow.deps);
  expect(given).toBeLessThanOrEqual(left); // the wait never gets more than is left
  expect(r).toMatchObject({ ok: false, state: "needs_input" });
  expect(JSON.stringify(r)).not.toContain(brief); // the pane showed the brief; the output does not
  expect(paneRead).toBe(false); // and after the task is sent, launch does not read the pane at all
  // Not on the failure path either (from the second verification of #46): a status read that errors ends as failed,
  // with the pane text withheld and the pane never read.
  let posted = false, readAfter = false;
  const broken = fakeHerdr({ kind: "codex", reply: (a) => {
    if (a[1] === "prompt") { posted = true; return herdrOK({}); }
    if (a[1] === "get" && posted) return herdrError("server_error");
    if (a[1] === "read" && posted) { readAfter = true; return herdrOK({ text: brief }); }
  } });
  const b = await launch(["--kind", "codex", "--name", "w", "--model", "gpt-6-sol", "--task", brief], broken.deps);
  expect(b.state).toBe("failed");
  expect(readAfter).toBe(false);
  expect(JSON.stringify(b)).not.toContain(brief);
});

test("from 2026-10-11: a harness is ready only on two readings 1.5 s apart, and a moment of no agent is waited through", async () => {
  // One ready reading is not enough: the task goes only once the agent has stayed ready for SETTLE_MS. The fake reads
  // ready from its first wait on, so the first agent reading is ready, and the prompt must come 1.5 s after it.
  let firstGet = null, promptAt = null;
  const f = fakeHerdr({ reply: (a) => { if (a[1] === "get" && firstGet == null) firstGet = f.deps.now(); if (a[1] === "prompt") promptAt = f.deps.now(); } });
  const r = await launch([...launchArgs, "--task", "Fix the parser. Verify with bun test."], f.deps);
  expect(r.state).toBe("prompted");
  expect(promptAt - firstGet).toBeGreaterThanOrEqual(1500);
  // herdr briefly sees no agent (a wrapper handing over to the harness's own process): the launch carries on.
  let gone = 3;
  const g = fakeHerdr({ reply: (a) => (a[1] === "wait" && gone > 0 && f.calls.length >= 0 && g.calls.some((c) => c[1] === "start") ? (gone--, herdrError("agent_not_running")) : undefined) });
  expect(await launch([...launchArgs, "--task", "Task"], g.deps)).toMatchObject({ ok: true, state: "prompted" });
  // One that stays gone fails, with herdr's own words, and nothing is sent.
  const h = fakeHerdr({ reply: (a) => (a[1] === "wait" && h.calls.some((c) => c[1] === "start") ? herdrError("agent_not_running") : undefined) });
  const dead = await launch([...launchArgs, "--task", "Task"], h.deps);
  expect(dead).toMatchObject({ ok: false, state: "failed" });
  expect(dead.steps.at(-1).detail).toContain("no longer running (herdr_refused)"); // herdr's own error, passed on
  expect(h.calls.some((a) => a[1] === "prompt")).toBe(false);
  // Gone after a startup question that herdr's explain disagreed with: the exit is reported, not the old question.
  let waits = 0;
  const q = fakeHerdr({ reply: (a) => {
    if (a[1] === "wait" && q.calls.some((c) => c[1] === "start")) return ++waits === 1 ? herdrOK({}) : herdrError("agent_not_running");
    if (a[1] === "get" && waits === 1) return herdrOK({ agent: { agent: "claude", agent_status: "blocked" } });
    if (a[1] === "explain") return { ok: true, data: { agent: "claude", state: "idle" } };
  } });
  const exited = await launch([...launchArgs, "--timeout", "3000", "--task", "Task"], q.deps);
  expect(exited).toMatchObject({ ok: false, state: "failed" });
  expect(exited.needs_input).toBeFalsy();
});

test("from 2026-10-11: a task that never arrived is sent again by launch, adopting the pane, never by a bare herdr prompt", async () => {
  let submitted = false;
  const f = fakeHerdr({ reply: (a) => {
    if (a[1] === "prompt") { submitted = true; return herdrError("agent_prompt_stalled"); }
    if (a[1] === "wait" && submitted) return herdrError("timeout");
    if (a[1] === "get" && submitted) return herdrOK({ agent: { agent: "claude", agent_status: "idle" } });
  } });
  const dir = scratch("never-arrived"), task = join(dir, "task.md");
  writeFileSync(task, "Fix the parser. Verify with bun test.");
  const r = await launch([...launchArgs, "--task-file", task], f.deps);
  expect(r.state).toBe("needs_input");
  expect(instructions(r)).toContain("send it with the same launch template");
  expect(instructions(r)).toContain("--pane w1:p2");
  expect(instructions(r)).toContain(templateCommand(["--task-file", task]));
  expect(instructions(r)).toContain(templateCommand(["--cwd", process.cwd()]));
  expect(instructions(r)).not.toContain("herdr agent prompt");
});

// Trace-context carriers in a pane: every pane launch makes (a split beside the caller, or a worktree's) gets them, as
// `--env` on its split (herdr 0.9.5 measured: values reach the pane's shell byte for byte), and each one routr does not
// have as an empty `--env`, so the herdr server's own never reaches the worker; an existing pane and an adopted agent
// get none, and the launch says it passed none. A value is never shown, and never typed into a shell.
const CARRIED = { TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-CARRIER_MARK_TP-01", TRACESTATE: "k=CARRIER_MARK_TS,\tx=\"%y%\"", BAGGAGE: "a=CARRIER_MARK_BG;p=1,b=c d!&'" };
const noCarrierValue = (r) => { const text = JSON.stringify(r); for (const m of ["CARRIER_MARK_TP", "CARRIER_MARK_TS", "CARRIER_MARK_BG"]) expect([m, text.includes(m)]).toEqual([m, false]); };
const typed = (calls) => calls.filter((a) => a[0] === "pane" && ["run", "send-text", "send-keys"].includes(a[1]) || a[1] === "prompt").map((a) => a.join(" ")).join("\n");

test("split arguments name all three carriers: a forwarded value, or empty for one routr does not have; shown, only names", async () => {
  const { splitArgs } = await import("../src/lib/herdr.mjs");
  const base = ["pane", "split", "--current", "--direction", "right", "--cwd", "/w", "--no-focus"];
  expect(splitArgs("right", "/w", CARRIED)).toEqual([...base, "--env", `TRACEPARENT=${CARRIED.TRACEPARENT}`, "--env", `TRACESTATE=${CARRIED.TRACESTATE}`, "--env", `BAGGAGE=${CARRIED.BAGGAGE}`]);
  // Absent or withheld (the caller passes only what it forwards): an empty value, which OpenTelemetry reads as absent.
  expect(splitArgs("right", "/w", { BAGGAGE: CARRIED.BAGGAGE })).toEqual([...base, "--env", "TRACEPARENT=", "--env", "TRACESTATE=", "--env", `BAGGAGE=${CARRIED.BAGGAGE}`]);
  expect(splitArgs("right", "/w")).toEqual([...base, "--env", "TRACEPARENT=", "--env", "TRACESTATE=", "--env", "BAGGAGE="]);
  // Shown: a forwarded value is FORWARDED; an empty one has nothing to hide.
  expect(splitArgs("right", "/w", { TRACEPARENT: CARRIED.TRACEPARENT }, { shown: true })).toEqual([...base, "--env", "TRACEPARENT=<forwarded>", "--env", "TRACESTATE=", "--env", "BAGGAGE="]);
  // A split of a named pane (a worktree's root) names it in place of --current.
  expect(splitArgs("right", "/w", {}, { pane: "w5:p1" }).slice(0, 4)).toEqual(["pane", "split", "w5:p1", "--direction"]);
  // Only the three names, whatever else the object holds.
  expect(splitArgs("right", "/w", { LD_PRELOAD: "/evil.so", TRACEPARENT: "x" }).join(" ")).not.toContain("LD_PRELOAD");
});

test("a pane launch splits passes each present carrier with --env on that split, shows none of their values, and types none", async () => {
  const f = fakeHerdr();
  const r = await launch([...launchArgs, "--task", "Task"], { ...f.deps, env: { HERDR_ENV: "1", ...CARRIED } });
  expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w1:p2" });
  const split = f.calls.find((a) => a[1] === "split");
  // The real argv carries the values, as it must; one --env per carrier, after herdr's own options.
  expect(split.slice(split.indexOf("--no-focus") + 1)).toEqual(["--env", `TRACEPARENT=${CARRIED.TRACEPARENT}`, "--env", `TRACESTATE=${CARRIED.TRACESTATE}`, "--env", `BAGGAGE=${CARRIED.BAGGAGE}`]);
  expect(r.ran.find((c) => c.includes("pane split"))).toBe(displayCommand(["herdr", ...split.slice(0, split.indexOf("--no-focus") + 1),
    "--env", "TRACEPARENT=<forwarded>", "--env", "TRACESTATE=<forwarded>", "--env", "BAGGAGE=<forwarded>"]));
  expect(r.start.env).toEqual({ TRACEPARENT: "<forwarded>", TRACESTATE: "<forwarded>", BAGGAGE: "<forwarded>" });
  expect(r.warnings.filter((w) => /TRACE|BAGGAGE|carrier/.test(w))).toEqual([]);
  noCarrierValue(r);
  for (const m of ["CARRIER_MARK", "TRACEPARENT", "BAGGAGE"]) expect(typed(f.calls)).not.toContain(m);
  // Absent and empty carriers are passed empty, and one outside the limits is withheld with its warning and passed empty
  // too; the others go. start.env lists only the forwarded.
  const g = fakeHerdr();
  const s = await launch(launchArgs, { ...g.deps, env: { HERDR_ENV: "1", TRACEPARENT: CARRIED.TRACEPARENT, TRACESTATE: "", BAGGAGE: "a=\x1b[2J" } });
  const gs = g.calls.find((a) => a[1] === "split");
  expect(gs.slice(gs.indexOf("--no-focus") + 1)).toEqual(["--env", `TRACEPARENT=${CARRIED.TRACEPARENT}`, "--env", "TRACESTATE=", "--env", "BAGGAGE="]);
  expect(s.ran.find((c) => c.includes("pane split"))).toContain(displayCommand(["--env", "TRACEPARENT=<forwarded>", "--env", "TRACESTATE=", "--env", "BAGGAGE="]));
  expect(s.start.env).toEqual({ TRACEPARENT: "<forwarded>" });
  expect(s.warnings.filter((w) => /TRACE|BAGGAGE/.test(w))).toEqual(["BAGGAGE was not passed to the worker: routr passes it only when it is at most 8192 bytes of printable ASCII or tabs"]);
  expect(JSON.stringify(s)).not.toContain("\x1b[2J");
  // None at all: all three are passed empty, so the pane does not inherit the herdr server's, and nothing is said.
  const h = fakeHerdr();
  const none = await launch(launchArgs, h.deps);
  const hs = h.calls.find((a) => a[1] === "split");
  expect(hs.slice(hs.indexOf("--no-focus") + 1)).toEqual(["--env", "TRACEPARENT=", "--env", "TRACESTATE=", "--env", "BAGGAGE="]);
  expect([none.start.env, none.warnings.filter((w) => /TRACE|BAGGAGE|carrier/.test(w))]).toEqual([{}, []]);
});

test("a dry run shows the split's --env by name and placeholder only", async () => {
  const r = await launch([...launchArgs, "--direction", "down", "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); }, env: { ...CARRIED } });
  expect(r.would_run.find((c) => c.includes("pane split"))).toBe(displayCommand(["herdr", "pane", "split", "--current", "--direction", "down", "--cwd", process.cwd(), "--no-focus",
    "--env", "TRACEPARENT=<forwarded>", "--env", "TRACESTATE=<forwarded>", "--env", "BAGGAGE=<forwarded>"]));
  expect(r.start.env).toEqual({ TRACEPARENT: "<forwarded>", TRACESTATE: "<forwarded>", BAGGAGE: "<forwarded>" });
  noCarrierValue(r);
  // A worktree's pane is split from its root pane, with the same carriers; an existing pane gets none, and is told so.
  const w = await launch([...launchArgs, "--worktree", "b", "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); }, env: { TRACEPARENT: CARRIED.TRACEPARENT } });
  expect(w.would_run.find((c) => c.includes("pane split"))).toBe(displayCommand(["herdr", "pane", "split", "<root-pane>", "--direction", "right", "--cwd", "<worktree-path>", "--no-focus",
    "--env", "TRACEPARENT=<forwarded>", "--env", "TRACESTATE=", "--env", "BAGGAGE="]));
  expect([w.start.env, w.warnings.some((x) => x.includes("passed none"))]).toEqual([{ TRACEPARENT: "<forwarded>" }, false]);
  noCarrierValue(w);
  const p = await launch([...launchArgs, "--pane", "w1:p9", "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); }, env: { ...CARRIED } });
  expect(p.would_run.join("\n")).not.toContain("--env");
  expect(p.start.env).toEqual({});
  expect(p.warnings.some((x) => x.includes("passed none"))).toBe(true);
  noCarrierValue(p);
});

test("an existing pane and an adopted agent get no carriers, and launch says it passed none, never that the worker has none", async () => {
  const here = process.cwd(), env = { HERDR_ENV: "1", ...CARRIED };
  const pane = fakeHerdr();
  const adopt = fakeHerdr({ reply: (a) => (a[1] === "prompt" ? herdrOK({}) : a[1] === "get" && a[2] === "w1:p9" ? herdrOK({ agent: { agent: "claude", agent_status: "idle", interactive_ready: true, cwd: here } }) : undefined) });
  const runs = [
    [pane, [...launchArgs, "--pane", "w1:p9", "--cwd", here], "an existing pane"],
    [adopt, [...launchArgs, "--pane", "w1:p9", "--cwd", here, "--task", "Task"], "an existing pane"],
  ];
  for (const [f, args, why] of runs) {
    const r = await launch(args, { ...f.deps, env });
    expect([why, r.ok]).toEqual([why, true]);
    const said = r.warnings.filter((w) => w.includes("passed none"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(why);
    expect(said[0]).not.toMatch(/has none|have none/);
    expect(r.start.env).toEqual({});
    expect(f.calls.flat().join(" ")).not.toContain("--env");
    expect(typed(f.calls)).not.toMatch(/CARRIER_MARK|TRACEPARENT|TRACESTATE|BAGGAGE/);
    noCarrierValue(r);
  }
  expect(adopt.calls.some((a) => a[1] === "start")).toBe(false);
  // No carrier present: nothing to say.
  const quiet = fakeHerdr();
  expect((await launch([...launchArgs, "--pane", "w1:p9", "--cwd", here], quiet.deps)).warnings.filter((w) => w.includes("passed none"))).toEqual([]);
});

// A worktree's own fake: herdr opens workspace w5 with root pane w5:p1 in `path`; a split of w5:p1 makes w5:p2.
const worktreeHerdr = (path, { kind, split, close, also = () => undefined } = {}) => fakeHerdr({ kind, reply: (a) => {
  if (a[0] === "worktree") return herdrOK({ root_pane: { pane_id: "w5:p1" }, worktree: { path }, workspace: { workspace_id: "w5" } });
  if (a[1] === "split") return split?.(a) ?? (a[2] === "w5:p1" ? herdrOK({ pane: { pane_id: "w5:p2" } }) : herdrError("not_the_root"));
  if (a[1] === "close") return close?.(a);
  if (a[1] === "process-info") return shellInfo([{ pid: 1, cwd: path }]);
  return also(a);
} });

test("a worktree launch opens the worker's pane itself: split of the root pane in the worktree, with the carriers, then the root closed", async () => {
  const repo = scratch("wt-carriers-repo"), path = scratch("wt-carriers-tree");
  writeFileSync(join(repo, ".env.test"), "x=1");
  let copiedBeforeSplit = null;
  const f = worktreeHerdr(path, { split: (a) => { copiedBeforeSplit = existsSync(join(path, ".env.test")); return undefined; } });
  const r = await launch([...launchArgs, "--cwd", repo, "--worktree", "b", "--copy", ".env.test", "--task", "Task"], { ...f.deps, env: { HERDR_ENV: "1", TRACEPARENT: CARRIED.TRACEPARENT, BAGGAGE: CARRIED.BAGGAGE } });
  expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w5:p2", cwd: path, worktree: { branch: "b", path, workspace: "w5" } });
  // The order: worktree create, the copy, a split of the root pane in the worktree, the root's close, then the agent.
  const at = (pred) => f.calls.findIndex(pred);
  const split = f.calls[at((a) => a[1] === "split")];
  expect(split).toEqual(["pane", "split", "w5:p1", "--direction", "right", "--cwd", path, "--no-focus",
    "--env", `TRACEPARENT=${CARRIED.TRACEPARENT}`, "--env", "TRACESTATE=", "--env", `BAGGAGE=${CARRIED.BAGGAGE}`]);
  expect(copiedBeforeSplit).toBe(true);
  expect(at((a) => a[0] === "worktree")).toBe(0);
  expect(at((a) => a[1] === "split")).toBe(1);
  expect(f.calls[2]).toEqual(["pane", "close", "w5:p1"]);
  const start = f.calls.find((a) => a[1] === "start");
  expect(start.slice(start.indexOf("--pane"), start.indexOf("--pane") + 2)).toEqual(["--pane", "w5:p2"]);
  // Nothing after the close goes to the root pane: the agent never starts there.
  expect(f.calls.slice(3).filter((a) => a.includes("w5:p1"))).toEqual([]);
  expect(r.ran.slice(0, 3)).toEqual([displayCommand(["herdr", "worktree", "create", "--cwd", repo, "--branch", "b", "--no-focus"]),
    displayCommand(["herdr", "pane", "split", "w5:p1", "--direction", "right", "--cwd", path, "--no-focus", "--env", "TRACEPARENT=<forwarded>", "--env", "TRACESTATE=", "--env", "BAGGAGE=<forwarded>"]),
    displayCommand(["herdr", "pane", "close", "w5:p1"])]);
  expect(r.start.env).toEqual({ TRACEPARENT: "<forwarded>", BAGGAGE: "<forwarded>" });
  expect(r.warnings.filter((w) => /passed none|TRACE|BAGGAGE/.test(w))).toEqual([]);
  expect(cleanupStep(r)?.argv).toEqual(["routr", "cleanup", "--cwd", repo, "--worktree", "b"]);
  noCarrierValue(r);
  expect(typed(f.calls)).not.toMatch(/CARRIER_MARK|TRACEPARENT|TRACESTATE|BAGGAGE/);
  // Cursor (started with pane run, not agent start) gets the same pane.
  const src = join(scratch("wt-cursor"), "source.json"); writeFileSync(src, "{}");
  const c = worktreeHerdr(path, { kind: "cursor", also: (a) => (a[1] === "get" && c.calls.some((x) => x[1] === "run") ? herdrOK({ agent: { agent: "cursor", agent_status: "idle" } }) : undefined) });
  const cr = await launch(["--kind", "cursor", "--name", "worker", "--model", "composer-2.5", "--cwd", repo, "--worktree", "c"], { ...c.deps, cursorConfigSource: src, tempRoot: scratch("wt-cursor-tmp") });
  expect(cr).toMatchObject({ ok: true, pane: "w5:p2" });
  expect(c.calls.filter((a) => a[1] === "run").map((a) => a[2])).toEqual(["w5:p2"]);
  expect(c.calls.slice(3).filter((a) => a.includes("w5:p1"))).toEqual([]);
});

test("a worktree launch whose split, or close of the root pane, fails fails before any agent starts, saying the worktree was made and how to remove it", async () => {
  const path = process.cwd(), env = { HERDR_ENV: "1", ...CARRIED };
  const failed = worktreeHerdr(path, { split: () => herdrError("split_failed") });
  const r = await launch([...launchArgs, "--cwd", "/", "--worktree", "b"], { ...failed.deps, env });
  noCarrierValue(r);
  expect(r).toMatchObject({ ok: false, state: "failed" });
  expect(r.error).toContain(`created the worktree ${path}`);
  expect(r.error).toContain(displayCommand(["routr", "cleanup", "--cwd", resolve("/"), "--worktree", "b"]));
  expect(cleanupStep(r)?.argv).toEqual(["routr", "cleanup", "--cwd", resolve("/"), "--worktree", "b"]);
  // Neither the root pane (it is the workspace's only pane: closing it would leave the worktree) nor any agent.
  expect(failed.calls.filter((a) => a[1] === "close" || a[1] === "start")).toEqual([]);
  // A root pane left open would make the worker's pane one of two, which cleanup --pane would close, leaving the
  // worktree: nothing runs yet, so the launch ends there, and only the worktree's cleanup is given.
  const kept = worktreeHerdr(path, { close: () => herdrError("boom") });
  const k = await launch([...launchArgs, "--cwd", "/", "--worktree", "b", "--task", "Task"], { ...kept.deps, env });
  expect(k).toMatchObject({ ok: false, state: "failed" });
  expect(k.error).toContain(`created the worktree ${path}`);
  expect(k.error).toContain("extra shell pane");
  expect(k.error).toContain("w5:p1");
  expect(k.error).toContain(displayCommand(["routr", "cleanup", "--cwd", resolve("/"), "--worktree", "b"]));
  expect(k.next.filter((n) => n.kind === "run" && n.argv[1] === "cleanup").map((n) => n.argv)).toEqual([["routr", "cleanup", "--cwd", resolve("/"), "--worktree", "b"]]);
  expect(instructions(k)).not.toContain("--pane");
  expect(kept.calls.filter((a) => ["start", "run", "prompt", "send-keys"].includes(a[1]))).toEqual([]);
  expect(kept.calls.filter((a) => a[1] === "close")).toEqual([["pane", "close", "w5:p1"]]); // the new pane is not closed: that would close the workspace
  noCarrierValue(k);
});

test("a --pane launch into a pane of a worktree's workspace keeps the pane's own cleanup, and reads no workspace", async () => {
  const f = fakeHerdr();
  const r = await launch([...launchArgs, "--pane", "w5:p2", "--cwd", process.cwd()], f.deps);
  expect(r).toMatchObject({ ok: true, state: "ready", pane: "w5:p2" });
  expect(cleanupStep(r)?.argv).toEqual(["routr", "cleanup", "--pane", "w5:p2"]); // cleanup --pane redirects a worktree's only pane itself
  expect(f.calls.some((a) => a[1] === "list")).toBe(false);
});

test("a worktree launch whose agent never becomes ready fails without a carrier value, its pane's last lines redacted", async () => {
  const path = process.cwd(), tail = `$ claude\nTRACEPARENT=${CARRIED.TRACEPARENT} BAGGAGE=${CARRIED.BAGGAGE}\nError: gone`;
  const f = worktreeHerdr(path, { also: (a) => (a[1] === "wait" && f.calls.some((c) => c[1] === "start") ? herdrError("agent_not_running")
    : a[1] === "read" && a.includes("recent-unwrapped") ? herdrOK({ text: tail }) : undefined) });
  const r = await launch([...launchArgs, "--worktree", "b", "--task", "Task"], { ...f.deps, env: { HERDR_ENV: "1", ...CARRIED } });
  expect(r).toMatchObject({ ok: false, state: "failed", pane: "w5:p2" });
  expect(r.screen).toContain("TRACEPARENT=<carrier> BAGGAGE=<carrier>");
  noCarrierValue(r);
});

test("a worktree dry run plans the same steps, with no values and no pane ids", async () => {
  const r = await launch([...launchArgs, "--worktree", "b", "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); }, env: { ...CARRIED } });
  expect(r.would_run.slice(0, 3)).toEqual([displayCommand(["herdr", "worktree", "create", "--cwd", process.cwd(), "--branch", "b", "--no-focus"]),
    displayCommand(["herdr", "pane", "split", "<root-pane>", "--direction", "right", "--cwd", "<worktree-path>", "--no-focus", "--env", "TRACEPARENT=<forwarded>", "--env", "TRACESTATE=<forwarded>", "--env", "BAGGAGE=<forwarded>"]),
    displayCommand(["herdr", "pane", "close", "<root-pane>"])]);
  expect(r.would_run.find((c) => c.includes("agent start"))).toContain(displayCommand(["--pane", "<new-pane>"]));
  expect(r.would_run.join("\n")).not.toContain("pane current");
  noCarrierValue(r);
});

test("a screen launch returns never carries a carrier value routr holds: the needs_input screen and the failure tail are redacted", async () => {
  const env = { HERDR_ENV: "1", ...CARRIED, TRACESTATE: "k=CARRIER_MARK_TS\x1b" }; // withheld, and still redacted
  const shown = `TRACEPARENT=${CARRIED.TRACEPARENT}\nTRACESTATE=k=CARRIER_MARK_TS\x1b\nBAGGAGE=${CARRIED.BAGGAGE.slice(0, 10)}\n${CARRIED.BAGGAGE.slice(10)}\nfound '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)`;
  const asks = fakeHerdr({ reply: (a) => (a[1] === "read" ? herdrOK({ text: shown }) : undefined) });
  const r = await launch([...launchArgs, "--task", "Task"], { ...asks.deps, env });
  expect(r.state).toBe("needs_input");
  expect(r.screen).toContain("<carrier>");
  expect(r.screen).toContain("Source it?");
  noCarrierValue(r);
  // A start herdr refuses: launch reads the pane's recent lines for the harness's own complaint, and returns them.
  const tail = `$ claude\nTRACEPARENT=${CARRIED.TRACEPARENT} BAGGAGE=${CARRIED.BAGGAGE}\nError: bad flag`;
  const fails = fakeHerdr({ reply: (a) => (a[1] === "start" ? herdrError("refused") : a[1] === "read" && a.includes("recent-unwrapped") ? herdrOK({ text: tail }) : undefined) });
  const f = await launch(launchArgs, { ...fails.deps, env });
  expect(f.state).toBe("failed");
  expect(f.screen).toContain("Error: bad flag");
  expect(f.screen).toContain("TRACEPARENT=<carrier> BAGGAGE=<carrier>");
  noCarrierValue(f);
});
