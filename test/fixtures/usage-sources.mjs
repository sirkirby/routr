// CLI-only fake sources. Sign-in results are seeded by the test, and PATH contains no harness. Cursor is served from what
// routr keeps (the test writes its entry); Kiro is read in the call here, as a metered seat.
import { SOURCES } from "../../src/lib/harnesses.mjs";
import { summarize } from "../../src/lib/usage.mjs";
import { usageReadings } from "../../src/lib/usage-readings.mjs";
import { BRIEF_MARKER, KEY_MARKER } from "./provider-fetch.mjs";

const scenario = process.env.ROUTR_TEST_USAGE;
if (scenario) {
  SOURCES.codex.read = async () => { throw new Error(`${BRIEF_MARKER} ${KEY_MARKER}`); };
  SOURCES.kiro = { source: "kiro /usage", read: () => summarize({ pool: "kiro", source: "kiro /usage", cls: "metered", note: "metered: remaining budget is unknown" }) };
  SOURCES.agy.read = () => { throw new Error("a disabled source must not be read"); };
  if (scenario === "snapshot_failure") {
    // A named read of Cursor that fails with raw text in its answer: what is kept of the try is its code alone.
    SOURCES.cursor.check = async () => ({ ok: false, code: "invalid_response", error: `${BRIEF_MARKER} ${KEY_MARKER}`, why: KEY_MARKER });
    await usageReadings({ configPath: null }).readNow("cursor");
  }
}
