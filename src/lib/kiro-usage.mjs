// Kiro's usage: its own /usage command, kept and refreshed in the background (usage-readings.mjs); kiroReading, below,
// is what routr keeps.
import { tmpdir } from "node:os";
import { run } from "./processes.mjs";
import { monthMinutes } from "./usage.mjs";
import { usageFailure } from "./usage-failure.mjs";
import { HARNESSES } from "./harnesses.mjs";
const kiroPlan = (p) => ["KIRO FREE", "KIRO PRO", "KIRO PRO+", "KIRO POWER"].includes(p) ? p : null;

// Kiro: `kiro-cli chat --no-interactive /usage` answers without an agent turn (0 credits) with the plan's monthly
// credits: "Estimated Usage | resets on 2026-10-01 | KIRO FREE" / "Credits (0.00 of 50 covered in plan), 0.0%"
// (measured on a Free plan, 2026-09-26). Every model draws on those credits, so there is one pool. Other lines are
// counted, never copied: their text can contain account details or prompts.
export const KIRO_BY_HAND = HARNESSES.kiro.usage.byHand;
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
// A reset on a UTC month boundary makes the window that month, so the reserve tapers toward it as for Codex's cap.
// `at` is when it was read (seconds).
const number = (x) => Number.isFinite(x) ? x : null;
export const kiroReading = (raw, at) => {
  const plan = kiroPlan(raw.plan), extra = Number.isSafeInteger(raw.unrecognized_lines) && raw.unrecognized_lines > 0 ? raw.unrecognized_lines : 0;
  return { source: "kiro /usage", takenAt: at,
    windows: [{ name: "monthly_credits", usedPct: number(raw.used_pct), windowMin: monthMinutes(number(raw.resets_at)), resetsAt: number(raw.resets_at) }],
    note: `${plan ? `${plan}: ` : ""}${number(raw.credits_used)} of ${number(raw.credits_limit)} credits used${extra ? ` (${extra} additional lines not read)` : ""}` };
};
