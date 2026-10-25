// A decision model's answers + user preferences → a FACT SHEET and advice for the agent that asked. Pure: no I/O.
// System One feeds System Two: the decision model (Jev, or Clef: providers.mjs) reads what the brief says, fast and
// calibrated; the agent, who knows the codebase and the purpose of the work, decides how much intelligence and
// reasoning to buy. Nothing here overrides either.
import { FACTS, LEVELS } from "./questions.mjs";
import { doNext } from "./next.mjs";
import { decisionTarget } from "./providers.mjs";

const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;
const YES = 0.8, NO = 0.2; // P26's bar for a decisive answer

// `profile` is the answering model's (providers.mjs): its sure_at, unless the user set one, and the numbers the torn note
// quotes. Jev's when not given.
export function advise(a, c, profile = decisionTarget(null, {}).profile) {
  const s = a.level;
  const sure = s.confidence >= (c.sure_at ?? profile.sure_at);
  // Sure: round to the nearest level. Torn: the MOST LIKELY level (r5). Measured on 36 real tasks from the
  // maintainer's worker runs (P32, 2026-09-26: each labelled by two blind judges, the 16 they split by the maintainer):
  // Jev was torn on 31; on the same gate answers (2026-09-27) the most likely level was right on 29 of 36 (7 one level
  // low, none high), r4's "lower of the two" on 15 (21 low). r4's rule came from 68 short labelled briefs (P31), where
  // Jev reads high and the lower level was right about five times in six; there the most likely level scores 53-54
  // against 59-60 (13-14 over). Over all 104, 82-83 against 74-75. The gate reports both sets. A tie goes lower.
  const probs = LEVELS.map((_, i) => s.probabilities?.[i] ?? 0);
  const topTwo = [0, 1, 2].sort((x, y) => probs[y] - probs[x]).slice(0, 2).sort((x, y) => x - y);
  const between = sure || !s.probabilities ? null : topTwo.map((i) => LEVELS[i]);
  const likely = [0, 1, 2].reduce((best, i) => (probs[i] > probs[best] ? i : best), 0);
  const level = between ? LEVELS[likely] : LEVELS[Math.min(2, Math.max(0, Math.round(s.score)))];
  const notes = [], next = [], briefSteps = [], facts = {}, unclear = [];
  for (const [k, f] of Object.entries(FACTS)) {
    const p = a[k]?.noul;
    if (p == null) continue;
    const reading = p >= YES ? "yes" : p <= NO ? "no" : "unclear";
    facts[k] = { reading, p: Math.round(p * 100) / 100, ...(reading === "unclear" ? {} : { means: f.say[reading === "yes" ? 0 : 1] }) };
    if (reading === "unclear") unclear.push(k);
    if (f.about === "brief" && reading === "no") briefSteps.push(doNext(`Fix the brief: ${f.say[1]}, then dispatch it again`));
  }
  // Said as it was decided: the more likely of two, the lower of two equally likely, or the rounded score when
  // the model gave no spread at all. The record quoted is the answering model's own (its profile).
  const tie = between && probs[topTwo[0]] === probs[topTwo[1]];
  const t = profile.torn, off = [t.low && "too low", t.high && "too high"].filter(Boolean);
  const record = `on ${t.of} real tasks it was the right level ${t.right} times${off.length ? `, and when it was wrong it was one level ${off.join(" or ")}` : ""}`;
  if (!sure) {
    notes.push(!between ? `routr is unsure of the level; its rounded score is ${level}.`
      : `routr is between ${between.join(" and ")} (${LEVELS.map((l, i) => `${l} ${pct(s.probabilities?.[i])}`).join(", ")}); ${level} is ${tie ? "the lower of two equally likely levels" : `the more likely: ${record}`}.`);
    next.push(doNext(`Start at ${level}; go higher if a fact calls for it`));
  }
  if (unclear.length) { notes.push(`routr could not tell from the brief: ${unclear.join(", ")}.`); next.push(doNext(`Settle these from the codebase: ${unclear.join(", ")}`)); }
  // Preferences for every kind of work the model finds plausible, so an unsure work type does not hide one.
  const kinds = Object.entries(a.work_type.probabilities ?? { [a.work_type.choice]: 1 }).filter(([, p]) => p >= 0.3).map(([k]) => k);
  for (const k of kinds) {
    const want = c.prefer[k];
    if (want && LEVELS.indexOf(want) > LEVELS.indexOf(level)) { notes.push(`The user prefers ${want} for ${k} work; routr reads this piece as ${level}.`); next.push(doNext(`Go with ${want} unless the work is plainly rote`)); }
  }
  const risky = a.high_blast_radius.noul > c.risk_above;
  if (risky) { notes.push(`A mistake here could be costly (${pct(a.high_blast_radius.noul)} likely high risk).`); next.push(doNext("Do not go below standard, and review the result")); }
  // Worth a worker? A suggestion from three literal facts; the agent knows what else is running and may overrule it.
  const is = (k) => facts[k]?.reading === "yes";
  const worker = is("needs_user") ? { suggestion: "settle it with the user first", why: "the brief leaves a decision to the user; a worker cannot ask them" }
    : is("tiny") ? { suggestion: "do it yourself", why: "it is one or two small edits; starting a worker costs more than the work" }
    : is("separable") ? { suggestion: "split it across workers", why: "the pieces do not depend on each other, so they can run side by side; ask routr again per piece" }
    : { suggestion: "worth a worker", why: "when it can run while you do something else, or your own subscription is near its reserve; otherwise doing it yourself costs about half" };
  // No brief is being sent when the work stays with the agent, so its gaps are not worth a note.
  const sending = worker.suggestion === "worth a worker" || worker.suggestion === "split it across workers";
  return { level, sure, ...(between ? { between } : {}), work_type: a.work_type.choice, high_risk: risky, worker, facts, notes, next: [...(sending ? briefSteps : []), ...next] };
}

// The advice in one line, for an agent to read first: what to do with the work, the level, the kind of work, the facts
// that read yes and bear on difficulty, then the two warnings. Facts about the brief or the launch are left out: they
// have their own fields.
const NOT_ABOUT_DIFFICULTY = /^(states_check|standalone|names_location|tiny|separable|needs_user)$/;
export function headline(advice) {
  const lead = advice.worker && advice.worker.suggestion !== "worth a worker" ? `${advice.worker.suggestion.toUpperCase()} · ` : "";
  const level = `${advice.level}${advice.sure ? "" : advice.between ? ` (torn between ${advice.between.join(" and ")})` : " (unsure)"}`;
  const yes = Object.entries(advice.facts ?? {}).filter(([k, f]) => f.reading === "yes" && !NOT_ABOUT_DIFFICULTY.test(k)).map(([k]) => k);
  const fixBrief = ["worth a worker", "split it across workers"].includes(advice.worker?.suggestion) && Object.entries(advice.facts ?? {}).some(([k, f]) => FACTS[k]?.about === "brief" && f.reading === "no");
  return `routr: ${lead}${level}, ${advice.work_type ?? "unknown"} work${yes.length ? `; ${yes.join(", ")}` : ""}${advice.high_risk ? "; HIGH RISK" : ""}${fixBrief ? "; FIX THE BRIEF FIRST" : ""}`;
}
