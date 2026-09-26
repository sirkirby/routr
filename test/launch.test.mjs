// launch.mjs, herdr.mjs, harnesses.mjs: starting a worker in a herdr pane
import { expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { HARNESSES, plan } from "../src/lib/harnesses.mjs";
import { composePrompt, launch, parseLaunchArgs, permissiveConfirm, trustDialog, WORKER_GUIDE } from "../src/lib/launch.mjs";
import { paneText, promptSettled, quote, shellPrompt } from "../src/lib/herdr.mjs";
import { herdrError, herdrOK, SCRATCH, scratch, SCRIPT, shellInfo } from "./helpers.mjs";
test("launch plans use each harness's measured permissions and model syntax", () => {
  expect(plan({ kind: "claude", model: "sonnet", effort: "medium" }).argv)
    .toEqual(["--dangerously-skip-permissions", "--model", "sonnet", "--effort", "medium"]);
  expect(plan({ kind: "codex", model: "gpt-5.6-sol", effort: "high" }).argv)
    .toEqual(["--yolo", "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=high"]);
  expect(plan({ kind: "cursor", model: "composer-2.5", cursorConfigDir: "/private/config" }))
    .toMatchObject({ executable: "cursor-agent", argv: ["--yolo", "--trust", "--model", "composer-2.5"], env: { CURSOR_CONFIG_DIR: "/private/config" } });
  expect(plan({ kind: "agy", model: "gemini-3.8-flash-low", cwd: "/work" }).argv)
    .toEqual(["--dangerously-skip-permissions", "--add-dir", "/work", "--model", "gemini-3.8-flash-low"]);
  expect(plan({ kind: "kiro", model: "claude-haiku-4.5" })).toMatchObject({ executable: "kiro-cli", argv: ["chat", "--trust-all-tools", "--model", "claude-haiku-4.5"], env: {} });
});

test("Kiro's effort: auto passes no flag (the model decides, nothing remembered); a level is passed and its side effect said", () => {
  const auto = plan({ kind: "kiro", model: "auto", effort: "auto" });
  expect(auto.argv).toEqual(["chat", "--trust-all-tools", "--model", "auto"]);
  expect(auto.warnings.join(" ")).not.toContain("remembers");
  const high = plan({ kind: "kiro", model: "claude-opus-4.8", effort: "high" });
  expect(high.argv).toEqual(["chat", "--trust-all-tools", "--model", "claude-opus-4.8", "--effort", "high"]);
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

test("shell detection distinguishes dotenv, a clean prompt, and unfinished startup", () => {
  expect(shellPrompt("found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver) ")).toBe("dotenv");
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

test("a trust dialog's options come only from the dialog", () => {
  const withTips = "Tips for getting started:\n  1. Run /init\n  2. Ask questions\n\nDo you trust the files in this folder?\n\n  1. Yes, I trust this folder\n❯ 2. No, exit";
  expect(trustDialog(withTips)).toMatchObject({ affirmative: { text: "Yes, I trust this folder" }, keys: ["up", "enter"] });
  expect(trustDialog(withTips).options).toHaveLength(2);   // the tip list above the question is not an option
});

test("an unrecognized prompt counts only once it has stopped changing", () => {
  const powerline = " dev@workstation  ~/Repos/routr  ↱ routr-skill ";
  expect(promptSettled(powerline, powerline.trim())).toBe(true);   // same line twice: settled
  expect(promptSettled(powerline, "Loading...")).toBe(false);       // still changing
  expect(promptSettled("", "")).toBe(false);                        // nothing on the line is never a prompt
});

const claudeTrust = "Do you trust the files in this folder?\n\n  1. Yes, I trust this folder\n❯ 2. No, exit\n\nEnter to confirm · Esc to cancel";

const codexTrust = "Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\nPress enter to continue";

test("trust detection chooses the affirmative option even when No is selected", () => {
  expect(trustDialog(claudeTrust)).toMatchObject({ affirmative: { number: "1", text: "Yes, I trust this folder" }, keys: ["up", "enter"] });
  expect(trustDialog(codexTrust)).toMatchObject({ affirmative: { number: "1" }, keys: ["enter"] });
  expect(trustDialog("Trust this workspace?\n› 1. No, exit\n  2. Yes, continue")?.keys).toEqual(["down", "enter"]);
  expect(trustDialog(claudeTrust.replace("❯", " "))?.keys).toBeNull();
  expect(trustDialog("Do you trust the files in this folder?" )?.keys).toBeNull();
  expect(trustDialog("Folder trust is configured.\nReady\n❯")).toBeNull();
  expect(trustDialog("Ready\n❯")).toBeNull();
});

test("pane reads extract text from JSON without mistaking envelope fields for pane contents", () => {
  expect(paneText({ id: "cli:pane:read", result: { text: claudeTrust, type: "pane_read" } })).toBe(claudeTrust);
  expect(paneText({ result: { snapshot: { lines: ["hello", "❯"] } } })).toBe("hello\n❯");
  expect(paneText("❯")).toBe("❯");
  expect(() => paneText({ result: { type: "unknown" } })).toThrow("Unrecognized");
});

test("launch options are validated before any pane operation", () => {
  const base = ["--kind", "claude", "--name", "worker"];
  for (const extra of [["--timeout", "0"], ["--timeout", "NaN"], ["--trust", "yes"], ["--direction", "left"], ["--task", "a", "--task-file", "b"], ["--model"], ["--bogus"], ["--name", "duplicate"]])
    expect(() => parseLaunchArgs([...base, ...extra])).toThrow();
  expect(parseLaunchArgs(base)).toMatchObject({ trust: "ask", timeout: 120000, dryRun: false });
  expect(quote("a'$(touch /tmp/no);`whoami`\n")).toBe("'a'\\''$(touch /tmp/no);`whoami`\n'");
});

function fakeHerdr({ kind = "claude", trust = null, notReady = false, foreground = false, stuck = false, reply = () => undefined } = {}) {
  let stage = "shell", dotenv = true, ticks = 0;
  const calls = [];
  const ok = (result) => ({ ok: true, data: { result } });
  const deps = {
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
      if (a[1] === "send-keys") {
        if (stage === "shell") { expect(a.slice(3)).toEqual(["n", "enter"]); dotenv = false; }
        else { expect(a.slice(3)).toEqual(trustDialog(trust).keys); stage = "starting"; }
        return ok({});
      }
      if (a[1] === "run") return ok({});
      if (a[1] === "close" || a[1] === "rename") return ok({});
      if (a[1] === "start") {
        expect(dotenv).toBe(false); stage = trust ? "trust" : "starting";
        return notReady ? { ok: false, data: { error: { code: "agent_not_ready", message: "blocked on startup" } } } : ok({});
      }
      if (a[1] === "wait") { expect(stage).not.toBe("trust"); if (!stuck) stage = "ready"; return ok({}); }
      if (a[1] === "get") return ok({ agent: { agent: kind, agent_status: stage === "ready" ? "idle" : "unknown", interactive_ready: stage === "ready" } });
      if (a[1] === "prompt") { expect(stage).toBe("ready"); expect(a).toContain("--wait"); return ok({}); }
      throw new Error(`Unexpected command ${a.join(" ")}`);
    },
  };
  return { calls, deps };
}

const launchArgs = ["--kind", "claude", "--name", "worker", "--model", "sonnet"];

test("startup answers the shell, recovers agent_not_ready, selects trust, then prompts", async () => {
  const f = fakeHerdr({ trust: claudeTrust, notReady: true });
  const r = await launch([...launchArgs, "--trust", "auto", "--task", "Fix the parser. Verify with bun test."], f.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w1:p2", needs_human: null });
  expect(r.warnings.join(" ")).toContain("Answered no");
  expect(r.steps.find((s) => s.step === "trust").detail).toContain("1. Yes, I trust this folder; sent up, enter");
  expect(r.steps.map((s) => s.step).indexOf("ready")).toBeLessThan(r.steps.map((s) => s.step).indexOf("prompt"));
});

test("Codex idle at trust still needs a human under the default policy", async () => {
  const f = fakeHerdr({ kind: "codex", trust: codexTrust });
  const r = await launch(["--kind", "codex", "--name", "worker", "--model", "gpt-5.6-sol", "--task", "Task"], f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_human", needs_human: { pane_text: codexTrust } });
  expect(f.calls.some((a) => a[1] === "prompt" || a[1] === "close")).toBe(false);
  expect(f.calls.filter((a) => a[1] === "send-keys")).toHaveLength(1); // dotenv only
});

test("auto trust leaves an ambiguous menu alive without guessing an answer", async () => {
  const f = fakeHerdr({ trust: claudeTrust.replace("❯", " "), notReady: true });
  const r = await launch([...launchArgs, "--trust", "auto"], f.deps);
  expect(r.state).toBe("needs_human");
  expect(f.calls.filter((a) => a[1] === "send-keys")).toHaveLength(1);
});

test("an existing occupied pane receives no input and is never closed", async () => {
  const f = fakeHerdr({ foreground: true });
  const r = await launch([...launchArgs, "--pane", "w1:p9"], f.deps);
  expect(r.state).toBe("needs_human");
  expect(f.calls.every((a) => ["read", "process-info"].includes(a[1]))).toBe(true);
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

test("unchanged dotenv questions stop after one answer and leave the pane for a human", async () => {
  let sent = 0;
  const f = fakeHerdr({ reply: (a) => {
    if (a[1] === "send-keys") { sent++; return herdrOK(); }
  } });
  const r = await launch(launchArgs, f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_human" });
  expect(r.needs_human.why).toContain("did not clear");
  expect(sent).toBe(1);
  expect(f.deps.now()).toBe(5000);
});

test("a settled shell in the wrong directory is reported rather than started", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "process-info" ? shellInfo([{ pid: 1, cwd: "/" }]) : undefined });
  const r = await launch(launchArgs, f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_human" });
  expect(r.needs_human.why).toContain("wrong directory");
  expect(f.calls.some((a) => a[1] === "start")).toBe(false);
});

test("trust parsing ignores old dialogs and refuses ambiguous menus", () => {
  expect(trustDialog(`${claudeTrust}\nReady\n❯`)).toBeNull();
  expect(trustDialog(`Folder trust is configured.\n1. Yes, continue\n› 2. No`)).toBeNull();
  expect(trustDialog(`${claudeTrust}\n\n${codexTrust}`).keys).toEqual(["enter"]);
  expect(trustDialog(codexTrust.replace("?", "?\n/projects/$")).keys).toEqual(["enter"]);
  expect(trustDialog(codexTrust.split("\n").map((line) => `│ ${line} │`).join("\n")).keys).toEqual(["enter"]);
  for (const options of [
    "› 1. Yes, continue\n❯ 2. No, quit",
    "› 1. Yes, continue\n2. Yes, I trust this folder",
    "› 1. No, quit\n3. Yes, continue",
    "› 1. Yes, delete all files\n2. No, quit",
    "› 1. No, quit\nUnrelated menu:\n2. Yes, continue",
  ]) expect(trustDialog(`Do you trust this folder?\n${options}`).keys).toBeNull();
});

test("a persistent trust dialog is answered once, then requires a human", async () => {
  const f = fakeHerdr({ trust: claudeTrust, reply: (a) =>
    a[1] === "send-keys" && a[3] !== "n" ? herdrOK() : undefined });
  const r = await launch([...launchArgs, "--trust", "auto"], f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_human" });
  expect(r.needs_human.why).toContain("did not clear");
  expect(f.calls.filter((a) => a[1] === "send-keys" && a[3] !== "n")).toHaveLength(1);
  expect(r.warnings.join(" ")).toContain("Accepted folder trust");
  expect(f.deps.now()).toBeLessThan(6000);
});

test("a different trust menu after one acceptance stops without sending more keys", async () => {
  let answered = false;
  const f = fakeHerdr({ trust: claudeTrust, reply: (a) => {
    if (a[1] === "send-keys" && a[3] !== "n") { answered = true; return herdrOK(); }
    if (a[1] === "read" && answered) return herdrOK({ text: codexTrust });
  } });
  const r = await launch([...launchArgs, "--trust", "auto"], f.deps);
  expect(r.state).toBe("needs_human");
  expect(r.needs_human.why).toContain("different");
  expect(f.calls.filter((a) => a[1] === "send-keys" && a[3] !== "n")).toHaveLength(1);
});

// Kiro CLI 2.24.1's screens, as read from a herdr pane (2026-09-26).
const kiroConfirm = (sel) => ` Warning: Kiro is running in trust all tools mode\n ────────\n In this mode, Kiro will execute all tool calls — including shell commands, file operations, and MCP tools — without asking for your approval.\n By proceeding, you confirm that you understand the risks and accept responsibility for all actions taken during this session.\n${["No, exit", "Yes, I accept", "Yes, and don't ask again"].map((o, i) => ` ${i === sel ? "❯" : " "} ${o}`).join("\n")}\n ────────\n  esc to cancel · ↑↓ to navigate · ↵ to select`;

const kiroReady = (model) => ` Trust All Tools active, confirmations are off · /quit to exit\n────────\nkiro_default · ${model ? `${model} · ` : ""}◔ 5%        /private/tmp/work\n›  ask a question or describe a task ↵`;

test("Kiro's trust-all-tools confirmation: move to \"Yes, I accept\", see it selected, then enter; never \"don't ask again\"", () => {
  const { confirm } = HARNESSES.kiro;
  expect(permissiveConfirm(kiroConfirm(0), confirm)).toMatchObject({ answer: "Yes, I accept", keys: ["down"] });
  expect(permissiveConfirm(kiroConfirm(1), confirm)).toMatchObject({ keys: ["enter"] });
  expect(permissiveConfirm(kiroConfirm(2), confirm).keys).toEqual(["up"]);
  expect(permissiveConfirm(kiroConfirm(0).replace("❯", " "), confirm).keys).toBeNull(); // nothing selected: no guess
  expect(permissiveConfirm(kiroConfirm(0).replace("Yes, I accept", "Yes, continue"), confirm).keys).toBeNull();
  expect(permissiveConfirm(`${kiroConfirm(0)}\n${kiroReady("glm-5")}`, confirm)).toBeNull(); // answered: scrolled past
  expect(permissiveConfirm(kiroReady("glm-5"), confirm)).toBeNull();
  expect(permissiveConfirm(claudeTrust, confirm)).toBeNull();
  expect(permissiveConfirm(kiroConfirm(0), undefined)).toBeNull(); // only a harness that asks
  expect(trustDialog(kiroConfirm(0))).toBeNull(); // not a folder trust: --trust does not govern it
  expect(HARNESSES.kiro.showsModel(kiroReady("claude-sonnet-4.5"), "claude-sonnet-4.5")).toBe(true);
  expect(HARNESSES.kiro.showsModel(kiroReady(null), "not-a-model")).toBe(false);
  expect(HARNESSES.kiro.showsModel(kiroReady("claude-sonnet-4.5"), "claude-sonnet-4")).toBe(false);
});

function fakeKiro({ model = "glm-5", shown = model } = {}) {
  let sel = 0, accepted = false;
  const keys = [];
  const f = fakeHerdr({ kind: "kiro", reply: (a) => {
    const started = f.calls.some((c) => c[1] === "start");
    if (a[1] === "read" && started) return herdrOK({ text: accepted ? kiroReady(shown) : kiroConfirm(sel) });
    if (a[1] === "send-keys" && started) {
      keys.push(a.slice(3));
      if (a[3] === "down") sel++; else if (a[3] === "up") sel--; else if (a[3] === "enter") accepted = sel === 1;
      return herdrOK();
    }
  } });
  return { ...f, keys };
}

test("launch answers Kiro's confirmation under the default --trust ask, one key at a time, and checks the model took", async () => {
  const f = fakeKiro();
  const r = await launch(["--kind", "kiro", "--name", "worker", "--model", "glm-5", "--task", "Task"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted" });
  expect(f.keys).toEqual([["down"], ["enter"]]); // an arrow and enter in one burst chose "No, exit" (measured)
  expect(f.calls.find((a) => a[1] === "start")).toEqual(expect.arrayContaining(["--kind", "kiro", "--", "chat", "--trust-all-tools", "--model", "glm-5"]));
  expect(r.steps.find((s) => s.step === "confirm").detail).toContain("Yes, I accept");
  expect(r.steps.find((s) => s.step === "model").ok).toBe(true);
  expect(r.warnings.join(" ")).toContain("this session");
});

test("a Kiro that silently dropped the model id is never prompted", async () => {
  const f = fakeKiro({ model: "not-a-model", shown: null });
  const r = await launch(["--kind", "kiro", "--name", "worker", "--model", "not-a-model", "--task", "Task"], f.deps);
  expect(r).toMatchObject({ ok: false, state: "failed" });
  expect(r.steps.at(-1).detail).toContain("did not take --model not-a-model");
  expect(r.steps.at(-1).detail).toContain("kiro-cli chat --list-models");
  expect(f.calls.some((a) => a[1] === "prompt")).toBe(false);
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
    { status: "blocked", response: herdrOK(), expected: "needs_human" },
    { status: "blocked", response: herdrError("agent_blocked"), expected: "needs_human" },
    { status: "unknown", response: herdrOK(), expected: "failed" },
    { status: "working", response: herdrError("agent_prompt_stalled"), expected: "failed" },
    { status: "working", response: herdrError("timeout"), expected: "prompted" },
    { status: "idle", response: herdrError("timeout"), expected: "failed" },
    { status: "done", response: herdrOK(), expected: "prompted" },
    { status: "working", response: herdrOK(), kind: "codex", expected: "needs_human" },
  ]) {
    let submitted = false;
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === "prompt") { submitted = true; return response; }
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

test("unnumbered trust menus are parsed: Antigravity selects Yes already, Claude Code defaults to No", async () => {
  const { trustDialog } = await import("../src/lib/launch.mjs");
  const agy = trustDialog("Accessing workspace:\n\n/w/x\n\nDo you trust the contents of this project?\n\nAntigravity CLI requires permission to read, edit, and execute files here.\n\n> Yes, I trust this folder\n  No, exit\n\n  ↑/↓ Navigate · enter Confirm\n");
  expect(agy.affirmative.text).toBe("Yes, I trust this folder"); expect(agy.keys).toEqual(["enter"]);
  const claude = trustDialog(" Accessing workspace:\n /w/x\n Quick safety check: Is this a project you created or one you trust? If not, review it first.\n Do you trust the files in this folder?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n");
  expect(claude.keys).toEqual(["down", "enter"]);
  // A menu with no selection marker is never guessed at.
  expect(trustDialog("Do you trust the contents of this project?\n  Yes, I trust this folder\n  No, exit\n").keys).toBeNull();
});

test("launch --copy is repeatable, needs --worktree, and refuses paths outside the repository", async () => {
  const { parseLaunchArgs } = await import("../src/lib/launch.mjs");
  const base = ["--kind", "codex", "--name", "w", "--model", "m"];
  expect(parseLaunchArgs([...base, "--worktree", "b", "--copy", ".env.test", "--copy", "fixtures"]).copy).toEqual([".env.test", "fixtures"]);
  expect(() => parseLaunchArgs([...base, "--copy", "x"])).toThrow("--worktree");
  expect(() => parseLaunchArgs([...base, "--worktree", "b", "--copy", "../secrets"])).toThrow("inside the repository");
  expect(() => parseLaunchArgs([...base, "--worktree", "b", "--copy", "/etc/passwd"])).toThrow("inside the repository");
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
  // This exact line was run on Windows 11: the watcher appeared, and the folder was gone once the shell exited.
  expect(SHELLS.powershell.cursorEnv(dir)).toBe(`$env:CURSOR_CONFIG_DIR='${dir}'; $w = 'powershell -NoProfile -WindowStyle Hidden -Command "Wait-Process -Id ' + $PID + '; Remove-Item -LiteralPath ''${dir}'' -Recurse -Force -ErrorAction SilentlyContinue"'; ([wmiclass]'Win32_Process').Create($w) | Out-Null`);
  expect(SHELLS.powershell.cd("C:\\it's here")).toBe("Set-Location -LiteralPath 'C:\\it''s here'");
  expect(SHELLS.cmd.cursorEnv(dir)).toBe(`set "CURSOR_CONFIG_DIR=${dir}"`);
  expect(SHELLS.cmd.cd("C:\\a b")).toBe('cd /d "C:\\a b"');
  expect(SHELLS.posix.cursor("/tmp/x", "cursor-agent", ["--trust"])).toMatch(/^env CURSOR_CONFIG_DIR=\/tmp\/x sh -c 'trap .*cursor-agent --trust'$/);
  expect(SHELLS.posix.cd("/a b")).toBe("cd -- '/a b'");
});

test("waitForShell: ready at a settled prompt, answers dotenv once, and stops at a question, a busy adopted pane, or the wrong folder", async () => {
  const { waitForShell } = await import("../src/lib/herdr.mjs");
  const here = process.cwd();
  const pane = (screens, { busy = false } = {}) => {
    const keys = [];
    return { keys, read: async () => screens.length > 1 ? screens.shift() : screens[0], keys: async (...k) => { keys.push(k); },
      info: async () => ({ shell_pid: 1, foreground_processes: busy ? [{ pid: 1, name: "zsh", cwd: here }, { pid: 2 }] : [{ pid: 1, name: "zsh", cwd: here }] }) };
  };
  let t = 0;
  const time = { sleep: async (ms) => { t += ms; }, now: () => t, remaining: () => 60000 };
  expect(await waitForShell(pane(["chris % "]), time)).toEqual({ ok: true, name: "zsh", cwd: here }); // settles on the second read
  const dotenv = pane(["found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)", "chris % "]);
  const answered = [];
  expect((await waitForShell(dotenv, { ...time, onAnswer: () => answered.push(1) })).ok).toBe(true);
  expect(answered).toEqual([1]);
  expect(await waitForShell(pane(["Overwrite? [y/N]"]), time)).toMatchObject({ ok: false, why: "Unrecognized shell question" });
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
test("a prompt herdr says stalled is sent once more only when the pane shows no trace of it, no dialog, and the agent idle", async () => {
  const drive = async (shown, status = "idle") => {
    let prompts = 0;
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === "prompt") return ++prompts === 1 ? herdrError("agent_prompt_stalled") : undefined;
      if (a[1] === "read" && a.includes("recent-unwrapped")) return herdrOK({ text: shown });
      if (a[1] === "get" && prompts === 1) return herdrOK({ agent: { agent: "claude", agent_status: status, interactive_ready: true } });
    } });
    const r = await launch([...launchArgs, "--task", "Task"], f.deps);
    return { r, prompts, retried: r.steps.some((s) => s.step === "prompt_retry") };
  };
  const never = await drive("Welcome\n❯");
  expect(never).toMatchObject({ prompts: 2, retried: true, r: { ok: true, state: "prompted" } });
  // Any trace of the prompt, a dialog, or an agent that is not idle: never sent twice, and the person is warned.
  for (const [why, shown, status] of [
    ["the opening", "❯ You are a routr worker. Your first action…", "idle"],
    ["a half-pasted opening", "❯ You are a routr wor", "idle"],
    ["only the closing line of a long task (the opening scrolled away)", "…line 400 of the task\n\nFinish with the report block from the worker guide, starting with the line `VERDICT: done | partial | blocked`.", "idle"],
    ["a folder-trust dialog", claudeTrust, "idle"],
    ["a paste the harness folded into a placeholder", "  → [Pasted text #1 +18 lines]", "idle"],
    ["a short part of the opening", "❯ You are a", "idle"],
    ["the closing line hard-wrapped at 40 columns", "Finish with the report block from the\nworker guide, starting with the line `VERD\nICT: done | partial | blocked`.", "idle"],
    ["an agent that is not idle", "Welcome\n❯", "working"],
  ]) {
    const x = await drive(shown, status);
    expect([why, x.prompts, x.retried]).toEqual([why, 1, false]);
    expect(x.r.state).not.toBe("prompted");
    expect(x.r.warnings).toContain("Prompt may have been submitted; inspect the pane before retrying.");
  }
});

test("prompt traces survive any wrap and box drawing, and ordinary screens have none", async () => {
  const { promptTrace, composePrompt } = await import("../src/lib/launch.mjs");
  const full = composePrompt("Do the thing.\n".repeat(1200));
  const wrapped = (w) => full.split("\n").flatMap((l) => l.match(new RegExp(`.{1,${w}}`, "g")) ?? [""]).map((l) => `│ ${l} │`);
  for (const w of [20, 40, 80]) expect(promptTrace(wrapped(w).slice(-1000).join("\n"))).toBe(true); // the closing survives, however it wraps
  for (const screen of ["Welcome\n❯", "kiro_default · auto · ◔ 1%", "  ~/.herdr/worktrees/routr/review5-verify · review5-verify", "chris % "]) expect(promptTrace(screen)).toBe(false);
});
