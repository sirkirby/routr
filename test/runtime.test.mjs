// runtime.mjs: every process routr starts, and the environment a harness read gets
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cmdArg, cmdLine, harnessEnv, npmShimScript, probe, resolveCommand, run, start, startOptions, startSync, windowsCommand } from "../src/lib/runtime.mjs";
import { npmShim } from "./helpers.mjs";

// The ordinary ways of reaching node's process API, or Bun's: a static import, require, or a literal dynamic import,
// with or without node:. A text scan, not a parser: a computed import or `Bun["spawn"]` would get past it, and a comment
// naming Bun.spawn trips it. It guards against the ordinary mistake; review covers the rest.
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
  const platform = "linux"; // off Windows the command is passed on as given
  expect(start("herdr", ["pane", "read"], { stdio: ["ignore", "pipe", "pipe"] }, { via, platform })).toBe("child");
  expect(startSync("routr", ["--version"], { encoding: "utf8" }, { via, platform })).toBe("child");
  expect(start("cmd", ["/c"], undefined, { via, platform })).toBe("child");
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

// Windows resolution and quoting, with PATH, PATHEXT and the files given, so they run on every OS. The same rules
// against real .cmd files: windows-shims.test.mjs (Windows CI).
const winFs = (files) => {
  const lower = new Map(Object.entries(files).map(([f, text]) => [f.toLowerCase(), text]));
  return { exists: (p) => lower.has(p.toLowerCase()), read: (p) => lower.get(p.toLowerCase()) ?? "" };
};
const WIN_ENV = { Path: 'C:\\first;"C:\\Program Files\\nodejs";;C:\\Users\\u\\AppData\\Roaming\\npm', PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
const NPM = "C:\\Users\\u\\AppData\\Roaming\\npm", NODE = "C:\\Program Files\\nodejs\\node.exe";

test("a command resolves as cmd would: PATH in order, PATHEXT in order and any case, an explicit extension or folder as given", () => {
  const { exists } = winFs({ [`${NPM}\\codex`]: "#!/bin/sh", [`${NPM}\\codex.ps1`]: "", [`${NPM}\\CODEX.CMD`]: "", [NODE]: "", "C:\\first\\tool.exe": "", [`${NPM}\\tool.cmd`]: "",
    [`${NPM}\\only.js`]: "", "D:\\x\\app.EXE": "", "D:/x/run.bat": "" });
  const r = (cmd, env = WIN_ENV) => resolveCommand(cmd, { env, exists });
  expect(r("codex")).toBe(`${NPM}\\codex.cmd`); // not npm's extensionless sh twin, nor its .ps1
  expect(r("Codex.cmd")).toBe(`${NPM}\\Codex.cmd`);
  expect(r("node")).toBe(NODE); // a quoted PATH entry
  expect(r("tool")).toBe("C:\\first\\tool.exe"); // the first folder wins over a later .cmd
  expect(r("only")).toBeNull(); // .JS is in PATHEXT, but cmd would hand it to Windows Script Host
  expect(r("D:\\x\\app")).toBe("D:\\x\\app.exe");
  expect(r("D:/x/run.bat")).toBe("D:/x/run.bat");
  expect(r("D:\\x\\missing")).toBeNull();
  expect(r("codex", { PATH: NPM })).toBe(`${NPM}\\codex.cmd`); // no PATHEXT: cmd's own default
  expect(r("codex", { PATH: NPM, PATHEXT: ".EXE" })).toBeNull();
});

test("npm's cmd shim is recognised in each form npm has written, and nothing else is", () => {
  const script = "node_modules\\@openai\\codex\\bin\\codex.js";
  expect(npmShimScript(npmShim(script))).toBe(script); // cmd-shim 9.0.2 (npm 11), as generated
  // cmd-shim 5 and 6: the PATHEXT line inside the ELSE, not on the run line.
  expect(npmShimScript(npmShim(script).replace(' SET "_prog=node"\r\n', ' SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n').replace("set PATHEXT=%PATHEXT:;.JS;=;% & ", ""))).toBe(script);
  // cmd-shim 4 (npm 7): the subroutine at the end, a plain run line.
  const v4 = '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n"%_prog%"  "%dp0%\\..\\x\\cli.js" %*\r\nENDLOCAL\r\nEXIT /b %errorlevel%\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n';
  expect(npmShimScript(v4)).toBe("..\\x\\cli.js");
  // A shebang with arguments or variables, another program, pnpm's shim, a hand-written file: cmd.exe runs those.
  expect(npmShimScript(npmShim(script).replace('"%_prog%"  "', '"%_prog%" --no-warnings "'))).toBeNull();
  expect(npmShimScript(npmShim(script).replace("CALL :find_dp0\r\n", "CALL :find_dp0\r\n@SET NODE_OPTIONS=--x\r\n"))).toBeNull();
  expect(npmShimScript(npmShim(script).replaceAll("node.exe", "bun.exe").replace('"_prog=node"', '"_prog=bun"'))).toBeNull();
  expect(npmShimScript('@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=C:\\x"\r\n)\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\x\\cli.js" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\..\\x\\cli.js" %*\r\n)\r\n')).toBeNull();
  expect(npmShimScript('@"C:\\bin\\bun.exe" "%~dp0x.js" %*\r\n')).toBeNull();
  expect(npmShimScript(npmShim(script) + "del /q C:\\x\r\n")).toBeNull();
});

test("an argument for cmd.exe is quoted for the C runtime, then every cmd metacharacter escaped twice; a line break is refused", () => {
  expect(cmdArg("plain")).toBe('^^^"plain^^^"');
  expect(cmdArg("")).toBe('^^^"^^^"');
  expect(cmdArg("a&b")).toBe('^^^"a^^^&b^^^"');
  expect(cmdArg('a"&b')).toBe('^^^"a\\^^^"^^^&b^^^"'); // the quote escaped for the C runtime AND for both cmd passes
  expect(cmdArg("100% %PATH%")).toBe('^^^"100^^^%^^^ ^^^%PATH^^^%^^^"');
  expect(cmdArg("trailing\\")).toBe('^^^"trailing\\\\^^^"'); // doubled, or it would escape the closing quote
  expect(cmdArg('back\\"q')).toBe('^^^"back\\\\\\^^^"q^^^"');
  expect(cmdArg('{"disableAllHooks":true}')).toBe('^^^"{\\^^^"disableAllHooks\\^^^":true}^^^"');
  expect(() => cmdArg("a\nb")).toThrow(/line break/);
  expect(cmdLine("C:\\Program Files (x86)\\t\\t.cmd", ["x"])).toBe('C:\\Program^ Files^ ^(x86^)\\t\\t.cmd ^^^"x^^^"');
});

test("on Windows an npm shim starts node on its script, any other .cmd goes through cmd.exe, an .exe starts as it is", () => {
  const shim = npmShim("node_modules\\@openai\\codex\\bin\\codex.js"), js = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const w = (cmd, args, files) => windowsCommand(cmd, args, { env: WIN_ENV, ...winFs(files) });
  const base = { [`${NPM}\\codex.cmd`]: shim, [NODE]: "" };
  expect(w("codex", ["login", "status"], { ...base, [js]: "" })).toEqual({ cmd: NODE, args: [js, "login", "status"] });
  // The shim's own node.exe first, as the shim would.
  expect(w("codex", ["x"], { ...base, [js]: "", [`${NPM}\\node.exe`]: "" })).toEqual({ cmd: `${NPM}\\node.exe`, args: [js, "x"] });
  // Its script missing, or a wrapper of some other shape: cmd.exe runs the file as written.
  const viaCmd = (file, args) => ({ cmd: WIN_ENV.ComSpec, args: ["/d", "/s", "/c", `"${cmdLine(file, args)}"`], verbatim: true });
  expect(w("codex", ["x"], base)).toEqual(viaCmd(`${NPM}\\codex.cmd`, ["x"]));
  expect(w("tool", ['{"a":1}'], { [`${NPM}\\tool.cmd`]: '@"C:\\bin\\tool.exe" %*' })).toEqual(viaCmd(`${NPM}\\tool.cmd`, ['{"a":1}']));
  expect(w("cmd", ["/c", "x"], { "C:\\first\\cmd.exe": "" })).toEqual({ cmd: "C:\\first\\cmd.exe", args: ["/c", "x"] });
  expect(w("herdr", ["pane"], {})).toEqual({ cmd: "herdr", args: ["pane"] }); // not found: as given, and it fails as before
  // node itself a .cmd (a version manager's): the same rule again, through cmd.exe.
  const nodeCmd = "C:\\first\\node.cmd";
  expect(w("codex", ["x"], { [`${NPM}\\codex.cmd`]: shim, [js]: "", [nodeCmd]: "@echo off" })).toEqual(viaCmd(nodeCmd, [js, "x"]));
});

test("start on Windows passes a command it cannot find on unchanged, console still hidden", () => {
  const seen = [];
  start("routr-no-such-command", ["a"], { stdio: "ignore" }, { via: (...a) => seen.push(a), platform: "win32" });
  expect(seen).toEqual([["routr-no-such-command", ["a"], { stdio: "ignore", windowsHide: true }]]);
});
