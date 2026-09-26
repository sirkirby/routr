// update.mjs: releases, the binary swap, and the daily check
import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/lib/config.mjs";
import { SCRATCH, scratch } from "./helpers.mjs";

test("update picks the right release asset and compares versions like semver", async () => {
  const { assetName, newer } = await import("../src/lib/update.mjs");
  expect(assetName("darwin", "arm64")).toBe("routr-darwin-arm64");
  expect(assetName("linux", "x64")).toBe("routr-linux-x64");
  expect(assetName("win32", "arm64")).toBe("routr-windows-x64.exe");
  expect(assetName("freebsd", "x64")).toBeNull();
  expect(newer("0.1.10", "0.1.9")).toBe(true);
  expect(newer("v0.2.0", "0.1.99")).toBe(true);
  expect(newer("0.1.6", "0.1.6")).toBe(false);
  expect(newer("0.1.6", "0.1.6-rc.1")).toBe(true);        // the release is newer than its own pre-release
  expect(newer("0.1.5", "0.1.6")).toBe(false);
});

test("the background update check is due at most once a day, and the config can turn it off", async () => {
  const { dueForCheck } = await import("../src/lib/update.mjs");
  const now = 1_800_000_000_000;
  expect(dueForCheck(NaN, now)).toBe(true);                               // never checked
  expect(dueForCheck(now - 2 * 3600 * 1000, now)).toBe(false);            // two hours ago
  expect(dueForCheck(now - 25 * 3600 * 1000, now)).toBe(true);
  const off = join(SCRATCH, "noupdate.json"); writeFileSync(off, JSON.stringify({ auto_update: false }));
  expect(loadConfig(off).config.auto_update).toBe(false);
  expect(loadConfig("/nonexistent/config.json").config.auto_update).toBe(true);
});

test("a failed binary swap puts the old binary back", async () => {
  const { swapBinary } = await import("../src/lib/update.mjs");
  const dir = scratch("swap"), self = join(dir, "routr");
  writeFileSync(self, "old");
  let calls = 0;
  const failSecond = (a, b) => { if (++calls === 2) throw new Error("locked"); (require("node:fs")).renameSync(a, b); };
  expect(() => swapBinary(self, Buffer.from("new"), { rename: failSecond })).toThrow("locked");
  expect(readFileSync(self, "utf8")).toBe("old");
  expect(existsSync(`${self}.new`)).toBe(false);
  swapBinary(self, Buffer.from("new"));
  expect(readFileSync(self, "utf8")).toBe("new");
});

test("an update lock is taken over only when its owner is gone", async () => {
  const { lockIsStale } = await import("../src/lib/update.mjs");
  const f = join(scratch("lock"), "update.lock");
  writeFileSync(f, String(process.pid));
  expect(lockIsStale(f)).toBe(false);                                    // we are alive
  expect(lockIsStale(f, { alive: () => false })).toBe(true);
  writeFileSync(f, "");                                                  // a lock from an older routr: no pid, fresh
  expect(lockIsStale(f)).toBe(false);
});

test("routr update reports a real swap as an update and reinstalls the skill (the 0.1.14 regression)", async () => {
  const { update } = await import("../src/lib/update.mjs");
  const dir = scratch("upd"), self = join(dir, "routr");
  writeFileSync(self, "OLD");
  const fresh = Buffer.from("NEW-BINARY");
  const sum = (await import("node:crypto")).createHash("sha256").update(fresh).digest("hex");
  const { assetName } = await import("../src/lib/update.mjs");
  const fetchFn = async (u) => ({ ok: true, status: 200, arrayBuffer: async () => (String(u).endsWith("SHA256SUMS") ? Buffer.from(`${sum}  ${assetName()}\n`) : fresh) });
  const calls = [];
  const spawn = (file, args) => { calls.push([file, args[0]]); return { status: 0, stdout: args[0] === "--version" ? "9.9.9\n" : "" }; };
  const r = await update({ base: "http://fake.invalid/r", self, fetchFn, spawn, isStandalone: () => true });
  expect(r).toMatchObject({ ok: true, updated: true, now: "9.9.9", skill_reinstalled: true });
  expect(readFileSync(self, "utf8")).toBe("NEW-BINARY");
  expect(calls).toEqual([[self, "--version"], [self, "skill install".split(" ")[0]]]);
  // A failure after the swap is still an update, and says so.
  writeFileSync(self, "OLD");
  const bad = await update({ base: "http://fake.invalid/r", self, fetchFn, spawn: () => { throw new Error("spawn broke"); }, isStandalone: () => true });
  expect(bad.updated).toBe(true); expect(bad.ok).toBe(false); expect(bad.note).toContain("updated to");
  expect(readFileSync(self, "utf8")).toBe("NEW-BINARY");
});
