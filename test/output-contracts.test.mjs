import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { adviseCommand, checkCommand, cleanup, contract, launch, recordCommand, usageCommand } from "./contract.mjs";
import { ans, cfg, cliEnv, fakeExecutable, herdrOK, live, scratch, SCRIPT, shellInfo } from "./helpers.mjs";
import { briefSha, read, shareRows } from "../src/lib/ledger.mjs";
import { telemetryRows } from "../src/lib/telemetry.mjs";
import { callGit, callHerdr } from "../src/lib/process-boundary.mjs";
import { usageFailure } from "../src/lib/usage-failure.mjs";

const MARK = "OUTSIDE_TEXT_MARKER_9c61";
const failure = () => ({ ok: false, data: { error: { code: MARK, message: MARK }, other: MARK } });
const base = ["--kind", "claude", "--name", "worker", "--model", "model"];
const adviceFixture = () => {
  const dir = scratch("contracts"), advice = join(dir, "advice.json"), task = join(dir, "task.txt"), ledger = join(dir, "ledger.jsonl");
  const body = { id: "contract-advice", brief_sha: briefSha(MARK), level: "standard", facts: {} };
  writeFileSync(task, MARK); writeFileSync(advice, JSON.stringify(body));
  return { dir, advice, task, ledger, body, args: [...base, "--cwd", dir, "--advice", advice, "--task-file", task] };
};
const recordOptions = (f) => ({ advice: f.advice, ledger: f.ledger, task_file: f.task, subscription: "claude", model: "model", effort: "default", verdict: "done", check: "pass" });
const withoutScreen = ({ screen, ...rest }) => JSON.stringify(rest);
const judgment = async () => ({ answers: ans(1, 1), provider: "typesafe", model: "jev-test", latencyMs: 1 });
const doText = (r) => r.next.map((n) => n.why).join(" ");

// Both seams and real transports must use the same classifier, including a transport throwing arbitrary text.
test("process failures and malformed answers have fixed codes, never outside prose", async () => {
  for (const run of [async () => failure(), async () => { throw new Error(MARK); }, async () => ({ ok: true, data: MARK })]) {
    for (const args of [["agent", "get", "p"], ["agent", "start", "w"], ["worktree", "create"], ["pane", "split"]]) {
      const r = await callHerdr(run, args, 10); expect(r.ok).toBe(false); expect(r.code).toMatch(/^herdr_(unreachable|refused|invalid_response)$/); expect(JSON.stringify(r)).not.toContain(MARK);
    }
  }
  for (const result of [null, { code: 1, out: MARK, err: MARK }, { code: 0, out: MARK, err: MARK }]) {
    for (const args of [["rev-parse", "--verify", "HEAD"], ["status"], ["ls-files"], ["for-each-ref"], ["worktree", "list"]]) {
      const r = await callGit(async () => result, "/repo", args); expect(r.ok).toBe(false); expect(r.code).toMatch(/^git_(unreachable|refused|invalid_response)$/); expect(JSON.stringify(r)).not.toContain(MARK);
    }
  }
});

test("known herdr error codes stay out of whole launch, cleanup and cursor usage outputs", () => {
  // Unknown markers are discarded immediately; these real codes survive internally for lifecycle decisions.
  const codes = ["agent_not_found", "agent_not_running", "agent_not_ready", "agent_prompt_stalled", "server_not_running", "timeout"];
  const home = scratch("known-herdr-errors"), bin = join(home, "bin"), calls = join(home, "calls.jsonl");
  for (const dir of [bin, join(home, ".config/routr")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".config/routr/config.json"), JSON.stringify({ ...cfg(), auto_update: false }));
  fakeExecutable(bin, "herdr", `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
console.error(JSON.stringify({ error: { code: process.env.FAKE_CODE, message: ${JSON.stringify(MARK)} } })); process.exit(1);`);
  fakeExecutable(bin, "claude", `console.log('{"loggedIn":true}');`);
  fakeExecutable(bin, "cursor-agent", `console.log('Logged in as local@example.invalid');`);
  const env = cliEnv(home, { PATH: bin + delimiter + dirname(process.execPath), HERDR_ENV: "1", FAKE_CALLS: calls });
  const outputs = [];
  for (const code of codes) {
    for (const [command, args, op, exitCode] of [
      ["launch", [...base, "--cwd", home, "--direction", "right"], ["pane", "split"], 1],
      ["cleanup", ["--pane", "w1:p9"], ["pane", "list"], 1],
      ["usage", ["cursor"], ["session", "list"], 0],
    ]) {
      writeFileSync(calls, "");
      const result = Bun.spawnSync([process.execPath, SCRIPT, command, ...args], { env: { ...env, FAKE_CODE: code }, stdin: "ignore" });
      expect(result.exitCode).toBe(exitCode); expect(result.stderr.toString()).toBe("");
      const r = contract(JSON.parse(result.stdout.toString()));
      expect(r.ok).toBe(false);
      expect(readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).slice(0, 2))).toContainEqual(op);
      outputs.push({ command, code, output: result.stdout.toString() });
    }
  }
  // Check every field, including error, headline, next, why and warnings; do not exempt diagnostic subtrees.
  const leaks = outputs.filter(({ output }) => [MARK, ...codes].some((text) => output.includes(text)));
  expect(leaks).toEqual([]);
});

test("pane process-info keeps only shell vocabulary and drops private process names at callHerdr", async () => {
  const cwd = scratch("process-info"), privateName = `${MARK}_process`, privateArgv = `${MARK}_argv0`;
  const r = await callHerdr(async () => shellInfo([
    { pid: 1, name: "zsh", cwd },
    { pid: 2, name: privateName, argv0: privateArgv, cwd },
    { pid: 3, name: "claude", argv0: privateArgv },
  ]), ["pane", "process-info", "w1:p9"], 10);
  expect(JSON.stringify(r)).not.toContain(MARK);
  expect(r).toEqual(herdrOK({ process_info: { shell_pid: 1, foreground_processes: [
    { pid: 1, name: "zsh", cwd }, { pid: 2, name: "shell", cwd }, { pid: 3, name: "shell" },
  ] } }));
});

test("launch never prints herdr failures at any stage, and only screen may contain pre-submission text", async () => {
  const f = adviceFixture();
  for (const op of ["current", "layout", "split", "read", "process-info", "start", "wait", "get", "explain", "prompt", "rename"]) {
    for (const throws of [false, true]) {
      let started = false, sent = false, ticks = 0;
      const run = async (a) => {
        if (a[1] === op) { if (throws) throw new Error(MARK); return failure(); }
        if (a[1] === "current") return herdrOK({ pane: { pane_id: "w1:p1" } });
        if (a[1] === "layout") return herdrOK({ layout: { panes: [{ pane_id: "w1:p1", rect: { width: 100, height: 40 } }] } });
        if (a[1] === "split") return herdrOK({ pane: { pane_id: "w1:p2" } });
        if (a[1] === "process-info") return shellInfo([{ pid: 1, name: "zsh", cwd: f.dir }]);
        if (a[1] === "read") return herdrOK({ text: started ? MARK : "user % " });
        if (a[1] === "start") { started = true; return herdrOK(); }
        if (a[1] === "prompt") { sent = true; return herdrOK({ state: "working" }); }
        if (a[1] === "get") return herdrOK({ agent: { agent: "claude", cwd: f.dir, agent_status: sent ? "working" : op === "explain" ? "blocked" : "idle" } });
        return herdrOK();
      };
      const r = await launch(f.args, { run, ready: async () => null, settings: () => cfg(), env: { HERDR_ENV: "1" }, now: () => ticks, sleep: async (ms) => { ticks += ms; } });
      expect(withoutScreen(r)).not.toContain(MARK);
      if (sent) expect(JSON.stringify(r)).not.toContain(MARK);
      if (op === "start") expect(r.steps.find((s) => s.step === "start").detail).toMatch(/herdr_(refused|unreachable)/);
    }
  }
  for (const op of ["get", "prompt", "rename"]) {
    let sent = false;
    const r = await launch([...f.args, "--pane", "w1:p9"], { env: { HERDR_ENV: "1" }, ready: async () => null, settings: () => cfg(), run: async (a) => {
      if (a[1] === op && (op !== "get" || sent)) return failure();
      if (a[1] === "prompt") sent = true;
      if (a[1] === "get") return herdrOK({ agent: { agent: "claude", cwd: f.dir, agent_status: sent ? "working" : "idle" } });
      return herdrOK({ text: MARK });
    } });
    expect(JSON.stringify(r)).not.toContain(MARK);
  }
});

test("cleanup counts processes and classifies herdr and git across read, remove and branch failures", async () => {
  const f = adviceFixture(), path = join(f.dir, "worker"), sha = "a".repeat(40);
  const worktree = { branch: "worker", path, is_linked_worktree: true };
  for (const op of ["pane-list", "worktree-list", "workspace-list", "process-info", "remove", "branch", "rev-parse", "status", "ls-files", "for-each-ref", "process-name", "pane-close"]) {
    const r = await cleanup(op.startsWith("pane") || ["workspace-list", "process-info", "process-name"].includes(op) ? ["--pane", "w2:p1"] : ["--cwd", f.dir, "--worktree", "worker", "--delete-branch"], {
      env: {}, linked: () => true,
      run: async (a) => {
        if (`${a[0]}-${a[1]}` === op || a[1] === op) return failure();
        if (a[0] === "pane" && a[1] === "list") return herdrOK({ panes: [{ pane_id: "w2:p1", workspace_id: "w2", agent_status: "unknown" }] });
        if (a[0] === "workspace") return herdrOK({ workspaces: [] });
        if (a[1] === "process-info") return shellInfo([{ pid: 1 }, ...(op === "process-name" ? [{ pid: 2, name: MARK, argv0: MARK }] : [])]);
        return herdrOK({ source: { source_checkout_path: f.dir }, worktrees: [worktree] });
      },
      git: async (_dir, a) => {
        if (a[0] === op || (a[1] === "remove" && op === "remove")) return { code: 1, out: MARK, err: MARK };
        return { code: 0, err: MARK, out: a[0] === "rev-parse" ? sha : a[0] === "for-each-ref" ? "refs/heads/worker\n" : "" };
      },
    });
    expect(JSON.stringify(r)).not.toContain(MARK);
    if (op === "process-name") { expect(r.headline).toContain("1 command besides its shell"); expect(r.next[0].argv).toEqual(["herdr", "pane", "read", "w2:p1"]); }
    if (["rev-parse", "status", "ls-files", "for-each-ref"].includes(op)) expect(r.unavailable).toContainEqual(expect.objectContaining({ part: "worktree", path, code: "unreadable" }));
  }
  const recorded = recordCommand(recordOptions(f)); expect(recorded.ok).toBe(true);
  const rows = read(f.ledger);
  for (const value of [readFileSync(f.ledger, "utf8"), JSON.stringify(shareRows(rows)), JSON.stringify(telemetryRows(rows, "local-test"))]) expect(value).not.toContain(MARK);
});

test("herdr structured values are allow-listed before prose or diagnostics are built", async () => {
  const f = adviceFixture();
  const inspect = async (agent, explanation = {}) => launch([...f.args, "--pane", "w1:p2"], { env: { HERDR_ENV: "1" }, settings: () => cfg(), ready: async () => null,
    run: async (a) => a[1] === "get" ? herdrOK({ agent }) : a[1] === "explain" ? herdrOK(explanation) : herdrOK({ text: "question?" }) });
  const occupant = { agent: "claude", cwd: f.dir, agent_status: "idle", interactive_ready: true };
  for (const bad of [MARK, "IDLE", 42, null, {}]) {
    const r = await inspect({ ...occupant, agent_status: bad }); expect(JSON.stringify(r)).not.toContain(MARK); expect(r.needs_input.why).toContain("a state routr does not know");
  }
  for (const bad of [MARK, "CLAUDE", {}]) {
    const r = await inspect({ ...occupant, agent: bad }); expect(JSON.stringify(r)).not.toContain(MARK); expect(r.needs_input.why).toContain("another agent");
  }
  for (const bad of [MARK, "relative/folder", "/control\n" + MARK, "/" + MARK.repeat(40)]) {
    const r = await inspect({ ...occupant, cwd: bad }); expect(JSON.stringify(r)).not.toContain(MARK); expect(r.needs_input.why).toContain("a folder herdr does not report");
  }
  for (const bad of [MARK, "Uppercase", "a".repeat(65), 4]) {
    const r = await inspect({ ...occupant, agent_status: "blocked" }, { state: "blocked", matched_rule: { id: bad }, manifest_version: bad });
    expect(JSON.stringify(r)).not.toContain(MARK); expect(r.needs_input.herdr).toEqual({ state: "blocked" });
  }
  const unknown = await inspect({ ...occupant, agent_status: "blocked" }, { state: MARK, matched_rule: { id: MARK }, manifest_version: MARK });
  expect(JSON.stringify(unknown)).not.toContain(MARK); expect(unknown.needs_input.why).toContain("a state routr does not know");
  const valid = await inspect({ ...occupant, agent_status: "blocked" }, { state: "blocked", matched_rule: { id: "trust_directory" }, manifest_version: "2026.10.01.1" });
  expect(valid.needs_input.herdr).toEqual({ state: "blocked", rule: "trust_directory", rules: "2026.10.01.1" });
  for (const interactive_ready of [MARK, {}, 1]) {
    const r = await callHerdr(async () => herdrOK({ agent: { ...occupant, interactive_ready } }), ["agent", "get", "w1:p2"], 10);
    expect(r.data.result.agent).not.toHaveProperty("interactive_ready"); expect(JSON.stringify(r)).not.toContain(MARK);
  }
});

test("usable advice table applies to record with and without a task and to real and dry launch", async () => {
  const f = adviceFixture();
  for (const [body, accepted, message] of [
    [{ ...f.body, ok: true }, true], [{ ...f.body, ok: true, unavailable: [{ part: "decision model" }] }, true],
    [f.body, true], [{ ...f.body, unavailable: {} }, true], [{ ...f.body, fallback: true }, true], [{ ...f.body, fallback: true, unavailable: [{ part: "decision model" }] }, true],
    [{ ...f.body, ok: false }, false, "refused dispatch"], [{ ...f.body, error: null }, false, "refused dispatch"],
    [{ brief_sha: f.body.brief_sha }, false, "missing id"], [{ ...f.body, id: "" }, false, "missing id"], [{ ...f.body, id: "  " }, false, "missing id"],
    [{ id: "test" }, false, "missing brief_sha"], [{ ...f.body, brief_sha: " " }, false, "missing brief_sha"],
    [[], false, "missing id"], [null, false, "missing id"], ["not JSON", false, "not JSON"],
  ]) {
    writeFileSync(f.advice, typeof body === "string" ? body : JSON.stringify(body));
    for (const task_file of [undefined, f.task]) {
      const r = recordCommand({ ...recordOptions(f), task_file }); expect(r.ok).toBe(accepted); if (!accepted) expect(r.error).toContain(message);
      if (accepted && (body.fallback || body.unavailable?.length)) expect(read(f.ledger).at(-1).advised.fallback).toBe(true);
    }
    for (const dry of [false, true]) {
      let calls = 0, sent = false;
      const r = await launch([...f.args, "--pane", "w1:p9", ...(dry ? ["--dry-run"] : [])], { env: { HERDR_ENV: "1" }, settings: () => cfg(), ready: async () => null,
        run: async (a) => { calls++; if (a[1] === "prompt") sent = true; return a[1] === "get" ? herdrOK({ agent: { agent: "claude", cwd: f.dir, agent_status: sent ? "working" : "idle" } }) : herdrOK(); } });
      if (!accepted) { expect(r.ok).toBe(false); expect(r.error).toContain(message); expect(calls).toBe(0); if (dry) expect(r.would_run.length).toBeGreaterThan(0); }
      else { expect(r.advice.matches).toBe(true); expect(r.state).toBe(dry ? "planned" : "prompted"); }
    }
  }
  for (const task_file of [undefined, f.task]) expect(recordCommand({ ...recordOptions(f), advice: join(f.dir, "missing"), task_file }).error).toContain("could not read it");
  for (const dry of [false, true]) expect((await launch([...base, "--advice", join(f.dir, "missing"), "--task-file", f.task, ...(dry ? ["--dry-run"] : [])])).error).toContain("could not read it");
  for (const flag of ["subscription", "model", "effort", "verdict", "check"]) {
    const r = recordCommand({ ...recordOptions(f), [flag]: undefined }); expect(r.error).toContain(`--${flag}`);
  }
  for (const options of [{}, { brief: f.task }, { report: f.task }]) expect((await checkCommand(options)).error).toContain("check requires");
});

test("every launch record template can be followed, with explicit, default and adopted efforts", async () => {
  const f = adviceFixture();
  for (const [kind, model] of [["claude", "sonnet"], ["codex", "model"], ["cursor", "grok-4.7-high"], ["agy", "gemini-3.8-flash-low"], ["kiro", "auto"]]) {
    for (const effort of [undefined, ...(["claude", "codex", "kiro"].includes(kind) ? ["high"] : [])]) for (const adopted of [false, true]) {
      const r = await launch(["--kind", kind, "--name", "worker", "--model", model, "--advice", f.advice, "--task-file", f.task, "--dry-run", ...(effort ? ["--effort", effort] : []), ...(adopted ? ["--pane", "w1:p9"] : [])]);
      const template = r.next.find((n) => n.template?.startsWith("routr record ")).template;
      expect(template).toContain(`--effort ${adopted ? "<effort>" : effort ?? "default"}`);
      const filled = template.replace("<model>", model).replace("<effort>", "default").replace("<level>", "standard").replace("<done|partial|blocked>", "done").replace("<pass|fail|none>", "pass");
      const words = filled.match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, ""));
      const flags = Object.fromEntries(Array.from({ length: (words.length - 2) / 2 }, (_, i) => [words[2 + i * 2].slice(2).replaceAll("-", "_"), words[3 + i * 2]]));
      const recorded = recordCommand({ ...flags, ledger: f.ledger }); expect(recorded.ok).toBe(true);
    }
  }
});

test("instructions live in next for every capacity view and advice situation", async () => {
  const c = cfg({ subscriptions: { cursor: { hardest_work: "strong", reserve: 0.2, assumed_headroom: 0.5 } } });
  for (const situation of ["reserve", "level", "unconfigured", "failed", "internal", "ordinary"]) {
    const config = structuredClone(c);
    if (situation === "level") config.subscriptions.cursor.hardest_work = "basic";
    if (situation === "unconfigured") config.subscriptions = {};
    const read = async () => situation === "internal" ? null : [{ ...live("cursor", situation === "reserve" ? 0.1 : 0.8), ...(situation === "failed" ? { headroom: null, failure: usageFailure("read_failed") } : {}) }];
    for (const words of [[], ["--level", "strong"], ["cursor"]]) {
      const r = await usageCommand(words, config, {}, { read, sources: { cursor: { check: async () => ({ ok: situation !== "failed", ...usageFailure("read_failed") }) } } });
      const explanations = JSON.stringify({ note: r.subscriptions.note, rows: r.subscriptions.ranked, warnings: r.warnings });
      expect(explanations).not.toMatch(/Hold the work|Tell the user|Read capacity yourself|By hand:|Choose a suitable/);
      if (situation === "reserve") expect(r.next[0].why).toContain("Hold the work");
      if (situation === "unconfigured") expect(doText(r)).toContain("Tell the user");
      if (situation === "failed") expect(r.next.some((n) => n.template === "--headroom cursor=<share left>")).toBe(true);
      if (situation === "internal") expect(doText(r)).toContain("Read capacity yourself");
      if (situation === "ordinary" && !words.length) expect(r.next).toEqual([]);
    }
    const d = await adviseCommand("dispatch", MARK, { config }, {}, { read, askFn: judgment });
    if (situation === "reserve") { expect(d.next[0].why).toContain("Hold the work"); expect(d.next.some((n) => n.template?.startsWith("routr launch"))).toBe(false); }
    if (situation === "failed") expect(doText(d)).toContain("usage by hand");
  }
  const a = { ...ans(1, 0.3, "debug", 0.95), states_check: { noul: 0.1 }, cause_unknown: { noul: 0.5 } };
  const r = await adviseCommand("dispatch", MARK, { config: cfg({ prefer: { debug: "strong" } }) }, {}, { askFn: async () => ({ answers: a, latencyMs: 1 }), read: async () => [] });
  expect(r.notes.join(" ")).not.toMatch(/Fix the brief|Start at|Go higher|Go with|review the result|You can:/);
  for (const step of ["Fix the brief", "Start at", "Settle these", "Go with strong", "Do not go below standard"]) expect(doText(r)).toContain(step);
});

// Run the entry point itself: isolated home and PATH, real source parsing/printing, only fake external processes.
test("source CLI outputs match the field maps in a throwaway home with fake herdr and git", () => {
  const f = adviceFixture(), bin = join(f.dir, "bin"), repo = join(f.dir, "repo"), worker = join(f.dir, "worker"), sent = join(f.dir, "sent");
  for (const dir of [bin, join(repo, ".git"), worker, join(f.dir, ".config/routr"), join(f.dir, ".cursor")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(worker, ".git"), `gitdir: ${join(repo, ".git/worktrees/worker")}\n`);
  writeFileSync(join(f.dir, ".cursor/cli-config.json"), "{}");
  const config = join(f.dir, ".config/routr/config.json");
  writeFileSync(config, JSON.stringify({ ...cfg({ subscriptions: Object.fromEntries(["claude", "codex", "agy", "cursor", "kiro"].map((n) => [n, { hardest_work: "strong", reserve: 0, assumed_headroom: 0.5 }])) }), auto_update: false }));
  const executable = (name, code) => fakeExecutable(bin, name, code);
  executable("herdr", `import { existsSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2), mode = process.env.FAKE_MODE, mark = ${JSON.stringify(MARK)};
const yes = result => console.log(JSON.stringify({ result }));
if (mode === 'failed' || a[0] === 'session') { console.error(JSON.stringify({ error: { code: mark, message: mark }, marker: mark })); process.exit(1); }
if (a[0] === 'agent' && a[1] === 'get') yes({ agent: { agent: 'claude', agent_status: mode === 'needs_input' ? 'blocked' : existsSync(process.env.FAKE_SENT) ? 'working' : 'idle', cwd: process.env.FAKE_CWD, interactive_ready: true } });
else if (a[1] === 'explain') yes({ state: 'blocked', matched_rule: { id: 'trust_directory' }, manifest_version: '2026.10.01.1' });
else if (a[1] === 'prompt') { writeFileSync(process.env.FAKE_SENT, 'sent'); yes({ state: 'working' }); }
else if (a[0] === 'pane' && a[1] === 'read') yes({ text: mark });
else if (a[0] === 'pane' && a[1] === 'list') yes({ panes: mode === 'absent' ? [] : [{ pane_id: 'w2:p1', workspace_id: 'w2', agent_status: mode === 'refused' ? 'working' : 'done' }] });
else if (a[0] === 'workspace') yes({ workspaces: [] });
else if (a[0] === 'worktree' && a[1] === 'list') yes({ source: { source_checkout_path: process.env.FAKE_REPO }, worktrees: mode === 'absent' ? [] : [{ branch: 'worker', path: process.env.FAKE_WORKER, is_linked_worktree: true }] });
else yes({});`);
  executable("git", `const a = process.argv.slice(4), mode = process.env.FAKE_MODE;
if (mode === 'git-failed') { console.log(${JSON.stringify(MARK)}); console.error(${JSON.stringify(MARK)}); process.exit(1); }
if (a[0] === 'rev-parse') console.log('a'.repeat(40));
else if (a[0] === 'for-each-ref') console.log('refs/heads/worker');
else if (mode === 'refused' && a[0] === 'status') process.stdout.write(' M ${MARK}\\0');
else if (mode === 'branch-kept' && a[0] === 'branch') { console.error(${JSON.stringify(MARK)}); process.exit(1); }`);
  executable("claude", `console.log('{"loggedIn":true}');`);
  executable("codex", `console.log('Not logged in'); process.exit(1);`);
  executable("agy", `console.log('Please sign in'); process.exit(1);`);
  executable("cursor-agent", `console.log('Logged in as local@example.invalid');`);
  executable("kiro-cli", `const a = process.argv.slice(2); console.log(a[0] === 'whoami' ? '{"email":"local@example.invalid"}' : JSON.stringify({ type: 'runFinished', data: { finalText: 'Estimated Usage | resets on 2026-11-01 | KIRO FREE\\nCredits (20 of 50 covered in plan), 40.0%' } }));`);
  const fields = {
    subagent: 'id ts mode question_set brief_sha brief_chars provider decision_model unmeasured ms answers level sure between work_type high_risk worker facts notes meaning',
    dispatch: 'id ts mode question_set brief_sha brief_chars provider decision_model unmeasured ms answers level sure between work_type high_risk worker facts notes meaning subscriptions',
    check: 'mode question_set provider decision_model unmeasured ms claimed flags unclear checks',
    launch: 'state kind name pane cwd model effort start steps ran would_run prompt_chars advice worktree needs_input screen',
    record: 'id run_id ledger', cleanup: 'state steps ran cwd pane worktrees worktree branch', usage: 'level subscriptions subscription reading',
  };
  const env = cliEnv(f.dir, { PATH: bin + delimiter + dirname(process.execPath), HERDR_ENV: "1", FAKE_CWD: f.dir, FAKE_SENT: sent, FAKE_REPO: repo, FAKE_WORKER: worker });
  const invoke = (command, args = [], mode = "ordinary", input) => {
    const result = Bun.spawnSync([process.execPath, SCRIPT, command, ...args], { env: { ...env, FAKE_MODE: mode }, stdin: input == null ? "ignore" : Buffer.from(input) });
    expect(result.stderr.toString()).toBe("");
    const r = contract(JSON.parse(result.stdout.toString()));
    const allowed = new Set(['ok', 'headline', 'unavailable', 'warnings', 'next', 'error', ...fields[command].split(' ')]);
    for (const key of Object.keys(r)) expect(allowed.has(key)).toBe(true);
    expect(withoutScreen(r)).not.toContain(MARK);
    return { r, code: result.exitCode };
  };
  for (const command of ["subagent", "dispatch"]) {
    expect(invoke(command, ["--task-file", f.task]).r.ok).toBe(true);
    expect(invoke(command).r).toMatchObject({ ok: false, error: "empty brief" });
  }
  expect(invoke("check").r.error).toContain("--brief");
  expect(invoke("check", ["--brief", f.task, "--report", f.task]).r.ok).toBe(false);
  for (const args of [[], ["--level", "strong"], ...["claude", "codex", "agy", "cursor", "kiro"].map((n) => [n])]) {
    const { r } = invoke("usage", args);
    expect(r.level).toBe(args[0] === "--level" ? "strong" : "basic");
    if (args[0] === "cursor") { expect(r.ok).toBe(false); expect(r.unavailable.some((u) => u.subscription === "cursor")).toBe(true); }
    if (args[0] === "kiro") expect(r.reading).toMatchObject({ credits_used: 20, credits_limit: 50, used_pct: 40 });
  }
  const recordArgs = ["--advice", f.advice, "--ledger", f.ledger, "--subscription", "claude", "--model", "model", "--effort", "default", "--task-file", f.task];
  const recorded = invoke("record", [...recordArgs, "--verdict", "done", "--check", "pass"]).r;
  expect(recorded.id).toBe(f.body.id);
  for (const verdict of ["done", "partial", "blocked"]) for (const check of ["pass", "fail", "none"]) {
    for (const revision of [[], ["--run-id", recorded.run_id]]) {
      const r = invoke("record", [...recordArgs, "--verdict", verdict, "--check", check, ...revision]).r;
      const why = r.next.map((n) => n.why).join(" ");
      if (verdict === "done" && check === "pass") expect(why).toContain("Integrate the verified result");
      else { expect(why).toContain("Send the work back or escalate"); expect(why).toContain("no cleanup yet"); expect(why).not.toContain("Integrate"); }
      expect(r.next.find((n) => n.template?.startsWith("routr record ")).template).toContain(`--run-id ${r.run_id}`);
    }
  }
  for (const run_id of [f.body.id, "12345678-1234-4234-8234-123456789abc"]) {
    const r = invoke("record", [...recordArgs, "--verdict", "blocked", "--check", "none", "--run-id", run_id]).r;
    expect(r.error).toContain("run_id field from record's earlier output, not id"); expect(r.next[0].why).toContain(f.ledger);
  }
  expect(invoke("record").r.error).toContain("--subscription");
  const launchArgs = [...base, "--cwd", f.dir, "--pane", "w1:p9"];
  expect(invoke("launch", [...launchArgs, "--dry-run"]).r.state).toBe("planned");
  expect(invoke("launch", [...launchArgs, "--task-file", f.task, "--dry-run"]).code).toBe(1);
  expect(invoke("launch", launchArgs).r.state).toBe("ready");
  const needsInput = invoke("launch", launchArgs, "needs_input").r;
  expect(needsInput.state).toBe("needs_input");
  const startup = needsInput.next.find((n) => n.template?.startsWith("herdr pane send-keys ")).why;
  expect(startup).toContain("otherwise ask the user and leave the pane waiting");
  expect(startup).toContain('the default answer can be "No, exit"');
  expect(invoke("launch", launchArgs, "failed").r.state).toBe("failed");
  expect(invoke("launch", [...launchArgs, "--task-file", f.task, "--advice", f.advice]).r.state).toBe("prompted");
  for (const args of [["--pane", "w2:p1"], ["--cwd", repo], ["--cwd", repo, "--worktree", "worker"]]) {
    for (const mode of ["ordinary", "absent", "refused", "failed", "git-failed", "branch-kept"]) invoke("cleanup", [...args, ...(mode === "branch-kept" && args.includes("--worktree") ? ["--delete-branch"] : [])], mode);
    invoke("cleanup", [...args, "--dry-run"]);
  }
  const rows = read(f.ledger);
  for (const value of [readFileSync(f.ledger, "utf8"), JSON.stringify(telemetryRows(rows, "local-test"))]) expect(value).not.toContain(MARK);
});

test("classification preserves plain private-session pane reads and discards successful action prose", async () => {
  const r = await callHerdr(async () => ({ ok: true, data: MARK }), ["--session", "routr-scratch-1-abc", "pane", "read", "w1:p1"], 10);
  expect(r).toEqual({ ok: true, data: MARK });
  for (const a of [["agent", "start"], ["agent", "rename"], ["worktree", "remove"], ["pane", "close"]]) {
    const r = await callHerdr(async () => herdrOK({ message: MARK, stderr: MARK }), a, 10);
    expect(JSON.stringify(r)).not.toContain(MARK);
  }
  const d = await adviseCommand("dispatch", MARK, { config: cfg() }, {}, { askFn: async () => { throw new Error(MARK); }, read: async () => [live("claude", 0.9)] });
  expect(doText(d)).not.toContain("Read capacity yourself");
});

test("worktree creation and removal failures keep markers out, including list and prunable reads", async () => {
  const f = adviceFixture();
  const r = await launch([...f.args, "--worktree", "worker"], { env: { HERDR_ENV: "1" }, settings: () => cfg(), ready: async () => null, run: async () => failure() });
  expect(r.state).toBe("failed"); expect(r.error).toContain("herdr_refused"); expect(JSON.stringify(r)).not.toContain(MARK);
  for (const failed of ["list", "remove", "heads"]) {
    const path = join(f.dir, "worker");
    const r = await cleanup(["--cwd", f.dir, "--worktree", "worker"], { env: {}, linked: () => true,
      run: async (a) => {
        if (a[0] === "pane" && a[1] === "list") return failed === "list" ? failure() : herdrOK({ panes: [] });
        if (a[1] === "remove") return failure();
        return herdrOK({ source: { source_checkout_path: f.dir }, worktrees: [{ path, branch: "worker", is_linked_worktree: true, open_workspace_id: "w3", is_prunable: failed === "heads" }] });
      }, git: async (_d, a) => ({ code: a[0] === "worktree" ? 1 : 0, err: MARK, out: a[0] === "rev-parse" ? "a".repeat(40) : a[0] === "for-each-ref" ? "refs/heads/worker\n" : a[0] === "worktree" ? MARK : "" }),
    });
    expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toContain(MARK);
    if (failed === "heads") expect(r.unavailable).toContainEqual(expect.objectContaining({ part: "worktree", path }));
  }
});

test("named fresh failures retain cached readings and Kiro cleanup facts, signed-out readers start nothing", async () => {
  const config = cfg(), read = async () => [{ ...live("cursor", 0.7), source: "cursor snapshot", ageSec: 100 }];
  const r = await usageCommand(["cursor"], config, {}, { read, sources: { cursor: { source: "cursor /usage", check: async () => ({ ok: false, ...usageFailure("read_failed") }) } } });
  expect(r.ok).toBe(false); expect(r.unavailable).toEqual([{ part: "usage", subscription: "cursor", source: "cursor /usage", ...usageFailure("read_failed"), reading: "kept", reading_source: "cursor snapshot", age_sec: 100 }]);
  for (const ok of [true, false]) {
    const r = await usageCommand(["kiro"], cfg({ subscriptions: {} }), {}, { read: async () => [], sources: { kiro: { check: async () => ({ ok, used_pct: 40, note: "Kiro kept an empty usage session; inspect its saved sessions to remove it." }) } } });
    expect(r.warnings).toContain("Kiro kept an empty usage session"); expect(doText(r)).toContain("Inspect Kiro's saved sessions"); expect(r.warnings.join(" ")).not.toContain("inspect");
  }
  const signedOut = await usageCommand(["cursor"], config, {}, { read: async () => { throw new Error("should not read"); }, sources: { cursor: { check: async () => ({ ok: false, excluded: true, why: "not signed in: run cursor-agent login" }) } } });
  expect(signedOut.unavailable).toEqual([]); expect(signedOut.subscriptions.excluded).toEqual([{ subscription: "cursor", why: "not signed in: run cursor-agent login" }]);
});

test("commands that load config carry its warnings on success and refusal", async () => {
  const warnings = ["config warning"], f = adviceFixture();
  for (const o of [recordOptions(f), {}]) expect(recordCommand(o, [], cfg(), { warnings }).warnings).toContain(warnings[0]);
  for (const o of [{}, { brief: f.task, report: f.task }]) expect((await checkCommand(o, { warnings, askFn: judgment })).warnings).toContain(warnings[0]);
  expect((await usageCommand([], cfg(), {}, { warnings, read: async () => [] })).warnings).toContain(warnings[0]);
  const launched = await launch([...base, "--pane", "w1:p9"], { env: { HERDR_ENV: "1" }, ready: async () => null, settings: () => ({ config: cfg(), notes: warnings }),
    run: async () => herdrOK({ agent: { agent: "claude", cwd: process.cwd(), agent_status: "idle" } }) });
  expect(launched.ok).toBe(true); expect(launched.warnings).toContain(warnings[0]);
});
