// ledger.mjs: record, assess, subagent rows, projects
import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cliEnv, row, scratch, SCRIPT } from "./helpers.mjs";
test("parsing of →, ->, none, and malformed lines for subagents", async () => {
  const { parseSubagent, parseReportSubagents } = await import("../src/lib/ledger.mjs");

  // unicode arrow →
  expect(parseSubagent("Count Python files → basic → haiku")).toEqual({
    subtask: "Count Python files",
    advised: "basic",
    model: "haiku",
  });

  // ascii arrow ->
  expect(parseSubagent("Review runtime.py error handling -> standard -> sonnet")).toEqual({
    subtask: "Review runtime.py error handling",
    advised: "standard",
    model: "sonnet",
  });

  // extra spaces and mixed arrows
  expect(parseSubagent("   Count Python files   →   basic   ->   haiku   ")).toEqual({
    subtask: "Count Python files",
    advised: "basic",
    model: "haiku",
  });

  // none and SUBAGENTS: none
  expect(parseSubagent("none")).toBeNull();
  expect(parseSubagent("SUBAGENTS: none")).toBeNull();
  expect(parseSubagent("  none  ")).toBeNull();
  expect(parseSubagent("SUBAGENTS: none (one line per subagent, or \"none\")")).toBeNull();

  // malformed lines
  expect(parseSubagent("Count Python files")).toEqual({
    subtask: "Count Python files",
    advised: null,
    model: null,
  });
  expect(parseSubagent("Count Python files → medium → haiku")).toEqual({
    subtask: "Count Python files → medium → haiku",
    advised: null,
    model: null,
  });
  expect(parseSubagent("Count Python files -> basic")).toEqual({
    subtask: "Count Python files -> basic",
    advised: null,
    model: null,
  });

  // parsing from report file
  const reportText = [
    "VERDICT: done",
    "SUMMARY: fixed the bugs",
    "CHECKED: bun test",
    "FILES: file.ts",
    "SUBAGENTS: Count Python files → basic → haiku",
    "SUBAGENTS: none",
    "SUBAGENTS: Review runtime.py error handling -> standard -> sonnet",
    "SUBAGENTS: Malformed text without level",
  ].join("\n");

  expect(parseReportSubagents(reportText)).toEqual([
    { subtask: "Count Python files", advised: "basic", model: "haiku" },
    { subtask: "Review runtime.py error handling", advised: "standard", model: "sonnet" },
    { subtask: "Malformed text without level", advised: null, model: null },
  ]);
});

test("toEntry stores subagents correctly and never stores brief or report text", async () => {
  const { toEntry } = await import("../src/lib/ledger.mjs");
  const advice = {
    id: "a1b2c3d4",
    ts: "2026-09-21T12:00:00.000Z",
    mode: "dispatch",
    question_set: "r3",
    brief_sha: "123456789abc",
    brief_chars: 42,
    level: "standard",
    sure: true,
    work_type: "feature",
    high_risk: false,
    facts: { tiny: { p: 0.1 } },
    subscriptions: { ranked: [{ subscription: "codex", usable: 0.8, usage: "live" }] },
  };

  // With subagents
  const entryWithSubagents = toEntry(advice, {
    subscription: "codex",
    model: "gpt-5",
    effort: "medium",
    verdict: "done",
    check: "pass",
    subagents: [
      "Count Python files → basic → haiku",
      "Review runtime.py error handling -> standard -> sonnet",
      "Count Python files → unknownlevel → haiku",
    ],
    report: "/tmp/report.txt",
    brief: "secret brief text",
  });

  expect(entryWithSubagents.subagents).toEqual([
    { subtask: "Count Python files", advised: "basic", model: "haiku" },
    { subtask: "Review runtime.py error handling", advised: "standard", model: "sonnet" },
    { subtask: "Count Python files → unknownlevel → haiku", advised: null, model: null },
  ]);
  expect(entryWithSubagents.brief).toBeUndefined();
  expect(entryWithSubagents.report).toBeUndefined();
  expect(JSON.stringify(entryWithSubagents)).not.toContain("secret brief text");
  expect(JSON.stringify(entryWithSubagents)).not.toContain("/tmp/report.txt");

  // Without subagents
  const entryEmpty = toEntry(advice, {
    subscription: "codex",
    model: "gpt-5",
    effort: "medium",
    verdict: "done",
    check: "pass",
  });
  expect(entryEmpty.subagents).toEqual([]);

  // Subagents with "none"
  const entryNone = toEntry(advice, {
    subscription: "codex",
    model: "gpt-5",
    effort: "medium",
    verdict: "done",
    check: "pass",
    subagents: ["none"],
  });
  expect(entryNone.subagents).toEqual([]);
});

test("assess includes subagent section with counts and models by advised level", async () => {
  const { toEntry, assess } = await import("../src/lib/ledger.mjs");
  const advice = {
    id: "a1",
    ts: "2026-09-21T12:00:00.000Z",
    mode: "dispatch",
    question_set: "r3",
    brief_sha: "sha1",
    brief_chars: 20,
    level: "standard",
    sure: true,
    work_type: "refactor",
    high_risk: false,
    facts: {},
    subscriptions: { ranked: [] },
  };

  const entry = toEntry(advice, {
    subscription: "codex",
    model: "m",
    effort: "low",
    verdict: "done",
    check: "pass",
    subagents: [
      "Task 1 → basic → haiku",
      "Task 2 → basic → haiku",
      "Task 3 → basic → haiku",
      "Task 4 → basic → sonnet",
      "Task 5 → standard → sonnet",
    ],
  });

  const report = assess([entry]);
  expect(report).toContain("subagents: 5 recorded");
  expect(report).toContain("basic: haiku 3, sonnet 1");
  expect(report).toContain("standard: sonnet 1");
});

test("old ledger rows without a subagents field assess without error", async () => {
  const { assess } = await import("../src/lib/ledger.mjs");
  const oldRow = {
    ts: "2026-09-20T10:00:00.000Z",
    id: "old12345",
    asked_at: "2026-09-20T10:00:00.000Z",
    mode: "dispatch",
    question_set: "r3",
    brief_sha: "abc123456789",
    brief_chars: 30,
    advised: { level: "basic", sure: true, work_type: "fix", high_risk: false, fallback: false, facts: {} },
    headroom: {},
    chose: { subscription: "claude", model: "sonnet", effort: "medium", level: "basic" },
    outcome: { verdict: "done", check: "pass", seconds: 12, attempts: 1, note: null },
    // Notice: NO subagents field
  };

  expect(() => assess([oldRow])).not.toThrow();
  const report = assess([oldRow]);
  expect(report).toContain("1 recorded pieces of work");
  expect(report).not.toContain("subagents:");
});

test("CLI round trip for record with repeatable --subagent and --report flags", () => {
  const tempDir = scratch("record-test");
  const adviceFile = join(tempDir, "advice.json");
  const reportFile = join(tempDir, "report.txt");
  const ledgerFile = join(tempDir, "ledger.jsonl");

  writeFileSync(
    adviceFile,
    JSON.stringify({
      id: "test1234",
      ts: "2026-09-21T12:00:00.000Z",
      mode: "dispatch",
      question_set: "r3",
      brief_sha: "abc",
      brief_chars: 10,
      level: "basic",
      sure: true,
      work_type: "fix",
      high_risk: false,
      facts: {},
      subscriptions: { ranked: [] },
    })
  );

  writeFileSync(
    reportFile,
    [
      "VERDICT: done",
      "SUMMARY: fixed the bug",
      "CHECKED: bun test",
      "FILES: test.js",
      "SUBAGENTS: Count files → basic → haiku",
      "SUBAGENTS: Review diff -> standard -> sonnet",
    ].join("\n")
  );

  // Run record with both --report and repeatable --subagent
  const rec = Bun.spawnSync([
    "bun",
    SCRIPT,
    "record",
    "--advice", adviceFile,
    "--report", reportFile,
    "--subagent", "Extra task → strong → opus",
    "--subagent", "Another extra -> basic -> haiku",
    "--subscription", "codex",
    "--model", "m",
    "--effort", "low",
    "--verdict", "done",
    "--check", "pass",
    "--ledger", ledgerFile,
  ]);
  expect(rec.exitCode).toBe(0);
  const recOut = JSON.parse(rec.stdout.toString().trim());
  expect(recOut.recorded).toBe("test1234");

  // Read ledger entry
  const entry = JSON.parse(readFileSync(ledgerFile, "utf8").trim());
  expect(entry.subagents).toEqual([
    { subtask: "Count files", advised: "basic", model: "haiku" },
    { subtask: "Review diff", advised: "standard", model: "sonnet" },
    { subtask: "Extra task", advised: "strong", model: "opus" },
    { subtask: "Another extra", advised: "basic", model: "haiku" },
  ]);

  // Run assess
  const ass = Bun.spawnSync(["bun", SCRIPT, "assess", "--ledger", ledgerFile]);
  expect(ass.exitCode).toBe(0);
  const assOut = ass.stdout.toString();
  expect(assOut).toContain("subagents: 4 recorded");
  expect(assOut).toContain("basic: haiku 2");
  expect(assOut).toContain("standard: sonnet 1");
  expect(assOut).toContain("strong: opus 1");

}, 20000); // several CLI spawns: over 5 s when the machine is busy (seen with four test runs at once)

test("assess turns the ledger into suggestions about the user's own settings, and only with enough runs", async () => {
  const { assess } = await import("../src/lib/ledger.mjs");
  const c = { prefer: { research: "strong" }, subscriptions: { codex: { hardest_work: "standard", reserve: 0.2 } } };
  expect(assess([row(), row()], c)).toContain("Nothing here argues for changing your settings yet");
  const six = Array.from({ length: 6 }, () => row());                       // six research pieces run BELOW the preference, all delivered
  const report = assess(six, c);
  expect(report).toContain('prefer.research is "strong": agents went lower 6 times and 6 delivered');
  expect(report).toContain("If you trust it with more, raise hardest_work");
  const struggling = Array.from({ length: 5 }, () => row({ outcome: { verdict: "done", check: "pass", attempts: 2 } }));
  expect(assess(struggling, c)).toContain("subscriptions.codex.hardest_work");
  expect(report).not.toContain("TOO LOW");                                    // the level review is for the lab, not the user
});

test("ledger rows are labelled with their project, a worktree counts as its repository, and the label is never shared", async () => {
  const { projectName, toEntry, shareRows, assess } = await import("../src/lib/ledger.mjs");
  const root = scratch("proj");
  mkdirSync(join(root, "acme-api", ".git"), { recursive: true }); mkdirSync(join(root, "acme-api", "src", "deep"), { recursive: true });
  expect(projectName(join(root, "acme-api", "src", "deep"))).toBe("acme-api");
  mkdirSync(join(root, "wt", "fix-branch"), { recursive: true });
  writeFileSync(join(root, "wt", "fix-branch", ".git"), `gitdir: ${join(root, "acme-api", ".git", "worktrees", "fix-branch")}\n`);
  expect(projectName(join(root, "wt", "fix-branch"))).toBe("acme-api");
  const e = toEntry({ id: "x", level: "basic", sure: true, facts: {} }, { project: "acme-api", verdict: "done", check: "pass" });
  expect(e.project).toBe("acme-api");
  expect(JSON.stringify(shareRows([e]))).not.toContain("acme-api");
  const other = { ...e, project: "site" };
  expect(assess([e, other])).toContain("by project");
  expect(assess([e])).not.toContain("by project");                        // one project: no breakdown to show
});

test("record --project labels the row, assess answers on an unreadable ledger, and share never writes into the current folder", () => {
  const home = scratch("cli"), work = join(home, "work"); mkdirSync(work);
  const env = cliEnv(home);
  const advice = JSON.stringify({ id: "a1", mode: "dispatch", level: "basic", sure: true, facts: {} });
  const rec = Bun.spawnSync([process.execPath, SCRIPT, "record", "--subscription", "codex", "--model", "m", "--effort", "low", "--verdict", "done", "--check", "pass", "--project", "other"], { env, cwd: work, stdin: Buffer.from(advice) });
  expect(rec.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(home, ".local/share/routr/ledger.jsonl"), "utf8").trim()).project).toBe("other");
  expect(Bun.spawnSync([process.execPath, SCRIPT, "share"], { env, cwd: work }).exitCode).toBe(0);
  expect(readdirSync(work)).toEqual([]);
  expect(readdirSync(join(home, ".local/share/routr")).some((f) => f.startsWith("routr-ledger-"))).toBe(true);
  const bad = Bun.spawnSync([process.execPath, SCRIPT, "assess", "--ledger", home], { env, cwd: work }); // a folder, not a file
  expect(bad.exitCode).toBe(0);
  expect(bad.stdout.toString()).toContain("could not read the ledger");
}, 20000); // several CLI spawns: over 5 s when the machine is busy (seen with four test runs at once)
