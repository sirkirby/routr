// `routr board`: what only routr knows, for a folder's project, in one answer the Herdr app's routr panel draws (and any
// agent can read). The room each account has (as `usage` ranks it, from kept readings: no harness is called), each
// launch's decision (the launch history) joined to how it turned out (the ledger), and a 7-day count. Reads only:
// it changes nothing of the user's and writes nothing but the usage cache's refresh mark (usage-cache.mjs). Fails open:
// a part it cannot read is said in `unavailable` and its numbers are null, never zero. Every field is projected here,
// field by field: a ledger note (the recorder's text) never reaches its output.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { answer, refusal } from "./output.mjs";
import { firstTime, LEDGER_PATH, latestRuns, projectName, read } from "./ledger.mjs";
import { HISTORY_DAYS, readHistory } from "./launch-history.mjs";
import { cachedUsage } from "./harnesses.mjs";
import { rankSubscriptions } from "./pick.mjs";
import { recentLaunches } from "./shares.mjs";
import { usageUnavailable } from "./usage-failure.mjs";
import { capacityNext } from "./commands.mjs";

export const DECISIONS_MAX = 50;
const WINDOW_MS = HISTORY_DAYS * 86400000;
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const ms = (t) => { const v = Date.parse(t); return Number.isFinite(v) ? v : null; };

// The ledger's own shapes, kept as they are: `advised` and `chose`. An outcome without its note.
const outcomeOf = (o) => (o ? { verdict: o.verdict ?? null, check: o.check ?? null, attempts: o.attempts ?? null, causes: o.causes ?? null, seconds: o.seconds ?? null } : null);
// A launch's choice before it is recorded: the level is the recorder's, so not yet known.
const choseOfLaunch = (h) => ({ subscription: h.subscription, model: h.model, effort: h.effort, effort_from: null, level: null });

// Parses `--cwd <folder>` (once, an existing folder). Anything else is refused.
function parse(words) {
  const o = {}, rest = [...words];
  while (rest.length) {
    const w = rest.shift();
    if (w === "--json") continue;
    if (w !== "--cwd") throw new Error(`board: unknown ${w.startsWith("-") ? "flag" : "argument"} ${w}; routr board [--cwd <folder>]`);
    if (o.cwd != null) throw new Error("board: --cwd was given more than once");
    const v = rest.shift();
    if (!v || v.startsWith("--")) throw new Error("board: --cwd takes a folder");
    let dir; try { dir = statSync(resolve(v)).isDirectory(); } catch { dir = false; }
    if (!dir) throw new Error(`board: --cwd ${v} is not a folder`);
    o.cwd = resolve(v);
  }
  return o;
}

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
    advised: r?.advised ?? h?.advised ?? null, chose: r?.chose ?? (h ? choseOfLaunch(h) : null), outcome: outcomeOf(r?.outcome) };
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

// `usage` is cachedUsage's seam; `ledger`, `history` and `now` are tests'.
export async function boardCommand(words, config, { usage = cachedUsage, ledger = LEDGER_PATH(), history = readHistory, now = Date.now(), warnings = [] } = {}) {
  let o;
  try { o = parse(words); } catch (e) { return refusal("no board", e.message, warnings); }
  const project = o.cwd ? projectName(o.cwd) : null, inScope = (x) => project == null || x.project === project;
  // `level`: the work the room is ranked for, as in usage: plain work, so no account is left out for its hardest_work.
  const out = { ok: true, headline: "", unavailable: [], warnings: [...warnings], next: [], project, level: "basic" };
  // Room: every configured account that is on, as `usage` ranks it for plain work, from kept readings.
  try {
    const names = Object.keys(config.subscriptions ?? {}).filter((n) => config.subscriptions[n]?.enabled !== false);
    const { rows } = usage(names);
    out.subscriptions = rankSubscriptions("basic", rows, config, recentLaunches());
    out.unavailable.push(...usageUnavailable(rows).filter((u) => !out.subscriptions.excluded.some((e) => e.subscription === u.subscription)));
    out.next.push(...capacityNext(out.subscriptions, out.unavailable, out.level, config)); // as usage says them
  } catch {
    out.subscriptions = null;
    out.unavailable.push({ part: "usage", subscription: null, source: "routr", code: "internal_error", why: "routr could not rank its kept usage readings" });
  }
  // Decisions: launches in the history and recorded runs, in scope.
  const h = history({ now });
  if (h.unreadable) out.unavailable.push({ part: "launch history", code: "unreadable", why: "routr's launch history could not be read: open launches are not shown, and the launch count is unknown" });
  let rows = null;
  try { rows = read(ledger); } catch { out.unavailable.push({ part: "ledger", code: "unreadable", why: "The ledger could not be read: recorded outcomes are not shown, and their counts are unknown" }); }
  const launches = h.unreadable ? null : h.records.filter(inScope);
  const decisions = joinDecisions(launches ?? [], rows ? latestRuns(rows).filter(inScope) : []);
  out.decisions = decisions.slice(0, DECISIONS_MAX).map(({ at, ...d }) => d);
  out.outcomes = outcomesOf(launches, rows, now, inScope);
  const room = out.subscriptions?.most_room;
  out.headline = `routr: ${decisions.length} decision${decisions.length === 1 ? "" : "s"} in ${project ?? "all projects"}${room ? `; ${room} has the most room` : ""}`;
  return answer(out);
}
