// Jev answers about a worker's report → a quick first read for the orchestrator, who is the judge. Pure: no I/O.
// It never accepts or rejects work: the orchestrator's own check (run it, read the diff) decides.
import { CHECKS } from "./questions.mjs";

export function readReport(a) {
  const kind = a.work_type?.choice;
  const flags = [], unclear = [], checks = {};
  for (const [k, c] of Object.entries(CHECKS)) {
    const p = a[k]?.noul;
    if (p == null) continue;
    if (c.onlyFor && !c.onlyFor.includes(kind)) continue; // an answer about a branch this work is not on is noise
    const reading = p >= 0.8 ? "yes" : p <= 0.2 ? "no" : "unclear";
    checks[k] = { reading, p: Math.round(p * 100) / 100 };
    if (reading === c.flag) flags.push(c.say);
    else if (reading === "unclear") unclear.push(k);
  }
  const claimed = a.verdict?.choice ?? "unstated";
  if (claimed !== "done") flags.push(`the report claims "${claimed}", not done`);
  const next = flags.length
    ? "Send it back to the SAME worker with these points (it has the context). If it comes back flagged again, or the flag is a symptom patch, relaunch one level up and attach this report."
    : "Nothing in the report argues against it. Now run your own check; that is what decides.";
  return { headline: flags.length ? `routr: ${flags.length} reason${flags.length > 1 ? "s" : ""} to send this back` : "routr: the report gives no reason to send this back", claimed, flags, unclear, checks, next };
}
