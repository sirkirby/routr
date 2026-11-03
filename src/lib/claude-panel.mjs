// Enterprise print /usage has no windows. Only that answered shape plus its sign-in classification enables this
// background interactive read. No prompt is sent: /usage is a local command (p46, 2.1.317, 2026-11-03).
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CLAUDE_PANEL_SNAPSHOT, STATE_DIR } from "./runtime.mjs";
import { shellCommand } from "./herdr.mjs";
import { usageStateFile } from "./usage-command.mjs";
import { screenUsage, screenUsageError } from "./screen-usage.mjs";
import { parseClaudeReset } from "./usage.mjs";
import { readSnapshot, refreshSnapshot } from "./snapshot.mjs";
import { HARNESSES } from "./harnesses.mjs";

// p46 project-skill shadow probe, 2.1.317, 2026-11-03: two /usage rows vs one. Descriptions may change.
export function claudeUsageMenu(text) {
  const rows = clean(text).split("\n").map((l) => l.trim().match(/^(❯\s*)?\/?usage\s+\S.*$/)).filter(Boolean);
  return rows.length ? rows.length === 1 && Boolean(rows[0][1]) : null;
}
const clean = (s) => stripVTControlCharacters(String(s ?? "")).replaceAll("\r", "");
// Date only: the END of that day in its zone, never its beginning. The period length is unknown, so full reserve.
export const panelReset = (s, nowSec) => parseClaudeReset(s.replace(/\s*\(/, " at 11:59pm ("), nowSec);
const MONEY = String.raw`\$(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}`;
const SPENT = new RegExp(`^${MONEY} spent$`), RATIO = new RegExp(`^${MONEY} / ${MONEY} spent · Resets (.+)$`);
export function parseClaudePanel(text, nowSec = Date.now() / 1000) {
  const t = clean(text);
  if (claudePanelScreen(t) !== "panel") return null;
  const sections = [...t.matchAll(/^[ \t]*Usage credits[ \t]*\n([^]*?)^[ \t]*Esc to cancel[ \t]*$/gm)];
  if (sections.length !== 1) return null;
  const lines = sections[0][1].split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && SPENT.test(lines[0])) return { used_pct: null, resets_at: null };
  // Exactly one progress row, then one ratio/reset row. Do not swallow a digit/comma prefix (1,050% → 50%).
  if (lines.length !== 2) return null;
  const pct = lines[0].match(/^[█▏▎▍▌▋▊▉░▒▓ ]*?(\d+(?:\.\d+)?)% used$/);
  const ratio = lines[1].match(RATIO);
  if (!pct || !ratio) return null;
  return { used_pct: Math.min(100, +pct[1]), resets_at: panelReset(ratio[1], nowSec) };
}
export function claudePanelScreen(text) {
  const t = clean(text);
  // Answer this screen only, in the empty folder checked before launch. No other confirmation is accepted.
  if (/trust this folder|trust the files in this folder|trust this directory/i.test(t) && /Yes, I trust/.test(t) && /^[ \t]*❯[ \t]*No, exit[ \t]*$/m.test(t)) return "trust";
  if (/Settings\s+Status\s+Config\s+Usage\s+Stats/.test(t) && /Esc to cancel/.test(t)) return "panel";
  if (/❯/.test(t) && (/\? for shortcuts/.test(t) || (/Claude Code/.test(t) && /shift.*tab/i.test(t)))) return "ready";
  return "unknown";
}
// p46 source verification, 2.1.317, 2026-11-03, separate sandbox CLAUDE_CONFIG_DIR: two reads of the
// same new empty folder changed the project count 4 -> 5 -> 5. Config, history and caches changed on both;
// the first added one backup, the second none. Claude records project metrics/session ids even with no model turn.
// Leave those harness-owned files alone; one stable empty cwd avoids a new trust/config entry on every read.
export function claudePanelUsage({ quiet = HARNESSES.claude.quiet, cwd = join(STATE_DIR(), "claude-usage-empty"), nowSec = Date.now() / 1000, ...options } = {}) {
  return screenUsage({
    label: HARNESSES.claude.label, startFailure: "no_response", readyMs: 12000, shellExitMs: 3000,
    shadows: HARNESSES.claude.usage.shadows(), menu: { check: claudeUsageMenu, timeoutMs: 2000 },
    // A no-limit draw can precede a cap row. A 3 s unchanged result is a judgment, not a measurement.
    settle: { ms: 3000, when: (r) => r.used_pct == null },
    prepare: () => {
      try {
        mkdirSync(cwd, { recursive: true, mode: 0o700 });
        const st = lstatSync(cwd);
        if (st.isSymbolicLink() || !st.isDirectory() || readdirSync(cwd).length) throw new Error();
        const empty = () => {
          try { const at = lstatSync(cwd); return !at.isSymbolicLink() && at.dev === st.dev && at.ino === st.ino && readdirSync(cwd).length === 0; }
          catch { return false; }
        };
        cwd = realpathSync(cwd);
        return { cwd, verifyCwd: true, empty, rows: 200 };
      } catch { throw screenUsageError("private_folder"); }
    },
    start: async ({ t, shell }) => {
      const settingsAt = quiet.indexOf("--settings");
      const args = [...quiet];
      if (settingsAt >= 0) args[settingsAt + 1] = usageStateFile("json", quiet[settingsAt + 1]);
      await t.call(["pane", "run", t.pane, shellCommand(shell, "claude", args)]);
    },
    screen: claudePanelScreen,
    // Default-login source probe, 2.1.317, 2026-11-03: keys on the first draw were ignored. Waiting 750 ms
    // before the declared trust answer worked; the settle is a judgment, and still requires No, exit selected.
    safe: { trust: { settleMs: 750, keys: ["down", "enter"], check: (state) => { if (!state.empty()) throw screenUsageError("private_folder"); } } },
    parse: (text) => parseClaudePanel(text, nowSec),
  }, options);
}
const keep = (r) => ({ used_pct: Number.isFinite(r.used_pct) ? r.used_pct : null, resets_at: Number.isFinite(r.resets_at) ? r.resets_at : null });
export const refreshClaudePanel = ({ read = claudePanelUsage, file = CLAUDE_PANEL_SNAPSHOT(), ...o } = {}) => refreshSnapshot({ read, keep, file, ...o });
// One hour is a judgment, not a measurement: bursts can exhaust caps and owners can raise them within four hours.
// Keep Cursor's 24-hour trust rule. A kept cap rolls over only AFTER its conservative reset.
export const readClaudePanel = ({ file = CLAUDE_PANEL_SNAPSHOT(), ...o } = {}) => readSnapshot({ name: "claude", label: HARNESSES.claude.label, limitReader: true, source: "claude /usage", file, keep, refreshSec: 3600, ...o,
  emptyClass: "metered", classify: (r) => r.used_pct == null ? "metered" : "capped",
  windows: (r) => r.used_pct == null ? [] : [{ name: "spend_limit", usedPct: r.used_pct, windowMin: null, resetsAt: r.resets_at }],
  describe: (r) => r.used_pct == null ? "Claude's panel shows no spend limit: still metered" : "Claude's panel shows an admin spend limit" });
