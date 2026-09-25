// Live smoke test for the telemetry data path, on THIS machine's real ledger. Reads only; sends nothing; writes nothing.
// Run before releasing any change to what telemetry sends (CONTRIBUTING.md), and after opting in on a dogfood install:
//   bun run smoke:telemetry
// It prints what `routr share` would not: every value that would arrive as "other" (data lost), the longest string in a
// sent row (the endpoint refuses over 80), how many rows are waiting, and whether telemetry is really on here.
import { LEDGER_PATH, read } from "../src/lib/ledger.mjs";
import { loadConfig } from "../src/lib/config.mjs";
import { pendingCount, telemetryRows, telemetryState, telemetryStatus } from "../src/lib/telemetry.mjs";

const entries = read(LEDGER_PATH), rows = telemetryRows(entries, "smoke");
const lost = {};
const valid = entries.filter((e) => e && e.advised && e.chose && e.outcome);
rows.forEach((r, i) => {
  const walk = (o, path, raw) => { for (const [k, v] of Object.entries(o ?? {})) {
    if (v === "other") (lost[path + k] ??= new Set()).add(String(raw?.[k] ?? "?").slice(0, 40));
    else if (v && typeof v === "object") walk(v, `${path}${k}.`, raw?.[k]);
  } };
  const e = valid[i];
  walk(r, "", { ...e, advised: e.advised, chose: e.chose, outcome: e.outcome, subagents: e.subagents });
});
let longest = 0;
for (const r of rows) JSON.stringify(r, (k, v) => { if (typeof v === "string") longest = Math.max(longest, v.length); return v; });
const st = telemetryStatus(loadConfig().config), state = telemetryState();
console.log(`${entries.length} ledger lines · ${rows.length} rows in sent form · longest string ${longest} (endpoint limit 80)`);
console.log(`telemetry ${st.on ? "on" : `off (${st.why_off})`} · opted in ${state.opted_in_at ?? "never"} · ${st.on ? pendingCount() : 0} waiting to be sent`);
if (Object.keys(lost).length) {
  console.log("\nvalues that would arrive as \"other\" (data lost; add real ones to test/fixtures/seen-values.json and the allowlist):");
  for (const [k, vs] of Object.entries(lost)) console.log(`  ${k}: ${[...vs].join(", ")}`);
  process.exitCode = 1;
} else console.log("no value would arrive as \"other\"");
if (longest > 80) { console.log("a row carries a string over 80 characters: the endpoint would refuse it"); process.exitCode = 1; }
