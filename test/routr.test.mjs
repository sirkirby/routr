import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advise } from "../skills/routr/scripts/lib/advise.mjs";
import { readReport } from "../skills/routr/scripts/lib/check.mjs";
import { DEFAULTS, loadConfig } from "../skills/routr/scripts/lib/config.mjs";
import { rankSubscriptions } from "../skills/routr/scripts/lib/pick.mjs";
import { plan } from "../skills/routr/scripts/lib/harness.mjs";
import { composePrompt, promptSettled, launch, paneText, parseLaunchArgs, quote, shellPrompt, trustDialog, WORKER_GUIDE } from "../skills/routr/scripts/lib/launch.mjs";
import { COMMANDS, DESCRIPTION, formatCommandHelp, formatTopLevelHelp, formatUnknownUsage } from "../skills/routr/scripts/lib/help.mjs";

const cfg = (over = {}) => ({ ...DEFAULTS, subscriptions: {
  claude: { hardest_work: "strong", reserve: 0.25, assumed_headroom: 0.5 },
  codex: { hardest_work: "strong", reserve: 0.2, assumed_headroom: 0.5 },
  cursor: { hardest_work: "standard", reserve: 0.1, assumed_headroom: 0.5 },
}, ...over });
const ans = (score, confidence, kind = "implement", blast = 0.1, kinds = { [kind]: 1 }) =>
  ({ level: { score, confidence, probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 } }, work_type: { choice: kind, confidence: 1, probabilities: kinds }, high_blast_radius: { noul: blast } });
const live = (pool, headroom) => ({ pool, source: "t", ageSec: 5, windows: [{}], headroom });
const NOW = 1_800_000_000_000, win = (usedPct, hoursLeft, windowMin = 10080) => ({ name: "seven_day", usedPct, windowMin, resetsAt: NOW / 1000 + hoursLeft * 3600 });
const none = (pool) => ({ pool, source: "none", ageSec: null, windows: [], headroom: null });
const fact = (a, over) => ({ ...a, ...Object.fromEntries(Object.entries(over).map(([k, p]) => [k, { noul: p }])) });

test("rounds to the nearest level and never adjusts it", () => {
  expect(advise(ans(0.4, 0.9), cfg()).level).toBe("basic");
  expect(advise(ans(1.4, 0.9), cfg()).level).toBe("standard");
  expect(advise(ans(1.6, 0.9), cfg()).level).toBe("strong");
});
test("says when Jev is unsure and hands the decision to the agent", () => {
  const a = advise(ans(1.2, 0.3), cfg());
  expect(a.sure).toBe(false); expect(a.notes[0]).toContain("Decide from the facts");
  expect(advise(ans(1.2, 0.85), cfg()).sure).toBe(true);
});
test("a user preference is advice beside the level, not an override", () => {
  const a = advise(ans(0, 1, "review"), cfg());
  expect(a.level).toBe("basic");                                   // a rote count stays basic
  expect(a.notes.join(" ")).toContain("prefers strong for review");
  expect(advise(ans(2, 1, "review"), cfg()).notes).toEqual([]);      // nothing to say when already at the preference
});
test("preferences cover every plausible kind of work", () => {
  const a = advise(ans(1, 1, "implement", 0.1, { implement: 0.5, research: 0.4, docs: 0.1 }), cfg());
  expect(a.notes.join(" ")).toContain("research");
});
test("facts are read as yes, no, or unclear, and unclear ones go back to the agent", () => {
  const a = advise(fact(ans(1, 0.9), { names_location: 0.95, approach_open: 0.1, cause_unknown: 0.5 }), cfg());
  expect(a.facts.names_location.reading).toBe("yes"); expect(a.facts.approach_open.reading).toBe("no");
  expect(a.facts.cause_unknown.reading).toBe("unclear"); expect(a.notes.join(" ")).toContain("routr could not tell from the brief: cause_unknown");
});
test("gaps in the brief are flagged for fixing before it is sent", () => {
  const a = advise(fact(ans(1, 0.9), { states_check: 0.05, standalone: 0.1 }), cfg());
  expect(a.notes.filter((n) => n.startsWith("Fix the brief first")).length).toBe(2);
  expect(advise(fact(ans(1, 0.9), { states_check: 0.95, standalone: 0.95 }), cfg()).notes).toEqual([]);
});
test("the user's default model is passed through, and caller-read headroom is used", () => {
  const c = cfg(); c.subscriptions.cursor = { ...c.subscriptions.cursor, default_model: "some-model", default_effort: "low" };
  const r = rankSubscriptions("basic", [live("claude", 0.3), { pool: "cursor", source: "given by caller", ageSec: 0, windows: [], headroom: 0.97 }], c);
  expect(r.ranked[0]).toMatchObject({ subscription: "cursor", usable: 0.87, usage: "given", your_default: "some-model @ low" });
});
test("high risk is called out", () => {
  const a = advise(ans(0.1, 1, "implement", 0.9), cfg());
  expect(a.high_risk).toBe(true); expect(a.notes.join(" ")).toContain("costly");
});
test("ranks by usable headroom after reserves; assumed usage is labelled", () => {
  const r = rankSubscriptions("basic", [live("claude", 0.6), live("codex", 0.5), none("cursor")], cfg());
  expect(r.ranked.map((x) => x.subscription)).toEqual(["cursor", "claude", "codex"]); // 0.40, 0.35, 0.30
  expect(r.ranked[0].usage).toBe("assumed"); expect(r.most_room).toBe("cursor");
});
test("a subscription is never offered work harder than the user allows", () => {
  const r = rankSubscriptions("strong", [live("claude", 0.3), live("codex", 0.35), none("cursor")], cfg());
  expect(r.most_room).toBe("codex"); expect(r.excluded[0].subscription).toBe("cursor");
});
test("never offers a reserve: all at reserve means no suggestion", () => {
  expect(rankSubscriptions("strong", [live("claude", 0.2), live("codex", 0.2)], cfg()).most_room).toBeNull();
});
test("usage is read per call: a drained subscription drops down the ranking (P9)", () => {
  expect(rankSubscriptions("strong", [live("claude", 0.4), live("codex", 0.9)], cfg()).most_room).toBe("codex");
  expect(rankSubscriptions("strong", [live("claude", 0.4), live("codex", 0.15)], cfg()).most_room).toBe("claude");
});
test("broken or missing config falls back to defaults with a note", () => {
  const bad = `${import.meta.dir}/.bad.json`; writeFileSync(bad, "{ not json");
  for (const path of [bad, "/nonexistent/config.json"]) { const r = loadConfig(path); expect(r.config.fallback_level).toBe("standard"); expect(r.notes.length).toBe(1); }
  const odd = `${import.meta.dir}/.odd.json`; writeFileSync(odd, JSON.stringify({ prefer: { debug: "huge" }, subscriptions: { x: { reserve: 0.3 } } }));
  const r = loadConfig(odd); expect(r.config.prefer.debug).toBeUndefined(); expect(r.config.subscriptions.x.hardest_work).toBe("strong"); expect(r.notes.length).toBe(1);
});

test("launch plans use each harness's measured permissions and model syntax", () => {
  expect(plan({ kind: "claude", model: "sonnet", effort: "medium" }).argv)
    .toEqual(["--dangerously-skip-permissions", "--model", "sonnet", "--effort", "medium"]);
  expect(plan({ kind: "codex", model: "gpt-5.6-sol", effort: "high" }).argv)
    .toEqual(["--yolo", "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=high"]);
  expect(plan({ kind: "cursor", model: "composer-2.5", cursorConfigDir: "/private/config" }))
    .toMatchObject({ executable: "cursor-agent", argv: ["--yolo", "--trust", "--model", "composer-2.5"], env: { CURSOR_CONFIG_DIR: "/private/config" } });
  expect(plan({ kind: "agy", model: "gemini-3.8-flash-low", cwd: "/work" }).argv)
    .toEqual(["--dangerously-skip-permissions", "--add-dir", "/work", "--model", "gemini-3.8-flash-low"]);
});
test("agy rejects separate effort, even when it agrees with the model suffix", () => {
  for (const effort of ["low", "high"]) expect(() => plan({ kind: "agy", model: "gemini-3.8-flash-low", effort, cwd: "/work" })).toThrow("omit --effort");
  expect(() => plan({ kind: "agy", model: "gemini-3.8-flash-low" })).toThrow("--add-dir");
  expect(() => plan({ kind: "cursor", model: "composer-2.5", effort: "low" })).toThrow("no separate --effort");
});
test("a model is required except when only planning; unknown kinds are rejected", () => {
  expect(() => plan({ kind: "claude" })).toThrow("--model is required");
  expect(plan({ kind: "claude", dryRun: true }).warnings).toHaveLength(1);
  expect(() => plan({ kind: "toString", model: "x" })).toThrow("--kind");
});
test("launch prompt preserves the required opening, task with verification, and closing verbatim", () => {
  const task = "TASK\nFix the parser. Work only in /work.\n\nHOW TO VERIFY\nbun test";
  const prompt = composePrompt(task);
  const doc = readFileSync(new URL("../skills/routr/references/orchestrator.md", import.meta.url), "utf8");
  const opening = doc.match(/       You are a routr worker\.[\s\S]*?orchestrator parses\./)[0].trim().replace(/\s*\n\s*/g, " ").replace("<routr skill folder>/references/worker.md", WORKER_GUIDE);
  expect(WORKER_GUIDE.startsWith("/")).toBe(true);
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
    env: { HERDR_ENV: "1" }, now: () => ticks, sleep: async (ms) => { ticks += ms; },
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
  const script = `${import.meta.dir}/../skills/routr/scripts/routr.mjs`;
  const result = Bun.spawnSync(["bun", script, "launch", ...launchArgs, "--timeout", "bad"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString()).state).toBe("failed");
  const version = Bun.spawnSync(["bun", script, "--version"]);
  expect(version.exitCode).toBe(0);
  expect(version.stdout.toString().trim()).toBe(JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")).version);
});

const herdrOK = (result = {}) => ({ ok: true, data: { result } });
const herdrError = (code) => ({ ok: false, data: { error: { code, message: code } } });
const shellInfo = (foreground_processes = [{ pid: 1, cwd: process.cwd() }]) => herdrOK({ process_info: { shell_pid: 1, foreground_processes } });

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
  const script = `${import.meta.dir}/../skills/routr/scripts/routr.mjs`;
  for (const suffix of [["--version"], ["--task", "--version"]]) {
    const r = Bun.spawnSync(["bun", script, "launch", ...launchArgs, ...suffix]);
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
  const root = mkdtempSync(join(import.meta.dir, ".cursor-readiness-"));
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

test("Cursor removes configs on pre-start failure and on worker exit without changing the source", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".cursor-launch-"));
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

test("transport timeouts return a timeout code, even if the subprocess printed JSON", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".herdr-stub-"));
  try {
    const executable = join(root, "herdr");
    writeFileSync(executable, '#!/bin/sh\nprintf \'{"result":{}}\'\nexec sleep 30\n'); chmodSync(executable, 0o755);
    const modulePath = new URL("../skills/routr/scripts/lib/launch.mjs", import.meta.url).href;
    const result = Bun.spawnSync(["bun", "-e", `import { runHerdr } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await runHerdr([], 50)));`],
      { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, data: { error: { code: "timeout" } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const rep = (over = {}, kind = "debug", verdict = "done") => ({ work_type: { choice: kind }, verdict: { choice: verdict },
  ...Object.fromEntries(Object.entries({ states_verification: 0.95, covers_brief: 0.95, admits_gaps: 0.05, symptom_patch: 0.05, out_of_scope: 0.05, ...over }).map(([k, p]) => [k, { noul: p }])) });
test("a clean report gives no reason to send it back, and says the orchestrator's own check decides", () => {
  const r = readReport(rep()); expect(r.flags).toEqual([]); expect(r.next).toContain("your own check");
});
test("a symptom patch, an admitted gap, and a non-done verdict are each flagged", () => {
  expect(readReport(rep({ symptom_patch: 0.92 })).flags.join(" ")).toContain("symptom");
  expect(readReport(rep({ admits_gaps: 0.97 }, "debug", "partial")).flags.length).toBe(2);
  expect(readReport(rep({ states_verification: 0.05 })).headline).toContain("1 reason");
});
test("the symptom-patch answer is ignored on work that is not a fix", () => {
  const r = readReport(rep({ symptom_patch: 0.95 }, "review")); expect(r.flags).toEqual([]); expect(r.checks.symptom_patch).toBeUndefined();
});

test("help table covers every command the CLI dispatches", () => {
  const dispatched = ["subagent", "dispatch", "launch", "doctor", "check", "record", "assess"];
  expect(Object.keys(COMMANDS).sort()).toEqual(dispatched.sort());

  // Every command has a valid description, non-empty synopsis, and flags/args
  for (const name of dispatched) {
    const cmd = COMMANDS[name];
    expect(cmd.name).toBe(name);
    expect(typeof cmd.description).toBe("string");
    expect(cmd.description.length).toBeGreaterThan(10);
    const help = formatCommandHelp(cmd);
    expect(help).toContain(`routr ${name}: ${cmd.description}`);
    expect(help).toContain("--help, -h");
    if (cmd.flags) {
      for (const flag of cmd.flags) {
        expect(flag.name.startsWith("--")).toBe(true);
        expect(typeof flag.description).toBe("string");
        expect(help).toContain(flag.name);
      }
    }
  }

  // launch flags match parseLaunchArgs options
  const launchFlags = COMMANDS.launch.flags.map((f) => f.name.replace(/^--/, ""));
  for (const opt of ["kind", "name", "cwd", "model", "effort", "pane", "direction", "task", "task-file", "trust", "timeout", "dry-run"]) {
    expect(launchFlags).toContain(opt);
  }
  expect(COMMANDS.launch.flags.find((f) => f.name === "--model").required).toBe("required unless --dry-run");

  // Unknown usage string contains every command
  const unknownUsage = formatUnknownUsage();
  for (const name of dispatched) {
    expect(unknownUsage).toContain(`routr ${name}`);
  }

  // Top-level help contains routr description, --version, and all commands
  const topHelp = formatTopLevelHelp();
  expect(topHelp).toContain(DESCRIPTION);
  expect(topHelp).toContain("--version");
  for (const name of dispatched) {
    expect(topHelp).toContain(name);
  }
});

test("top-level help flags and help command print usage and exit 0", () => {
  const script = `${import.meta.dir}/../skills/routr/scripts/routr.mjs`;
  for (const flag of ["--help", "-h", "help"]) {
    const res = Bun.spawnSync(["bun", script, flag]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toBe("");
    const stdout = res.stdout.toString();
    expect(stdout).toContain(DESCRIPTION);
    expect(stdout).toContain("--version");
    for (const cmd of ["subagent", "dispatch", "launch", "doctor", "check", "record", "assess"]) {
      expect(stdout).toContain(cmd);
    }
  }
});

test("command help prints usage for each command and exits 0", () => {
  const script = `${import.meta.dir}/../skills/routr/scripts/routr.mjs`;
  const commands = ["subagent", "dispatch", "launch", "doctor", "check", "record", "assess"];
  for (const cmd of commands) {
    for (const flag of ["--help", "-h"]) {
      const res = Bun.spawnSync(["bun", script, cmd, flag]);
      expect(res.exitCode).toBe(0);
      expect(res.stderr.toString()).toBe("");
      const stdout = res.stdout.toString();
      expect(stdout).toContain(`routr ${cmd}: ${COMMANDS[cmd].description}`);
      expect(stdout).toContain(`usage: routr ${cmd}`);
      expect(stdout).toContain("--help, -h");
    }
  }

  // routr launch --help works without HERDR_ENV, does not touch herdr, and exits 0
  const cleanEnv = { ...process.env };
  delete cleanEnv.HERDR_ENV;
  const launchRes = Bun.spawnSync(["bun", script, "launch", "--help"], { env: cleanEnv });
  expect(launchRes.exitCode).toBe(0);
  expect(launchRes.stderr.toString()).toBe("");
  expect(launchRes.stdout.toString()).toContain("routr launch: start a worker");
  expect(launchRes.stdout.toString()).toContain("--kind <kind>");
  expect(launchRes.stdout.toString()).toContain("--model <id>");
  expect(launchRes.stdout.toString()).toContain("required unless --dry-run");

  // routr record --help exits 0 without reading stdin
  const recordRes = Bun.spawnSync(["bun", script, "record", "--help"], { stdin: "ignore" });
  expect(recordRes.exitCode).toBe(0);
  expect(recordRes.stderr.toString()).toBe("");
  expect(recordRes.stdout.toString()).toContain("routr record: append what you chose");
  expect(recordRes.stdout.toString()).toContain("--subscription <name>");
});

test("a brief containing --help as a separate word is routed as a brief, not as help", () => {
  const script = `${import.meta.dir}/../skills/routr/scripts/routr.mjs`;
  for (const cmd of ["subagent", "dispatch"]) {
    const res = Bun.spawnSync(["bun", script, cmd, "add", "--help", "to", "the", "CLI"]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toBe("");
    const data = JSON.parse(res.stdout.toString());
    expect(data.mode).toBe(cmd);
    expect(data.brief_chars).toBe("add --help to the CLI".length);
  }
});

test("unrecognized mode prints usage from table to stderr and exits 2", () => {
  const script = `${import.meta.dir}/../skills/routr/scripts/routr.mjs`;
  for (const args of [["unknown-mode"], []]) {
    const res = Bun.spawnSync(["bun", script, ...args]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout.toString()).toBe("");
    const stderr = res.stderr.toString();
    expect(stderr).toContain("usage: routr subagent");
    for (const cmd of ["dispatch", "launch", "doctor", "check", "record", "assess"]) {
      expect(stderr).toContain(`routr ${cmd}`);
    }
  }
});

test("the reserve shrinks as the window runs out, and each window is shown", () => {
  const c = { ...cfg(), now: NOW };
  const early = rankSubscriptions("basic", [{ pool: "claude", source: "t", ageSec: 1, headroom: 0.39, windows: [win(61, 160)] }], c).ranked.find((x) => x.subscription === "claude");
  const late = rankSubscriptions("basic", [{ pool: "claude", source: "t", ageSec: 1, headroom: 0.39, windows: [win(61, 28)] }], c).ranked.find((x) => x.subscription === "claude");
  expect(early.usable).toBe(0.15);                       // 0.39 left − 0.25 × (160/168)
  expect(late.usable).toBe(0.35);                        // 0.39 left − 0.25 × (28/168): a day from the reset, use it
  expect(late.windows[0]).toMatchObject({ window: "seven_day", used_pct: 61, resets_in_h: 28, left: 0.39, reserve_now: 0.04 });
});
test("the tightest window decides", () => {
  const c = { ...cfg(), now: NOW };
  const r = rankSubscriptions("basic", [{ pool: "claude", source: "t", ageSec: 1, headroom: 0.05, windows: [win(20, 100), { ...win(95, 1, 300), name: "five_hour" }] }], c).ranked.find((x) => x.subscription === "claude");
  expect(r.usable).toBe(0);                              // 5% left in the five-hour window − 0.25 × (1/5) reserve
});

test("worth a worker: tiny work stays with the agent, a user decision comes first, independent pieces are split", () => {
  expect(advise(fact(ans(0, 1), { tiny: 0.95 }), cfg()).worker.suggestion).toBe("do it yourself");
  expect(advise(fact(ans(1, 1), { tiny: 0.95, needs_user: 0.9 }), cfg()).worker.suggestion).toBe("settle it with the user first");
  expect(advise(fact(ans(1, 1), { separable: 0.9, tiny: 0.1 }), cfg()).worker.suggestion).toBe("split it across workers");
  expect(advise(fact(ans(1, 1), { tiny: 0.5 }), cfg()).worker.suggestion).toBe("worth a worker");
});

test("the version inside the skill matches the plugin manifest (the manifest is not installed with the skill)", async () => {
  const { ROUTR_VERSION } = await import("../skills/routr/scripts/lib/version.mjs");
  const { readFileSync } = await import("node:fs");
  expect(JSON.parse(readFileSync(`${import.meta.dir}/../.claude-plugin/plugin.json`, "utf8")).version).toBe(ROUTR_VERSION);
});
