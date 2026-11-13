// More than one account of a harness: extra accounts configured under `accounts: { "<name>": "<folder>", ... }`
// are checked, read, kept, ranked and launched with their folder, from nothing but their harness's `folder` entry
// in the registry. The first harness here is the test's own, so nothing can lean on Claude Code or Codex; theirs follow.
// A harness entry with no `accounts` is the account the environment names.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { enabledSubscriptions, loadConfig } from "../src/lib/config.mjs";
import { accountAt, accountOf, HARNESSES, sameLogin, sourceKey, KINDS, notReady, savedAccount, signIn, SOURCES, workerAccount } from "../src/lib/harnesses.mjs";
import { runWorker } from "../src/lib/backend-terminal.mjs";
import { keptSignIn } from "../src/lib/signin.mjs";
import { FISH_PATH, SHELLS } from "../src/lib/herdr.mjs";
import { readHistory } from "../src/lib/launch-history.mjs";
import { assess, briefSha, resolveEffort } from "../src/lib/ledger.mjs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { CLAUDE_SNAPSHOT, configDirOf, folderSha, home } from "../src/lib/state-files.mjs";
import { capacityView } from "../src/lib/capacity.mjs";
import { run, start } from "../src/lib/processes.mjs";
import { terminalEnv, workerEnv } from "../src/lib/worker-env.mjs";
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
  folder: { variable: "TESTY_HOME", default: ".testy", unnamed: true },
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

test("an account takes its harness's settings but for the ones it states, and is turned off on its own", () => {
  const { config, notes } = loadConfig(configFile({ claude: sub({ enabled: false, default_model: "m", use: "fallback", accounts: { team: "~/claude-team", work: { folder: WORK, reserve: 0.4, hardest_work: "basic", billing: "metered", use: "normal", share: 3, default_model: "w" }, off: { folder: OUT, enabled: false },
    odd: { folder: "~/odd", reserve: 2, hardest_work: "huge", billing: "free" }, nowhere: { reserve: 0.2 }, twin: "~/claude-team/" } }), codex: sub({ accounts: { b: CODEX_B } }) }));
  const of = (n) => config.subscriptions[n];
  // A harness turned off leaves its accounts on: each is turned off by its own `enabled`.
  expect(["claude", "claude-team", "claude-work", "claude-off", "codex", "codex-b"].map((n) => of(n).enabled)).toEqual([false, true, true, false, true, true]);
  expect(enabledSubscriptions(config)).toEqual(["codex", "claude-team", "claude-work", "claude-odd", "codex-b"]);
  expect(of("claude-team")).toMatchObject({ reserve: 0.1, hardest_work: "strong", default_model: "m", use: "fallback", billing: null, share: null });
  expect(of("claude-work")).toMatchObject({ harness: "claude", config_dir: WORK, reserve: 0.4, hardest_work: "basic", billing: "metered", use: "normal", share: 3, default_model: "w" });
  // A setting it states that routr cannot take is its harness's, with a note; one with no folder is left out.
  expect(of("claude-odd")).toMatchObject({ reserve: 0.1, hardest_work: "strong", billing: null });
  expect(of("claude-nowhere")).toBeUndefined();
  expect(notes).toEqual(["subscriptions.claude.accounts.nowhere: folder undefined is not a full path or one under ~/, so it is left out",
    "subscriptions.claude.accounts.twin: its folder is claude-team's too, and one folder is one account, so it is left out",
    'subscriptions.claude.accounts.odd.hardest_work: "huge" is not a level, so its harness\'s is used', "subscriptions.claude.accounts.odd.reserve: 2 is not a share from 0 to 1, so its harness's is used",
    'subscriptions.claude.accounts.odd.billing: "free" is not one of included, metered, using the harness\'s own reading']);
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

test("a worker's record keeps whether its folder variable was removed: a later turn from another home folder is refused", () => {
  const dflt = join(home(), ".testy"), was = [process.env.HOME, process.env.USERPROFILE];
  const w = { kind: "testy", ...savedAccount(accountAt("testy-home", "testy", "~/.testy")) }, b = { kind: "testy", ...savedAccount(accountAt("testy-b", "testy", B)) };
  let there; process.env.HOME = process.env.USERPROFILE = scratch("accounts-other-home");
  try {
    there = { kind: "testy", ...savedAccount(accountAt("testy-home", "testy", dflt)) };
    expect(() => workerAccount(w)).toThrow(`testy-home's folder ${dflt} was its harness's default when it was launched, and here the default, ${join(home(), ".testy")}, is another folder: this worker runs only where the default is still ${dflt}`);
    expect(workerAccount(b).env).toEqual({ TESTY_HOME: B });
    expect(workerAccount({ kind: "testy", subscription: "testy-home", config_dir: dflt }).env).toEqual({ TESTY_HOME: dflt });
  } finally { [process.env.HOME, process.env.USERPROFILE] = was; }
  expect(workerAccount(there).env).toEqual({ TESTY_HOME: dflt }); // launched where it was not the default: set here too
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
  expect([...store.entries.keys()].sort()).toEqual(names.filter((n) => n !== "testy-3").map((n) => sourceKey(n, config)).sort()); // each under its login's source key
  const served = readings().kept(names).served.map((s) => s.row);
  expect(served.map((r) => [r.pool, Math.round(r.headroom * 100)])).toEqual([["testy", 30], ["testy-b", 80], ["testy-home", 45], ["testy-3", 0]]);
  expect(rankSubscriptions("standard", rows, config).ranked.map((r) => [r.subscription, r.usable])).toEqual([["testy-b", 0.7], ["testy-home", 0.35], ["testy", 0.2]]);
  const dryB = await launch(["--subscription", "testy-b", "--name", "tb", ...taskFiles().flags, "--direction", "right", "--dry-run"], { env: { HERDR_ENV: "1" }, settings: () => ({ config }) });
  expect(dryB.ok).toBe(true);
  expect(dryB.start.env).toEqual({ TESTY_HOME: "<forwarded>" });
  expect(dryB.would_run.find((c) => c.includes("pane run"))).toContain("TESTY_HOME=");
  const dryHome = await launch(["--subscription", "testy-home", "--name", "th", ...taskFiles().flags, "--direction", "right", "--dry-run"], { env: { HERDR_ENV: "1" }, settings: () => ({ config }) });
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
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ [sourceKey("testy")]: { ts: T, state: "yes" }, [`testy~${folderSha(B)}`]: { ts: T, state: "yes" }, [`testy~${folderSha(OUT)}`]: { ts: T, state: "no" } }); // by login: the harness and its folder, never a path
  asked.length = 0;
  expect((await signIn(b, { file, ask, nowSec: T + 60 })).state).toBe("yes");
  expect(asked).toEqual([]);
  expect(await notReady(out, { file, ask, nowSec: T + 60 })).toBe(`not signed in: run \`testy login\` with TESTY_HOME set to ${OUT}`);
  expect(await notReady(accountAt("testy-h", "testy", "~/.testy"), { file, nowSec: T, ask: async () => ({ out: "signed out", code: 1 }) })).toBe("not signed in: run `testy login` with TESTY_HOME unset");
  expect(await notReady(b, { file, fresh: true, ask: async () => null })).toBe("`testy` did not answer its sign-in check (not installed, or it hung)");
}));

test("a name pointed at another folder is asked again: its kept answer counts only for the folder it was asked with", async () => {
  const file = join(scratch("accounts-moved"), "signed-in.json"), asked = [];
  const ask = async (cmd, args, o) => { asked.push(o.account.TESTY_HOME); return { out: o.account.TESTY_HOME === OUT ? "signed out" : "signed in", code: o.account.TESTY_HOME === OUT ? 1 : 0 }; };
  expect(await notReady(accountAt("testy-b", "testy", B), { file, ask, nowSec: T })).toBeNull();
  // The same name on a signed-out folder (a typo fixed, an account swapped, another config file's), within the 6 hours.
  expect(await notReady(accountAt("testy-b", "testy", OUT), { file, ask, nowSec: T + 60 })).toBe(`not signed in: run \`testy login\` with TESTY_HOME set to ${OUT}`);
  expect([asked, keptSignIn("testy-b", { file })]).toEqual([[B, OUT], null]); // nothing is kept by the name
});

test("a kept sign-in counts only with the account's variable as it was asked: set and removed are asked apart", async () => {
  const file = join(scratch("accounts-modes"), "signed-in.json"), dir = join(home(), ".testy"), asked = [];
  const ask = async (cmd, args, o) => { asked.push(o.account.TESTY_HOME); return o.account.TESTY_HOME === null ? { out: "signed in", code: 0 } : { out: "signed out", code: 1 }; };
  expect((await signIn(accountAt("testy-h", "testy", dir), { file, ask, nowSec: T })).state).toBe("yes");
  expect((await signIn(accountAt("testy-h", "testy", dir, false), { file, ask, nowSec: T + 1 })).state).toBe("no");
  expect(asked).toEqual([null, dir]);
});


test("a name pointed at another folder has no kept reading of the old folder's: each folder's is kept apart, and a late refresh lands on its own", async () => {
  const store = memoryStore(), C = resolve("/acct/c"), claims = [], keys = ["testy-b"];
  let now = T;
  const at = (b) => usageReadings({ configPath: null, config: loadConfig(configFile({ testy: sub({ accounts: { b } }) })).config, store, clock: { now: () => now },
    starter: { start: (argv) => claims.push(argv[argv.indexOf("--claim") + 1]) }, signIn: { state: async () => ({ state: "yes" }), kept: () => null, why: () => "no" } });
  const room = (r) => r.kept(keys, { mayRefresh: [] }).served[0].row.headroom;
  await at(B).live(keys);
  now += 3600; at(B).kept(keys); // B's refresh is claimed, and runs late
  expect([room(at(B)), room(at(C))]).toEqual([0.8, null]);
  await at(C).live(keys); await at(B).refreshClaimed(claims[0]);
  expect(room(at(C))).toBeCloseTo(0.3); // B's late refresh did not land on C
  expect([claims.length, room(at(B))]).toEqual([1, 0.8]); // pointed back: B's own reading, as its refresh kept it
  expect([...store.entries.keys()].sort()).toEqual([`testy~${folderSha(B)}`, `testy~${folderSha(C)}`].sort());
});

test("a refresh claimed for a folder no name is on any more reads nothing: never that key from another login", async () => {
  const store = memoryStore(), claims = [];
  let now = T;
  const at = (accounts) => usageReadings({ configPath: null, config: loadConfig(configFile({ testy: sub({ accounts }) })).config, store, clock: { now: () => now },
    starter: { start: (argv) => claims.push(argv[argv.indexOf("--claim") + 1]) }, signIn: { state: async () => ({ state: "yes" }), kept: () => null, why: () => "no" } });
  await at({ b: B }).live(["testy-b"]);
  now += 3600; at({ b: B }).kept(["testy-b"]);
  const before = structuredClone(store.entries.get(`testy~${folderSha(B)}`).reading);
  rmSync(LOG, { force: true });
  await at({}).refreshClaimed(claims[0]); // the account was removed from the config before its refresh ran
  expect([existsSync(LOG), store.entries.get(`testy~${folderSha(B)}`).reading]).toEqual([false, before]);
});

test("in an environment that names an extra account's folder, the harness's own entry is that login: one key, and ranked once, as the account", async () => {
  const { config } = loadConfig(configFile({ testy: sub({ accounts: { b: B, home: "~/.testy" } }) }));
  const here = { TESTY_HOME: B }, plain = {};
  expect([sourceKey("testy", config, here), sourceKey("testy-b", config, here), sameLogin("testy", config, here)]).toEqual([`testy~${folderSha(B)}`, `testy~${folderSha(B)}`, "testy-b"]);
  // With the variable unset it is the default folder's login, which an account listing that folder is too.
  expect([sourceKey("testy", config, plain), sourceKey("testy-home", config, plain), sameLogin("testy", config, plain)]).toEqual(["testy", "testy", "testy-home"]);
  expect(sameLogin("testy", config, { TESTY_HOME: OUT })).toBeNull();
  // An account turned off stands in for nothing: the harness's own entry is the login's one name, and is ranked.
  const off = loadConfig(configFile({ testy: sub({ accounts: { b: { folder: B, enabled: false } } }) })).config;
  expect(sameLogin("testy", off, here)).toBeNull();
  const was = process.env.TESTY_HOME; process.env.TESTY_HOME = B;
  try {
    rmSync(LOG, { force: true });
    const names = ["testy", "testy-b", "testy-home"], readings = usageReadings({ configPath: null, config, store: memoryStore(), clock: { now: () => T }, starter: { start: () => false }, signIn: { state: async () => ({ state: "yes" }), kept: () => null, why: () => "no" } });
    const rows = (await readings.live(names)).map((x) => x.row), r = rankSubscriptions("standard", rows, config);
    expect([r.ranked.map((x) => x.subscription).sort(), r.excluded]).toEqual([["testy-b", "testy-home"], [{ subscription: "testy", why: "the same account as testy-b here: TESTY_HOME names its folder" }]]);
    expect(started().map((c) => c.dir).sort()).toEqual([B, null].sort()); // the login is read once, as the account
    expect(readings.kept(names, { mayRefresh: [] }).served[0].row).toMatchObject({ pool: "testy", sameAs: "testy-b" });
    const offRows = (await usageReadings({ configPath: null, config: off, store: memoryStore(), clock: { now: () => T }, starter: { start: () => false }, signIn: { state: async () => ({ state: "yes" }), kept: () => null, why: () => "no" } })
      .live(enabledSubscriptions(off))).map((x) => x.row);
    expect(rankSubscriptions("standard", offRows, off).ranked.map((x) => x.subscription)).toEqual(["testy"]);
  } finally { if (was === undefined) delete process.env.TESTY_HOME; else process.env.TESTY_HOME = was; }
});

test.skipIf(process.platform === "win32")("a folder named through a link is kept as its target: pointed elsewhere, its kept sign-in and kept reading are none", async () => {
  const root = scratch("accounts-link"), a = join(root, "a"), b = join(root, "b"), seat = join(root, "seat"), file = join(root, "signed-in.json"), asked = [];
  for (const d of [a, b]) mkdirSync(d);
  symlinkSync(a, seat);
  const ask = async (cmd, args, o) => { asked.push(realpathSync(o.account.TESTY_HOME)); return { out: "signed in", code: 0 }; };
  const store = memoryStore(), readings = () => usageReadings({ configPath: null, config: loadConfig(configFile({ testy: sub({ accounts: { b: seat } }) })).config, store, clock: { now: () => T },
    signIn: { state: async () => ({ state: "yes" }), kept: () => null, why: () => "no" } });
  await notReady(accountAt("testy-b", "testy", seat), { file, ask, nowSec: T });
  await readings().live(["testy-b"]);
  rmSync(seat); symlinkSync(b, seat);
  await notReady(accountAt("testy-b", "testy", seat), { file, ask, nowSec: T + 60 });
  expect([asked, readings().kept(["testy-b"], { mayRefresh: [] }).served[0].row.headroom]).toEqual([[realpathSync(a), realpathSync(b)], null]);
});

test("Claude Code and Codex read an account with its folder: its variables, its own files, and its own statusline snapshot, never another folder's", async () => {
  const dir = scratch("accounts-readers"), calls = [];
  const answer = (result) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, result });
  const exec = async (cmd, args, o) => { calls.push({ cmd, account: o.account }); return cmd === "claude" ? answer("Current session: 20% used\nCurrent week (all models): 10% used") : null; };
  const snapshot = CLAUDE_SNAPSHOT(); mkdirSync(dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, JSON.stringify({ ts: T - 10, rate_limits: { five_hour: { used_percentage: 90, resets_at: T + 3600 } }, answered: true }));
  const work = accountAt("claude-work", "claude", WORK), mine = accountAt("claude-mine", "claude", "~/.claude");
  mkdirSync(join(dir, "shadow", "commands"), { recursive: true }); writeFileSync(join(dir, "shadow", "commands", "usage.md"), "x");
  // The caller's own folder has no snapshot, so the default folder's is not its reading either: Claude is asked.
  const callers = await readClaude({ nowSec: T, exec, tmp: dir });
  expect([Math.round(callers.headroom * 100), calls.splice(0)]).toEqual([80, [{ cmd: "claude", account: undefined }]]);
  delete process.env.CLAUDE_CONFIG_DIR;
  const plain = await readClaude({ nowSec: T, exec, tmp: dir });
  expect([Math.round(plain.headroom * 100), calls]).toEqual([10, []]);
  const read = await HARNESSES.claude.usage.read({ account: work, nowSec: T, exec, tmp: dir });
  expect([Math.round(read.headroom * 100), calls]).toEqual([80, [{ cmd: "claude", account: { CLAUDE_CONFIG_DIR: WORK } }]]);
  // A snapshot the statusline saved from its own folder is its own; the default folder's account reads the default's.
  writeFileSync(CLAUDE_SNAPSHOT(WORK), JSON.stringify({ ts: T - 10, rate_limits: { five_hour: { used_percentage: 50, resets_at: T + 3600 } }, answered: true }));
  const [again, home1] = [await HARNESSES.claude.usage.read({ account: work, nowSec: T, exec, tmp: dir }), await HARNESSES.claude.usage.read({ account: mine, nowSec: T, exec, tmp: dir })];
  expect([Math.round(again.headroom * 100), Math.round(home1.headroom * 100), calls.length]).toEqual([50, 10, 1]);
  rmSync(snapshot); rmSync(CLAUDE_SNAPSHOT(WORK));
  await HARNESSES.claude.usage.read({ account: mine, nowSec: T, exec, tmp: dir });
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
  expect([SHELLS.posix.unset("X"), SHELLS.powershell.unset("X"), SHELLS.cmd.unset("X")]).toEqual(["unset X", "Remove-Item -LiteralPath Env:X -ErrorAction SilentlyContinue", "set X="]);
});

test("launch --subscription takes the account's name: a pane routr splits is given its folder, or has the variable dropped in its shell, and an existing pane is refused", async () => {
  const { config } = loadConfig(configFile({ ...TESTY, testy2: sub({ accounts: { rel: "relative" } }) }));
  const settings = () => ({ config, notes: [] }), t = taskFiles();
  const go = async (kind, more = [], shellName) => { const f = fakeHerdr(t.dir, "testy", shellName); const r = await launch(["--subscription", kind, "--name", "p1", ...t.flags, ...more], { env: { HERDR_ENV: "1" }, settings, run: f.run, now: f.now, sleep: f.sleep, home: scratch("accounts-history") }); return { r, f }; };
  const b = await go("testy-b", ["--direction", "right"]);
  expect([b.r.ok, b.r.state, b.r.kind, b.r.start.env, b.r.headline]).toEqual([true, "prompted", "testy", { TESTY_HOME: "<forwarded>" }, "routr: p1 (testy) took its task in pane w1:p2"]);
  expect(b.r.next.find((n) => n.template?.startsWith("routr record")).template).toContain("--subscription testy-b");
  const tree = await go("testy-b", ["--worktree", "wt-b"]);
  expect([tree.r.state, tree.f.text()]).toEqual(["prompted", expect.arrayContaining([`pane run w1:p2 ${SHELLS[SHELL].set("TESTY_HOME", B)}`])]);
  const homeLaunch = await go("testy-home", ["--direction", "right"]);
  expect(homeLaunch.r.start.env).toEqual({ TESTY_HOME: null });
  expect(homeLaunch.f.calls.find((a) => a[1] === "split")).not.toContain("TESTY_HOME");
  expect(homeLaunch.f.text().some((c) => c.includes("pane run") && c.includes(SHELLS[SHELL].unset("TESTY_HOME")))).toBe(true);
  expect(homeLaunch.r.steps).toContainEqual({ step: "unset_env", ok: true, detail: `Removed TESTY_HOME from the pane's ${SHELL} shell` });
  if (process.platform !== "win32") expect((await go("testy-home", ["--direction", "right"], "fish")).r.error).toContain("or fish for an account whose folder is set");
  const existing = await go("testy-b", ["--pane", "w1:p1"]);
  expect(existing.r.ok).toBe(false);
  expect(existing.r.error).toContain("--pane cannot be used with testy-b: an existing pane keeps its own shell's environment. Leave --pane off, and routr splits a pane with it");
  const continued = await go("testy-b", ["--pane", "w1:p1", "--continue"]);
  expect(continued.r.ok).toBe(true);
  expect(continued.r.ran.find((c) => c.includes("pane split"))).toBeUndefined();
  // routr's own, in help as that; anywhere else it is refused where an unknown option always was, before a later one.
  expect([COMMANDS.launch.flags.find((f) => f.name === "--subscription").description, COMMANDS.launch.flags.find((f) => f.name === "--continue").description]).toEqual([expect.stringContaining("an extra account"), expect.stringContaining("routr's own")]);
  expect(COMMANDS.record.flags.find((f) => f.name === "--subscription").description).toContain("or an extra account's name, <harness>-<name>");
  expect(await go("testy", ["--continue", "--bogus"])).toMatchObject({ r: { ok: false, error: expect.stringContaining("Unknown launch option: --continue") } });
  expect(await go("testy", ["--pane", "w1:p1", "--continue"])).toMatchObject({ r: { ok: false, error: expect.stringContaining("Unknown launch option: --continue") } });
  expect(await go("testy-b", ["--continue"])).toMatchObject({ r: { ok: false, error: expect.stringContaining("Unknown launch option: --continue") } });
  for (const none of ["testy2-rel", "nope", "constructor", "__proto__", "toString"]) expect(await go(none)).toMatchObject({ r: { ok: false, error: expect.stringContaining("--subscription must be") } });
});

test("a launch counts toward its own subscription, and a turned-off or signed-out account is refused by its name", async () => {
  const history = scratch("accounts-counts"), t = taskFiles();
  const cOff = loadConfig(configFile({ testy: sub({ accounts: { off: { folder: B, enabled: false } } }) })).config;
  const goOff = (kind) => launch(["--subscription", kind, "--name", "p1", ...t.flags, "--direction", "right"], { env: { HERDR_ENV: "1" }, settings: () => ({ config: cOff }), run: fakeHerdr(t.dir, "testy").run, home: history });
  expect((await goOff("testy-off")).error).toContain("testy-off is turned off in your settings: turn it on with routr setup --enable testy-off");
  const c = loadConfig(configFile({ testy: sub({ accounts: { b: B, out: OUT } }) })).config;
  const go = (kind) => launch(["--subscription", kind, "--name", "p1", ...t.flags, "--direction", "right"], { env: { HERDR_ENV: "1" }, settings: () => ({ config: c }), run: fakeHerdr(t.dir, "testy").run, home: history });
  expect((await go("testy-out")).error).toContain(`not signed in: run \`testy login\` with TESTY_HOME set to ${OUT}`);
  expect((await go("testy-b")).state).toBe("prompted");
  expect(readHistory({ home: history }).records.map((r) => [r.subscription, r.model, r.effort, r.project, r.backend, r.name])).toEqual([["testy-b", "model-a", null, basename(t.dir), "pane", "p1"]]);
});

test("in the Herdr app, the worker's record keeps its account, and its runner starts the harness with it over the caller's and the core's, or refuses where the home folder's default is another folder", async () => {
  const { config } = loadConfig(configFile(TESTY)), t = taskFiles(), seen = {}, at = {};
  let clock = 0;
  for (const [kind, name] of [["testy-b", "tb"], ["testy-home", "th"], ["testy", "tp"]]) {
    const r = await launch(["--subscription", kind, "--name", name, ...t.flags], { env: { ...CORE, TESTY_HOME: "/caller/testy" }, settings: () => ({ config }), hc: fakeHc(name), self: (a) => ["/bin/routr", ...a], now: () => (clock += 100), home: scratch("accounts-history") });
    expect([name, r.ok, r.error]).toEqual([name, true, undefined]);
    const dir = r.worker.run, w = JSON.parse(readFileSync(join(dir, "worker.json"), "utf8"));
    seen[name] = { start: r.start.env, subscription: w.subscription, config_dir: w.config_dir, default_folder: w.default_folder }; at[name] = [dir, w.id];
    rmSync(LOG, { force: true });
    const code = await runWorker(dir, w.id, { env: { ...process.env, TESTY_HOME: "/core/testy" }, say: () => {}, on: () => {}, begin: (cmd, args, opts, seams) => start(cmd, ["whoami"], { ...opts, stdio: "ignore" }, seams) });
    seen[name].ran = [code, started().map((s) => s.dir)];
  }
  expect(seen.tb).toEqual({ start: { TESTY_HOME: "<forwarded>" }, subscription: "testy-b", config_dir: B, default_folder: false, ran: [0, [B]] });
  expect(seen.th).toEqual({ start: { TESTY_HOME: null }, subscription: "testy-home", config_dir: join(home(), ".testy"), default_folder: true, ran: [0, [null]] });
  expect(seen.tp).toEqual({ start: {}, subscription: undefined, config_dir: undefined, default_folder: undefined, ran: [0, ["/core/testy"]] });
  // Its runner in a core whose home folder is another: the refusal, said, and nothing started.
  const was = [process.env.HOME, process.env.USERPROFILE], said = [];
  process.env.HOME = process.env.USERPROFILE = scratch("accounts-other-home");
  try { expect(await runWorker(...at.th, { say: (s) => said.push(s), on: () => {}, begin: () => { throw new Error("started"); } })).toBe(2); } finally { [process.env.HOME, process.env.USERPROFILE] = was; }
  expect(said).toEqual([expect.stringMatching(/^routr: testy-home's folder .+ was its harness's default when it was launched, .+; nothing was started$/)]);
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
  expect([room(dispatched), room(cli(["usage"]))]).toEqual(Array(2).fill({ "claude-team": 0.8, "claude-mine": 0.4 })); // claude itself is claude-mine's login here: ranked once
  const one = cli(["usage", "claude-team"]);
  expect([one.ok, one.subscription, room(one)]).toEqual([true, "claude-team", { "claude-team": 0.8 }]);
  const state = (n) => { try { return JSON.parse(readFileSync(join(root, ".local", "state", "routr", "workers", n, "state.json"), "utf8")).state; } catch { return null; } };
  const settled = async (n) => { for (let i = 0; i < 300; i++) { if (state(n) && !["working", "waiting", "starting"].includes(state(n))) return true; await Bun.sleep(50); } return false; };
  const turns = {};
  rmSync(join(root, ".cache", "routr", "signed-in.json"), { force: true }); // every launch and send below asks again
  try {
    for (const kind of ["claude-team", "claude-mine", "claude"]) {
      const log = join(root, `${kind}.jsonl`), at = { FAKE_LOG: log }, from = (dir) => ({ ...at, CLAUDE_CONFIG_DIR: kind === "claude" ? dir : "/signed-out" });
      const l = cli(["launch", "--subscription", kind, "--name", `w-${kind}`, "--model", "haiku", "--task-file", task, "--advice", advice], from("/launcher/claude"));
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

test("launch refuses an account's name that its advice ranked from another folder: dispatch --config another file, or accounts changed since", () => {
  const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rs-")), bin = join(root, "bin"), work = join(root, "work"), started = join(root, "started.jsonl");
  for (const d of [bin, work, join(root, ".config", "routr")]) mkdirSync(d, { recursive: true });
  fakeExecutable(bin, "claude", FAKE_CLAUDE);
  const file = (name, folder, over = {}) => { const path = join(root, name); writeFileSync(path, JSON.stringify({ subscriptions: { claude: sub({ accounts: { work: folder }, ...over }) } })); return path; };
  const DEFAULT = join(".config", "routr", "config.json"), other = file("other.json", B), tuned = file("tuned.json", WORK, { reserve: 0.3 });
  writeFileSync(join(root, "none.json"), JSON.stringify({ subscriptions: { claude: sub() } }));
  file(DEFAULT, WORK);
  const task = join(root, "task.md"); writeFileSync(task, "Rename foo to bar in x.js.");
  const env = cliEnv(root, { PATH: [bin, dirname(process.execPath)].join(delimiter), ROUTR_NO_UPDATE: "1", FAKE_LOG: started });
  for (const k of Object.keys(env)) if (/^(HERDR_|HC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|SANDBOX_RUNTIME$|CODEX_|TRACEPARENT$|TRACESTATE$|BAGGAGE$)/i.test(k)) delete env[k];
  const cli = (args) => { const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: work, env, stdin: "ignore" }); return { r: JSON.parse(r.stdout.toString()), code: r.exitCode }; };
  const save = (name, advice) => { const path = join(root, `${name}.advice.json`); writeFileSync(path, JSON.stringify(advice)); return path; };
  const advised = (name, ...config) => { const { r } = cli(["dispatch", ...config, "--task-file", task]); return { r, path: save(name, r) }; };
  const go = (kind, advice, ...more) => cli(["launch", "--subscription", kind, "--name", "w1", "--model", "haiku", "--task-file", task, "--advice", advice, ...more]);
  const REFUSED = "--advice ranked claude-work from a different folder than this launch would start; dispatch the exact task again, without --config";
  try {
    const mine = advised("mine"), others = advised("others", "--config", other), same = advised("same", "--config", tuned);
    // Advice names each extra account's folder as a fingerprint, never its path.
    expect([mine.r.accounts, same.r.accounts, others.r.accounts]).toEqual([{ "claude-work": folderSha(WORK) }, { "claude-work": folderSha(WORK) }, { "claude-work": folderSha(B) }]);
    const real = join(root, "acct"), link = join(root, "acct-link"); mkdirSync(real); symlinkSync(real, link, "junction");
    expect(folderSha(link)).toBe(folderSha(real));
    expect([folderSha(B), Object.hasOwn(advised("none", "--config", join(root, "none.json")).r, "accounts"), COMMANDS.dispatch.contract.fields.includes("accounts")]).toEqual([expect.stringMatching(/^[a-f0-9]{12}$/), false, true]);
    const refused = go("claude-work", others.path);
    expect([refused.code, refused.r.ok, refused.r.state, refused.r.error, refused.r.advice]).toEqual([1, false, "failed", REFUSED, { file: others.path, matches: false }]);
    expect(refused.r.next.map((n) => n.argv)).toEqual([["routr", "dispatch", "--task-file", task]]); // the step every advice refusal gives: dispatch again, on the default config
    expect([existsSync(started), existsSync(join(root, ".local", "state", "routr", "workers", "w1"))]).toEqual([false, false]);
    expect(go("claude-work", others.path, "--dry-run").r).toMatchObject({ ok: false, state: "planned", error: REFUSED });
    // Taken as before: the same folder from another file, the harness's own entry, and advice that names no folder for it (an older routr's).
    const older = save("older", { ...others.r, accounts: undefined });
    for (const [kind, advice] of [["claude-work", mine.path], ["claude-work", same.path], ["claude", others.path], ["claude-work", older]]) expect([kind, advice, go(kind, advice, "--dry-run").r.error]).toEqual([kind, advice, undefined]);
    // The default file's own accounts changed since dispatch: the name is another folder now.
    file(DEFAULT, B);
    expect([go("claude-work", mine.path, "--dry-run").r.error, go("claude-work", others.path, "--dry-run").r.error]).toEqual([REFUSED, undefined]);
    // record takes the same advice and keeps none of it.
    expect(cli(["record", "--advice", others.path, "--task-file", task, "--subscription", "claude-work", "--model", "haiku", "--effort", "default", "--verdict", "blocked", "--check", "none"]).r.ok).toBe(true);
    expect(readFileSync(join(root, ".local", "share", "routr", "ledger.jsonl"), "utf8")).not.toContain(folderSha(B));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);

test("a subscription name of the user's own never leaves the machine: telemetry sends an extra account as its harness, OpenTelemetry a harness's name or other, and no reading of it; its effort is read from its harness's settings", async () => {
  const { telemetryRows } = await import("../src/lib/telemetry.mjs");
  const [sent] = telemetryRows([row({ chose: { subscription: "claude-team", model: "m", effort: "high", level: "standard" }, headroom: { "claude-team": { usable: 0.3, usage: "live" } } })], "install-a");
  expect(sent.chose.subscription).toBe("claude");
  expect(JSON.stringify(sent)).not.toContain("claude-team");
  expect(telemetryRows([row({ chose: { subscription: "mine-team", model: "m", effort: "high", level: "standard" } })], "install-a")[0].chose.subscription).toBe("other");
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

test("routr statusline saves one snapshot per folder Claude Code runs with: the default folder's where it always was", () => {
  const dir = scratch("accounts-statusline"), cache = join(dir, ".cache/routr");
  const runWith = (env) => {
    rmSync(cache, { recursive: true, force: true });
    Bun.spawnSync([process.execPath, SCRIPT, "statusline"], { env: cliEnv(dir, { CLAUDE_CONFIG_DIR: env }), stdin: Buffer.from(JSON.stringify({ model: { display_name: "Claude" }, rate_limits: { five_hour: { used_percentage: 10 } } })) });
    return readdirSync(cache).filter((f) => f.startsWith("claude-usage"));
  };
  expect([runWith(WORK), runWith(undefined), runWith(join(dir, ".claude"))]).toEqual([[`claude-usage-${folderSha(WORK)}.json`], ["claude-usage.json"], ["claude-usage.json"]]);
});

test("a pane launch for an account that stops at a startup question offers a fresh launch, and hands no task to the agent in the pane", async () => {
  const { config } = loadConfig(configFile(TESTY)), t = taskFiles(), f = fakeHerdr(t.dir, "testy"), o = { env: { HERDR_ENV: "1" }, settings: () => ({ config }), now: f.now, sleep: f.sleep, home: scratch("accounts-history") };
  let gets = 0;
  o.run = async (a) => (a[0] === "agent" && a[1] === "get" ? { ok: true, data: { result: { agent: { agent: "testy", agent_status: gets++ ? "idle" : "blocked", cwd: t.dir } } } }
    : a[0] === "agent" && a[1] === "explain" ? { ok: true, data: { result: { state: "blocked", matched_rule: { id: "trust_folder" } } } } : f.run(a));
  const stop = async (kind) => { gets = 0; const r = await launch(["--subscription", kind, "--name", "p1", ...t.flags, "--direction", "right"], o); return { r, again: r.next.find((n) => n.kind === "run" && n.argv[1] === "launch").argv }; };
  const own = await stop("testy"), first = await stop("testy-home");
  expect([own.r.state, own.again.slice(-4)]).toEqual(["needs_input", ["--pane", own.r.pane, "--cwd", t.dir]]); // a harness's own: the rerun into its pane, as before
  expect([first.r.state, first.again.filter((a) => ["--pane", "--continue"].includes(a)), first.again.slice(-2)]).toEqual(["needs_input", [], ["--cwd", t.dir]]);
  expect(await launch([...first.again.slice(2), "--pane", first.r.pane, "--continue"], o)).toMatchObject({ ok: false, state: "needs_input", needs_input: { why: expect.stringContaining("not one launch can tell is testy-home") } });
  expect([f.text().filter((c) => c.includes("agent prompt")), readHistory({ home: o.home }).records]).toEqual([[], []]);
});

test("routr board ranks an account from its kept reading, and leaves a signed-out one out by its harness's step", async () => {
  const { boardCommand } = await import("../src/lib/board.mjs");
  const { config } = loadConfig(configFile({ testy: sub({ accounts: { b: B, out: OUT } }) })), dir = scratch("accounts-board");
  // Kept as a live read keeps them: each sign-in answer and reading under its own source key, in routr's own cache.
  for (const n of ["testy", "testy-b", "testy-out"]) { const a = accountOf(n, config); await signIn(a ?? n, { fresh: true }); fileStore().put(sourceKey(n, config), { source: "testy usage", takenAt: Date.now() / 1000, windows: [{ name: "week", usedPct: 20 }] }, undefined); }
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

test("doctor's default_model line is the harness's alone: an extra account takes its harness's settings", () => {
  const dir = scratch("accounts-doctor"), doc = JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json", "--config", configFile({ claude: sub({ accounts: { work: WORK } }) })], { env: cliEnv(dir, { PATH: dir, ROUTR_NO_UPDATE: "1" }) }).stdout.toString());
  expect(doc.config.notes.filter((n) => n.includes("default_model"))).toEqual(["subscriptions.claude: no default_model set; the orchestrator will pick from the harness's live list"]);
}, 60_000); // starts doctor, a process with harness probes: slow on Windows

test("doctor asks each extra account afresh with its folder: a signed-in harness does not hide a signed-out account, which gets its own step", () => {
  const dir = scratch("accounts-doctor");
  fakeExecutable(dir, "claude", `console.log(JSON.stringify({ loggedIn: process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(WORK)} }));`);
  // Kept as signed in a moment ago: doctor asks again.
  mkdirSync(join(dir, ".cache/routr"), { recursive: true }); writeFileSync(join(dir, ".cache/routr/signed-in.json"), JSON.stringify({ "claude-work": { ts: Date.now() / 1000, state: "yes" } }));
  const doc = JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json", "--config", configFile({ claude: sub({ accounts: { work: WORK } }) })], { env: cliEnv(dir, { PATH: dir, ROUTR_NO_UPDATE: "1" }) }).stdout.toString());
  expect([doc.harnesses.claude.signed_in, doc.accounts["claude-work"].signed_in]).toEqual([true, false]);
  expect(doc.next_steps).toContain(`claude-work is set up in routr but gets no work: not signed in: run \`claude auth login\` with CLAUDE_CONFIG_DIR set to ${WORK}`);
}, 60_000); // starts doctor, a process with harness probes: slow on Windows

test("a harness signed out on its own lists its models through its first signed-in account, so doctor shows them and setup takes its settings, turned off too", async () => {
  const dir = scratch("accounts-doctor"), path = configFile({ claude: sub({ enabled: false, accounts: { work: WORK, out: { folder: OUT, enabled: false } } }), codex: sub({ accounts: { b: CODEX_B, c: OUT } }) });
  fakeExecutable(dir, "codex", `const a = process.argv.slice(2), b = process.env.CODEX_HOME === ${JSON.stringify(CODEX_B)}, c = process.env.CODEX_HOME === ${JSON.stringify(OUT)};
if (a[0] === "login") { console.log(b || c ? "Logged in using ChatGPT" : "Not logged in"); process.exit(b || c ? 0 : 1); }
a[0] === "debug" ? console.log(JSON.stringify({ models: [{ slug: b ? "m-b" : c ? "m-c" : "m-own" }] })) : process.exit(1);`);
  fakeExecutable(dir, "claude", `const a = process.argv.slice(2), w = process.env.CLAUDE_CONFIG_DIR === ${JSON.stringify(WORK)};
a[0] === "auth" ? console.log(JSON.stringify({ loggedIn: w })) : a[0] === "--help" ? console.log("  --model <model>  an alias for the latest model (e.g. '" + (w ? "m-work" : "m-own") + "')") : process.exit(1);`);
  const doc = JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json", "--config", path], { env: cliEnv(dir, { PATH: dir, ROUTR_NO_UPDATE: "1" }) }).stdout.toString());
  expect(["claude", "codex"].map((n) => [doc.harnesses[n].signed_in, doc.harnesses[n].models])).toEqual([[false, ["m-work"]], [false, ["m-b"]]]);
  expect([doc.accounts["claude-out"].signed_in, doc.next_steps.filter((s) => s.startsWith("claude-out"))]).toEqual([false, []]); // turned off: no step of its own
  const text = Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--config", path], { env: cliEnv(dir, { PATH: dir, ROUTR_NO_UPDATE: "1" }) }).stdout.toString();
  expect(text.split("\n").filter((l) => /claude-(work|out) /.test(l)).map((l) => l.trim().split(" · ")[0].slice(0, 2) + " " + l.includes("turned off in your settings"))).toEqual(["ok false", "-- true"]); // its harness is off; each account is on or off on its own
  expect(text).toContain("routr setup --enable claude-out");
  const { guided } = await import("../src/lib/setup-guided.mjs"), offered = [];
  await guided({ ui: { style: { dim: (s) => s }, glyphs: { arrow: "→" }, line() {}, note() {}, multiselect: async (q) => { offered.push(...q.options); return ["codex"]; }, search: async () => "", select: async (q) => q.initial,
    confirm: async () => false, text: async () => "" }, r: doc, config: null, efforts: async () => null });
  expect(offered.filter((o) => !o.disabled).map((o) => o.value)).toContain("codex");
  const { setup } = await import("../src/lib/setup.mjs");
  const r = await setup(["--config", path, "--yes", "--force", "--model", "codex=m-b", "--enable", "claude"], { inspect: async () => doc, install: () => {}, share: () => {}, key: async () => ({ ok: true }), hasKey: () => true, print: () => {} });
  const saved = JSON.parse(readFileSync(path, "utf8")).subscriptions;
  expect([r.ok, r.error, r.skipped.filter((x) => x.includes("left out")), saved.codex, saved.claude.enabled]).toEqual([true, undefined, [], expect.objectContaining({ default_model: "m-b", accounts: { b: CODEX_B, c: OUT } }), true]);
}, 60_000); // starts doctor, a process with harness probes: slow on Windows

test("routr setup adds an account once its folder is signed in, and its flags give it settings of its own, written under its harness", async () => {
  const dir = scratch("accounts-setup"), path = configFile({ claude: sub({ default_model: "m-own" }) });
  fakeExecutable(dir, "claude", `const a = process.argv.slice(2), d = process.env.CLAUDE_CONFIG_DIR, w = d === undefined || d === ${JSON.stringify(WORK)};
a[0] === "auth" ? console.log(JSON.stringify({ loggedIn: w })) : a[0] === "--help" ? console.log("  --model <model>  an alias for the latest model (e.g. 'm-own')\\n  --effort <level>  (low, medium, high)") : process.exit(1);`);
  const env = cliEnv(dir, { PATH: dir, ROUTR_NO_UPDATE: "1" });
  const doctor = () => JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json", "--config", path], { env }).stdout.toString());
  const asked = [], { setup } = await import("../src/lib/setup.mjs");
  const run = async (flags) => setup(["--config", path, "--yes", ...flags], { inspect: async () => doctor(), install: () => {}, share: () => {}, key: async () => ({ ok: true }), hasKey: () => true, print: () => {}, efforts: async () => ["low", "medium", "high"],
    accountSignIn: async (a) => { asked.push(a.env); return { state: a.dir === WORK ? "yes" : "no" }; } });
  const saved = () => JSON.parse(readFileSync(path, "utf8")).subscriptions.claude;
  // Not signed in from that folder: refused with the command to run, and nothing written. routr never signs in.
  expect((await run(["--account", `claude-out=${OUT}`])).error).toBe(`--account claude-out=…: not signed in: run \`claude auth login\` with CLAUDE_CONFIG_DIR set to ${OUT}, then routr setup --account claude-out=${OUT} again`);
  expect([asked, saved().accounts]).toEqual([[{ CLAUDE_CONFIG_DIR: OUT }], undefined]);
  for (const [flags, why] of [[["--account", "cursor-b=~/x"], "--account takes <harness>-<name>=<folder>"], [["--account", "claude-work=relative"], "the folder must be a full path or one under ~/"],
    [["--reserve", "claude-work=0.1"], "claude-work is not an account in your config; add it first: routr setup --account claude-work=<folder>"], [["--disable", "claude-nope"], "claude-nope is not an account in your config"]])
    expect((await run(flags)).error).toContain(why);
  // Added as its folder alone: its harness's settings. A setting given with it, or later, is its own.
  const added = await run(["--account", `claude-work=${WORK}`]);
  expect([added.ok, saved().accounts, loadConfig(path).config.subscriptions["claude-work"]]).toEqual([true, { work: WORK }, expect.objectContaining({ harness: "claude", config_dir: WORK, reserve: 0.1, default_model: "m-own", enabled: true })]);
  expect((await run(["--reserve", "claude-work=40%", "--use", "claude-work=fallback", "--hardest", "claude-work=basic", "--effort", "claude-work=high", "--disable", "claude-work"])).ok).toBe(true);
  expect(saved()).toEqual({ ...sub({ default_model: "m-own" }), accounts: { work: { folder: WORK, hardest_work: "basic", reserve: 0.4, default_effort: "high", enabled: false, use: "fallback" } } });
  expect(loadConfig(path).config.subscriptions).toMatchObject({ claude: { enabled: true, reserve: 0.1, use: null }, "claude-work": { enabled: false, reserve: 0.4, use: "fallback", hardest_work: "basic", default_effort: "high", default_model: "m-own" } });
  expect((await run(["--effort", "claude-work=huge"])).error).toBe("--effort claude-work=huge: Claude Code takes low, medium, high for m-own");
  expect((await run(["--enable", "claude-work"])).ok).toBe(true);
  expect(saved().accounts.work.enabled).toBe(true);
  // One folder is one account: a second name on it is refused, where the config loader would leave it out.
  expect((await run(["--account", `claude-again=${WORK}`])).error).toBe("--account claude-again=…: its folder is claude-work's too, and one folder is one account");
  // Taken out by name: its entry goes and nothing else; a name that is not an account is refused.
  expect((await run(["--remove-account", "claude-nope"])).error).toBe("--remove-account claude-nope: claude-nope is not an account in your config");
  expect((await run(["--remove-account", "claude"])).error).toContain("--remove-account takes an extra account's name");
  expect((await run(["--remove-account", "claude-work"])).ok).toBe(true);
  expect([saved().accounts, Object.keys(loadConfig(path).config.subscriptions)]).toEqual([undefined, ["claude"]]);
}, 60_000); // it starts doctor a dozen times, each a process: slow on Windows

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
}, 60_000); // starts doctor, a process with harness probes: slow on Windows

test("a failed read of an extra account's usage gives its harness's step by hand, with its folder and its own name", () => {
  const { config } = loadConfig(configFile({ codex: sub({ accounts: { b: CODEX_B } }) }));
  expect(capacityView("basic", [failedUsage("codex-b", "codex app-server")], config).next).toContainEqual({ kind: "do", why: `Read codex-b's usage by hand with CODEX_HOME set to ${CODEX_B}: open Codex and read /status, then pass --headroom codex-b=<share left>`, template: "--headroom codex-b=<share left>" });
});

test("assess points an extra account's reserve suggestion at its harness's reserve, the setting it takes", () => {
  const { config } = loadConfig(configFile({ claude: sub({ accounts: { work: WORK } }) }));
  expect(assess(Array.from({ length: 5 }, () => row({ headroom: { "claude-work": { usable: 0 } } })), config)).toContain("subscriptions.claude.reserve: it was at its reserve in 5 of 5 dispatches");
});

// A pane launch for an account, from a fake herdr whose shell is `shellName` (`run` over its own for an agent there).
const teamLaunch = async (folder, more, shellName = SHELL_NAME, run = null) => {
  const { config } = loadConfig(configFile({ testy: sub({ accounts: { team: folder } }) })), t = taskFiles(), f = fakeHerdr(t.dir, "testy", shellName);
  const r = await launch(["--subscription", folder ? "testy-team" : "testy", "--name", "p1", ...t.flags, ...more], { env: { HERDR_ENV: "1" }, settings: () => ({ config }), run: run?.(f, t) ?? f.run, now: f.now, sleep: f.sleep, home: scratch("accounts-history") });
  return { r, f };
};

test("a pane routr splits for an account sets its folder in the shell once it is ready", async () => {
  expect([SHELLS.posix.set("X", "/a b"), SHELLS.posix.set("X", "/a", true), SHELLS.powershell.set("X", "C:\\a'b"), SHELLS.cmd.set("X", "C:\\a b")]).toEqual(["export X='/a b'", "set -gx X /a", "$env:X='C:\\a''b'", 'set "X=C:\\a b"']);
  const { r, f } = await teamLaunch(B, ["--direction", "right"]);
  expect([r.state, f.text().filter((c) => c.startsWith("pane run") && c.includes("TESTY_HOME")), r.ran.filter((c) => c.includes("pane run") && c.includes("TESTY_HOME") && !c.includes(B))])
    .toEqual(["prompted", [`pane run w1:p2 ${SHELLS[SHELL].set("TESTY_HOME", B)}`], [expect.stringContaining("<forwarded>")]]);
  expect(r.steps).toContainEqual({ step: "set_env", ok: true, detail: `Set TESTY_HOME in the pane's ${SHELL} shell` });
  const typed = f.text(); expect(typed.findIndex((c) => c.startsWith("pane run") && c.includes("TESTY_HOME"))).toBeLessThan(typed.findIndex((c) => c.startsWith("agent start")));
  if (process.platform !== "win32") expect((await teamLaunch(B, ["--direction", "right"], "fish")).f.text()).toContain(`pane run w1:p2 set -gx TESTY_HOME ${B}`);
});

test("an account launch is refused before anything is typed in a shell routr does not know", async () => {
  // Any name herdr gives that process-boundary does not list reaches launch as "shell": tcsh, dash, a login shell.
  for (const shellName of ["nu", "tcsh", "-zsh", "dash", null]) {
    const { r, f } = await teamLaunch("~/.testy", ["--direction", "right"], shellName);
    expect([shellName, r.ok, r.error, f.calls.filter((a) => a[1] === "run")]).toEqual([shellName, false, expect.stringContaining("routr gives an extra account its folder only in a pane running sh, bash, zsh, PowerShell or cmd"), []]);
  }
  for (const shellName of ["bash", "zsh"]) expect([shellName, (await teamLaunch("~/.testy", ["--direction", "right"], shellName)).r.state]).toEqual([shellName, "prompted"]);
  if (process.platform !== "win32") expect((await teamLaunch(B + "\\", ["--direction", "right"], "fish")).r.error).toBe(FISH_PATH);
  expect((await teamLaunch(null, ["--direction", "right"], "tcsh")).r.state).toBe("prompted"); // no account: as before
});

// Skills: a harness that reads skills from its own folder reads them from an account's folder too, so routr's skills
// are linked there as they are for the harness, reported missing by the same check, and removed by uninstall.
test("routr's skills are linked into an extra account's skills folder, and removed from it", async () => {
  const { installSkill, skillPlaces } = await import("../src/lib/skill-install.mjs");
  const { uninstallPlan } = await import("../src/lib/uninstall.mjs");
  const { accountSkillFolders } = await import("../src/lib/harnesses.mjs");
  const h = realpathSync(mkdtempSync(join(tmpdir(), "routr-acct-skills-"))), was = process.env.HOME, wasProfile = process.env.USERPROFILE;
  process.env.HOME = h; process.env.USERPROFILE = h; // the home routr reads, on every platform
  try {
    mkdirSync(join(h, ".claude")); mkdirSync(join(h, ".claude-work")); mkdirSync(join(h, ".codex-work"));
    const config = { subscriptions: { claude: {}, "claude-work": { harness: "claude", config_dir: join(h, ".claude-work") }, "claude-same": { harness: "claude", config_dir: join(h, ".claude") },
      "codex-work": { harness: "codex", config_dir: join(h, ".codex-work") } } };
    const accounts = accountSkillFolders(config);
    // Codex reads the shared folder, and an account on the default folder has the harness's place already.
    expect(accounts).toEqual([{ label: "claude-work", path: join(h, ".claude-work", "skills") }]);
    const r = installSkill({ home: h, accounts });
    expect(r.ok).toBe(true);
    for (const s of ["routr", "routr-orchestrate"]) {
      expect(readFileSync(join(h, ".claude-work/skills", s, "SKILL.md"), "utf8")).toBe(readFileSync(join(h, ".agents/skills", s, "SKILL.md"), "utf8"));
      expect(r.installed.some((i) => i.where === join(h, ".claude-work/skills", s) && i.how.endsWith("for claude-work"))).toBe(true);
    }
    expect(skillPlaces(h, accounts).filter((p) => p.label === "claude-work").map((p) => p.state)).toEqual(["ours", "ours"]);
    expect(uninstallPlan({ home: h, accounts }).remove.map((x) => x.path)).toContain(join(h, ".claude-work/skills/routr"));
    // Without the account, its folder is no place of routr's: nothing is planned there.
    expect(uninstallPlan({ home: h }).remove.map((x) => x.path)).not.toContain(join(h, ".claude-work/skills/routr"));
  } finally { process.env.HOME = was; if (wasProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = wasProfile; rmSync(h, { recursive: true, force: true }); }
});

test("`routr skill install` reads the accounts from the config and links into their folders", async () => {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "routr-acct-skill-cli-")));
  try {
    mkdirSync(join(h, ".claude-work")); mkdirSync(join(h, ".config/routr"), { recursive: true });
    writeFileSync(join(h, ".config/routr/config.json"), JSON.stringify({ subscriptions: { claude: { accounts: { work: "~/.claude-work" } } } }));
    const r = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../src/routr.mjs"), "skill", "install"], { env: { ...process.env, HOME: h, USERPROFILE: h, XDG_CONFIG_HOME: "" } });
    const out = JSON.parse(r.stdout.toString());
    expect(out.ok).toBe(true);
    expect(out.installed.map((i) => i.where)).toContain(join(h, ".claude-work/skills/routr"));
    expect(existsSync(join(h, ".claude-work/skills/routr/SKILL.md"))).toBe(true);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

// Guided setup with accounts, each scenario driven as a person would: scripted answers on a fake machine.
async function guidedRun({ config = null, answers, signedIn = true, classes = {}, loginWorks = true }) {
  const dir = scratch("accounts-guided-run"), path = join(dir, "config.json"), { setup } = await import("../src/lib/setup.mjs");
  if (config) writeFileSync(path, JSON.stringify(config));
  const said = [], asked = [], installs = [], queue = [...answers], logins = [], opens = [], signedNow = new Set();
  const inspect = async () => { const subs = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).subscriptions : {}, accounts = Object.fromEntries(Object.keys(subs.claude?.accounts ?? {}).map((k) => [`claude-${k}`, { harness: "claude", signed_in: true, usage_class: classes[`claude-${k}`] ?? "included" }]));
    return { harnesses: { claude: { installed: true, signed_in: signedIn, ...(signedIn ? {} : { sign_in: "not signed in: run `claude auth login`" }), models: ["m-own", "m2"], usage_class: classes.claude ?? "included" } }, accounts,
      config: { path, exists: existsSync(path), subscriptions: [...Object.keys(subs), ...Object.keys(accounts)], off: [] }, skill: [], decision: [{ works: true }], next_steps: [] }; };
  const r = await setup(["--config", path, "--json"], { inspect, interactive: true, env: {}, install: (o) => { installs.push(o); return {}; }, share: () => {}, key: async () => ({ ok: true }), hasKey: () => true, print: (t) => said.push(t), efforts: async () => ["low", "medium"],
    question: async (q) => { asked.push(q.trim().split("\n")[0]); if (!queue.length) throw new Error(`unexpected question: ${q.trim()}`); return queue.shift(); }, accountSignIn: async (a) => ({ state: a.dir === OUT && !signedNow.has(a.dir) ? "no" : "yes" }),
    // The harness's own sign-in and first run, as setup would start them in the terminal: recorded, never started.
    accountLogin: async (a) => { logins.push(a.env); if (loginWorks) signedNow.add(a.dir); return 0; }, accountOpen: async (a) => { opens.push(a.dir); return 0; } });
  return { r, asked, installs, logins, opens, left: queue.length, said: said.join("\n").replace(/\n[│|]\s+/g, " "), saved: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).subscriptions : null };
}
const BASE = { hardest_work: "strong", reserve: 0.1, default_model: "m-own" };

test("guided setup, first run: with the harness signed out on its default folder, an account signed in from another folder is still offered and added", async () => {
  const g = await guidedRun({ signedIn: false, answers: ["2", "work", WORK, "", "", "", "", "", "", "n", "", ""] }); // + Add, its name and folder, three settings kept, no more, then the rest of a first run
  expect([g.r.ok, g.left]).toEqual([true, 0]);
  expect(g.asked.filter((q) => q.startsWith("Claude Code · work")).length).toBe(3); // asked once, when added: not walked again
  expect(g.saved.claude.accounts).toEqual({ work: WORK }); // nothing answered differs from its harness's
  // The harness's entry made for it, which the account reads its model and effort from, is on the review as written.
  expect(g.said).toContain(`Claude Code: added for its account · model left to the lead agent @ ${g.saved.claude.default_effort}`);
  expect(g.installs.at(-1).accounts.map((a) => a.label)).toEqual(["claude-work"]); // its skills folder is linked in the same run
});

test("guided setup: an account can have no model where its harness has one, and keeps an answer that matched its harness's old value", async () => {
  const none = await guidedRun({ config: { subscriptions: { claude: { ...BASE, accounts: { work: WORK } } } }, answers: ["1", "2", "1", "1", "b", "b", "8"] });
  expect([none.r.ok, none.left, none.saved.claude.accounts.work]).toEqual([true, 0, { folder: WORK, default_model: null }]);
  const kept = await guidedRun({ config: { subscriptions: { claude: { ...BASE, accounts: { work: WORK } } } }, answers: ["1", "1", "1", "m2", "b", "2", "1", "m-own", "b", "b", "8"] });
  expect([kept.r.ok, kept.left, kept.saved.claude.default_model, kept.saved.claude.accounts.work]).toEqual([true, 0, "m2", { folder: WORK, default_model: "m-own" }]);
  // Read back, each is what the person chose.
  const path = configFile({ claude: { ...BASE, share: 3, accounts: { a: { folder: WORK, default_model: null, share: null }, b: OUT } } }), subs = loadConfig(path).config.subscriptions;
  expect([subs["claude-a"].default_model, subs["claude-a"].share, subs["claude-b"].default_model, subs["claude-b"].share]).toEqual([null, null, "m-own", 3]);
});

test("guided setup: a new account beside a metered one is asked its launch share, a folder another account lists is refused, and leaving without saving writes nothing", async () => {
  const config = { subscriptions: { claude: { hardest_work: "strong", reserve: 0.1, share: 3, accounts: { work: WORK } } } };
  // Subscriptions, + Add (after Claude Code and its account), name, folder, three settings, its share, back, Exit without saving.
  const quit = await guidedRun({ config, classes: { claude: "metered", "claude-work": "metered" }, answers: ["1", "3", "w2", "/acct/w2", "", "", "", "", "b", "9"] });
  expect([quit.r.ok, quit.r.cancelled, quit.left, quit.saved]).toEqual([false, true, 0, config.subscriptions]);
  expect(quit.asked).toContainEqual(expect.stringContaining("Claude Code · w2: launch share"));
  const same = await guidedRun({ config, answers: ["1", "3", "w2", WORK, "b", "8"] });
  expect([same.r.ok, same.left, same.saved]).toEqual([true, 0, config.subscriptions]);
  expect(same.said).toContain("Claude Code · w2: its folder is claude-work's too, and one folder is one account");
  // Two added in one run may not share a folder either: the second is refused, and only the first is written.
  const twice = await guidedRun({ config, answers: ["1", "3", "one", "/acct/same", "", "", "", "4", "two", "/acct/same", "b", "8"] });
  expect([twice.r.ok, twice.left, twice.saved.claude.accounts]).toEqual([true, 0, { work: WORK, one: "/acct/same" }]);
  expect(twice.said).toContain("Claude Code · two: its folder is claude-one's too, and one folder is one account");
});

test("guided setup's Subscriptions list is where an account is added, changed and removed, with its folder beside it", async () => {
  const config = { subscriptions: { claude: { ...BASE } } };
  // Subscriptions, + Add another Claude Code account, name, folder (signed in already: no sign-in is offered), hardest
  // kept, reserve 25%, fallback, back, save.
  const add = await guidedRun({ config, answers: ["1", "2", "work", WORK, "", "4", "2", "b", "8"] });
  expect([add.r.ok, add.left, add.logins, add.opens]).toEqual([true, 0, [], []]);
  expect(add.asked).toContainEqual(expect.stringContaining("Claude Code: a name for this account"));
  expect(add.asked.filter((q) => q.startsWith("Claude Code · work"))).toEqual(["Claude Code · work: the hardest work routr may send there", expect.stringContaining("Claude Code · work: reserve"), "Claude Code · work: how may routr use this account?"]);
  expect(add.saved.claude).toEqual({ ...BASE, accounts: { work: { folder: WORK, reserve: 0.25, use: "fallback" } } }); // only what was made to differ is its own
  // Run again: it is a line of the list with its folder, a setting changed there is written under it, and it can be removed.
  const withWork = { subscriptions: add.saved };
  const change = await guidedRun({ config: withWork, answers: ["1", "2", "3", "1", "b", "b", "8"] });
  expect([change.r.ok, change.left, change.saved.claude.accounts.work]).toEqual([true, 0, { folder: WORK, reserve: 0.25, use: "fallback", hardest_work: "basic" }]);
  const list = await guidedRun({ config: withWork, answers: ["1"] }).catch((e) => String(e.message));
  expect(list).toContain(`2. Claude Code · work (${WORK}) (`);
  expect(list).toContain("3. + Add another Claude Code account");
  const gone = await guidedRun({ config: withWork, answers: ["1", "2", "6", "y", "b", "8"] }); // its settings, Remove this account, yes
  expect([gone.r.ok, gone.left, gone.saved.claude]).toEqual([true, 0, BASE]);
  expect(gone.said).toContain(`Claude Code · work: removed from routr (its folder ${WORK} is left as it is)`);
});

test("guided setup signs a new account in and opens its harness once, in the terminal, only on the person's yes", async () => {
  const config = { subscriptions: { claude: { ...BASE } } };
  // The folder is not signed in: yes to signing in, yes to opening Claude Code once, then its settings.
  const yes = await guidedRun({ config, answers: ["1", "2", "max2", OUT, "y", "y", "", "", "", "b", "8"] });
  expect([yes.r.ok, yes.left, yes.logins, yes.opens]).toEqual([true, 0, [{ CLAUDE_CONFIG_DIR: OUT }], [OUT]]);
  expect(yes.saved.claude.accounts).toEqual({ max2: OUT });
  // No to signing in: nothing is started, the command is said, and nothing is added.
  const no = await guidedRun({ config, answers: ["1", "2", "max2", OUT, "n", "b", "8"] });
  expect([no.r.ok, no.left, no.logins, no.opens, no.saved]).toEqual([true, 0, [], [], config.subscriptions]);
  expect(no.said).toContain(`Claude Code · max2: not signed in: run \`claude auth login\` with CLAUDE_CONFIG_DIR set to ${OUT}, then add it again`);
  // A sign-in that did not take (closed, or another account's): checked again, refused the same way, never opened.
  const failed = await guidedRun({ config, loginWorks: false, answers: ["1", "2", "max2", OUT, "y", "b", "8"] });
  expect([failed.r.ok, failed.left, failed.logins.length, failed.opens, failed.saved]).toEqual([true, 0, 1, [], config.subscriptions]);
  expect(failed.said).toContain(`Claude Code · max2: ${OUT} is still not signed in, so it was not added. Choose "+ Add another Claude Code account" again to try once more.`);
  // A flag run never signs in: it refuses with the command.
  const { setup } = await import("../src/lib/setup.mjs");
  const started = [], dir = scratch("accounts-nosignin"), path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const r = await setup(["--config", path, "--yes", "--json", "--account", `claude-max2=${OUT}`], { inspect: async () => ({ harnesses: { claude: { installed: true, signed_in: true, models: [] } }, accounts: {}, config: { path, exists: true, subscriptions: ["claude"], off: [] }, skill: [], decision: [{ works: true }], next_steps: [] }),
    install: () => ({}), share: () => {}, key: async () => ({ ok: true }), hasKey: () => true, print: () => {}, accountSignIn: async () => ({ state: "no" }), accountLogin: async () => { started.push("login"); }, accountOpen: async () => { started.push("open"); } });
  expect([r.ok, started]).toEqual([false, []]);
});
test("an effort for an account with no model of its own is checked against no model, not its harness's", async () => {
  const dir = scratch("accounts-effort"), path = join(dir, "config.json"), { setup } = await import("../src/lib/setup.mjs");
  writeFileSync(path, JSON.stringify({ subscriptions: { claude: { ...BASE, accounts: { work: { folder: WORK, default_model: null }, same: OUT } } } }));
  const inspect = async () => ({ harnesses: { claude: { installed: true, signed_in: true, models: ["m-own"] } }, accounts: { "claude-work": { harness: "claude", signed_in: true }, "claude-same": { harness: "claude", signed_in: true } },
    config: { path, exists: true, subscriptions: ["claude", "claude-work", "claude-same"], off: [] }, skill: [], decision: [{ works: true }], next_steps: [] });
  const run = (flags) => setup(["--config", path, "--yes", "--json", ...flags], { inspect, install: () => ({}), share: () => {}, key: async () => ({ ok: true }), hasKey: () => true, print: () => {},
    efforts: async (n, model) => (model === "m-own" ? ["medium", "high"] : ["low", "medium"]) });
  expect((await run(["--effort", "claude-work=low"])).ok).toBe(true); // no model: the levels for none
  expect((await run(["--effort", "claude-same=low"])).error).toBe("--effort claude-same=low: Claude Code takes medium, high for m-own"); // its harness's model
});

test("a harness command run in the person's terminal gets the account's folder, and routr waits for it and takes its exit code", async () => {
  const { attended } = await import("../src/lib/processes.mjs");
  const dir = scratch("accounts-attended"), out = join(dir, "seen");
  // The child writes what it was given to a file: its output is the terminal's, so nothing of it is captured here.
  const code = await attended(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(out)}, String(process.env.TESTY_HOME)); process.exit(3);`], { account: { TESTY_HOME: WORK } });
  expect([code, readFileSync(out, "utf8")]).toEqual([3, WORK]);
  expect(await attended(join(dir, "no-such-command"), [])).toBeNull();
});
