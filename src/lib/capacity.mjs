// One capacity view wherever a command shows ranked subscriptions: the ranking, failed usage reads, stale-reader
// warnings, and what to do next. Callers add only the steps and fallbacks their own contracts require.
import { doNext, runNext } from "./next.mjs";
import { levelExcludedWhy, rankSubscriptions } from "./pick.mjs";
import { staleReaders, USAGE_BY_HAND, usageFailure, usageUnavailable } from "./usage-failure.mjs";

const hasCandidates = (r) => r && [...r.candidates.normal, ...r.candidates.fallback].length > 0;
export const emptyRanking = (note) => ({ most_room: null, candidates: { normal: [], fallback: [] }, ranked: [], excluded: [], note });

// `capacityConfig` is usage's full config when a named view ranks only one subscription. `unavailable` is for the
// named readers' fresh-read failure, which usage alone can know; this module still owns its ordering and next step.
export function capacityView(level, usage, config, launches = null, { capacityConfig = config, unavailable: extra = [] } = {}) {
  try {
    const subscriptions = rankSubscriptions(level, usage, config, launches);
    const unavailable = usageUnavailable(usage).filter((u) => !subscriptions.excluded.some((e) => e.subscription === u.subscription));
    for (const u of extra) if (!unavailable.some((x) => x.subscription === u.subscription) && !subscriptions.excluded.some((e) => e.subscription === u.subscription)) unavailable.push(u);
    const stale = staleReaders(usage, config);
    const warnings = stale.map((s) => s.warning);
    const next = [...capacityNext(subscriptions, unavailable, level, capacityConfig),
      ...stale.map((s) => runNext(`Try reading ${s.pool}'s usage again.`, ["routr", "usage", s.pool]))];
    return { subscriptions, unavailable, warnings, next, stale };
  } catch {
    return capacityFailure();
  }
}

export function capacityFailure() {
  const failure = { part: "usage", subscription: null, source: "routr", ...usageFailure("internal_error") };
  return { subscriptions: null, unavailable: [failure], warnings: [], next: [doNext("Read capacity yourself before choosing an account")], stale: [] };
}

function capacityNext(r, unavailable, level, config) {
  const steps = [];
  if (unavailable.some((u) => u.part === "usage" && u.code === "internal_error")) steps.push(doNext("Read capacity yourself before choosing an account"));
  else if (!Object.keys(config.subscriptions).length) steps.push(doNext("Tell the user routr is not set up (routr setup), and ask which subscription to use meanwhile"));
  else if (!r.ranked.length) steps.push(doNext(level !== "basic" && r.excluded.some((e) => e.why === levelExcludedWhy(level))
    ? "Hold the work, or choose a lower level and refresh with routr usage --level, or ask the user"
    : "Hold the work, use an eligible subscription for this run, or ask the user; the exclusions explain what fixes eligibility"));
  else if (!hasCandidates(r)) steps.push(doNext(`Hold the work or ask the user: every subscription that takes ${level} work is at its reserve`));
  for (const u of unavailable.filter((u) => u.part === "usage")) {
    const byHand = USAGE_BY_HAND[u.subscription];
    if (u.code === "command_shadowed") steps.push(doNext("Rename or remove your own usage skill or command, or pass --headroom from a number you already have", `--headroom ${u.subscription}=<share left>`));
    else if (byHand) steps.push(doNext(`Read ${u.subscription}'s usage by hand: ${byHand}`, `--headroom ${u.subscription}=<share left>`));
  }
  return steps;
}
