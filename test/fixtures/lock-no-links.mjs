import { mock } from "bun:test";
import fs from "node:fs";
let links = 0;
mock.module("node:fs", () => ({ ...fs, linkSync: () => { links++; throw Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" }); } }));
const { takeLock, lockOwned } = await import("../../src/lib/runtime.mjs");
const file = process.argv[2]; fs.writeFileSync(file, "999999999");
let a = false;
const b = takeLock(file, () => true, { rename: (from, to) => { a = takeLock(file, () => true); fs.renameSync(from, to); } });
console.log(JSON.stringify({ winners: [a, b].filter(Boolean).length, owned: lockOwned(file), links }));
