import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch } from "../src/lib/launch.mjs";
import { recordCommand, adviseCommand } from "../src/lib/commands.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { cleanup } from "../src/lib/cleanup.mjs";
import { cfg, cliEnv, scratch, SCRIPT, herdrOK } from "./helpers.mjs";

const MARKER = "PRIVATE_BRIEF_HANDOFF_MARKER_9b98";
const base = ["--kind", "claude", "--name", "worker", "--model", "sonnet", "--effort", "low"];
const recordStep = (r) => r.next.find((n) => n.kind === "do" && n.template?.startsWith("routr record "));
function fixture() {
  const dir = scratch("handoff"), task = join(dir, "task.md"), advice = join(dir, "advice.json"), ledger = join(dir, "ledger.jsonl");
  const text = `Fix ${MARKER} and verify it.\n`;
  writeFileSync(task, text);
  const adv = { id: "worker-advice", brief_sha: briefSha(text), fallback: true, level: "standard", facts: {} };
  writeFileSync(advice, JSON.stringify(adv));
  return { dir, task, advice, ledger, text, adv };
}
const noCalls = { run: () => { throw new Error("unexpected herdr call"); }, ready: () => { throw new Error("unexpected harness call"); }, models: () => { throw new Error("unexpected model list call"); } };

test("task launch requires readable, hashed, matching advice before any outside call; dry runs warn and plan", async () => {
  const f = fixture();
  for (const [label, body, error] of [
    ["missing", null, "No advice file was supplied for this task."],
    ["unreadable", null, "could not read it"],
    ["malformed", "not JSON", "not JSON"],
    ["unhashed", JSON.stringify({ id: "old" }), "missing brief_sha"],
    ["mismatched", JSON.stringify({ brief_sha: briefSha("someone else's task") }), "different text"],
  ]) {
    const file = join(f.dir, label + ".json");
    if (body) writeFileSync(file, body);
    const args = [...base, "--worktree", "worker", "--task-file", f.task, ...(label === "missing" ? [] : ["--advice", file])];
    const r = await launch(args, noCalls);
    expect([label, r.ok, r.state]).toEqual([label, false, "failed"]);
    expect(r.steps.at(-1).detail).toContain(error);
    expect(recordStep(r)).toBeUndefined();
    expect(r.next[0]).toMatchObject({ kind: "run", argv: ["routr", "dispatch", "--task-file", resolve(f.task)] });
    expect(r.next[0].stdout_to).toBeTruthy();
    expect(r.next[0].argv).not.toContain(">");
    const dry = await launch([...args, "--dry-run"], noCalls);
    expect(dry).toMatchObject({ ok: true, state: "planned" });
    expect(dry.warnings.join(" ")).toContain(error);
    expect(dry.planned_command.length).toBeGreaterThan(0);
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
  for (const part of [resolve(f.advice), "--task-file", resolve(f.task), "--subscription claude", "--model sonnet", "--effort low", "--level <level>", "--verdict <done|partial|blocked>", "--check <pass|fail|none>"]) expect(recordStep(dry).template).toContain(part);
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
  expect(fresh.error).toContain("original task file is gone");
  expect(fresh.error).toContain("--note");
  expect(readFileSync(f.ledger, "utf8")).toBe(bytes);
  writeFileSync(f.advice, JSON.stringify({ id: "unhashed" }));
  expect(recordCommand(o).error).toContain("missing brief_sha");
  expect(readFileSync(f.ledger, "utf8")).toBe(bytes);
  writeFileSync(f.advice, JSON.stringify(f.adv));
  const revision = recordCommand({ ...o, task_file: undefined, run_id: good.run_id, note: "Original task file is gone." });
  expect(revision.ok).toBe(true);
  expect(revision.warnings.join(" ")).toContain("not checked against a task");
  const inline = recordCommand({ ...o, task_file: undefined });
  expect(inline.ok).toBe(true);
  expect(inline.warnings.join(" ")).toContain("not checked against a task");
  expect(JSON.stringify([good, revision, inline])).not.toContain(MARKER);
  expect(readFileSync(f.ledger, "utf8")).not.toContain(MARKER);
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
  const rec = run(["record", "--advice", f.advice, "--ledger", f.ledger, "--task-file"]);
  expect(JSON.parse(rec.stdout.toString())).toMatchObject({ ok: false, recorded: null, error: expect.stringContaining("--task-file") });
  expect(existsSync(f.ledger)).toBe(false);
  const other = join(f.dir, "other.md"); writeFileSync(other, "different task");
  const mismatch = run(["record", "--advice", f.advice, "--ledger", f.ledger, "--task-file", other]);
  expect(JSON.parse(mismatch.stdout.toString()).ok).toBe(false);
  expect(existsSync(f.ledger)).toBe(false);
  expect(run(["record", "--help"]).stdout.toString()).toContain("--task-file <path>");
  const dry = run(["launch", ...base, "--task-file", f.task, "--dry-run"]);
  expect(JSON.parse(dry.stdout.toString())).toMatchObject({ ok: true, state: "planned", warnings: expect.arrayContaining([expect.stringContaining("No advice file")]) });
  const refused = run(["launch", ...base, "--task-file", f.task]);
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout.toString()).command).toEqual([]);
  const matched = run(["launch", ...base, "--task-file", f.task, "--advice", f.advice, "--dry-run"]);
  expect(recordStep(JSON.parse(matched.stdout.toString())).template).toContain("--task-file");
  expect([dry, refused, matched, mismatch, rec].map((r) => r.stdout.toString() + r.stderr.toString()).join(" ")).not.toContain(MARKER);
});

test("whole dispatch, record and cleanup results never carry the brief marker", async () => {
  const f = fixture();
  const dispatch = await adviseCommand("dispatch", f.text, { config: cfg() }, {}, { askFn: async () => { throw new Error(MARKER); }, read: async () => [] });
  const record = recordCommand({ advice: f.advice, task_file: f.task, ledger: f.ledger });
  const cleaned = await cleanup(["--pane", "w1:p2"], { run: async () => herdrOK({ panes: [] }), env: {} });
  expect(JSON.stringify([dispatch, record, cleaned])).not.toContain(MARKER);
});
