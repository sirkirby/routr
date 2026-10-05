// runtime.mjs: every process routr starts, and the environment a harness read gets
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { harnessEnv, probe, run, start, startOptions, startSync } from "../src/lib/runtime.mjs";

// Any way of reaching node's process API, or Bun's: a static import, require, or a dynamic import, with or without node:.
const STARTS_PROCESSES = /["'`](?:node:)?child_process["'`]|\bBun\.spawn(?:Sync)?\b/;

test("only runtime.mjs starts processes: no other file in src/ imports child_process or calls Bun.spawn", () => {
  const root = join(import.meta.dir, "../src");
  const files = readdirSync(root, { recursive: true }).map(String).filter((f) => /\.[cm]?[jt]s$/.test(f));
  expect(files.length).toBeGreaterThan(10);
  const offenders = files.filter((f) => relative("lib/runtime.mjs", f) !== "" && STARTS_PROCESSES.test(readFileSync(join(root, f), "utf8")));
  expect(offenders).toEqual([]);
  // The scan sees the one file that is allowed, so a pattern that matched nothing could not pass for a clean tree.
  expect(STARTS_PROCESSES.test(readFileSync(join(root, "lib/runtime.mjs"), "utf8"))).toBe(true);
  for (const s of ['import { spawn } from "node:child_process";', "require('child_process')", "await import(`node:child_process`)", "Bun.spawnSync(["]) expect(STARTS_PROCESSES.test(s)).toBe(true);
});

test("every start hides its console on Windows, whatever the caller passed, and keeps the caller's other options", () => {
  expect(startOptions()).toEqual({ windowsHide: true });
  expect(startOptions({ detached: true, stdio: "ignore", windowsHide: false })).toEqual({ detached: true, stdio: "ignore", windowsHide: true });
  const seen = [];
  const via = (...a) => { seen.push(a); return "child"; };
  expect(start("herdr", ["pane", "read"], { stdio: ["ignore", "pipe", "pipe"] }, { via })).toBe("child");
  expect(startSync("routr", ["--version"], { encoding: "utf8" }, { via })).toBe("child");
  expect(start("cmd", ["/c"], undefined, { via })).toBe("child");
  expect(seen).toEqual([
    ["herdr", ["pane", "read"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }],
    ["routr", ["--version"], { encoding: "utf8", windowsHide: true }],
    ["cmd", ["/c"], { windowsHide: true }],
  ]);
});

test("a harness read's environment drops herdr's pane variables and keeps everything else", () => {
  const env = { PATH: "/bin", HOME: "/h", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "p", herdr_other: "x", NOT_HERDR_ENV: "kept" };
  expect(harnessEnv(env)).toEqual({ PATH: "/bin", HOME: "/h", NOT_HERDR_ENV: "kept" });
  expect(env.HERDR_PANE_ID).toBe("p"); // the caller's copy is untouched
});

test("run and probe start their command without herdr's pane variables (a bun child prints what it got)", async () => {
  const names = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "ROUTR_TEST_MARK"], saved = names.map((k) => process.env[k]);
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w1:p1", ROUTR_TEST_MARK: "kept" });
  try {
    const keys = ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"];
    const viaRun = JSON.parse(await run(process.execPath, keys, { timeoutMs: 15000 }));
    const viaProbe = JSON.parse((await probe(process.execPath, keys)).out);
    for (const got of [viaRun, viaProbe]) {
      expect(got.filter((k) => /^HERDR_/i.test(k))).toEqual([]);
      expect(got).toContain("ROUTR_TEST_MARK");
      expect(got.some((k) => /^path$/i.test(k))).toBe(true); // Windows spells it Path
    }
  } finally {
    names.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
});
