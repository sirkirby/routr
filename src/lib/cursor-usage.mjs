// Cursor has no local usage file: it shows usage only in its own /usage screen. This opens that screen in a throwaway
// terminal (terminal.mjs) and reads Included N% used. routr keeps the reading (refreshCursor, below).
// The footer context meter (e.g. "Grok 4.6 High · 8.7%") is not usage and must never be parsed as it.
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { cmdTypable, SHELLS } from "./herdr.mjs";
import { CURSOR_SNAPSHOT, home } from "./runtime.mjs";
import { readSnapshot, refreshSnapshot } from "./snapshot.mjs";
import { screenUsage, screenUsageError } from "./screen-usage.mjs";
import { HARNESSES } from "./harnesses.mjs";
import { USAGE_BY_HAND } from "./usage-failure.mjs";

const cursorPlan = (p) => ["Free", "Pro", "Pro+", "Ultra", "Team", "Business", "Enterprise"].includes(p) ? p : null;

const PCT = String.raw`(\d+(?:\.\d+)?)%\s+used\b`;

export function parseCursorUsage(text) {
  if (text == null) return null;
  const t = stripVTControlCharacters(String(text)).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!t.trim()) return null;
  // Category rows say "N% used". The footer meter is "High · 8.7%" with no "used".
  const included = t.match(new RegExp(String.raw`^\s*Included\s+${PCT}`, "m"));
  if (!included) return null;
  const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
  const auto = t.match(new RegExp(String.raw`^\s*Auto\s+${PCT}`, "m"));
  const api = t.match(new RegExp(String.raw`^\s*API\s+${PCT}`, "m"));
  const plan = t.match(/Usage\s*[•·]\s*(\S+)/)?.[1] ?? null;
  return {
    plan: cursorPlan(plan),
    included_used_pct: num(included[1]),
    auto_used_pct: auto ? num(auto[1]) : null,
    api_used_pct: api ? num(api[1]) : null,
  };
}

const cursorUiReady = (text) => {
  const t = stripVTControlCharacters(String(text ?? ""));
  // Welcome screen says "Cursor Agent"; a later footer meter is "Grok 4.6 High · 8.7%".
  return /\bCursor Agent\b/.test(t) || /·\s*\d+(?:\.\d+)?%\s*$/m.test(t);
};

// What to do when routr cannot open the screen itself: said with every failed read.
export const CURSOR_BY_HAND = USAGE_BY_HAND.cursor;

// Cursor writes to its config folder as it runs (seen 2026-09-25: it rewrote cli-config.json and added a project
// folder for the working directory), so it runs on a private copy, as `launch` does, removed when the read ends.
export function cursorUsage({ tmp = tmpdir(), cursorConfig = join(home(), ".cursor", "cli-config.json"), ...options } = {}) {
  let dir;
  return screenUsage({
    label: HARNESSES.cursor.label, byHand: CURSOR_BY_HAND,
    prepare: () => ({ cwd: tmp }),
    start: async ({ t, shell }) => {
      dir = join(tmp, `routr-cursor-${randomBytes(4).toString("hex")}`);
      if (shell === "cmd" && !cmdTypable(dir)) throw screenUsageError("cmd_path");
      mkdirSync(dir, { mode: 0o700 });
      copyFileSync(cursorConfig, join(dir, "cli-config.json")); chmodSync(join(dir, "cli-config.json"), 0o600);
      if (SHELLS[shell].cursor) await t.call(["pane", "run", t.pane, SHELLS[shell].cursor(dir, "cursor-agent", ["--trust"])]);
      else { await t.call(["pane", "run", t.pane, SHELLS[shell].cursorEnv(dir)]); await t.call(["pane", "run", t.pane, "cursor-agent --trust"]); }
    },
    screen: (text) => cursorUiReady(text) ? "ready" : "unknown",
    shellExitMs: 3000, extraEnterMs: 6000,
    parse: parseCursorUsage,
    result: (parsed) => ({ subscription: "cursor", ...parsed, headroom: Math.round((1 - parsed.included_used_pct / 100) * 100) / 100 }),
    close: () => { if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  }, options);
}

// Cursor: only Included counts: it is the whole plan, and Cursor's own models (Composer, Grok) draw on it through Auto.
// API is other vendors' models inside Cursor, which routr does not route to, so it is shown in the note and never ranked.
const pct = (x) => (x == null ? "?" : `${x}%`);
const number = (x) => Number.isFinite(x) ? x : null;
const keepCursor = (r) => ({ plan: cursorPlan(r.plan), included_used_pct: number(r.included_used_pct), auto_used_pct: number(r.auto_used_pct), api_used_pct: number(r.api_used_pct) });
export const refreshCursor = ({ read = cursorUsage, file = CURSOR_SNAPSHOT(), ...o } = {}) => refreshSnapshot({ read, file, ...o,
  keep: keepCursor });
export const readCursor = ({ file = CURSOR_SNAPSHOT(), ...o } = {}) => readSnapshot({ name: "cursor", label: HARNESSES.cursor.label, source: "cursor /usage", byHand: CURSOR_BY_HAND, file, ...o,
  keep: keepCursor,
  windows: (r) => [{ name: "included", usedPct: r.included_used_pct, windowMin: null, resetsAt: null }],
  describe: (r) => `Included ${pct(r.included_used_pct)} used (Auto ${pct(r.auto_used_pct)}, API ${pct(r.api_used_pct)})` });
