// `routr statusline`: Claude Code's statusline command. Claude reports subscription usage ONLY to its statusline, so
// this prints the model and usage there and saves each snapshot to ~/.cache/routr/claude-usage.json, which the usage
// reader picks up. It must never fail or print an error: a broken statusline is visible in every Claude session.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function statusline() { try { run(); } catch {} }

function run() {
  let raw;
  try { raw = readFileSync(0, "utf8"); } catch { return; }
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    if (data === null) process.stdout.write("\n");
    return;
  }

  if (data.rate_limits != null) {
    const out = join(homedir(), ".cache", "routr", "claude-usage.json");
    const snap = { ts: Math.floor(Date.now() / 1000), model: data.model?.id ?? null, rate_limits: data.rate_limits };
    try {
      mkdirSync(dirname(out), { recursive: true });
      const tmp = `${out}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(snap) + "\n");
      try { renameSync(tmp, out); }
      catch { try { unlinkSync(out); } catch {} renameSync(tmp, out); }
    } catch {}
  }

  const parts = [];
  const name = data.model?.display_name;
  if (name != null) parts.push(String(name));
  const five = data.rate_limits?.five_hour?.used_percentage;
  if (five != null) parts.push(`5h ${Math.floor(five)}%`);
  const seven = data.rate_limits?.seven_day?.used_percentage;
  if (seven != null) parts.push(`7d ${Math.floor(seven)}%`);
  process.stdout.write(parts.join(" · ") + "\n");
}
