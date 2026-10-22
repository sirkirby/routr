// Live check of every usage reader on THIS machine: each one takes a fresh reading now, by its own live path (no kept
// snapshot, no fallback), so a reader that a harness or herdr update broke shows here before routing runs on assumed
// headroom for days (herdr 0.9.5, 2026-10-22: Cursor's read failed on every try for 89 h unnoticed). Run after updating
// a harness or herdr, and before a release that changes a reader (CONTRIBUTING.md):
//   bun run smoke:usage
// Reads only, writes nothing of routr's (each reader cleans up after itself), and reads only a subscription that is
// turned on and signed in (asking a signed-out harness can open its sign-in). Exits 1 when a reader could not read.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/lib/config.mjs";
import { HARNESSES, notReady } from "../src/lib/harnesses.mjs";
import { readAgy, readClaude, readCodexLive } from "../src/lib/usage.mjs";
import { cursorUsage } from "../src/lib/cursor-usage.mjs";
import { kiroUsage } from "../src/lib/kiro-usage.mjs";

const LIVE = {
  claude: () => readClaude({ quiet: HARNESSES.claude.quiet, file: join(tmpdir(), "routr-smoke-no-snapshot.json") }),
  codex: () => readCodexLive({ fallback: () => null }),
  cursor: () => cursorUsage(),
  kiro: () => kiroUsage(),
  agy: () => readAgy(),
};
const said = (r) => (r?.ok === false ? `FAILED (${r.code})` : r?.headroom != null ? `ok: ${Math.round(r.headroom * 100)}% left` : r?.class === "metered" ? "ok: metered" : `FAILED (${r?.failure?.code ?? "no reading"})`);
const { config } = loadConfig();
let failed = 0;
for (const name of Object.keys(LIVE)) {
  if (!config.subscriptions[name]) { console.log(`${name}: not set up, not read`); continue; }
  if (config.subscriptions[name].enabled === false) { console.log(`${name}: turned off, not read`); continue; }
  const why = await notReady(name);
  if (why) { console.log(`${name}: ${why}, not read`); continue; }
  const t = performance.now();
  let r; try { r = await LIVE[name](); } catch { r = { ok: false, code: "read_failed" }; }
  const line = said(r);
  if (line.startsWith("FAILED")) failed++;
  console.log(`${name}: ${line} (${HARNESSES[name].usage.source}, ${((performance.now() - t) / 1000).toFixed(1)} s)`);
}
process.exitCode = failed ? 1 : 0;
