// `routr statusline`: Claude Code's statusline command. Claude reports subscription usage ONLY to its statusline, so
// this prints the model and usage there and saves each snapshot to ~/.cache/routr/claude-usage.json, which the usage
// reader picks up. It must never fail or print an error: a broken statusline is visible in every Claude session.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CLAUDE_SNAPSHOT } from "./runtime.mjs";

export function statusline() { try { run(); } catch {} }

// Is this Claude Code statusline command routr's? One test for setup, doctor, and uninstall (three copies had drifted).
// `routr` must be the whole program name (`/x/routr statusline`, `"C:\...\routr.exe" statusline`), so `myroutr statusline`
// is someone else's. The second form is the script routr shipped before it had a statusline command of its own.
export const isOurStatusline = (command) => /(^|[\\/\s"'])routr(\.exe)?["']?\s+statusline\b|claude-statusline-usage/.test(String(command ?? ""));

// The snapshot the usage reader parses. `answered` says a model response has happened this session: the statusline
// docs state `prompt_cache` appears after the first API response and `context_window.current_usage` is null before
// the first API call (recorded in references/harnesses.md). The reader uses it only to word its note. `seen` keeps the
// last windows that did arrive, with their time, so a fresh session's first renders do not blank a good reading.
export function snapshotFrom(data, previous, ts) {
  const has = (rl) => rl != null && typeof rl === "object" && Object.values(rl).some((v) => v?.used_percentage != null);
  const answered = has(data.rate_limits) || data.prompt_cache != null || data.context_window?.current_usage != null;
  const seen = has(data.rate_limits) ? { ts, rate_limits: data.rate_limits }
    : previous?.seen ?? (has(previous?.rate_limits) ? { ts: previous.ts, rate_limits: previous.rate_limits } : null);
  return { ts, model: data.model?.id ?? null, rate_limits: data.rate_limits ?? null, answered, seen };
}

function run() {
  let raw;
  try { raw = readFileSync(0, "utf8"); } catch { return; }
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    if (data === null) process.stdout.write("\n");
    return;
  }

  // Every render is written, windows or not: a seat with no quota never sends `rate_limits`, and the usage reader must
  // be able to tell that from a statusline that was never installed.
  const out = CLAUDE_SNAPSHOT;
  let previous = null;
  try { previous = JSON.parse(readFileSync(out, "utf8")); } catch {}
  const snap = snapshotFrom(data, previous, Math.floor(Date.now() / 1000));
  try {
    mkdirSync(dirname(out), { recursive: true });
    const tmp = `${out}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(snap) + "\n");
    try { renameSync(tmp, out); }
    catch { try { unlinkSync(out); } catch {} renameSync(tmp, out); }
  } catch {}

  const parts = [];
  const name = data.model?.display_name;
  if (name != null) parts.push(String(name));
  const five = data.rate_limits?.five_hour?.used_percentage;
  if (five != null) parts.push(`5h ${Math.floor(five)}%`);
  const seven = data.rate_limits?.seven_day?.used_percentage;
  if (seven != null) parts.push(`7d ${Math.floor(seven)}%`);
  process.stdout.write(parts.join(" · ") + "\n");
}
