// launch.mjs, herdr.mjs, harnesses.mjs: starting a worker in a herdr pane
import { expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { plan } from "../src/lib/harnesses.mjs";
import { composePrompt, launch, parseLaunchArgs, WORKER_GUIDE } from "../src/lib/launch.mjs";
import { paneText, promptSettled, quote, runHerdr, shellPrompt } from "../src/lib/herdr.mjs";
import { EventEmitter } from "node:events";
import { herdrError, herdrOK, SCRATCH, scratch, SCRIPT, shellInfo } from "./helpers.mjs";
test("launch plans use each harness's measured permissions and model syntax", () => {
  expect(plan({ kind: "claude", model: "sonnet", effort: "medium" }).argv)
    .toEqual(["--dangerously-skip-permissions", "--model", "sonnet", "--effort", "medium"]);
  expect(plan({ kind: "codex", model: "gpt-5.6-sol", effort: "high" }).argv)
    .toEqual(["--yolo", "-c", "check_for_update_on_startup=false", "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=high"]);
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
  writeFileSync(advice, JSON.stringify({ brief_sha: briefSha("Fix the flaky retry test in src/retry.mjs.") }));
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

test("launch --advice warns when the advice was given on a different text than the task it sends", async () => {
  const { briefSha } = await import("../src/lib/ledger.mjs");
  const dir = scratch("launch-advice"), task = join(dir, "task.md"), advice = join(dir, "advice.json");
  writeFileSync(task, "Fix the flaky retry test in src/retry.mjs.\n");
  const go = (a) => launch([...launchArgs, "--task-file", task, "--advice", a, "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); } });
  writeFileSync(advice, JSON.stringify({ brief_sha: briefSha("Fix the flaky retry test in src/retry.mjs.") })); // dispatch trims, as launch does
  const same = await go(advice);
  expect(same.advice).toEqual({ file: advice, matches: true });
  expect(same.warnings.join(" ")).not.toContain("different text");
  writeFileSync(advice, JSON.stringify({ brief_sha: briefSha("Retry test: see the task file for paths.") })); // a summary, as leads wrote 8 times
  const other = await go(advice);
  expect(other.advice).toEqual({ file: advice, matches: false });
  expect(other.warnings.join(" ")).toContain("was given on a different text than this task");
  const unread = await go(join(dir, "missing.json"));
  expect(unread.warnings.join(" ")).toContain("could not read it");
  expect(unread.advice).toBeUndefined();
});

test("launch options are validated before any pane operation", () => {
  const base = ["--kind", "claude", "--name", "worker"];
  for (const extra of [["--timeout", "0"], ["--timeout", "NaN"], ["--trust", "yes"], ["--direction", "left"], ["--task", "a", "--task-file", "b"], ["--model"], ["--bogus"], ["--name", "duplicate"]])
    expect(() => parseLaunchArgs([...base, ...extra])).toThrow();
  expect(parseLaunchArgs(base)).toMatchObject({ trust: "ask", timeout: 120000, dryRun: false });
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
  expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w1:p2", needs_input: null });
  expect(r.steps.map((s) => s.step).indexOf("ready")).toBeLessThan(r.steps.map((s) => s.step).indexOf("prompt"));
});

test("a question at startup is never answered: herdr's reading and the screen go to the orchestrator, with what the registry knows", async () => {
  // --trust auto (an older guide's launch line) still parses, answers nothing, and says so.
  for (const extra of [[], ["--trust", "auto"]]) {
    const f = fakeHerdr({ trust: claudeTrust, notReady: true });
    const r = await launch([...launchArgs, ...extra, "--task", "Task"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "needs_input", needs_input: { screen: claudeTrust, pane: "w1:p2", herdr: { state: "blocked", rule: "live_blocked_form", rules: "2026.09.11.1" } } });
    expect(r.needs_input.why).toContain("herdr reads it as live_blocked_form, rules 2026.09.11.1");
    expect(r.needs_input.note).toContain("trusted the repository in Claude"); // Claude's own way to be asked no more
    // How to carry on: the same launch into this pane, which adopts the agent once the question is answered.
    expect(r.needs_input.then).toContain("--pane w1:p2");
    // An inline brief is never repeated, and no placeholder stands in for it: the orchestrator gives it again.
    expect(r.needs_input.then).toContain("with your --task given again");
    expect(r.needs_input.then).toMatch(/--task <your task>$/);
    expect(r.needs_input.then).not.toContain("'Task'");
    expect(f.calls.some((a) => a[1] === "prompt")).toBe(false);
    expect(f.calls.filter((a) => a[1] === "send-keys")).toHaveLength(0);
    expect(r.warnings.some((w) => w.startsWith("--trust is no longer used"))).toBe(extra.length > 0);
  }
  // From the review of #47: herdr's explanation is extra; when it errors, throws, or comes back in another shape, the
  // confirmed block is still reported as needs_input, with the screen and the registry's note.
  for (const explain of [() => herdrError("invalid_request"), () => { throw new Error("herdr went away"); }, () => herdrOK({ nothing: true })]) {
    const f = fakeHerdr({ trust: claudeTrust, notReady: true, reply: (a) => (a[1] === "explain" ? explain() : undefined) });
    const r = await launch([...launchArgs, "--task", "Task"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "needs_input", needs_input: { screen: claudeTrust, herdr: { state: "blocked" } } });
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
    expect(r).toMatchObject({ ok: true, state: "planned", pane: null, command: [] });
    expect(r.planned_command.length).toBeGreaterThan(0);
    if (kind === "cursor") expect(existsSync(r.env.CURSOR_CONFIG_DIR)).toBe(false);
  }
});

test("task files are read and wrapped before any launch operation", async () => {
  const file = `${import.meta.dir}/../package.json`;
  const r = await launch([...launchArgs, "--task-file", file, "--dry-run"]);
  expect(r.state).toBe("planned");
  expect(r.prompt_chars).toBe(composePrompt(readFileSync(file, "utf8")).length);
  const missing = await launch([...launchArgs, "--task-file", "/does-not-exist", "--dry-run"]);
  expect(missing).toMatchObject({ ok: false, state: "failed", command: [] });
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
  for (const option of ["kind", "name", "cwd", "model", "effort", "pane", "direction", "task", "task-file", "trust", "timeout"]) {
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
    expect(r).toMatchObject({ ok: false, state: "failed", command: [] });
    expect(f.calls).toEqual([]);
  }
});

test("launch dispatch cannot be intercepted by a --version option or task value", () => {
  for (const suffix of [["--version"], ["--task", "--version"]]) {
    const r = Bun.spawnSync(["bun", SCRIPT, "launch", ...launchArgs, ...suffix]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ ok: false, state: "failed", command: [] });
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
  expect(r).toMatchObject({ ok: false, state: "needs_input", needs_input: { pane: "w1:p2", screen: expect.stringContaining("Source it?") } });
  expect(r.needs_input.why).toContain("asked a question");
  expect(r.needs_input.then).toContain("herdr pane send-keys w1:p2");
  expect(r.needs_input.then).toContain(`--task-file ${quote(task)} --pane w1:p2`); // quoted as the shell needs it (Windows paths)
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

test("from the review of #48: an agent of another kind in a pane launch did not make is never offered for closing", async () => {
  let started = false;
  const f = fakeHerdr({ reply: (a) => { if (a[1] === "start") started = true; if (a[1] === "get" && started) return herdrOK({ agent: { agent: "codex", agent_status: "idle" } }); } });
  const passed = await launch([...launchArgs, "--pane", "w1:p9", "--cwd", process.cwd()], f.deps);
  expect(passed.needs_input.then).toBe("Leave that pane; choose another, or leave --pane off");
  started = false;
  const made = await launch(launchArgs, fakeHerdr({ reply: (a) => { if (a[1] === "start") started = true; if (a[1] === "get" && started) return herdrOK({ agent: { agent: "codex", agent_status: "idle" } }); } }).deps);
  expect(made.needs_input.then).toContain("Close the pane this launch made (herdr pane close w1:p2)");
});

test("--pane adopts only an idle agent of the kind asked for, in --cwd; anything else goes back with the screen", async () => {
  const here = process.cwd();
  // An adopted agent is not waited on, so the fake's own "ready" stage (set by a wait) never comes: the prompt is taken here.
  const taking = (reply) => (a) => (a[1] === "prompt" ? herdrOK({}) : reply(a));
  const occupying = (agent, extra = {}) => fakeHerdr({ reply: taking((a) => (a[1] === "get" && a[2] === "w1:p9" ? herdrOK({ agent: { agent: "claude", agent_status: "idle", interactive_ready: true, cwd: here, ...agent } }) : undefined)), ...extra });
  const args = [...launchArgs, "--pane", "w1:p9", "--cwd", here, "--task", "Task"];
  // The `then` of a launch that stopped at a startup question: the agent is running, idle, the question answered.
  const adopt = occupying({});
  const r = await launch(args, adopt.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w1:p9" });
  expect(r.steps.map((st) => st.step)).toContain("adopt");
  expect(adopt.calls.some((a) => ["start", "run", "send-keys", "wait"].includes(a[1]))).toBe(false); // no shell, no second agent, no wait
  // From the review of #48: another kind, another folder, a working or a blocked agent are never sent the task.
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
  expect(u.warnings.join(" ")).toContain("address it by its pane, w1:p9");
  // Cursor too: its later rename (for one launch started) is not repeated for an adopted agent.
  const cursor = fakeHerdr({ kind: "cursor", reply: taking((a) => (a[1] === "get" && a[2] === "w1:p9" ? herdrOK({ agent: { agent: "cursor", agent_status: "idle", cwd: here } }) : a[1] === "rename" ? herdrError("name_taken") : undefined)) });
  const c = await launch(["--kind", "cursor", "--name", "worker", "--model", "composer-2.5", "--pane", "w1:p9", "--cwd", here, "--task", "Task"], cursor.deps);
  expect(c.state).toBe("prompted");
  expect(cursor.calls.filter((a) => a[1] === "rename")).toHaveLength(1);
});

// Seen 2026-10-05 (Codex, herdr rules 2026.10.01.1): the orchestrator answered Codex's folder trust and ran `then` at
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

test("the `then` of a startup question adopts the agent at once when herdr's live reading is idle, and never waits on it", async () => {
  const dir = scratch("adopt-ready"), task = join(dir, "task.md");
  writeFileSync(task, "Review the parser for hidden state.\n");
  const codex = ["--kind", "codex", "--name", "review", "--model", "gpt-6.1-sol", "--effort", "high", "--task-file", task];
  // 1. The first launch stops at the trust question: herdr reads it blocked, by trust_directory.
  const first = fakeHerdr({ kind: "codex", trust: codexTrust, notReady: true, reply: (a) => (a[1] === "explain" ? explained("blocked", "trust_directory") : undefined) });
  const stopped = await launch(codex, first.deps);
  expect(stopped).toMatchObject({ state: "needs_input", needs_input: { pane: "w1:p2", herdr: { state: "blocked", rule: "trust_directory" } } });
  // 2. The orchestrator answers it (herdr pane send-keys w1:p2 enter) and runs `then` at once: herdr's state still says
  // blocked, its explain (the live reading) says idle. The block is stale: the agent is adopted as idle.
  // The words of `then` are shell-quoted where needed (a Windows path is), so they are checked as text, not split.
  expect(stopped.needs_input.then).toContain("then run routr launch --kind codex --name review --model gpt-6.1-sol --effort high --task-file ");
  expect(stopped.needs_input.then).toContain(" --pane w1:p2 --cwd ");
  const again = [...codex, "--pane", "w1:p2", "--cwd", process.cwd()];
  for (const reads of ["idle", "done"]) {
    const stale = codexPane(["blocked"], [explained(reads, `osc_title_${reads}`)]);
    const r = await launch(again, stale.deps);
    expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w1:p2", needs_input: null });
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
  expect(r.warnings.join(" ")).toContain("Could not rename the adopted agent to review: address it by its pane, w1:p2");
  const order = f.calls.map((a) => a[1]);
  expect(order.filter((c) => c === "prompt")).toHaveLength(1);
  expect(order.indexOf("rename")).toBeGreaterThan(order.indexOf("prompt"));
});

// From the reviews of this change: waiting on an agent launch did not start (unknown, or working, to idle) could hand a
// busy worker a second task, since one wait can see it work and finish. An adopted agent is decided from one reading.
test("an adopted agent that herdr does not read idle is refused from one reading, never waited on", async () => {
  for (const [gets, explains, state] of [[["unknown", "idle"], [explained("idle")], "unknown"], [["working", "idle"], [explained("idle")], "working"],
    [["blocked", "idle"], [explained("working", "osc_title_working")], "working"], [["blocked", "idle"], [explained("unknown")], "unknown"]]) {
    const f = codexPane(gets, explains);
    const r = await launch(adoptArgs, f.deps);
    expect([gets[0], state, r.state]).toEqual([gets[0], state, "needs_input"]);
    expect(r.needs_input.why).toContain(`is ${state}, not waiting for a task`);
    expect(r.needs_input.then).toContain("herdr agent wait w1:p2 --until idle");
    expect(f.calls.some((a) => ["wait", "prompt", "send-keys", "rename"].includes(a[1]))).toBe(false);
  }
  // The screen is extra: a read that fails or runs out of time leaves it out, and the refusal stands.
  const slow = codexPane(["working"], [explained("idle")], { reads: herdrError("timeout") });
  const s = await launch(adoptArgs, slow.deps);
  expect(s).toMatchObject({ state: "needs_input", needs_input: { screen: null } });
  expect(s.needs_input.why).toContain("is working, not waiting for a task");
});

// An agent launch started itself has no task yet, so its start is waited through: a stale block (get blocked, explain
// idle) is not a question, and if the two readings still disagree when the time runs out, wherever it runs out (from
// the review of f8a30f9: inside a call, with each command taking time), the block is reported, not a timeout.
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

// From the final review: the saved disagreement (get blocked, explain idle) was cleared only when an agent was read, so
// an agent that then vanished left it standing, and the deadline reported a block nobody saw any more as needs_input.
test("an agent that vanishes after a stale block lets the readiness timeout fail, not report the old block", async () => {
  const codex = ["--kind", "codex", "--name", "review", "--model", "gpt-6.1-sol", "--task", "Task", "--timeout", "6000"];
  let gets = 0;
  const f = fakeHerdr({ kind: "codex", reply: async (a) => {
    if (a[1] === "get" && a[2] === "w1:p2") return ++gets === 1 ? herdrOK({ agent: { agent: "codex", agent_status: "blocked", cwd: process.cwd() } }) : herdrError("agent_not_found");
    if (a[1] === "explain") return explained("idle", "osc_title_idle");
  } });
  const r = await launch(codex, f.deps);
  expect(f.calls.some((a) => a[1] === "explain")).toBe(true); // the disagreement was seen
  expect(r).toMatchObject({ state: "failed", needs_input: null });
  expect(r.steps.at(-1).detail).toContain("Launch readiness timeout");
});

// From the final review: an adopted agent was renamed after its task even when the outcome read found another agent
// in the pane (or none), so the name could go to someone else's agent. The rename now needs the identity confirmed.
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
  // From the review of #48: a list that cannot be read is said, never passed over in silence.
  const unread = await launch(["--kind", "kiro", "--name", "worker", "--model", "glm-5", "--task", "Task"], { ...fakeKiro().deps, models: async () => null });
  expect(unread.warnings.join(" ")).toContain("Could not read kiro's model list");
});

test("fatal start, wait, and inspection errors cannot be masked by UI or polled forever", async () => {
  for (const op of ["start", "wait", "get"]) {
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === op) return herdrError("invalid_request");
      if (op === "start" && a[1] === "read" && f.calls.some((c) => c[1] === "start")) return herdrOK({ text: claudeTrust });
    } });
    const r = await launch([...launchArgs, "--trust", "auto"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "failed" });
    expect(f.calls.filter((a) => a[1] === op)).toHaveLength(1);
    expect(f.calls.some((a) => a[1] === "prompt" || (a[1] === "send-keys" && a[3] !== "n"))).toBe(false);
    expect(r.command.length).toBe(f.calls.length); // Includes the diagnostic read.
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
    const r = await launch(["--kind", "cursor", "--name", "worker", "--model", "composer-2.5", "--timeout", "1500", "--task", "Task"],
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
    if (expected !== "prompted") expect(r.warnings.join(" ")).toContain("before retrying");
    if (response.data.error?.code === "agent_blocked") expect(r.steps.find((s) => s.step === "prompt").ok).toBe(false);
  }
});

test("prompt waits request activity and reserve deadline budget for the status read", async () => {
  let submitted = false;
  const f = fakeHerdr({ reply: async (a, ms) => {
    if (a[1] === "prompt") {
      submitted = true;
      expect(a.slice(4, -2)).toEqual(["--wait", "--until", "working", "--until", "idle", "--until", "done", "--until", "blocked"]);
      expect(ms).toBeLessThanOrEqual(1500 - f.deps.now());
      expect(Number(a.at(-1))).toBeLessThan(ms);
      await f.deps.sleep(ms);
      return herdrError("timeout");
    }
    if (a[1] === "get" && submitted) return herdrOK({ agent: { agent: "claude", agent_status: "working" } });
    expect(ms).toBeGreaterThan(0);
  } });
  const r = await launch([...launchArgs, "--timeout", "1500", "--task", "Task"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted" });
  expect(f.deps.now()).toBeLessThan(1500);
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
      expect(existsSync(r.env.CURSOR_CONFIG_DIR)).toBe(false);
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
  expect(r.planned_command.some((s) => s.includes("pane current --current"))).toBe(true);
  expect(r.planned_command.some((s) => s.includes("pane process-info --pane"))).toBe(true);
  const explicit = await launch([...launchArgs, "--direction", "down", "--dry-run"]);
  expect(explicit.planned_command.some((s) => /pane (current|layout)/.test(s))).toBe(false);
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

// From the final review: runHerdr answered only on `close`, so a client that held its pipes after the kill (on Windows
// herdr behind cmd.exe, where the kill reaches cmd.exe alone) kept the call pending past its timeout. The timeout now
// answers by itself; only the child is killed (never its tree: it may have started the user's herdr server).
test("a herdr call answers at its timeout even when the killed client never closes its pipes", async () => {
  const child = new EventEmitter(), pipe = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  Object.assign(child, { stdout: pipe(), stderr: pipe(), signals: [], unrefd: false, kill(sig) { child.signals.push(sig); }, unref() { child.unrefd = true; } });
  const seen = [];
  const call = runHerdr(["agent", "get", "w1:p2"], 50, { via: (...a) => { seen.push(a); child.stdout.emit("data", '{"result":{}}'); return child; } });
  const r = await Promise.race([call, Bun.sleep(1000).then(() => "still pending")]);
  expect(r).toEqual({ ok: false, data: { error: { code: "timeout", message: "Herdr command timed out" } } });
  expect(seen.map(([cmd]) => cmd)).toEqual(["herdr"]);
  expect([child.signals, child.stdout.destroyed, child.stderr.destroyed, child.unrefd]).toEqual([["SIGKILL"], true, true, true]);
  child.emit("close", 0); // a late close changes nothing
  expect(await call).toMatchObject({ ok: false, data: { error: { code: "timeout" } } });
});

test("launch --copy is repeatable, needs --worktree, and refuses paths outside the repository", async () => {
  const { parseLaunchArgs } = await import("../src/lib/launch.mjs");
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
  expect(plan.planned_command[0]).toBe(`herdr worktree create --cwd ${quote(process.cwd())} --branch stacked --base feat/one --no-focus`);
  // A worktree launch: herdr gets --base as given, and the result names the one command that finishes the worker.
  const f = fakeHerdr({ reply: (a) => a[0] === "worktree" ? herdrOK({ root_pane: { pane_id: "w5:p1" }, worktree: { path: process.cwd() }, workspace: { workspace_id: "w5" } }) : undefined });
  const r = await launch([...launchArgs, "--cwd", "/", "--worktree", "stacked", "--base", "feat/one"], f.deps);
  expect(f.calls[0]).toEqual(["worktree", "create", "--cwd", "/", "--branch", "stacked", "--base", "feat/one", "--no-focus"]);
  expect(r).toMatchObject({ ok: true, pane: "w5:p1", worktree: { branch: "stacked", base: "feat/one", path: process.cwd(), workspace: "w5" }, cleanup: "routr cleanup --cwd / --worktree stacked" });
  // A split pane is closed by cleanup; a relaunch into a pane gets the pane's line (cleanup redirects a worktree's own).
  expect((await launch(launchArgs, fakeHerdr().deps)).cleanup).toBe("routr cleanup --pane w1:p2");
  const kept = await launch(launchArgs, fakeHerdr({ reply: (a) => a[1] === "start" ? herdrError("boom") : undefined }).deps);
  expect(kept).toMatchObject({ state: "failed", cleanup: "routr cleanup --pane w1:p2" }); // a start was tried: the pane stays
  const closed = await launch(launchArgs, fakeHerdr({ reply: (a) => a[1] === "process-info" ? herdrError("boom") : undefined }).deps);
  expect(closed.steps.map((s) => s.step)).toContain("cleanup_pane"); expect(closed.cleanup).toBeUndefined(); // closed by launch
});

test("Windows shell prompts count as ready; a bare continuation prompt still does not", () => {
  for (const text of ["PS C:\\Users\\chris>", "PS C:\\Users\\chris\\AppData\\Local\\Temp\\routr-wintest> ", "C:\\Users\\chris>", "Windows PowerShell\nCopyright (C) Microsoft\n\nPS D:\\work\\my repo>"])
    expect(shellPrompt(text)).toBe("ready");
  expect(shellPrompt("> ")).toBe("question");
  expect(shellPrompt(">> ")).not.toBe("ready");
  expect(shellPrompt("Do you want to continue? C:\\temp>no")).not.toBe("ready");
});

test("launch never puts the brief in its result: not in the command log, not in a dry run", async () => {
  const { launch } = await import("../src/lib/launch.mjs");
  const secret = "REFACTOR-THE-PAYMENTS-LEDGER-7731";
  const r = await launch(["--kind", "codex", "--name", "w", "--cwd", process.cwd(), "--worktree", "b", "--model", "m", "--task", `Do this: ${secret}`, "--dry-run"]);
  expect(r.prompt_chars).toBeGreaterThan(secret.length);
  expect(JSON.stringify(r)).not.toContain(secret);
  expect(r.planned_command.join("\n")).toContain("<prompt: ");
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
  expect(SHELLS.powershell.cd("C:\\it's here")).toBe("Set-Location -LiteralPath 'C:\\it''s here'");
  expect(SHELLS.cmd.cursorEnv(dir)).toBe(`set "CURSOR_CONFIG_DIR=${dir}"`);
  expect(SHELLS.cmd.cd("C:\\a b")).toBe('cd /d "C:\\a b"');
  expect(SHELLS.posix.cursor("/tmp/x", "cursor-agent", ["--trust"])).toMatch(/^env CURSOR_CONFIG_DIR=\/tmp\/x sh -c 'trap .*cursor-agent --trust'$/);
  expect(SHELLS.posix.cd("/a b")).toBe("cd -- '/a b'");
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
});

test("launch refuses a subscription the user turned off, before any herdr call", async () => {
  const f = fakeHerdr({ kind: "codex" });
  const r = await launch(["--kind", "codex", "--name", "worker", "--model", "m"], { ...f.deps, settings: () => ({ subscriptions: { codex: { enabled: false } } }) });
  expect(r.steps.at(-1).detail).toBe("Codex is turned off in your settings: turn it on with routr setup --enable codex");
  expect(f.calls).toEqual([]);
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
  expect(never.r.needs_input.screen).not.toContain("Task"); // the brief is never printed
  const asks = await drive("blocked", "claude"); // it took the task and now asks something
  expect(asks).toMatchObject({ prompts: 1, keys: 0, r: { state: "needs_input" } });
});

test("from the review of #46: a worker seen starting counts even if it is done by the status read; the wait leaves time for the reads after it; the brief stays off the output", async () => {
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
