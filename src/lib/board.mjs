// `routr board`: what only routr knows, for a folder's project, in one answer `routr top` draws for a person (and any
// agent can read). The room each account has (as `usage` ranks it, from kept readings: no harness is called), each
// launch's decision (the launch history) joined to how it turned out (the ledger), and a 7-day count. Reads only:
// it changes nothing of the user's and writes nothing but a usage refresh's mark (usage-readings.mjs). Fails open:
// a part it cannot read is said in `unavailable` and its numbers are null, never zero. Every field is projected here,
// field by field: a ledger note (the recorder's text) never reaches its output.
import { resolve } from "node:path";
import { readFlags } from "./command-line.mjs";
import { answer, refusal } from "./output.mjs";
import { firstTime, LEDGER_PATH, latestRuns, projectAdvised, projectChose, projectName, read } from "./ledger.mjs";
import { HISTORY_DAYS, readHistory } from "./launch-history.mjs";
import { usageReadings } from "./usage-readings.mjs";
import { recentLaunches } from "./shares.mjs";
import { capacityFailure, capacityView } from "./capacity.mjs";

export const DECISIONS_MAX = 50;
const WINDOW_MS = HISTORY_DAYS * 86400000;
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const ms = (t) => { const v = Date.parse(t); return Number.isFinite(v) ? v : null; };

// The ledger's own shapes, kept as they are: `advised` and `chose`. An outcome without its note.
const outcomeOf = (o) => (o ? { verdict: o.verdict ?? null, check: o.check ?? null, attempts: o.attempts ?? null, causes: o.causes ?? null, seconds: o.seconds ?? null } : null);
// A launch's choice before it is recorded: the level is the recorder's, so not yet known.
const choseOfLaunch = (h) => ({ subscription: h.subscription, model: h.model, effort: h.effort, effort_from: null, level: null });

// `--cwd <folder>`, once, an existing folder. Anything else is refused; `--json` is passed over.
const parse = (words) => readFlags("board", words, { "--cwd": "folder" }, { ignored: ["--json"] });

// Each launch in the history, joined to its recorded run: by the `launch_id` the run names; a run from before launch
// ids by its advice id, only when exactly one launch in the window used that advice. Runs no launch joins stand alone.
export function joinDecisions(launches, runs) {
  const byLaunch = new Map(runs.filter((r) => r.launch_id).map((r) => [r.launch_id, r]));
  const perAdvice = new Map();
  for (const h of launches) if (h.id) perAdvice.set(h.id, (perAdvice.get(h.id) ?? 0) + 1);
  const legacy = new Map();
  for (const r of runs) if (!r.launch_id && r.id) legacy.set(r.id, legacy.has(r.id) ? null : r); // two runs on one advice: neither joins
  const used = new Set(), out = [];
  for (const h of launches) {
    let run = byLaunch.get(h.launch_id) ?? null;
    if (!run && h.id && perAdvice.get(h.id) === 1 && legacy.get(h.id)) run = legacy.get(h.id);
    if (run) used.add(run);
    out.push(entry(h, run));
  }
  for (const r of runs) if (!used.has(r)) out.push(entry(null, r));
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

function entry(h, r) {
  const launched = h?.at ?? null, recorded = r ? ms(r.ts) : null;
  return { at: Math.max(launched ?? 0, recorded ?? 0) || null, launch_id: h?.launch_id ?? r?.launch_id ?? null, run_id: r?.run_id ?? null, id: r?.id ?? h?.id ?? null,
    name: h?.name ?? null, backend: h?.backend ?? null, project: r?.project ?? h?.project ?? null,
    launched_at: iso(launched), recorded_at: iso(recorded),
    advised: projectAdvised(r?.advised ?? h?.advised ?? null), chose: projectChose(r?.chose ?? (h ? choseOfLaunch(h) : null)), outcome: outcomeOf(r?.outcome) };
}

// The 7-day counts, from every row before the display limit: launches in the window (the history keeps 7 days), and runs
// whose first record falls in it, each counted once at its latest revision. Null where its source cannot be read.
function outcomesOf(launches, rows, now, inScope) {
  const first = new Map();
  for (const r of rows ?? []) if (r.run_id && !first.has(r.run_id)) first.set(r.run_id, ms(r.ts));
  const runs = rows ? latestRuns(rows).filter(inScope).filter((r) => { const t = first.get(r.run_id) ?? ms(r.ts); return t != null && now - t < WINDOW_MS; }) : null;
  return {
    launches: launches ? launches.length : null,
    recorded: runs ? runs.length : null,
    done_first_time: runs ? runs.filter((r) => r.outcome && firstTime(r)).length : null,
    level_changed: runs ? runs.filter((r) => r.chose?.level && r.advised?.level && r.chose.level !== r.advised.level).length : null,
    check_failed: runs ? runs.filter((r) => r.outcome?.check === "fail").length : null,
  };
}

// What is kept for `names` (usage-readings.mjs), as rows: no harness is called. `configPath`, the `--config` given, goes
// to the background refresh, so it reads the subscriptions this config names. `config`: the caller's, for its extra
// accounts (usage-readings.mjs).
const keptUsage = (names, { config, configPath }) => {
  const { served, refreshing } = usageReadings({ configPath, config }).kept(names);
  return { rows: served.map((s) => s.row), refreshing };
};
// `usage` is keptUsage's seam; `ledger`, `history` and `now` are tests'.
export async function boardCommand(words, config, { usage = keptUsage, ledger = LEDGER_PATH(), history = readHistory, now = Date.now(), warnings = [], configPath } = {}) {
  let o;
  try { o = parse(words); } catch (e) { return refusal("no board", e.message, warnings); }
  const project = o.cwd ? projectName(o.cwd) : null, inScope = (x) => project == null || x.project === project;
  // `level`: the work the room is ranked for, as in usage: plain work, so no account is left out for its hardest_work.
  const out = { ok: true, headline: "", unavailable: [], warnings: [...warnings], next: [], project, level: "basic" };
  // Room: every configured account that is on, as `usage` ranks it for plain work, from kept readings.
  // Kept readings keep no failed read (usage-readings), so no reader reads as stopped here: `stale` is usage's to say.
  // When ranking fails, board says so in `unavailable` and leaves `next` alone.
  try {
    const names = Object.keys(config.subscriptions ?? {}).filter((n) => config.subscriptions[n]?.enabled !== false);
    const { rows } = usage(names, { config, configPath: configPath ? resolve(configPath) : null });
    const capacity = capacityView(out.level, rows, config, recentLaunches());
    out.subscriptions = capacity.subscriptions;
    out.unavailable.push(...capacity.unavailable);
    out.next.push(...capacity.next);
  } catch {
    out.subscriptions = null;
    out.unavailable.push(capacityFailure("routr could not rank its kept usage readings").failure);
  }
  // Decisions: launches in the history and recorded runs, in scope.
  const h = history({ now });
  if (h.unreadable) out.unavailable.push({ part: "launch history", code: "unreadable", why: "routr's launch history could not be read: open launches are not shown, and the launch count is unknown" });
  let rows = null;
  try { rows = read(ledger); } catch { out.unavailable.push({ part: "ledger", code: "unreadable", why: "The ledger could not be read: recorded outcomes are not shown, and their counts are unknown" }); }
  const launches = h.unreadable ? null : h.records.filter(inScope);
  // Joined across every project, then scoped: whether a run joins a launch, and which, never depends on the folder asked
  // about (a legacy run's advice used by launches in two projects joins neither, in each project's board too).
  const decisions = joinDecisions(h.unreadable ? [] : h.records, rows ? latestRuns(rows) : []).filter(inScope);
  out.decisions = decisions.slice(0, DECISIONS_MAX).map(({ at, ...d }) => d);
  out.outcomes = outcomesOf(launches, rows, now, inScope);
  const room = out.subscriptions?.most_room;
  out.headline = `routr: ${decisions.length} decision${decisions.length === 1 ? "" : "s"} in ${project ?? "all projects"}${room ? `; ${room} has the most room` : ""}`;
  return answer(out);
}
