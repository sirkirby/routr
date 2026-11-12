// Cause details: the lead's own tags for rework, counted by project, and the reminder when one comes back. Pure
// fixtures and temporary ledgers; no harness, no model.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/lib/config.mjs";
import { warningCode } from "../src/lib/warnings.mjs";
import { assess, causeRepeats, latestRuns, read, toEntry } from "../src/lib/ledger.mjs";
import { telemetryRows } from "../src/lib/telemetry.mjs";
import { shareRows } from "../src/lib/ledger.mjs";
import { recordCommand } from "./contract.mjs";
import { cfg, row, scratch } from "./helpers.mjs";

const advice = { id: "cause-advice", brief_sha: "abc", level: "standard", mode: "dispatch", facts: {} };
const choice = { subscription: "codex", model: "worker-model", effort: "medium", level: "standard", verdict: "done", check: "pass", project: "acme" };
const DAY = 86400000;
const at = (daysAgo, e) => ({ ...e, ts: new Date(Date.now() - daysAgo * DAY).toISOString() });
const tagged = (daysAgo, details, over = {}) => at(daysAgo, toEntry(advice, { ...choice, causes: ["brief"], cause_details: details, ...over }));
const reminders = (r) => r.next.filter((n) => n.why.startsWith("--cause-detail"));

test("a cause detail is a short slug beside a cause other than none, kept once each", () => {
  expect(toEntry(advice, { ...choice, causes: ["brief", "review"], cause_details: ["copied-existing-code", "copied-existing-code"] }).outcome)
    .toMatchObject({ causes: ["brief", "review"], cause_details: ["copied-existing-code"] });
  expect(toEntry(advice, { ...choice, causes: ["brief"] }).outcome.cause_details).toBeNull();
  for (const bad of [["Copied existing code"], ["copied_existing"], ["-x"], ["x-"], ["a".repeat(41)], [undefined], [""]])
    expect(() => toEntry(advice, { ...choice, causes: ["brief"], cause_details: bad })).toThrow("--cause-detail takes a short tag");
  for (const causes of [undefined, [], ["none"]])
    expect(() => toEntry(advice, { ...choice, causes, cause_details: ["unchecked-claim"] })).toThrow("--cause other than none");
});

test("assess counts runs with no cause as not recorded, apart from unknown, and groups tags by project", () => {
  const entries = [
    toEntry(advice, { ...choice }),                                                   // no --cause
    toEntry(advice, { ...choice, causes: ["unknown"] }),
    tagged(1, ["copied-existing-code"]), tagged(2, ["copied-existing-code", "unchecked-claim"]), tagged(30, ["copied-existing-code"]),
    tagged(1, ["unchecked-claim"], { project: "site" }),
  ];
  const report = assess(entries, cfg());
  expect(report).toContain("unknown 1, not recorded 1");
  expect(report).toContain("cause details (your own tags), by project:");
  const lines = report.split("\n"), acme = lines.indexOf("  acme"), site = lines.indexOf("  site");
  expect(lines[acme + 1]).toMatch(/^ {4}copied-existing-code {2}3 runs, 2 in the last 7 days$/);
  expect(lines[acme + 2]).toMatch(/^ {4}unchecked-claim {7}1 run, 1 in the last 7 days$/);
  expect(lines[site + 1]).toBe(lines[acme + 2]); // one column width across projects
  expect(assess(entries, cfg({ cause_repeat_days: 0 }))).toContain("    copied-existing-code  3 runs\n");
  expect(assess([toEntry(advice, { ...choice, causes: ["none"] })], cfg())).not.toContain("cause details");
});

test("a repeat is another run in the same project inside the window, a revised run counted once, never the run itself", () => {
  const mine = tagged(0, ["copied-existing-code"]);
  const other = tagged(3, ["copied-existing-code"]), revised = { ...other, ts: new Date(Date.now() - DAY).toISOString() };
  expect(causeRepeats([mine], mine)).toEqual([]);
  expect(causeRepeats([other, revised, mine], mine)).toEqual([{ tag: "copied-existing-code", runs: 1 }]);
  expect(causeRepeats([tagged(8, ["copied-existing-code"]), mine], mine)).toEqual([]);                 // outside 7 days
  expect(causeRepeats([tagged(8, ["copied-existing-code"]), mine], mine, { days: 10 })).toHaveLength(1);
  expect(causeRepeats([other, mine], mine, { days: 0 })).toEqual([]);                                  // turned off
  expect(causeRepeats([tagged(1, ["copied-existing-code"], { project: "site" }), mine], mine)).toEqual([]);
  expect(causeRepeats([tagged(1, ["unchecked-claim"]), mine], mine)).toEqual([]);
  // A hand-edited row with a malformed detail is not counted.
  expect(causeRepeats([{ ...other, outcome: { ...other.outcome, cause_details: "copied-existing-code" } }, mine], mine)).toEqual([]);
});

test("record points out a tag that comes back before the next launch, once per new tag, and fails open", () => {
  const dir = scratch("cause-repeat"), ledger = join(dir, "ledger.jsonl"), adviceFile = join(dir, "advice.json");
  writeFileSync(adviceFile, JSON.stringify(advice));
  const base = { ...choice, advice: adviceFile, ledger, causes: ["brief"] };
  const first = recordCommand({ ...base, cause_details: ["copied-existing-code"] }, [], cfg());
  expect(reminders(first)).toEqual([]);
  const second = recordCommand({ ...base, cause_details: ["copied-existing-code", "unchecked-claim"] }, [], cfg());
  expect(reminders(second)).toHaveLength(1);
  expect(reminders(second)[0].why).toBe("--cause-detail copied-existing-code is now on 2 runs in acme in the last 7 days. A repeat is usually a rule the briefs are missing: before the next launch, add what would have caught it (a line in your brief template, or a check in the repository), then revise this row with --run-id and say which in --note.");
  expect(second.next.indexOf(reminders(second)[0])).toBe(0);                                           // before integrating
  // Revising the run to say what was added is not reminded again; a tag the revision adds is.
  expect(reminders(recordCommand({ ...base, run_id: second.run_id, cause_details: ["copied-existing-code", "unchecked-claim"], note: "added a brief line" }, [], cfg()))).toEqual([]);
  const third = recordCommand({ ...base, cause_details: ["unchecked-claim"] }, [], cfg());
  expect(reminders(third)[0].why).toContain("--cause-detail unchecked-claim is now on 2 runs");
  expect(reminders(recordCommand({ ...base, cause_details: ["copied-existing-code"] }, [], cfg({ cause_repeat_days: 0 })))).toEqual([]);
  expect(latestRuns(read(ledger))).toHaveLength(4);
  // The revision template carries the run's own causes and details, so following it keeps them.
  const template = second.next.find((n) => n.template?.includes("--run-id")).template;
  expect(template).toContain("--cause brief --cause-detail copied-existing-code --cause-detail unchecked-claim --note <note>");
});

test("cause_repeat_days takes a whole number of days, 0 to 365, and says when it cannot", () => {
  const dir = scratch("repeat-config"), path = join(dir, "config.json");
  const load = (v) => { writeFileSync(path, JSON.stringify({ cause_repeat_days: v })); return loadConfig(path); };
  expect(load(14).config.cause_repeat_days).toBe(14);
  expect(load(0).config.cause_repeat_days).toBe(0);
  for (const bad of [-1, 2.5, "7", 366, null]) {
    const { config, notes } = load(bad);
    expect(config.cause_repeat_days).toBe(7);
    expect(notes.map(warningCode)).toContain("config_repeat");
  }
  writeFileSync(path, "{}");
  expect(loadConfig(path).config.cause_repeat_days).toBe(7);
});

// The record span's projection is checked in traces.test.mjs, and board, top and dash in output-contracts.test.mjs.
test("cause details never reach telemetry or share output", () => {
  const plain = row(), local = { ...plain, outcome: { ...plain.outcome, causes: ["brief"], cause_details: ["private-tag-marker"] } };
  expect(telemetryRows([local], "fixture-install")).toEqual(telemetryRows([{ ...plain, outcome: { ...plain.outcome, causes: ["brief"] } }], "fixture-install"));
  expect(JSON.stringify(shareRows([local]))).not.toContain("private-tag-marker");
});
