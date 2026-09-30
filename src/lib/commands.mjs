// The advice commands (`subagent`, `dispatch`), the file-and-ledger commands, and `usage`: `check`, `record`, `assess`, `share`. Each takes its parsed flags and returns what to
// print, so a test can drive it without a process. The pure parts stay where they were (check.mjs, ledger.mjs); this is
// the I/O around them. None of them may fail an agent: an error becomes output, and the caller exits 0.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { advise, headline } from "./advise.mjs";
import { readReport } from "./check.mjs";
import { ask } from "./jev.mjs";
import { append, assess, briefSha, LEDGER_PATH, parseReportSubagents, read, toEntry } from "./ledger.mjs";
import { installId, pendingCount, telemetryRows, telemetryState, telemetryStatus } from "./telemetry.mjs";
import { standalone } from "./runtime.mjs";
import { CHECK_VERSION, checkQuestions, MEANING, questions, VERSION } from "./questions.mjs";
import { ADVICE_RULE } from "./wording.mjs";
import { rankSubscriptions } from "./pick.mjs";
import { enabledSubscriptions } from "./config.mjs";
import { readUsage, SOURCES } from "./harnesses.mjs";

const short = (e, n = 160) => String(e?.message ?? e).slice(0, n);

// `--headroom claude=0.4` or `=40%`: usage the caller read itself. A value that cannot be read (empty, "%" alone, out
// of 0..1, no name) is a note in the answer, never dropped without a word, and never read as 0.
export function parseHeadroom(values) {
  const given = {}, notes = [];
  for (const h of values) {
    const [k0 = "", v = ""] = String(h ?? "").split("="), k = k0.trim(), t = v.trim(), num = t.endsWith("%") ? t.slice(0, -1).trim() : t;
    const x = num && /^[0-9.]+$/.test(num) ? Number(num) / (t.endsWith("%") ? 100 : 1) : NaN;
    if (k && Number.isFinite(x) && x >= 0 && x <= 1) given[k] = x;
    else notes.push(`--headroom ${h ?? ""} is not <subscription>=<a share from 0 to 1, or a percent>: ignored`);
  }
  return { given, notes };
}

// `routr subagent|dispatch "<brief>"`: Jev's reading of the brief with the user's preferences, and for dispatch the
// subscriptions ranked by usage, read while Jev answers. An unreachable Jev still gets an answer: the user's fallback.
export async function adviseCommand(mode, brief, { config, notes: configNotes = [] }, given = {}, { askFn = ask, read = readUsage } = {}) {
  const out = { id: randomUUID().slice(0, 8), ts: new Date().toISOString(), mode, question_set: VERSION, brief_sha: briefSha(brief), brief_chars: brief.length };
  let advice = { level: config.fallback_level, sure: false, facts: {}, notes: [] };
  // Each source's newest reading, read while Jev answers; a slow source (Cursor's screen) is a snapshot refreshed in the background.
  const usageP = mode === "dispatch" ? read(enabledSubscriptions(config), given).catch(() => []) : null; // a turned-off one is not read
  try {
    const r = await askFn({ task: { brief } }, questions, undefined, 10000);
    advice = advise(r.answers, config);
    // Raw judgments travel with the advice, so preferences can be re-evaluated later without asking again.
    const a = r.answers;
    Object.assign(out, { jev_model: r.model, ms: Math.round(r.latencyMs), answers: { level: { score: a.level.score, confidence: a.level.confidence, probabilities: a.level.probabilities }, work_type: { choice: a.work_type.choice, confidence: a.work_type.confidence }, high_blast_radius: a.high_blast_radius.noul } }); // fact probabilities are in `facts`
  } catch (e) {
    advice.notes.push(`Router unavailable (${short(e, 120)}). "${config.fallback_level}" is only the user's fallback: judge the level yourself.`);
    out.fallback = true;
  }
  Object.assign(out, { headline: headline(advice), ...advice, meaning: MEANING[advice.level] });
  if (mode === "dispatch") {
    try { out.subscriptions = rankSubscriptions(advice.level, await usageP, config); }
    catch (e) { out.subscriptions = { most_room: null, candidates: { normal: [], fallback: [] }, ranked: [], excluded: [], note: `could not read usage: ${short(e, 120)}` }; }
    // An unconfigured routr ranks nothing; say why, so the lead tells the user instead of guessing (seen in a real session).
    if (!Object.keys(config.subscriptions).length) out.subscriptions.note = "no subscriptions are configured, so none is ranked: the user has not run `routr setup` yet. Tell them, and ask which subscription to use meanwhile";
  }
  return { ...out, rule: ADVICE_RULE[mode], ...(configNotes.length ? { config_notes: configNotes } : {}) };
}

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
export function recordCommand(o, subagentFlags = [], config = null) {
  try {
    const advice = JSON.parse(readFileSync(o.advice ?? 0, "utf8"));
    const subagents = o.report != null || subagentFlags.length
      ? [...(o.report != null ? parseReportSubagents(readFileSync(o.report, "utf8")) : []), ...subagentFlags] : undefined;
    const entry = toEntry(advice, { ...o, subagents }, config);
    append(entry, o.ledger ?? LEDGER_PATH, { revision: o.run_id != null });
    return { recorded: advice.id, run_id: entry.run_id, ledger: o.ledger ?? LEDGER_PATH };
  } catch (e) { return { recorded: null, error: short(e) }; }
}

// `routr share`: write exactly what telemetry sends to a file the user can read. Sends nothing itself.
export function shareCommand({ ledger = LEDGER_PATH, out }, config = null, { env = process.env, isStandalone = standalone } = {}) {
  const entries = read(ledger);
  if (!entries.length) return "The ledger is empty: there is nothing to share yet.";
  const rows = telemetryRows(entries, installId(ledger, { create: false }) ?? "not-yet-created"); // looking must not create an id
  // Beside the ledger read by default (the one --ledger names), never in the current folder: that is usually a
  // repository, and the file could be committed.
  const file = out ?? join(dirname(ledger), `routr-ledger-${new Date().toISOString().slice(0, 10)}.jsonl`);
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
  if (extra.length || unknown.length) return { ok: false, error: `usage: routr usage [--config <path>] [--headroom <subscription>=<share, 0.9 or 90%>]... [<subscription>]${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}` };
  if (name && sources[name]?.check) return sources[name].check({ background: flags.includes("--background") });
  if (name && !configured.includes(name)) return { ok: false, error: `${name} is not a configured subscription (configured: ${configured.join(", ") || "none, run routr setup"})` };
  try {
    const names = name ? [name] : configured;
    const subs = Object.fromEntries(names.map((n) => [n, config.subscriptions[n]]));
    // Ranked for basic work, which every subscription takes: harder work leaves out one whose hardest_work is lower.
    const r = rankSubscriptions("basic", await read(names.filter((n) => subs[n].enabled !== false), given, { sources }), { ...config, subscriptions: subs });
    return { ok: true, most_room: r.most_room, candidates: r.candidates, note: r.note, ...(r.excluded.length ? { excluded: r.excluded } : {}), ranked: r.ranked.map((row) => ({ ...row, hardest_work: subs[row.subscription].hardest_work })),
      how: "usable = what is left in the tightest window minus your reserve, and the reserve shrinks as the window nears its reset. dispatch ranks the same way and leaves out a subscription whose hardest_work is below the level of the work" };
  } catch (e) { return { ok: false, error: short(e) }; }
}
