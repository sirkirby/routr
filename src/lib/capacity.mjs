// One capacity view wherever a command shows ranked subscriptions (dispatch, usage, board): the ranking, the usage that
// could not be read, the readers that stopped working, and what to do next. Callers add what is only theirs.
import { doNext, runNext } from "./next.mjs";
import { levelExcludedWhy, rankSubscriptions } from "./pick.mjs";
import { staleReaders, usageFailure, usageUnavailable } from "./usage-failure.mjs";
import { accountOf, HARNESSES, withFolder } from "./harnesses.mjs";

const hasCandidates = (r) => r && [...r.candidates.normal, ...r.candidates.fallback].length > 0;
export const emptyRanking = (note) => ({ most_room: null, candidates: { normal: [], fallback: [] }, ranked: [], excluded: [], note });

// The view of `usage` (rows from a read or kept readings) ranked for `level`. `named`: the subscription a named `usage`
// view ranks alone, which never offers a lower level. `configured`: whether routr has any subscription configured,
// when `config` is narrowed to the named one. `unavailable`: entries only the caller knows (a named fresh read that
// failed), merged before the steps are worked out, so their by-hand step is said too. Throws when ranking fails: each
// command says that its own way, with capacityFailure.
// Returns `subscriptions`, `unavailable`, `next` (the capacity steps, which go first in a command's `next`) and `stale`,
// each reader that stopped working as `{ pool, warning, retry }`: its warning, and the step to try it again.
export function capacityView(level, usage, config, launches = null, { named = null, configured = Object.keys(config.subscriptions).length > 0, unavailable: extra = [] } = {}) {
  const subscriptions = rankSubscriptions(level, usage, config, launches);
  const unavailable = usageUnavailable(usage).filter((u) => !subscriptions.excluded.some((e) => e.subscription === u.subscription));
  for (const u of extra) if (!unavailable.some((x) => x.subscription === u.subscription)) unavailable.push(u);
  const stale = staleReaders(usage, config).map((s) => ({ ...s, retry: runNext(`Try reading ${s.pool}'s usage again.`, ["routr", "usage", s.pool]) }));
  return { subscriptions, unavailable, next: capacityNext(subscriptions, unavailable, level, configured, named, config), stale };
}

// What a command says when ranking failed: its `unavailable` entry (with the command's own `why`, if it has one) and
// the step to read capacity by hand.
export function capacityFailure(why = usageFailure("internal_error").why) {
  return { failure: { part: "usage", subscription: null, source: "routr", ...usageFailure("internal_error"), why }, next: doNext("Read capacity yourself before choosing an account") };
}

function capacityNext(r, unavailable, level, configured, named, config) {
  const steps = [];
  if (!configured) steps.push(doNext("Tell the user routr is not set up (routr setup), and ask which subscription to use meanwhile"));
  else if (!r.ranked.length) steps.push(doNext(level !== "basic" && !named && r.excluded.some((e) => e.why === levelExcludedWhy(level))
    ? "Hold the work, or choose a lower level and refresh with routr usage --level, or ask the user"
    : "Hold the work, use an eligible subscription for this run, or ask the user; the exclusions explain what fixes eligibility"));
  else if (!hasCandidates(r)) steps.push(doNext(`Hold the work or ask the user: every subscription that takes ${level} work is at its reserve`));
  for (const u of unavailable.filter((u) => u.part === "usage")) {
    // Each harness's own words for reading it by hand: shared by reader diagnostics and these steps, never tucked into a ranked row's note.
    // An extra account's are its harness's, with its folder and its own name.
    const a = accountOf(u.subscription, config), h = a?.kind ?? u.subscription;
    const byHand = Object.hasOwn(HARNESSES, h) ? HARNESSES[h].usage.byHand(u.subscription) : null;
    if (u.code === "command_shadowed") steps.push(doNext("Rename or remove your own usage skill or command, or pass --headroom from a number you already have", `--headroom ${u.subscription}=<share left>`));
    else if (byHand) steps.push(doNext(`Read ${u.subscription}'s usage by hand${a ? ` ${withFolder(a)}` : ""}: ${byHand}`, `--headroom ${u.subscription}=<share left>`));
  }
  return steps;
}
