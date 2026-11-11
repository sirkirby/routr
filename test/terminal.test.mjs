// Workers in a herdr-core terminal: what launch asks of hc, what it answers, the runner and its environment, and what
// cleanup and the worker commands do with such a worker. Fakes only: no hc, no herdr-app and no harness runs here.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { launch } from "../src/lib/launch.mjs";
import { cleanup } from "../src/lib/cleanup.mjs";
import { sendCommand, stopCommand, waitCommand, workersCommand } from "../src/lib/workers.mjs";
import { watchCommand } from "../src/lib/watch.mjs";
import { hold } from "../src/lib/headless.mjs";
import { workers as workerSet } from "../src/lib/worker.mjs";
import { firstMessage, reportToLead, runRecord, runWorker as runner } from "../src/lib/backend-terminal.mjs";
import { ADAPTERS } from "../src/lib/headless.mjs";
import { HARNESSES, KINDS, plan, terminalPlan } from "../src/lib/harnesses.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { LaunchIndex } from "../src/lib/launch-index.mjs";
import { runDir } from "../src/lib/worker-record.mjs";
import { start as processStart, startOptions } from "../src/lib/processes.mjs";
import { CLOSING } from "../src/lib/wording.mjs";
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
  expect(argv("codex")).toEqual(["--no-daemon", "--yolo", "--dangerously-bypass-hook-trust", "-c", "check_for_update_on_startup=false", "-c", "projects={'/w'={trust_level=\"trusted\"}}", "-m", "m", "the pointer"]);
  expect(argv("cursor")).toEqual(["--yolo", "--trust", "--model", "m", "the pointer"]);
  expect(argv("agy")).toEqual(["--dangerously-skip-permissions", "--add-dir", "/w", "--model", "m", "-i", "the pointer"]);
  expect(argv("kiro")).toEqual(["--v3", "chat", "--trust-all-tools", "--trust-workspace", "--model", "m", "the pointer"]);
  expect(KINDS.filter((k) => HARNESSES[k].noStatus)).toEqual(["cursor"]);
  // What differs in a core terminal is data: a pane starts Codex without its flag, and Kiro on V2, and only Kiro's headless
  // start is neither (below). Every other harness starts the same in both.
  expect(plan({ kind: "codex", model: "m" }).argv).not.toContain("--no-daemon");
  expect(plan({ kind: "kiro", model: "m" }).argv).toEqual(["--v2", "chat", "--trust-tools=*", "--model", "m"]);
  for (const kind of ["claude", "cursor"]) expect(argv(kind).slice(0, -1)).toEqual(plan({ kind, model: "m" }).argv);
  // Its V3 screen ignores --trust-tools (kiro-cli 3.0.0). Folder trust for this run only goes to a start with a screen
  // where the harness has a flag for it, never to a headless start, and names the worker's own folder.
  expect(argv("kiro")).not.toContain("--trust-tools=*");
  for (const start of [plan({ kind: "kiro", model: "m" }).argv, plan({ kind: "kiro", model: "m", interactive: false }).argv]) expect(start).not.toContain("--trust-workspace");
  // A TOML literal string, so no backslash is doubled for a shell to collapse (fish); a basic string only for a ' in the path.
  expect(plan({ kind: "codex", model: "m", cwd: "/repo/wt" }).argv).toContain(`projects={'/repo/wt'={trust_level="trusted"}}`);
  expect(plan({ kind: "codex", model: "m", cwd: 'C:\\w "q"' }).argv).toContain(`projects={'C:\\w "q"'={trust_level="trusted"}}`);
  expect(plan({ kind: "codex", model: "m", cwd: "/it's\\x" }).argv).toContain(`projects={"/it's\\\\x"={trust_level="trusted"}}`);
  expect(plan({ kind: "codex", model: "m", cwd: "/w", interactive: false }).argv.join(" ")).not.toContain("projects=");
  expect(KINDS.filter((k) => (HARNESSES[k].core?.trust ?? HARNESSES[k].trust))).toEqual(["codex", "kiro"]);
});

test("Kiro's headless start stays its ACP mode, with no engine flag and no chat, and a model named chat survives it", () => {
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
  expect(steps).toContain("routr wait --name w1");
  expect(steps).toContain("hc read t9");
  expect(steps).toContain("routr send --name w1 --task-file <file>");
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

test("a tab the app has not adopted yet is named again", async () => {
  let tries = 0;
  const late = fixture("claude", { hc: fakeHc({ over: { do: () => ({ code: ++tries < 3 ? 1 : 0, out: "" }) } }) }), r = await late.go();
  expect(r.state).toBe("prompted");
  expect(tries).toBe(3);
});

test("a tab name that never lands is tried six times, and the worker has started all the same", async () => {
  const never = fixture("claude", { hc: fakeHc({ over: { do: { code: 1, out: "" } } }) }), n = await never.go();
  expect(n.state).toBe("prompted");
  expect(never.hc.calls.filter((c) => c.cmd === "herdr-app").length).toBe(6);
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

test("a long name hc refuses keeps hc's 32-character limit with the id added; a run with no address fails the launch", async () => {
  const long = "a".repeat(32);
  let tries = 0;
  const f = fixture("claude", { name: long, hc: fakeHc({ name: "other", over: { run: () => (++tries === 1 ? { code: 1, out: "" } : undefined) } }) });
  expect((await f.go()).state).toBe("prompted");
  const names = f.hc.calls.filter((c) => c.args[0] === "run").map((c) => c.args[c.args.indexOf("--name") + 1]);
  expect(names[0]).toBe(long);
  expect(names[1]).toMatch(new RegExp(`^${"a".repeat(23)}-[a-f0-9]{8}$`));
  expect(names[1].length).toBe(32);
  const blank = fixture("claude", { name: "w2", hc: fakeHc({ name: "w2", over: { run: { code: 0, out: "{}" } } }) }), r = await blank.go();
  expect([r.ok, r.state]).toEqual([false, "failed"]);
  expect(blank.hc.calls.filter((c) => c.cmd === "herdr-app")).toEqual([]);
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
  expect(noted(r)).toContain("routr send --name w1 --task-file <file>");
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
  expect(noted(r)).toContain("routr wait --name w1");
  expect(noted(r)).toContain("routr send --name w1 --task-file <file>");
  expect(r.worker.terminal).toBe("t9");
  expect(r.next.find((n) => n.argv?.[1] === "cleanup").argv).toEqual(["routr", "cleanup", "--worker", "w1"]);
});

test("Kiro's trust-all-tools warning, reported blocked, is needs_input and is never answered", async () => {
  const f = fixture("kiro", { hc: fakeHc({ sees: [{ status: { state: "blocked" }, turn: 0 }] }) }), r = await f.go();
  expect(r.state).toBe("needs_input");
  expect(r.start.argv.slice(0, 4)).toEqual(["--v3", "chat", "--trust-all-tools", "--trust-workspace"]);
  expect(r.needs_input.note).toContain("Yes, and don't ask again");
  expect(r.needs_input.note).toContain("for the user to answer");
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
  expect(r.needs_input.note).toContain("asks no folder-trust question");
  expect(r.screen).toStartWith("withheld:");
  expect(r.start.argv.slice(0, 2)).toEqual(["--v3", "chat"]);
  expect(f.hc.words()).not.toContain("keys");
});

test("a harness that runs and has reported nothing for 20 seconds is needs_input then, not at --timeout; one that reported is waited on", async () => {
  // The runner's record says the harness runs, as the runner writes it once the harness has started.
  const running = (args) => { if (existsSync(runDir("w1")) && !existsSync(join(runDir("w1"), "run.json"))) writeFileSync(join(runDir("w1"), "run.json"), JSON.stringify({ pid: 1, harness_pid: 2, started_at: "x" })); return undefined; };
  const quiet = fixture("codex", { hc: fakeHc({ sees: [{ status: null, turn: 0, reported: false }], over: { get: running } }) }), q = await quiet.go();
  expect([q.state, q.needs_input.code ?? null, q.needs_input.hc]).toEqual(["needs_input", null, { state: null, reported: false }]);
  expect(q.needs_input.why).toBe("Codex has run for 20 seconds without reporting any status: it is most likely waiting at a question it reports no status for.");
  expect(q.next.map((n) => n.argv?.join(" ") ?? "")).toContain("hc read t9 --lines 200");
  rmSync(runDir("w1"), { recursive: true, force: true });
  // Reported (idle, at its input box) but not yet working: waited on until --timeout, as before.
  const idle = fixture("codex", { timeout: 60000, hc: fakeHc({ sees: [{ status: { state: "idle" }, turn: 0, reported: true }], over: { get: running } }) }), i = await idle.go();
  expect([i.state, i.needs_input.why]).toEqual(["needs_input", "Codex has not reported working within the timeout: it may be waiting at a question it reports no status for, or still starting."]);
  rmSync(runDir("w1"), { recursive: true, force: true });
  // A core that does not say `reported`, or a harness not yet running: no early answer.
  const old = fixture("codex", { timeout: 60000, hc: fakeHc({ sees: [{ status: null, turn: 0 }], over: { get: running } }) }), o = await old.go();
  expect(o.needs_input.why).toContain("within the timeout");
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
  let seen; processStart("x", [], { visible: true, env: {} }, { via: (c, a, o) => { seen = o; }, platform: "linux" });
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
    expect(noted(r)).toContain("routr stop --name w1");
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
test("workers asks hc where a terminal worker's terminal is: a finished or gone one is finished with cleanup --worker, never by hand", async () => {
  await launched();
  const row = async (hc) => workersCommand(["--name", "w1"], { settings: () => cfg(), env: {}, hc: hc.run });
  const finished = await row(fakeHc({ sees: [{ state: "finished", status: null, exit_code: 0 }] }));
  expect([finished.workers[0].state, finished.next[0].argv]).toEqual(["finished", ["routr", "cleanup", "--worker", "w1"]]);
  // Its tab closed, or its core lost it: hc does not know it, and its runner is not running.
  const gone = await row(fakeHc({ over: { get: { code: 1, out: "", err: "no terminal t9" } } }));
  expect([gone.workers[0].state, gone.headline, gone.next[0].argv]).toEqual(["gone", "routr: w1 gone", ["routr", "cleanup", "--worker", "w1"]]);
  expect(gone.next[0].why).toContain("removes its worktree through its checks and then its record");
  // hc not answering, or an address now another terminal's: not known, and said, never "gone".
  // A refusal for another reason, or an answer that is not a terminal, is not "gone" either.
  for (const hc of [fakeHc({ over: { get: null } }), fakeHc({ sees: [{ status: { state: "idle" }, turn: 0, labels: { "routr.worker": "f".repeat(32) } }] }),
    fakeHc({ over: { get: { code: 1, out: "", err: "permission denied" } } }), fakeHc({ over: { get: { code: 0, out: "null" } } })]) {
    const r = await row(hc);
    expect([r.workers[0].state, typeof r.workers[0].why]).toEqual(["unknown", "string"]);
    expect(r.next.some((n) => n.argv?.includes("cleanup"))).toBe(false);
  }
  // cleanup --worker reads the same: a refusal that is not "no such terminal" keeps everything.
  const kept = await cleanup(["--worker", "w1"], { hc: fakeHc({ over: { get: { code: 1, out: "", err: "permission denied" } } }).run, settings: () => cfg() });
  expect([kept.state, existsSync(runDir("w1"))]).toEqual(["refused", true]);
  // Every terminal worker is asked at once, each call bounded, so one hc that does not answer holds up no other row.
  const calls = fakeHc({ over: { get: null } });
  await row(calls);
  expect(calls.calls.filter((c) => c.args[0] === "get").map((c) => c.ms)).toEqual([3000]);
});

test("workers and watch keep their terminal behavior while wait follows hc turns through the worker module", async () => {
  await launched();
  const shown = await workersCommand(["--name", "w1"], { settings: () => cfg(), env: {}, hc: fakeHc({ sees: [{ status: { state: "working" }, turn: 0 }] }).run });
  expect([shown.ok, shown.workers]).toEqual([true, [{ name: "w1", kind: "claude", model: "m", effort: null, cwd: expect.any(String), backend: "terminal", terminal: "t9", state: "in_terminal", status: "working" }]]);
  expect(noted(shown)).toContain("routr wait --name w1");
  expect(shown.headline).toBe("routr: w1 in_terminal");
  expect((await workerSet({ hc: fakeHc({ sees: [{ status: { state: "working" }, turn: 0 }] }).run }).one("w1").look()).view.state).toBe("in_terminal");
  let now = 0;
  const hc = fakeHc({ sees: [{ status: { state: "working" }, turn: 0 }, { status: { state: "done" }, turn: 1 }] });
  const waited = await waitCommand(["--name", "w1", "--timeout", "1000"], { settings: () => cfg(), env: {}, hc: hc.run, now: () => now, pause: async () => { now = 1001; } });
  expect([waited.ok, waited.state, waited.headline]).toEqual([true, "finished", "routr: w1 finished a turn"]);
  expect(waited.workers[0]).toMatchObject({ name: "w1", state: "idle", status: "done", turn: 1, turns: [{ turn: 1, outcome: "finished", report: null, delivered: 0 }] });
  expect(waited.next[0].argv).toEqual(["hc", "read", "t9", "--lines", "200"]);
  expect(hc.calls.filter((c) => c.args[0] === "get").map((c) => c.args)).toEqual([["get", "t9", "--json"], ["get", "t9", "--json"]]);
  await expect(watchCommand(["--name", "w1"], { write: () => {} })).rejects.toThrow("w1 runs in terminal t9: follow it with hc; its terminal shows it");
  // A holder never takes one on.
  await hold("w1", { run: () => { throw new Error("a holder started a harness"); } });
  expect(existsSync(join(runDir("w1"), "state.json"))).toBe(false);
});

test("wait returns at a terminal question and notices a terminal that is gone, without reading its screen", async () => {
  await launched();
  const blocked = fakeHc({ sees: [{ status: { state: "blocked", kind: "question" }, turn: 0 }], over: { read: { code: 0, out: SECRET } } });
  const b = await waitCommand(["--name", "w1", "--timeout", "0"], { settings: () => cfg(), env: {}, hc: blocked.run });
  expect([b.ok, b.state, b.workers[0].state, b.workers[0].status]).toEqual([true, "idle", "idle", "blocked"]);
  expect(blocked.words()).toEqual(["get"]);
  expect(JSON.stringify(b)).not.toContain(SECRET);
  const questionTurn = await waitCommand(["--name", "w1", "--timeout", "0"], { settings: () => cfg(), env: {}, hc: fakeHc({ sees: [{ status: { state: "blocked" }, turn: 1 }] }).run });
  expect([questionTurn.state, questionTurn.headline, questionTurn.workers[0].status]).toEqual(["finished", "routr: w1 finished a turn", "blocked"]);
  const gone = fakeHc({ over: { get: { code: 1, out: "", err: "no terminal t9" }, read: { code: 0, out: SECRET } } });
  const g = await waitCommand(["--name", "w1", "--timeout", "0"], { settings: () => cfg(), env: {}, hc: gone.run });
  expect([g.ok, g.state, g.workers[0].state, g.headline]).toEqual([true, "finished", "lost", "routr: w1 lost"]);
  expect(g.next.map((n) => n.argv)).toEqual([["routr", "cleanup", "--worker", "w1"]]);
  expect(JSON.stringify(g)).not.toContain("process ended without settling");
  expect(gone.words()).toEqual(["get"]);
  expect(JSON.stringify(g)).not.toContain(SECRET);
});

test("send writes an owner-only message file and gives hc only its pointer, classifying handed, blocked and unknown answers", async () => {
  const cases = [
    [{ code: 0, out: JSON.stringify({ turn: 1, status: "working", wait: null }) }, true, "delivered", { code: "handed_to_harness" }],
    [{ code: 3, out: JSON.stringify({ error: { kind: "blocked", message: SECRET } }) }, false, "refused", { code: "refused", why: "refused" }],
    [{ code: 0, out: SECRET }, false, "unknown", { code: "unknown" }],
    [null, false, "unknown", { code: "unknown" }],
  ];
  for (const [answer, ok, state, message] of cases) {
    await launched();
    const hc = fakeHc({ over: { send: answer } });
    const r = await sendCommand(["--name", "w1", "--task", SECRET], { settings: () => cfg(), env: {}, hc: hc.run });
    expect([r.ok, r.state, r.message]).toEqual([ok, state, message]);
    const calls = hc.calls.filter((c) => c.cmd === "hc");
    expect(calls.map((c) => c.args[0])).toEqual(["get", "send"]);
    expect(calls[0].args).toEqual(["get", "t9", "--json"]);
    const pointer = calls[1].args[2], match = /^Your message is in (.+)\. Read that whole file now and do what it says\.$/.exec(pointer);
    expect(calls[1].args).toEqual(["send", "t9", pointer, "--json"]);
    expect(match).not.toBeNull();
    expect(pointer).not.toContain(SECRET);
    expect(readFileSync(match[1], "utf8")).toBe(`${SECRET}\n\n${CLOSING}`);
    if (process.platform !== "win32") expect(statSync(match[1]).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    if (state === "refused") {
      expect(r.next[0].argv).toEqual(["hc", "read", "t9", "--lines", "200"]);
      expect(r.next[1].template).toBe("hc keys t9 <keys>");
    }
    rmSync(runDir("w1"), { recursive: true, force: true });
  }
});

test("wait after send stays pending at the old idle turn until hc advances the turn", async () => {
  await launched();
  const sentHc = fakeHc({ sees: [{ status: { state: "idle" }, turn: 0 }], over: { send: { code: 0, out: JSON.stringify({ turn: 0 }) } } });
  expect((await sendCommand(["--name", "w1", "--task", "more"], { settings: () => cfg(), env: {}, hc: sentHc.run })).state).toBe("delivered");
  const marker = join(runDir("w1"), "send.json");
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ turn: 0 });
  if (process.platform !== "win32") expect(statSync(marker).mode & 0o777).toBe(0o600);
  let now = 0, pauses = 0;
  const waitedHc = fakeHc({ sees: [{ status: { state: "idle" }, turn: 0 }, { status: { state: "done" }, turn: 1 }] });
  const r = await waitCommand(["--name", "w1", "--timeout", "1000"], { settings: () => cfg(), env: {}, hc: waitedHc.run, now: () => now,
    pause: async () => { pauses++; now += 500; } });
  expect([r.state, pauses, waitedHc.words()]).toEqual(["finished", 1, ["get", "get"]]);
  expect(r.workers[0]).toMatchObject({ state: "idle", turn: 1, turns: [{ turn: 1, report: null }] });
});

test("send says nothing was sent when lookup or identity stops it before hc send", async () => {
  const cases = [
    fakeHc({ sees: [{ status: { state: "done" }, turn: 1, labels: { "routr.worker": "f".repeat(32) } }] }),
    fakeHc({ sees: [{ state: "finished", status: null, turn: 1 }] }),
    fakeHc({ over: { get: { code: 1, out: "", err: "no terminal t9" } } }),
    fakeHc({ over: { get: null } }),
    fakeHc({ over: { get: { code: 0, out: SECRET } } }),
    fakeHc({ sees: [{ address: "not an address", status: { state: "working" }, turn: 0 }] }),
  ];
  for (const hc of cases) {
    await launched();
    const r = await sendCommand(["--name", "w1", "--task", SECRET], { settings: () => cfg(), env: {}, hc: hc.run });
    expect([r.ok, r.state, r.headline.includes("nothing was sent"), hc.words()]).toEqual([false, "refused", true, ["get"]]);
    expect(readdirSync(runDir("w1")).filter((n) => n.startsWith("message-"))).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    rmSync(runDir("w1"), { recursive: true, force: true });
  }
});

test("send and stop act on nothing when the worker record is replaced after the terminal identity check", async () => {
  for (const command of ["send", "stop"]) {
    await launched();
    const before = recordOf(), calls = [];
    const hc = async (cmd, args, ms) => {
      calls.push({ cmd, args, ms });
      if (args[0] === "get") {
        writeFileSync(join(runDir("w1"), "worker.json"), JSON.stringify({ ...before, id: "f".repeat(32) }));
        return { code: 0, out: JSON.stringify({ address: "t9", name: "w1", state: "live", labels: { "routr.worker": before.id }, status: { state: "working" }, turn: 0 }) };
      }
      throw new Error("an action reached hc");
    };
    const r = command === "send"
      ? await sendCommand(["--name", "w1", "--task", SECRET], { settings: () => cfg(), env: {}, hc })
      : await stopCommand(["--name", "w1"], { settings: () => cfg(), env: {}, hc });
    expect([r.ok, r.state, r.headline.includes(command === "send" ? "nothing was sent" : "nothing was stopped")]).toEqual([false, command === "send" ? "refused" : "unknown", true]);
    expect(calls.map((c) => c.args[0])).toEqual(["get"]);
    expect(readdirSync(runDir("w1")).filter((n) => n.startsWith("message-"))).toEqual([]);
    rmSync(runDir("w1"), { recursive: true, force: true });
  }
});

test("stop kills only the live terminal carrying this worker's id, and leaves finished and foreign terminals alone", async () => {
  const cases = [
    [fakeHc({ sees: [{ status: { state: "working" }, turn: 0 }] }), true, "stopped", ["get", "kill"]],
    [fakeHc({ sees: [{ state: "finished", status: null, exit_code: 0 }] }), true, "absent", ["get"]],
    [fakeHc({ sees: [{ status: { state: "done" }, turn: 1, labels: { "routr.worker": "f".repeat(32) } }] }), false, "unknown", ["get"]],
  ];
  for (const [hc, ok, state, words] of cases) {
    await launched();
    const r = await stopCommand(["--name", "w1"], { settings: () => cfg(), env: {}, hc: hc.run });
    expect([r.ok, r.state, r.error]).toEqual([ok, state, undefined]);
    expect(hc.words()).toEqual(words);
    if (words.includes("kill")) expect(hc.calls.find((c) => c.args[0] === "kill").args).toEqual(["kill", "t9"]);
    expect(existsSync(runDir("w1"))).toBe(true);
    rmSync(runDir("w1"), { recursive: true, force: true });
  }
});

test("stop classifies a terminal gone during kill, hc failures and an unreadable lookup without leaking hc text", async () => {
  const cases = [
    [fakeHc({ over: { kill: { code: 1, out: "", err: "no terminal t9" } } }), true, "absent", ["get", "kill"], "is not running"],
    [fakeHc({ over: { kill: { code: 1, out: SECRET, err: "permission denied " + SECRET } } }), false, "unknown", ["get", "kill"], "nothing was stopped"],
    [fakeHc({ over: { kill: null } }), false, "unknown", ["get", "kill"], "whether hc received"],
    [fakeHc({ over: { get: { code: 0, out: SECRET } } }), false, "unknown", ["get"], "nothing was stopped"],
  ];
  for (const [hc, ok, state, words, headline] of cases) {
    await launched();
    const r = await stopCommand(["--name", "w1"], { settings: () => cfg(), env: {}, hc: hc.run });
    expect([r.ok, r.state, hc.words(), r.headline.includes(headline)]).toEqual([ok, state, words, true]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    rmSync(runDir("w1"), { recursive: true, force: true });
  }
});

test("wait notices finished and unreadable terminals and unnamed wait includes a status-reporting terminal", async () => {
  await launched();
  const finished = fakeHc({ sees: [{ state: "finished", status: null, turn: 0 }] });
  const f = await waitCommand(["--name", "w1", "--timeout", "0"], { settings: () => cfg(), env: {}, hc: finished.run });
  expect([f.state, f.workers[0].state, f.workers[0].backend]).toEqual(["finished", "stopped", "terminal"]);
  expect(f.next.map((n) => n.argv)).toEqual([["hc", "read", "t9", "--lines", "200"], ["routr", "cleanup", "--worker", "w1"]]);
  rmSync(join(runDir("w1"), "seen.json"), { force: true });
  const unreadable = fakeHc({ over: { get: { code: 0, out: SECRET } } });
  const u = await waitCommand(["--name", "w1", "--timeout", "0"], { settings: () => cfg(), env: {}, hc: unreadable.run });
  expect([u.state, u.workers[0].state, u.next.map((n) => n.argv)]).toEqual(["finished", "unreachable", [["hc", "ls", "--all"], ["routr", "wait", "--name", "w1"]]]);
  expect(JSON.stringify(u)).not.toContain(SECRET);
  rmSync(join(runDir("w1"), "seen.json"), { force: true });
  const unnamed = await waitCommand(["--timeout", "0"], { settings: () => cfg(), env: {}, hc: fakeHc({ sees: [{ status: { state: "idle" }, turn: 0 }] }).run });
  expect([unnamed.state, unnamed.workers.map((w) => w.name), unnamed.headline]).toEqual(["idle", ["w1"], "routr: nothing running: w1 idle"]);
});

test("Cursor keeps wait's status refusal, while terminal send and stop still act by id", async () => {
  cursorHome();
  await fixture("cursor", { hc: fakeHc({ sees: [{ status: null, turn: 1 }] }) }).go();
  const waited = await waitCommand(["--name", "w1", "--timeout", "0"], { settings: () => cfg(), env: {} });
  expect([waited.ok, waited.state, waited.workers]).toEqual([true, "none", []]);
  expect(waited.headline).toBe("routr: w1 runs in terminal t9: follow it with hc");
  const sentHc = fakeHc({ sees: [{ status: null, turn: 1 }], over: { send: { code: 0, out: JSON.stringify({ turn: 1 }) } } });
  const sent = await sendCommand(["--name", "w1", "--task", "more"], { settings: () => cfg(), env: {}, hc: sentHc.run });
  expect([sent.ok, sent.state, sentHc.words()]).toEqual([true, "delivered", ["get", "send"]]);
  const stopHc = fakeHc({ sees: [{ status: null, turn: 1 }] });
  const stopped = await stopCommand(["--name", "w1"], { settings: () => cfg(), env: {}, hc: stopHc.run });
  expect([stopped.ok, stopped.state, stopHc.words()]).toEqual([true, "stopped", ["get", "kill"]]);
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

// cleanup --cwd/--worktree/--path in herdr-core: git lists and removes, core's terminals say what runs in a worktree.
const gitRepo = () => {
  const dir = scratch("core-repo"), g = (...a) => { const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...a]); if (r.exitCode) throw new Error(String(r.stderr)); return String(r.stdout).trim(); };
  g("init", "-q", "-b", "main"); g("commit", "-q", "--allow-empty", "-m", "start");
  return { dir, g };
};
// The lead's own terminal, as `get` describes a live one: where its program is.
const LEAD_LIVE = { ...LEAD, state: "live", cwd: "/lead", foreground: { pid: 1, name: "zsh", argv: ["zsh"], cwd: "/lead" } };
const coreHc = (terminals, got = {}) => { got = { t3: LEAD_LIVE, ...got }; return fakeHc({ over: { ls: { code: 0, out: JSON.stringify({ hidden_finished: 0, machines: [], terminals }) },
  get: (a) => (got[a[1]] ? { code: 0, out: JSON.stringify(got[a[1]]) } : { code: 0, out: JSON.stringify(terminals.find((t) => t.address === a[1]) ?? {}) }) } }); };

test("in herdr-core, cleanup refuses a worktree a live terminal is in, names cleanup --worker for a routr worker's, and says what it sees", async () => {
  const { dir, g } = gitRepo(), wt = join(dir + "-wt", "side"); g("worktree", "add", "-q", "-b", "side", wt);
  const env = { ...LEAD_ENV, HERDR_ENV: "" }, run = (hc) => cleanup(["--cwd", dir, "--path", wt], { env, hc: hc.run, settings: () => cfg() });
  // A shell started elsewhere whose program is in the worktree now (an empty folder: git sees nothing to keep).
  mkdirSync(join(wt, "src"));
  const shell = coreHc([LEAD, { address: "t5", state: "live", cwd: "/elsewhere" }], { t5: { address: "t5", name: "notes", state: "live", cwd: "/elsewhere", foreground: { pid: 1, name: "zsh", argv: ["zsh"], cwd: join(wt, "src") } } });
  const r1 = await run(shell);
  // The path is git's own form of it (macOS /private/var, Windows forward slashes and long names): the reason is what is checked.
  expect([r1.state, r1.headline.replace(/^routr: kept .*?: terminal/, "terminal").replace(/ runs in .*$/, " runs in")]).toEqual(["refused", "terminal t5 (notes) runs in"]);
  expect(r1.next.map((n) => n.argv?.join(" ") ?? n.why)).toContain("hc read t5 --lines 200");
  // A routr worker's terminal: finish it with cleanup --worker, by the name its record has.
  mkdirSync(runDir("w9"), { recursive: true }); writeFileSync(join(runDir("w9"), "worker.json"), JSON.stringify({ format: 1, id: "f".repeat(32), name: "w9", kind: "claude", model: "m", cwd: wt, backend: "terminal" }));
  const worker = coreHc([LEAD, { address: "t6", state: "live", cwd: wt }], { t6: { address: "t6", name: "w9", state: "live", cwd: wt, foreground: { pid: 2, name: "claude", argv: [], cwd: wt }, labels: { "routr.worker": "f".repeat(32) } } });
  const r2 = await run(worker);
  expect([r2.state, r2.headline.replace(/^routr: kept .*?: terminal/, "terminal").replace(/ runs in .*$/, " runs in"), r2.next[0].argv]).toEqual(["refused", "terminal t6 (w9), a routr worker's, runs in", ["routr", "cleanup", "--worker", "w9"]]);
  // hc not answering is not knowing: nothing is removed. Nor is an answer that does not say where a live terminal's
  // program is (core's schema: `foreground` is null only once it has finished), nor one that is not a terminal.
  const r3 = await run(fakeHc({ over: { ls: null } }));
  expect([r3.state, existsSync(wt)]).toEqual(["refused", true]);
  const there = (cwd) => ({ address: "t5", state: "live", cwd: "/elsewhere", foreground: { pid: 5, name: "zsh", argv: [], cwd } });
  for (const said of [{}, { address: "t5", state: "live", cwd: "/elsewhere", foreground: null }, there(""), there("side")]) {
    const r = await run(coreHc([LEAD, { address: "t5", state: "live", cwd: "/elsewhere" }], { t5: said }));
    expect([r.state, existsSync(wt), r.unavailable.map((u) => u.part)]).toEqual(["refused", true, ["terminal"]]);
    expect(r.headline).toContain("did not say where terminal t5's program is");
  }
  // Only terminals elsewhere, and finished ones: removed, and the warning says what cleanup sees.
  const r4 = await run(coreHc([LEAD, { address: "t7", state: "finished", cwd: wt }]));
  expect([r4.state, existsSync(wt)]).toEqual(["removed", false]);
  expect(r4.warnings).toContain("In herdr-core, cleanup sees the core's terminals in a worktree's folder, not other processes there: it checks git's state and hc's terminals");
  expect(r4.warnings.join("\n")).not.toContain("Outside herdr");
});

test("cleanup removes a repository's folder in routr's worktrees folder once its last worktree is gone, and only an empty one", async () => {
  const { dir, g } = gitRepo(), root = join(process.env.HOME, ".local/share/routr/worktrees", "repo-1234abcd");
  const one = join(root, "routr-a"), two = join(root, "routr-b"); g("worktree", "add", "-q", "-b", "a", one); g("worktree", "add", "-q", "-b", "b", two);
  const rm = (p) => cleanup(["--cwd", dir, "--path", p], { env: {}, settings: () => cfg() });
  expect([(await rm(one)).state, existsSync(root)]).toEqual(["removed", true]);
  const last = await rm(two);
  expect([last.state, existsSync(root), last.steps.some((s) => s.step === "folder")]).toEqual(["removed", false, true]);
  // A worktree outside routr's folder leaves its parent alone, empty or not.
  const mine = join(dir + "-own", "x"); g("worktree", "add", "-q", "-b", "c", mine);
  expect([(await rm(mine)).state, existsSync(dirname(mine))]).toEqual(["removed", true]);
});

test("cleanup --worker in herdr-core keeps the worktree while another terminal is in it, and passes over the worker's own", async () => {
  const f = fixture("claude", { extra: ["--worktree", "wt-k"] }); repo(f.dir);
  const { worktree } = await f.go(), id = recordOf().id;
  const own = { address: "t9", name: "w1", state: "live", cwd: worktree.path, foreground: { pid: 3, name: "claude", argv: [], cwd: worktree.path }, labels: { "routr.worker": id }, status: { state: "done" }, turn: 1 };
  const lead = LEAD_LIVE;
  const shell = { address: "t5", name: "notes", state: "live", cwd: "/elsewhere", foreground: { pid: 4, name: "zsh", argv: [], cwd: worktree.path } };
  const hcWith = (terms) => fakeHc({ over: { ls: { code: 0, out: JSON.stringify({ hidden_finished: 0, machines: [], terminals: terms }) },
    get: (a) => ({ code: 0, out: JSON.stringify([lead, own, shell].find((t) => t.address === a[1])) }) } });
  const go = (hc, extra = []) => cleanup(["--worker", "w1", ...extra], { env: LEAD_ENV, hc: hc.run, settings: () => cfg() });
  // A dry run would end its own terminal: that terminal does not keep the worktree.
  expect((await go(hcWith([lead, own]), ["--dry-run"])).state).toBe("planned");
  // Another shell in the worktree keeps it, the worker's record with it.
  const kept = await go(hcWith([lead, own, shell]));
  expect([kept.state, existsSync(worktree.path), existsSync(runDir("w1"))]).toEqual(["refused", true, true]);
  expect(kept.headline).toContain(`terminal t5 (notes) runs in`);
  // With it gone, the worker is finished.
  expect((await go(hcWith([lead, own]))).state).toBe("removed");
  expect(existsSync(worktree.path)).toBe(false);
});
