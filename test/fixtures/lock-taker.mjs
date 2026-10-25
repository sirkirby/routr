import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockIsStale, lockToken, takeLock } from "../../src/lib/runtime.mjs";

const [file, barrier] = process.argv.slice(2);
const wait = (name) => {
  const until = Date.now() + 15_000;
  while (!existsSync(join(barrier, name))) {
    if (Date.now() > until) throw new Error("lock test barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
writeFileSync(join(barrier, `ready-${process.pid}`), "ready"); wait("go");
const won = takeLock(file, lockIsStale), result = { won, token: lockToken(file) ?? null };
writeFileSync(join(barrier, `result-${process.pid}`), JSON.stringify(result));
wait("finish"); // Keep a winning pid alive until the other contender has tried.
console.log(JSON.stringify(result));
