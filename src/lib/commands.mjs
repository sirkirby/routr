// The file-and-ledger commands: `check`, `record`, `assess`, `share`. Each takes its parsed flags and returns what to
// print, so a test can drive it without a process. The pure parts stay where they were (check.mjs, ledger.mjs); this is
// the I/O around them. None of them may fail an agent: an error becomes output, and the caller exits 0.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readReport } from "./check.mjs";
import { ask } from "./jev.mjs";
import { append, assess, LEDGER_PATH, parseReportSubagents, read, toEntry } from "./ledger.mjs";
import { installId, telemetryRows, telemetryStatus } from "./telemetry.mjs";
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

// `routr share`: write exactly what telemetry sends to a file the user can read. Sends nothing itself.
export function shareCommand({ ledger = LEDGER_PATH, out }, config = null) {
  const entries = read(ledger);
  if (!entries.length) return "The ledger is empty: there is nothing to share yet.";
  const rows = telemetryRows(entries, installId(ledger));
  // Beside the ledger by default, never in the current folder: that is usually a repository, and the file could be committed.
  const file = out ?? join(dirname(LEDGER_PATH), `routr-ledger-${new Date().toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(dirname(file) || ".", { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const st = telemetryStatus(config);
  return [
    `Wrote ${rows.length} rows to ${file}: exactly what routr's telemetry sends. Writing it sent nothing.`,
    "",
    "In each row: what routr read from the brief (yes/no probabilities, level, the Jev version), the subscription, model,",
    "effort and level chosen, the outcome, attempts and seconds, and a random install id. Day-level dates only.",
    "Never in it: the briefs (routr never stores them) or any other text, notes, project names, ids, usage numbers.",
    "",
    st.on ? "Telemetry is on: new rows are sent once a day. To stop: routr telemetry off"
      : `Telemetry is off (${st.why_off}). To send these rows once anyway: routr telemetry send. To turn it on: routr telemetry on`,
  ].join("\n");
}
