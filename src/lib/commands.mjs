// The file-and-ledger commands, and `usage`: `check`, `record`, `assess`, `share`. Each takes its parsed flags and returns what to
// print, so a test can drive it without a process. The pure parts stay where they were (check.mjs, ledger.mjs); this is
// the I/O around them. None of them may fail an agent: an error becomes output, and the caller exits 0.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readReport } from "./check.mjs";
import { ask } from "./jev.mjs";
import { append, assess, LEDGER_PATH, parseReportSubagents, read, toEntry } from "./ledger.mjs";
import { installId, pendingCount, telemetryRows, telemetryState, telemetryStatus } from "./telemetry.mjs";
import { standalone } from "./runtime.mjs";
import { CHECK_VERSION, checkQuestions } from "./questions.mjs";
import { rankSubscriptions } from "./pick.mjs";
import { readUsage, SOURCES } from "./usage.mjs";

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
export function shareCommand({ ledger = LEDGER_PATH, out }, config = null, { env = process.env, isStandalone = standalone } = {}) {
  const entries = read(ledger);
  if (!entries.length) return "The ledger is empty: there is nothing to share yet.";
  const rows = telemetryRows(entries, installId(ledger, { create: false }) ?? "not-yet-created"); // looking must not create an id
  // Beside the ledger by default, never in the current folder: that is usually a repository, and the file could be committed.
  const file = out ?? join(dirname(LEDGER_PATH), `routr-ledger-${new Date().toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(dirname(file) || ".", { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const st = telemetryStatus(config, env, telemetryState(ledger)), pending = st.on ? pendingCount(ledger) : 0;
  return [
    `Wrote ${rows.length} rows to ${file}: every row in your ledger, in exactly the form telemetry sends. Writing it sent nothing.`,
    "",
    "In each row: what routr read from the brief (yes/no probabilities, level, the Jev version), the subscription, model,",
    "effort and level chosen, the outcome, attempts and seconds, and a key per row. Day-level dates only. Anything typed by",
    "hand (a model name, a verdict) is cut to a known value or a short name, or sent as \"other\". Each send also carries",
    "routr's version, your OS, and a random install id made on this machine. Never sent: the briefs (routr never stores",
    "them) or any other free text, notes, project names, paths, usage numbers.",
    "",
    !st.on ? `Telemetry is off (${st.why_off}), so none of these is shared. To share rows recorded from now on: routr telemetry on (docs/telemetry.md)`
      : `Telemetry is on. ${pending ? `${pending} of these ${pending === 1 ? "is" : "are"} waiting to be sent` : "None of these is waiting to be sent"}: only rows recorded after you turned it on are shared${rows.length > pending ? " (the rest stay on this machine)" : ""}.`,
    ...(st.on ? [isStandalone() ? "They are sent once a day by routr's background job. To stop: routr telemetry off"
      : "This routr runs from a source checkout, where the daily job does not run: send with routr telemetry send. To stop: routr telemetry off"] : []),
  ].join("\n");
}

// `routr usage [<subscription>]`: what routr sees of each subscription's usage and how dispatch would rank it, with no
// brief. Named, a harness with a `check` (Cursor) prints its raw reading instead, for a person to verify. Fails open.
export async function usageCommand(words, config, given = {}, { read = readUsage, sources = SOURCES } = {}) {
  const flags = words.filter((w) => w.startsWith("-")), configured = Object.keys(config.subscriptions);
  const [name, ...extra] = words.filter((w) => !w.startsWith("-"));
  // The output is JSON already, so --json (which doctor and setup take) is accepted and changes nothing.
  const unknown = flags.filter((f) => f !== "--json" && f !== "--background"); // --background: routr's own refresh job
  if (extra.length || unknown.length) return { ok: false, error: `usage: routr usage [--config <path>] [--headroom <subscription>=<0..1>]... [<subscription>]${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}` };
  if (name && sources[name]?.check) return sources[name].check({ background: flags.includes("--background") });
  if (name && !configured.includes(name)) return { ok: false, error: `${name} is not a configured subscription (configured: ${configured.join(", ") || "none, run routr setup"})` };
  try {
    const names = name ? [name] : configured;
    const subs = Object.fromEntries(names.map((n) => [n, config.subscriptions[n]]));
    // Ranked for basic work, which every subscription takes: harder work leaves out one whose hardest_work is lower.
    const r = rankSubscriptions("basic", await read(names, given, { sources }), { ...config, subscriptions: subs });
    return { ok: true, most_room: r.most_room, note: r.note, ranked: r.ranked.map((row) => ({ ...row, hardest_work: subs[row.subscription].hardest_work })),
      how: "usable = what is left in the tightest window minus your reserve, and the reserve shrinks as the window nears its reset. dispatch ranks the same way and leaves out a subscription whose hardest_work is below the level of the work" };
  } catch (e) { return { ok: false, error: short(e) }; }
}
