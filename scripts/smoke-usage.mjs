// Live, read-only check through the registry, with no cached reading or fallback. Run after reader/harness changes
// and before EVERY release on a signed-in machine (CONTRIBUTING.md). Conditional limit readers report their own
// exercised/not-exercised line; a primary read passing is not evidence that its limit reader works.
import { loadConfig } from "../src/lib/config.mjs";
import { billingFor, HARNESSES, SOURCES, notReady, withBilling } from "../src/lib/harnesses.mjs";

const said = (r, billing) => (!r ? "FAILED (no reading)" : r.ok === false ? `FAILED (${r.code})` : r.failure ? `FAILED (${r.failure.code})`
  : r.ok === true && r.note ? `FAILED (cleanup: ${r.note})`
  : r.headroom != null ? `ok: ${Math.round(r.headroom * 100)}% left` : r.class === "metered" || billing === "metered" ? "ok: metered" : "FAILED (no reading)");
// `live` may override registry reads in tests; limit recipes are separate, so each path's evidence is explicit.
export async function smokeUsage({ config = loadConfig().config, sources = SOURCES, live = Object.fromEntries(Object.entries(sources).map(([n, s]) => [n, s.live])),
  ready = notReady, billing = billingFor, log = console.log } = {}) {
  let failed = 0;
  for (const name of Object.keys(live)) {
    const src = sources[name], s = config.subscriptions?.[name];
    const skipped = (why) => { log(`${name}: ${why}, not read`); if (src?.limit) log(`${name} limit: NOT EXERCISED (${why})`); };
    if (!s) { skipped("not set up"); continue; }
    if (s.enabled === false) { skipped("turned off"); continue; }
    const why = await ready(name, { fresh: true });
    if (why) { skipped(why); continue; }
    const t = performance.now();
    let r; try { r = await live[name](); } catch { r = { ok: false, code: "read_failed" }; }
    let b = {};
    if (r && r.ok === undefined) {
      b = await billing(name, { fresh: r.headroom == null });
      if (b.not) { skipped(b.not); continue; }
    }
    const state = src?.limit?.state(r, b.status);
    const line = said(r?.ok === undefined ? withBilling(name, r, b.billing ?? (state === "read" ? src.limit.billing : null)) : r, s.billing);
    if (line.startsWith("FAILED")) failed++;
    log(`${name}: ${line} (${src?.source ?? HARNESSES[name]?.usage.source}, ${((performance.now() - t) / 1000).toFixed(1)} s)`);
    if (!src?.limit) continue;
    if (state !== "read") {
      if (state === "skip") {
        const reason = r?.windows?.length ? "this seat shows windows" : "this sign-in does not need a limit reader";
        log(`${name} limit: NOT EXERCISED (${reason})`);
      } else { log(`${name} limit: FAILED (limit_unverified)`); failed++; }
      continue;
    }
    const limitAt = performance.now();
    let limit; try { limit = await src.limit.live(); } catch { limit = { ok: false, code: "read_failed" }; }
    const found = limit?.ok === true ? `read: ${src.limit.describe(limit)}` : `FAILED (${limit?.code ?? "read_failed"})`;
    if (!limit?.ok) failed++;
    log(`${name} limit: ${found} (${((performance.now() - limitAt) / 1000).toFixed(1)} s)`);
  }
  return failed;
}
if (import.meta.main) {
  process.exitCode = (await smokeUsage()) ? 1 : 0;
  console.log("detached refreshes: NOT EXERCISED (this smoke reads foreground sources only)");
}
