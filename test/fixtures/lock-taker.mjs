import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockToken, takeLock } from "../../src/lib/runtime.mjs";

const [file, barrier] = process.argv.slice(2);
const won = takeLock(file, () => {
  writeFileSync(join(barrier, `ready-${process.pid}`), "ready");
  const until = Date.now() + 15_000;
  while (!existsSync(join(barrier, "go"))) {
    if (Date.now() > until) throw new Error("lock test barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  return true;
});
console.log(JSON.stringify({ won, token: lockToken(file) ?? null }));
