// The router's fixed question set. Versioned: any wording change is a new VERSION and needs its measurement (docs/evidence.md, CONTRIBUTING.md).
// r2 is a FACT SHEET for the agent that asked, not a verdict. P26: Jev is decisive about facts stated in the brief
// (63-88% of answers below 0.2 or above 0.8) and unsure about estimates of what the work will take (22-43%), which
// depend on the codebase: the asking agent knows that, Jev cannot. So Jev reads the brief; the agent decides.
// All questions go in ONE request; Jev answers them in parallel and none can see another's answer. Code combines them.
export const VERSION = "r4"; // r4 asks the same questions as r3; an unsure level now reads as the lower of the two most likely
import { LEVEL_MEANING } from "./wording.mjs";

export const LEVELS = ["basic", "standard", "strong"];
// What each level means for the agent that asked: the work (wording.mjs, shared with setup and the docs), then the kind
// of model that fits it. Never a model's name.
export const MEANING = {
  basic: LEVEL_MEANING.basic,
  standard: `${LEVEL_MEANING.standard}; a mid-range model, not the top one`,
  strong: `${LEVEL_MEANING.strong}; a strong model`,
};
// The Jev version every result in docs/evidence.md was measured on. Answers, and the thresholds tuned on them (0.2/0.8,
// sure_at, the lower-of-two rule), belong to a version, so the pin moves only after the maintainers' model gate has run
// the saved items on the new version beside this one (CONTRIBUTING.md, "Moving to a new Jev version"). ROUTR_JEV_MODEL
// overrides it for that gate and for trying a preview on real work; it is not a user setting.
export const JEV_MODEL = "jev-1.13.0";


// Literal yes/no facts about the brief. Order here is the order they are reported in.
export const FACTS = {
  names_location: { about: "work", say: ["the brief names where to work", "the brief does not name where to work: the worker must find it"],
    instructions: "Does `task.brief` name the specific files, directories, or functions where the change should be made?" },
  approach_open: { about: "work", say: ["the approach is left to the worker", "the brief dictates the change"],
    instructions: "Does `task.brief` leave the agent to choose the approach or design, rather than stating the exact change to make?" },
  cause_unknown: { about: "work", say: ["the cause is unknown and must be investigated", "no unknown cause to investigate"],
    instructions: "Does `task.brief` describe a problem whose cause is unknown and must be investigated before it can be fixed?" },
  cross_cutting: { about: "work", say: ["needs coordinated changes across many parts", "contained to one part"],
    instructions: "Does the task in `task.brief` require coordinated changes across many modules, services, or tables that must stay consistent with each other?" },
  concurrency_or_data: { about: "work", say: ["involves concurrency or stored-data integrity", "no concurrency or data-integrity hazard"],
    instructions: "Does the task in `task.brief` involve race conditions, concurrency, distributed consistency, or the integrity of stored data?" },
  hard_to_reverse: { about: "work", say: ["expensive to undo once shipped", "cheap to undo"],
    instructions: "Would the result of the task in `task.brief` be expensive or risky to undo once shipped, such as a data migration, a public contract, or an architectural commitment?" },
  // Is it worth a worker at all? (P30) Starting a worker has a fixed cost, and delegation that does not split roughly
  // doubles usage for no gain, so the first decision is whether to hand the work out.
  tiny: { about: "launch", say: ["one or two small edits or a single command", "more than a couple of small edits"],
    instructions: "Could all of the work in `task.brief` be completed with one or two small edits or a single command?" },
  separable: { about: "launch", say: ["several pieces that do not depend on each other", "one connected piece of work"],
    instructions: "Does `task.brief` ask for several pieces of work that do not depend on each other's results?" },
  needs_user: { about: "launch", say: ["leaves a decision to the user that must be settled first", "leaves no decision to the user"],
    instructions: "Does `task.brief` leave a decision to the person who wrote it, such as a preference, a choice between options, or an approval, that must be settled before the work can be finished?" },
  states_check: { about: "brief", say: ["the brief says how to check the work", "the brief does NOT say how to check the work: add the command or expected result before you send it"],
    instructions: "Does `task.brief` explicitly state how to confirm the work is correct, such as a test to add, tests that must pass, or an expected output?" },
  standalone: { about: "brief", say: ["a worker with no other context can start on it", "the brief leans on context the worker will not have: add it before you send it"],
    instructions: "Does `task.brief` describe a piece of work that someone who has seen no earlier conversation could understand and start on?",
    criteria: { true: "It states what is to be done, even if details must be investigated.", false: "It is a reply, a reaction, a short question, or a fragment that only makes sense as part of an earlier conversation." } },
};

export const questions = {
  ...Object.fromEntries(Object.entries(FACTS).map(([k, f]) => [k, { type: "noul", instructions: f.instructions, ...(f.criteria ? { criteria: f.criteria } : {}) }])),
  // The three Score levels ARE the three outcomes, so code only rounds; there is no difficulty scale to map.
  // Wording chosen by P23 (two wordings measured against 68 labelled briefs).
  // Each level describes a situation and stands on its own: Jev never sees level numbers or neighbouring levels.
  level: {
    type: "score",
    instructions: "What does the work described in `task.brief` demand of the agent that carries it out?",
    criteria: [
      "Rote or well-specified work: the brief says what to change or what to look up, and where. For example a rename, a config value, a typo, a version bump, counting or listing things, running a command and reporting its output, or an ordinary change to a few named files that needs coding skill but leaves no design decisions.",
      "Work where the agent must find something out or choose an approach: the cause of a bug is not given, several reasonable solutions exist, a feature must be fitted into existing code across a few modules, or part of a codebase must be read and explained.",
      "Work where a wrong or shallow result is expensive and hard to notice: tracing how behaviour emerges across many parts of a large codebase, an architectural or cross-cutting redesign, concurrency or data-integrity hazards, a subtle intermittent failure, or a decision that is expensive to reverse.",
    ],
  },
  work_type: {
    type: "choice",
    instructions: "What is the primary kind of work requested in `task.brief`?",
    criteria: {
      implement: "Build new behavior or a new feature.",
      debug: "Find and fix the cause of incorrect behavior, a crash, a failure, or a slowdown.",
      refactor: "Restructure existing code without changing its behavior, including renames and migrations of call sites.",
      review: "Read existing code or a diff and report findings without changing it.",
      research: "Investigate a question, compare options, or gather facts and report back; no code change is the main deliverable.",
      test_writing: "Write or extend automated tests for existing behavior.",
      docs: "Write or update documentation, comments, or a README.",
    },
  },
  high_blast_radius: {
    type: "noul",
    instructions:
      "If the task in `task.brief` were done incorrectly, could it cause data loss, a security hole, a production outage, or breakage across many parts of the system?",
    criteria: {
      true: "The work touches authentication, payments, data migrations, deletion, shared infrastructure, public APIs, or concurrency in production paths.",
      false: "A mistake would be contained to one feature, a test, a script, documentation, or would be caught immediately and cheaply.",
    },
  },
};

// The JUDGE step: narrow questions about a worker's REPORT, read against the brief it was given. They do not replace
// the orchestrator's own check (run the tests, read the diff); they decide quickly whether the report itself gives a
// reason to send the work back. `flag` is the reading that counts against the work.
export const CHECK_VERSION = "c1";
export const CHECKS = {
  states_verification: { flag: "no", say: "the report does not say what was run to verify the work or what it showed",
    instructions: "Does `report.text` name a specific command, test, or check that was actually run on the work, together with what it showed?" },
  covers_brief: { flag: "no", say: "the report does not cover every part of the brief",
    instructions: "Does `report.text` say that every separate piece of work requested in `task.brief` was completed?" },
  admits_gaps: { flag: "yes", say: "the report itself says something is unfinished, skipped, untested, or failing",
    instructions: "Does `report.text` say that any part of the work is unfinished, skipped, untested, uncertain, or still failing?" },
  symptom_patch: { flag: "yes", onlyFor: ["debug"], // asked every time (one request), consumed only where it applies
    say: "the fix reads as a special case around the symptom, not a fix of the cause",
    instructions: "Does `report.text` describe handling the reported problem with a special case, guard, workaround, retry, or suppressed error, rather than correcting the underlying cause?" },
  out_of_scope: { flag: "yes", say: "the report describes changes beyond what the brief asked for",
    instructions: "Does `report.text` describe changing files or behaviour beyond what `task.brief` asked for?" },
};
export const checkQuestions = {
  ...Object.fromEntries(Object.entries(CHECKS).map(([k, c]) => [k, { type: "noul", instructions: c.instructions }])),
  work_type: questions.work_type,
  verdict: { type: "choice", instructions: "What outcome does `report.text` claim for the work?",
    criteria: { done: "All of the requested work is complete.", partial: "Some of the requested work is complete and some is not.", blocked: "The work could not proceed or could not be completed.", unstated: "The report does not say." } },
};
