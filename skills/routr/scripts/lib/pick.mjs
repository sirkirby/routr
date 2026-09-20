// Level + live usage + user config → subscriptions ranked by usable headroom. Pure: no I/O.
// Usable is worked out PER WINDOW and the tightest window counts: what is left, minus the user's reserve. The reserve is
// what the user keeps for their own work during the REST of the window, so it shrinks as the reset approaches:
// unused capacity expires at the reset, and holding a full reserve on the last day only wastes it.
// The orchestrator chooses; it may know things this cannot (what is already running, what comes next).
import { LEVELS } from "./questions.mjs";

export function rankSubscriptions(level, usage, c) {
  const ranked = [], excluded = [];
  for (const [name, s] of Object.entries(c.subscriptions)) {
    if (LEVELS.indexOf(s.hardest_work) < LEVELS.indexOf(level)) { excluded.push({ subscription: name, reason: `the user does not give it ${level} work` }); continue; }
    const u = usage.find((p) => p.pool === name);
    const live = u?.headroom != null;
    // No local usage source (or no snapshot yet): use the user's assumption and say so, never "full".
    const headroom = live ? u.headroom : s.assumed_headroom;
    const r2 = (x) => Math.round(x * 100) / 100, nowSec = (c.now ?? Date.now()) / 1000;
    // One line per window, so the numbers can be checked against the harness's own usage screen.
    const windows = (live ? u.windows ?? [] : []).filter((w) => Number.isFinite(w.usedPct)).map((w) => {
      const ahead = w.resetsAt && w.windowMin ? Math.min(1, Math.max(0, (w.resetsAt - nowSec) / (w.windowMin * 60))) : 1;
      const left = Math.max(0, 1 - w.usedPct / 100);
      return { window: w.name, used_pct: Math.round(w.usedPct), resets_in_h: w.resetsAt ? Math.round(Math.max(0, w.resetsAt - nowSec) / 360) / 10 : null, left: r2(left), reserve_now: r2(s.reserve * ahead), usable: r2(Math.max(0, left - s.reserve * ahead)) };
    });
    const usable = windows.length ? Math.min(...windows.map((w) => w.usable)) : r2(Math.max(0, headroom - s.reserve));
    ranked.push({ subscription: name, usable, headroom: r2(headroom), reserve: s.reserve, ...(windows.length ? { windows } : {}), usage: live ? (u.source === "given by caller" ? "given" : "live") : "assumed", age_sec: live ? u.ageSec : null, ...(s.default_model ? { your_default: s.default_model + (s.default_effort ? ` @ ${s.default_effort}` : "") } : {}) });
  }
  ranked.sort((x, y) => y.usable - x.usable);
  const open = ranked.filter((r) => r.usable > 0);
  const note = !ranked.length ? `no configured subscription takes ${level} work`
    : !open.length ? `every subscription that takes ${level} work is at its reserve: hold the work or ask the user`
    : `${open[0].subscription} has the most usable headroom`;
  return { most_room: open[0]?.subscription ?? null, ranked, excluded, note };
}
