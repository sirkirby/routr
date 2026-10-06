// runtime.mjs: every process routr starts, and the environment a harness read gets
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cmdArg, cmdLine, harnessEnv, npmShimScript, probe, resolveCommand, run, start, startOptions, startSync, stop, windowsCommand } from "../src/lib/runtime.mjs";
import { npmShim, scratch } from "./helpers.mjs";

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
    [`${NPM}\\only.js`]: "", "D:\\x\\app.EXE": "", "D:\\x\\run.bat": "" });
  const r = (cmd, env = WIN_ENV) => resolveCommand(cmd, { env, cwd: "C:\\work", exists });
  expect(r("codex")).toBe(`${NPM}\\codex.cmd`); // not npm's extensionless sh twin, nor its .ps1
  expect(r("Codex.cmd")).toBe(`${NPM}\\Codex.cmd`);
  expect(r("node")).toBe(NODE); // a quoted PATH entry
  expect(r("tool")).toBe("C:\\first\\tool.exe"); // the first folder wins over a later .cmd
  expect(r("only")).toBeNull(); // .JS is in PATHEXT, but cmd would hand it to Windows Script Host
  expect(r("D:\\x\\app")).toBe("D:\\x\\app.exe");
  expect(r("D:/x/run.bat")).toBe("D:\\x\\run.bat");
  expect(r("D:\\x\\missing")).toBeNull();
  expect(r("codex", { PATH: NPM })).toBe(`${NPM}\\codex.cmd`); // no PATHEXT: cmd's own default
  expect(r("codex", { PATH: NPM, PATHEXT: ".EXE" })).toBeNull();
});

test("a relative PATH entry or command is looked up in the child's folder, and the answer is always absolute", () => {
  // The same names exist under routr's folder (C:\routr) and the child's (C:\work): only the child's may be chosen.
  const { exists } = winFs({ "C:\\routr\\tools\\h.cmd": "", "C:\\work\\tools\\h.cmd": "", "C:\\routr\\bin\\x.exe": "", "C:\\work\\bin\\x.exe": "" });
  const r = (cmd, cwd) => resolveCommand(cmd, { env: { PATH: "tools;C:\\none" }, cwd, exists });
  expect(r("h", "C:\\work")).toBe("C:\\work\\tools\\h.cmd");
  expect(r("h", "C:\\routr")).toBe("C:\\routr\\tools\\h.cmd");
  expect(r(".\\bin\\x", "C:\\work")).toBe("C:\\work\\bin\\x.exe");
  expect(r("bin/x.exe", "C:\\work")).toBe("C:\\work\\bin\\x.exe");
  expect(r("h", "C:\\elsewhere")).toBeNull();
  // An npm shim found through a relative entry starts node on its script by absolute path.
  const files = winFs({ "C:\\work\\tools\\h.cmd": npmShim("node_modules\\h\\h.js"), "C:\\work\\tools\\node_modules\\h\\h.js": "", [NODE]: "" });
  expect(windowsCommand("h", ["a"], { env: { PATH: `tools;C:\\Program Files\\nodejs` }, cwd: "C:\\work", ...files }))
    .toEqual({ cmd: NODE, args: ["C:\\work\\tools\\node_modules\\h\\h.js", "a"] });
});

test("doctor finds a harness by the rule start() uses on Windows, so what it calls found is what routr can start", async () => {
  const { offPath, which } = await import("../src/lib/doctor.mjs");
  const { exists } = winFs({ [`${NPM}\\codex`]: "#!/bin/sh", [`${NPM}\\codex.cmd`]: "", [`${NPM}\\only.js`]: "", [`${NPM}\\vb.vbs`]: "", "C:\\work\\kiro-cli.exe": "",
    "C:\\first\\agy.exe": "", [`${NPM}\\agy.cmd`]: "", "C:\\Users\\u\\.local\\bin\\claude.exe": "", "C:\\Users\\u\\.local\\bin\\gem.js": "" });
  const w = (cmd, env = WIN_ENV) => which(cmd, { platform: "win32", env, cwd: "C:\\work", exists });
  for (const cmd of ["codex", "only", "vb", "kiro-cli", "agy"]) expect(w(cmd)).toBe(resolveCommand(cmd, { env: WIN_ENV, cwd: "C:\\work", exists }));
  expect(w("codex")).toBe(`${NPM}\\codex.cmd`); // never npm's extensionless sh twin
  expect(w("only")).toBeNull(); // .JS and .VBS are in PATHEXT, but start() would not run them, so they are not found
  expect(w("vb")).toBeNull();
  expect(w("kiro-cli")).toBeNull(); // the current folder is not searched first (or at all), as start() does not
  expect(w("agy")).toBe("C:\\first\\agy.exe"); // PATH in order
  expect(w("codex", { PATH: NPM, PATHEXT: ".EXE" })).toBeNull(); // PATHEXT decides, as for start()
  // Off PATH, in the usual install folders: the same rule.
  expect(offPath("claude", { platform: "win32", dirHome: "C:\\Users\\u", env: WIN_ENV, exists })).toBe("C:\\Users\\u\\.local\\bin\\claude.exe");
  expect(offPath("gem", { platform: "win32", dirHome: "C:\\Users\\u", env: WIN_ENV, exists })).toBeNull();
});

test.skipIf(process.platform === "win32")("off Windows, doctor's which is a plain PATH search, unchanged", async () => {
  const { offPath, which } = await import("../src/lib/doctor.mjs");
  const files = new Set(["/a/codex", "/b/codex", "/b/kiro-cli", "/h/.local/bin/agy", "/opt/homebrew/bin/herdr"]);
  const exists = (p) => files.has(p);
  const w = (cmd) => which(cmd, { platform: "darwin", env: { PATH: "/a::/b" }, exists });
  expect(w("codex")).toBe("/a/codex");
  expect(w("kiro-cli")).toBe("/b/kiro-cli");
  expect(w("agy")).toBeNull();
  expect(offPath("agy", { platform: "darwin", dirHome: "/h", exists })).toBe("/h/.local/bin/agy");
  expect(offPath("herdr", { platform: "linux", dirHome: "/h", exists })).toBe("/opt/homebrew/bin/herdr");
});

test("npm's cmd shim is recognised in each form npm has written, and nothing else is", () => {
  const script = "node_modules\\@openai\\codex\\bin\\codex.js";
  expect(npmShimScript(npmShim(script))).toBe(script); // cmd-shim 9.0.2 (npm 11), as generated
  // cmd-shim 7.0.0 and 8.0.0: the PATHEXT line inside the ELSE, not on the run line.
  const v8 = npmShim(script).replace(' SET "_prog=node"\r\n', ' SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n').replace("set PATHEXT=%PATHEXT:;.JS;=;% & ", "");
  expect(npmShimScript(v8)).toBe(script);
  expect(npmShimScript(npmShim("..\\x\\cli.js"))).toBe("..\\x\\cli.js");
  // Matched whole and in order: a line added (an exit before the run line), moved, repeated or missing is not npm's.
  const lines = npmShim(script).split("\r\n"), at = lines.findIndex((l) => l.startsWith("endLocal"));
  const edit = (f) => { const l = [...lines]; f(l); return l.join("\r\n"); };
  expect(npmShimScript(edit((l) => l.splice(at, 0, "exit /b")))).toBeNull();
  expect(npmShimScript(edit((l) => l.splice(at, 0, "EXIT /b")))).toBeNull(); // a line the template has, in the wrong place
  expect(npmShimScript(edit((l) => { [l[1], l[2]] = [l[2], l[1]]; }))).toBeNull(); // reordered
  expect(npmShimScript(edit((l) => l.splice(at, 0, l[at])))).toBeNull(); // the run line twice
  expect(npmShimScript(edit((l) => l.splice(6, 1)))).toBeNull(); // SETLOCAL dropped
  expect(npmShimScript(v8.replace("SET PATHEXT", "SET PATHEXT=x\r\nSET PATHEXT"))).toBeNull();
  // The older form (cmd-shim 4.0: run line, ENDLOCAL, subroutine last) is not matched: cmd.exe runs it.
  const v4 = '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n"%_prog%"  "%dp0%\\..\\x\\cli.js" %*\r\nENDLOCAL\r\nEXIT /b %errorlevel%\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n';
  expect(npmShimScript(v4)).toBeNull();
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
  const w = (cmd, args, files) => windowsCommand(cmd, args, { env: WIN_ENV, cwd: "C:\\work", ...winFs(files) });
  const base = { [`${NPM}\\codex.cmd`]: shim, [NODE]: "" };
  expect(w("codex", ["login", "status"], { ...base, [js]: "" })).toEqual({ cmd: NODE, args: [js, "login", "status"] });
  // The shim's own node.exe first, as the shim would.
  expect(w("codex", ["x"], { ...base, [js]: "", [`${NPM}\\node.exe`]: "" })).toEqual({ cmd: `${NPM}\\node.exe`, args: [js, "x"] });
  // Its script missing, or a wrapper of some other shape: cmd.exe runs the file as written.
  const viaCmd = (file, args) => ({ cmd: WIN_ENV.ComSpec, args: ["/d", "/s", "/c", `"${cmdLine(file, args)}"`], verbatim: true });
  expect(w("codex", ["x"], base)).toEqual(viaCmd(`${NPM}\\codex.cmd`, ["x"]));
  expect(w("tool", ['{"a":1}'], { [`${NPM}\\tool.cmd`]: '@"C:\\bin\\tool.exe" %*' })).toEqual(viaCmd(`${NPM}\\tool.cmd`, ['{"a":1}']));
  expect(w("cmd", ["/c", "x"], { "C:\\first\\cmd.exe": "" })).toEqual({ cmd: "C:\\first\\cmd.exe", args: ["/c", "x"] });
  // Not found: ENOENT, as for a missing program. Passed on bare (as before), libuv would search the current folder.
  expect(() => w("herdr", ["pane"], {})).toThrow(expect.objectContaining({ code: "ENOENT" }));
  // node itself a .cmd (a version manager's): the same rule again, through cmd.exe.
  const nodeCmd = "C:\\first\\node.cmd";
  expect(w("codex", ["x"], { [`${NPM}\\codex.cmd`]: shim, [js]: "", [nodeCmd]: "@echo off" })).toEqual(viaCmd(nodeCmd, [js, "x"]));
});

// From the final review: a name not found was passed on unchanged, and libuv's own search on Windows looks in the
// current folder first, so a planted `codex.exe` in a work tree would have started. Now the start fails, as for a
// missing program, and run() and probe() answer null as they do for one. Off Windows nothing changes.
test("start on Windows fails a command it cannot find with ENOENT, and starts nothing; elsewhere the name goes on as given", async () => {
  const seen = [], via = (...a) => { seen.push(a); return { on: () => {} }; };
  expect(() => start("routr-no-such-command", ["a"], { stdio: "ignore" }, { via, platform: "win32" })).toThrow(expect.objectContaining({ code: "ENOENT" }));
  expect(seen).toEqual([]);
  start("routr-no-such-command", ["a"], { stdio: "ignore" }, { via, platform: "linux" });
  expect(seen).toEqual([["routr-no-such-command", ["a"], { stdio: "ignore", windowsHide: true }]]);
  expect(await run("routr-no-such-command", [], { timeoutMs: 5000 })).toBeNull();
});

test("stopping a child on Windows kills its whole tree with taskkill, never a child that has exited; elsewhere the child alone", () => {
  const child = (over = {}) => { const c = { pid: 4242, exitCode: null, signalCode: null, killed: 0, kill() { c.killed++; }, ...over }; return c; };
  const seen = [], via = (...a) => { seen.push(a); return { on: () => {} }; };
  const running = child();
  stop(running, { platform: "win32", via });
  expect(seen.map(([cmd, args, opts]) => [cmd.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase(), args, opts])).toEqual([["taskkill", ["/PID", "4242", "/T", "/F"], { stdio: "ignore", windowsHide: true }]]);
  expect(running.killed).toBe(0); // the tree walk needs the child alive
  // taskkill failing to start: the child alone, as before.
  const lone = child();
  stop(lone, { platform: "win32", via: () => { throw new Error("EPERM"); } });
  expect(lone.killed).toBe(1);
  // A child that has exited may have handed its pid on: nothing is killed.
  seen.length = 0;
  for (const c of [child({ exitCode: 0 }), child({ signalCode: "SIGTERM" })]) { stop(c, { platform: "win32", via }); expect(c.killed).toBe(0); }
  expect(seen).toEqual([]);
  const posix = child();
  stop(posix, { platform: "linux", via, after: () => {} });
  expect([posix.killed, seen]).toEqual([1, []]);
});

// From the final review: taskkill's spawn error was handled, its exit status was not, so a taskkill that failed (or
// hung) left the child running. Each case falls back to killing the child alone, unless it has exited meanwhile.
test("on Windows a taskkill that exits non-zero or does not finish falls back to killing the child, never one that has exited", () => {
  const child = () => { const c = { pid: 4242, exitCode: null, signalCode: null, signals: [], kill(sig) { c.signals.push(sig ?? "TERM"); } }; return c; };
  const taskkill = () => { const h = {}; return { h, via: () => ({ on: (ev, fn) => { h[ev] = fn; } }) }; };
  const timers = [], after = (ms, fn) => { timers.push({ ms, fn }); return 0; };
  for (const [code, killed] of [[0, []], [1, ["TERM"]], [128, ["TERM"]]]) {
    const c = child(), tk = taskkill();
    stop(c, { platform: "win32", via: tk.via, after });
    expect(c.signals).toEqual([]);
    tk.h.exit(code);
    expect([code, c.signals]).toEqual([code, killed]);
  }
  // A child that exited while taskkill ran is not killed after a failure: its pid may be someone else's by now.
  const gone = child(), tk = taskkill();
  stop(gone, { platform: "win32", via: tk.via, after });
  gone.exitCode = 1; tk.h.exit(1);
  expect(gone.signals).toEqual([]);
  // taskkill still running after the grace: the child alone; a later exit does not kill it twice.
  timers.length = 0;
  const slow = child(), tk2 = taskkill();
  stop(slow, { platform: "win32", via: tk2.via, after });
  expect(timers.map((t) => t.ms)).toEqual([2000]);
  timers[0].fn(); tk2.h.exit(1);
  expect(slow.signals).toEqual(["TERM"]);
});

// From the final review: off Windows a timeout sent SIGTERM once, and a CLI that ignores it kept running. SIGKILL
// follows after a grace, unless the child has gone; the timer never holds routr's exit (unref'd), and the caller's
// answer does not wait for it.
test("off Windows a child that outlives SIGTERM gets SIGKILL after a grace; one that exited does not", () => {
  const child = () => { const c = { pid: 4242, exitCode: null, signalCode: null, signals: [], kill(sig) { c.signals.push(sig ?? "SIGTERM"); } }; return c; };
  const timers = [], after = (ms, fn) => { timers.push({ ms, fn }); return 0; };
  const stubborn = child();
  stop(stubborn, { platform: "linux", after });
  expect([stubborn.signals, timers.map((t) => t.ms)]).toEqual([["SIGTERM"], [2000]]);
  timers[0].fn();
  expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"]);
  timers.length = 0;
  const polite = child();
  stop(polite, { platform: "darwin", after });
  polite.signalCode = "SIGTERM"; timers[0].fn();
  expect(polite.signals).toEqual(["SIGTERM"]);
});

test.skipIf(process.platform === "win32")("a real child that ignores SIGTERM is gone soon after run() times out, and run() answers on time", async () => {
  const dir = scratch("stubborn"), pidFile = join(dir, "pid");
  const script = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 20000);`;
  const began = Date.now();
  expect(await run(process.execPath, ["-e", script], { timeoutMs: 1500 })).toBeNull();
  expect(Date.now() - began).toBeLessThan(2500); // the grace is not the caller's wait
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  expect(alive()).toBe(true); // SIGTERM alone did not stop it
  for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(100);
  expect(alive()).toBe(false);
});

// From the verification of 2b89d1d, with real processes in a routr-like parent (`bun -e`), so what is checked is
// whether that parent exits and what it leaves behind. A process that ends by itself after `life` ms stands in for a
// CLI, and for a taskkill that hangs: none outlives the test by more than that.
const RUNTIME = JSON.stringify(new URL("../src/lib/runtime.mjs", import.meta.url).href);
const lingering = (life) => `setTimeout(() => {}, ${life})`;
const parent = (code) => {
  const began = Date.now();
  const r = Bun.spawnSync([process.execPath, "-e", code], { timeout: 30000 });
  return { ms: Date.now() - began, code: r.exitCode, err: r.stderr.toString() };
};

// A taskkill that hung was outlived by the grace, then left running and referenced: routr stayed up until it ended.
test("a taskkill that hangs is killed and let go at the grace, so routr exits; the child it was for is killed", () => {
  const r = parent(`import { spawn } from "node:child_process"; import { stop } from ${RUNTIME};
    const target = spawn(process.execPath, ["-e", ${JSON.stringify(lingering(12000))}], { stdio: "ignore" });
    target.on("exit", (code, sig) => console.error("target", sig));
    const hang = () => spawn(process.execPath, ["-e", ${JSON.stringify(lingering(12000))}], { stdio: "ignore" });
    stop(target, { platform: "win32", via: hang });`);
  expect(r.code).toBe(0);
  expect(r.ms).toBeLessThan(6000); // the 2 s grace, not the hung taskkill's 12 s
  expect(r.err).toContain("target SIGTERM");
});

// usage and doctor call process.exit right after printing: the unref'd SIGKILL timer never fired, and a CLI that
// ignores SIGTERM outlived routr. Exit now kills what is still owed its SIGKILL.
test.skipIf(process.platform === "win32")("a child that ignores SIGTERM does not outlive a routr that exits right after the timeout", async () => {
  const pidFile = join(scratch("exit-reap"), "pid");
  const child = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${lingering(15000)}`;
  const r = parent(`import { run } from ${RUNTIME};
    console.log(await run(process.execPath, ["-e", ${JSON.stringify(child)}], { timeoutMs: 1000 })); process.exit(0);`);
  expect([r.code, r.ms < 5000]).toEqual([0, true]);
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 10 && alive(); i++) await Bun.sleep(100);
  expect(alive()).toBe(false);
});
