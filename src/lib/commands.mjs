// The file-and-ledger commands: `check`, `record`, `assess`, `share`. Each takes its parsed flags and returns what to
// print, so a test can drive it without a process. The pure parts stay where they were (check.mjs, ledger.mjs); this is
// the I/O around them. None of them may fail an agent: an error becomes output, and the caller exits 0.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readReport } from "./check.mjs";
import { ask } from "./jev.mjs";
import { append, assess, LEDGER_PATH, parseReportSubagents, read, shareRows, toEntry } from "./ledger.mjs";
import { CHECK_VERSION, checkQuestions } from "./questions.mjs";

const short = (e, n = 160) => String(e?.message ?? e).slice(0, n);

// A quick first read of a worker's report; the orchestrator remains the judge.
export async function checkCommand({ brief: briefFile, report: reportFile }, { askFn = ask } = {}) {
  const out = { mode: "check", question_set: CHECK_VERSION };
  try {
    const brief = readFileSync(briefFile, "utf8").trim(), report = readFileSync(reportFile, "utf8").trim();
    if (report.length < 200) out.warning = "this report is very short: make sure it is the worker's full report, not just its last message";
    const r = await askFn({ task: { brief }, report: { text: report } }, checkQuestions, undefined, 10000);
    Object.assign(out, readReport(r.answers), { jev_model: r.model, ms: Math.round(r.latencyMs) });
  } catch (e) { Object.assign(out, { headline: "routr: could not read the report; judge it yourself", fallback: true, error: short(e) }); }
  return out;
}

// An advice command: an unreadable ledger still gets an answer.
export function assessCommand({ ledger = LEDGER_PATH }, config) {
  let entries = [], unreadable = "";
  try { entries = read(ledger); } catch (e) { unreadable = `routr: could not read the ledger (${short(e, 120)}); reporting as if it were empty.\n`; }
  return unreadable + assess(entries, config);
}

// `o` holds record's flags by name; the advice JSON comes from `--advice <file>` or stdin.
export function recordCommand(o, subagentFlags = []) {
  try {
    const advice = JSON.parse(readFileSync(o.advice ?? 0, "utf8"));
    const subagents = [...(o.report ? parseReportSubagents(readFileSync(o.report, "utf8")) : []), ...subagentFlags];
    append(toEntry(advice, { ...o, subagents }), o.ledger ?? LEDGER_PATH);
    return { recorded: advice.id, ledger: o.ledger ?? LEDGER_PATH };
  } catch (e) { return { recorded: null, error: short(e) }; }
}

// Prepare (never send) a file the user can attach to a GitHub issue, to help tune routr's questions on real outcomes.
export function shareCommand({ ledger = LEDGER_PATH, out, withModels = false }) {
  const rows = shareRows(read(ledger), { withModels });
  if (!rows.length) return "The ledger is empty: there is nothing to share yet.";
  // Beside the ledger by default, never in the current folder: that is usually a repository, and the file could be committed.
  const file = out ?? join(dirname(LEDGER_PATH), `routr-ledger-${new Date().toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(dirname(file) || ".", { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return [
    `Wrote ${rows.length} rows to ${file}. Nothing has been sent anywhere.`,
    "",
    "In the file: what routr read from each brief (yes/no probabilities, level), the level and subscription chosen,",
    `the outcome and attempt count${withModels ? ", and the model names you chose" : ""}. Day-level dates only.`,
    `Left out: the briefs (routr never stores them), their hashes, your notes, ids, usage numbers${withModels ? "" : ", model names (add --with-models to include them)"}.`,
    "",
    "Read it, then attach it to a new issue using the \"Share your ledger\" form:",
    "  https://github.com/sirkirby/routr/issues/new?template=share-ledger.yml",
    "Issues are public. That is why the file holds nothing that identifies you or your work.",
  ].join("\n");
}
