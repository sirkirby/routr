import { mock } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const channel = await import("../../src/lib/channel.mjs");
const { newRecord, recordStore } = await import("../../src/lib/worker-record.mjs");
const { reserve } = await import("../../src/lib/worker-start.mjs");
const store = recordStore(), { dir } = reserve("w1"), lock = join(store.dir, "w1.lock");
store.write(dir, newRecord({ name: "w1", kind: "claude", model: "m", cwd: dir }, { backend: "headless" }));
mock.module("../../src/lib/channel.mjs", () => ({ ...channel, probe: async () => {
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "replacement" }));
  return { state: "released" };
} }));
const { workers } = await import("../../src/lib/worker.mjs");
let error = "";
try { await workers().finish("w1", {}, { steps: [], next: [], warnings: [], ran: [], unavailable: [] }); } catch (e) { error = e.message; }
console.log(JSON.stringify({ stopped: error.includes("lock"), kept: existsSync(dir), owner: JSON.parse(readFileSync(lock)).token }));
