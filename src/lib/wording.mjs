// User-facing wording that more than one place shows: written once here, so setup's questions, the help, doctor's notes,
// and the docs (checked by a test) cannot drift apart. No imports: every module may use it.

// What each level of work means. Setup shows it when asking, dispatch prints it with its advice, docs/ranking.md
// repeats it word for word.
export const LEVEL_MEANING = {
  basic: "rote or well-specified work; a small, fast model is enough",
  standard: "the worker must find something out or choose an approach",
  strong: "a wrong or shallow result would be expensive and hard to notice",
};

// The two settings that decide where work may go (docs/ranking.md, "Your settings").
export const HARDEST = {
  what: "the hardest work routr may send to a subscription",
  flag: "the hardest work routr may send there",
  unset: (name) => `subscriptions.${name}.hardest_work is not set, so strong is used`,
  invalid: (name, value) => `subscriptions.${name}.hardest_work: "${value}" is not a level, so strong is used`,
  choose: (name) => `Choose one: routr setup --hardest ${name}=basic|standard|strong`,
};
const ROOM = "so the orchestrator and anything you run outside routr still have room";
const RULE = "routr stops sending workers there when less than this share is left";
const NONE = "0% holds nothing back";
const UNSET_EFFECT = "so routr holds nothing back (as with 0%)";
export const RESERVE = {
  what: `the share of each subscription routr never hands to workers, ${ROOM}`,
  rule: RULE,
  none: NONE,
  flag: `the share routr holds back from workers, ${ROOM} (0.25 or 25%; ${NONE})`,
  unset: (name) => `subscriptions.${name}.reserve is not set, ${UNSET_EFFECT}`,
  invalid: (name, value) => `subscriptions.${name}.reserve: ${JSON.stringify(value)} is not a share from 0 to 1, ${UNSET_EFFECT}`,
  choose: (name) => `Choose one: routr setup --reserve ${name}=<share, 0% for none>`,
};

// A subscription the user turned off keeps its settings; routr just gives it no work until it is turned on again.
export const OFF = {
  reason: (name) => `turned off in your settings: routr setup --enable ${name}`,
  launch: (label, name) => `${label} is turned off in your settings: turn it on with routr setup --enable ${name}`,
};

// The one-line summary of what is set.
export const settingSummary = (name, s) => `${name} takes ${s.hardest_work} work, reserve ${Math.round(s.reserve * 100)}%`;

// A missing config is not an error: routr answers on its defaults, and says how to write one.
export const NO_CONFIG = (path) => `no config at ${path}: using defaults (run \`routr setup\`)`;

// The last line of every `subagent` and `dispatch` answer: whose decision it is, and what to report.
export const ADVICE_RULE = {
  subagent: "You decide how much intelligence and reasoning this work needs, from these facts and what you know of the codebase; pick the model and effort that match, never a model stronger than yourself. Do not default to your own model. If you settle on a different level than advised, say so in your report: ROUTR: <advised> → <chosen> because <reason>.",
  dispatch: "You decide how much intelligence and reasoning this work needs, from these facts and what you know of the codebase. Launch on a subscription with usable headroom, starting from the user's default model there and moving up or down to match. If you go against this advice, record why.",
};
