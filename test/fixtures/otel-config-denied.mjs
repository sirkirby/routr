import { mock } from "bun:test";
import fs from "node:fs";
const [home, configPath] = process.argv.slice(2);
mock.module("node:fs", () => ({ ...fs, readFileSync: (file, ...args) => {
  if (file === configPath) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  return fs.readFileSync(file, ...args);
} }));
const { sendOtel } = await import("../../src/lib/otel.mjs");
await sendOtel({ home, configPath, env: {} });
