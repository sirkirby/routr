// Headless workers outside herdr: launch, wait, send, workers, stop, cleanup --worker, the holder and its channel. A fake
// `claude` stands in for Claude Code's stream-json mode, with the behaviours measured in prototypes p34 and p36.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { claim, connect, endpointFor, generations, ownEndpoint, probe, serve, SOCKET_DIR, writeSecret } from "../src/lib/channel.mjs";
import { readEvent } from "../src/lib/headless.mjs";
import { unmakeWorktree, view } from "../src/lib/workers.mjs";
import { worktreesFromGit } from "../src/lib/cleanup.mjs";
import { callGit } from "../src/lib/process-boundary.mjs";
import { launch } from "../src/lib/launch.mjs";
import { harnessEnv, start, stop } from "../src/lib/runtime.mjs";
import { cfg, cliEnv, fakeExecutable, scratch, SCRIPT } from "./helpers.mjs";

// A worker's socket lives under its home, and macOS caps a socket path at 103 bytes: the test scratch folder under
// macOS's long tmpdir would be refused (path_too_long, tested below). So these homes sit in /tmp there, removed after.
const homes = [];
const shortHome = () => { const h = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rw-")); homes.push(h); return h; };
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
const POSIX = process.platform !== "win32";
const until = async (ok, ms = 10000) => { for (let t = 0; t < ms && !ok(); t += 50) await Bun.sleep(50); return ok(); };

// Claude Code's stream-json, as measured: init (with the session), tool_use, background_tasks_changed, result; a
// message on stdin mid-turn joins the running turn; with stdin closed it exits once no background task runs, and a
// background task's end starts a turn of its own. Words in the brief pick a behaviour: HOLD keeps the turn open until
// the test writes the gate file, FAIL ends it with an error, CRASH exits before any event, BACKGROUND leaves a task
// running, MCP uses an MCP tool, LINGER leaves a process in Claude's group that ignores SIGTERM.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "auth") { console.log('{"loggedIn": true, "authMethod": "claude.ai"}'); process.exit(0); }
if (!a.includes("--input-format")) process.exit(0); // any other read (usage) finds nothing
if (process.env.FAKE_ARGV) fs.appendFileSync(process.env.FAKE_ARGV, JSON.stringify(a) + "\\n");
const sid = a.includes("--resume") ? a[a.indexOf("--resume") + 1] : "11111111-2222-3333-4444-555555555555";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "", busy = false, tasks = 0, ended = false, mcp = false; const mid = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(text) {
  if (text.includes("CRASH")) process.exit(3);
  busy = true; mcp ||= text.includes("MCP"); out({ type: "system", subtype: "init", session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: mcp ? "mcp__srv__tool" : "Bash", input: { command: "an argument" } }] } });
  if (text.includes("LINGER")) { const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.env.FAKE_LINGER, String(process.pid)); setInterval(() => {}, 1000)"], { stdio: "ignore" }).unref(); }
  if (text.includes("HOLD")) for (let i = 0; i < 400 && !fs.existsSync(process.env.FAKE_GATE); i++) await sleep(50);
  if (text.includes("BACKGROUND")) { tasks = 1; out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t" }] }); }
  out({ type: "result", subtype: "success", is_error: text.includes("FAIL"), result: "VERDICT: done\\nSUMMARY: turn with " + mid.length + " mid-turn messages" });
  busy = false;
  if (text.includes("BACKGROUND")) { await sleep(500); tasks = 0; out({ type: "system", subtype: "background_tasks_changed", tasks: [] }); await turn("the background task ended"); }
  if (ended && !tasks) leave();
}
process.stdin.on("data", async (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const t = JSON.parse(l).message.content; if (busy) mid.push(t); else await turn(t); } });
// FAKE_HOLD_EXIT: once its input closes, it stays until the test writes the gate file (a Claude slow to exit).
const leave = async () => { if (process.env.FAKE_HOLD_EXIT) for (let i = 0; i < 400 && !fs.existsSync(process.env.FAKE_GATE); i++) await sleep(50); process.exit(0); };
process.stdin.on("end", () => { ended = true; if (!busy && !tasks) leave(); });
`;
const BRIEF = "PRIVATE-BRIEF-7f3a: rename foo to bar in x.js. Check: grep bar x.js.";
const SENT = "PRIVATE-SEND-91c2: also rename baz.";

function world(over = {}) {
  const home = shortHome(), bin = join(home, "bin"), work = join(home, "work"), inputs = join(home, "inputs");
  for (const d of [bin, work, inputs]) mkdirSync(d, { recursive: true });
  fakeExecutable(bin, "claude", FAKE_CLAUDE);
  const gate = join(home, "gate"), linger = join(home, "linger");
  // git's own folder too: launch --worktree and cleanup run it, as they would for a person.
  const env = cliEnv(home, { PATH: [bin, dirname(process.execPath), dirname(Bun.which("git") ?? "git")].join(delimiter), FAKE_ARGV: join(home, "argv.jsonl"), FAKE_GATE: gate, FAKE_LINGER: linger, ...over });
  for (const k of Object.keys(env)) if (/^(HERDR_|CLAUDECODE$|CLAUDE_CODE_SESSION|SANDBOX_RUNTIME$|CODEX_SANDBOX)/.test(k)) delete env[k];
  const outputs = [];
  const run = (args, extra = {}) => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: work, env: { ...env, ...extra }, stdin: "ignore" });
    const text = r.stdout.toString(); outputs.push(text, r.stderr.toString());
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  const task = (text, name = "task.md") => { const f = join(inputs, name); writeFileSync(f, text); return f; };
  const advise = (file) => { const a = join(home, `${file.split(/[\\/]/).pop()}.advice.json`); writeFileSync(a, JSON.stringify(run(["dispatch", "--task-file", file]))); return a; };
  const launchW = (name, file, more = [], extra) => run(["launch", "--kind", "claude", "--name", name, "--model", "haiku", "--task-file", file, "--advice", advise(file), ...more], extra);
  const runDir = (name) => join(home, ".local", "state", "routr", "workers", name);
  const state = (n) => { try { return JSON.parse(readFileSync(join(runDir(n), "state.json"), "utf8")); } catch { return {}; } };
  const settled = (n) => until(() => !["working", "waiting", "starting"].includes(state(n).state));
  return { home, work, gate, linger, inputs, env, run, outputs, task, advise, launch: launchW, runDir, state, settled, release: () => writeFileSync(gate, "") };
}
const filesUnder = (dir) => readdirSync(dir, { recursive: true }).map(String).filter((f) => { try { return statSync(join(dir, f)).isFile(); } catch { return false; } });

test("a headless Claude worker: launch, a message mid-turn, wait, a follow-up that resumes its session, stop and cleanup", async () => {
  const w = world(), file = w.task(`${BRIEF} HOLD`);
  const l = w.launch("w1", file);
  expect([l.ok, l.state, l.headline]).toEqual([true, "prompted", "routr: w1 (claude) took its task, running headless"]);
  expect(l.worker).toEqual({ name: "w1", backend: "headless", run: w.runDir("w1"), session: "11111111-2222-3333-4444-555555555555" });
  expect(l.start.argv.slice(0, 6)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  expect(l.next.map((n) => n.argv ?? n.template)).toEqual([["routr", "wait", "--name", "w1"], expect.stringContaining("routr record --advice"), ["routr", "cleanup", "--worker", "w1"]]);
  // The turn is held open: the message goes into it, and a short wait times out with it still running.
  const s = w.run(["send", "--name", "w1", "--task", SENT]);
  expect([s.ok, s.state, s.message.code]).toEqual([true, "delivered", "handed_to_harness"]);
  expect(w.run(["workers"]).workers[0]).toMatchObject({ name: "w1", state: "working", turn: 1, last_tool: "Bash", report: null });
  expect(w.run(["wait", "--timeout", "300"])).toMatchObject({ ok: true, state: "running", headline: "routr: still running: w1", next: [{ kind: "run", argv: ["routr", "wait", "--name", "w1"] }] });
  w.release();
  const done = w.run(["wait", "--name", "w1", "--timeout", "20000"]);
  expect([done.ok, done.state, done.headline]).toEqual([true, "finished", "routr: w1 finished a turn"]);
  expect(done.workers[0].turns).toEqual([{ turn: 1, outcome: "finished", report: join(w.runDir("w1"), "reports", "turn-1.md"), delivered: 1 }]);
  expect(done.next[0]).toMatchObject({ kind: "do", template: expect.stringContaining("routr check --brief <task-file> --report") });
  expect(readFileSync(done.workers[0].turns[0].report, "utf8")).toContain("turn with 1 mid-turn messages");
  // A wait after that reports nothing twice; an idle worker is not running, and stop says so.
  await w.settled("w1");
  expect(w.run(["wait", "--name", "w1", "--timeout", "2000"])).toMatchObject({ ok: true, state: "idle", headline: "routr: nothing running: w1 idle" });
  expect(w.run(["stop", "--name", "w1"])).toMatchObject({ ok: true, state: "absent" });
  // Idle: a follow-up starts the next holder, which resumes the same session.
  const again = w.run(["send", "--name", "w1", "--task-file", w.task(SENT, "more.md")]);
  expect([again.state, again.message?.code, again.error]).toEqual(["resumed", "prompted", undefined]);
  const resumed = readFileSync(join(w.home, "argv.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x)).at(-1);
  expect(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2)).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
  expect(w.run(["wait", "--name", "w1", "--timeout", "20000"]).workers[0].turns.map((t) => t.turn)).toEqual([2]);
  expect(w.state("w1")).toMatchObject({ gen: 2, turn: 2 });
  // cleanup keeps a running worker; stop ends it through its own process.
  rmSync(w.gate, { force: true });
  expect(w.launch("w2", w.task(`${BRIEF} HOLD`, "slow.md")).state).toBe("prompted");
  expect(w.run(["cleanup", "--worker", "w2"])).toMatchObject({ ok: false, state: "refused", headline: "routr: kept w2: w2 is still running",
    next: [{ kind: "run", argv: ["routr", "wait", "--name", "w2"] }, { kind: "run", argv: ["routr", "stop", "--name", "w2"] }] });
  expect(w.run(["stop", "--name", "w2"])).toMatchObject({ ok: true, state: "stopped", headline: "routr: stopped w2" });
  expect(w.state("w2")).toMatchObject({ state: "stopped", turns: [expect.objectContaining({ outcome: "stopped" })] });
  expect(w.run(["wait", "--name", "w2", "--timeout", "2000"])).toMatchObject({ state: "finished", headline: "routr: w2 stopped" });
  await w.settled("w1");
  expect(w.run(["cleanup", "--worker", "w1", "--dry-run"])).toMatchObject({ ok: true, state: "planned", name: "w1" });
  for (const n of ["w1", "w2"]) expect(w.run(["cleanup", "--worker", n])).toMatchObject({ ok: true, state: "removed", name: n });
  expect(existsSync(w.runDir("w1"))).toBe(false);
  expect(w.run(["cleanup", "--worker", "w1"])).toMatchObject({ ok: true, state: "absent" });
  expect(w.run(["cleanup", "--worker", "w1", "--cwd", w.work]).error).toBe("--worker takes no --cwd: the worker's run folder says where its worktree is");
}, 90000);

test("the brief and messages reach the harness on stdin only: never an answer, an argument, or a file but the reports", async () => {
  const w = world(), l = w.launch("p1", w.task(`${BRIEF} HOLD`));
  expect(l.state).toBe("prompted");
  const dir = w.runDir("p1"), secret = readFileSync(join(dir, "secret"), "utf8");
  expect(w.run(["send", "--name", "p1", "--task", SENT]).state).toBe("delivered");
  w.release();
  w.run(["wait", "--name", "p1", "--timeout", "20000"]);
  w.run(["workers"]);
  await w.settled("p1");
  w.run(["send", "--name", "p1", "--task", SENT]);
  w.run(["wait", "--name", "p1", "--timeout", "20000"]);
  await w.settled("p1");
  w.run(["stop", "--name", "p1"]);
  // Every answer and every stderr, and every file under the home but the test's own inputs and the reports.
  for (const o of w.outputs) for (const m of ["PRIVATE-BRIEF", "PRIVATE-SEND", secret]) expect([m.slice(0, 13), o.includes(m)]).toEqual([m.slice(0, 13), false]);
  const files = filesUnder(w.home).filter((f) => !f.startsWith("inputs") && !f.split(/[\\/]/).includes("reports") && !f.startsWith("bin"));
  expect(files).toEqual(expect.arrayContaining([join(".local", "state", "routr", "workers", "p1", "state.json"), "argv.jsonl"]));
  for (const f of files) {
    const text = readFileSync(join(w.home, f), "utf8");
    for (const m of ["PRIVATE-BRIEF", "PRIVATE-SEND"]) expect([f, m, text.includes(m)]).toEqual([f, m, false]);
    if (!f.endsWith("secret")) expect([f, text.includes(secret)]).toEqual([f, false]);
  }
  if (POSIX) {
    expect(statSync(dir).mode & 0o077).toBe(0);
    for (const f of ["secret", "worker.json", join("reports", "turn-1.md")]) expect([f, statSync(join(dir, f)).mode & 0o077]).toEqual([f, 0]);
  }
  w.run(["cleanup", "--worker", "p1"]);
}, 60000);

test("a turn the harness starts itself, after a background command ends, is waited on like any other", async () => {
  const w = world();
  expect(w.launch("bg", w.task(`${BRIEF} BACKGROUND MCP`)).state).toBe("prompted");
  const seen = [];
  for (let i = 0; i < 3 && seen.length < 2; i++) seen.push(...w.run(["wait", "--name", "bg", "--timeout", "20000"]).workers[0].turns.map((t) => [t.turn, t.outcome]));
  expect(seen).toEqual([[1, "finished"], [2, "finished"]]);
  expect(w.state("bg").last_tool).toBe("mcp");
  await w.settled("bg");
  expect(w.state("bg").state).toBe("idle");
  w.run(["cleanup", "--worker", "bg"]);
}, 60000);

test("a message sent while Claude is exiting is queued, and runs as the next turn on the same session", async () => {
  const w = world({ FAKE_HOLD_EXIT: "1" });
  expect(w.launch("q1", w.task(BRIEF)).state).toBe("prompted");
  expect(w.run(["wait", "--name", "q1", "--timeout", "20000"]).workers[0].turns.map((t) => t.turn)).toEqual([1]);
  // Its input is closed and it has not exited yet: the holder keeps the message for the next Claude.
  await until(() => w.state("q1").state === "waiting", 3000);
  expect(w.run(["send", "--name", "q1", "--task", SENT])).toMatchObject({ ok: true, state: "queued", message: { code: "queued" } });
  w.release(); // the first Claude exits; the holder starts the next on the same session
  const next = w.run(["wait", "--name", "q1", "--timeout", "20000"]);
  expect(next.workers[0].turns).toMatchObject([{ turn: 2, outcome: "finished" }]);
  expect(w.state("q1").turns.map((t) => t.outcome)).toEqual(["finished", "finished"]);
  await w.settled("q1");
  w.run(["cleanup", "--worker", "q1"]);
}, 60000);

// A repository for a worker's worktree: one commit, and an untracked file a launch may --copy.
function repo(w) {
  const g = (...a) => { const r = Bun.spawnSync([Bun.which("git"), "-C", w.work, ...a], { env: { ...w.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); return r.stdout.toString().trim(); };
  g("init", "-q", "-b", "main"); writeFileSync(join(w.work, "x.js"), "let foo = 1;\n"); g("add", "x.js"); g("commit", "-q", "-m", "init");
  writeFileSync(join(w.work, ".env.local"), "LOCAL=1\n");
  return g;
}

test("outside herdr, a worker gets its own worktree, and cleanup --worker removes it only once nothing of the work would be lost", async () => {
  const w = world(), g = repo(w);
  const l = w.launch("t1", w.task(BRIEF), ["--worktree", "work/t1", "--copy", ".env.local"]);
  expect([l.ok, l.state]).toEqual([true, "prompted"]);
  const path = l.worktree.path;
  expect(l.worktree).toEqual({ branch: "work/t1", path, workspace: null });
  expect(path.startsWith(join(realpathSync.native(w.home), ".local", "share", "routr", "worktrees"))).toBe(true);
  expect([l.cwd, existsSync(join(path, "x.js")), readFileSync(join(path, ".env.local"), "utf8")]).toEqual([path, true, "LOCAL=1\n"]);
  expect(g("branch", "--list", "work/t1")).toContain("work/t1");
  expect(w.run(["workers", "--name", "t1"]).workers[0].cwd).toBe(path);
  w.run(["wait", "--name", "t1", "--timeout", "20000"]);
  await w.settled("t1");
  // A file the worker made keeps the worktree, and the worker's run folder with it.
  writeFileSync(join(path, "new.txt"), "work\n");
  const kept = w.run(["cleanup", "--worker", "t1"]);
  expect([kept.ok, kept.state]).toEqual([false, "refused"]);
  expect(kept.headline).toMatch(/^routr: kept t1: 1 untracked file in .+ that the main checkout does not hold as they are$/); // git's form of the path
  expect([existsSync(path), existsSync(w.runDir("t1"))]).toEqual([true, true]);
  rmSync(join(path, "new.txt"));
  // The copy it was given, unchanged, goes with it; the branch is kept unless --delete-branch.
  expect(w.run(["cleanup", "--worker", "t1", "--dry-run"])).toMatchObject({ ok: true, state: "planned", headline: `routr: would remove ${w.runDir("t1")} and ${path}` });
  const done = w.run(["cleanup", "--worker", "t1", "--delete-branch"]);
  expect([done.ok, done.state, done.branch]).toEqual([true, "removed", { name: "work/t1", deleted: true }]);
  expect(done.warnings.filter((x) => x.startsWith("cleanup cannot see a command t1 started that left Claude's process group or detached itself"))).toHaveLength(1);
  expect([existsSync(path), existsSync(w.runDir("t1")), g("branch", "--list", "work/t1")]).toEqual([false, false, ""]);
  // A branch that exists is refused before anything is written.
  g("branch", "taken");
  expect(w.launch("t2", w.task(BRIEF), ["--worktree", "taken"]).error).toBe(`branch taken exists in ${realpathSync.native(w.work)}; choose a new branch for the worker`);
  expect(existsSync(w.runDir("t2"))).toBe(false);
}, 60000);

test("a launch that stops before its worker starts removes the worktree and branch it made", async () => {
  const w = world(), g = repo(w), file = w.task(BRIEF), advice = w.advise(file);
  const saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = w.home;
  try {
    const r = await launch(["--kind", "claude", "--name", "t3", "--model", "m", "--task-file", file, "--advice", advice, "--cwd", w.work, "--worktree", "work/t3", "--copy", ".env.local"],
      { env: {}, settings: () => cfg(), ready: async () => null, spawn: () => false });
    expect([r.state, r.error, r.worker, r.warnings]).toEqual(["failed", "the worker's process did not start (not_started)", null, []]);
  } finally { [process.env.HOME, process.env.USERPROFILE] = saved; }
  expect([g("branch", "--list", "work/t3"), g("worktree", "list").split("\n").length, existsSync(w.runDir("t3"))]).toEqual(["", 1, false]);
}, 60000);

test("a launch that stops early takes back a copied folder too, and never copies through a link in the worktree", async () => {
  const w = world(), g = repo(w), file = w.task(BRIEF), advice = w.advise(file);
  mkdirSync(join(w.work, "fixtures", "deep"), { recursive: true });
  writeFileSync(join(w.work, "fixtures", "deep", "a.json"), "{}\n");
  mkdirSync(join(w.work, "fixtures", "empty", "deeper"), { recursive: true });
  const saved = [process.env.HOME, process.env.USERPROFILE], here = process.cwd();
  process.env.HOME = process.env.USERPROFILE = w.home;
  const go = (branch, more) => launch(["--kind", "claude", "--name", "c1", "--model", "m", "--task-file", file, "--advice", advice, "--cwd", w.work, "--worktree", branch, ...more],
    { env: {}, settings: () => cfg(), ready: async () => null, spawn: () => false });
  try {
    // Run from the source checkout: the folders it took back are the worktree's, never the same names here.
    process.chdir(w.work);
    const r = await go("work/c1", ["--copy", "fixtures"]);
    expect([r.state, r.warnings]).toEqual(["failed", []]);
    expect([g("branch", "--list", "work/c1"), g("worktree", "list").split("\n").length]).toEqual(["", 1]);
    expect([existsSync(join(w.work, "fixtures", "empty", "deeper")), existsSync(join(w.work, "fixtures", "deep", "a.json"))]).toEqual([true, true]);
    if (POSIX) {
      // A folder that is a link in the commit the worktree starts from: nothing is copied through it, and the launch
      // leaves nothing.
      const outside = join(w.home, "outside"); mkdirSync(outside);
      symlinkSync(outside, join(w.work, "cfg")); g("add", "cfg"); g("commit", "-q", "-m", "link");
      unlinkSync(join(w.work, "cfg")); mkdirSync(join(w.work, "cfg")); writeFileSync(join(w.work, "cfg", "local.json"), "{}\n");
      const l = await go("work/c2", ["--copy", "cfg/local.json"]);
      expect([l.state, l.error]).toEqual(["failed", expect.stringContaining("is a link or not a folder; nothing is copied through it")]);
      expect([existsSync(join(outside, "local.json")), g("branch", "--list", "work/c2")]).toEqual([false, ""]);
      // A copied folder that is a link: taken back as a link, and nothing behind it is walked or removed.
      const behind = join(w.home, "behind"); mkdirSync(join(behind, "empty", "deeper"), { recursive: true });
      symlinkSync(behind, join(w.work, "linked"));
      const k = await go("work/c3", ["--copy", "linked"]);
      expect([k.state, k.warnings, g("branch", "--list", "work/c3")]).toEqual(["failed", [], ""]);
      expect(existsSync(join(behind, "empty", "deeper"))).toBe(true);
    }
  } finally { [process.env.HOME, process.env.USERPROFILE] = saved; process.chdir(here); }
}, 60000);

test("cleanup --worker keeps a worktree that took the place of the one launch made, or a folder git does not list", async () => {
  const w = world(), g = repo(w);
  const l = w.launch("r1", w.task(BRIEF), ["--worktree", "work/r1"]);
  expect(l.state).toBe("prompted");
  w.run(["wait", "--name", "r1", "--timeout", "20000"]);
  await w.settled("r1");
  g("worktree", "remove", l.worktree.path); g("worktree", "add", "-q", "-b", "other", l.worktree.path);
  const kept = w.run(["cleanup", "--worker", "r1"]);
  expect([kept.state, kept.headline]).toEqual(["refused", `routr: kept r1: the worktree at ${l.worktree.path} is on branch other, not on work/r1: it is not the one launch made`]);
  expect(existsSync(l.worktree.path)).toBe(true);
  // Made again at the same path on the worker's own branch: another folder, so not the one launch made either.
  g("worktree", "remove", l.worktree.path); g("worktree", "add", "-q", l.worktree.path, "work/r1");
  const again = w.run(["cleanup", "--worker", "r1"]);
  expect([again.state, again.headline]).toEqual(["refused", `routr: kept r1: the worktree at ${l.worktree.path} was made again since launch: it is not the one launch made`]);
  // A plain folder at that path, not a worktree git lists, is not known to be the worker's either.
  g("worktree", "remove", l.worktree.path); mkdirSync(l.worktree.path); writeFileSync(join(l.worktree.path, "notes.txt"), "mine\n");
  const plain = w.run(["cleanup", "--worker", "r1"]);
  expect([plain.state, plain.headline]).toEqual(["refused", `routr: kept r1: git lists no worktree at ${l.worktree.path}, yet a folder is there: routr cannot tell it is the one launch made`]);
  expect([existsSync(join(l.worktree.path, "notes.txt")), existsSync(w.runDir("r1"))]).toEqual([true, true]);
  rmSync(l.worktree.path, { recursive: true });
  expect(w.run(["cleanup", "--worker", "r1"]).state).toBe("removed");
}, 60000);

test("a launch whose worktree git did not make leaves a branch of that name alone: it may be another command's", async () => {
  const w = world(), g = repo(w), start = g("rev-parse", "HEAD");
  g("branch", "raced");
  const out = { warnings: [] };
  await unmakeWorktree({ added: false, branch: "raced", source: w.work, start, path: join(w.home, "wt"), files: [], dirs: [] }, out);
  expect([g("rev-parse", "raced"), out.warnings]).toEqual([start, [`Branch raced exists in ${w.work}, but git did not make this launch's worktree, so whose branch it is cannot be told; it was left`]]);
  const none = { warnings: [] };
  await unmakeWorktree({ added: false, branch: "never", source: w.work, start, path: join(w.home, "wt"), files: [], dirs: [] }, none);
  expect(none.warnings).toEqual([]);
});

test("outside herdr, cleanup lists and removes worktrees through git, and says what it cannot see", () => {
  const w = world(), g = repo(w);
  const wt = join(w.home, "wt one"); g("worktree", "add", "-q", "-b", "side", wt);
  const list = w.run(["cleanup", "--cwd", w.work]);
  expect([list.ok, list.state, list.worktrees.map((x) => [x.branch, x.removable])]).toEqual([true, "listed", [["side", true]]]);
  expect(list.warnings).toContain("Outside herdr, cleanup cannot see whether anything runs in a worktree's folder: it checks git's state only");
  expect(w.run(["cleanup", "--cwd", w.work, "--path", wt, "--delete-branch"])).toMatchObject({ ok: true, state: "removed", branch: { name: "side", deleted: true } });
  expect(existsSync(wt)).toBe(false);
});

test("git's worktree list, read as herdr's: the main checkout, branches, detached, prunable, bare, a path with spaces", async () => {
  const sha = "a".repeat(40);
  const text = [`worktree /repo`, `HEAD ${sha}`, `branch refs/heads/main`, ``, `worktree /wt/a b`, `HEAD ${sha}`, `branch refs/heads/work/x`, ``,
    `worktree /wt/det`, `HEAD ${sha}`, `detached`, ``, `worktree /wt/gone`, `HEAD ${sha}`, `branch refs/heads/old`, `prunable gitdir file points to non-existent location`, ``].join("\n");
  expect(worktreesFromGit(text)).toEqual({ source: { source_checkout_path: "/repo" }, worktrees: [
    { path: "/repo", branch: "main", is_detached: false, is_prunable: false, is_linked_worktree: false, open_workspace_id: null },
    { path: "/wt/a b", branch: "work/x", is_detached: false, is_prunable: false, is_linked_worktree: true, open_workspace_id: null },
    { path: "/wt/det", branch: null, is_detached: true, is_prunable: false, is_linked_worktree: true, open_workspace_id: null },
    { path: "/wt/gone", branch: "old", is_detached: false, is_prunable: true, is_linked_worktree: true, open_workspace_id: null }] });
  const bare = `worktree /repo.git\nbare\n\nworktree /wt/x\nHEAD ${sha}\nbranch refs/heads/x\n`;
  expect(worktreesFromGit(bare).worktrees.map((x) => [x.path, x.is_linked_worktree])).toEqual([["/repo.git", false], ["/wt/x", true]]);
  // The boundary takes a bare repository's record, and a top folder whose name ends in a space, as they are.
  expect((await callGit(async () => ({ out: bare, code: 0 }), "/repo.git", ["worktree", "list", "--porcelain"])).ok).toBe(true);
  expect((await callGit(async () => ({ out: "/repos/project \n", code: 0 }), "/x", ["rev-parse", "--show-toplevel"])).out).toBe("/repos/project \n");
});

test("after a failed turn, wait reports the failure once, then the turn a follow-up resumes", async () => {
  const w = world();
  expect(w.launch("f1", w.task(`${BRIEF} FAIL`)).state).toBe("prompted");
  const first = w.run(["wait", "--name", "f1", "--timeout", "20000"]);
  expect(first.workers[0].turns).toMatchObject([{ turn: 1, outcome: "failed" }]);
  await w.settled("f1");
  // The worker's failed state is said once: with its turn, or by the next wait, never twice.
  const later = [w.run(["wait", "--name", "f1", "--timeout", "2000"]), w.run(["wait", "--name", "f1", "--timeout", "1000"])];
  expect([first, ...later].filter((r) => r.headline === "routr: f1 failed").length).toBe(1);
  expect(later[1]).toMatchObject({ state: "idle" });
  expect(w.run(["send", "--name", "f1", "--task", "try again"]).state).toBe("resumed");
  const second = w.run(["wait", "--name", "f1", "--timeout", "20000"]);
  expect(second.workers[0].turns).toMatchObject([{ turn: 2, outcome: "finished" }]);
  await w.settled("f1");
  w.run(["cleanup", "--worker", "f1"]);
}, 60000);

test("a harness that ends before its session leaves a failed worker that send will not resume", async () => {
  const w = world();
  const l = w.launch("c1", w.task(`${BRIEF} CRASH`));
  expect([l.ok, l.state, l.error]).toEqual([false, "failed", "Launch failed after prompt submission: Claude Code ended before it started the task (harness_ended)"]);
  expect(l.next.map((n) => n.argv ?? n.template)).toEqual(expect.arrayContaining([["routr", "workers", "--name", "c1"], ["routr", "cleanup", "--worker", "c1"]]));
  await w.settled("c1");
  expect(w.state("c1")).toMatchObject({ state: "failed", session_id: null, turns: [expect.objectContaining({ outcome: "no_finish" })] });
  expect(w.run(["send", "--name", "c1", "--task", "again"]).error).toBe("c1 has no session to resume; launch the work again");
  expect(w.run(["send", "--name", "nobody", "--task", "x"]).error).toBe("no headless worker named nobody; routr workers lists them");
  w.run(["cleanup", "--worker", "c1"]);
}, 60000);

test("outside herdr, launch refuses what a headless worker cannot do, before it writes or starts anything", async () => {
  const w = world(), file = w.task(BRIEF), advice = w.advise(file);
  const go = (args, extra) => w.run(["launch", "--name", "r1", "--model", "m", "--task-file", file, "--advice", advice, ...args], extra);
  expect(go(["--kind", "codex"]).error).toBe("outside herdr, routr launch starts Claude Code workers only; run the lead inside herdr for a Codex worker");
  expect(go(["--kind", "claude", "--pane", "w1:p1"]).error).toBe("--pane needs herdr; outside herdr a worker runs headless, with no pane");
  expect(go(["--kind", "claude", "--worktree", "b"]).error).toStartWith("--worktree needs a git repository: git found none at");
  expect(w.run(["launch", "--kind", "claude", "--name", "r1", "--model", "m"]).error).toBe("outside herdr a worker starts with its task: pass --task-file (or --task) and --advice");
  for (const [k, which] of [["SANDBOX_RUNTIME", "Claude Code's Bash sandbox"], ["CODEX_SANDBOX", "Codex's sandbox"]]) expect(go(["--kind", "claude"], { [k]: "1" }).error).toStartWith(`this command runs inside ${which}`);
  expect(w.run(["workers"], { SANDBOX_RUNTIME: "1" }).warnings[0]).toStartWith("this command runs inside Claude Code's Bash sandbox, which may keep it from reaching");
  // Called in-process for the seams: signed out, the subscription off, and a holder that never starts.
  const saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = w.home;
  try {
    const args = ["--kind", "claude", "--name", "r2", "--model", "m", "--task-file", file, "--advice", advice, "--cwd", w.work];
    const deps = { env: {}, settings: () => cfg(), ready: async () => null, spawn: () => false };
    expect((await launch(args, { ...deps, ready: async () => "not signed in: run `claude auth login`" })).error).toBe("Claude Code cannot take work: not signed in: run `claude auth login`");
    expect((await launch(args, { ...deps, settings: () => cfg({ subscriptions: { claude: { enabled: false } } }) })).error).toContain("turned off");
    const never = await launch(args, deps);
    expect([never.state, never.error, never.worker]).toEqual(["failed", "the worker's process did not start (not_started)", null]);
  } finally { [process.env.HOME, process.env.USERPROFILE] = saved; }
  expect(existsSync(w.runDir("r1"))).toBe(false);
  expect(existsSync(w.runDir("r2"))).toBe(false);
  expect(w.run(["wait"])).toMatchObject({ ok: true, state: "none" });
});

test.skipIf(!POSIX)("a home whose socket path would be too long is refused before anything is written", () => {
  const w = world({ HOME: join(scratch("long"), "h".repeat(80)) });
  const r = w.launch("w1", w.task(BRIEF));
  expect([r.ok, r.state]).toEqual([false, "failed"]);
  expect(r.error).toContain("the worker's socket path would be longer than this system allows");
  expect(existsSync(join(w.env.HOME, ".local", "state", "routr", "workers", "w1"))).toBe(false);
}, 30000);

test.skipIf(!POSIX)("a holder killed mid-turn reads as lost, and cleanup keeps the worker while its harness's group lives", async () => {
  const w = world();
  expect(w.launch("k1", w.task(`${BRIEF} HOLD`)).state).toBe("prompted");
  const st = w.state("k1");
  process.kill(st.holder_pid, "SIGKILL");
  await Bun.sleep(200);
  expect(w.run(["workers", "--name", "k1"]).workers[0]).toMatchObject({ state: "lost", harness_group: st.harness_pgid });
  expect(w.run(["cleanup", "--worker", "k1"])).toMatchObject({ state: "refused", headline: `routr: kept k1: k1's harness may still be running (process group ${st.harness_pgid})` });
  expect(w.run(["send", "--name", "k1", "--task", "x"]).error).toStartWith("k1's harness may still be running");
  expect(w.run(["stop", "--name", "k1"])).toMatchObject({ ok: false, state: "lost" });
  expect(w.run(["wait", "--name", "k1", "--timeout", "5000"])).toMatchObject({ state: "finished", headline: "routr: k1 lost" });
  try { process.kill(-st.harness_pgid, "SIGKILL"); } catch {}
  await until(() => { try { process.kill(-st.harness_pgid, 0); return false; } catch { return true; } });
  expect(w.run(["cleanup", "--worker", "k1"])).toMatchObject({ ok: true, state: "removed" });
}, 60000);

test.skipIf(!POSIX)("a process left in Claude's group after it exits keeps the worker from being resumed or removed", async () => {
  const w = world();
  afterAll(() => { try { process.kill(Number(readFileSync(w.linger, "utf8")), "SIGKILL"); } catch {} }); // never left running
  expect(w.launch("g1", w.task(`${BRIEF} LINGER`)).state).toBe("prompted");
  w.run(["wait", "--name", "g1", "--timeout", "20000"]);
  await w.settled("g1");
  const st = w.state("g1");
  expect([st.state, Number.isInteger(st.harness_pgid)]).toEqual(["idle", true]);
  expect(w.run(["cleanup", "--worker", "g1"]).headline).toBe(`routr: kept g1: g1's harness may still be running (process group ${st.harness_pgid})`);
  expect(w.run(["send", "--name", "g1", "--task", "x"]).error).toStartWith("g1's harness may still be running");
  // stop does not signal a group whose Claude has gone (the id may be someone else's by then): it says so.
  expect(w.run(["stop", "--name", "g1"])).toMatchObject({ ok: false, state: "lost" });
  process.kill(Number(readFileSync(w.linger, "utf8")), "SIGKILL");
  await until(() => { try { process.kill(-st.harness_pgid, 0); return false; } catch { return true; } });
  expect(w.run(["cleanup", "--worker", "g1"])).toMatchObject({ ok: true, state: "removed" });
}, 60000);

test("Claude's stream as routr reads it: the session, turns, fixed tool names, background tasks, the turn's end", () => {
  const sid = "a85913d2-fe70-4450-8c5b-4ae162e7a5df";
  expect(readEvent(JSON.stringify({ type: "system", subtype: "init", session_id: sid, cwd: "/x", tools: [] }))).toEqual({ turn: true, session: sid });
  expect(readEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "not an id" }))).toEqual({ turn: true });
  expect(readEvent(JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b", description: "a private title" }] }))).toEqual({ tasks: 1 });
  expect(readEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "rm secret" } }] } }))).toEqual({ tool: "Bash" });
  expect(readEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__myco__search" }] } }))).toEqual({ tool: "mcp" });
  expect(readEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "SomethingNew" }] } }))).toEqual({ tool: "other" });
  expect(readEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } }))).toEqual({ activity: true });
  expect(readEvent(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "VERDICT: done" }))).toEqual({ result: { failed: false, text: "VERDICT: done" } });
  expect(readEvent(JSON.stringify({ type: "result", is_error: true }))).toEqual({ result: { failed: true, text: null } });
  // A report over 1 MB of UTF-8 is cut there, back to a whole character (here the cut falls inside an é); one under it
  // is kept exactly as written, a replacement character at its end included.
  const long = readEvent(JSON.stringify({ type: "result", result: "x" + "é".repeat(700000) })).result.text;
  expect([Buffer.byteLength(long), long.endsWith("é"), long.includes("\uFFFD")]).toEqual([1024 * 1024 - 1, true, false]);
  expect(readEvent(JSON.stringify({ type: "result", result: "ok\uFFFD" })).result.text).toBe("ok\uFFFD");
  for (const l of ["not json", "null", JSON.stringify({ type: "rate_limit_event" }), JSON.stringify({ type: "system", subtype: "hook_started" })]) expect(readEvent(l)).toBeNull();
});

test("the channel: one claimant per generation, and nothing for a peer that has not proved the secret", async () => {
  const home = shortHome(), saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const dir = join(home, "run"); mkdirSync(dir, { mode: 0o700 }); writeSecret(dir);
    // routr never leaves a claim half written; one with no readable pid is not routr's, and nothing is assumed of it.
    writeFileSync(join(dir, "gen-1.claim"), "");
    expect((await probe(dir)).state).toBe("unreachable");
    rmSync(join(dir, "gen-1.claim"));
    expect([claim(dir, 1), claim(dir, 1), generations(dir)]).toEqual([true, false, [1]]);
    const endpoint = endpointFor("abcdef0123456789", 1);
    expect([ownEndpoint("abcdef0123456789", endpoint), ownEndpoint("abcdef0123456789", `${SOCKET_DIR()}X${endpoint.split(/[\\/]/).pop()}`), ownEndpoint("ffffffff01234567", endpoint)]).toEqual([true, false, false]);
    const server = await serve(dir, 1, endpoint, async (op, m) => ({ code: "ok", op, text: m.text }));
    const c = await connect(dir, 1, endpoint);
    expect(await c.request("send", { text: "hi" })).toMatchObject({ t: "res", code: "ok", op: "send", text: "hi" });
    c.close();
    expect(await connect(dir, 1, endpoint, { secret: "wrong" }).then(() => "connected", (e) => e.code)).toBe("server_unproven");
    expect(await connect(dir, 2, endpoint).then(() => "connected", (e) => e.code)).toBe("server_unproven"); // another generation's proof
    // Malformed handshakes get a fixed code and leave the server answering: an old protocol, a proof of the right
    // length in characters but not in bytes.
    const raw = (lines) => new Promise((r) => { const s = net.createConnection(endpoint); let got = ""; s.setEncoding("utf8");
      s.on("connect", () => { for (const l of lines) s.write(JSON.stringify(l) + "\n"); }); s.on("data", (d) => { got += d; }); s.on("close", () => r(got)); s.on("error", () => r(got)); setTimeout(() => { s.destroy(); r(got); }, 3000); });
    expect(await raw([{ t: "hello", v: 0, nc: "a".repeat(32) }])).toContain('"proto_mismatch"');
    expect(await raw([{ t: "hello", v: 1, nc: "a".repeat(32) }, { t: "proof", pc: "é".repeat(64) }])).toContain('"unproven"');
    const again = await connect(dir, 1, endpoint);
    expect((await again.request("ping")).code).toBe("ok");
    again.close(); server.close();
  } finally { [process.env.HOME, process.env.USERPROFILE] = saved; }
});

test("a worker is lost only when its channel and its state are of one generation", async () => {
  const home = shortHome(), saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const dir = join(home, ".local", "state", "routr", "workers", "v1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "worker.json"), JSON.stringify({ format: 1, id: "abcdef0123456789", name: "v1", kind: "claude", model: "m", cwd: home }));
    const gone = Bun.spawnSync([process.execPath, "-e", ""]).pid; // a process that has exited
    const state = (gen) => writeFileSync(join(dir, "state.json"), JSON.stringify({ gen, state: "working", turn: 1, turns: [{ turn: 1 }] }));
    // The state is generation 2's; the channel only shows generation 1, released: the two never agree, so nothing is
    // concluded from the channel.
    writeFileSync(join(dir, "gen-1.claim"), JSON.stringify({ pid: gone, at: 0 }));
    writeFileSync(join(dir, "gen-1.ready"), JSON.stringify({ endpoint: "x", pid: gone }));
    writeFileSync(join(dir, "gen-1.released"), JSON.stringify({ at: 0 }));
    state(2);
    expect((await view("v1")).state).toBe("working");
    // No generation at all beside a running state: still not lost.
    for (const f of ["gen-1.claim", "gen-1.ready", "gen-1.released"]) rmSync(join(dir, f));
    expect((await view("v1")).state).toBe("working");
    // One generation, claimed by a process that is gone and never bound: lost.
    writeFileSync(join(dir, "gen-2.claim"), JSON.stringify({ pid: gone, at: 0 }));
    expect((await view("v1")).state).toBe("lost");
  } finally { [process.env.HOME, process.env.USERPROFILE] = saved; }
});

test("a harness gets none of the lead's session variables, and keeps its sign-in settings", () => {
  const env = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_PID: "1", CODEX_THREAD_ID: "c", HERDR_PANE_ID: "p",
    CLAUDE_CODE_OAUTH_TOKEN: "kept", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_HOME: "/c" };
  expect(harnessEnv(env)).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "kept", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_HOME: "/c" });
});

test.skipIf(!POSIX)("stop with group: true ends what a detached child started in its group, SIGTERM first", async () => {
  const dir = scratch("group"), pidFile = join(dir, "grandchild");
  const code = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1000);`;
  const child = start(process.execPath, ["-e", code], { stdio: "ignore", detached: true });
  await until(() => existsSync(pidFile));
  const g = Number(readFileSync(pidFile, "utf8"));
  const exited = new Promise((r) => child.once("exit", r));
  stop(child, { group: true });
  await exited;
  expect(await until(() => { try { process.kill(g, 0); return false; } catch { return true; } }, 3000)).toBe(true);
});
