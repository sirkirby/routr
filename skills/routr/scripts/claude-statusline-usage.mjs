#!/usr/bin/env bun
// Claude Code statusline: shows model + subscription usage, and records the usage snapshot
// for routr routing (~/.cache/routr/claude-usage.json). Same behaviour as the .sh, with no
// dependency on sh, jq, or other Unix tools. Installed 2026-09-20.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

try { run(); } catch {}

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
