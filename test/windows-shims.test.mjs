// On Windows, a harness CLI installed with npm is a .cmd shim. These start real .cmd files through runtime.mjs, so they
// run on Windows only (CI's windows-latest); the pure parts are tested everywhere in runtime.test.mjs.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probe, resolveCommand, run } from "../src/lib/runtime.mjs";
import { npmShim, scratch } from "./helpers.mjs";

const ECHO = "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n";
// Everything cmd treats specially, the C runtime's quote and backslash rules, and the JSON Claude Code's read passes.
const ARGS = ["plain", "with space", 'dq"inside', "100%", "%PATH%", "a&b", "a^b", "a|b", '{"disableAllHooks":true}', "trailing\\",
  'back\\"q', "", "!x!", "<y>", "(p)", "a & echo INJECTED", 'a"&echo INJECTED'];

// Measured before the fix (windows-latest, 2026-10-05, Bun 1.4.2): every one of these answered null.
test.skipIf(process.platform !== "win32")("Windows only: run and probe start a .cmd and an npm shim, by bare name and full path, and every argument arrives intact", async () => {
  const dir = scratch("shim"), saved = process.env.PATH;
  writeFileSync(join(dir, "echo.js"), ECHO);
  writeFileSync(join(dir, "fake.cmd"), `@"${process.execPath}" "%~dp0echo.js" %*\r\n`); // a plain wrapper that hands on %*
  mkdirSync(join(dir, "node_modules/fake2/bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules/fake2/bin/fake2.js"), "#!/usr/bin/env node\n" + ECHO);
  writeFileSync(join(dir, "fake2.cmd"), npmShim("node_modules\\fake2\\bin\\fake2.js"));
  writeFileSync(join(dir, "fake2"), "#!/bin/sh\n"); // npm's sh twin, which a bare name must not pick
  process.env.PATH = `${dir};${saved}`;
  try {
    expect(resolveCommand("node")).not.toBeNull(); // the npm shim needs node, as it would without routr
    for (const cmd of ["fake", "fake.cmd", join(dir, "fake.cmd"), "fake2", "FAKE2.CMD", join(dir, "fake2.cmd")]) {
      expect([cmd, await run(cmd, ARGS, { timeoutMs: 20000 })]).toEqual([cmd, JSON.stringify(ARGS)]);
      expect([cmd, await probe(cmd, ['{"a":1}', "x y"])]).toEqual([cmd, { out: JSON.stringify(['{"a":1}', "x y"]), code: 0 }]);
    }
    // The compiled binary starts them the same way.
    const entry = join(dir, "entry.mjs"), exe = join(dir, "entry.exe");
    writeFileSync(entry, `import { run } from ${JSON.stringify(join(import.meta.dir, "../src/lib/runtime.mjs"))};\n`
      + `console.log(JSON.stringify(await Promise.all(["fake", "fake2"].map((c) => run(c, ${JSON.stringify(ARGS)}, { timeoutMs: 20000 })))));\n`);
    expect(spawnSync(process.execPath, ["build", "--compile", entry, "--outfile", exe], { encoding: "utf8" }).status).toBe(0);
    const out = spawnSync(exe, [], { encoding: "utf8", env: process.env });
    expect(JSON.parse(out.stdout)).toEqual([JSON.stringify(ARGS), JSON.stringify(ARGS)]);
  } finally { process.env.PATH = saved; }
}, 180000);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
test.skipIf(process.platform !== "win32")("Windows only: a timeout stops the CLI a .cmd started, not just the cmd.exe above it", async () => {
  const dir = scratch("shim-kill"), saved = process.env.PATH, pidFile = join(dir, "pid");
  writeFileSync(join(dir, "hang.js"), "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
  writeFileSync(join(dir, "hang.cmd"), `@"${process.execPath}" "%~dp0hang.js" %*\r\n`);
  process.env.PATH = `${dir};${saved}`;
  try {
    expect(await run("hang", [pidFile], { timeoutMs: 4000 })).toBeNull();
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    const until = Date.now() + 10000;
    while (alive(pid) && Date.now() < until) await Bun.sleep(200);
    expect(alive(pid)).toBe(false);
  } finally { process.env.PATH = saved; }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows only: a relative PATH entry is found in the child's folder, not routr's", async () => {
  const dir = scratch("shim-cwd"), saved = process.env.PATH;
  mkdirSync(join(dir, "tools"));
  writeFileSync(join(dir, "echo.js"), ECHO);
  writeFileSync(join(dir, "tools", "rel.cmd"), `@"${process.execPath}" "%~dp0..\\echo.js" %*\r\n`);
  process.env.PATH = `tools;${saved}`;
  try {
    expect(await run("rel", ["a b"], { cwd: dir, timeoutMs: 20000 })).toBe(JSON.stringify(["a b"]));
    expect(await run("rel", ["a b"], { timeoutMs: 20000 })).toBeNull(); // routr's own folder has no tools\rel.cmd
  } finally { process.env.PATH = saved; }
}, 60000);
