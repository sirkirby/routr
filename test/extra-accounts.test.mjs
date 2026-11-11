// More than one account of a harness: extra accounts configured under `accounts: { "<name>": "<folder>", ... }`
// are checked, read, kept, ranked and launched with their folder, from nothing but their harness's `folder` entry
// in the registry. The first harness here is the test's own, so nothing can lean on Claude Code or Codex; theirs follow.
// A harness entry with no `accounts` is the account the environment names.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { enabledSubscriptions, loadConfig } from "../src/lib/config.mjs";
import { accountAt, accountOf, HARNESSES, KINDS, notReady, signIn, SOURCES, workerAccount } from "../src/lib/harnesses.mjs";
import { runWorker } from "../src/lib/backend-terminal.mjs";
import { SHELLS } from "../src/lib/herdr.mjs";
import { readHistory } from "../src/lib/launch-history.mjs";
import { assess, briefSha, resolveEffort } from "../src/lib/ledger.mjs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { CLAUDE_SNAPSHOT, configDirOf, home } from "../src/lib/state-files.mjs";
import { capacityView } from "../src/lib/capacity.mjs";
import { run, start } from "../src/lib/processes.mjs";
import { carriersFrom, paneEnv, terminalEnv, workerEnv } from "../src/lib/worker-env.mjs";
import { COMMANDS } from "../src/lib/command-table.mjs";
import { commandTrace, usageSpans } from "../src/lib/traces.mjs";
import { fileStore, memoryStore, usageReaders, usageReadings } from "../src/lib/usage-readings.mjs";
import { claudeProjectFolders, failedUsage, readClaude, summarize } from "../src/lib/usage.mjs";
import { launch } from "./contract.mjs";
import { install } from "./fixtures/otel-signals.mjs";
import { cliEnv, fakeExecutable, row, scratch, SCRIPT } from "./helpers.mjs";

const T = 1_800_000_000;
// The accounts' folders, as the config reads them: full paths, which on Windows carry a drive.
const B = resolve("/acct/b"), OUT = resolve("/acct/out"), WORK = resolve("/acct/claude-work"), CODEX_B = resolve("/acct/codex-b");
// The shell a pane is taken to have until herdr names one (backend-pane.mjs usualShell).
const SHELL = process.platform === "win32" ? "powershell" : "posix";
const SHELL_NAME = process.platform === "win32" ? "powershell.exe" : "zsh", SHELL_PROMPT = process.platform === "win32" ? "PS C:\\repo>" : "chris % ";
// A harness of the test's own: one registry entry, as CONTRIBUTING.md asks of a new one, with a `folder`. Its program
// says what it was started with, and answers its status check and usage by the folder it finds.
const BIN = scratch("accounts-bin"), LOG = join(BIN, "started.jsonl");
fakeExecutable(BIN, "testy", `
const a = process.argv.slice(2), dir = process.env.TESTY_HOME ?? null;
require("node:fs").appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ argv: a, dir }) + "\\n");
if (a[0] === "whoami") { console.log(dir === ${JSON.stringify(OUT)} ? "signed out" : "signed in"); process.exit(dir === ${JSON.stringify(OUT)} ? 1 : 0); }
if (a[0] === "usage") console.log(JSON.stringify({ used: dir === ${JSON.stringify(B)} ? 20 : dir === null ? 55 : 70 }));
`);
HARNESSES.testy = { label: "Testy", executable: "testy", app: "testy", installAs: "Testy", permissions: ["--yes"], model: "--model",
  folder: { variable: "TESTY_HOME", unsetAt: ".testy" },
  auth: { check: ["whoami"], signedIn: (out, code) => code === 0 && /signed in/.test(out), signIn: "run `testy login`" },
  usage: { source: "testy usage", read: async ({ account } = {}) => summarize({ pool: "testy", source: "testy usage", ts: T, nowSec: T,
    windows: [{ name: "week", usedPct: JSON.parse(await run("testy", ["usage"], { account: account?.env })).used }] }) } };
// The registry's own lists were made when it loaded: an entry in the source is in them already.
KINDS.push("testy"); SOURCES.testy = HARNESSES.testy.usage;
afterAll(() => { delete HARNESSES.testy; delete SOURCES.testy; KINDS.splice(KINDS.indexOf("testy"), 1); });

// Each test runs with a caller who has set every folder variable: none of it may reach another account.
const CALLER = { TESTY_HOME: "/caller/testy", CLAUDE_CONFIG_DIR: "/caller/claude", CODEX_HOME: "/caller/codex" };
const saved = {};
beforeEach(() => { for (const k of ["PATH", "ROUTR_NO_REFRESH", ...Object.keys(CALLER)]) saved[k] = process.env[k]; Object.assign(process.env, CALLER); process.env.PATH = `${BIN}${delimiter}${process.env.PATH}`; rmSync(LOG, { force: true }); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const started = () => { try { return readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
// The test setup turns the caches' writes off (ROUTR_NO_REFRESH); a cache test turns them on until it has finished.
const withRefresh = async (fn) => { delete process.env.ROUTR_NO_REFRESH; return fn(); };
const sub = (over = {}) => ({ hardest_work: "strong", reserve: 0.1, ...over });
const configFile = (subscriptions) => {
  const dir = scratch("accounts-cfg"), path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ subscriptions }));
  return path;
};
// Testy with two extra accounts configured under `accounts`:
const TESTY = { testy: sub({ accounts: { b: B, home: "~/.testy" } }) };
const taskFiles = (text = "Rename foo to bar in x.js.") => {
  const dir = scratch("accounts-task"), task = join(dir, "task.md"), advice = join(dir, "advice.json");
  writeFileSync(task, text); writeFileSync(advice, JSON.stringify({ mode: "dispatch", id: "abc12345", brief_sha: briefSha(text), fallback: true }));
  return { dir, flags: ["--model", "model-a", "--cwd", dir, "--task-file", task, "--advice", advice] };
};
// A herdr session with one shell pane, answering what launch asks of it (as launch.test.mjs's, trimmed).
const fakeHerdr = (cwd, agent, shellName = SHELL_NAME) => {
  const calls = []; let stage = "shell", ticks = 0;
  const ok = (result) => ({ ok: true, data: { result } });
  return { calls, text: () => calls.map((a) => a.join(" ")), now: () => ticks, sleep: async (ms) => { ticks += ms; }, run: async (a) => {
    calls.push(a);
    if (a[0] === "pane" && a[1] === "current") return ok({ pane: { pane_id: "w1:p1" } });
    if (a[1] === "layout") return ok({ layout: { panes: [{ pane_id: "w1:p1", rect: { width: 100, height: 40 } }] } });
    if (a[1] === "split") return ok({ pane: { pane_id: "w1:p2" } });
    if (a[0] === "worktree") return ok({ root_pane: { pane_id: "w1:p9" }, worktree: { path: cwd }, workspace: { workspace_id: "w2" } });
    if (a[1] === "read") return ok({ text: stage === "shell" ? SHELL_PROMPT : "Welcome\n❯" });
    if (a[1] === "process-info") return ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: shellName, cwd }] } });
    if (["run", "close", "rename", "prompt"].includes(a[1])) return ok({});
    if (a[1] === "start") { stage = "starting"; return ok({}); }
    if (a[1] === "wait") { stage = "ready"; return ok({}); }
    if (a[1] === "get") return stage === "shell" ? { ok: false, data: { error: { code: "agent_not_found", message: "no agent" } } } : ok({ agent: { agent, agent_status: "idle", interactive_ready: true, cwd } });
    throw new Error(`Unexpected command ${a.join(" ")}`);
  } };
};
// herdr-core, with a lead in t3: the worker's terminal is t9.
const fakeHc = (name) => async (cmd, args) => {
  if (args[0] === "get" && args[1] === "t3") return { code: 0, out: JSON.stringify({ address: "t3", name: "lead", labels: { "herdr.space": "sp1" } }) };
  if (args[0] === "get") { let id; try { id = JSON.parse(readFileSync(join(home(), ".local/state/routr/workers", name, "worker.json"), "utf8")).id; } catch {} return { code: 0, out: JSON.stringify({ address: "t9", name, state: "live", labels: id ? { "routr.worker": id } : {}, status: { app: "x", state: "working" }, turn: 0 }) }; }
  return { code: 0, out: args[0] === "run" ? JSON.stringify({ address: "t9", name }) : "{}" };
};
const CORE = { HC_TERMINAL_ID: "t3", HC_TERMINAL_SOCKET: "/lead.sock", HC_SCOPE: "lead-scope" };

test("the config gives a subscription its accounts and folders, expanding them into rows and leaving out invalid ones", () => {
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
  const subscriptions = { claude: sub({ accounts: { team: "~/claude-team", work: "~/.claude-work", "Bad Name": "~/bad", rel: "claude-rel" } }), codex: sub({ accounts: { b: resolve("/srv/codex-b") } }),
    cursor: sub({ accounts: { team: "~/cursor-team" } }), agy: sub({ accounts: { team: "~/agy-team" } }), kiro: sub({ accounts: "~/kiro-team" }), plain: sub(), "codex-b": sub() };
  const { config, notes } = loadConfig(configFile(subscriptions));
  expect(Object.keys(config.subscriptions)).toEqual(["claude", "codex", "cursor", "agy", "kiro", "plain", "codex-b", "claude-team", "claude-work"]);
  expect(config.subscriptions["claude-team"]).toMatchObject({ harness: "claude", config_dir: join(home(), "claude-team"), hardest_work: "strong", reserve: 0.1 });
  expect(config.subscriptions["claude-work"]).toMatchObject({ harness: "claude", config_dir: join(home(), ".claude-work") });
  for (const n of ["claude", "codex", "cursor", "agy", "kiro", "plain", "codex-b"]) expect(Object.keys(config.subscriptions[n])).toEqual(["enabled", "hardest_work", "reserve", "default_model", "default_effort", "billing", "use", "share"]);
  expect(notes).toEqual(["subscriptions.claude.accounts.Bad Name: claude-Bad Name is not a name routr takes: a-z, 0-9, - and _, 32 characters at most",
    'subscriptions.claude.accounts.rel: folder "claude-rel" is not a full path or one under ~/', "subscriptions.codex.accounts.b: codex-b is already used by another subscription",
    "subscriptions.cursor.accounts.team: Cursor has no folder setting routr knows",
    "subscriptions.agy.accounts.team: Antigravity has no folder setting routr knows",
    "subscriptions.kiro.accounts: accounts must be an object of <name>: <folder>"].map((note) => `${note}, so it is left out`));
  const before = loadConfig(configFile({ claude: sub(), codex: sub(), plain: sub() }));
  expect([Object.keys(before.config.subscriptions), before.notes]).toEqual([["claude", "codex", "plain"], []]);
});

test("enabled: false on the harness turns off its accounts too", () => {
  const { config } = loadConfig(configFile({ claude: sub({ enabled: false, accounts: { team: "~/claude-team", work: WORK } }), codex: sub({ accounts: { b: CODEX_B } }) }));
  expect(["claude", "claude-team", "claude-work", "codex", "codex-b"].map((n) => config.subscriptions[n].enabled)).toEqual([false, false, false, true, true]);
  expect(enabledSubscriptions(config)).toEqual(["codex", "codex-b"]);
  expect(rankSubscriptions("standard", [], config).excluded).toContainEqual({ subscription: "claude-team", why: "turned off in your settings: routr setup --enable claude" });
});

test("an account is its harness's folder entry and nothing else: the variable names the folder, and is removed where the harness wants its default unnamed", () => {
  const dflt = join(home(), ".testy"), link = join(scratch("accounts-link"), "testy");
  mkdirSync(dflt, { recursive: true });
  const linked = (() => { try { symlinkSync(dflt, link); return link; } catch { return dflt; } })();
  expect(accountAt("testy-b", "testy", B)).toEqual({ name: "testy-b", kind: "testy", dir: B, env: { TESTY_HOME: B } });
  for (const dir of ["~/.testy", `${dflt}/`, join(home(), "x", "..", ".testy"), linked]) expect([dir, accountAt("testy-home", "testy", dir).env]).toEqual([dir, { TESTY_HOME: null }]);
  expect(accountAt("claude-home", "claude", "~/.claude").env).toEqual({ CLAUDE_CONFIG_DIR: null });
  expect(accountAt("claude-work", "claude", "~/.claude-work").env).toEqual({ CLAUDE_CONFIG_DIR: join(home(), ".claude-work") });
  expect(accountAt("codex-b", "codex", "~/.codex").env).toEqual({ CODEX_HOME: join(home(), ".codex") });
  expect(configDirOf("relative")).toBeNull(); expect(configDirOf("/a/../b/")).toBe(resolve("/b")); expect(configDirOf("bad\npath")).toBeNull();
  expect(() => workerAccount({ kind: "codex", subscription: "codex-b", config_dir: "relative" })).toThrow("not a full path");
});

test("two and three accounts under one harness work from entry alone: config, sign-in, usage, kept readings, ranking", async () => withRefresh(async () => {
  const THREE = { testy: sub({ accounts: { b: B, home: "~/.testy", "3": OUT } }) };
  const { config, notes } = loadConfig(configFile(THREE));
  const names = ["testy", "testy-b", "testy-home", "testy-3"];
  expect([Object.keys(config.subscriptions).sort(), notes]).toEqual([names.slice().sort(), []]);
  const dir = scratch("accounts-generic"), file = join(dir, "signed-in.json"), store = memoryStore();
  const readings = (o = {}) => usageReadings({ configPath: null, config, store, clock: { now: () => T + 1 }, starter: { start: () => false }, ...o });
  for (const n of names) {
    const acct = accountOf(n, config) ?? n;
    if (n === "testy-3") expect(await notReady(acct, { file, nowSec: T })).toContain("not signed in");
    else expect(await notReady(acct, { file, nowSec: T })).toBeNull();
  }
  expect(started()).toEqual([{ argv: ["whoami"], dir: "/caller/testy" }, { argv: ["whoami"], dir: B }, { argv: ["whoami"], dir: null }, { argv: ["whoami"], dir: OUT }]);
  rmSync(LOG);
  const rows = (await readings().live(names)).map((s) => s.row);
  expect(rows.map((r) => [r.pool, Math.round(r.headroom * 100), r.signedIn])).toEqual([["testy", 30, undefined], ["testy-b", 80, undefined], ["testy-home", 45, undefined], ["testy-3", 0, false]]);
  expect(rows[3].note).toBe(`not signed in: run \`testy login\` with TESTY_HOME set to ${OUT}`);
  const metered = await readings({ store: memoryStore(), readers: usageReaders({ testy: { source: "testy usage", read: async () => summarize({ pool: "testy", source: "testy usage", nowSec: T }) } }),
    signIn: { state: async () => ({ state: "yes", billing: { billing: "metered", why: "an API key" } }), kept: () => null, why: () => "no" } }).live(["testy-b"]);
  expect([metered[0].row.pool, metered[0].row.source]).toEqual(["testy-b", "testy whoami"]); // its harness's sign-in check, by name
  expect([...store.entries.keys()].sort()).toEqual(names.filter((n) => n !== "testy-3").sort());
  const served = readings().kept(names).served.map((s) => s.row);
  expect(served.map((r) => [r.pool, Math.round(r.headroom * 100)])).toEqual([["testy", 30], ["testy-b", 80], ["testy-home", 45], ["testy-3", 0]]);
  expect(rankSubscriptions("standard", rows, config).ranked.map((r) => [r.subscription, r.usable])).toEqual([["testy-b", 0.7], ["testy-home", 0.35], ["testy", 0.2]]);
  const dryB = await launch(["--kind", "testy-b", "--name", "tb", ...taskFiles().flags, "--direction", "right", "--dry-run"], { env: { HERDR_ENV: "1" }, settings: () => ({ config }) });
  expect(dryB.ok).toBe(true);
  expect(dryB.start.env).toEqual({ TESTY_HOME: "<forwarded>" });
  expect(dryB.would_run.find((c) => c.includes("pane split"))).toContain('--env "TESTY_HOME=<forwarded>"');
  const dryHome = await launch(["--kind", "testy-home", "--name", "th", ...taskFiles().flags, "--direction", "right", "--dry-run"], { env: { HERDR_ENV: "1" }, settings: () => ({ config }) });
  expect(dryHome.ok).toBe(true);
  expect(dryHome.start.env).toEqual({ TESTY_HOME: null });
  expect(dryHome.would_run.find((c) => c.includes("pane split"))).not.toContain("TESTY_HOME");
  expect(dryHome.would_run.some((c) => c.includes("pane run") && c.includes(SHELLS[SHELL].unset("TESTY_HOME")))).toBe(true);
}));

test("sign-in answers of two accounts are kept apart: neither is served for the other", async () => withRefresh(async () => {
  const dir = scratch("accounts-kept"), file = join(dir, "signed-in.json"), asked = [];
  const ask = async (cmd, args, o) => { asked.push(o?.account ?? "the environment's"); return { out: o?.account?.TESTY_HOME === OUT ? "signed out" : "signed in", code: o?.account?.TESTY_HOME === OUT ? 1 : 0 }; };
  const b = accountAt("testy-b", "testy", B), out = accountAt("testy-out", "testy", OUT);
  expect([await signIn("testy", { file, ask, nowSec: T }), await signIn(b, { file, ask, nowSec: T }), await signIn(out, { file, ask, nowSec: T })].map((a) => a.state)).toEqual(["yes", "yes", "no"]);
  expect(asked).toEqual(["the environment's", { TESTY_HOME: B }, { TESTY_HOME: OUT }]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ testy: { ts: T, state: "yes" }, "testy-b": { ts: T, state: "yes" }, "testy-out": { ts: T, state: "no" } });
  asked.length = 0;
  expect((await signIn(b, { file, ask, nowSec: T + 60 })).state).toBe("yes");
  expect(asked).toEqual([]);
  expect(await notReady(out, { file, ask, nowSec: T + 60 })).toBe(`not signed in: run \`testy login\` with TESTY_HOME set to ${OUT}`);
  expect(await notReady(accountAt("testy-h", "testy", "~/.testy"), { file, nowSec: T, ask: async () => ({ out: "signed out", code: 1 }) })).toBe("not signed in: run `testy login` with TESTY_HOME unset");
  expect(await notReady(b, { file, fresh: true, ask: async () => null })).toBe("`testy` did not answer its sign-in check (not installed, or it hung)");
}));

test("Claude Code and Codex read an account with its folder: its variables, its own files, and never the statusline's one snapshot", async () => {
  const dir = scratch("accounts-readers"), calls = [];
  const answer = (result) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, result });
  const exec = async (cmd, args, o) => { calls.push({ cmd, account: o.account }); return cmd === "claude" ? answer("Current session: 20% used\nCurrent week (all models): 10% used") : null; };
  const snapshot = CLAUDE_SNAPSHOT(); mkdirSync(dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, JSON.stringify({ ts: T - 10, rate_limits: { five_hour: { used_percentage: 90, resets_at: T + 3600 } }, answered: true }));
  const work = accountAt("claude-work", "claude", WORK), mine = accountAt("claude-mine", "claude", "~/.claude");
  mkdirSync(join(dir, "shadow", "commands"), { recursive: true }); writeFileSync(join(dir, "shadow", "commands", "usage.md"), "x");
  const plain = await readClaude({ nowSec: T, exec, tmp: dir });
  expect([Math.round(plain.headroom * 100), calls]).toEqual([10, []]);
  const read = await HARNESSES.claude.usage.read({ account: work, nowSec: T, exec, tmp: dir });
  expect([Math.round(read.headroom * 100), calls]).toEqual([80, [{ cmd: "claude", account: { CLAUDE_CONFIG_DIR: WORK } }]]);
  await HARNESSES.claude.usage.read({ account: mine, nowSec: T, exec, tmp: dir }); rmSync(snapshot);
  expect(calls[1]).toEqual({ cmd: "claude", account: { CLAUDE_CONFIG_DIR: null } });
  expect((await readClaude({ account: accountAt("claude-s", "claude", join(dir, "shadow")), nowSec: T, exec, tmp: dir })).failure.code).toBe("command_shadowed");
  expect(calls).toHaveLength(2);
  const sessions = join(dir, "codex-b", "sessions", "2027", "01", "15"); mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout.jsonl"), JSON.stringify({ timestamp: new Date((T - 5) * 1000).toISOString(), payload: { type: "token_count", rate_limits: { primary: { used_percent: 40, window_minutes: 300, resets_at: T + 600 } } } }) + "\n");
  const codex = await HARNESSES.codex.usage.read({ account: accountAt("codex-b", "codex", join(dir, "codex-b")), exec, nowSec: T });
  expect(calls[2]).toEqual({ cmd: "codex", account: { CODEX_HOME: join(dir, "codex-b") } });
  expect([codex.kept?.source ?? codex.note, Math.round(codex.headroom * 100)]).toEqual([expect.stringContaining("session log"), 60]);
  // Claude makes an empty project folder where it ran, in the folder it ran with: that one is removed.
  const own = accountAt("claude-own", "claude", join(dir, "own")); let made;
  await readClaude({ account: own, nowSec: T, tmp: dir, exec: async (cmd, args, o) => { [made] = claudeProjectFolders(o.cwd, join(own.dir, "projects")); mkdirSync(join(made, "memory"), { recursive: true }); return answer("Current session: 20% used\nCurrent week (all models): 10% used"); } });
  expect(existsSync(made)).toBe(false);
});

test("every process start can be handed an account: its variables replace the caller's, a null one is removed, and on Windows in any case", () => {
  const seen = [], via = (...a) => { seen.push(a[2].env); return { on: () => {} }; };
  const env = { PATH: "/bin", TESTY_HOME: "/caller", OTHER: "kept" };
  start("x", [], { env }, { via, platform: "linux", account: { TESTY_HOME: B } });
  start("x", [], { env }, { via, platform: "linux", account: { TESTY_HOME: null } });
  start("x", [], { env }, { via, platform: "linux" });
  expect(seen).toEqual([{ PATH: "/bin", OTHER: "kept", TESTY_HOME: B }, { PATH: "/bin", OTHER: "kept" }, env]);
  expect(seen[2]).toBe(env);
  const win = (account) => terminalEnv({ carriers: {}, config: {}, account }, { Path: "C:\\bin", Testy_Home: "C:\\caller" }, { platform: "win32" });
  expect([win({ TESTY_HOME: "C:\\acct\\b" }), win({ TESTY_HOME: null }), win({})]).toEqual([{ Path: "C:\\bin", TESTY_HOME: "C:\\acct\\b" }, { Path: "C:\\bin" }, { Path: "C:\\bin", Testy_Home: "C:\\caller" }]);
  // Over the lead's own folder that the worker saved, and over a headless turn's environment.
  expect(terminalEnv({ carriers: {}, config: { CLAUDE_CONFIG_DIR: "/lead" }, account: { CLAUDE_CONFIG_DIR: null } }, { PATH: "/bin" })).toEqual({ PATH: "/bin" });
  expect(workerEnv({}, { A: "1" }, { PATH: "/bin", TESTY_HOME: "/caller" }, { TESTY_HOME: B })).toEqual({ PATH: "/bin", A: "1", TESTY_HOME: B });
  expect(paneEnv({ found: carriersFrom({}), plan: { X: "y" }, account: { TESTY_HOME: B } }, { warnings: [], start: { env: {} } }).split).toEqual({ env: { TESTY_HOME: B, X: "y" }, shownEnv: { TESTY_HOME: "<forwarded>", X: "y" } });
  expect([SHELLS.posix.unset("X"), SHELLS.posix.unset("X", true), SHELLS.powershell.unset("X"), SHELLS.cmd.unset("X")]).toEqual(["unset X", "set -e -g X", "Remove-Item -LiteralPath Env:X -ErrorAction SilentlyContinue", "set X="]);
});

test("launch --kind takes the account's name: a pane routr splits is given its folder, or has the variable dropped in its shell, and an existing pane is refused", async () => {
  const { config } = loadConfig(configFile({ ...TESTY, testy2: sub({ accounts: { rel: "relative" } }) }));
  const settings = () => ({ config, notes: [] }), t = taskFiles();
  const go = async (kind, more = [], shellName) => { const f = fakeHerdr(t.dir, "testy", shellName); const r = await launch(["--kind", kind, "--name", "p1", ...t.flags, ...more], { env: { HERDR_ENV: "1" }, settings, run: f.run, now: f.now, sleep: f.sleep, home: scratch("accounts-history") }); return { r, f }; };
  const b = await go("testy-b", ["--direction", "right"]);
  expect([b.r.ok, b.r.state, b.r.kind, b.r.start.env, b.r.headline]).toEqual([true, "prompted", "testy", { TESTY_HOME: "<forwarded>" }, "routr: p1 (testy) took its task in pane w1:p2"]);
  expect(b.r.ran.find((c) => c.includes("pane split"))).toContain('--env "TESTY_HOME=<forwarded>"');
  expect(b.r.next.find((n) => n.template?.startsWith("routr record")).template).toContain("--subscription testy-b");
  expect(b.f.calls.find((a) => a[1] === "split")).toContain(`TESTY_HOME=${B}`);
  const tree = await go("testy-b", ["--worktree", "wt-b"]);
  expect([tree.r.state, tree.f.calls.find((a) => a[1] === "split")]).toEqual(["prompted", expect.arrayContaining([`TESTY_HOME=${B}`])]);
  expect(tree.r.ran.find((c) => c.includes("pane split"))).toContain('--env "TESTY_HOME=<forwarded>"');
  const homeLaunch = await go("testy-home", ["--direction", "right"]);
  expect(homeLaunch.r.start.env).toEqual({ TESTY_HOME: null });
  expect(homeLaunch.f.calls.find((a) => a[1] === "split")).not.toContain("TESTY_HOME");
  expect(homeLaunch.f.text().some((c) => c.includes("pane run") && c.includes(SHELLS[SHELL].unset("TESTY_HOME")))).toBe(true);
  expect(homeLaunch.r.steps).toContainEqual({ step: "unset_env", ok: true, detail: `Removed TESTY_HOME from the pane's ${SHELL} shell` });
  if (process.platform !== "win32") expect((await go("testy-home", ["--direction", "right"], "fish")).f.text().some((c) => c.includes("pane run") && c.includes("set -e -g TESTY_HOME"))).toBe(true);
  const existing = await go("testy-b", ["--pane", "w1:p1"]);
  expect(existing.r.ok).toBe(false);
  expect(existing.r.error).toContain("--pane cannot be used with testy-b: an existing pane keeps its own shell's environment. Leave --pane off, and routr splits a pane with it");
  const continued = await go("testy-b", ["--pane", "w1:p1", "--continue"]);
  expect(continued.r.ok).toBe(true);
  expect(continued.r.ran.find((c) => c.includes("pane split"))).toBeUndefined();
  // routr's own, in help as that; anywhere else it is refused where an unknown option always was, before a later one.
  expect([COMMANDS.launch.flags.find((f) => f.name === "--kind").description, COMMANDS.launch.flags.find((f) => f.name === "--continue").description]).toEqual([expect.stringContaining("an extra account"), expect.stringContaining("routr's own")]);
  expect(COMMANDS.record.flags.find((f) => f.name === "--subscription").description).toContain("or an extra account's name, <harness>-<name>");
  expect(await go("testy", ["--continue", "--bogus"])).toMatchObject({ r: { ok: false, error: expect.stringContaining("Unknown launch option: --continue") } });
  expect(await go("testy", ["--pane", "w1:p1", "--continue"])).toMatchObject({ r: { ok: false, error: expect.stringContaining("Unknown launch option: --continue") } });
  expect(await go("testy-b", ["--continue"])).toMatchObject({ r: { ok: false, error: expect.stringContaining("Unknown launch option: --continue") } });
  for (const none of ["testy2-rel", "nope", "constructor", "__proto__", "toString"]) expect(await go(none)).toMatchObject({ r: { ok: false, error: expect.stringContaining("--kind must be") } });
});

test("a launch counts toward its own subscription, and a turned-off or signed-out account is refused by its name", async () => {
  const history = scratch("accounts-counts"), t = taskFiles();
  const cOff = loadConfig(configFile({ testy: sub({ enabled: false, accounts: { off: B } }) })).config;
  const goOff = (kind) => launch(["--kind", kind, "--name", "p1", ...t.flags, "--direction", "right"], { env: { HERDR_ENV: "1" }, settings: () => ({ config: cOff }), run: fakeHerdr(t.dir, "testy").run, home: history });
  expect((await goOff("testy-off")).error).toContain("Testy is turned off in your settings: turn it on with routr setup --enable testy");
  const c = loadConfig(configFile({ testy: sub({ accounts: { b: B, out: OUT } }) })).config;
  const go = (kind) => launch(["--kind", kind, "--name", "p1", ...t.flags, "--direction", "right"], { env: { HERDR_ENV: "1" }, settings: () => ({ config: c }), run: fakeHerdr(t.dir, "testy").run, home: history });
  expect((await go("testy-out")).error).toContain(`not signed in: run \`testy login\` with TESTY_HOME set to ${OUT}`);
  expect((await go("testy-b")).state).toBe("prompted");
  expect(readHistory({ home: history }).records.map((r) => [r.subscription, r.model, r.effort, r.project, r.backend, r.name])).toEqual([["testy-b", "model-a", null, basename(t.dir), "pane", "p1"]]);
});

test("in the Herdr app, the worker's record keeps its account, and its runner starts the harness with it over the caller's and the core's", async () => {
  const { config } = loadConfig(configFile(TESTY)), t = taskFiles(), seen = {};
  let clock = 0;
  for (const [kind, name] of [["testy-b", "tb"], ["testy-home", "th"], ["testy", "tp"]]) {
    const r = await launch(["--kind", kind, "--name", name, ...t.flags], { env: { ...CORE, TESTY_HOME: "/caller/testy" }, settings: () => ({ config }), hc: fakeHc(name), self: (a) => ["/bin/routr", ...a], now: () => (clock += 100), home: scratch("accounts-history") });
    expect([name, r.ok, r.error]).toEqual([name, true, undefined]);
    const dir = r.worker.run, w = JSON.parse(readFileSync(join(dir, "worker.json"), "utf8"));
    seen[name] = { start: r.start.env, subscription: w.subscription, config_dir: w.config_dir };
    rmSync(LOG, { force: true });
    const code = await runWorker(dir, w.id, { env: { ...process.env, TESTY_HOME: "/core/testy" }, say: () => {}, on: () => {}, begin: (cmd, args, opts, seams) => start(cmd, ["whoami"], { ...opts, stdio: "ignore" }, seams) });
    seen[name].ran = [code, started().map((s) => s.dir)];
  }
  expect(seen.tb).toEqual({ start: { TESTY_HOME: "<forwarded>" }, subscription: "testy-b", config_dir: B, ran: [0, [B]] });
  expect(seen.th).toEqual({ start: { TESTY_HOME: null }, subscription: "testy-home", config_dir: join(home(), ".testy"), ran: [0, [null]] });
  expect(seen.tp).toEqual({ start: {}, subscription: undefined, config_dir: undefined, ran: [0, ["/core/testy"]] });
});

const FAKE_CLAUDE = `
const fs = require("node:fs"), a = process.argv.slice(2);
if (a[0] === "auth") { console.log(JSON.stringify({ loggedIn: process.env.CLAUDE_CONFIG_DIR !== "/signed-out", authMethod: "claude.ai" })); process.exit(0); }
if (a.includes("/usage")) { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: "Current session: " + (process.env.CLAUDE_CONFIG_DIR ? 20 : 60) + "% used\\nCurrent week (all models): 10% used" })); process.exit(0); }
if (!a.includes("--input-format")) process.exit(0);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.env.CLAUDE_CONFIG_DIR ?? null) + "\\n");
const sid = a.includes("--resume") ? a[a.indexOf("--resume") + 1] : "11111111-2222-3333-4444-555555555555";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { buf = buf.slice(i + 1); out({ type: "system", subtype: "init", session_id: sid }); out({ type: "result", subtype: "success", is_error: false, result: "VERDICT: done" }); } });
process.stdin.on("end", () => process.exit(0));
`;
test("outside herdr, every turn of a worker runs on its account, whoever sends the next message and from whatever environment", async () => {
  const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rs-")), bin = join(root, "bin"), work = join(root, "work");
  for (const d of [bin, work, join(root, ".config", "routr")]) mkdirSync(d, { recursive: true });
  fakeExecutable(bin, "claude", FAKE_CLAUDE);
  writeFileSync(join(root, ".config", "routr", "config.json"), JSON.stringify({ subscriptions: { claude: sub({ accounts: { team: WORK, mine: "~/.claude" } }) } }));
  const task = join(root, "task.md"), more = join(root, "more.md"); writeFileSync(task, "Rename foo to bar in x.js."); writeFileSync(more, "Also rename baz.");
  const env = cliEnv(root, { PATH: [bin, dirname(process.execPath)].join(delimiter), ROUTR_NO_UPDATE: "1" });
  for (const k of Object.keys(env)) if (/^(HERDR_|HC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|SANDBOX_RUNTIME$|CODEX_|TRACEPARENT$|TRACESTATE$|BAGGAGE$)/i.test(k)) delete env[k];
  const cli = (args, over = {}) => { const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: work, env: { ...env, ...over }, stdin: "ignore" }); try { return JSON.parse(r.stdout.toString()); } catch { return { raw: r.stdout.toString() + r.stderr.toString() }; } };
  const advice = join(root, "advice.json"), dispatched = cli(["dispatch", "--task-file", task]); writeFileSync(advice, JSON.stringify(dispatched));
  const room = (r) => Object.fromEntries(r.subscriptions.ranked.map((s) => [s.subscription, s.headroom]));
  expect([room(dispatched), room(cli(["usage"]))]).toEqual(Array(2).fill({ claude: 0.4, "claude-team": 0.8, "claude-mine": 0.4 }));
  const one = cli(["usage", "claude-team"]);
  expect([one.ok, one.subscription, room(one)]).toEqual([true, "claude-team", { "claude-team": 0.8 }]);
  const state = (n) => { try { return JSON.parse(readFileSync(join(root, ".local", "state", "routr", "workers", n, "state.json"), "utf8")).state; } catch { return null; } };
  const settled = async (n) => { for (let i = 0; i < 300; i++) { if (state(n) && !["working", "waiting", "starting"].includes(state(n))) return true; await Bun.sleep(50); } return false; };
  const turns = {};
  rmSync(join(root, ".cache", "routr", "signed-in.json"), { force: true }); // every launch and send below asks again
  try {
    for (const kind of ["claude-team", "claude-mine", "claude"]) {
      const log = join(root, `${kind}.jsonl`), at = { FAKE_LOG: log }, from = (dir) => ({ ...at, CLAUDE_CONFIG_DIR: kind === "claude" ? dir : "/signed-out" });
      const l = cli(["launch", "--kind", kind, "--name", `w-${kind}`, "--model", "haiku", "--task-file", task, "--advice", advice], from("/launcher/claude"));
      expect([kind, l.state, l.error, l.start.env.CLAUDE_CONFIG_DIR]).toEqual([kind, "prompted", undefined, { "claude-team": "<forwarded>", "claude-mine": null }[kind]]);
      expect(cli(["wait", "--name", `w-${kind}`, "--timeout", "20000"], at).state).toBe("finished");
      expect(await settled(`w-${kind}`)).toBe(true);
      expect(cli(["send", "--name", `w-${kind}`, "--task-file", more], from("/sender/claude")).state).toBe("resumed");
      expect(cli(["wait", "--name", `w-${kind}`, "--timeout", "20000"], at).state).toBe("finished");
      expect(await settled(`w-${kind}`)).toBe(true);
      turns[kind] = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    }
    expect(turns["claude-team"]).toEqual([WORK, WORK]);
    expect(turns["claude-mine"]).toEqual([null, null]);
    expect(turns.claude).toEqual(["/launcher/claude", "/sender/claude"]);
  } finally { for (const kind of ["claude-team", "claude-mine", "claude"]) { cli(["stop", "--name", `w-${kind}`]); cli(["cleanup", "--worker", `w-${kind}`]); } rmSync(root, { recursive: true, force: true }); }
}, 120000);

test("a subscription name of the user's own never leaves the machine: telemetry and OpenTelemetry send a harness's name or other, and no reading of it; its effort is read from its harness's settings", async () => {
  const { telemetryRows } = await import("../src/lib/telemetry.mjs");
  const [sent] = telemetryRows([row({ chose: { subscription: "claude-team", model: "m", effort: "high", level: "standard" }, headroom: { "claude-team": { usable: 0.3, usage: "live" } } })], "install-a");
  expect(sent.chose.subscription).toBe("other");
  expect(JSON.stringify(sent)).not.toContain("claude-team");
  const f = install("http://127.0.0.1:4318"), reading = summarize({ pool: "claude-team", source: "claude /usage", ts: T, nowSec: T + 1, windows: [{ name: "five_hour", usedPct: 25 }] });
  await commandTrace("usage", { config: f.config, env: {}, otel: f.opts }, () => usageSpans(async () => [reading]));
  const queued = existsSync(f.root) ? (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: f.root, onlyFiles: true }))).map((p) => readFileSync(join(f.root, p), "utf8")).join("\n") : "";
  expect(queued).not.toContain("claude-team");
  const config = { subscriptions: { claude: sub({ default_effort: "high", accounts: { team: "~/claude-team" } }), cursor: sub() } };
  const loaded = loadConfig(configFile(config.subscriptions)).config;
  expect(resolveEffort({ subscription: "claude-team", model: "m", effort: "default" }, loaded)).toEqual({ effort: "high", effort_from: "config default" });
  expect(resolveEffort({ subscription: "cursor", model: "grok-4.7-medium-fast", effort: null }, loaded)).toEqual({ effort: "medium", effort_from: "model id" });
});

test("setup --force rebuilds the settings and keeps accounts", async () => {
  const { setup } = await import("../src/lib/setup.mjs");
  const path = join(scratch("accounts-setup"), "config.json");
  const before = { subscriptions: { claude: sub({ accounts: { team: "~/claude-team", work: "~/.claude-work" } }), codex: sub({ default_model: "m", accounts: { b: "~/codex-b" } }), cursor: sub() } };
  writeFileSync(path, JSON.stringify(before));
  const inspect = async () => ({ harnesses: Object.fromEntries(["claude", "codex", "cursor", "agy", "kiro"].map((n) => [n, { installed: n === "claude", signed_in: n === "claude", models: [], usage_class: "included" }])),
    config: { path, exists: true, subscriptions: Object.keys(before.subscriptions), off: [], notes: [], problems: [] }, decision: [{ works: true }], herdr: { path: "/bin/herdr", inside_session: true, skill: true }, core: { path: null },
    skill: [{ where: "~/.agents/skills/routr", version: "0.0.0-dev" }, { name: "routr-orchestrate", where: "~/.agents/skills/routr-orchestrate", version: "0.0.0-dev" }],
    auto_update: { on: false, why_off: "running from source", channel: "stable" }, next_steps: [] });
  const r = await setup(["--config", path, "--yes", "--force"], { inspect, install: () => {}, share: () => {}, key: async () => ({ ok: true }), hasKey: () => true, print: () => {} });
  expect(r.ok).toBe(true);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect([saved.subscriptions.claude.accounts, saved.subscriptions.codex?.accounts]).toEqual([{ team: "~/claude-team", work: "~/.claude-work" }, { b: "~/codex-b" }]);
});

test("routr statusline saves no snapshot for a folder the config gives an account under accounts, and saves it as before for any other", () => {
  const dir = scratch("accounts-statusline"), cfgDir = join(dir, ".config/routr");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ subscriptions: { claude: sub({ accounts: { work: WORK, mine: "~/.claude" } }) } }));
  const snap = join(dir, ".cache/routr/claude-usage.json");
  const runWith = (env) => {
    rmSync(snap, { force: true });
    Bun.spawnSync([process.execPath, SCRIPT, "statusline"], { env: cliEnv(dir, { CLAUDE_CONFIG_DIR: env }), stdin: Buffer.from(JSON.stringify({ model: { display_name: "Claude" }, rate_limits: { five_hour: { used_percentage: 10 } } })) });
    return existsSync(snap);
  };
  expect([runWith(WORK), runWith(undefined), runWith(join(dir, ".claude-other"))]).toEqual([false, false, true]);
});

test("a pane launch for an account that stops at needs_input is continued by the --pane rerun it offers", async () => {
  const { config } = loadConfig(configFile(TESTY)), t = taskFiles(), f = fakeHerdr(t.dir, "testy"), o = { env: { HERDR_ENV: "1" }, settings: () => ({ config }), now: f.now, sleep: f.sleep, home: scratch("accounts-history") };
  let gets = 0;
  o.run = async (a) => (a[0] === "agent" && a[1] === "get" ? { ok: true, data: { result: { agent: { agent: "testy", agent_status: gets++ ? "idle" : "blocked", cwd: t.dir } } } }
    : a[0] === "agent" && a[1] === "explain" ? { ok: true, data: { result: { state: "blocked", matched_rule: { id: "trust_folder" } } } } : f.run(a));
  const first = await launch(["--kind", "testy-home", "--name", "p1", ...t.flags, "--direction", "right"], o);
  const rerun = first.next.find((n) => n.kind === "run" && n.argv.includes("--pane")).argv;
  expect([first.state, rerun.slice(-5)]).toEqual(["needs_input", ["--pane", first.pane, "--cwd", t.dir, "--continue"]]);
  expect(await launch(rerun.slice(2), o)).toMatchObject({ ok: true, state: "prompted", kind: "testy", start: { env: { TESTY_HOME: null } } });
  expect(f.text().filter((c) => c.includes(SHELLS[SHELL].unset("TESTY_HOME")))).toHaveLength(1); // typed once, into the shell: never at the agent the rerun finds there
  gets = 0; // stopped again: the rerun it offers carries routr's --continue once
  expect((await launch(rerun.slice(2), o)).next.find((n) => n.kind === "run" && n.argv.includes("--pane")).argv.filter((a) => a === "--continue")).toEqual(["--continue"]);
});

test("routr board ranks an account from its kept reading, and leaves a signed-out one out by its harness's step", async () => {
  const { boardCommand } = await import("../src/lib/board.mjs");
  const { config } = loadConfig(configFile({ testy: sub({ accounts: { b: B, out: OUT } }) })), dir = scratch("accounts-board");
  // Kept as a live read keeps them: each sign-in answer and reading under its own name, in routr's own cache.
  for (const n of ["testy", "testy-b", "testy-out"]) { await signIn(accountOf(n, config) ?? n, { fresh: true }); fileStore().put(n, { source: "testy usage", takenAt: Date.now() / 1000, windows: [{ name: "week", usedPct: 20 }] }); }
  const b = await boardCommand([], config, { ledger: join(dir, "ledger.jsonl") });
  expect([b.subscriptions.ranked.map((r) => r.subscription), b.subscriptions.excluded]).toEqual([["testy", "testy-b"], [{ subscription: "testy-out", why: `not signed in: run \`testy login\` with TESTY_HOME set to ${OUT}` }]]);
});

test("smoke:usage reads each extra account after the harnesses, as its harness is, with its folder", async () => {
  const { smokeUsage } = await import("../scripts/smoke-usage.mjs");
  const { config } = loadConfig(configFile(TESTY)), asked = [], lines = [];
  const live = { testy: async (a) => summarize({ pool: "testy", source: "testy usage", ts: T, nowSec: T, windows: [{ name: "week", usedPct: a?.dir === B ? 20 : 50 }] }) };
  await smokeUsage({ config, live, ready: async (n) => { asked.push(n.env ?? n); return null; }, billing: async () => ({ billing: null, not: null }), log: (l) => lines.push(l.replace(/ \([^)]*, [\d.]+ s\)$/, "")) });
  expect([asked, lines]).toEqual([["testy", { TESTY_HOME: B }, { TESTY_HOME: null }], ["testy: ok: 50% left", "testy-b: ok: 80% left", "testy-home: ok: 50% left"]]);
  // Its billing is what its own sign-in answer says, and the step for one signed out names its folder.
  lines.length = 0; await smokeUsage({ config: loadConfig(configFile({ testy: sub({ accounts: { out: OUT } }) })).config, live, ready: async () => null, log: (l) => lines.push(l.replace(/ \([^)]*, [\d.]+ s\)$/, "")) });
  expect(lines).toEqual(["testy: ok: 50% left", `testy-out: not signed in: run \`testy login\` with TESTY_HOME set to ${OUT}, not read`]);
});

test("smoke:telemetry takes an extra account sent as other for what it is, not data lost", () => {
  const root = scratch("accounts-telemetry"), ledger = join(root, ".local/share/routr/ledger.jsonl");
  for (const d of [dirname(ledger), join(root, ".config/routr")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, ".config/routr/config.json"), JSON.stringify({ subscriptions: { claude: sub({ accounts: { work: WORK } }) } }));
  const smoke = (subscription) => { writeFileSync(ledger, JSON.stringify(row({ chose: { ...row().chose, subscription } })) + "\n"); return Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/smoke-telemetry.mjs")], { env: cliEnv(root), stdin: "ignore" }).stdout.toString(); };
  expect([smoke("claude-work"), smoke("claude-gone")].map((out) => out.includes("chose.subscription"))).toEqual([false, true]);
});

test("doctor's default_model line is the harness's alone: an extra account takes its harness's settings", () => {
  const dir = scratch("accounts-doctor"), doc = JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json", "--config", configFile({ claude: sub({ accounts: { work: WORK } }) })], { env: cliEnv(dir, { PATH: dir, ROUTR_NO_UPDATE: "1" }) }).stdout.toString());
  expect(doc.config.notes.filter((n) => n.includes("default_model"))).toEqual(["subscriptions.claude: no default_model set; the orchestrator will pick from the harness's live list"]);
});

test("doctor asks each extra account afresh with its folder: a signed-in harness does not hide a signed-out account, which gets its own step", () => {
  const dir = scratch("accounts-doctor");
  fakeExecutable(dir, "claude", `console.log(JSON.stringify({ loggedIn: process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(WORK)} }));`);
  // Kept as signed in a moment ago: doctor asks again.
  mkdirSync(join(dir, ".cache/routr"), { recursive: true }); writeFileSync(join(dir, ".cache/routr/signed-in.json"), JSON.stringify({ "claude-work": { ts: Date.now() / 1000, state: "yes" } }));
  const doc = JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json", "--config", configFile({ claude: sub({ accounts: { work: WORK } }) })], { env: cliEnv(dir, { PATH: dir, ROUTR_NO_UPDATE: "1" }) }).stdout.toString());
  expect([doc.harnesses.claude.signed_in, doc.accounts["claude-work"].signed_in]).toEqual([true, false]);
  expect(doc.next_steps).toContain(`claude-work is set up in routr but gets no work: not signed in: run \`claude auth login\` with CLAUDE_CONFIG_DIR set to ${WORK}`);
});

test("doctor gives each extra account a line of its own, and its own step when its reader has failed for over a day, naming its harness as what an update may have changed", () => {
  const dir = scratch("accounts-doctor"), stopped = join(dir, "stopped"), log = join(stopped, "sessions", "2026", "11", "10");
  // Codex is signed in and its app server does not answer; one account's session log last held limits 30 hours ago, with no number.
  fakeExecutable(dir, "codex", `process.argv[2] === "login" ? console.error("Logged in using ChatGPT") : process.exit(1);`);
  mkdirSync(log, { recursive: true });
  writeFileSync(join(log, "rollout.jsonl"), JSON.stringify({ timestamp: new Date(Date.now() - 30 * 3600000).toISOString(), payload: { rate_limits: { primary: {} } } }) + "\n");
  const config = configFile({ codex: sub({ accounts: { b: CODEX_B, stopped } }) });
  const doctor = (...more) => Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--config", config, ...more], { env: cliEnv(dir, { PATH: dir, ROUTR_NO_UPDATE: "1" }) }).stdout.toString();
  const doc = JSON.parse(doctor("--json")), stale = "codex-stopped's usage has not been read for 30 h, and its last try failed (no_response), so remaining capacity is unknown: an update of codex or herdr may have changed what routr reads. Try reading codex-stopped's usage again: routr usage codex-stopped";
  expect([doc.accounts["codex-b"].usage_stale, doc.accounts["codex-stopped"].usage_stale]).toEqual([undefined, stale]);
  expect(doc.next_steps).toContain(stale);
  expect(doctor()).toContain("ok codex-b codex account · usage none: ");
});

test("a failed read of an extra account's usage gives its harness's step by hand, with its folder and its own name", () => {
  const { config } = loadConfig(configFile({ codex: sub({ accounts: { b: CODEX_B } }) }));
  expect(capacityView("basic", [failedUsage("codex-b", "codex app-server")], config).next).toContainEqual({ kind: "do", why: `Read codex-b's usage by hand with CODEX_HOME set to ${CODEX_B}: open Codex and read /status, then pass --headroom codex-b=<share left>`, template: "--headroom codex-b=<share left>" });
});

test("assess points an extra account's reserve suggestion at its harness's reserve, the setting it takes", () => {
  const { config } = loadConfig(configFile({ claude: sub({ accounts: { work: WORK } }) }));
  expect(assess(Array.from({ length: 5 }, () => row({ headroom: { "claude-work": { usable: 0 } } })), config)).toContain("subscriptions.claude.reserve: it was at its reserve in 5 of 5 dispatches");
});
