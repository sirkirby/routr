// MEASUREMENT (temporary): what Bun's child_process does with .cmd files on Windows. Prints, asserts nothing.
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { probe, run } from "../src/lib/runtime.mjs";

const ECHO = "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n";
// cmd-shim 9.0.2 (npm 11's bin-links) output for a bin whose first line is `#!/usr/bin/env node`, byte for byte.
const npmShim = (target) => "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n"
  + 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\n'
  + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

const ARGS = ["plain", "with space", 'dq"inside', "100%", "%PATH%", "a&b", "a^b", "a|b", '{"disableAllHooks":true}', "trailing\\", 'back\\"q', "", "!x!", "<y>", "(p)", "a & echo INJECTED"];

test.skipIf(process.platform !== "win32")("MEASURE (Windows only): how Bun starts .cmd files and npm shims", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routr-shim-"));
  writeFileSync(join(dir, "echo.js"), ECHO);
  writeFileSync(join(dir, "fake.cmd"), `@"${process.execPath}" "%~dp0echo.js" %*\r\n`);
  mkdirSync(join(dir, "node_modules/fake2/bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules/fake2/bin/fake2.js"), "#!/usr/bin/env node\n" + ECHO);
  writeFileSync(join(dir, "fake2.cmd"), npmShim("node_modules\\fake2\\bin\\fake2.js"));
  writeFileSync(join(dir, "fake2"), "#!/bin/sh\nexec node \"$basedir/node_modules/fake2/bin/fake2.js\" \"$@\"\n");
  const savedPath = process.env.PATH;
  const result = { bun: Bun.version, node: spawnSync("node", ["--version"], { encoding: "utf8" }).stdout?.trim(), pathext: process.env.PATHEXT, cases: [] };
  process.env.PATH = dir + delimiter + savedPath;
  try {
    for (const cmd of ["fake", "fake.cmd", join(dir, "fake.cmd"), "fake2", "fake2.cmd", join(dir, "fake2.cmd")]) {
      const raw = spawnSync(cmd, ARGS, { encoding: "utf8", windowsHide: true, timeout: 15000 });
      const viaRun = await run(cmd, ARGS, { timeoutMs: 15000 });
      const viaProbe = await probe(cmd, ["one arg", '{"a":1}']);
      const verbatim = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmd} ^"x y^""`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 15000 });
      result.cases.push({ cmd: cmd.replace(dir, "<dir>"), raw: { error: raw.error?.code ?? raw.error?.message ?? null, status: raw.status, stdout: raw.stdout, stderr: raw.stderr?.slice(0, 300) },
        run: viaRun, roundTrip: viaRun === JSON.stringify(ARGS), probe: viaProbe, verbatim: { status: verbatim.status, stdout: verbatim.stdout, stderr: verbatim.stderr?.slice(0, 200) } });
    }
    // The compiled binary: the same calls from a `bun build --compile` executable.
    const entry = join(dir, "measure.mjs");
    writeFileSync(entry, `import { run } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/lib/runtime.mjs")).href)};\n`
      + `const out = {}; for (const c of ["fake", "fake.cmd", "fake2", "fake2.cmd"]) out[c] = await run(c, ${JSON.stringify(ARGS)}, { timeoutMs: 15000 });\nconsole.log(JSON.stringify(out));\n`);
    const build = spawnSync(process.execPath, ["build", "--compile", entry, "--outfile", join(dir, "measure.exe")], { encoding: "utf8", timeout: 120000 });
    const compiled = spawnSync(join(dir, "measure.exe"), [], { encoding: "utf8", timeout: 120000 });
    result.compiled = { build: build.status, buildErr: build.stderr?.slice(0, 300), status: compiled.status, stdout: compiled.stdout, stderr: compiled.stderr?.slice(0, 300) };
  } finally { process.env.PATH = savedPath; }
  console.log("ROUTR-MEASURE " + JSON.stringify(result, null, 1));
}, 240000);
