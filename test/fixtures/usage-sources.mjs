// CLI-only fake sources. Sign-in results are seeded by the test, and PATH contains no harness.
import { SOURCES } from "../../src/lib/harnesses.mjs";
import { summarize } from "../../src/lib/usage.mjs";
import { readCursor, refreshCursor } from "../../src/lib/cursor-usage.mjs";
import { BRIEF_MARKER, KEY_MARKER } from "./provider-fetch.mjs";

const scenario = process.env.ROUTR_TEST_USAGE;
if (scenario) {
  SOURCES.codex.read = async () => { throw new Error(`${BRIEF_MARKER} ${KEY_MARKER}`); };
  SOURCES.cursor.read = () => readCursor({ file: process.env.ROUTR_TEST_SNAPSHOT, background: false });
  SOURCES.kiro.read = () => summarize({ pool: "kiro", source: "kiro /usage", cls: "metered", note: "metered: remaining budget is unknown" });
  SOURCES.agy.read = () => { throw new Error("a disabled source must not be read"); };
  if (scenario === "snapshot_failure") {
    await refreshCursor({ file: process.env.ROUTR_TEST_SNAPSHOT, read: async () => ({ ok: false, code: "invalid_response", error: `${BRIEF_MARKER} ${KEY_MARKER}`, why: KEY_MARKER }) });
  }
}
