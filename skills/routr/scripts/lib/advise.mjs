// Jev answers + user preferences → a FACT SHEET and advice for the agent that asked. Pure: no I/O.
// System One feeds System Two: Jev reads what the brief says, fast and calibrated; the agent, who knows the codebase
// and the purpose of the work, decides how much intelligence and reasoning to buy. Nothing here overrides either.
import { FACTS, LEVELS } from "./questions.mjs";

const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;
const YES = 0.8, NO = 0.2; // P26's bar for a decisive answer

export function advise(a, c) {
  const s = a.level;
  const level = LEVELS[Math.min(2, Math.max(0, Math.round(s.score)))];
  const sure = s.confidence >= c.sure_at;
  const notes = [], facts = {}, unclear = [];
  for (const [k, f] of Object.entries(FACTS)) {
    const p = a[k]?.noul;
    if (p == null) continue;
    const reading = p >= YES ? "yes" : p <= NO ? "no" : "unclear";
    facts[k] = { reading, p: Math.round(p * 100) / 100, ...(reading === "unclear" ? {} : { means: f.say[reading === "yes" ? 0 : 1] }) };
    if (reading === "unclear") unclear.push(k);
    if (f.about === "brief" && reading === "no") notes.push(`Fix the brief first: ${f.say[1]}.`);
  }
  if (!sure) notes.push(`routr is not sure of the overall level (${LEVELS.map((l, i) => `${l} ${pct(s.probabilities?.[i])}`).join(", ")}). Decide from the facts and what you know of the codebase.`);
  if (unclear.length) notes.push(`routr could not tell from the brief: ${unclear.join(", ")}. You can: you know the codebase.`);
  // Preferences for every kind of work Jev finds plausible, so an unsure work type does not hide one.
  const kinds = Object.entries(a.work_type.probabilities ?? { [a.work_type.choice]: 1 }).filter(([, p]) => p >= 0.3).map(([k]) => k);
  for (const k of kinds) {
    const want = c.prefer[k];
    if (want && LEVELS.indexOf(want) > LEVELS.indexOf(level)) notes.push(`The user prefers ${want} for ${k} work; routr reads this piece as ${level}. Go with ${want} unless the work is plainly rote.`);
  }
  const risky = a.high_blast_radius.noul > c.risk_above;
  if (risky) notes.push(`A mistake here could be costly (${pct(a.high_blast_radius.noul)} likely high risk). Do not go below standard, and review the result.`);
  // Worth a worker? A suggestion from three literal facts; the agent knows what else is running and may overrule it.
  const is = (k) => facts[k]?.reading === "yes";
  const worker = is("needs_user") ? { suggestion: "settle it with the user first", why: "the brief leaves a decision to the user; a worker cannot ask them" }
    : is("tiny") ? { suggestion: "do it yourself", why: "it is one or two small edits; starting a worker costs more than the work" }
    : is("separable") ? { suggestion: "split it across workers", why: "the pieces do not depend on each other, so they can run side by side; ask routr again per piece" }
    : { suggestion: "worth a worker", why: "when it can run while you do something else, or your own subscription is near its reserve; otherwise doing it yourself costs about half" };
  // No brief is being sent when the work stays with the agent, so its gaps are not worth a note.
  const sending = worker.suggestion === "worth a worker" || worker.suggestion === "split it across workers";
  return { level, sure, work_type: a.work_type.choice, high_risk: risky, worker, facts, notes: sending ? notes : notes.filter((n) => !n.startsWith("Fix the brief first")) };
}
