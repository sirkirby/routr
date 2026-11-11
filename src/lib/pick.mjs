// Level + live usage + user config → subscriptions ranked by usable headroom. Pure: no I/O.
// Usable is worked out PER WINDOW and the tightest window counts: what is left, minus the user's reserve. The reserve is
// what routr holds back from workers (for the orchestrator and whatever the user runs outside routr) during the REST of
// the window, so it shrinks as the reset approaches:
// unused capacity expires at the reset, and holding a full reserve on the last day only wastes it.
// A metered account may carry a budget window; without a reading, remaining capacity is unknown.
// The orchestrator chooses; it may know things this cannot (what is already running, what comes next).
import { LEVELS } from "./questions.mjs";
import { OFF } from "./wording.mjs";
import { SHARE_WINDOW_DAYS, shareView } from "./shares.mjs";

export const levelExcludedWhy = (level) => `the user does not give it ${level} work`;
// `launches` is recentLaunches' answer (shares.mjs), loaded by the caller so this stays pure; without it, no share.
export function rankSubscriptions(level, usage, c, launches = null) {
  const ranked = [], excluded = [];
  for (const [name, s] of Object.entries(c.subscriptions)) {
    if (s.enabled === false) { excluded.push({ subscription: name, why: OFF.reason(s.harness ?? name) }); continue; }
    // A harness that is not signed in cannot take the work; the reading says what to run.
    const signedOut = usage.find((p) => p.pool === name && p.signedIn === false);
    if (signedOut) { excluded.push({ subscription: name, why: signedOut.note }); continue; }
    if (LEVELS.indexOf(s.hardest_work) < LEVELS.indexOf(level)) { excluded.push({ subscription: name, why: levelExcludedWhy(level) }); continue; }
    const u = usage.find((p) => p.pool === name);
    const live = u?.headroom != null;
    // The class is the shape the harness reported (usage.mjs), or the user's `billing` when the harness cannot show it.
    // A number the caller read itself (`--headroom`) is a window and outranks both. With no windows, the user's
    // `billing` wins over what the harness's sign-in status said (an API-key Claude reads `metered`: usage-readings.mjs).
    const cls = live ? (u.given ? "included" : u.class ?? "included") : s.billing ?? u?.class ?? "unknown";
    const r2 = (x) => Math.round(x * 100) / 100, nowSec = (c.now ?? Date.now()) / 1000;
    const base = { subscription: name, class: cls, use: s.use ?? "normal", reserve: s.reserve, hardest_work: s.hardest_work, ...(s.default_model ? { your_default: s.default_model + (s.default_effort ? ` @ ${s.default_effort}` : "") } : {}) };
    if (!live) {
      ranked.push({ ...base, usable: null, headroom: null, usage: cls === "metered" ? "metered" : "unknown", age_sec: u?.ageSec ?? null, note: u?.note ?? "remaining capacity is unknown: no usage reading" });
      continue;
    }
    const headroom = u.headroom;
    // One line per window, so the numbers can be checked against the harness's own usage screen. A window whose length
    // is unknown, or whose reset is past, holds the full reserve (past caps: synthetic probes, not seen live).
    const windows = (u.windows ?? []).filter((w) => Number.isFinite(w.usedPct)).map((w) => {
      const ahead = w.resetsAt > nowSec && w.windowMin ? Math.min(1, Math.max(0, (w.resetsAt - nowSec) / (w.windowMin * 60))) : 1;
      const left = Math.max(0, 1 - w.usedPct / 100);
      return { window: w.name, used_pct: Math.round(w.usedPct), resets_in_h: w.resetsAt ? Math.round(Math.max(0, w.resetsAt - nowSec) / 360) / 10 : null, left: r2(left), reserve_now: r2(s.reserve * ahead), usable: r2(Math.max(0, left - s.reserve * ahead)) };
    });
    const usable = windows.length ? Math.min(...windows.map((w) => w.usable)) : r2(Math.max(0, headroom - s.reserve));
    ranked.push({ ...base, usable, headroom: r2(headroom), ...(windows.length ? { windows } : {}), usage: u.given ? "given" : "live", age_sec: u?.ageSec ?? null,
      // Carry what the harness showed beside the number (Cursor's pools).
      ...(u?.note ? { note: u.note } : {}) });
  }
  // Pools with room, most first; then pools without a number; then pools at their reserve.
  const key = (r) => (r.usable == null ? -0.5 : r.usable > 0 ? r.usable : -1);
  ranked.sort((x, y) => key(y) - key(x));
  // Capture capacity order before the ratio moves sharers: most_room prefers a normal account with a number,
  // even when a metered account takes a numeric account's earlier slot. Included rows keep their slots.
  const open = ranked.filter((r) => r.usable > 0), unknown = ranked.filter((r) => r.usable == null);
  const most = open.find((r) => r.use === "normal") ?? open[0];
  // The user's launch ratio orders eligible normal metered accounts among themselves, the account furthest below its
  // target first. It is never a headroom: a share of launches and a share of a usage window are different units.
  const view = shareView(ranked, launches, c.subscriptions), share = view?.unreadable ? null : view;
  if (share) {
    for (const r of ranked) if (share.view[r.subscription]) r.share = share.view[r.subscription];
    const slots = ranked.map((r, i) => (r.share ? i : -1)).filter((i) => i >= 0), byShare = share.order.map((n) => ranked.find((r) => r.subscription === n));
    slots.forEach((slot, i) => { ranked[slot] = byShare[i]; });
  }
  // Candidate lists express permission, not suitability or a ranking. The lead chooses model/effort fit first.
  const candidates = Object.fromEntries(["normal", "fallback"].map((use) => [use,
    [...open, ...unknown].filter((r) => r.use === use).map((r) => r.subscription).sort()]));
  const note = !ranked.length ? !Object.keys(c.subscriptions).length ? "no subscriptions are configured: routr setup has not been run"
    : `no eligible subscriptions for ${level} work${excluded.length ? `; ${excluded.map((e) => `${e.subscription}: ${e.why}`).join("; ")}` : ""}`
    : !open.length && !unknown.length ? `every subscription that takes ${level} work is at its reserve`
    : `${open.length ? `${most.subscription} has the most usable headroom among accounts with a number (normal first)` : "remaining capacity is unknown"}.${unknown.length && open.length ? " Remaining capacity is unknown for other accounts." : ""}${share ? ` ${shareNote(share)}` : view?.unreadable ? " Your share is not shown: routr's launch history could not be read." : ""}`;
  return { most_room: most?.subscription ?? null, ...(share ? { share_due: share.due } : {}), candidates, ranked, excluded, note };
}

// What the ratio says, in a line: who is due and why, or that the launches already match it. The launches counted are
// routr's own on these accounts, whatever class they read as when they were launched.
function shareNote({ due, view }) {
  const v = Object.values(view)[0], of = v.of, days = `the last ${SHARE_WINDOW_DAYS} days`;
  const weights = Object.entries(view).map(([n, x]) => `${n} ${x.weight}`).join(", ");
  if (!due) return `By your share (${weights}), the ${of} routr launches on these accounts in ${days} match it: none is due.`;
  const d = view[due];
  return `By your share (${weights}), ${due} is due: ${of ? `${d.launches} of the ${of} routr launches on these accounts in ${days}` : `no routr launches on these accounts in ${days}`}, target ${Math.round(d.target * 100)}%.`;
}
