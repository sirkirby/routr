// User-facing wording that more than one place shows: written once here, so setup's questions, the help, doctor's notes,
// and the docs (checked by a test) cannot drift apart. No imports: every module may use it.

// What each level of work means. Setup shows it when asking, dispatch prints it with its advice, docs/ranking.md
// repeats it word for word.
export const LEVEL_MEANING = {
  basic: "rote or well-specified work; a small, fast model is enough",
  standard: "the worker must find something out or choose an approach",
  strong: "a wrong or shallow result would be expensive and hard to notice",
};
const levelList = Object.entries(LEVEL_MEANING).map(([l, m], i) => `    ${i + 1}  ${l.padEnd(8)}  ${m}`).join("\n");

// The two settings that decide where work may go (docs/ranking.md, "Your settings").
export const HARDEST = {
  what: "the hardest work routr may send to a subscription",
  flag: "the hardest work routr may send there",
  question: (name, current) => `  The hardest work routr may send to ${name}:\n${levelList}\n  basic, standard, or strong (or 1-3) [Enter = ${current}] `,
  retry: "  one of: basic, standard, strong (or 1-3)",
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
  question: (name, current) => `  Reserve for ${name}: ${RULE}. ${NONE} [Enter = ${current}] `,
  retry: `  a share from 0 to 1, or a percent: 0.25 or 25% (${NONE})`,
  unset: (name) => `subscriptions.${name}.reserve is not set, ${UNSET_EFFECT}`,
  invalid: (name, value) => `subscriptions.${name}.reserve: ${JSON.stringify(value)} is not a share from 0 to 1, ${UNSET_EFFECT}`,
  choose: (name) => `Choose one: routr setup --reserve ${name}=<share, 0% for none>`,
};

// Setup, before the questions, and the one-line summary of what is set.
export const SETTINGS_INTRO = `Two settings decide where routr sends work. The hardest work each subscription takes:\n${levelList}\nAnd a reserve: ${RESERVE.what}.`;
export const settingSummary = (name, s) => `${name} takes ${s.hardest_work} work, reserve ${Math.round(s.reserve * 100)}%`;
