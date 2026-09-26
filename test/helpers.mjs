// Shared by several test files: fixtures, fakes, and the scratch folder the preload (setup.mjs) made.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../src/lib/config.mjs";
export const SCRATCH = process.env.ROUTR_TEST_SCRATCH;
export const scratch = (name) => mkdtempSync(join(SCRATCH, `${name}-`));

export const cfg = (over = {}) => ({ ...DEFAULTS, subscriptions: {
  claude: { hardest_work: "strong", reserve: 0.25, assumed_headroom: 0.5 },
  codex: { hardest_work: "strong", reserve: 0.2, assumed_headroom: 0.5 },
  cursor: { hardest_work: "standard", reserve: 0.1, assumed_headroom: 0.5 },
}, ...over });

export const ans = (score, confidence, kind = "implement", blast = 0.1, kinds = { [kind]: 1 }) =>
  ({ level: { score, confidence, probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 } }, work_type: { choice: kind, confidence: 1, probabilities: kinds }, high_blast_radius: { noul: blast } });

export const live = (pool, headroom) => ({ pool, source: "t", ageSec: 5, windows: [{}], headroom });

export const NOW = 1_800_000_000_000, win = (usedPct, hoursLeft, windowMin = 10080) => ({ name: "seven_day", usedPct, windowMin, resetsAt: NOW / 1000 + hoursLeft * 3600 });

export const none = (pool) => ({ pool, source: "none", ageSec: null, windows: [], headroom: null });

export const fact = (a, over) => ({ ...a, ...Object.fromEntries(Object.entries(over).map(([k, p]) => [k, { noul: p }])) });

export const metered = (pool) => ({ pool, source: "app-server", ageSec: 1, windows: [], headroom: null, class: "metered", note: "metered: unlimited credits, usage is billed, no quota reported" });

export const herdrOK = (result = {}) => ({ ok: true, data: { result } });

export const herdrError = (code) => ({ ok: false, data: { error: { code, message: code } } });

export const shellInfo = (foreground_processes = [{ pid: 1, cwd: process.cwd() }]) => herdrOK({ process_info: { shell_pid: 1, foreground_processes } });

export const row = (over = {}) => ({ ts: "2026-09-21T10:11:12.000Z", id: "abc12345", asked_at: "2026-09-21T10:11:00.000Z", mode: "dispatch", question_set: "r4", brief_sha: "deadbeefcafe", brief_chars: 300,
  advised: { level: "standard", sure: true, between: null, work_type: "research", high_risk: false, fallback: false, facts: { approach_open: 0.9 } },
  headroom: { codex: { usable: 0.3, usage: "live" } }, chose: { subscription: "codex", model: "big-model", effort: "medium", level: "standard" },
  outcome: { verdict: "done", check: "pass", seconds: 60, attempts: 1, note: "private note about the client's billing bug" }, subagents: [{ subtask: "count files in the acme repo", advised: "basic", model: "small-model" }], ...over });

export const said = (asked, text) => asked.filter((q) => q.includes(text)).length;
