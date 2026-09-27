// the CLI: help, dispatch, versions, skill install, key set
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";


import { COMMANDS, DESCRIPTION, formatCommandHelp, formatTopLevelHelp, formatUnknownUsage } from "../src/lib/help.mjs";
import { cliEnv, scratch, SCRIPT } from "./helpers.mjs";
test("help table covers every command the CLI dispatches", () => {
  const dispatched = ["subagent", "dispatch", "launch", "usage", "doctor", "setup", "uninstall", "check", "record", "assess", "share", "update", "statusline", "skill", "key", "telemetry", "feedback"];
  expect(Object.keys(COMMANDS).sort()).toEqual(dispatched.sort());

  // Every command has a valid description, non-empty synopsis, and flags/args
  for (const name of dispatched) {
    const cmd = COMMANDS[name];
    expect(cmd.name).toBe(name);
    expect(typeof cmd.description).toBe("string");
    expect(cmd.description.length).toBeGreaterThan(10);
    const help = formatCommandHelp(cmd);
    expect(help).toContain(`routr ${name}: ${cmd.description}`);
    expect(help).toContain("--help, -h");
    if (cmd.flags) {
      for (const flag of cmd.flags) {
        expect(flag.name.startsWith("--")).toBe(true);
        expect(typeof flag.description).toBe("string");
        expect(help).toContain(flag.name);
      }
    }
  }

  // launch flags match parseLaunchArgs options
  const launchFlags = COMMANDS.launch.flags.map((f) => f.name.replace(/^--/, ""));
  for (const opt of ["kind", "name", "cwd", "model", "effort", "pane", "direction", "task", "task-file", "trust", "timeout", "dry-run"]) {
    expect(launchFlags).toContain(opt);
  }
  expect(COMMANDS.launch.flags.find((f) => f.name === "--model").required).toBe("required unless --dry-run");

  // Unknown usage string contains every command
  const unknownUsage = formatUnknownUsage();
  for (const name of dispatched) {
    expect(unknownUsage).toContain(`routr ${name}`);
  }

  // Top-level help contains routr description, --version, and all commands
  const topHelp = formatTopLevelHelp();
  expect(topHelp).toContain(DESCRIPTION);
  expect(topHelp).toContain("--version");
  for (const name of dispatched) {
    expect(topHelp).toContain(name);
  }
});

test("top-level help flags and help command print usage and exit 0", () => {
  for (const flag of ["--help", "-h", "help"]) {
    const res = Bun.spawnSync(["bun", SCRIPT, flag]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toBe("");
    const stdout = res.stdout.toString();
    expect(stdout).toContain(DESCRIPTION);
    expect(stdout).toContain("--version");
    for (const cmd of ["subagent", "dispatch", "launch", "doctor", "check", "record", "assess"]) {
      expect(stdout).toContain(cmd);
    }
  }
});

test("command help prints usage for each command and exits 0", () => {
  const commands = ["subagent", "dispatch", "launch", "usage", "doctor", "check", "record", "assess"];
  for (const cmd of commands) {
    for (const flag of ["--help", "-h"]) {
      const res = Bun.spawnSync(["bun", SCRIPT, cmd, flag]);
      expect(res.exitCode).toBe(0);
      expect(res.stderr.toString()).toBe("");
      const stdout = res.stdout.toString();
      expect(stdout).toContain(`routr ${cmd}: ${COMMANDS[cmd].description}`);
      expect(stdout).toContain(`usage: routr ${cmd}`);
      expect(stdout).toContain("--help, -h");
    }
  }

  // routr launch --help works without HERDR_ENV, does not touch herdr, and exits 0
  const cleanEnv = { ...process.env };
  delete cleanEnv.HERDR_ENV;
  const launchRes = Bun.spawnSync(["bun", SCRIPT, "launch", "--help"], { env: cleanEnv });
  expect(launchRes.exitCode).toBe(0);
  expect(launchRes.stderr.toString()).toBe("");
  expect(launchRes.stdout.toString()).toContain("routr launch: start a worker");
  expect(launchRes.stdout.toString()).toContain("--kind <kind>");
  expect(launchRes.stdout.toString()).toContain("--model <id>");
  expect(launchRes.stdout.toString()).toContain("required unless --dry-run");

  // routr record --help exits 0 without reading stdin
  const recordRes = Bun.spawnSync(["bun", SCRIPT, "record", "--help"], { stdin: "ignore" });
  expect(recordRes.exitCode).toBe(0);
  expect(recordRes.stderr.toString()).toBe("");
  expect(recordRes.stdout.toString()).toContain("routr record: append what you chose");
  expect(recordRes.stdout.toString()).toContain("--subscription <name>");
});

test("a brief containing --help as a separate word is routed as a brief, not as help", () => {
  for (const cmd of ["subagent", "dispatch"]) {
    // A throwaway HOME with no key and no config: the command falls back at once instead of calling the network,
    // so this test is about argument handling only and cannot time out on a slow connection.
    const home = scratch("nokey");
    const res = Bun.spawnSync(["bun", SCRIPT, cmd, "add", "--help", "to", "the", "CLI"], { env: cliEnv(home) });
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toBe("");
    const data = JSON.parse(res.stdout.toString());
    expect(data.mode).toBe(cmd);
    expect(data.brief_chars).toBe("add --help to the CLI".length);
  }
});

test("unrecognized mode prints usage from table to stderr and exits 2", () => {
  for (const args of [["unknown-mode"], []]) {
    const res = Bun.spawnSync(["bun", SCRIPT, ...args]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout.toString()).toBe("");
    const stderr = res.stderr.toString();
    expect(stderr).toContain("usage: routr subagent");
    for (const cmd of ["dispatch", "launch", "doctor", "check", "record", "assess"]) {
      expect(stderr).toContain(`routr ${cmd}`);
    }
  }
});

test("the repository carries no version: the three version fields read 0.0.0-dev, and only the tag sets one", async () => {
  const { ROUTR_VERSION } = await import("../src/lib/version.mjs");
  const root = `${import.meta.dir}/..`;
  expect(ROUTR_VERSION).toBe("0.0.0-dev");
  expect(JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version).toBe("0.0.0-dev");
  expect(readFileSync(`${root}/skills/routr/SKILL.md`, "utf8")).toContain('version: "0.0.0-dev"');
});

test("a release build stamps the tag's version into all three files, and refuses anything that is not a release version", () => {
  const root = scratch("stamp");
  try {
    for (const f of ["src/lib/version.mjs", "package.json", "skills/routr/SKILL.md"]) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), readFileSync(join(import.meta.dir, "..", f), "utf8"));
    }
    const stamp = (v) => Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/stamp-version.mjs"), v, root]);
    expect(stamp("0.3.0-rc.2").exitCode).toBe(0);
    expect(readFileSync(join(root, "src/lib/version.mjs"), "utf8")).toContain('const BASE = "0.3.0-rc.2";');
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("0.3.0");   // the base version
    expect(readFileSync(join(root, "skills/routr/SKILL.md"), "utf8")).toContain('  version: "0.3.0"'); // what doctor compares
    expect(stamp("v0.3.0").exitCode).not.toBe(0);                                                  // the tag name, not the version
    expect(stamp("0.3").exitCode).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a pre-release or source build and its skill count as the same release", async () => {
  const { baseVersion } = await import("../src/lib/version.mjs");
  expect(baseVersion("0.3.0-rc.2")).toBe("0.3.0");
  expect(baseVersion("0.0.0-dev")).toBe(baseVersion("0.0.0-dev"));
  expect(baseVersion(undefined)).toBe("");
});

test("routr skill install writes the guides and links them for Claude Code and Kiro", async () => {
  const { installSkill } = await import("../src/lib/skill-install.mjs");
  const { mkdirSync, readFileSync, existsSync } = await import("node:fs");

  const home = scratch("skill"); mkdirSync(`${home}/.claude`);
  const r = installSkill({ home });
  expect(readFileSync(`${home}/.agents/skills/routr/SKILL.md`, "utf8")).toContain("name: routr");
  expect(existsSync(`${home}/.agents/skills/routr/references/worker.md`)).toBe(true);
  expect(readFileSync(`${home}/.claude/skills/routr/SKILL.md`, "utf8")).toContain("name: routr");
  expect(r.installed.length).toBe(2); // no ~/.kiro: Kiro is not set up here
  mkdirSync(`${home}/.kiro`);                              // Kiro reads only ~/.kiro/skills (measured)
  expect(installSkill({ home }).installed.map((x) => x.how)).toEqual(["written", expect.stringContaining("Claude Code"), expect.stringContaining("Kiro")]);
  expect(readFileSync(`${home}/.kiro/skills/routr/SKILL.md`, "utf8")).toContain("name: routr");
  installSkill({ home });                                  // installing again replaces, never fails
});

test("routr key set stores a piped key owner-only, never prints it, and refuses junk", () => {
  const home = scratch("key");
  const env = cliEnv(home);
  const good = Bun.spawnSync(["bun", SCRIPT, "key", "set", "--no-verify"], { env, stdin: Buffer.from("ts_test_0123456789abcdef\n") });
  expect(good.exitCode).toBe(0);
  expect(good.stdout.toString()).not.toContain("0123456789abcdef");
  const file = join(home, ".config/routr/env");
  expect(readFileSync(file, "utf8")).toBe("TYPESAFE_API_KEY=ts_test_0123456789abcdef\n");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  const bad = Bun.spawnSync(["bun", SCRIPT, "key", "set", "--no-verify"], { env, stdin: Buffer.from("nope\n") });
  expect(bad.exitCode).toBe(1);
  expect(readFileSync(file, "utf8")).toContain("0123456789abcdef");    // the earlier key is untouched
});

test("the file-and-ledger commands answer instead of failing", async () => {
  const { checkCommand, recordCommand } = await import("../src/lib/commands.mjs");
  const missing = await checkCommand({ brief: "/nonexistent/brief", report: "/nonexistent/report" });
  expect(missing.fallback).toBe(true);
  expect(recordCommand({ advice: "/nonexistent/advice.json" }).recorded).toBeNull();
  const dir = scratch("check");
  writeFileSync(join(dir, "b"), "Fix the typo in README.md and run bun test."); writeFileSync(join(dir, "r"), "VERDICT: done");
  const seen = [];
  const out = await checkCommand({ brief: join(dir, "b"), report: join(dir, "r") }, { askFn: async (input) => { seen.push(input); return { answers: {}, latencyMs: 12 }; } });
  expect(out.warning).toContain("very short");
  expect(seen[0].report.text).toBe("VERDICT: done");
  expect(out.ms).toBe(12);
});

test("help, --version and statusline load none of the harness drivers: those load only when a command reads usage", () => {
  // Static imports only: `await import()` is how the drivers are reached on demand, and is exactly what stays out.
  const root = join(import.meta.dir, "../src");
  const reach = (file, seen = new Set()) => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const [, rel] of readFileSync(file, "utf8").matchAll(/^import [^;]*? from "(\.{1,2}\/[^"]+\.mjs)";/gm)) reach(join(dirname(file), rel), seen);
    return seen;
  };
  const heavy = ["cursor-usage.mjs", "kiro-usage.mjs", "terminal.mjs", "herdr.mjs", "launch.mjs", "snapshot.mjs"];
  for (const start of ["lib/help.mjs", "lib/statusline.mjs", "lib/harnesses.mjs"]) {
    const loaded = [...reach(join(root, start))].map((f) => f.split(/[\\/]/).at(-1));
    expect(loaded.filter((f) => heavy.includes(f))).toEqual([]);
  }
  expect(readFileSync(join(root, "routr.mjs"), "utf8")).not.toMatch(/^import /m); // the entry point imports nothing up front
});

test("routr's own code in the test process sees the scratch home, not the maintainer's (Bun's os.homedir ignores a changed HOME)", async () => {
  const { home, CACHE_DIR } = await import("../src/lib/runtime.mjs");
  const { CONFIG_PATH } = await import("../src/lib/config.mjs");
  expect(home()).toBe(process.env.HOME);
  expect(CONFIG_PATH.startsWith(process.env.HOME)).toBe(true);
  expect(CACHE_DIR().startsWith(process.env.HOME)).toBe(true);
});

test("small CLI fixes: help for a command however it is asked, --headroom never leaks into the brief, and share writes beside its ledger", () => {
  const home = scratch("cli-fixes"), env = cliEnv(home, { PATH: home }); // no harness on PATH: none is asked anything
  const run = (...a) => Bun.spawnSync([process.execPath, SCRIPT, ...a], { env, stdin: "ignore" });
  // `routr --help launch` and `-h dispatch` show that command's help, as `routr help launch` does.
  for (const [how, cmd] of [["--help", "launch"], ["-h", "dispatch"], ["help", "usage"]]) expect(run(how, cmd).stdout.toString()).toStartWith(`routr ${cmd}: `);
  expect(run("--help").stdout.toString()).toContain("commands:"); // alone: the list of commands
  for (const inherited of ["constructor", "toString", "__proto__"]) expect(run("--help", inherited).stdout.toString()).toContain("commands:"); // not a command
  // An empty --headroom is taken off the line with the rest; a percent is read; what cannot be read is said.
  const d = JSON.parse(run("dispatch", "--headroom", "cursor=", "--headroom", "claude=40%", "--headroom", "codex=lots", "Fix the parser").stdout.toString());
  expect(d.brief_chars).toBe("Fix the parser".length);
  expect(d.input_notes).toEqual([
    "--headroom cursor= is not <subscription>=<a share from 0 to 1, or a percent>: ignored",
    "--headroom codex=lots is not <subscription>=<a share from 0 to 1, or a percent>: ignored"]);
  // share writes its file beside the ledger it read, the one --ledger names.
  const dir = join(home, "elsewhere"); mkdirSync(dir);
  const ledger = join(dir, "l.jsonl");
  writeFileSync(ledger, JSON.stringify({ ts: "2026-09-26T10:00:00.000Z", id: "a1", mode: "dispatch", question_set: "r4", level: "basic", chose: { subscription: "codex", model: "m", effort: "low", level: "basic" }, outcome: { verdict: "done", check: "pass", attempts: 1 } }) + "\n");
  expect(run("share", "--ledger", ledger).stdout.toString()).toContain(dir);
  expect(readdirSync(dir).some((f) => /^routr-ledger-.*\.jsonl$/.test(f))).toBe(true);
});

test("--headroom: a share or a percent is read; empty, % alone, out of range, or no name is a note, never a 0", async () => {
  const { parseHeadroom } = await import("../src/lib/commands.mjs");
  const r = parseHeadroom(["claude=40%", "codex=0.9", "cursor=%", "agy=% ", "kiro=150%", "x=1.5", "claude2 =0.5", "=0.5", "lots", "y="]);
  expect(r.given).toEqual({ claude: 0.4, codex: 0.9, claude2: 0.5 });
  expect(r.notes.map((n) => n.split(" is not")[0])).toEqual(["--headroom cursor=%", "--headroom agy=% ", "--headroom kiro=150%", "--headroom x=1.5", "--headroom =0.5", "--headroom lots", "--headroom y="]);
});

test("a flag subagent and dispatch do not take is never advised on as the brief", () => {
  const home = scratch("flag-brief"), file = join(home, "brief.txt"), text = "Rename the helper foo to bar in src/a.js and update its two callers.";
  writeFileSync(file, text);
  const run = (args, input) => { const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: cliEnv(home), stdin: input ? Bun.file(input) : "ignore" }); return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }; };
  // Found 2026-09-26: `routr subagent --json < brief.txt` gave advice about the text "--json".
  const alone = run(["subagent", "--json"], file), a = JSON.parse(alone.out);
  expect(alone.code).toBe(0);
  expect(a.brief_chars).toBe(text.length); // the brief came from stdin
  expect(a.input_notes).toEqual(["--json: not a flag routr subagent takes, so ignored; the brief is the text, or stdin"]);
  const inside = JSON.parse(run(["dispatch", "Add", "a", "--verbose", "flag", "to", "the", "CLI"]).out);
  expect(inside.brief_chars).toBe("Add a --verbose flag to the CLI".length);
  expect(inside.input_notes).toEqual(["--verbose looks like a flag routr dispatch does not take; it was read as part of the brief"]);
  const empty = run(["subagent", "--json"]);
  expect(empty.code).toBe(2);
  expect(empty.err).toContain("routr: empty brief (--json: not a flag");
});
