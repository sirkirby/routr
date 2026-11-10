// The advice commands (`subagent`, `dispatch`), the file-and-ledger commands, and `usage`: `check`, `record`, `assess`, `share`. Each takes its parsed flags and returns what to
// print, so a test can drive it without a process. The pure parts stay where they were (check.mjs, ledger.mjs); this is
// the I/O around them. None of them may fail an agent: an error becomes output, and the caller exits 0.
import { warning } from "./warnings.mjs";
import { commandTrace, decisionSpan, recordSpan, spanClock, usageSpans } from "./traces.mjs";
import { matchAdvice, readAdvice, readTask } from "./advice-file.mjs";
import { answer, refusal } from "./output.mjs";
import { doNext, recordRevisionNext } from "./next.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { advise, headline } from "./advise.mjs";
import { readReport } from "./check.mjs";
import { ask } from "./systemone.mjs";
import { DecisionError, decisionTarget, failedReading, readingModel } from "./providers.mjs";
import { append, assess, briefSha, LEDGER_PATH, parseReportSubagents, read, RunIdError, toEntry } from "./ledger.mjs";
import { installId, pendingCount, telemetryRows, telemetryState, telemetryStatus } from "./telemetry.mjs";
import { ensureParent, standalone } from "./runtime.mjs";
import { CHECK_VERSION, checkQuestions, LEVELS, MEANING, questions, VERSION } from "./questions.mjs";
import { ADVICE_STEPS, count } from "./wording.mjs";
import { recentLaunches } from "./shares.mjs";
import { findLaunch, LAUNCH_ID } from "./launch-history.mjs";
import { enabledSubscriptions } from "./config.mjs";
import { HARNESSES, readUsage, SOURCES } from "./harnesses.mjs";
import { failedUsage } from "./usage.mjs";
import { usageFailure } from "./usage-failure.mjs";
import { capacityFailure, capacityView, emptyRanking } from "./capacity.mjs";

const short = (e, n = 160) => e instanceof DecisionError ? e.message : String(e?.message ?? e).slice(0, n);

// `--headroom claude=0.4` or `=40%`: usage the caller read itself. A value that cannot be read (empty, "%" alone, out
// of 0..1, no name) is a note in the answer, never dropped without a word, and never read as 0.
export function parseHeadroom(values) {
  const given = {}, notes = [];
  for (const h of values) {
    const [k0 = "", v = ""] = String(h ?? "").split("="), k = k0.trim(), t = v.trim(), num = t.endsWith("%") ? t.slice(0, -1).trim() : t;
    const x = num && /^[0-9.]+$/.test(num) ? Number(num) / (t.endsWith("%") ? 100 : 1) : NaN;
    if (k && Number.isFinite(x) && x >= 0 && x <= 1) given[k] = x;
    else notes.push(warning("headroom_ignored", `--headroom ${h ?? ""} is not <subscription>=<a share from 0 to 1, or a percent>: ignored`));
  }
  return { given, notes };
}

// `routr subagent|dispatch "<brief>"`: the decision model's reading of the brief with the user's preferences, and for
// dispatch the subscriptions ranked by usage, read while it answers. An unreachable model still gets an answer: the
// user's fallback.
async function adviseCommandBody(mode, brief, { config, notes: configNotes = [] }, given = {}, { askFn = ask, read = readUsage, warnings = [] } = {}) {
  const callWarnings = [...configNotes, ...warnings];
  if (typeof brief !== "string" || !brief.trim()) return refusal("no advice", "empty brief", callWarnings, [doNext("Supply the exact task", `routr ${mode} --task-file <path>`)]);
  const out = { ok: true, warnings: callWarnings, next: [], id: randomUUID().slice(0, 8), ts: new Date().toISOString(), mode, question_set: VERSION, brief_sha: briefSha(brief), brief_chars: brief.length, unavailable: [] };
  const target = decisionTarget(config);
  let answered = false;
  let advice = { level: config.fallback_level, sure: false, facts: {}, notes: [] };
  // Each source's newest reading, read while the decision model answers; a slow source (Cursor's screen) is a snapshot refreshed in the background.
  const names = enabledSubscriptions(config);
  const usageP = mode === "dispatch" ? Promise.resolve().then(() => usageSpans((observe) => read(names, given, { observe })))
    .catch(() => names.map((name) => failedUsage(name, SOURCES[name]?.source ?? name))) : null;
  try {
    const r = await decisionSpan(config, () => askFn({ task: { brief } }, questions, { config }));
    advice = advise(r.answers, config, r.profile ?? undefined);
    out.unavailable.push(...(r.unavailable ?? []));
    // Raw judgments travel with the advice, so preferences can be re-evaluated later without asking again. Which model
    // answered, and where, goes with them: answers from two models are not comparable.
    const a = r.answers;
    Object.assign(out, { provider: r.provider, decision_model: r.model, ...(r.measured === false ? { unmeasured: true } : {}), ms: Math.round(r.latencyMs), answers: { level: { score: a.level.score, confidence: a.level.confidence, probabilities: a.level.probabilities }, work_type: { choice: a.work_type.choice, confidence: a.work_type.confidence }, high_blast_radius: a.high_blast_radius.noul } }); // fact probabilities are in `facts`
    answered = true;
  } catch (e) {
    advice = { level: config.fallback_level, sure: false, facts: {}, notes: [], next: [doNext("Judge the level yourself; the user's fallback level is not a reading")] };
    Object.assign(out, failedReading(e, target));
  }
  Object.assign(out, { headline: !answered ? `${out.headline}; fallback level ${advice.level}` : `${headline(advice)}; reading by ${readingModel(out)}`, ...advice, meaning: MEANING[advice.level] });
  if (mode === "dispatch") {
    const usage = await usageP;
    let capacity;
    try { capacity = capacityView(advice.level, usage, config, recentLaunches()); }
    catch { const { failure, next } = capacityFailure(); capacity = { subscriptions: emptyRanking(failure.why), unavailable: [failure], next: [next], stale: [] }; }
    out.subscriptions = capacity.subscriptions;
    out.unavailable.push(...capacity.unavailable);
    out.warnings.push(...capacity.stale.map((s) => s.warning));
    // Capacity steps first, then the advice's own; a stopped reader's retry after them.
    out.next = [...capacity.next, ...out.next, ...capacity.stale.map((s) => s.retry)];
  }
  out.next = [...out.next, ...ADVICE_STEPS[mode].map((s) => doNext(s)),
    ...(mode === "dispatch" ? readingNext(out) : []),
    ...(mode === "dispatch" && hasCandidates(out.subscriptions) ? [doNext("Choose a suitable model and effort from normal candidates first; use fallback when none suitably takes the work. State the advised and chosen level, model, effort and account with separate reasons for model and effort")] : []),
    ...(mode === "dispatch" && hasCandidates(out.subscriptions) ? [doNext("Launch with this saved advice on the exact task; record from launch's template.", "routr launch --kind <subscription> --name <name> --model <model> --effort <effort> --task-file <task-file> --advice <advice-file>")] : [])];
  return answer(out);
}

// A backup restores the decision reading. Only missing usage or a true fallback needs the lead's own judgment.
function readingNext(out) {
  const steps = [], first = out.unavailable.find((u) => u.part === "decision model");
  if (out.decision_model && first) steps.push(doNext(`Tell the user a backup decision model answered (${readingModel(out)}); the first choice ${readingModel(first)} could not answer: ${first.why}`));
  if ((!out.decision_model && first) || out.unavailable.some((u) => u.part === "usage")) steps.push(doNext("Tell the user what was unavailable when stating the launch choice; judge those parts yourself"));
  return steps;
}

// A quick first read of a worker's report; the orchestrator remains the judge.
async function checkCommandBody({ brief: briefFile, report: reportFile }, { askFn = ask, config = null, warnings = [] } = {}) {
  const out = { ok: false, warnings: [...warnings], next: [], mode: "check", question_set: CHECK_VERSION, unavailable: [] };
  for (const [flag, value] of [["brief", briefFile], ["report", reportFile]]) if (typeof value !== "string" || !value.trim() || value.startsWith("--")) return { ...refusal("no reading", `check requires --${flag} <file>`, warnings), mode: "check", question_set: CHECK_VERSION };
  const failedFile = (part) => out.unavailable.push({ part, code: "unreadable", why: `The ${part} file could not be read. Provide a file that exists and is readable.` });
  let brief, report;
  try { brief = readFileSync(briefFile, "utf8").trim(); }
  catch { failedFile("brief"); }
  try { report = readFileSync(reportFile, "utf8").trim(); }
  catch { failedFile("report"); }
  if (out.unavailable.length) return answer(Object.assign(out, { headline: `routr: no reading (${out.unavailable.map((u) => `${u.part} unavailable: ${u.code}`).join("; ")}); judge the report yourself`, next: [doNext("Judge the report yourself against the brief")] }));
  try {
    if (report.length < 200) out.warnings.push(warning("report_short", "this report is very short: make sure it is the worker's full report, not just its last message"));
    const r = await decisionSpan(config, () => askFn({ task: { brief }, report: { text: report } }, checkQuestions, { config }));
    out.unavailable.push(...(r.unavailable ?? []));
    Object.assign(out, readReport(r.answers), { ok: true, provider: r.provider, decision_model: r.model, ...(r.measured === false ? { unmeasured: true } : {}), ms: Math.round(r.latencyMs) });
    out.headline += `; reading by ${readingModel(out)}`;
  } catch (e) {
    const failure = failedReading(e, decisionTarget(config));
    return answer(Object.assign(out, failure, { headline: `${failure.headline}; judge the report yourself`, next: [doNext("Judge the report yourself against the brief")] }));
  }
  return answer(out);
}

// An advice command: an unreadable ledger still gets an answer.
export function assessCommand({ ledger = LEDGER_PATH() }, config) {
  let entries = [], unreadable = "";
  try { entries = read(ledger); } catch (e) { unreadable = `routr: could not read the ledger (${short(e, 120)}); reporting as if it were empty.\n`; }
  return unreadable + assess(entries, config);
}

// A row's project and launch. A revision keeps its run's (given ones are checked against them when appended). A new run
// takes `--project`, else the project of the launch it names (`--launch`, from launch's record template), else the
// folder's: the repository the work was in, wherever the lead records from. A launch made for other advice is refused;
// history routr cannot read, or a launch past its 7 days, only warns and falls back to the folder.
function rowIdentity(o, advice, ledger, warnings) {
  if (o.launch_repeated) throw new Error("--launch was given more than once; give the one launch this run was");
  const launch_id = o.launch ?? null;
  const prior = o.run_id ? read(ledger).findLast((e) => e.run_id === o.run_id) : null;
  let project = o.project ?? prior?.project;
  if (launch_id != null && LAUNCH_ID.test(launch_id)) {
    const found = findLaunch(launch_id);
    if (found.record?.id && found.record.id !== advice.id) throw new Error(`--launch ${launch_id} was made with other advice (${found.record.id}); give the launch this advice was used for`);
    if (project == null) {
      if (found.unreadable) warnings.push(warning("launch_history_unreadable", "routr's launch history could not be read, so this row's project is the folder record ran in"));
      else if (!found.record) warnings.push(warning("launch_not_found", `Launch ${launch_id} is not in routr's launch history, which keeps 7 days, so this row's project is the folder record ran in`));
      else project = found.record.project ?? undefined;
    }
  }
  return { project, launch_id };
}

// `o` holds record's flags by name; the advice JSON comes from `--advice <file>` or stdin.
function recordCommandBody(o, subagentFlags = [], config = null, { warnings = [] } = {}) {
  const ledger = o.ledger ?? LEDGER_PATH();
  let advice;
  try {
    for (const flag of ["subscription", "model", "effort", "verdict", "check"]) if (typeof o[flag] !== "string" || !o[flag].trim() || o[flag].startsWith("--")) throw new Error(`record requires --${flag}`);
    advice = readAdvice(o.advice ?? 0);
    let task = null;
    try { if (o.task_file != null) task = readTask(o.task_file); }
    catch (e) {
      if (o.run_id != null && e.message === "--task-file: could not read the task file")
        throw new Error(`${e.message}. If the original task file is gone, revise without --task-file and say so in --note`);
      throw e;
    }
    if (task != null) matchAdvice(advice, task);
    const subagents = o.report != null || subagentFlags.length
      ? [...(o.report != null ? parseReportSubagents(readFileSync(o.report, "utf8")) : []), ...subagentFlags] : undefined;
    const { project, launch_id } = rowIdentity(o, advice, ledger, warnings = [...warnings]);
    const entry = append(toEntry(advice, { ...o, subagents, project, launch_id }, config), ledger, { revision: o.run_id != null });
    recordSpan(entry);
    return answer({ ok: true, headline: `routr: recorded run ${entry.run_id} (advice ${advice.id}) in ${ledger}`, id: advice.id, run_id: entry.run_id, ledger,
      warnings: [...warnings, ...(o.task_file == null ? [warning("advice_unchecked", "The advice was not checked against a task.")] : [])],
      next: [doNext(entry.outcome.verdict === "done" && entry.outcome.check === "pass"
        ? "Integrate the verified result, then follow launch’s cleanup step when this worker is finished."
        : "Send the work back or escalate, then verify and revise this row; no cleanup yet."),
      ...(o.task_file == null ? [doNext("If this task came from a file, revise this row with --run-id and --task-file; otherwise say why in --note")] : []), recordRevisionNext(o, entry, ledger)] });
  } catch (e) { return refusal("nothing recorded", short(e), warnings, e instanceof RunIdError ? [doNext(`Read the run_id field from record's earlier output, or from this worker's row for advice ${advice.id} in ${ledger}; retry with that run_id. Omit --run-id only for a new worker run.`)] : []); }
}

// `routr share`: write exactly what telemetry sends to a file the user can read. Sends nothing itself.
export function shareCommand({ ledger = LEDGER_PATH(), out }, config = null, { env = process.env, isStandalone = standalone } = {}) {
  const entries = read(ledger);
  if (!entries.length) return "The ledger is empty: there is nothing to share yet.";
  const rows = telemetryRows(entries, installId(ledger, { create: false }) ?? "not-yet-created"); // looking must not create an id
  // Beside the ledger read by default (the one --ledger names), never in the current folder: that is usually a
  // repository, and the file could be committed.
  const file = out ?? join(dirname(ledger), `routr-ledger-${new Date().toISOString().slice(0, 10)}.jsonl`);
  ensureParent(file);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const st = telemetryStatus(config, env, telemetryState(ledger)), pending = st.on ? pendingCount(ledger) : 0;
  return [
    `Wrote ${rows.length} rows to ${file}: every row in your ledger, in exactly the form telemetry sends. Writing it sent nothing.`,
    "",
    "In each row: what routr read from the brief (yes/no probabilities, level, the decision model and its provider), the subscription, model,",
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
const hasCandidates = (r) => r && [...r.candidates.normal, ...r.candidates.fallback].length > 0;
async function usageCommandBody(words, config, given = {}, { read = readUsage, sources = SOURCES, warnings = [] } = {}) {
  words = [...words];
  const at = words.indexOf("--level"), explicit = at !== -1;
  let level = "basic";
  const refuse = (error) => ({ ...refusal("no usage view", error, warnings), level });
  if (explicit) {
    if (words.lastIndexOf("--level") !== at || !LEVELS.includes(words[at + 1]))
      return refuse(`usage: --level takes one of ${LEVELS.join(", ")}, given once; eligibility was not refreshed`);
    level = words[at + 1]; words.splice(at, 2);
  }
  // The background refresh's lock token, handed over by the call that took the lock (snapshot.mjs).
  const tokenAt = words.indexOf("--lock-token"), token = tokenAt === -1 ? undefined : words[tokenAt + 1];
  if (tokenAt !== -1) {
    if (!words.includes("--background") || words.lastIndexOf("--lock-token") !== tokenAt || !token || token.startsWith("-")) return refuse("usage: --lock-token is routr's own, for its background refresh only");
    words.splice(tokenAt, 2);
  }
  const flags = words.filter((w) => w.startsWith("-")), configured = Object.keys(config.subscriptions);
  const [name, ...extra] = words.filter((w) => !w.startsWith("-"));
  const unknown = flags.filter((f) => f !== "--json" && f !== "--background");
  if (extra.length || unknown.length) return refuse(`usage: routr usage [--config <path>] [--headroom <subscription>=<share, 0.9 or 90%>]... [<subscription> | --level <${LEVELS.join("|")}>]${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}`);
  if (explicit && (name || flags.includes("--background"))) return refuse("usage: --level is for unnamed usage only; omit the subscription and --background. Eligibility was not refreshed");
  const fresh = name && Object.hasOwn(sources, name) && sources[name]?.check;
  // What the answer keeps and says of a fresh reading is the harness's own (its registry entry), whoever reads it.
  const reader = fresh ? { label: HARNESSES[name].label, ...HARNESSES[name].usage } : null;
  if (name && !configured.includes(name) && !fresh) return { ...refuse(`${name} is not a configured subscription (configured: ${configured.join(", ") || "none, run routr setup"})`), subscription: name };
  const out = { ok: true, warnings: [...warnings], next: [], unavailable: [], level, ...(name ? { subscription: name } : {}) };
  try {
    let reading = null; const readingStart = spanClock();
    if (fresh) {
      try { reading = await fresh({ background: flags.includes("--background"), ...(token ? { token } : {}) }); } catch { reading = { ok: false, ...usageFailure("read_failed") }; }
      out.ok = reading?.ok === true;
      if (reading?.note && reader.left) { out.warnings.push(reader.left.warning()); out.next.push(doNext(reader.left.next)); }
      if (out.ok) out.reading = Object.fromEntries(reader.fields.filter((k) => Object.hasOwn(reading, k)).map((k) => [k, reading[k]]));
      if (!configured.includes(name)) out.warnings.push(warning("subscription_unconfigured", `${name} is not configured, so it is not ranked`));
    }
    const names = name ? configured.filter((n) => n === name) : configured;
    const subs = Object.fromEntries(names.map((n) => [n, config.subscriptions[n]]));
    const viewConfig = { ...config, subscriptions: subs };
    const readingNames = fresh && !configured.includes(name) ? [name] : names.filter((n) => subs[n].enabled !== false);
    const rows = reading?.excluded ? [{ pool: name, signedIn: false, note: reading.why }] : await usageSpans((observe) => read(readingNames, given, { sources, background: fresh ? [] : names, observe }), fresh ? { since: readingStart } : {});
    const additionalUnavailable = [];
    if (fresh && !reading?.ok && !reading?.excluded) {
      const kept = rows.find((r) => r.pool === name && r.headroom != null);
      additionalUnavailable.push({ part: "usage", subscription: name, source: sources[name].source ?? name, ...usageFailure(reading?.code), reading: kept ? "kept" : "unknown", ...(kept ? { reading_source: kept.source, age_sec: kept.ageSec } : {}) });
    }
    const capacity = capacityView(level, rows, viewConfig, name ? null : recentLaunches(), { named: name, configured: Object.keys(config.subscriptions).length > 0, unavailable: additionalUnavailable });
    out.subscriptions = capacity.subscriptions;
    out.unavailable.push(...capacity.unavailable);
    // A fresh read that just worked clears its own warning; one that failed again keeps it (the retry is this call).
    const own = (s) => fresh && s.pool === name;
    out.warnings.push(...capacity.stale.filter((s) => !(own(s) && reading?.ok)).map((s) => s.warning));
    if (reading?.excluded && !out.subscriptions.excluded.some((r) => r.subscription === name)) out.subscriptions.excluded.push({ subscription: name, why: reading.why });
    if (name && !configured.includes(name)) {
      const excluded = out.subscriptions.excluded.find((e) => e.subscription === name);
      const why = ["not configured: routr setup configures this subscription", excluded?.why].filter(Boolean).join("; ");
      if (excluded) excluded.why = why; else out.subscriptions.excluded.push({ subscription: name, why });
      out.subscriptions.note = `${name} is ${why}`;
    }
    out.next = [...capacity.next, ...out.next, ...capacity.stale.filter((s) => !own(s)).map((s) => s.retry)];
    if (explicit && hasCandidates(out.subscriptions)) out.next.push(doNext("Choose from subscriptions.candidates, normal before fallback, and keep the original dispatch advice for launch and record"));
    out.headline = fresh ? reading?.ok ? `routr: ${reader.label}, ${reader.used(reading)}, read now${!out.subscriptions.ranked.length ? `; ${out.subscriptions.note}` : ""}` : `routr: no fresh ${reader.label} reading (${reading?.excluded ? "not signed in" : usageFailure(reading?.code).code})`
      : `routr: ${out.subscriptions.most_room ? `${out.subscriptions.most_room} has the most usable headroom for ${level} work (normal first); normal: ${out.subscriptions.candidates.normal.join(", ") || "none"}, fallback: ${out.subscriptions.candidates.fallback.join(", ") || "none"}` : out.subscriptions.note}${out.unavailable.length ? `; ${count(out.unavailable.length, "reading")} unavailable` : ""}`;
  } catch {
    out.ok = false;
    const { failure, next } = capacityFailure();
    out.unavailable.push(failure); out.subscriptions = emptyRanking(failure.why);
    out.headline = "routr: no usage ranking (internal_error)";
    out.next.push(next);
  }
  return answer(out);
}

export const usageCommand = (words, config, given = {}, opts = {}) => words.includes("--background") ? usageCommandBody(words, config, given, opts) : commandTrace("usage", () => ({ config, ...opts, explicitLevel: words.includes("--level") }), () => usageCommandBody(words, config, given, opts));

export const adviseCommand = (mode, brief, loaded, given = {}, opts = {}) => commandTrace(mode, () => ({ config: loaded.config, ...opts }), () => adviseCommandBody(mode, brief, loaded, given, opts));
export const checkCommand = (files, opts = {}) => commandTrace("check", () => opts, () => checkCommandBody(files, opts));
export const recordCommand = (o, subagents = [], config = null, opts = {}) => commandTrace("record", () => ({ config, ...opts }), () => recordCommandBody(o, subagents, config, opts));
