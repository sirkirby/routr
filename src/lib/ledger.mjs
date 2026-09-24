// The run ledger: one JSON line per piece of work handed out: what routr advised, what the agent chose, how it turned
// out. It is how routr's questions get judged against real work instead of dedicated experiments.
// `routr record` is the only command that writes the ledger; the advice commands stay side-effect free.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { LEVELS } from "./questions.mjs";

// The ledger is one file per user, shared by every project on the machine. Each row is labelled with its project so
// `assess` can tell them apart: the folder name of the git repository the work happened in. A worktree counts as its
// repository (its `.git` is a file pointing back at it). Local only: `routr share` never includes it.
export function projectName(cwd = process.cwd()) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    if (existsSync(git)) {
      try {
        const m = readFileSync(git, "utf8").match(/^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/m);
        if (m) return basename(m[1]);
      } catch {} // a directory, not a file: this is the repository itself
      return basename(dir);
    }
    if (dirname(dir) === dir) return basename(resolve(cwd));
  }
}

export const LEDGER_PATH = join(homedir(), ".local/share/routr/ledger.jsonl");

// advice = the JSON that `routr dispatch|subagent` printed. chose/outcome = what the agent did and what it verified.
export function parseSubagent(s) {
  if (!s) return null;
  if (typeof s === "object") {
    const rawAdvised = s.advised ? String(s.advised).trim().toLowerCase() : null;
    const advised = LEVELS.includes(rawAdvised) ? rawAdvised : null;
    if (advised) {
      return {
        subtask: String(s.subtask ?? "").trim(),
        advised,
        model: s.model ? String(s.model).trim() : null,
      };
    }
    return {
      subtask: String(s.raw ?? s.subtask ?? "").trim(),
      advised: null,
      model: null,
    };
  }
  const raw = String(s).trim();
  const text = raw.replace(/^SUBAGENTS:\s*/i, "").trim();
  if (!text || text.toLowerCase() === "none" || /^none\s*\(.*\)$/i.test(text)) return null;
  const m = text.match(/^(.*?)\s*(?:→|->)\s*(basic|standard|strong)\s*(?:→|->)\s*(.*)$/i);
  if (m && m[1].trim()) {
    return {
      subtask: m[1].trim(),
      advised: m[2].trim().toLowerCase(),
      model: m[3].trim() || null,
    };
  }
  return {
    subtask: text,
    advised: null,
    model: null,
  };
}

export function parseReportSubagents(reportText) {
  if (!reportText) return [];
  const lines = reportText.split("\n");
  const result = [];
  for (const line of lines) {
    const m = line.match(/^\s*SUBAGENTS:\s*(.*)$/i);
    if (m) {
      const parsed = parseSubagent(m[1]);
      if (parsed) result.push(parsed);
    }
  }
  return result;
}

export function toEntry(advice, { subscription, model, effort, level, verdict, check, seconds, attempts, note, subagents, project }) {
  return {
    ts: new Date().toISOString(), project: project ?? projectName(), id: advice.id, asked_at: advice.ts, mode: advice.mode, question_set: advice.question_set, jev_model: advice.jev_model ?? null, // the version that answered: a new Jev is compared on real work
    brief_sha: advice.brief_sha, brief_chars: advice.brief_chars, // never the brief itself: briefs can be private
    advised: { level: advice.level, sure: advice.sure, between: advice.between ?? null, work_type: advice.work_type, high_risk: advice.high_risk, fallback: !!advice.fallback,
      facts: Object.fromEntries(Object.entries(advice.facts ?? {}).map(([k, f]) => [k, f.p])) },
    headroom: Object.fromEntries((advice.subscriptions?.ranked ?? []).map((r) => [r.subscription, { usable: r.usable, usage: r.usage }])),
    chose: { subscription: subscription ?? null, model: model ?? null, effort: effort ?? null, level: LEVELS.includes(level) ? level : advice.level },
    outcome: { verdict: verdict ?? "unknown", check: check ?? "none", seconds: seconds ? +seconds : null, attempts: attempts ? +attempts : 1, note: note ?? null },
    subagents: (subagents ?? []).map(parseSubagent).filter(Boolean),
  };
}

export function append(entry, path = LEDGER_PATH) { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(entry) + "\n"); }

export function read(path = LEDGER_PATH) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

const MIN = 5; // below this many runs a rate is an anecdote, and the report says so
const good = (e) => e.outcome.verdict === "done" && e.outcome.check !== "fail";
const firstTime = (e) => good(e) && (e.outcome.attempts ?? 1) === 1;
const idx = (l) => LEVELS.indexOf(l);
const few = (n) => (n < MIN ? "   (too few to read)" : "");

// `routr assess`: what YOUR ledger says about YOUR setup. A user cannot change routr's questions, only their own
// settings, so every finding names the setting it bears on and nothing is read into fewer than MIN runs.
// Pure: entries (+ the user's config, when there is one) → report text.
export function assess(entries, config = null) {
  if (!entries.length) return "The ledger is empty. Record work with `routr record` (see references/orchestrator.md).";
  const out = [], suggestions = [];
  const delivered = entries.filter(good), rework = entries.filter((e) => (e.outcome.attempts ?? 1) > 1);
  out.push(`${entries.length} recorded pieces of work · ${entries.filter(firstTime).length} delivered first time · ${rework.length} needed rework · ${entries.length - delivered.length} not delivered`);

  // Where the work went, and how it did there: this is what `hardest_work` and `default_model` are about.
  out.push("\nwhere your work went            runs  first time  rework  not delivered");
  const groups = {};
  for (const e of entries) (groups[`${e.chose.subscription ?? "?"} · ${e.chose.model ?? "?"}`] ??= []).push(e);
  for (const [k, g] of Object.entries(groups).sort((x, y) => y[1].length - x[1].length))
    out.push(`  ${k.padEnd(30)} ${String(g.length).padStart(3)}  ${String(g.filter(firstTime).length).padStart(9)}  ${String(g.filter((e) => good(e) && !firstTime(e)).length).padStart(6)}  ${String(g.filter((e) => !good(e)).length).padStart(13)}${few(g.length)}`);

  const projects = [...new Set(entries.map((e) => e.project ?? "(unlabelled)"))];
  if (projects.length > 1) {
    out.push("\nby project                      runs  first time  rework  not delivered");
    for (const pr of projects) {
      const g = entries.filter((e) => (e.project ?? "(unlabelled)") === pr);
      out.push(`  ${pr.padEnd(30)} ${String(g.length).padStart(3)}  ${String(g.filter(firstTime).length).padStart(9)}  ${String(g.filter((e) => good(e) && !firstTime(e)).length).padStart(6)}  ${String(g.filter((e) => !good(e)).length).padStart(13)}${few(g.length)}`);
    }
  }
  out.push("\nlevel chosen   runs   delivered (done, check not failed)");
  for (const L of LEVELS) {
    const g = entries.filter((e) => e.chose.level === L);
    if (g.length) out.push(`  ${L.padEnd(11)} ${String(g.length).padStart(4)}   ${g.filter(good).length}/${g.length}${few(g.length)}`);
  }
  if (rework.length) out.push(`\nrework: ${rework.length}/${entries.length} pieces needed more than one attempt (by level chosen: ${LEVELS.map((L) => `${L} ${rework.filter((e) => e.chose.level === L).length}`).join(", ")})`);
  out.push(`\nroutr was torn between two levels on ${entries.filter((e) => !e.advised.sure).length}/${entries.length}; your agents settled on a different level than advised on ${entries.filter((e) => e.chose.level !== e.advised.level).length}.`);

  // Each subscription at the hardest work the user allows it: struggling there bears on `hardest_work`.
  for (const [name, sub] of Object.entries(config?.subscriptions ?? {})) {
    const top = entries.filter((e) => e.chose.subscription === name && e.chose.level === sub.hardest_work);
    const trouble = top.filter((e) => !firstTime(e));
    if (top.length >= MIN && trouble.length / top.length >= 0.4)
      suggestions.push(`subscriptions.${name}.hardest_work is "${sub.hardest_work}": ${trouble.length} of ${top.length} pieces at that level needed rework or were not delivered. Consider lowering it, or a stronger default_model there.`);
    const all = entries.filter((e) => e.chose.subscription === name);
    if (all.length >= MIN && all.every(firstTime) && idx(sub.hardest_work) < 2)
      suggestions.push(`subscriptions.${name}: all ${all.length} pieces delivered first time. If you trust it with more, raise hardest_work above "${sub.hardest_work}".`);
  }
  // A standing preference that agents keep going below, with the work delivered anyway, is costing usage for nothing.
  for (const [kind, want] of Object.entries(config?.prefer ?? {})) {
    const ofKind = entries.filter((e) => e.advised.work_type === kind);
    const below = ofKind.filter((e) => idx(e.chose.level) < idx(want));
    if (below.length >= MIN && below.filter(good).length / below.length >= 0.8)
      suggestions.push(`prefer.${kind} is "${want}": agents went lower ${below.length} times and ${below.filter(good).length} delivered. Consider lowering or removing that preference.`);
    const lifted = ofKind.filter((e) => e.chose.level === want && idx(e.advised.level) < idx(want));
    if (lifted.length >= MIN && lifted.filter((e) => !firstTime(e)).length / lifted.length >= 0.4)
      suggestions.push(`prefer.${kind} is "${want}": it raised ${lifted.length} pieces, and ${lifted.filter((e) => !firstTime(e)).length} still needed rework or failed. The preference is earning its keep.`);
  }

  const allSubagents = entries.flatMap((e) => e.subagents ?? []);
  if (allSubagents.length) {
    out.push(`\nsubagents: ${allSubagents.length} recorded (which models your workers gave their subagents, by the level routr advised)`);
    for (const L of LEVELS) {
      const at = allSubagents.filter((x) => x.advised === L);
      if (!at.length) continue;
      const counts = {};
      for (const x of at) counts[x.model ?? "unknown"] = (counts[x.model ?? "unknown"] ?? 0) + 1;
      out.push(`  ${L}: ${Object.entries(counts).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([m, c]) => `${m} ${c}`).join(", ")}`);
    }
  }

  // Usage over time comes free: every dispatch recorded each subscription's usable headroom. This bears on `reserve`.
  const subs = [...new Set(entries.flatMap((e) => Object.keys(e.headroom ?? {})))];
  if (subs.length) {
    out.push("\nusable headroom, first → last recorded dispatch · lowest seen (work sent there)");
    for (const name of subs) {
      // A metered seat records no number (usable null): it has no reserve to lower.
      const seen = entries.filter((e) => e.headroom?.[name]?.usable != null), us = seen.map((e) => e.headroom[name].usable);
      if (!seen.length) { out.push(`  ${name.padEnd(8)} metered: no headroom number   (${entries.filter((e) => e.chose.subscription === name).length} pieces)`); continue; }
      out.push(`  ${name.padEnd(8)} ${us[0]} → ${us.at(-1)} · ${Math.min(...us)}   (${entries.filter((e) => e.chose.subscription === name).length} pieces)`);
      const atReserve = us.filter((u) => u <= 0.02).length;
      if (seen.length >= MIN && atReserve / seen.length >= 0.3)
        suggestions.push(`subscriptions.${name}.reserve: it was at its reserve in ${atReserve} of ${seen.length} dispatches, so routr kept work away from it. If you want it used more, lower the reserve.`);
    }
  }

  out.push(suggestions.length ? "\nworth a look in ~/.config/routr/config.json:\n" + suggestions.map((x) => "  - " + x).join("\n")
    : `\nNothing here argues for changing your settings yet (a suggestion needs at least ${MIN} runs behind it).`);
  out.push("\nroutr's questions are tuned on real outcomes like these. To contribute yours: `routr share` writes a file you can\nread first (no briefs, no notes, nothing identifying) and tells you where to post it. Nothing is ever sent for you.");
  return out.join("\n");
}

// For the people tuning routr's questions (the lab), not for a user's report: where does the ADVISED level look wrong?
// Nothing in this repository calls it: the private workbench imports it, so the review reads rows exactly as routr writes them.
export function levelReview(entries) {
  const flags = [];
  for (const L of LEVELS) {
    const at = entries.filter((e) => e.chose.level === L && e.advised.level === L);
    const failed = at.filter((e) => !good(e));
    if (at.length >= MIN && failed.length / at.length >= 0.3) flags.push(`TOO LOW?  ${L}: ${failed.length}/${at.length} pieces advised and run at ${L} did not deliver. Common facts: ${topFacts(failed)}`);
    const lower = entries.filter((e) => e.advised.level === L && idx(e.chose.level) < idx(L));
    if (lower.length >= MIN && lower.filter(good).length / lower.length >= 0.8) flags.push(`TOO HIGH? ${L}: agents went lower ${lower.length} times and ${lower.filter(good).length} delivered anyway.`);
    const higher = entries.filter((e) => e.advised.level === L && idx(e.chose.level) > idx(L));
    if (higher.length >= MIN) flags.push(`DISAGREED UP ${L}: agents went higher ${higher.length} times. Common facts: ${topFacts(higher)}`);
  }
  return flags;
}

// `routr share`: the rows a user may choose to publish. Everything that could identify them or their work is
// left out: no ids, no brief hashes, no notes, no timestamps finer than the day, no usage numbers, and no model names
// unless they ask for them. What remains is what tuning needs: what routr read (and which Jev version read it), what was
// chosen, how it turned out. The Jev version is routr's, not the user's, so it identifies nothing.
export function shareRows(entries, { withModels = false } = {}) {
  return entries.map((e) => ({
    v: 1, day: String(e.ts ?? "").slice(0, 10), mode: e.mode, question_set: e.question_set, jev_model: e.jev_model ?? null, brief_chars: e.brief_chars,
    advised: { level: e.advised.level, sure: e.advised.sure, between: e.advised.between ?? null, work_type: e.advised.work_type, high_risk: e.advised.high_risk, fallback: e.advised.fallback, facts: e.advised.facts },
    chose: { subscription: e.chose.subscription, level: e.chose.level, effort: e.chose.effort, ...(withModels ? { model: e.chose.model } : {}) },
    outcome: { verdict: e.outcome.verdict, check: e.outcome.check, attempts: e.outcome.attempts ?? 1 },
    subagents: (e.subagents ?? []).map((x) => ({ advised: x.advised, ...(withModels ? { model: x.model } : {}) })),
  }));
}

function topFacts(es) {
  const n = {};
  for (const e of es) for (const [k, p] of Object.entries(e.advised.facts ?? {})) if (p >= 0.8) n[k] = (n[k] ?? 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => `${k} (${c})`).join(", ") || "none stand out";
}
