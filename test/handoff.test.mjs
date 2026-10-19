import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "./contract.mjs";
import { recordCommand, adviseCommand } from "./contract.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { templateCommand } from "../src/lib/next.mjs";
import { readAdvice, readTask } from "../src/lib/advice-file.mjs";
import { cleanup } from "./contract.mjs";
import { cfg, cliEnv, scratch, SCRIPT, herdrOK } from "./helpers.mjs";

const MARKER = "PRIVATE_BRIEF_HANDOFF_MARKER_9b98";
const base = ["--kind", "claude", "--name", "worker", "--model", "sonnet", "--effort", "low"];
const recordStep = (r) => r.next.find((n) => n.kind === "do" && n.template?.startsWith("routr record "));
function fixture() {
  const dir = scratch("handoff"), task = join(dir, "task.md"), advice = join(dir, "advice.json"), ledger = join(dir, "ledger.jsonl");
  const text = `Fix ${MARKER} and verify it.\n`;
  writeFileSync(task, text);
  const adv = { id: "worker-advice", brief_sha: briefSha(text), ok: true, level: "standard", facts: {} };
  writeFileSync(advice, JSON.stringify(adv));
  return { dir, task, advice, ledger, text, adv };
}
const noCalls = { run: () => { throw new Error("unexpected herdr call"); }, ready: () => { throw new Error("unexpected harness call"); }, models: () => { throw new Error("unexpected model list call"); } };

test("task launch requires readable, hashed, matching advice before any outside call; dry runs refuse and plan", async () => {
  const f = fixture();
  for (const [label, body, error] of [
    ["missing", null, "No advice file was supplied for this task."],
    ["unreadable", null, "could not read it"],
    ["malformed", "not JSON", "not JSON"],
    ["unhashed", JSON.stringify({ id: "old" }), "missing brief_sha"],
    ["mismatched", JSON.stringify({ id: "advice-test", brief_sha: briefSha("someone else's task") }), "different text"],
  ]) {
    const file = join(f.dir, label + ".json");
    if (body) writeFileSync(file, body);
    const args = [...base, "--worktree", "worker", "--task-file", f.task, ...(label === "missing" ? [] : ["--advice", file])];
    const r = await launch(args, noCalls);
    expect([label, r.ok, r.state]).toEqual([label, false, "failed"]);
    expect(r.steps.at(-1).detail).toContain(error);
    expect(recordStep(r)).toBeUndefined();
    expect(r.next[0]).toMatchObject({ kind: "run", argv: ["routr", "dispatch", "--task-file", resolve(f.task)] });
    expect(r.next[0].stdout_to).toBe(resolve(`${f.task}.advice.json`));
    expect(r.next[0].stdout_to).not.toBe(file);
    expect(r.next[0].argv).not.toContain(">");
    const dry = await launch([...args, "--dry-run"], noCalls);
    expect(dry).toMatchObject({ ok: false, state: "planned" });
    expect(dry.error).toContain(error);
    expect(dry.would_run.length).toBeGreaterThan(0);
    expect(recordStep(dry)).toBeUndefined();
    expect(JSON.stringify([r, dry])).not.toContain(MARKER);
  }
  expect(recordStep(await launch([...base, "--dry-run"], noCalls))).toBeUndefined();
  expect(recordStep(await launch([...base, "--advice", f.advice, "--dry-run"], noCalls))).toBeUndefined();
  expect(recordStep(await launch([...base, "--pane", "w1:p9"], adopted("idle")))).toBeUndefined();
});

test("matching fallback advice yields one worker record template on dry and real paths; inline text stays private", async () => {
  const f = fixture();
  const args = [...base, "--task-file", f.task, "--advice", f.advice];
  const dry = await launch([...args, "--dry-run"], noCalls);
  expect(recordStep(dry)).toEqual({ kind: "do", why: expect.stringContaining("Verify"), template: expect.stringContaining("routr record --advice ") });
  for (const part of [templateCommand([resolve(f.advice)]), "--task-file", templateCommand([resolve(f.task)]), "--subscription claude", "--model sonnet", "--effort low", "--level <level>", "--verdict <done|partial|blocked>", "--check <pass|fail|none>"]) expect(recordStep(dry).template).toContain(part);
  for (const extra of [["--pane", "w1:p9"], []]) {
    const noModel = args.filter((_, i) => ![base.indexOf("--model"), base.indexOf("--model") + 1].includes(i));
    const r = await launch([...noModel, ...extra, "--dry-run"], noCalls);
    expect(recordStep(r).template).toContain("--model <model> --effort <effort>");
  }
  const pane = await launch([...args, "--pane", "w1:p9", "--dry-run"], noCalls);
  expect(recordStep(pane).template).toContain("--model <model> --effort <effort>");
  const inline = await launch([...base, "--task", f.text, "--advice", f.advice, "--dry-run"], noCalls);
  expect(recordStep(inline).template).not.toContain("--task-file");
  expect(JSON.stringify(inline)).not.toContain(MARKER);
});

// An already-idle worker needs no shell or real harness. Its own outcome can contain task text in an error;
// after submission launch withholds both the pane and transport messages.
function adopted(status, error = false) {
  let sent = false;
  return { env: { HERDR_ENV: "1" }, settings: () => cfg(), ready: async () => null,
    run: async (a) => {
      if (a[1] === "get") {
        if (sent && error) throw new Error(MARKER);
        return herdrOK({ agent: { agent: "claude", cwd: process.cwd(), agent_status: sent ? status : "idle", interactive_ready: true } });
      }
      if (a[1] === "prompt") { sent = true; return { ok: false, data: { error: { code: "refused", message: MARKER } } }; }
      if (a[1] === "rename") return herdrOK();
      throw new Error(`unexpected call ${a[1]}`);
    } };
}
test("whole launch results withhold the brief in prompted, failed and needs-input paths, including adopted model placeholders", async () => {
  const f = fixture();
  for (const [status, error, state] of [["working", false, "prompted"], ["blocked", false, "needs_input"], ["unknown", false, "needs_input"], ["idle", true, "failed"]]) {
    const r = await launch([...base, "--task-file", f.task, "--advice", f.advice, "--pane", "w1:p9"], adopted(status, error));
    expect(r.state).toBe(state);
    expect(recordStep(r).template).toContain("--model <model> --effort <effort>");
    expect(JSON.stringify(r)).not.toContain(MARKER);
    if (state === "needs_input") {
      for (const argv of [["herdr", "agent", "read", "w1:p9"], ["herdr", "agent", "send-keys", "w1:p9", "enter"]]) {
        const instruction = r.next.find((n) => n.template === templateCommand(argv));
        expect(instruction).toMatchObject({ kind: "do" });
        expect(instruction).not.toHaveProperty("argv");
        expect(instruction).not.toHaveProperty("command");
      }
    }
    for (const n of r.next) expect(Object.hasOwn(n, "argv") && n.kind === "do").toBe(false);
  }
});

test("record compares the task before report processing or append, and revisions keep the original advice id", () => {
  const f = fixture(), other = join(f.dir, "other.md");
  writeFileSync(other, "another worker's task");
  const o = { advice: f.advice, task_file: f.task, ledger: f.ledger, subscription: "claude", model: "sonnet", effort: "low", level: "standard", verdict: "done", check: "pass" };
  const good = recordCommand(o);
  expect(good.ok).toBe(true);
  expect(good.warnings).toEqual([]);
  const bytes = readFileSync(f.ledger, "utf8");
  for (const file of [other, join(f.dir, "gone"), "", "--report"]) {
    const r = recordCommand({ ...o, task_file: file, report: join(f.dir, "unreadable-report") });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--task-file|--advice/);
    expect(readFileSync(f.ledger, "utf8")).toBe(bytes);
  }
  expect(recordCommand({ ...o, task_file: other, run_id: good.run_id }).ok).toBe(false);
  writeFileSync(f.advice, JSON.stringify({ ...f.adv, id: "fresh-dispatch" }));
  const fresh = recordCommand({ ...o, run_id: good.run_id });
  expect(fresh.ok).toBe(false);
  expect(fresh.error).toContain("original advice");
  expect(fresh.error).toContain("omit it for a new run");
  expect(fresh.error).not.toContain("task file is gone");
  expect(readFileSync(f.ledger, "utf8")).toBe(bytes);
  writeFileSync(f.advice, JSON.stringify({ id: "unhashed" }));
  expect(recordCommand(o).error).toContain("missing brief_sha");
  expect(readFileSync(f.ledger, "utf8")).toBe(bytes);
  writeFileSync(f.advice, JSON.stringify(f.adv));
  const missingRevision = recordCommand({ ...o, task_file: join(f.dir, "gone"), run_id: good.run_id });
  expect(missingRevision.error).toContain("If the original task file is gone, revise without --task-file and say so in --note");
  for (const [field, value] of [["subscription", "codex"], ["model", "another-model"], ["effort", "high"], ["level", "strong"], ["project", "another-project"]]) {
    const changed = recordCommand({ ...o, [field]: value, run_id: good.run_id });
    expect(changed.error).toContain(`different ${field}`);
    expect(changed.error).toContain("omit it for a new run");
    expect(changed.error).not.toContain("task file is gone");
  }
  expect(readFileSync(f.ledger, "utf8")).toBe(bytes);
  const revision = recordCommand({ ...o, task_file: undefined, run_id: good.run_id, note: "Original task file is gone." });
  expect(revision.ok).toBe(true);
  expect(revision.warnings.join(" ")).toContain("not checked against a task");
  const inline = recordCommand({ ...o, task_file: undefined });
  expect(inline.ok).toBe(true);
  expect(inline.warnings.join(" ")).toContain("not checked against a task");
  expect(JSON.stringify([good, revision, inline])).not.toContain(MARKER);
  expect(readFileSync(f.ledger, "utf8")).not.toContain(MARKER);
});

test("record next follows the outcome on new rows and revisions, with a usable revision template", () => {
  const f = fixture(), config = cfg();
  config.subscriptions.claude.default_effort = "high";
  const o = { advice: f.advice, task_file: f.task, ledger: f.ledger, project: "gate-project", subscription: "claude", model: "sonnet", effort: "default", level: "strong", verdict: "done", check: "pass" };
  const first = recordCommand(o, [], config);
  for (const verdict of ["done", "partial", "blocked"]) for (const check of ["pass", "fail", "none"]) for (const run_id of [undefined, first.run_id]) {
    const r = recordCommand({ ...o, verdict, check, run_id }, [], config);
    expect(r.ok).toBe(true);
    const why = r.next.map((n) => n.why).join(" ");
    if (verdict === "done" && check === "pass") {
      expect(why).toContain("Integrate the verified result"); expect(why).toContain("cleanup");
    } else {
      expect(why).toContain("Send the work back or escalate"); expect(why).toContain("no cleanup yet"); expect(why).not.toContain("Integrate");
    }
    const step = recordStep(r); expect(step).toBeDefined(); expect(step.kind).toBe("do");
    for (const [flag, value] of [["advice", f.advice], ["task-file", f.task], ["ledger", f.ledger], ["project", o.project], ["subscription", o.subscription], ["model", o.model], ["effort", "high"], ["level", "strong"], ["run-id", r.run_id]]) {
      expect(step.template).toContain(templateCommand([`--${flag}`, value]));
    }
    expect(step.template).toContain("--verdict <done|partial|blocked> --check <pass|fail|none> --note <note>");
    const words = step.template.replace("<done|partial|blocked>", "done").replace("<pass|fail|none>", "pass").replace("<note>", "rechecked").match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, ""));
    const revised = recordCommand(Object.fromEntries(Array.from({ length: (words.length - 2) / 2 }, (_, i) => [words[2 + i * 2].slice(2).replaceAll("-", "_"), words[3 + i * 2]])), [], config);
    expect(revised).toMatchObject({ ok: true, run_id: r.run_id });
  }
  const inline = recordCommand({ ...o, task_file: undefined }, [], config);
  expect(recordStep(inline).template).not.toContain("--task-file");
});

test("record revision resolves relative file inputs and works from another folder", () => {
  const f = fixture(), elsewhere = scratch("revise-elsewhere");
  // Set the cwd in the child before loading the real CLI: this tests record's relative inputs, independently of
  // the spawning runtime's Windows drive-cwd handling. Keep every argument and both CLI invocations unchanged.
  const entry = join(f.dir, "record-cli.mjs");
  writeFileSync(entry, `process.chdir(process.env.ROUTR_TEST_RECORD_CWD); await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`);
  const invoke = (args, cwd, input) => {
    const result = Bun.spawnSync([process.execPath, entry, "record", ...args], { env: cliEnv(f.dir, { PATH: "", ROUTR_TEST_RECORD_CWD: cwd }), stdin: input ? Buffer.from(input) : "ignore" });
    expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe("");
    return JSON.parse(result.stdout.toString());
  };
  const args = ["--advice", "advice.json", "--task-file", "task.md", "--ledger", "ledger.jsonl", "--subscription", "claude", "--model", "sonnet", "--effort", "low", "--level", "standard", "--verdict", "partial", "--check", "fail"];
  const first = invoke(args, f.dir); expect(first.error).toBeUndefined(); expect(first.ok).toBe(true);
  const template = recordStep(first).template;
  const words = template.replace("<done|partial|blocked>", "done").replace("<pass|fail|none>", "pass").replace("<note>", "rechecked").match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, ""));
  // The child resolves against its own cwd, which can be the real path (macOS /var is /private/var), so compare real paths.
  for (const [flag, file] of [["advice", f.advice], ["task-file", f.task], ["ledger", f.ledger]]) {
    const given = words[words.indexOf(`--${flag}`) + 1];
    expect(isAbsolute(given)).toBe(true); expect(realpathSync(given)).toBe(realpathSync(file));
  }
  const revised = invoke(words.slice(2), elsewhere);
  expect(revised.ok).toBe(true); expect(revised.run_id).toBe(first.run_id);
  const rows = readFileSync(f.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.map((r) => r.run_id)).toEqual([first.run_id, first.run_id]);
  expect(rows[1].outcome).toMatchObject({ verdict: "done", check: "pass", note: "rechecked" });
  expect(existsSync(join(elsewhere, "ledger.jsonl"))).toBe(false);
  const stdin = invoke(args.slice(2), f.dir, readFileSync(f.advice, "utf8"));
  expect(stdin.ok).toBe(true); expect(recordStep(stdin).template).toContain("--advice <advice-file>");
});

test("unknown record run ids explain id versus run_id and point to the original output and ledger", () => {
  const f = fixture(), o = { advice: f.advice, task_file: f.task, ledger: f.ledger, subscription: "claude", model: "sonnet", effort: "low", verdict: "partial", check: "fail" };
  recordCommand(o);
  const before = readFileSync(f.ledger, "utf8");
  for (const run_id of [f.adv.id, "", "12345678-1234-4234-8234-123456789abc"]) {
    const r = recordCommand({ ...o, run_id });
    expect(r.ok).toBe(false); expect(r.error).toContain("run_id field from record's earlier output, not id");
    const why = r.next.map((n) => n.why).join(" ");
    expect(why).toContain(f.ledger); expect(why).toContain(f.adv.id); expect(why).toContain("run_id");
    expect(r.next[0].kind).toBe("do"); expect(readFileSync(f.ledger, "utf8")).toBe(before);
  }
  const empty = join(f.dir, "empty-ledger.jsonl");
  const r = recordCommand({ ...o, ledger: empty, run_id: "12345678-1234-4234-8234-123456789abc" });
  expect(r.next[0].kind).toBe("do"); expect(r.next[0].why).toContain("record's earlier output");
  expect(r.next[0].why).toContain(empty); expect(existsSync(empty)).toBe(false);
});

test("CLI file dispatch matches stdin advice, trailing record task-file refuses, and no task text reaches output", async () => {
  const f = fixture();
  const config = join(f.dir, "config.json");
  writeFileSync(config, JSON.stringify({ ...cfg({ subscriptions: {} }), auto_update: false }));
  const run = (args, input) => Bun.spawnSync([process.execPath, SCRIPT, ...args, ...(args[0] === "launch" ? [] : ["--config", config])], { env: cliEnv(f.dir, { PATH: "" }), stdin: input ? Buffer.from(input) : "ignore" });
  for (const cmd of ["dispatch", "subagent"]) {
    const file = run([cmd, "--task-file", f.task]), stdin = run([cmd], f.text);
    const a = JSON.parse(file.stdout.toString()), b = JSON.parse(stdin.stdout.toString());
    for (const r of [a, b]) { delete r.id; delete r.ts; }
    expect(a).toEqual(b);
    expect(file.exitCode).toBe(0);
    expect(file.stdout.toString() + file.stderr.toString()).not.toContain(MARKER);
    for (const flags of [["--task-file"], ["--task-file", "--bad"], ["--task-file", join(f.dir, "missing")]]) expect(JSON.parse(run([cmd, ...flags]).stdout.toString()).ok).toBe(false);
  }
  const rec = run(["record", "--advice", f.advice, "--subscription", "claude", "--model", "sonnet", "--effort", "default", "--verdict", "done", "--check", "pass", "--ledger", f.ledger, "--task-file"]);
  expect(JSON.parse(rec.stdout.toString())).toMatchObject({ ok: false, error: expect.stringContaining("--task-file") });
  expect(existsSync(f.ledger)).toBe(false);
  const other = join(f.dir, "other.md"); writeFileSync(other, "different task");
  const mismatch = run(["record", "--advice", f.advice, "--subscription", "claude", "--model", "sonnet", "--effort", "default", "--verdict", "done", "--check", "pass", "--ledger", f.ledger, "--task-file", other]);
  expect(JSON.parse(mismatch.stdout.toString()).ok).toBe(false);
  expect(existsSync(f.ledger)).toBe(false);
  expect(run(["record", "--help"]).stdout.toString()).toContain("--task-file <path>");
  const dry = run(["launch", ...base, "--task-file", f.task, "--dry-run"]);
  expect(JSON.parse(dry.stdout.toString())).toMatchObject({ ok: false, state: "planned", error: expect.stringContaining("No advice file") });
  const refused = run(["launch", ...base, "--task-file", f.task]);
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout.toString()).ran).toEqual([]);
  const matched = run(["launch", ...base, "--task-file", f.task, "--advice", f.advice, "--dry-run"]);
  expect(recordStep(JSON.parse(matched.stdout.toString())).template).toContain("--task-file");
  expect([dry, refused, matched, mismatch, rec].map((r) => r.stdout.toString() + r.stderr.toString()).join(" ")).not.toContain(MARKER);
});

test("whole dispatch, record and cleanup results never carry the brief marker", async () => {
  const f = fixture();
  const dispatch = await adviseCommand("dispatch", f.text, { config: cfg() }, {}, { askFn: async () => { throw new Error(MARKER); }, read: async () => [] });
  const record = recordCommand({ advice: f.advice, task_file: f.task, ledger: f.ledger, subscription: "claude", model: "sonnet", effort: "default", verdict: "done", check: "pass" });
  const cleaned = await cleanup(["--pane", "w1:p2"], { run: async () => herdrOK({ panes: [] }), env: {} });
  expect(JSON.stringify([dispatch, record, cleaned])).not.toContain(MARKER);
});


test("advice written by PowerShell is readable as UTF-8 BOM and UTF-16LE with or without BOM", async () => {
  const f = fixture(), json = JSON.stringify({ ...f.adv, note: "café" });
  for (const bytes of [Buffer.from(json), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
    Buffer.from(json, "utf16le"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")])]) {
    writeFileSync(f.advice, bytes);
    expect(readAdvice(f.advice)).toEqual(JSON.parse(json));
    const planned = await launch([...base, "--task-file", f.task, "--advice", f.advice, "--dry-run"], noCalls);
    expect(planned.advice.matches).toBe(true);
    expect(recordStep(planned)).toBeDefined();
    expect(recordCommand({ advice: f.advice, task_file: f.task, ledger: f.ledger, subscription: "claude", model: "sonnet", effort: "default", verdict: "done", check: "pass" }).ok).toBe(true);
  }
  expect(readFileSync(f.ledger, "utf8").trim().split("\n")).toHaveLength(4);
});

test("a task file written by PowerShell reads as the same text in every encoding, and its advice still matches", async () => {
  const f = fixture(), text = readFileSync(f.task, "utf8") + " café";
  for (const bytes of [Buffer.from(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    Buffer.from(text, "utf16le"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])]) {
    writeFileSync(f.task, bytes);
    expect(readTask(f.task)).toBe(text); // never garbled: the decision model and the worker get what the lead wrote
  }
  writeFileSync(f.task, Buffer.from([0x41, 0x00, 0x42])); // an odd length cannot be UTF-16
  expect(() => readTask(f.task)).toThrow("not readable text");
});

test("templates replace expanding paths with placeholders, while runnable steps retain exact argv", async () => {
  const f = fixture(), task = join(f.dir, "task-$HOME`cmd`.md"), advice = join(f.dir, "advice-$HOME`cmd`.json");
  writeFileSync(task, f.text); writeFileSync(advice, JSON.stringify(f.adv));
  for (const suffix of [["--dry-run"], ["--pane", "w1:p9"]]) {
    const r = await launch([...base, "--task-file", task, "--advice", advice, ...suffix], adopted("blocked"));
    expect(recordStep(r).template).toContain("--advice <advice> --task-file <task-file>");
    for (const n of r.next.filter((n) => n.template)) {
      expect(n.template).not.toContain("$HOME"); expect(n.template).not.toContain("`cmd`");
    }
  }
  const missing = await launch([...base, "--task-file", task], noCalls);
  expect(missing.next[0].argv).toEqual(["routr", "dispatch", "--task-file", task]);
  expect(missing.next[0].command).toBeNull();
  expect(missing.next[0].stdout_to).toBe(`${task}.advice.json`);
});
