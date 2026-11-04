// `share`: the user's ratio of launches between normal metered accounts with room.
// A cap with no room after reserve leaves the ratio; the weights split launches among those still eligible.
// Advice only: the lead still chooses model and effort fit first, and nothing here enforces the ratio.
// The launches it counts are routr's launch history (launch-history.mjs): every launch that took its task, or was left
// ready with no task. History that cannot be read leaves the advice as it is, without a share.
import { readHistory, HISTORY_DAYS } from "./launch-history.mjs";

export const SHARE_WINDOW_DAYS = HISTORY_DAYS;

// Launches per subscription over the window. `unreadable` when the history is there but cannot be read: the caller
// shows no share then, since a count it cannot see is not a count of zero.
export function recentLaunches(opts) {
  const h = readHistory(opts);
  if (h.unreadable) return { counts: {}, unreadable: true };
  const counts = {};
  for (const r of h.records) counts[r.subscription] = (counts[r.subscription] ?? 0) + 1;
  return { counts };
}

// The share view, pure. `ranked` is rankSubscriptions' list; `launches` is recentLaunches' answer. Active only among
// normal metered accounts with usable null or above 0, when at least two qualify and at least one
// has a `share`; one without counts as 1. A cap at its limit or reserve is out.
// Each sharer gets the same shape as a usage window: what share of these launches it took (used_pct) and how far it
// is below its target (left). The account furthest below its target is `due` (ties: the larger weight, then the
// name); none is due when every one is at or above its target. `{ unreadable: true }` when a share would apply but
// the history cannot be read.
export function shareView(ranked, launches, subscriptions) {
  const sharers = ranked.filter((r) => r.use === "normal" && r.class === "metered" && (r.usable == null || r.usable > 0));
  if (sharers.length < 2 || !sharers.some((r) => subscriptions[r.subscription]?.share != null) || !launches) return null;
  // A share would apply, but the history cannot be read: a count routr cannot see is not zero, so it shows none.
  if (launches.unreadable) return { unreadable: true };
  const weight = (r) => subscriptions[r.subscription]?.share ?? 1;
  const total = sharers.reduce((n, r) => n + weight(r), 0);
  const of = sharers.reduce((n, r) => n + (launches.counts[r.subscription] ?? 0), 0);
  const r2 = (x) => Math.round(x * 100) / 100;
  // How far below its target (0 at or above it, as `left`), compared in whole numbers: weight/total − n/of over the common denominator total·of
  // (with no launches, every account's used is 0, so the weight alone). Floating point would break exact ties.
  const below = (r) => { const n = launches.counts[r.subscription] ?? 0; return Math.max(0, of ? weight(r) * of - n * total : weight(r)); };
  const view = Object.fromEntries(sharers.map((r) => {
    const target = weight(r) / total, n = launches.counts[r.subscription] ?? 0, used = of ? n / of : 0;
    return [r.subscription, { weight: weight(r), target: r2(target), used_pct: Math.round(used * 100), left: r2(Math.max(0, target - used)), launches: n, of }];
  }));
  const by = Object.fromEntries(sharers.map((r) => [r.subscription, below(r)]));
  const order = sharers.map((r) => r.subscription).sort((a, b) => by[b] - by[a] || view[b].weight - view[a].weight || a.localeCompare(b));
  return { due: by[order[0]] > 0 ? order[0] : null, order, view };
}
