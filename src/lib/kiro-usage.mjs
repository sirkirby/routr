// Kiro's usage: its own /usage command, kept as a snapshot refreshed in the background (snapshot.mjs).
import { tmpdir } from "node:os";
import { KIRO_SNAPSHOT, run } from "./runtime.mjs";
import { readSnapshot, refreshSnapshot } from "./snapshot.mjs";
import { monthMinutes } from "./usage.mjs";
import { USAGE_BY_HAND, usageFailure } from "./usage-failure.mjs";
const kiroPlan = (p) => ["KIRO FREE", "KIRO PRO", "KIRO PRO+", "KIRO POWER"].includes(p) ? p : null;

// Kiro: `kiro-cli chat --no-interactive /usage` answers without an agent turn (0 credits) with the plan's monthly
// credits: "Estimated Usage | resets on 2026-10-01 | KIRO FREE" / "Credits (0.00 of 50 covered in plan), 0.0%"
// (measured on a Free plan, 2026-09-26). Every model draws on those credits, so there is one pool. Other lines are
// counted, never copied: their text can contain account details or prompts.
export const KIRO_BY_HAND = USAGE_BY_HAND.kiro;
export function parseKiroUsage(text) {
  const t = String(text ?? "");
  const m = t.match(/Credits\s*\(\s*([\d.,]+)\s+of\s+([\d.,]+)\s+covered in plan\s*\)/i);
  if (!m) return null;
  const n = (s) => Number(s.replaceAll(",", "")), used = n(m[1]), limit = n(m[2]);
  if (!Number.isFinite(used) || !(limit > 0)) return null;
  const head = t.match(/^[^\n]*Estimated Usage[^\n]*$/im)?.[0] ?? "";
  const reset = head.match(/resets on (\d{4}-\d{2}-\d{2})/i)?.[1];
  const other = t.split("\n").map((l) => l.trim()).filter((l) => l && l !== head.trim() && !l.includes(m[0]) && !/^Manage your plan\b/i.test(l));
  return { plan: kiroPlan(head.split("|").at(-1)?.trim()), credits_used: used, credits_limit: limit, used_pct: Math.round(used / limit * 1000) / 10,
    resets_at: reset ? Date.parse(`${reset}T00:00:00Z`) / 1000 : null, ...(other.length ? { unrecognized_lines: other.length } : {}) };
}
// Kiro keeps each /usage as an empty saved session, listed under the folder it ran in. So it runs in the system temp
// folder, never the user's project, and the session is removed with Kiro's own `--delete-session` (measured: ~8 s).
export async function kiroUsage({ exec = run, cwd = tmpdir() } = {}) {
  try {
    const out = await exec("kiro-cli", ["chat", "--output-format", "stream-json", "/usage"], { cwd, timeoutMs: 45000 });
    if (out == null) return { ok: false, ...usageFailure("no_response"), read_yourself: KIRO_BY_HAND };
    let session = null, text = null;
    for (const line of out.split("\n")) {
      try { const o = JSON.parse(line); session ??= o.data?.sessionId ?? null; if (o.type === "runFinished") text = o.data?.finalText ?? null; } catch {}
    }
    // Kiro prints "Deleted" and exits 0 even for an id it never had (measured), so exit 0 is the best sign there is.
    const deleted = !session || (await exec("kiro-cli", ["chat", "--delete-session", session], { cwd, timeoutMs: 30000, status: true })) === 0;
    const cleanup = deleted ? {} : { note: "Kiro kept an empty usage session; inspect its saved sessions to remove it." };
    const p = parseKiroUsage(text);
    if (!p) return { ok: false, ...usageFailure("invalid_response"), read_yourself: KIRO_BY_HAND, ...cleanup };
    return { ok: true, subscription: "kiro", ...p, headroom: Math.round((1 - p.used_pct / 100) * 1000) / 1000, ...cleanup };
  } catch { return { ok: false, ...usageFailure("read_failed"), read_yourself: KIRO_BY_HAND }; }
}
const number = (x) => Number.isFinite(x) ? x : null;
const keepKiro = (r) => ({ plan: kiroPlan(r.plan), credits_used: number(r.credits_used), credits_limit: number(r.credits_limit), used_pct: number(r.used_pct), resets_at: number(r.resets_at),
  ...(Number.isSafeInteger(r.unrecognized_lines) && r.unrecognized_lines > 0 ? { unrecognized_lines: r.unrecognized_lines } : {}) });
export const refreshKiro = ({ read = kiroUsage, file = KIRO_SNAPSHOT, ...o } = {}) => refreshSnapshot({ read, file, ...o,
  keep: keepKiro });
// A reset on a UTC month boundary makes the window that month, so the reserve tapers toward it as for Codex's cap.
export const readKiro = ({ file = KIRO_SNAPSHOT, ...o } = {}) => readSnapshot({ name: "kiro", source: "kiro /usage", byHand: KIRO_BY_HAND, file, ...o,
  keep: keepKiro,
  windows: (r) => [{ name: "monthly_credits", usedPct: r.used_pct, windowMin: monthMinutes(r.resets_at), resetsAt: r.resets_at }],
  describe: (r) => `${kiroPlan(r.plan) ? `${kiroPlan(r.plan)}: ` : ""}${r.credits_used} of ${r.credits_limit} credits used${Number.isSafeInteger(r.unrecognized_lines) && r.unrecognized_lines > 0 ? ` (${r.unrecognized_lines} additional lines not read)` : ""}` });
