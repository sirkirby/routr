// Enterprise print /usage has no windows. Only that answered shape plus its sign-in classification enables this
// background interactive read. No prompt is sent: /usage is a local command (p46, 2.1.317, 2026-11-03).
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CLAUDE_PANEL_SNAPSHOT, STATE_DIR } from "./runtime.mjs";
import { cmdTypable, shellCommand } from "./herdr.mjs";
import { screenUsage, screenUsageError } from "./screen-usage.mjs";
import { parseClaudeReset } from "./usage.mjs";
import { readSnapshot, refreshSnapshot } from "./snapshot.mjs";
import { HARNESSES } from "./harnesses.mjs";

const clean = (s) => stripVTControlCharacters(String(s ?? "")).replaceAll("\r", "");
// Date only: the END of that day in its zone, never its beginning. The period length is unknown, so full reserve.
export const panelReset = (s, nowSec) => parseClaudeReset(s.replace(/\s*\(/, " at 11:59pm ("), nowSec);
export function parseClaudePanel(text, nowSec = Date.now() / 1000) {
  const t = clean(text), section = t.split(/\bUsage credits\s*\n/)[1];
  if (!section) return null;
  const m = section.match(/^\s*[^\n]*?(\d+(?:\.\d+)?)% used\s*\n\s*\$[\d,]+\.\d{2}\s*\/\s*\$[\d,]+\.\d{2} spent\s*·\s*Resets ([^\n]+)/m);
  if (m) return { used_pct: Math.min(100, +m[1]), resets_at: panelReset(m[2].trim(), nowSec) };
  // p46 no-limit read, 2.1.317, 2026-11-03: a spent-only line immediately under Usage credits.
  // Absence or another shape is unreadable, never evidence that the owner removed a limit.
  if (/^\s*\$[\d,]+\.\d{2} spent[ \t]*(?:\n|$)/.test(section)) return { used_pct: null, resets_at: null };
  return null;
}
export function claudePanelScreen(text) {
  const t = clean(text);
  // Answer this screen only, in the empty folder checked before launch. No other confirmation is accepted.
  if (/trust this folder|trust the files in this folder|trust this directory/i.test(t) && /Yes, I trust/.test(t) && /No, exit/.test(t)) return "trust";
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
    label: HARNESSES.claude.label, startFailure: "no_response", readyMs: 12000,
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
        return { cwd, verifyCwd: true, empty };
      } catch { throw screenUsageError("private_folder"); }
    },
    start: async ({ t, shell }) => {
      if (shell === "cmd" && !cmdTypable(cwd)) throw screenUsageError("cmd_path");
      await t.call(["pane", "run", t.pane, shellCommand(shell, "claude", quiet)]);
    },
    screen: claudePanelScreen,
    safe: { trust: { keys: ["down", "enter"], check: (state) => { if (!state.empty()) throw screenUsageError("private_folder"); } } },
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
