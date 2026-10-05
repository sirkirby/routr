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

test("versions compare by semver 2.0 precedence, pre-releases included", async () => {
  const { compareVersions, newer } = await import("../src/lib/update.mjs");
  // Each is newer than the one before it.
  const order = ["0.4.9", "0.5.0-alpha.1", "0.5.0-alpha.beta", "0.5.0-beta", "0.5.0-beta.1", "0.5.0-beta.2", "0.5.0-beta.10", "0.5.0-beta.10.1", "0.5.0-rc.1", "0.5.0", "0.5.1-beta.1", "0.5.1", "0.10.0"];
  for (let i = 1; i < order.length; i++) {
    expect([order[i], newer(order[i], order[i - 1])]).toEqual([order[i], true]);
    expect([order[i], newer(order[i - 1], order[i])]).toEqual([order[i], false]);
  }
  expect(compareVersions("v0.5.0-beta.2", "0.5.0-beta.2")).toBe(0);
  expect(compareVersions("0.5.0+build.7", "0.5.0")).toBe(0);              // build metadata does not count
  expect(newer("0.5.0-1", "0.5.0-alpha")).toBe(false);                   // numbers rank below words
  expect(newer("0.1.0", "0.0.0-dev")).toBe(true);                        // a source checkout sees every release as newer
});

// GitHub's release list, newest first as the API gives it, with a draft and an alpha ahead of everything.
const RELEASES = [
  { tag_name: "v0.7.0", draft: true, prerelease: false },
  { tag_name: "v0.6.0-alpha.1", draft: false, prerelease: true },
  { tag_name: "v0.6.0-beta.10", draft: false, prerelease: true },
  { tag_name: "v0.6.0-beta.2", draft: false, prerelease: true },
  { tag_name: "v0.5.1", draft: false, prerelease: false },
  { tag_name: "v0.5.1-rc.1", draft: false, prerelease: true },
  { tag_name: "v0.5.0", draft: false, prerelease: false },
];

test("each update channel picks its newest release: drafts never, alpha on no channel, stable only releases", async () => {
  const { pickRelease } = await import("../src/lib/update.mjs");
  expect(pickRelease(RELEASES, "beta")).toBe("0.6.0-beta.10");
  expect(pickRelease(RELEASES, "stable")).toBe("0.5.1");
  expect(pickRelease(RELEASES.slice(4), "beta")).toBe("0.5.1");          // a release overtakes its own rc on beta
  expect(pickRelease([...RELEASES, { tag_name: "v0.9.0", draft: false, prerelease: true }], "stable")).toBe("0.5.1"); // marked pre-release
  expect(pickRelease([{ tag_name: "v1.0.0", draft: true }], "beta")).toBeNull();
  expect(pickRelease(null, "beta")).toBeNull();
});

// A fake GitHub: the API answers with the release list, a download records its URL and serves a binary that checks out.
async function fakeGitHub(asked) {
  const { assetName } = await import("../src/lib/update.mjs");
  const bin = Buffer.from("NEW-BINARY"), sum = (await import("node:crypto")).createHash("sha256").update(bin).digest("hex");
  return async (u) => {
    asked.push(String(u));
    if (String(u).endsWith("/releases/latest")) return { ok: true, status: 200, json: async () => RELEASES.find((r) => r.tag_name === "v0.5.1") };
    if (String(u).includes("/releases?per_page=30")) return { ok: true, status: 200, json: async () => RELEASES };
    return { ok: true, status: 200, arrayBuffer: async () => (String(u).endsWith("SHA256SUMS") ? Buffer.from(`${sum}  ${assetName()}\n`) : bin) };
  };
}

test("an update downloads the exact tag it checked, on either channel", async () => {
  const { assetName, update } = await import("../src/lib/update.mjs");
  const run = async (channel, current) => {
    const asked = [], self = join(scratch("upd-tag"), "routr");
    writeFileSync(self, "OLD");
    const r = await update({ channel, current, self, base: undefined, fetchFn: await fakeGitHub(asked), spawn: () => ({ status: 0, stdout: "" }), isStandalone: () => true });
    return { r, asked: asked.filter((u) => !u.includes("api.github.com")) };
  };
  const beta = await run("beta", "0.5.1");
  expect(beta.r).toMatchObject({ ok: true, updated: true, latest: "0.6.0-beta.10", channel: "beta" });
  expect(beta.r.note).toContain("on the beta channel");
  expect(beta.asked).toEqual([`https://github.com/sirkirby/routr/releases/download/v0.6.0-beta.10/${assetName()}`, "https://github.com/sirkirby/routr/releases/download/v0.6.0-beta.10/SHA256SUMS"]);
  const stable = await run("stable", "0.5.0");
  expect(stable.r).toMatchObject({ ok: true, updated: true, latest: "0.5.1" });
  expect(stable.r.channel).toBeUndefined();
  expect(stable.asked.every((u) => u.startsWith("https://github.com/sirkirby/routr/releases/download/v0.5.1/"))).toBe(true);
});

test("on beta, the official release replaces its own last beta", async () => {
  const { update } = await import("../src/lib/update.mjs");
  const asked = [], self = join(scratch("upd-release"), "routr");
  writeFileSync(self, "BETA");
  const list = [{ tag_name: "v1.1.0", draft: false, prerelease: false }, { tag_name: "v1.1.0-beta.10", draft: false, prerelease: true }];
  const github = await fakeGitHub(asked);
  const fetchFn = async (u) => (String(u).includes("/releases?per_page=30") ? { ok: true, status: 200, json: async () => list } : github(u));
  const r = await update({ channel: "beta", current: "1.1.0-beta.10", self, base: undefined, fetchFn, spawn: () => ({ status: 0, stdout: "1.1.0\n" }), isStandalone: () => true });
  expect(r).toMatchObject({ ok: true, updated: true, latest: "1.1.0", now: "1.1.0", channel: "beta" });
  expect(asked.filter((u) => !u.includes("api.github.com")).every((u) => u.includes("/releases/download/v1.1.0/"))).toBe(true);
});

test("going back to stable on a pre-release never downgrades by itself, and --force installs the newest stable", async () => {
  const { update } = await import("../src/lib/update.mjs");
  const self = join(scratch("upd-down"), "routr");
  writeFileSync(self, "BETA");
  const opts = async (asked) => ({ channel: "stable", current: "0.6.0-beta.2", self, base: undefined, fetchFn: await fakeGitHub(asked), spawn: () => ({ status: 0, stdout: "0.5.1\n" }), isStandalone: () => true });
  const asked = [];
  const kept = await update(await opts(asked));
  expect(kept).toMatchObject({ ok: true, updated: false, latest: "0.5.1" });
  expect(kept.note).toBe("routr 0.6.0-beta.2 is a pre-release and the stable channel's newest is 0.5.1: you stay on 0.6.0-beta.2 until a stable release is newer. `routr update --force` installs 0.5.1 now");
  expect(asked.every((u) => u.includes("api.github.com"))).toBe(true);  // nothing downloaded
  expect(readFileSync(self, "utf8")).toBe("BETA");
  const forced = await update({ ...(await opts([])), force: true });
  expect(forced).toMatchObject({ ok: true, updated: true, now: "0.5.1" });
  expect(readFileSync(self, "utf8")).toBe("NEW-BINARY");
  // On beta, the same machine is simply up to date until a newer beta or release.
  expect((await update({ ...(await opts([])), channel: "beta", current: "0.6.0-beta.10" })).note).toBe("routr is up to date on the beta channel");
});

test("update_channel defaults to stable, and an unknown value is reported and read as stable", () => {
  const dir = scratch("channel");
  const at = (v) => { const f = join(dir, `${JSON.stringify(v)}.json`); writeFileSync(f, JSON.stringify(v === undefined ? {} : { update_channel: v })); return loadConfig(f); };
  expect(at(undefined).config.update_channel).toBe("stable");
  expect(at(undefined).notes).toEqual([]);
  expect(at("beta").config.update_channel).toBe("beta");
  const bad = at("nightly");
  expect(bad.config.update_channel).toBe("stable");
  expect(bad.notes).toEqual(['update_channel: "nightly" is not one of stable, beta, using stable: routr setup --channel stable|beta']);
  expect(loadConfig("/nonexistent/config.json").config.update_channel).toBe("stable");
});
