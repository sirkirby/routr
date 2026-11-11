// One caller of a read that must not wait (board), in a process of its own: a test starts several at once against one
// store folder, released together by a `go` file, and counts the refreshes they start between them.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileStore, usageReadings } from "../../src/lib/usage-readings.mjs";

const [dir, starts, configPath] = process.argv.slice(2);
const wait = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < 2000 && !existsSync(join(dir, "go")); i++) Atomics.wait(wait, 0, 0, 5);
const readers = {
  claude: { source: "claude /usage", speed: "inline", read: async () => null },
  cursor: { source: "cursor /usage", speed: "background", check: async () => null, reading: () => null },
};
const readings = usageReadings({ configPath: configPath || null, store: fileStore(join(dir, "usage"), { legacy: null }), clock: { now: () => 1_800_000_000 },
  starter: { start: (argv) => { appendFileSync(starts, `${JSON.stringify(argv)}\n`); return true; } }, readers, signIn: { kept: () => null, why: () => "" } });
console.log(JSON.stringify(readings.kept(["claude", "cursor"]).refreshing));
