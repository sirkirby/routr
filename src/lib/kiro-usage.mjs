// Kiro's usage: its own /usage command, kept as a snapshot refreshed in the background (snapshot.mjs).
import { tmpdir } from "node:os";
import { KIRO_SNAPSHOT, run } from "./runtime.mjs";
import { readSnapshot, refreshSnapshot } from "./snapshot.mjs";
import { monthMinutes } from "./usage.mjs";

// Kiro: `kiro-cli chat --no-interactive /usage` answers without an agent turn (0 credits) with the plan's monthly
// credits: "Estimated Usage | resets on 2026-10-01 | KIRO FREE" / "Credits (0.00 of 50 covered in plan), 0.0%"
// (measured on a Free plan, 2026-09-26). Every model draws on those credits, so there is one pool. Any other line
// (a paid plan's overage or bonus credits, not yet observed) is kept in the note, never guessed at.
export const KIRO_BY_HAND = "run `kiro-cli chat --no-interactive /usage`, read \"Credits (X of Y covered in plan)\", and pass --headroom kiro=<1 - X/Y>";
export function parseKiroUsage(text) {
  const t = String(text ?? "");
  const m = t.match(/Credits\s*\(\s*([\d.,]+)\s+of\s+([\d.,]+)\s+covered in plan\s*\)/i);
  if (!m) return null;
  const n = (s) => Number(s.replaceAll(",", "")), used = n(m[1]), limit = n(m[2]);
  if (!Number.isFinite(used) || !(limit > 0)) return null;
  const head = t.match(/^[^\n]*Estimated Usage[^\n]*$/im)?.[0] ?? "";
  const reset = head.match(/resets on (\d{4}-\d{2}-\d{2})/i)?.[1];
  const other = t.split("\n").map((l) => l.trim()).filter((l) => l && l !== head.trim() && !l.includes(m[0]) && !/^Manage your plan\b/i.test(l));
  return { plan: head.split("|").at(-1)?.trim() || null, credits_used: used, credits_limit: limit, used_pct: Math.round(used / limit * 1000) / 10,
    resets_at: reset ? Date.parse(`${reset}T00:00:00Z`) / 1000 : null, ...(other.length ? { other: other.join(" · ").slice(0, 160) } : {}) };
}
// Kiro keeps each /usage as an empty saved session, listed under the folder it ran in. So it runs in the system temp
// folder, never the user's project, and the session is removed with Kiro's own `--delete-session` (measured: ~8 s).
export async function kiroUsage({ exec = run, cwd = tmpdir() } = {}) {
  const out = await exec("kiro-cli", ["chat", "--output-format", "stream-json", "/usage"], { cwd, timeoutMs: 45000 });
  if (out == null) return { ok: false, error: "kiro-cli did not answer /usage in 45 s (not installed, not logged in, or hung)", read_yourself: KIRO_BY_HAND };
  let session = null, text = null;
  for (const line of out.split("\n")) {
    try { const o = JSON.parse(line); session ??= o.data?.sessionId ?? null; if (o.type === "runFinished") text = o.data?.finalText ?? null; } catch {}
  }
  // Kiro prints "Deleted" and exits 0 even for an id it never had (measured), so exit 0 is the best sign there is.
  const deleted = !session || (await exec("kiro-cli", ["chat", "--delete-session", session], { cwd, timeoutMs: 30000, status: true })) === 0;
  const cleanup = deleted ? {} : { note: `Kiro kept an empty session from this reading; remove it with: kiro-cli chat --delete-session ${session}` };
  const p = parseKiroUsage(text);
  if (!p) return { ok: false, error: "Kiro's /usage did not show \"Credits (X of Y covered in plan)\"", read_yourself: KIRO_BY_HAND, ...cleanup };
  return { ok: true, subscription: "kiro", ...p, headroom: Math.round((1 - p.used_pct / 100) * 1000) / 1000, ...cleanup };
}
export const refreshKiro = ({ read = kiroUsage, file = KIRO_SNAPSHOT, ...o } = {}) => refreshSnapshot({ read, file, ...o,
  keep: (r) => ({ plan: r.plan, credits_used: r.credits_used, credits_limit: r.credits_limit, used_pct: r.used_pct, resets_at: r.resets_at, ...(r.other ? { other: r.other } : {}) }) });
// A reset on a UTC month boundary makes the window that month, so the reserve tapers toward it as for Codex's cap.
export const readKiro = ({ file = KIRO_SNAPSHOT, ...o } = {}) => readSnapshot({ name: "kiro", source: "kiro /usage", byHand: KIRO_BY_HAND, file, ...o,
  windows: (r) => [{ name: "monthly_credits", usedPct: r.used_pct, windowMin: monthMinutes(r.resets_at), resetsAt: r.resets_at }],
  describe: (r) => `${r.plan ? `${r.plan}: ` : ""}${r.credits_used} of ${r.credits_limit} credits used${r.other ? ` (${r.other})` : ""}` });
