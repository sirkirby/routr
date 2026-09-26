// check.mjs: the first read of a worker's report
import { expect, test } from "bun:test";
import { readReport } from "../src/lib/check.mjs";

const rep = (over = {}, kind = "debug", verdict = "done") => ({ work_type: { choice: kind }, verdict: { choice: verdict },
  ...Object.fromEntries(Object.entries({ states_verification: 0.95, covers_brief: 0.95, admits_gaps: 0.05, symptom_patch: 0.05, out_of_scope: 0.05, ...over }).map(([k, p]) => [k, { noul: p }])) });

test("a clean report gives no reason to send it back, and says the orchestrator's own check decides", () => {
  const r = readReport(rep()); expect(r.flags).toEqual([]); expect(r.next).toContain("your own check");
});

test("a symptom patch, an admitted gap, and a non-done verdict are each flagged", () => {
  expect(readReport(rep({ symptom_patch: 0.92 })).flags.join(" ")).toContain("symptom");
  expect(readReport(rep({ admits_gaps: 0.97 }, "debug", "partial")).flags.length).toBe(2);
  expect(readReport(rep({ states_verification: 0.05 })).headline).toContain("1 reason");
});

test("the symptom-patch answer is ignored on work that is not a fix", () => {
  const r = readReport(rep({ symptom_patch: 0.95 }, "review")); expect(r.flags).toEqual([]); expect(r.checks.symptom_patch).toBeUndefined();
});
