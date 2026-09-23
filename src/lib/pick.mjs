// Level + live usage + user config → subscriptions ranked by usable headroom. Pure: no I/O.
// Usable is worked out PER WINDOW and the tightest window counts: what is left, minus the user's reserve. The reserve is
// what the user keeps for their own work during the REST of the window, so it shrinks as the reset approaches:
// unused capacity expires at the reset, and holding a full reserve on the last day only wastes it.
// A METERED pool (billed usage, no quota: an Enterprise seat) has no window, so it has no number. It gets a position
// instead: after every pool with a quota that still has room, because included usage expires and billed usage does not.
// `metered_rank: "with"` ranks it by the user's assumed_headroom like the rest. Neither names a price.
// The orchestrator chooses; it may know things this cannot (what is already running, what comes next).
import { LEVELS } from "./questions.mjs";

export function rankSubscriptions(level, usage, c) {
  const ranked = [], excluded = [];
  for (const [name, s] of Object.entries(c.subscriptions)) {
    if (LEVELS.indexOf(s.hardest_work) < LEVELS.indexOf(level)) { excluded.push({ subscription: name, reason: `the user does not give it ${level} work` }); continue; }
    const u = usage.find((p) => p.pool === name);
    const live = u?.headroom != null;
    // The class is the shape the harness reported (usage.mjs), or the user's `billing` when the harness cannot show it.
    // A number the caller read itself (`--headroom`) is a window and outranks both.
    const cls = u?.source === "given by caller" ? "included" : s.billing ?? u?.class ?? (live ? "included" : "unknown");
    const r2 = (x) => Math.round(x * 100) / 100, nowSec = (c.now ?? Date.now()) / 1000;
    const base = { subscription: name, class: cls, reserve: s.reserve, ...(s.default_model ? { your_default: s.default_model + (s.default_effort ? ` @ ${s.default_effort}` : "") } : {}) };
    if (cls === "metered") {
      const usable = s.metered_rank === "with" ? r2(s.assumed_headroom) : null;
      ranked.push({ ...base, usable, headroom: usable, usage: usable == null ? "metered" : "assumed", age_sec: u?.ageSec ?? null, note: u?.note ?? "metered: usage is billed, no quota reported" });
      continue;
    }
    // No local usage source (or no snapshot yet): use the user's assumption and say so, never "full".
    const headroom = live ? u.headroom : s.assumed_headroom;
    // One line per window, so the numbers can be checked against the harness's own usage screen. A window whose length
    // is unknown (a cap with an odd reset) holds the full reserve instead of tapering it.
    const windows = (live ? u.windows ?? [] : []).filter((w) => Number.isFinite(w.usedPct)).map((w) => {
      const ahead = w.resetsAt && w.windowMin ? Math.min(1, Math.max(0, (w.resetsAt - nowSec) / (w.windowMin * 60))) : 1;
      const left = Math.max(0, 1 - w.usedPct / 100);
      return { window: w.name, used_pct: Math.round(w.usedPct), resets_in_h: w.resetsAt ? Math.round(Math.max(0, w.resetsAt - nowSec) / 360) / 10 : null, left: r2(left), reserve_now: r2(s.reserve * ahead), usable: r2(Math.max(0, left - s.reserve * ahead)) };
    });
    const usable = windows.length ? Math.min(...windows.map((w) => w.usable)) : r2(Math.max(0, headroom - s.reserve));
    ranked.push({ ...base, usable, headroom: r2(headroom), ...(windows.length ? { windows } : {}), usage: live ? (u.source === "given by caller" ? "given" : "live") : "assumed", age_sec: live ? u.ageSec : null });
  }
  // Pools with room, most first; then metered pools without a number; then pools at their reserve.
  const key = (r) => (r.usable == null ? -0.5 : r.usable > 0 ? r.usable : -1);
  ranked.sort((x, y) => key(y) - key(x));
  const open = ranked.filter((r) => r.usable > 0), metered = ranked.filter((r) => r.usable == null);
  const first = open[0] ?? metered[0] ?? null;
  const note = !ranked.length ? `no configured subscription takes ${level} work`
    : !first ? `every subscription that takes ${level} work is at its reserve: hold the work or ask the user`
    : open.length ? `${open[0].subscription} has the most usable headroom`
    : ranked.length === metered.length ? `${first.subscription} is metered: every token there is billed`
    : `every subscription with a quota that takes ${level} work is at its reserve; ${first.subscription} is metered: every token there is billed`;
  return { most_room: first?.subscription ?? null, ranked, excluded, note };
}
