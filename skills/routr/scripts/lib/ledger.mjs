// The run ledger: one JSON line per piece of work handed out: what routr advised, what the agent chose, how it turned
// out. It is how routr's questions get judged against real work instead of dedicated experiments.
// `routr record` is the ONLY command that writes anything; the advice commands stay side-effect free.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LEVELS } from "./questions.mjs";

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

export function toEntry(advice, { subscription, model, effort, level, verdict, check, seconds, attempts, note, subagents }) {
  return {
    ts: new Date().toISOString(), id: advice.id, asked_at: advice.ts, mode: advice.mode, question_set: advice.question_set,
    brief_sha: advice.brief_sha, brief_chars: advice.brief_chars, // never the brief itself: briefs can be private
    advised: { level: advice.level, sure: advice.sure, work_type: advice.work_type, high_risk: advice.high_risk, fallback: !!advice.fallback,
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

// Pure: entries → report text. Where does a level look too low or too high, and how did usage move?
export function assess(entries) {
  if (!entries.length) return "The ledger is empty. Record work with `routr record` (see references/orchestrator.md).";
  const out = [`${entries.length} recorded pieces of work · question sets: ${[...new Set(entries.map((e) => e.question_set))].join(", ")}\n`];
  out.push("level chosen   runs   delivered (done, check not failed)");
  for (const L of LEVELS) {
    const g = entries.filter((e) => e.chose.level === L);
    if (g.length) out.push(`  ${L.padEnd(11)} ${String(g.length).padStart(4)}   ${g.filter(good).length}/${g.length}${g.length < MIN ? "   (too few to read)" : ""}`);
  }
  const flags = [];
  for (const L of LEVELS) {
    const at = entries.filter((e) => e.chose.level === L && e.advised.level === L);
    const failed = at.filter((e) => !good(e));
    if (at.length >= MIN && failed.length / at.length >= 0.3) flags.push(`TOO LOW?  ${L}: ${failed.length}/${at.length} pieces advised and run at ${L} did not deliver. Look at their facts: ${topFacts(failed)}`);
    const lower = entries.filter((e) => e.advised.level === L && LEVELS.indexOf(e.chose.level) < LEVELS.indexOf(L));
    if (lower.length >= MIN && lower.filter(good).length / lower.length >= 0.8) flags.push(`TOO HIGH? ${L}: agents went lower ${lower.length} times and ${lower.filter(good).length} delivered anyway.`);
    const higher = entries.filter((e) => e.advised.level === L && LEVELS.indexOf(e.chose.level) > LEVELS.indexOf(L));
    if (higher.length >= MIN) flags.push(`DISAGREED UP ${L}: agents went higher ${higher.length} times. Common facts: ${topFacts(higher)}`);
  }
  const rework = entries.filter((e) => (e.outcome.attempts ?? 1) > 1);
  if (rework.length) out.push(`\nrework: ${rework.length}/${entries.length} pieces needed more than one attempt (by level chosen: ${LEVELS.map((L) => `${L} ${rework.filter((e) => e.chose.level === L).length}`).join(", ")})`);
  const unsure = entries.filter((e) => !e.advised.sure);
  out.push(`\nroutr was unsure on ${unsure.length}/${entries.length}; agents changed the level on ${entries.filter((e) => e.chose.level !== e.advised.level).length}.`.replace("rouтr", "routr"));
  out.push(flags.length ? "\n" + flags.join("\n") : `\nNo level looks too low or too high yet (a flag needs at least ${MIN} runs behind it).`);
  const allSubagents = entries.flatMap((e) => e.subagents ?? []);
  if (allSubagents.length) {
    out.push(`\nsubagents: ${allSubagents.length} recorded`);
    for (const L of LEVELS) {
      const at = allSubagents.filter((s) => s.advised === L);
      if (at.length) {
        const counts = {};
        for (const s of at) {
          const m = s.model ?? "unknown";
          counts[m] = (counts[m] ?? 0) + 1;
        }
        const summary = Object.entries(counts)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([m, c]) => `${m} ${c}`)
          .join(", ");
        out.push(`  ${L}: ${summary}`);
      }
    }
  }
  // Usage over time comes free: every dispatch recorded each subscription's usable headroom.
  const subs = [...new Set(entries.flatMap((e) => Object.keys(e.headroom ?? {})))];
  if (subs.length) {
    out.push("\nusable headroom, first → last recorded dispatch (work sent there)");
    for (const s of subs) {
      const seen = entries.filter((e) => e.headroom?.[s]);
      out.push(`  ${s.padEnd(8)} ${seen[0].headroom[s].usable} → ${seen[seen.length - 1].headroom[s].usable}   (${entries.filter((e) => e.chose.subscription === s).length} pieces)`);
    }
  }
  return out.join("\n");
}

function topFacts(es) {
  const n = {};
  for (const e of es) for (const [k, p] of Object.entries(e.advised.facts ?? {})) if (p >= 0.8) n[k] = (n[k] ?? 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => `${k} (${c})`).join(", ") || "none stand out";
}
