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
import { billingFor, HARNESSES, notReady, withBilling } from "../src/lib/harnesses.mjs";
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
// A reading as routing would take it: a seat its own sign-in says is billed per token (Claude with a key) is
// metered, as is one the user's `billing` says is; a reader's own report of something it could not clean up is
// a failure. A failed read is a failure whatever the billing: only a reading that worked is taken as metered.
const said = (r, billing) => (!r ? "FAILED (no reading)" : r.ok === false ? `FAILED (${r.code})` : r.failure ? `FAILED (${r.failure.code})`
  : r.ok === true && r.note ? `FAILED (cleanup: ${r.note})`
  : r.headroom != null ? `ok: ${Math.round(r.headroom * 100)}% left` : r.class === "metered" || billing === "metered" ? "ok: metered" : "FAILED (no reading)");
// The check itself, its seams given (the tests give fakes): one line per subscription, and how many could not read.
export async function smokeUsage({ config = loadConfig().config, live = LIVE, ready = notReady, billing = billingFor, log = console.log } = {}) {
  let failed = 0;
  for (const name of Object.keys(live)) {
    const s = config.subscriptions?.[name];
    if (!s) { log(`${name}: not set up, not read`); continue; }
    if (s.enabled === false) { log(`${name}: turned off, not read`); continue; }
    // Asked now, not the answer kept for hours: a harness signed out since must not be read.
    const why = await ready(name, { fresh: true });
    if (why) { log(`${name}: ${why}, not read`); continue; }
    const t = performance.now();
    let r; try { r = await live[name](); } catch { r = { ok: false, code: "read_failed" }; }
    if (r && r.ok === undefined) { const b = await billing(name, { fresh: r.headroom == null }); if (b.not) { log(`${name}: ${b.not}, not read`); continue; } r = withBilling(name, r, b.billing); }
    const line = said(r, s.billing);
    if (line.startsWith("FAILED")) failed++;
    log(`${name}: ${line} (${HARNESSES[name].usage.source}, ${((performance.now() - t) / 1000).toFixed(1)} s)`);
  }
  return failed;
}
if (import.meta.main) process.exitCode = (await smokeUsage()) ? 1 : 0;
