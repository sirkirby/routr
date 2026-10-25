// The advice commands (`subagent`, `dispatch`), the file-and-ledger commands, and `usage`: `check`, `record`, `assess`, `share`. Each takes its parsed flags and returns what to
// print, so a test can drive it without a process. The pure parts stay where they were (check.mjs, ledger.mjs); this is
// the I/O around them. None of them may fail an agent: an error becomes output, and the caller exits 0.
import { commandTrace, decisionSpan, recordSpan, usageSpans } from "./traces.mjs";
import { matchAdvice, readAdvice, readTask } from "./advice-file.mjs";
import { answer, refusal } from "./output.mjs";
import { doNext, recordRevisionNext, runNext } from "./next.mjs";
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
import { rankSubscriptions, levelExcludedWhy } from "./pick.mjs";
import { enabledSubscriptions } from "./config.mjs";
import { readUsage, SOURCES } from "./harnesses.mjs";
import { failedUsage } from "./usage.mjs";
import { staleReaders, USAGE_BY_HAND, usageFailure, usageUnavailable } from "./usage-failure.mjs";

const short = (e, n = 160) => e instanceof DecisionError ? e.message : String(e?.message ?? e).slice(0, n);

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

// `routr subagent|dispatch "<brief>"`: the decision model's reading of the brief with the user's preferences, and for
// dispatch the subscriptions ranked by usage, read while it answers. An unreachable model still gets an answer: the
// user's fallback.
async function adviseCommandBody(mode, brief, { config, notes: configNotes = [] }, given = {}, { askFn = ask, read = readUsage } = {}) {
  if (typeof brief !== "string" || !brief.trim()) return refusal("no advice", "empty brief", configNotes, [doNext("Supply the exact task", `routr ${mode} --task-file <path>`)]);
  const out = { ok: true, warnings: configNotes, next: [], id: randomUUID().slice(0, 8), ts: new Date().toISOString(), mode, question_set: VERSION, brief_sha: briefSha(brief), brief_chars: brief.length, unavailable: [] };
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
    try {
      out.subscriptions = rankSubscriptions(advice.level, usage, config);
      out.unavailable.push(...usageUnavailable(usage).filter((u) => !out.subscriptions.excluded.some((e) => e.subscription === u.subscription)));
      for (const s of staleReaders(usage, config)) { out.warnings.push(s.warning); out.next.push(runNext(`Try reading ${s.pool}'s usage again.`, ["routr", "usage", s.pool])); }
    } catch {
      const failure = usageFailure("internal_error");
      out.unavailable.push({ part: "usage", subscription: null, source: "routr", ...failure });
      out.subscriptions = { most_room: null, candidates: { normal: [], fallback: [] }, ranked: [], excluded: [], note: failure.why };
    }
    // An unconfigured routr ranks nothing; say why, so the lead tells the user instead of guessing (seen in a real session).
    if (!Object.keys(config.subscriptions).length) out.subscriptions.note = "no subscriptions are configured: routr setup has not been run";
  }
  out.next = [...(mode === "dispatch" ? capacityNext(out.subscriptions, out.unavailable, out.level, config) : []), ...out.next,
    ...ADVICE_STEPS[mode].map((s) => doNext(s)),
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
    if (report.length < 200) out.warnings.push("this report is very short: make sure it is the worker's full report, not just its last message");
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
export function assessCommand({ ledger = LEDGER_PATH }, config) {
  let entries = [], unreadable = "";
  try { entries = read(ledger); } catch (e) { unreadable = `routr: could not read the ledger (${short(e, 120)}); reporting as if it were empty.\n`; }
  return unreadable + assess(entries, config);
}

// `o` holds record's flags by name; the advice JSON comes from `--advice <file>` or stdin.
function recordCommandBody(o, subagentFlags = [], config = null, { warnings = [] } = {}) {
  const ledger = o.ledger ?? LEDGER_PATH;
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
    const entry = toEntry(advice, { ...o, subagents }, config);
    append(entry, ledger, { revision: o.run_id != null });
    recordSpan(entry);
    return answer({ ok: true, headline: `routr: recorded run ${entry.run_id} (advice ${advice.id}) in ${ledger}`, id: advice.id, run_id: entry.run_id, ledger,
      warnings: [...warnings, ...(o.task_file == null ? ["The advice was not checked against a task."] : [])],
      next: [doNext(entry.outcome.verdict === "done" && entry.outcome.check === "pass"
        ? "Integrate the verified result, then follow launch’s cleanup step when this worker is finished."
        : "Send the work back or escalate, then verify and revise this row; no cleanup yet."),
      ...(o.task_file == null ? [doNext("If this task came from a file, revise this row with --run-id and --task-file; otherwise say why in --note")] : []), recordRevisionNext(o, entry, ledger)] });
  } catch (e) { return refusal("nothing recorded", short(e), warnings, e instanceof RunIdError ? [doNext(`Read the run_id field from record's earlier output, or from this worker's row for advice ${advice.id} in ${ledger}; retry with that run_id. Omit --run-id only for a new worker run.`)] : []); }
}

// `routr share`: write exactly what telemetry sends to a file the user can read. Sends nothing itself.
export function shareCommand({ ledger = LEDGER_PATH, out }, config = null, { env = process.env, isStandalone = standalone } = {}) {
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
// One set of capacity steps wherever the same ranking is printed.
export function capacityNext(r, unavailable, level, config, subscription = null) {
  const steps = [];
  if (unavailable.some((u) => u.part === "usage" && u.code === "internal_error")) steps.push(doNext("Read capacity yourself before choosing an account"));
  else if (!Object.keys(config.subscriptions).length) steps.push(doNext("Tell the user routr is not set up (routr setup), and ask which subscription to use meanwhile"));
  else if (!r.ranked.length) steps.push(doNext(level !== "basic" && !subscription && r.excluded.some((e) => e.why === levelExcludedWhy(level))
    ? "Hold the work, or choose a lower level and refresh with routr usage --level, or ask the user"
    : "Hold the work, use an eligible subscription for this run, or ask the user; the exclusions explain what fixes eligibility"));
  else if (!hasCandidates(r)) steps.push(doNext(`Hold the work or ask the user: every subscription that takes ${level} work is at its reserve`));
  for (const u of unavailable.filter((u) => u.part === "usage")) {
    const byHand = USAGE_BY_HAND[u.subscription];
    if (byHand) steps.push(doNext(`Read ${u.subscription}'s usage by hand: ${byHand}`, `--headroom ${u.subscription}=<share left>`));
  }
  return steps;
}
const emptyRanking = (note) => ({ most_room: null, candidates: { normal: [], fallback: [] }, ranked: [], excluded: [], note });
async function usageCommandBody(words, config, given = {}, { read = readUsage, sources = SOURCES, warnings = [] } = {}) {
  words = [...words];
  const at = words.indexOf("--level"), explicit = at !== -1;
  let level = "basic";
  const refuse = (error) => ({ ...refusal("no usage view", error, warnings), level });
  if (explicit) {
    if (words.lastIndexOf("--level") !== at || !LEVELS.includes(words[at + 1]))
      return refuse("usage: --level takes one of basic, standard, strong, once; eligibility was not refreshed");
    level = words[at + 1]; words.splice(at, 2);
  }
  const flags = words.filter((w) => w.startsWith("-")), configured = Object.keys(config.subscriptions);
  const [name, ...extra] = words.filter((w) => !w.startsWith("-"));
  const unknown = flags.filter((f) => f !== "--json" && f !== "--background");
  if (extra.length || unknown.length) return refuse(`usage: routr usage [--config <path>] [--headroom <subscription>=<share, 0.9 or 90%>]... [<subscription> | --level <basic|standard|strong>]${unknown.length ? ` (unknown: ${unknown.join(" ")})` : ""}`);
  if (explicit && (name || flags.includes("--background"))) return refuse("usage: --level is for unnamed usage only; omit the subscription and --background. Eligibility was not refreshed");
  const fresh = name && Object.hasOwn(sources, name) && sources[name]?.check;
  if (name && !configured.includes(name) && !fresh) return { ...refuse(`${name} is not a configured subscription (configured: ${configured.join(", ") || "none, run routr setup"})`), subscription: name };
  const out = { ok: true, warnings: [...warnings], next: [], unavailable: [], level, ...(name ? { subscription: name } : {}) };
  try {
    let reading = null; const readingStart = Date.now();
    if (fresh) {
      try { reading = await fresh({ background: flags.includes("--background") }); } catch { reading = { ok: false, ...usageFailure("read_failed") }; }
      out.ok = reading?.ok === true;
      if (name === "kiro" && reading?.note) out.warnings.push("Kiro kept an empty usage session");
      if (name === "kiro" && reading?.note) out.next.push(doNext("Inspect Kiro's saved sessions to remove the empty usage session"));
      if (out.ok) {
        const fields = name === "cursor" ? ["plan", "included_used_pct", "auto_used_pct", "api_used_pct", "headroom"] : ["plan", "credits_used", "credits_limit", "used_pct", "resets_at", "unrecognized_lines", "headroom"];
        out.reading = Object.fromEntries(fields.filter((k) => Object.hasOwn(reading, k)).map((k) => [k, reading[k]]));
      }
      if (!configured.includes(name)) out.warnings.push(`${name} is not configured, so it is not ranked`);
    }
    const names = name ? configured.filter((n) => n === name) : configured;
    const subs = Object.fromEntries(names.map((n) => [n, config.subscriptions[n]]));
    const viewConfig = { ...config, subscriptions: subs };
    const readingNames = fresh && !configured.includes(name) ? [name] : names.filter((n) => subs[n].enabled !== false);
    const rows = reading?.excluded ? [{ pool: name, signedIn: false, note: reading.why }] : await usageSpans((observe) => read(readingNames, given, { sources, background: fresh ? [] : names, observe }), fresh ? { startedAt: readingStart } : {});
    out.subscriptions = rankSubscriptions(level, rows, viewConfig);
    out.unavailable.push(...usageUnavailable(rows).filter((u) => !out.subscriptions.excluded.some((e) => e.subscription === u.subscription)));
    // A fresh read that just worked clears its own warning; one that failed again keeps it (the retry is this call).
    for (const s of staleReaders(rows, viewConfig).filter((x) => !(fresh && reading?.ok && x.pool === name))) {
      out.warnings.push(s.warning);
      if (!(fresh && s.pool === name)) out.next.push(runNext(`Try reading ${s.pool}'s usage again.`, ["routr", "usage", s.pool]));
    }
    if (fresh && !reading?.ok && !reading?.excluded && !out.unavailable.some((u) => u.subscription === name)) {
      const kept = rows.find((r) => r.pool === name && r.headroom != null);
      out.unavailable.push({ part: "usage", subscription: name, source: sources[name].source ?? name, ...usageFailure(reading?.code), reading: kept ? "kept" : "assumed", ...(kept ? { reading_source: kept.source, age_sec: kept.ageSec } : {}) });
    }
    if (reading?.excluded && !out.subscriptions.excluded.some((r) => r.subscription === name)) out.subscriptions.excluded.push({ subscription: name, why: reading.why });
    if (name && !configured.includes(name)) {
      const excluded = out.subscriptions.excluded.find((e) => e.subscription === name);
      const why = ["not configured: routr setup configures this subscription", excluded?.why].filter(Boolean).join("; ");
      if (excluded) excluded.why = why; else out.subscriptions.excluded.push({ subscription: name, why });
      out.subscriptions.note = `${name} is ${why}`;
    }
    out.next = [...capacityNext(out.subscriptions, out.unavailable, level, config, name), ...out.next];
    if (explicit && hasCandidates(out.subscriptions)) out.next.push(doNext("Choose from subscriptions.candidates, normal before fallback, and keep the original dispatch advice for launch and record"));
    out.headline = fresh ? reading?.ok ? `routr: ${name === "cursor" ? "Cursor" : "Kiro"}, ${name === "cursor" ? `Included ${reading.included_used_pct}% used` : `${reading.used_pct}% used`}, read now${!out.subscriptions.ranked.length ? `; ${out.subscriptions.note}` : ""}` : `routr: no fresh ${name === "cursor" ? "Cursor" : "Kiro"} reading (${reading?.excluded ? "not signed in" : usageFailure(reading?.code).code})`
      : `routr: ${out.subscriptions.most_room ? `${out.subscriptions.most_room} has the most usable headroom for ${level} work; normal: ${out.subscriptions.candidates.normal.join(", ") || "none"}, fallback: ${out.subscriptions.candidates.fallback.join(", ") || "none"}` : out.subscriptions.note}${out.unavailable.length ? `; ${count(out.unavailable.length, "reading")} unavailable` : ""}`;
  } catch {
    out.ok = false;
    const failure = { part: "usage", subscription: null, source: "routr", ...usageFailure("internal_error") };
    out.unavailable.push(failure); out.subscriptions = emptyRanking(failure.why);
    out.headline = "routr: no usage ranking (internal_error)";
    out.next.push(doNext("Read capacity yourself before choosing an account"));
  }
  return answer(out);
}

export const usageCommand = (words, config, given = {}, opts = {}) => words.includes("--background") ? usageCommandBody(words, config, given, opts) : commandTrace("usage", () => ({ config, ...opts, explicitLevel: words.includes("--level") }), () => usageCommandBody(words, config, given, opts));

export const adviseCommand = (mode, brief, loaded, given = {}, opts = {}) => commandTrace(mode, () => ({ config: loaded.config, ...opts }), () => adviseCommandBody(mode, brief, loaded, given, opts));
export const checkCommand = (files, opts = {}) => commandTrace("check", () => opts, () => checkCommandBody(files, opts));
export const recordCommand = (o, subagents = [], config = null, opts = {}) => commandTrace("record", () => ({ config, ...opts }), () => recordCommandBody(o, subagents, config, opts));
