import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, launch, adviseCommand, checkCommand, usageCommand, contract, noMovedInstructions } from "./contract.mjs";
import { cfg, scratch, herdrOK, herdrError, shellInfo, cliEnv, fakeExecutable, SCRIPT, live } from "./helpers.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { processFailure } from "../src/lib/process-boundary.mjs";
const base = ["--kind", "claude", "--name", "worker", "--model", "model"];
const text = (r) => r.next.map((n) => n.why).join(" ");
const fixture = () => {
  const dir = scratch("review-contracts"), advice = join(dir, "advice.json"), task = join(dir, "task.txt");
  writeFileSync(task, "Fix the test and verify it."); writeFileSync(advice, JSON.stringify({ id: "review", brief_sha: briefSha(readFileSync(task, "utf8")) }));
  return { dir, advice, task };
};
const deps = (run) => ({ run, env: { HERDR_ENV: "1" }, settings: () => cfg(), ready: async () => null });

test("review 1/10: adopted busy, unknown, not-ready and explained states have truthful headlines", async () => {
  for (const [state, ready, explanation] of [["working", true], ["unknown", true], ["idle", false], ["blocked", true, "working"], ["blocked", true, undefined]]) {
    const r = await launch([...base, "--pane", "w1:p9"], deps(async (a) => a[1] === "get" ? herdrOK({ agent: { agent: "claude", cwd: process.cwd(), agent_status: state, interactive_ready: ready } }) : a[1] === "explain" ? herdrOK(explanation ? { state: explanation } : {}) : herdrOK({ text: "question?" })));
    expect(r.state).toBe("needs_input"); expect(r.headline).toContain(r.needs_input.why);
    if (state === "blocked" && explanation === undefined) expect(r.needs_input.herdr).toEqual({ state: "blocked" });
  }
});

test("review 2: unranked views explain actual exclusions and never lower basic", async () => {
  const c = cfg({ subscriptions: { claude: { ...cfg().subscriptions.claude, enabled: false } } });
  for (const words of [[], ["claude"], ["--level", "basic"]]) {
    const r = await usageCommand(words, c, {}, { read: async () => [] });
    expect(r.subscriptions.note).toContain("turned off"); expect(r.headline).toContain("turned off"); expect(text(r)).not.toContain("lower level"); expect(text(r)).toContain("eligible subscription");
  }
  const signedOut = await usageCommand(["cursor"], cfg(), {}, { sources: { cursor: { check: async () => ({ ok: false, excluded: true, why: "not signed in: run cursor-agent login" }) } }, read: async () => [] });
  expect(signedOut.subscriptions.note).toContain("not signed in"); expect(text(signedOut)).not.toContain("lower level");
  const unconfigured = await usageCommand(["kiro"], c, {}, { sources: { kiro: { check: async () => ({ ok: true, used_pct: 40 }) } }, read: async () => [] });
  expect(unconfigured.subscriptions.note).toContain("kiro is not configured"); expect(text(unconfigured)).not.toContain("lower level");
});

test("review 3: model-less dry runs refuse with a plan and model next step", async () => {
  const r = await launch(["--kind", "claude", "--name", "worker", "--dry-run"]);
  expect(r.ok).toBe(false); expect(r.error).toContain("--model is required"); expect(r.would_run.length).toBeGreaterThan(0); expect(text(r)).toContain("Choose --model");
});

test("review 4/5: failed refs are unreadable, dirty and untracked refusals offer git status", async () => {
  const f = fixture(), path = join(f.dir, "worker"), sha = "a".repeat(40);
  for (const mode of ["refs-fail", "refs-malformed", "dirty", "untracked", "prunable-refs", "prunable-heads"]) {
    const r = await cleanup(["--cwd", f.dir, "--worktree", "worker"], { env: {}, linked: () => true,
      run: async () => herdrOK({ source: { source_checkout_path: f.dir }, worktrees: [{ path, branch: "worker", is_linked_worktree: true, is_prunable: mode.startsWith("prunable") }] }),
      git: async (_d, a) => ({ code: mode.endsWith("fail") && a[0] === "for-each-ref" ? 1 : 0, out: a[0] === "rev-parse" ? sha : a[0] === "for-each-ref" ? mode === "refs-malformed" ? "BAD" : mode === "prunable-refs" ? null : "refs/heads/worker\n" : a[0] === "worktree" ? mode === "prunable-heads" ? "BAD" : `worktree ${path}\nHEAD ${sha}\ndetached\n` : a[0] === "status" ? mode === "dirty" ? " M a.txt\0" : mode === "untracked" ? "?? new.txt\0" : "" : "" }),
    });
    expect(r.ok).toBe(false);
    if (mode.includes("refs")) { expect(r.headline).toContain("could not read the refs"); expect(r.headline).not.toContain("no branch or tag holds"); expect(text(r)).toContain("refs"); }
    if (mode === "prunable-heads") expect(r.headline).toContain("could not read the recorded commit");
    if (["dirty", "untracked"].includes(mode)) expect(r.next).toContainEqual(expect.objectContaining({ kind: "run", argv: ["git", "-C", path, "status"] }));
  }
});

test("review 6: every moved sentence is rejected in explanatory strings of every output", () => {
  const sentences = ["Fix the brief first: add a check.", "Start at strong; go higher if a fact calls for it.", "You can: you know the codebase.", "Settle these from the codebase.", "Go with strong unless the work is plainly rote.", "Do not go below standard, and review the result.", "Choose a suitable model and effort from normal candidates first.", "every account is at its reserve: hold the work or ask the user", "choose a lower level", "Tell them, and ask which subscription to use meanwhile", "By hand: run cursor-agent", "Read Cursor's usage by hand", "pass --headroom cursor=0.5", "set `billing: \"metered\"` for claude", "Read capacity yourself before choosing an account.", "Pane p was left alive; inspect it before closing or retrying.", "Prompt may have been submitted; inspect the pane before retrying.", "Cursor config is retained; remove it if the launch command did not run.", "Could not rename it: address it by its pane.", "check the model's /effort panel", "Plan only: choose --model before launching.", "Omit --task-file only for an inline task; say so in --note.", "If this task came from a file, revise this row with --run-id and --task-file."];
  for (const mode of ["dispatch", "subagent", "launch", "check", "record", "cleanup", "usage"]) for (const sentence of sentences) for (const key of ["notes", "note", "why", "warnings"]) {
    const r = { mode, [key]: ["notes", "warnings"].includes(key) ? [sentence.toUpperCase()] : sentence.toLowerCase() };
    expect(() => noMovedInstructions(r)).toThrow();
    expect(() => noMovedInstructions({ next: [{ why: sentence }] })).not.toThrow();
    expect(() => noMovedInstructions({ subscriptions: { ranked: [r] } })).toThrow();
  }
});

test("review 6/7/8: dispatch reports unavailable parts, subagent stays local, check names failed provider", async () => {
  const f = fixture(), askFn = async () => { throw new Error("unavailable"); };
  const dispatch = await adviseCommand("dispatch", "task", { config: cfg() }, {}, { askFn, read: async () => [live("claude", 0.9)] });
  expect(text(dispatch)).toContain("Tell the user what was unavailable");
  const subagent = await adviseCommand("subagent", "task", { config: cfg() }, {}, { askFn });
  expect(subagent.next.filter((n) => /unavailable|fallback|judge the level/i.test(n.why)).map((n) => n.why).join(" ")).not.toMatch(/launch|tell the user/i);
  const checked = await checkCommand({ brief: f.task, report: f.task }, { askFn });
  expect(checked.provider).toBe(checked.unavailable[0].provider);
});

test("review 9: startup questions continue directly; failed starts say no task was delivered", async () => {
  const f = fixture(); let ticks = 0;
  for (const refused of [false, true]) {
    let started = false;
    const r = await launch([...base, "--cwd", f.dir, "--task-file", f.task, "--advice", f.advice, "--direction", "right"], { ...deps(async (a) => {
      if (a[1] === "split") return herdrOK({ pane: { pane_id: "w1:p2" } });
      if (a[1] === "read") return herdrOK({ text: started ? "question?" : "user % " });
      if (a[1] === "process-info") return shellInfo([{ pid: 1, name: "zsh", cwd: f.dir }]);
      if (a[1] === "start") { started = true; return refused ? herdrError("invalid_request") : herdrOK(); }
      if (a[1] === "get") return herdrOK({ agent: { agent: "claude", agent_status: "blocked" } });
      if (a[1] === "explain") return herdrOK({ state: "blocked" });
      return herdrOK();
    }), now: () => ticks, sleep: async (ms) => { ticks += ms; } });
    const record = r.next.find((n) => n.template?.startsWith("routr record"));
    if (refused) { expect(record.why).toContain("No task was delivered"); expect(record.template).toContain("--verdict blocked"); }
    else { expect(r.state).toBe("needs_input"); expect(r.next.some((n) => /before closing it or retrying/i.test(n.why))).toBe(false); }
  }
});

test("review 11: missing herdr has installation guidance, process refusal names tool once", async () => {
  expect(processFailure("herdr", ["pane", "split"], "herdr_refused").why).toBe("herdr refused pane split (herdr_refused).");
  for (const command of [launch, cleanup]) {
    const args = command === launch ? [...base, "--direction", "right"] : ["--pane", "w1:p9"];
    const r = await command(args, deps(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }));
    expect(r.headline).toContain("herdr is not installed"); expect(text(r)).toContain("Install herdr");
  }
});

test("review inputs through the source CLI show corrected headlines, reasons and next steps", () => {
  const f = fixture(), bin = join(f.dir, "bin"), noHerdr = join(f.dir, "no-herdr"), repo = join(f.dir, "repo"), worker = join(f.dir, "worker");
  for (const dir of [bin, noHerdr, join(repo, ".git"), worker, join(f.dir, ".config/routr"), join(f.dir, ".cache/routr")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(worker, ".git"), `gitdir: ${join(repo, ".git/worktrees/worker")}\n`);
  const config = join(f.dir, ".config/routr/config.json"), stage = join(f.dir, "stage"), signed = join(f.dir, ".cache/routr/signed-in.json");
  const setup = (subscriptions = { claude: cfg().subscriptions.claude, cursor: cfg().subscriptions.cursor }) => writeFileSync(config, JSON.stringify({ ...cfg({ subscriptions }), auto_update: false }));
  const executable = fakeExecutable;
  for (const where of [bin, noHerdr]) executable(where, "claude", `console.log('{"loggedIn":true}');`);
  executable(bin, "cursor-agent", `console.log('Not logged in');`);
  executable(bin, "kiro-cli", `const a=process.argv.slice(2); console.log(a[0]==='whoami' ? '{"email":"test@example.invalid"}' : JSON.stringify({type:'runFinished', data:{finalText:'Estimated Usage | resets on 2026-11-01 | KIRO FREE\\nCredits (20 of 50 covered in plan), 40.0%'}}));`);
  executable(bin, "git", `const a=process.argv.slice(4), m=process.env.REVIEW_MODE;
if(a[0]==='rev-parse') console.log('a'.repeat(40));
else if(a[0]==='for-each-ref') { if(m==='refs-fail') { console.error('private error'); process.exit(1); } console.log(m==='refs-bad'?'private malformed response':'refs/heads/worker'); }
else if(a[0]==='status') process.stdout.write(m==='dirty'?' M changed.txt\\0':m==='untracked'?'?? new.txt\\0':'');`);
  executable(bin, "herdr", `import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
const a=process.argv.slice(2), m=process.env.REVIEW_MODE, p=process.env.REVIEW_ROOT;
const yes=result=>console.log(JSON.stringify({result})); let stage=''; try{stage=readFileSync(p+'/stage','utf8')}catch{}
if(a[1]==='get') yes({agent:{agent:'claude',cwd:p,agent_status: ['explain-working','missing-state'].includes(m)?'blocked':['working','unknown'].includes(m)?m:m==='start-question'?'blocked':'idle',interactive_ready:m!=='not-ready'}});
else if(a[1]==='explain') yes(m==='missing-state'?{}:{state:m==='explain-working'?'working':'blocked'});
else if(a[1]==='read') yes({text:stage==='start'?'Question?':'user % '});
else if(a[1]==='process-info') yes({process_info:{shell_pid:1,foreground_processes:[{pid:1,name:'zsh',cwd:p},...(m==='busy'?[{pid:2,name:'private'}]:[])]}});
else if(a[1]==='split') yes({pane:{pane_id:'w1:p2'}});
else if(a[1]==='start'){writeFileSync(p+'/stage','start');if(m==='start-refused'){console.error(JSON.stringify({error:{code:'invalid_request',message:'private error'}}));process.exit(1)}yes({});}
else if(a[0]==='worktree'&&a[1]==='list') yes({source:{source_checkout_path:join(p,'repo')},worktrees:[{path:join(p,'worker'),branch:'worker',is_linked_worktree:true}]});
else if(a[0]==='pane'&&a[1]==='list') yes({panes:[{pane_id:'w1:p9',agent_status:'unknown'}]});
else if(a[0]==='workspace') yes({workspaces:[]});
else yes({});`);
  setup();
  const invoke = (command, args = [], mode = "ordinary", path = bin) => {
    writeFileSync(stage, ""); writeFileSync(signed, JSON.stringify({ claude: { state: "yes", ts: Date.now()/1000 } }));
    const r = Bun.spawnSync([process.execPath, SCRIPT, command, ...args], { env: cliEnv(f.dir, { PATH: path, HERDR_ENV: "1", REVIEW_MODE: mode, REVIEW_ROOT: f.dir }), stdin: "ignore" });
    expect(r.stderr.toString()).toBe("");
    return { out: contract(JSON.parse(r.stdout.toString())), code: r.exitCode };
  };
  const launchArgs = [...base, "--cwd", f.dir, "--pane", "w1:p9"];
  for (const mode of ["working", "unknown", "not-ready", "explain-working", "missing-state"]) {
    const { out } = invoke("launch", launchArgs, mode);
    expect(out.headline).toContain("needs input"); expect(out.headline).toContain(out.needs_input.why);
    if (mode === "missing-state") expect(out.needs_input.herdr).toEqual({ state: "blocked" });
  }
  setup({ claude: { ...cfg().subscriptions.claude, enabled: false } });
  for (const words of [[], ["claude"], ["--level", "basic"]]) {
    const { out } = invoke("usage", words); expect(out.headline).toContain("turned off"); expect(text(out)).not.toContain("lower level");
  }
  setup();
  const unconfigured = invoke("usage", ["kiro"]).out;
  expect(unconfigured.headline).toContain("kiro is not configured"); expect(unconfigured.subscriptions.note).not.toContain("no configured subscription takes");
  const signedOut = invoke("usage", ["cursor"]).out;
  expect(signedOut.subscriptions.note).toContain("not signed in"); expect(text(signedOut)).not.toContain("lower level");
  const dry = invoke("launch", ["--kind", "claude", "--name", "worker", "--dry-run"]);
  expect(dry.code).toBe(1); expect(dry.out.error).toContain("--model is required"); expect(dry.out.would_run.length).toBeGreaterThan(0);
  for (const mode of ["refs-fail", "refs-bad", "dirty", "untracked"]) {
    const out = invoke("cleanup", ["--cwd", repo, "--worktree", "worker"], mode).out;
    if (mode.startsWith("refs")) { expect(out.headline).toContain("could not read the refs"); expect(text(out)).not.toContain("Keep the commit"); }
    else expect(out.next).toContainEqual(expect.objectContaining({ kind: "run", argv: ["git", "-C", worker, "status"] }));
  }
  const dispatch = invoke("dispatch", ["--task-file", f.task]).out;
  expect(text(dispatch)).toContain("Tell the user what was unavailable"); expect(invoke("usage", ["claude"]).out.headline).toContain("1 reading unavailable");
  const subagent = invoke("subagent", ["--task-file", f.task]).out;
  expect(text(subagent)).not.toContain("Tell the user");
  const check = invoke("check", ["--brief", f.task, "--report", f.task]).out;
  expect(check.provider).toBe(check.unavailable[0].provider);
  for (const mode of ["start-question", "start-refused"]) {
    const out = invoke("launch", [...base, "--cwd", f.dir, "--direction", "right", "--task-file", f.task, "--advice", f.advice], mode).out;
    if (mode === "start-question") expect(out.next.some((n) => /before closing it or retrying/.test(n.why))).toBe(false);
    else expect(out.next.find((n) => n.template?.startsWith("routr record")).why).toContain("No task was delivered");
  }
  const missing = invoke("launch", [...base, "--cwd", f.dir, "--direction", "right"], "ordinary", noHerdr).out;
  expect(missing.error).toContain("herdr is not installed"); expect(text(missing)).toContain("Install herdr");
  expect(invoke("cleanup", ["--cwd", repo]).out.headline).toContain("1 worktree,");
  expect(invoke("cleanup", ["--pane", "w1:p9"], "busy").out.headline).toContain("1 command besides its shell");
});
