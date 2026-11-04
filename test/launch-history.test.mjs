// routr's launch history: what a record holds (checked fields only), records from before the decision fields, and how
// `record` takes a row's project and launch from it. launch.test.mjs covers launch writing it; shares.test.mjs the
// folder's own rules (links, uninstall, the sweep) through the share count.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { findLaunch, LAUNCH_HISTORY_DIR, launchRecord, readHistory, recordLaunch } from "../src/lib/launch-history.mjs";
import { briefSha, projectName } from "../src/lib/ledger.mjs";
import { recordCommand } from "./contract.mjs";
import { telemetryRows } from "../src/lib/telemetry.mjs";
import { LaunchIndex } from "../src/lib/launch-index.mjs";
import { cliEnv, scratch, SCRIPT } from "./helpers.mjs";

const decision = { subscription: "codex", model: "gpt-6.1-sol", effort: "high", id: "ab12cd34",
  advised: { level: "strong", sure: true, between: null, work_type: "review", high_risk: true, fallback: false, facts: { cross_cutting: 0.81, tiny: 0.04 } }, project: "myco", backend: "terminal", name: "rev7" };

test("a record holds checked fields only: text that is not what a field is becomes null, and nothing else gets in", () => {
  expect(launchRecord(decision)).toEqual(decision);
  const odd = launchRecord({ ...decision, model: "gpt 6; rm -rf /", effort: "x".repeat(200), id: "../etc", project: "a/b", backend: "ssh", name: "Bad Name",
    advised: { level: "huge", sure: "yes", between: ["basic"], work_type: "Review!", high_risk: 1, fallback: null, facts: { tiny: 0.9, "Bad Key": 0.5, huge: 7, secret: "secret" } }, brief: "secret", task: "secret", note: "secret" });
  expect(odd).toEqual({ subscription: "codex", model: null, effort: null, id: null, project: null, backend: null, name: null,
    advised: { level: null, sure: null, between: null, work_type: null, high_risk: null, fallback: null, facts: { tiny: 0.9 } } });
  expect(JSON.stringify(odd)).not.toContain("secret");
  expect(launchRecord(null).advised).toBeNull();
});

test("a record from before the decision fields still counts, with no decision; findLaunch finds one by its id", () => {
  const home = scratch("history-old"), dir = LAUNCH_HISTORY_DIR(home), now = Date.now();
  mkdirSync(dir, { recursive: true });
  const old = "11111111-1111-4111-8111-111111111111";
  writeFileSync(join(dir, `${old}.json`), JSON.stringify({ subscription: "claude", at: new Date(now - 1000).toISOString() }));
  const id = randomUUID();
  expect(recordLaunch(id, decision, { home, now })).toBe(true);
  const { records } = readHistory({ home, now });
  expect(records.map((r) => [r.launch_id, r.subscription, r.model, r.advised])).toEqual([[old, "claude", null, null], [id, "codex", "gpt-6.1-sol", decision.advised]]);
  expect(findLaunch(id, { home, now }).record.project).toBe("myco");
  expect(findLaunch(randomUUID(), { home, now })).toEqual({ record: null });
  // Only a launch's own id names its file: anything else is refused before a write.
  expect(recordLaunch("../x", decision, { home, now })).toBe(false);
  expect(recordLaunch(randomUUID(), { ...decision, subscription: "../codex" }, { home, now })).toBe(false);
});

// A recording lead in a scratch folder, not the repository: what `record` labels the row with.
function recording(advice = { mode: "dispatch", id: "ab12cd34", brief_sha: briefSha("Task"), level: "strong" }) {
  const dir = scratch("history-record"), ledger = join(dir, "ledger.jsonl"), file = join(dir, "advice.json");
  writeFileSync(file, JSON.stringify(advice));
  const o = { advice: file, subscription: "codex", model: "gpt-6.1-sol", effort: "high", level: "strong", verdict: "done", check: "pass", ledger };
  return { o, ledger, rows: () => readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

test("record labels a row with its launch's project: --project wins, then the launch, then the folder record ran in", () => {
  const id = randomUUID(); recordLaunch(id, decision);
  const r = recording();
  expect(recordCommand({ ...r.o, launch: id }).ok).toBe(true);
  expect(recordCommand({ ...r.o, launch: id, project: "chosen" }).ok).toBe(true);
  expect(recordCommand(r.o).ok).toBe(true);
  expect(r.rows().map((x) => [x.launch_id, x.project])).toEqual([[id, "myco"], [id, "chosen"], [null, projectName()]]);
  // A launch past the history's 7 days, or never made: said, and the folder's project.
  const gone = recordCommand({ ...r.o, launch: randomUUID() });
  expect([gone.ok, gone.warnings.some((w) => w.includes("not in routr's launch history")), r.rows().at(-1).project]).toEqual([true, true, projectName()]);
});

test("record refuses a launch made with other advice, and an id that is not a launch's; a revision keeps its launch and project", () => {
  const id = randomUUID(); recordLaunch(id, decision);
  const other = recording({ mode: "dispatch", id: "ffff0000", brief_sha: briefSha("Task"), level: "basic" });
  const refused = recordCommand({ ...other.o, launch: id });
  expect([refused.ok, refused.error]).toEqual([false, expect.stringContaining("made with other advice (ab12cd34)")]);
  expect(recordCommand({ ...other.o, launch: "ab12cd34" }).error).toContain("--launch takes the launch_id field from launch's answer");
  const r = recording(), first = recordCommand({ ...r.o, launch: id });
  // The revision names neither: it keeps both, as its template also passes them.
  const revised = recordCommand({ ...r.o, run_id: first.run_id, verdict: "partial" });
  expect(revised.ok).toBe(true);
  expect(r.rows().map((x) => [x.run_id, x.launch_id, x.project, x.outcome.verdict])).toEqual([[first.run_id, id, "myco", "done"], [first.run_id, id, "myco", "partial"]]);
  expect(revised.next.find((n) => n.template?.includes("--run-id")).template).toContain(`--launch ${id}`);
  const moved = recordCommand({ ...r.o, run_id: first.run_id, launch: randomUUID() });
  expect([moved.ok, moved.error]).toEqual([false, expect.stringContaining("different --launch")]);
  // A run recorded without a launch keeps none: a revision cannot give it one.
  const bare = recordCommand(r.o), added = recordCommand({ ...r.o, run_id: bare.run_id, launch: id });
  expect([added.ok, added.error]).toEqual([false, expect.stringContaining("recorded without --launch")]);
  // On the command line, --launch with no value or given twice is refused, never read as absent.
  // Another flag cannot take it as its value either (`--note --launch <id>`).
  for (const extra of [["--launch"], ["--launch", id, "--launch", id], ["--note", "--launch"], ["--launch", id, "--note", "--launch", randomUUID()]]) {
    const cli = Bun.spawnSync([process.execPath, SCRIPT, "record", "--advice", r.o.advice, "--subscription", "codex", "--model", "m", "--effort", "high", "--verdict", "done", "--check", "pass", "--ledger", r.ledger, ...extra], { env: cliEnv(scratch("history-cli")) });
    const out = JSON.parse(cli.stdout.toString());
    expect([out.ok, out.error]).toEqual([false, expect.stringMatching(/--launch (takes|was given more than once)/)]);
  }
});

test("a row's launch id and project stay on this machine: telemetry rows carry neither", () => {
  const id = randomUUID(); recordLaunch(id, decision);
  const r = recording();
  recordCommand({ ...r.o, launch: id });
  const sent = JSON.stringify(telemetryRows(r.rows(), "00000000-0000-4000-8000-000000000000"));
  expect(sent).not.toContain(id);
  expect(sent).not.toContain("myco");
});

test("the trace's launch index finds a launch by its launch_id, so a record span links to its own launch, not another on the same advice", () => {
  const home = scratch("history-index"); mkdirSync(join(home, ".local/state/routr"), { recursive: true });
  const index = new LaunchIndex({ home }), at = new Date().toISOString(), span = (n) => ({ traceId: n.repeat(32), spanId: n.repeat(16) });
  const one = randomUUID(), two = randomUUID();
  index.add({ launch_id: one, advice_id: "ab12cd34", backend: "terminal", ...span("a"), created_at: at });
  index.add({ launch_id: two, advice_id: "ab12cd34", backend: "terminal", ...span("b"), created_at: at });
  expect(index.match({ advice_id: "ab12cd34" })).toBeNull(); // two launches used that advice: not one match
  expect(index.match({ launch_id: two })?.traceId).toBe("b".repeat(32));
});
