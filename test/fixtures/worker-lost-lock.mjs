import { mock } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const channel = await import("../../src/lib/channel.mjs");
const { FORMAT, reserve, WORKERS_DIR } = await import("../../src/lib/headless.mjs");
const { dir } = reserve("w1"), lock = join(WORKERS_DIR(), "w1.lock");
writeFileSync(join(dir, "worker.json"), JSON.stringify({ format: FORMAT, name: "w1", kind: "claude", cwd: dir }));
mock.module("../../src/lib/channel.mjs", () => ({ ...channel, probe: async () => {
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "replacement" }));
  return { state: "released" };
} }));
const { cleanupWorker } = await import("../../src/lib/workers.mjs");
let error = "";
try { await cleanupWorker("w1", {}, { steps: [], next: [], warnings: [], ran: [], unavailable: [] }); } catch (e) { error = e.message; }
console.log(JSON.stringify({ stopped: error.includes("lock"), kept: existsSync(dir), owner: JSON.parse(readFileSync(lock)).token }));
