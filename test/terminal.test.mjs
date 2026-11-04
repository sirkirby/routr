// Workers in a herdr-core terminal: what launch asks of hc, what it answers, the runner and its environment, and what
// cleanup and the worker commands do with such a worker. Fakes only: no hc, no herdr-app and no harness runs here.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { launch } from "../src/lib/launch.mjs";
import { cleanup } from "../src/lib/cleanup.mjs";
import { sendCommand, stopCommand, waitCommand, workersCommand } from "../src/lib/workers.mjs";
import { watchCommand } from "../src/lib/watch.mjs";
import { hold } from "../src/lib/headless.mjs";
import { firstMessage, reportToLead, runRecord, runWorker as runner } from "../src/lib/backend-terminal.mjs";
import { ADAPTERS } from "../src/lib/headless.mjs";
import { HARNESSES, KINDS, plan, terminalPlan } from "../src/lib/harnesses.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { LaunchIndex } from "../src/lib/launch-index.mjs";
import { runDir } from "../src/lib/worker-record.mjs";
import { configLocations, savedConfigLocations, start as runtimeStart, startOptions, terminalEnv } from "../src/lib/runtime.mjs";
import { cfg, cliEnv, fakeExecutable, scratch, SCRIPT } from "./helpers.mjs";

// bun test runs every file in one process, in an order that differs by platform, so a test here has a home of its own:
// what it writes (a run folder, Cursor's config) reaches no other file, and what another left does not reach it.
const HOME_BEFORE = process.env.HOME;
beforeEach(() => { process.env.HOME = process.env.USERPROFILE = scratch("terminal-home"); });
afterAll(() => { process.env.HOME = process.env.USERPROFILE = HOME_BEFORE; });
const recordOf = (name = "w1") => JSON.parse(readFileSync(join(runDir(name), "worker.json"), "utf8"));
const runWorker = (name, deps) => runner(runDir(name), recordOf(name).id, deps);

const SECRET = "a brief only the worker may see, long enough to be recognised anywhere it is quoted";
const LEAD = { address: "t3", name: "lead", labels: { "herdr.space": "sp1" } };
// `hc` and `herdr-app`, answering in core's schema (hc 0.1.17). `sees` is what `get` says of the worker's terminal, in
// order, the last repeating; `over` replaces any answer by its word.
const fakeHc = ({ sees = [{ status: { app: "x", state: "working" }, turn: 0 }], over = {}, name = "w1" } = {}) => {
  const calls = []; let seen = 0;
  const run = async (cmd, args, ms) => {
    calls.push({ cmd, args, ms });
    const a = over[args[0]];
    if (a !== undefined) { const v = typeof a === "function" ? a(args, calls) : a; if (v !== undefined) return v; }
    if (cmd === "herdr-app") return { code: 0, out: "" };
    if (args[0] === "get" && args[1] === "t3") return { code: 0, out: JSON.stringify(LEAD) };
    // The label launch set, as hc keeps it, read from the record; `sees` may say otherwise.
    if (args[0] === "get") { const t = sees[Math.min(seen++, sees.length - 1)]; return { code: 0, out: JSON.stringify({ address: "t9", name, state: "live", labels: existsSync(join(runDir("w1"), "worker.json")) ? { "routr.worker": recordOf().id } : {}, ...t }) }; }
    if (args[0] === "run") return { code: 0, out: JSON.stringify({ address: "t9", name }) };
    if (args[0] === "read") return { code: 0, out: "the screen\n" };
    return { code: 0, out: "{}" };
  };
  return { run, calls, words: () => calls.filter((c) => c.cmd === "hc").map((c) => c.args[0]) };
};
const SELF = (a) => ["/bin/routr", ...a];
const LEAD_ENV = { HC_TERMINAL_ID: "t3", HC_TERMINAL_SOCKET: "/lead.sock", HC_SCOPE: "lead-scope" };
const fixture = (kind = "claude", { task = SECRET, extra = [], name = "w1", env = {}, hc = fakeHc({ name }), timeout, ...deps } = {}) => {
  const dir = scratch("terminal"), file = join(dir, "task.md"), advice = join(dir, "advice.json");
  writeFileSync(file, task); writeFileSync(advice, JSON.stringify({ mode: "dispatch", id: "abc12345", brief_sha: briefSha(task), fallback: true }));
  let clock = 0;
  const args = ["--kind", kind, "--name", name, "--model", "m", "--cwd", dir, "--task-file", file, "--advice", advice, ...(timeout ? ["--timeout", String(timeout)] : []), ...extra];
  return { dir, hc, args, go: () => launch(args, { env: { ...LEAD_ENV, ...env }, hc: hc.run, self: SELF, ready: async () => null, settings: () => cfg(), models: async () => ["m"], sleep: async () => {}, now: () => (clock += 100), ...deps }) };
};
// A Cursor private copy needs ~/.cursor/cli-config.json, under this run's scratch home.
const cursorHome = () => { const d = join(process.env.HOME, ".cursor"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "cli-config.json"), "{}"); };
const noted = (r) => r.next.map((n) => `${n.why} ${n.template ?? (n.argv ?? []).join(" ")}`).join("\n");

test("each harness's differences in a core terminal are data: its flags, and how it takes a first message", () => {
  const argv = (kind) => terminalPlan({ kind, model: "m", cwd: "/w" }, "the pointer").argv;
  expect(argv("claude")).toEqual(["--dangerously-skip-permissions", "--model", "m", "the pointer"]);
  expect(argv("codex")).toEqual(["--no-daemon", "--yolo", "--dangerously-bypass-hook-trust", "-c", "check_for_update_on_startup=false", "-m", "m", "the pointer"]);
  expect(argv("cursor")).toEqual(["--yolo", "--trust", "--model", "m", "the pointer"]);
  expect(argv("agy")).toEqual(["--dangerously-skip-permissions", "--add-dir", "/w", "--model", "m", "-i", "the pointer"]);
  expect(argv("kiro")).toEqual(["--v3", "chat", "--trust-all-tools", "--model", "m", "the pointer"]);
  expect(KINDS.filter((k) => HARNESSES[k].noStatus)).toEqual(["cursor"]);
  // Only Codex's flag is the core terminal's alone: a pane starts Codex without it, and Kiro with --v3 too.
  expect(plan({ kind: "codex", model: "m" }).argv).not.toContain("--no-daemon");
  expect(plan({ kind: "kiro", model: "m" }).argv.slice(0, 3)).toEqual(["--v3", "chat", "--trust-all-tools"]);
  // Its V3 screen ignores --trust-tools (kiro-cli 3.0.0), and the person's own trust decision is never answered for them.
  for (const kind of [undefined, false]) expect(plan({ kind: "kiro", model: "m", ...(kind === false ? { interactive: false } : {}) }).argv).not.toContain("--trust-workspace");
  expect(plan({ kind: "kiro", model: "m" }).argv).not.toContain("--trust-tools=*");
});

test("Kiro's headless start stays its ACP mode, with neither --v3 nor chat, and a model named chat survives it", () => {
  expect(ADAPTERS.kiro.argv({ model: "m" })).toEqual(["acp", "--trust-tools=*", "--model", "m"]);
  expect(ADAPTERS.kiro.argv({ model: "chat" })).toEqual(["acp", "--trust-tools=*", "--model", "chat"]);
});

test("in the app a worker gets a tab of its own, running routr's runner, with its task in an owner-only file and in no argv or output", async () => {
  const f = fixture(), r = await f.go();
  expect([r.ok, r.state, r.pane]).toEqual([true, "prompted", null]);
  expect(r.headline).toBe("routr: w1 (claude) took its task in terminal t9");
  const run = f.hc.calls.find((c) => c.args[0] === "run").args, tab = run[run.indexOf("--label") + 3];
  expect(run.slice(0, run.indexOf("--label"))).toEqual(["run", "--bg", "--json", "--name", "w1", "--cwd", r.cwd, "--outlive-parent", "--no-notify"]);
  expect(run).toContain("herdr.space=sp1");
  expect(tab).toMatch(/^herdr\.tab=routr-[a-f0-9]{32}$/);
  const id = recordOf().id;
  expect(run).toContain(`routr.worker=${id}`);
  // The folder by its path, and the record's id to check there: the terminal's HOME may not be this one.
  expect(run.slice(run.indexOf("--"))).toEqual(["--", "/bin/routr", "workers", "--run", runDir("w1"), "--id", id]);
  expect(run).not.toContain("--rm"); // what it finished with stays to read until cleanup
  expect(f.hc.calls.find((c) => c.cmd === "herdr-app").args).toEqual(["do", "tab.rename", "--id", tab.slice("herdr.tab=".length), "--name", "w1"]);
  // What launch answers, and its record.
  expect(r.worker).toEqual({ name: "w1", backend: "terminal", run: runDir("w1"), terminal: "t9" });
  const w = JSON.parse(readFileSync(join(runDir("w1"), "worker.json"), "utf8"));
  expect([w.backend, w.terminal, w.terminal_name, w.kind, w.model]).toEqual(["terminal", "t9", "w1", "claude", "m"]);
  // The prompt: whole, wrapped, owner-only, and nowhere else.
  const file = join(runDir("w1"), "prompt.md"), prompt = readFileSync(file, "utf8");
  expect(prompt).toStartWith("You are a routr worker.");
  expect(prompt).toContain(SECRET);
  expect(prompt).toEndWith("Finish with the report block from the worker guide, starting with the line `VERDICT: done | partial | blocked`.");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(r.prompt_chars).toBe(prompt.length);
  expect(r.start.argv.at(-1)).toBe(firstMessage(file));
  expect(r.start.argv.at(-1)).not.toContain("brief only");
  for (const text of [JSON.stringify(r), JSON.stringify(f.hc.calls), readFileSync(join(runDir("w1"), "worker.json"), "utf8")]) expect(text).not.toContain("brief only the worker");
  // A person follows it by its tab, the lead with hc, and it ends with routr.
  const steps = noted(r);
  expect(steps).toContain("hc wait t9");
  expect(steps).toContain("A turn above 0");
  expect(steps).toContain("hc read t9");
  expect(steps).toContain("hc send t9");
  expect(r.next.find((n) => n.argv?.[1] === "cleanup").argv).toEqual(["routr", "cleanup", "--worker", "w1"]);
  expect(r.steps.map((s) => s.step)).toEqual(["reserve", "terminal", "prompt"]);
});

test("off the app there are no app labels to give and no tab to name; it still carries the worker's id, and a terminal is started", async () => {
  const f = fixture("claude", { hc: fakeHc({ over: { get: (a) => (a[1] === "t3" ? { code: 0, out: JSON.stringify({ address: "t3", labels: {} }) } : undefined) } }) });
  const r = await f.go();
  expect(r.state).toBe("prompted");
  const run = f.hc.calls.find((c) => c.args[0] === "run").args;
  expect(run.filter((a) => a === "--label").length).toBe(1);
  expect(run).toContain(`routr.worker=${recordOf().id}`);
  expect(f.hc.calls.filter((c) => c.cmd === "herdr-app")).toEqual([]);
});

test("a name hc refuses gets one more try with the worker's id, and the record says the name it got", async () => {
  let tries = 0;
  const f = fixture("claude", { hc: fakeHc({ name: "other", over: { run: () => (++tries === 1 ? { code: 1, out: "" } : undefined) } }) });
  // Whatever its id is, `get` must answer the name it was given.
  const r = await f.go();
  expect(r.state).toBe("prompted");
  const names = f.hc.calls.filter((c) => c.args[0] === "run").map((c) => c.args[c.args.indexOf("--name") + 1]);
  expect(names[0]).toBe("w1");
  expect(names[1]).toMatch(/^w1-[a-f0-9]{8}$/);
  expect(JSON.parse(readFileSync(join(runDir("w1"), "worker.json"), "utf8")).terminal_name).toBe(names[1]);
});

test("started means status working, or a turn already gone by; idle at turn 0 is only not started yet", async () => {
  for (const sees of [[{ status: null, turn: 0 }, { status: { state: "idle" }, turn: 0 }, { status: { state: "working" }, turn: 0 }], [{ status: { state: "done" }, turn: 1 }], [{ status: { state: "idle" }, turn: 2 }], [{ status: "working", turn: 0 }]]) {
    const f = fixture("claude", { hc: fakeHc({ sees }) }), r = await f.go();
    expect(r.state).toBe("prompted");
    expect(f.hc.words().filter((w) => w === "get").length).toBe(sees.length + 1);
    rmSync(runDir("w1"), { recursive: true, force: true });
  }
});

test("a harness that reports no status counts once its process runs, and is told how to report; those that report are told nothing", async () => {
  cursorHome();
  // The runner's own record is what says its process runs: written here as it writes it.
  const seen = fakeHc({ sees: [{ status: null, turn: 0 }] }), real = seen.run;
  let gets = 0;
  const hc = { ...seen, run: async (cmd, args, ms) => { if (args[0] === "get" && args[1] === "t9" && ++gets === 2) writeFileSync(join(runDir("w1"), "run.json"), JSON.stringify({ pid: 1, harness_pid: 2 })); return real(cmd, args, ms); } };
  const c = fixture("cursor", { hc });
  const r = await c.go();
  expect(r.state).toBe("prompted");
  expect(gets).toBe(2);
  const prompt = readFileSync(join(runDir("w1"), "prompt.md"), "utf8");
  expect(prompt.endsWith(reportToLead("t3"))).toBe(true);
  expect(prompt).toContain("hc send t3");
  expect(noted(r)).toContain("reports no status");
  expect(r.next.filter((n) => n.argv?.[1] === "wait")).toEqual([]);
  // Its private config is the run folder's.
  expect(existsSync(join(runDir("w1"), "cursor-config", "cli-config.json"))).toBe(true);
  rmSync(runDir("w1"), { recursive: true, force: true });
  await fixture("claude").go();
  expect(readFileSync(join(runDir("w1"), "prompt.md"), "utf8")).not.toContain("hc send");
});

test("a blocked start comes back as needs_input, with the screen withheld as the worker has its task, and routr answers nothing", async () => {
  const f = fixture("agy", { hc: fakeHc({ sees: [{ status: { state: "blocked", kind: "question" }, turn: 0 }] }) });
  const r = await f.go();
  expect([r.ok, r.state, r.error]).toEqual([false, "needs_input", undefined]);
  expect(r.needs_input.why).toBe("Antigravity is waiting at a question before it can start.");
  expect(r.needs_input.hc).toEqual({ state: "blocked", kind: "question" });
  expect(r.needs_input.note).toContain("Antigravity asks whether to trust");
  expect(r.screen).toStartWith("withheld:");
  expect(r.headline).toBe("routr: w1 needs input in terminal t9: Antigravity is waiting at a question before it can start.");
  expect(f.hc.words()).not.toContain("keys");
  expect(f.hc.words()).not.toContain("send");
  expect(r.next[0].argv).toEqual(["hc", "read", "t9", "--lines", "200"]);
  expect(noted(r)).toContain("hc keys t9 <keys>");
  expect(noted(r)).toContain("default answer can be");
  expect(noted(r)).toContain("do not launch it again");
  expect(r.worker.terminal).toBe("t9");
  expect(r.next.find((n) => n.argv?.[1] === "cleanup").argv).toEqual(["routr", "cleanup", "--worker", "w1"]);
});

test("Kiro's trust-all-tools warning, reported blocked, is needs_input and is never answered", async () => {
  const f = fixture("kiro", { hc: fakeHc({ sees: [{ status: { state: "blocked" }, turn: 0 }] }) }), r = await f.go();
  expect(r.state).toBe("needs_input");
  expect(r.start.argv.slice(0, 3)).toEqual(["--v3", "chat", "--trust-all-tools"]);
  expect(r.start.argv).not.toContain("--trust-workspace");
  expect(r.needs_input.note).toContain("Yes, and don't ask again");
  expect(r.needs_input.note).toContain("for the person to answer");
  expect(f.hc.words()).not.toContain("keys");
});

test("no text from the terminal reaches launch's answer: a short brief a startup screen echoes stays out, at every way it stops", async () => {
  const brief = "customer-pin=7391", read = { code: 0, out: `${brief}\n` };
  const stops = [["needs_input", [{ status: { state: "blocked" }, turn: 0 }], {}], ["needs_input", [{ status: null, turn: 0 }], { timeout: 1000 }],
    ["failed", [{ state: "finished", status: null, exit_code: 3 }], {}], ["failed", [{ status: { state: "error" }, turn: 0 }], {}]];
  for (const [state, sees, over] of stops) {
    const f = fixture("claude", { task: brief, hc: fakeHc({ sees, over: { read } }), ...over }), r = await f.go();
    expect(r.state).toBe(state);
    expect(JSON.stringify(r)).not.toContain(brief);
    expect(r.screen).toStartWith("withheld:");
    expect(f.hc.words()).not.toContain("read");
    rmSync(runDir("w1"), { recursive: true, force: true });
  }
});

test("a harness that says nothing within --timeout is needs_input, not started and not failed: Kiro at its trust question", async () => {
  const f = fixture("kiro", { timeout: 1000, hc: fakeHc({ sees: [{ status: null, turn: 0 }] }) }), r = await f.go();
  expect([r.state, r.needs_input.hc]).toEqual(["needs_input", { state: null }]);
  expect(r.needs_input.why).toContain("has not reported working within the timeout");
  expect(r.needs_input.note).toContain("whether to trust this folder");
  expect(r.screen).toStartWith("withheld:");
  expect(r.start.argv.slice(0, 2)).toEqual(["--v3", "chat"]);
  expect(f.hc.words()).not.toContain("keys");
});

test("a refusal from hc about the lead's own terminal stops the launch before anything is written", async () => {
  for (const [answer, why] of [[{ code: 1, out: "" }, "hc refused"], [null, "hc did not answer"], [{ code: 0, out: "not json" }, "hc gave an answer"]]) {
    const f = fixture("claude", { hc: fakeHc({ over: { get: answer } }) }), r = await f.go();
    expect([r.ok, r.state]).toEqual([false, "failed"]);
    expect(r.error).toContain(why);
    expect(existsSync(runDir("w1"))).toBe(false);
    expect(f.hc.words()).toEqual(["get"]);
    expect(r.next.filter((n) => n.argv?.[1] === "cleanup")).toEqual([]);
  }
});

const repo = (dir) => { const git = (...a) => Bun.spawnSync(["git", "-C", dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); git("init", "-q"); writeFileSync(join(dir, "a.txt"), "a"); git("add", "a.txt"); git("commit", "-qm", "a"); return git; };

test("a refused hc run takes back the run folder, the worktree and its branch; no answer keeps them, for cleanup to finish", async () => {
  const f = fixture("claude", { extra: ["--worktree", "wt-a"], hc: fakeHc({ over: { run: { code: 1, out: "" } } }) }), git = repo(f.dir);
  const r = await f.go();
  expect([r.state, r.error]).toEqual(["failed", "hc refused to start the worker's terminal (refused); nothing was started, and what launch made is gone"]);
  expect(existsSync(runDir("w1"))).toBe(false);
  expect(r.worker).toBeNull();
  expect(git("rev-parse", "--verify", "--quiet", "refs/heads/wt-a").exitCode).not.toBe(0);
  expect(r.worktree.path && existsSync(r.worktree.path)).toBe(false);
  const lost = fixture("claude", { hc: fakeHc({ over: { run: null } }) }), u = await lost.go();
  expect(u.state).toBe("failed");
  expect(u.error).toContain("whether it runs is not known");
  expect(existsSync(join(runDir("w1"), "worker.json"))).toBe(true);
  expect(u.worker.terminal).toBeNull();
  expect(noted(u)).toContain("hc ls");
  expect(u.next.find((n) => n.argv?.[1] === "cleanup").argv).toEqual(["routr", "cleanup", "--worker", "w1"]);
});

test("a harness that ends before it starts fails the launch, with what its terminal showed and the worker kept for cleanup", async () => {
  const r = await fixture("claude", { hc: fakeHc({ sees: [{ state: "finished", status: null, exit_code: 3 }] }) }).go();
  expect(r.state).toBe("failed");
  expect(r.error).toContain("Claude Code ended before it started the task (exit code 3)");
  expect(r.screen).toStartWith("withheld:");
  expect(r.next.map((n) => n.argv)).toContainEqual(["hc", "read", "t9", "--lines", "200"]);
  expect(existsSync(runDir("w1"))).toBe(true);
  const gone = await fixture("claude", { name: "w2", hc: fakeHc({ name: "w2", over: { get: (a) => (a[1] === "t9" ? { code: 1, out: "", err: "no terminal t9" } : undefined) } }) }).go();
  expect(gone.error).toContain("its terminal is gone");
});

test("launch refuses, before anything is written: a pane, no task, a sandbox, a name taken, a harness turned off or signed out", async () => {
  const refused = async (o, kind = "claude") => { const r = await fixture(kind, o).go(); expect([r.ok, r.state]).toEqual([false, "failed"]); return r.error; };
  expect(await refused({ extra: ["--pane", "w1:p1"] })).toBe("--pane needs herdr; in a herdr-core terminal a worker runs in a terminal of its own, with no pane");
  expect(await refused({ extra: ["--direction", "right"] })).toContain("--direction needs herdr");
  expect(await refused({ env: { SANDBOX_RUNTIME: "1" } })).toContain("Claude Code's Bash sandbox");
  expect(await refused({ settings: () => ({ subscriptions: { claude: { enabled: false } } }) })).toContain("turned off");
  expect(await refused({ ready: async () => "run `claude auth login`" })).toContain("cannot take work");
  const f = fixture("claude"), noTask = await launch(["--kind", "claude", "--name", "w1", "--model", "m", "--cwd", f.dir], { env: LEAD_ENV, hc: f.hc.run, self: SELF, ready: async () => null, settings: () => cfg() });
  expect(noTask.error).toBe("in a herdr-core terminal a worker starts with its task: pass --task-file (or --task) and --advice");
  expect(f.hc.calls).toEqual([]);
  expect(existsSync(runDir("w1"))).toBe(false);
  mkdirSync(runDir("w1"), { recursive: true });
  expect(await refused({})).toContain("a worker named w1 exists");
});

test("a Kiro id its own list does not have is refused before hc is asked", async () => {
  const f = fixture("kiro", { models: async () => ["other"] }), r = await f.go();
  expect(r.error).toContain("does not list --model m");
  expect(f.hc.calls).toEqual([]);
});

// ---- the environment ---------------------------------------------------------------------------------------------------
const CORE = { PATH: "/core/bin", HOME: "/core/home", HC_SESSION: "s1", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "core-lead", TRACEPARENT: "00-core", HERDR_ENV: "1", OPENAI_API_KEY: "core-key",
  HC_TERMINAL_ID: "t9", HC_TERMINAL_SOCKET: "/core/t9.sock", HC_SCOPE: "worker-scope", CODEX_HOME: "/core/codex" };
const CALLER = { ...LEAD_ENV, PATH: "/lead/bin", CODEX_HOME: "/lead/codex", CLAUDE_CONFIG_DIR: "/lead/claude", CURSOR_CONFIG_DIR: "/lead/cursor", XDG_CONFIG_HOME: "/lead/xdg", ANTHROPIC_API_KEY: "lead-key", CLAUDE_CODE_OAUTH_TOKEN: "lead-token", SOME_LEAD_SETTING: "x",
  TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };

test("the runner's environment: the core's, without a lead's identity, its own terminal, and only what launch saved", () => {
  const saved = { carriers: { TRACEPARENT: CALLER.TRACEPARENT }, config: configLocations(CALLER) };
  expect(saved.config).toEqual({ CODEX_HOME: "/lead/codex", CLAUDE_CONFIG_DIR: "/lead/claude", CURSOR_CONFIG_DIR: "/lead/cursor", XDG_CONFIG_HOME: "/lead/xdg" });
  const env = terminalEnv({ ...saved, adapter: { CLAUDE_CODE_SUBAGENT_MODEL: "s" } }, CORE);
  expect(env).toEqual({ PATH: "/core/bin", HOME: "/core/home", HC_SESSION: "s1", OPENAI_API_KEY: "core-key", HC_TERMINAL_ID: "t9", HC_TERMINAL_SOCKET: "/core/t9.sock", HC_SCOPE: "worker-scope",
    TRACEPARENT: CALLER.TRACEPARENT, CODEX_HOME: "/lead/codex", CLAUDE_CONFIG_DIR: "/lead/claude", CURSOR_CONFIG_DIR: "/lead/cursor", XDG_CONFIG_HOME: "/lead/xdg", CLAUDE_CODE_SUBAGENT_MODEL: "s" });
  // Cursor's private config beats the caller's; a caller who set none leaves the core's, and carriers it saved none of are none.
  expect(terminalEnv({ carriers: {}, config: saved.config, adapter: { CURSOR_CONFIG_DIR: "/run/cursor-config" } }, CORE).CURSOR_CONFIG_DIR).toBe("/run/cursor-config");
  const bare = terminalEnv({ carriers: {}, config: {} }, CORE);
  expect(bare.CODEX_HOME).toBe("/core/codex");
  expect(bare).not.toHaveProperty("TRACEPARENT");
  // Exact names, checked again: anything else saved is ignored, and so is a value that is no path.
  expect(savedConfigLocations({ CODEX_HOME: "/a", ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: 3, XDG_DATA_HOME: "bad\nvalue", XDG_STATE_HOME: "" })).toEqual({ CODEX_HOME: "/a" });
  expect(terminalEnv({ carriers: { TRACEPARENT: "x\ny", OTHER: "z" }, config: "not an object" }, { PATH: "/p" })).toEqual({ PATH: "/p" });
  // Windows names differ by case only: one variable, the later layer's.
  const win = terminalEnv({ carriers: {}, config: { CODEX_HOME: "/a" } }, { codex_home: "/core", hc_terminal_id: "t9" }, { platform: "win32" });
  expect(win).toEqual({ HC_TERMINAL_ID: "t9", CODEX_HOME: "/a" });
});

test("a harness starts where the terminal is, on its stdio, with a caller and a core whose environments differ; what launch saved holds no key", async () => {
  cursorHome();
  const f = fixture("cursor", { env: CALLER, hc: fakeHc({ sees: [{ status: null, turn: 1 }] }) }), r = await f.go();
  expect(r.state).toBe("prompted");
  const record = readFileSync(join(runDir("w1"), "worker.json"), "utf8");
  for (const leak of ["lead-key", "lead-token", "SOME_LEAD_SETTING", "/lead/bin", "lead.sock", "lead-scope"]) expect(record).not.toContain(leak);
  expect(JSON.parse(record).config.CURSOR_CONFIG_DIR).toBe("/lead/cursor");
  // Output says which, never where.
  expect(r.start.env).toMatchObject({ TRACEPARENT: "<forwarded>", CODEX_HOME: "<forwarded>", CURSOR_CONFIG_DIR: "<forwarded>" });
  expect(JSON.stringify(r)).not.toContain("/lead/codex");
  const started = [], child = new EventEmitter(); child.pid = 77;
  const running = runWorker("w1", { env: CORE, begin: (...a) => { started.push(a); return child; }, on: () => {}, say: () => {} });
  const [exe, argv, opts] = started[0];
  expect(exe).toBe("cursor-agent");
  expect(argv).toEqual(["--yolo", "--trust", "--model", "m", firstMessage(join(runDir("w1"), "prompt.md"))]);
  expect(JSON.stringify(argv)).not.toContain("only the worker");
  expect([opts.stdio, opts.cwd, opts.visible]).toEqual(["inherit", r.cwd, true]);
  expect(opts.env.CURSOR_CONFIG_DIR).toBe(join(runDir("w1"), "cursor-config"));
  expect(opts.env.CODEX_HOME).toBe("/lead/codex");
  expect([opts.env.HC_TERMINAL_ID, opts.env.HC_TERMINAL_SOCKET, opts.env.HC_SCOPE]).toEqual(["t9", "/core/t9.sock", "worker-scope"]);
  expect(opts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(opts.env).not.toHaveProperty("CLAUDECODE");
  expect(opts.env.PATH).toBe("/core/bin");
  child.emit("exit", 5, null);
  expect(await running).toBe(5);
  const ran = runRecord("w1").value;
  expect([ran.harness_pid, ran.exit_code, ran.signal, typeof ran.ended_at]).toEqual([77, 5, null, "string"]);
  if (process.platform !== "win32") expect(statSync(join(runDir("w1"), "run.json")).mode & 0o777).toBe(0o600);
});

test("the runner stays until the harness has gone, passes on hc kill's signals, starts once, and only for a terminal worker", async () => {
  await fixture("claude").go();
  const child = new EventEmitter(), kills = [], handlers = {}, said = []; child.pid = 7; child.kill = (s) => kills.push(s);
  const running = runWorker("w1", { env: {}, begin: () => child, on: (s, fn) => { handlers[s] = fn; }, say: (s) => said.push(s) });
  handlers.SIGHUP(); handlers.SIGTERM(); handlers.SIGINT();
  expect(kills).toEqual(["SIGHUP", "SIGTERM"]);
  expect(await runWorker("w1", { env: {}, begin: () => { throw new Error("a second start"); }, on: () => {}, say: (s) => said.push(s) })).toBe(2);
  expect(said).toEqual(["routr: w1 was started before; nothing was started now"]);
  child.emit("exit", null, "SIGTERM");
  expect(await running).toBe(128 + 15);
  expect(runRecord("w1").value.signal).toBe("SIGTERM");
  expect(await runner(runDir("nobody"), "x", { say: (s) => said.push(s) })).toBe(2);
  expect(said.at(-1)).toBe(`routr: ${runDir("nobody")} does not hold the terminal worker launch started; nothing was started`);
});

test("a test here runs in a home of its own, so nothing of it reaches another file sharing this process", () => {
  expect(process.env.HOME).not.toBe(HOME_BEFORE);
  expect(runDir("w1").startsWith(process.env.HOME)).toBe(true);
});

test("tests never reach the real hc: the preload clears a core terminal's names and stubs both commands", async () => {
  for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"]) expect(process.env[k]).toBeUndefined();
  if (process.platform !== "win32") {
    expect(Bun.which("hc", { PATH: process.env.PATH })).toContain(join("fixtures", "no-herdr"));
    expect(Bun.which("herdr-app", { PATH: process.env.PATH })).toContain(join("fixtures", "no-herdr"));
  }
});

test("the runner finds its worker by the folder launch passed, under another HOME, and starts nothing for another worker's id", async () => {
  const dir = scratch("other-home"), bin = join(dir, "bin"), out = join(dir, "ran.txt");
  mkdirSync(bin);
  await fixture("claude").go();
  const { id } = recordOf(), folder = runDir("w1");
  fakeExecutable(bin, "claude", `require("node:fs").writeFileSync(${JSON.stringify(out)}, process.argv.slice(2).join(" ")); process.exit(4);`);
  const go = (asked) => Bun.spawnSync([process.execPath, SCRIPT, "workers", "--run", folder, "--id", asked], { env: cliEnv(join(dir, "core-home"), { PATH: `${bin}${delimiter}${dirname(process.execPath)}` }), stdout: "ignore", stderr: "ignore" });
  expect(go("not-its-id").exitCode).toBe(2);
  expect(existsSync(out)).toBe(false);
  expect(go(id).exitCode).toBe(4);
  expect(readFileSync(out, "utf8")).toContain(firstMessage(join(folder, "prompt.md")));
  expect(JSON.parse(readFileSync(join(folder, "run.json"), "utf8")).exit_code).toBe(4);
}, 20000);

test("a harness that cannot start is said in fixed words, recorded for launch, and exits 127", async () => {
  await fixture("claude").go();
  const child = new EventEmitter(), said = [];
  const running = runWorker("w1", { env: {}, begin: () => child, on: () => {}, say: (s) => said.push(s) });
  child.emit("error", Object.assign(new Error("spawn claude ENOENT at /secret/path"), { code: "ENOENT" }));
  expect(await running).toBe(127);
  expect(said).toEqual(["routr: Claude Code did not start (ENOENT)"]);
  expect(runRecord("w1").value.not_started).toBe("ENOENT");
  await fixture("claude", { name: "w2" }).go();
  expect(await runWorker("w2", { env: {}, begin: () => { throw Object.assign(new Error("x"), { code: "EACCES" }); }, on: () => {}, say: () => {} })).toBe(127);
});

test("a runner's start keeps its console on Windows; every other start stays hidden", () => {
  expect(startOptions({ stdio: "inherit", visible: true })).toEqual({ stdio: "inherit", windowsHide: false });
  expect(startOptions({ stdio: "ignore" })).toEqual({ stdio: "ignore", windowsHide: true });
  expect(startOptions({ windowsHide: false })).toEqual({ windowsHide: true });
  let seen; runtimeStart("x", [], { visible: true, env: {} }, { via: (c, a, o) => { seen = o; }, platform: "linux" });
  expect(seen).toEqual({ env: {}, windowsHide: false });
});

// ---- cleanup ---------------------------------------------------------------------------------------------------------
const launched = async (over = {}) => { const f = fixture(over.kind ?? "claude", { hc: fakeHc({ sees: [{ status: { state: "working" }, turn: 0 }] }), ...over }); return { ...f, r: await f.go() }; };
const atRest = (over = {}) => fakeHc({ sees: [{ status: { state: "done" }, turn: 1 }], ...over });

test("cleanup ends a resting worker's terminal, kill then rm, then removes its worktree and run folder through their checks", async () => {
  const f = fixture("claude", { extra: ["--worktree", "wt-b"] }), git = repo(f.dir), { worktree } = await f.go();
  const hc = atRest(), r = await cleanup(["--worker", "w1"], { hc: hc.run, settings: () => cfg() });
  expect([r.ok, r.state, r.headline]).toEqual([true, "removed", "routr: removed worker w1"]);
  expect(hc.words()).toEqual(["get", "kill", "rm"]);
  expect(hc.calls[1].args).toEqual(["kill", "t9"]);
  expect(hc.calls[2].args).toEqual(["rm", "t9"]);
  expect(r.steps.map((s) => s.step)).toEqual(expect.arrayContaining(["terminal", "terminal_removed", "remove"]));
  expect(existsSync(runDir("w1"))).toBe(false);
  expect(existsSync(worktree.path)).toBe(false);
  expect(git("rev-parse", "--verify", "--quiet", "refs/heads/wt-b").exitCode).toBe(0); // the branch stays unless asked
});

test("its terminal goes first, and a worktree with uncommitted work is still kept, with the worker's record", async () => {
  const f = fixture("claude", { extra: ["--worktree", "wt-c"] }); repo(f.dir);
  const { worktree } = await f.go();
  writeFileSync(join(worktree.path, "a.txt"), "changed");
  const hc = atRest(), r = await cleanup(["--worker", "w1"], { hc: hc.run, settings: () => cfg() });
  expect(r.state).toBe("refused");
  expect(r.headline).toContain("uncommitted");
  expect(hc.words()).toEqual(["get", "kill", "rm"]);
  expect(existsSync(worktree.path)).toBe(true);
  expect(existsSync(join(runDir("w1"), "prompt.md"))).toBe(true);
  // Again, with its terminal gone: it is told so, and goes on to the same check.
  const again = await cleanup(["--worker", "w1"], { hc: fakeHc({ over: { get: { code: 1, out: "", err: "no terminal t9" } } }).run, settings: () => cfg() });
  expect(again.state).toBe("refused");
  expect(again.steps.find((s) => s.step === "terminal").detail).toContain("is gone");
});

test("cleanup refuses a worker still working or at a question, and ends nothing", async () => {
  await launched();
  for (const [word, says] of [["working", "is working in terminal t9"], ["blocked", "is waiting at a question in terminal t9"]]) {
    const hc = fakeHc({ sees: [{ status: { state: word }, turn: 0 }] }), r = await cleanup(["--worker", "w1"], { hc: hc.run, settings: () => cfg() });
    expect([r.ok, r.state]).toEqual([false, "refused"]);
    expect(r.headline).toContain(says);
    expect(hc.words()).toEqual(["get"]);
    expect(noted(r)).toContain("hc kill t9");
    expect(existsSync(runDir("w1"))).toBe(true);
  }
});

test("a terminal that is someone else's now is never ended, and hc not answering stops cleanup", async () => {
  await launched();
  // Same address and same name, as another core can have: only the id launch labelled it with says whose it is.
  for (const labels of [{ "herdr.tab": "someone-elses-tab" }, { "routr.worker": "f".repeat(32) }, {}]) {
    const other = fakeHc({ sees: [{ status: { state: "done" }, turn: 1, labels }] }), r = await cleanup(["--worker", "w1"], { hc: other.run, settings: () => cfg() });
    expect(r.state).toBe("refused");
    expect(r.headline).toContain("does not carry w1's id");
    expect(r.headline).toContain("ended nothing and kept everything");
    expect(other.words()).toEqual(["get"]);
    expect(existsSync(join(runDir("w1"), "worker.json"))).toBe(true);
  }
  const finished = fakeHc({ sees: [{ state: "finished", status: null, labels: {} }] });
  expect((await cleanup(["--worker", "w1"], { hc: finished.run, settings: () => cfg() })).state).toBe("refused");
  expect(finished.words()).toEqual(["get"]);
  for (const answer of [null, { code: 0, out: "not json" }]) {
    const hc = fakeHc({ over: { get: answer } }), u = await cleanup(["--worker", "w1"], { hc: hc.run, settings: () => cfg() });
    expect(u.state).toBe("refused");
    expect(u.headline).toContain("whether w1's terminal runs is not known");
    expect(hc.words()).toEqual(["get"]);
  }
  const kill = fakeHc({ sees: [{ status: { state: "done" }, turn: 1 }], over: { kill: { code: 1, out: "" } } }), k = await cleanup(["--worker", "w1"], { hc: kill.run, settings: () => cfg() });
  expect(k.state).toBe("refused");
  expect(k.headline).toContain("may still be running");
  expect(kill.words()).toEqual(["get", "kill"]);
  expect(existsSync(runDir("w1"))).toBe(true);
});

test("hc not finding it while its runner is alive may be another core, so nothing is removed; a runner gone, or one that recorded its exit, is over", async () => {
  await launched();
  const missing = () => fakeHc({ over: { get: { code: 1, out: "", err: "not_found" } } }).run;
  writeFileSync(join(runDir("w1"), "run.json"), JSON.stringify({ pid: process.pid, harness_pid: 1 }));
  const r = await cleanup(["--worker", "w1"], { hc: missing(), settings: () => cfg() });
  expect(r.state).toBe("refused");
  expect(r.headline).toContain("it may be in another core");
  writeFileSync(join(runDir("w1"), "run.json"), JSON.stringify({ pid: process.pid, ended_at: "x", exit_code: 0 }));
  expect((await cleanup(["--worker", "w1"], { hc: missing(), settings: () => cfg() })).state).toBe("removed");
  await launched();
  writeFileSync(join(runDir("w1"), "run.json"), "not json");
  const damaged = await cleanup(["--worker", "w1"], { hc: missing(), settings: () => cfg() });
  expect(damaged.headline).toContain("run.json could not be read");
  writeFileSync(join(runDir("w1"), "run.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  expect((await cleanup(["--worker", "w1"], { hc: missing(), settings: () => cfg() })).state).toBe("removed");
});

test("a dry run looks and ends nothing; a finished terminal is only removed; a harness with no status is ended, and said", async () => {
  await launched();
  const dry = atRest(), d = await cleanup(["--worker", "w1", "--dry-run"], { hc: dry.run, settings: () => cfg() });
  expect(d.state).toBe("planned");
  expect(dry.words()).toEqual(["get"]);
  expect(existsSync(runDir("w1"))).toBe(true);
  const done = fakeHc({ sees: [{ state: "finished", status: null, exit_code: 0 }] }), r = await cleanup(["--worker", "w1"], { hc: done.run, settings: () => cfg() });
  expect(r.state).toBe("removed");
  expect(done.words()).toEqual(["get", "rm"]);
  cursorHome();
  await fixture("cursor", { hc: fakeHc({ sees: [{ status: null, turn: 1 }] }) }).go();
  const quiet = fakeHc({ sees: [{ status: null, turn: 0 }] }), c = await cleanup(["--worker", "w1"], { hc: quiet.run, settings: () => cfg() });
  expect(c.state).toBe("removed");
  expect(quiet.words()).toEqual(["get", "kill", "rm"]);
  expect(c.warnings.join(" ")).toContain("Cursor reports no status, so routr cannot see whether it is still working in t9");
});

test("rm is tried again while the terminal finishes; one that stays costs a warning, not the cleanup", async () => {
  await launched();
  let tries = 0;
  const late = atRest({ over: { rm: () => (++tries < 3 ? { code: 1, out: "", err: "live" } : { code: 0, out: "{}" }) } });
  const r = await cleanup(["--worker", "w1"], { hc: late.run, settings: () => cfg() });
  expect(r.state).toBe("removed");
  expect(tries).toBe(3);
  await launched();
  const stays = atRest({ over: { rm: { code: 1, out: "" } } }), s = await cleanup(["--worker", "w1"], { hc: stays.run, settings: () => cfg() });
  expect(s.state).toBe("removed");
  expect(s.warnings.join(" ")).toContain("hc rm t9 removes it");
}, 15000);

// ---- the worker commands ------------------------------------------------------------------------------------------------
test("workers, wait, send, stop and watch each say a terminal worker is followed with hc, and none fails on its record", async () => {
  await launched();
  const shown = await workersCommand(["--name", "w1"], { settings: () => cfg(), env: {} });
  expect([shown.ok, shown.workers]).toEqual([true, [{ name: "w1", kind: "claude", model: "m", effort: null, cwd: expect.any(String), backend: "terminal", terminal: "t9", state: "in_terminal" }]]);
  expect(noted(shown)).toContain("hc wait t9");
  expect(shown.headline).toBe("routr: w1 in_terminal");
  const waited = await waitCommand(["--name", "w1"], { settings: () => cfg(), env: {} });
  expect([waited.ok, waited.state, waited.workers]).toEqual([true, "none", []]);
  expect(waited.headline).toBe("routr: w1 runs in terminal t9: follow it with hc");
  expect(noted(waited)).toContain("hc wait t9");
  // Unnamed, it is not waited on: there is nothing of its to read here.
  expect((await waitCommand([], { settings: () => cfg(), env: {} })).state).toBe("none");
  const sent = await sendCommand(["--name", "w1", "--task", "more"], { settings: () => cfg(), env: {} });
  expect([sent.ok, sent.state, sent.error]).toEqual([false, "refused", undefined]);
  expect(sent.headline).toBe("routr: w1 runs in terminal t9: follow it with hc; nothing was sent");
  expect(noted(sent)).toContain("hc send t9 <message>");
  const stopped = await stopCommand(["--name", "w1"], { settings: () => cfg(), env: {} });
  expect([stopped.ok, stopped.state, stopped.error]).toEqual([false, "refused", undefined]);
  expect(stopped.headline).toBe("routr: w1 runs in terminal t9: follow it with hc; nothing was stopped");
  expect(stopped.next[0].argv).toEqual(["hc", "kill", "t9"]);
  await expect(watchCommand(["--name", "w1"], { write: () => {} })).rejects.toThrow("w1 runs in terminal t9: follow it with hc; its terminal shows it");
  // A holder never takes one on.
  await hold("w1", { run: () => { throw new Error("a holder started a harness"); } });
  expect(existsSync(join(runDir("w1"), "state.json"))).toBe(false);
});

test("the launch index keeps a terminal worker's launch", () => {
  const home = scratch("index"), now = Date.now(), entry = { launch_id: "12345678-1234-4123-8123-123456789abc", traceId: "a".repeat(32), spanId: "b".repeat(16), created_at: new Date(now).toISOString(), advice_id: "abc12345" };
  mkdirSync(join(home, ".local/state/routr"), { recursive: true });
  const index = new LaunchIndex({ home, now: () => now });
  expect(index.add({ ...entry, backend: "terminal" })).toBe(true);
  expect(index.match({ advice_id: "abc12345" })).toMatchObject({ backend: "terminal" });
  expect(index.add({ ...entry, launch_id: "12345678-1234-4123-8123-123456789abd", advice_id: "bcd23456", backend: "another" })).toBe(true);
  expect(index.match({ advice_id: "bcd23456" })).toBeNull(); // written whole, and not read back
});
