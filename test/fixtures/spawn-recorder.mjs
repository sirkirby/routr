// Preloaded into a routr CLI by a test: each detached start routr would make (the processes module's spawnSelf) is
// written to ROUTR_TEST_SPAWNS as one JSON line, and nothing is started. With ROUTR_TEST_CURSOR_PCT, Cursor's own read
// answers that share used at once, with no screen and no sign-in gate (the test seeds the sign-in answer).
import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../../src/lib/processes.mjs", import.meta.url));
const real = await import(path);
mock.module(path, () => ({ ...real, spawnSelf: (args) => { appendFileSync(process.env.ROUTR_TEST_SPAWNS, `${JSON.stringify(args)}\n`); return true; } }));
if (process.env.ROUTR_TEST_CURSOR_PCT) {
  const { SOURCES } = await import("../../src/lib/harnesses.mjs");
  const pct = Number(process.env.ROUTR_TEST_CURSOR_PCT);
  SOURCES.cursor.check = async () => ({ ok: true, subscription: "cursor", plan: "Pro", included_used_pct: pct, auto_used_pct: null, api_used_pct: null, headroom: 1 - pct / 100 });
}
