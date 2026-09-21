#!/usr/bin/env bun
// routr: quick, calibrated advice for an agent that is about to hand out work.
//   routr subagent "<brief>"   an agent is about to spawn a subagent → what the work demands
//   routr dispatch "<brief>"   an orchestrator is about to launch a pane → the same, plus subscriptions ranked by usable headroom
//   routr doctor [--json]      check the setup; changes nothing
//   routr check --brief <f> --report <f>   a quick first read of a worker's report (pure); you remain the judge
//   routr record ...           append what you chose and how it turned out to the ledger
//   routr launch ...           start a worker, handle startup, and submit its task
//   routr assess               what the ledger says: where a level looks too low or too high, and how usage moved
// The brief may come on stdin. Jev (TypeSafe System One) judges the WORK in ~300 ms; code does the arithmetic;
// the agent that asked makes the decision. Never names a model.
// Advice is side-effect free and fail-open; launch reports failures as JSON and exits nonzero.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { advise } from "./lib/advise.mjs";
import { readReport } from "./lib/check.mjs";
import { loadConfig } from "./lib/config.mjs";
import { doctor } from "./lib/doctor.mjs";
import { ask } from "./lib/jev.mjs";
import { append, assess, LEDGER_PATH, read, toEntry } from "./lib/ledger.mjs";
import { launch } from "./lib/launch.mjs";
import { rankSubscriptions } from "./lib/pick.mjs";
import { CHECK_VERSION, checkQuestions, questions, VERSION } from "./lib/questions.mjs";
import { readUsage } from "./lib/usage.mjs";
import { setKey } from "./lib/key.mjs";
import { installSkill } from "./lib/skill-install.mjs";
import { statusline } from "./lib/statusline.mjs";
import { ROUTR_VERSION } from "./lib/version.mjs";
import { COMMANDS, formatCommandHelp, formatTopLevelHelp, formatUnknownUsage } from "./lib/help.mjs";

const MEANING = {
  basic: "rote or well-specified work; a small, fast model is enough",
  standard: "the agent must find something out or choose an approach; a mid-range model, not the top one",
  strong: "a wrong or shallow result would be expensive and hard to notice; a strong model",
};
const RULE = {
  subagent: "You decide how much intelligence and reasoning this work needs, from these facts and what you know of the codebase; pick the model and effort that match, never a model stronger than yourself. Do not default to your own model. If you settle on a different level than advised, say so in your report: ROUTR: <advised> → <chosen> because <reason>.",
  dispatch: "You decide how much intelligence and reasoning this work needs, from these facts and what you know of the codebase. Launch on a subscription with usable headroom, starting from the user's default model there and moving up or down to match. If you go against this advice, record why.",
};

const argv = process.argv.slice(2);
if (argv[0] === "--help" || argv[0] === "-h" || (argv[0] === "help" && (!argv[1] || !COMMANDS[argv[1]]))) {
  console.log(formatTopLevelHelp());
  process.exit(0);
}
if ((argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") && argv[1] && COMMANDS[argv[1]]) {
  console.log(formatCommandHelp(COMMANDS[argv[1]]));
  process.exit(0);
}
if (COMMANDS[argv[0]]) {
  const isHelp = (argv[0] === "subagent" || argv[0] === "dispatch")
    ? (argv[1] === "--help" || argv[1] === "-h")
    : (argv.slice(1).includes("--help") || argv.slice(1).includes("-h"));
  if (isHelp) {
    console.log(formatCommandHelp(COMMANDS[argv[0]]));
    process.exit(0);
  }
}
if (argv[0] === "launch") {
  const result = await launch(argv.slice(1));
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
if (argv[0] === "statusline" && !argv.includes("--help") && !argv.includes("-h")) { statusline(); process.exit(0); } // before anything else: it runs on every Claude turn
if (argv.includes("--version")) { console.log(ROUTR_VERSION); process.exit(0); }
if (argv[0] === "key" && argv[1] === "set" && !argv.includes("--help") && !argv.includes("-h")) { const r = await setKey({ verify: !argv.includes("--no-verify") }); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
if (argv[0] === "skill" && argv[1] === "install" && !argv.includes("--help") && !argv.includes("-h")) { console.log(JSON.stringify(installSkill({ dryRun: argv.includes("--dry-run") }), null, 1)); process.exit(0); }
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const configPath = flag("--config");
// --headroom cursor=0.97 : usage the caller read itself (repeatable), for harnesses with no local source
const given = {}; for (let h; (h = flag("--headroom")); ) { const [k, v] = h.split("="); if (k && !Number.isNaN(+v)) given[k] = +v; }
const [mode, ...rest] = argv;

if (mode === "check") {
  // usage: routr check --brief <file> --report <file>    a quick first read of a worker's report; you remain the judge
  const out = { mode: "check", question_set: CHECK_VERSION };
  try {
    const brief = readFileSync(flag("--brief"), "utf8").trim(), report = readFileSync(flag("--report"), "utf8").trim();
    if (report.length < 200) out.warning = "this report is very short: make sure it is the worker's full report, not just its last message";
    const r = await ask({ task: { brief }, report: { text: report } }, checkQuestions, undefined, 10000);
    Object.assign(out, readReport(r.answers), { ms: Math.round(r.latencyMs) });
  } catch (e) { Object.assign(out, { headline: "routr: could not read the report; judge it yourself", fallback: true, error: String(e?.message ?? e).slice(0, 160) }); }
  console.log(JSON.stringify(out)); process.exit(0);
}
if (mode === "assess") { console.log(assess(read(flag("--ledger") ?? LEDGER_PATH))); process.exit(0); }
if (mode === "record") {
  // usage: routr dispatch "<brief>" > advice.json ... then: routr record --advice advice.json --subscription codex --model <m> --effort low [--level basic] --verdict done --check pass [--seconds 24] [--note "..."]
  const o = Object.fromEntries(["--advice", "--subscription", "--model", "--effort", "--level", "--verdict", "--check", "--seconds", "--attempts", "--note", "--ledger"].map((f) => [f.slice(2), flag(f)]));
  try {
    const advice = JSON.parse(o.advice ? readFileSync(o.advice, "utf8") : readFileSync(0, "utf8"));
    append(toEntry(advice, o), o.ledger ?? LEDGER_PATH);
    console.log(JSON.stringify({ recorded: advice.id, ledger: o.ledger ?? LEDGER_PATH }));
  } catch (e) { console.log(JSON.stringify({ recorded: null, error: String(e?.message ?? e).slice(0, 160) })); } // never blocks the agent
  process.exit(0);
}
if (mode === "doctor") { await doctor({ json: rest.includes("--json"), configPath }); process.exit(0); }
if (mode !== "subagent" && mode !== "dispatch") { console.error(formatUnknownUsage()); process.exit(2); }
let brief = rest.join(" ").trim();
if (!brief && !process.stdin.isTTY) { try { brief = readFileSync(0, "utf8").trim(); } catch {} }
if (!brief) { console.error("routr: empty brief"); process.exit(2); }

const { config, notes: configNotes } = loadConfig(configPath);
const out = { id: randomUUID().slice(0, 8), ts: new Date().toISOString(), mode, question_set: VERSION, brief_sha: createHash("sha256").update(brief).digest("hex").slice(0, 12), brief_chars: brief.length };
let advice = { level: config.fallback_level, sure: false, facts: {}, notes: [] };
// Usage is re-read on every call, never cached (P9), and read while Jev answers so it adds no waiting.
const usageP = mode === "dispatch" ? readUsage(Object.keys(config.subscriptions), given).catch(() => []) : null;
try {
  const r = await ask({ task: { brief } }, questions, undefined, 10000);
  advice = advise(r.answers, config);
  // Raw judgments travel with the advice, so preferences can be re-evaluated later without asking again.
  const a = r.answers;
  Object.assign(out, { jev_model: r.model, ms: Math.round(r.latencyMs), answers: { level: { score: a.level.score, confidence: a.level.confidence, probabilities: a.level.probabilities }, work_type: { choice: a.work_type.choice, confidence: a.work_type.confidence }, high_blast_radius: a.high_blast_radius.noul } }); // fact probabilities are in `facts`
} catch (e) {
  advice.notes.push(`Router unavailable (${String(e?.message ?? e).slice(0, 120)}). "${config.fallback_level}" is only the user's fallback: judge the level yourself.`);
  out.fallback = true;
}
const yes = Object.entries(advice.facts ?? {}).filter(([k, f]) => f.reading === "yes" && !/^(states_check|standalone|names_location|tiny|separable|needs_user)$/.test(k)).map(([k]) => k);
Object.assign(out, { headline: `routr: ${advice.worker && advice.worker.suggestion !== "worth a worker" ? advice.worker.suggestion.toUpperCase() + " · " : ""}${advice.level}${advice.sure ? "" : advice.between ? ` (torn between ${advice.between.join(" and ")})` : " (unsure)"}, ${advice.work_type ?? "unknown"} work${yes.length ? "; " + yes.join(", ") : ""}${advice.high_risk ? "; HIGH RISK" : ""}${(advice.notes ?? []).some((n) => n.startsWith("Fix the brief")) ? "; FIX THE BRIEF FIRST" : ""}`, ...advice, meaning: MEANING[advice.level] });
if (mode === "dispatch") {
  try { out.subscriptions = rankSubscriptions(advice.level, await usageP, config); }
  catch (e) { out.subscriptions = { most_room: null, ranked: [], excluded: [], note: `could not read usage: ${String(e?.message ?? e).slice(0, 120)}` }; }
}
console.log(JSON.stringify({ ...out, rule: RULE[mode], ...(configNotes.length ? { config_notes: configNotes } : {}) }));
