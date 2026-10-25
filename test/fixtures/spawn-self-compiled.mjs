import { writeFileSync } from "node:fs";
import { spawnSelf, standalone } from "../../src/lib/runtime.mjs";
if (process.argv[2] === "--self-child" && process.argv.length === 4) {
  writeFileSync(process.argv[3], JSON.stringify({ argv: process.argv.slice(2), executable: process.execPath })); process.exit(0);
}
if (process.argv.length !== 2) process.exit(93); // A wrong self invocation cannot recurse.
process.argv[1] = "foreign-script.mjs";
console.log(JSON.stringify({ standalone: standalone(), started: spawnSelf(["--self-child", process.env.ROUTR_SELF_RESULT]) }));
