// the CLI: help, dispatch, versions, skill install, key set
import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";


import { COMMANDS, DESCRIPTION, formatCommandHelp, formatTopLevelHelp, formatUnknownUsage } from "../src/lib/help.mjs";
import { ans, cfg, fact, live, scratch } from "./helpers.mjs";
test("dispatch and subagent answer from a function: Jev's reading, the ranking, and the user's fallback when Jev is down", async () => {
  const { adviseCommand } = await import("../src/lib/commands.mjs");
  const jev = async () => ({ model: "jev-test", latencyMs: 12.4, answers: fact(ans(1.1, 0.9), {}) });
  const read = async (names) => names.map((n) => live(n, n === "cursor" ? 0.9 : 0.3));
  const d = await adviseCommand("dispatch", "Fix the parser", { config: cfg(), notes: [] }, {}, { askFn: jev, read });
  expect(d).toMatchObject({ mode: "dispatch", level: "standard", jev_model: "jev-test", ms: 12, brief_chars: 14 });
  expect(d.subscriptions.most_room).toBe("cursor");
  expect(d.rule).toContain("Launch on a subscription");
  expect(JSON.stringify(d)).not.toContain("Fix the parser"); // the brief itself is never in the output
  const down = await adviseCommand("subagent", "Fix it", { config: cfg(), notes: ["a note"] }, {}, { askFn: async () => { throw new Error("offline"); } });
  expect(down).toMatchObject({ fallback: true, level: "standard", config_notes: ["a note"] });
  expect(down.subscriptions).toBeUndefined();
  expect(down.notes[0]).toContain("Router unavailable (offline)");
  const none = await adviseCommand("dispatch", "x", { config: { ...cfg(), subscriptions: {} }, notes: [] }, {}, { askFn: jev, read });
  expect(none.subscriptions.note).toContain("has not run `routr setup`");
});

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
  const script = `${import.meta.dir}/../src/routr.mjs`;
  for (const flag of ["--help", "-h", "help"]) {
    const res = Bun.spawnSync(["bun", script, flag]);
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
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const commands = ["subagent", "dispatch", "launch", "usage", "doctor", "check", "record", "assess"];
  for (const cmd of commands) {
    for (const flag of ["--help", "-h"]) {
      const res = Bun.spawnSync(["bun", script, cmd, flag]);
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
  const launchRes = Bun.spawnSync(["bun", script, "launch", "--help"], { env: cleanEnv });
  expect(launchRes.exitCode).toBe(0);
  expect(launchRes.stderr.toString()).toBe("");
  expect(launchRes.stdout.toString()).toContain("routr launch: start a worker");
  expect(launchRes.stdout.toString()).toContain("--kind <kind>");
  expect(launchRes.stdout.toString()).toContain("--model <id>");
  expect(launchRes.stdout.toString()).toContain("required unless --dry-run");

  // routr record --help exits 0 without reading stdin
  const recordRes = Bun.spawnSync(["bun", script, "record", "--help"], { stdin: "ignore" });
  expect(recordRes.exitCode).toBe(0);
  expect(recordRes.stderr.toString()).toBe("");
  expect(recordRes.stdout.toString()).toContain("routr record: append what you chose");
  expect(recordRes.stdout.toString()).toContain("--subscription <name>");
});

test("a brief containing --help as a separate word is routed as a brief, not as help", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  for (const cmd of ["subagent", "dispatch"]) {
    // A throwaway HOME with no key and no config: the command falls back at once instead of calling the network,
    // so this test is about argument handling only and cannot time out on a slow connection.
    const home = scratch("nokey");
    const res = Bun.spawnSync(["bun", script, cmd, "add", "--help", "to", "the", "CLI"], { env: { ...process.env, HOME: home, USERPROFILE: home, TYPESAFE_API_KEY: "" } });
    rmSync(home, { recursive: true, force: true });
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toBe("");
    const data = JSON.parse(res.stdout.toString());
    expect(data.mode).toBe(cmd);
    expect(data.brief_chars).toBe("add --help to the CLI".length);
  }
});

test("unrecognized mode prints usage from table to stderr and exits 2", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  for (const args of [["unknown-mode"], []]) {
    const res = Bun.spawnSync(["bun", script, ...args]);
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
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const home = scratch("key");
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYPESAFE_API_KEY: "" };
  const good = Bun.spawnSync(["bun", script, "key", "set", "--no-verify"], { env, stdin: Buffer.from("ts_test_0123456789abcdef\n") });
  expect(good.exitCode).toBe(0);
  expect(good.stdout.toString()).not.toContain("0123456789abcdef");
  const file = join(home, ".config/routr/env");
  expect(readFileSync(file, "utf8")).toBe("TYPESAFE_API_KEY=ts_test_0123456789abcdef\n");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  const bad = Bun.spawnSync(["bun", script, "key", "set", "--no-verify"], { env, stdin: Buffer.from("nope\n") });
  expect(bad.exitCode).toBe(1);
  expect(readFileSync(file, "utf8")).toContain("0123456789abcdef");    // the earlier key is untouched
  rmSync(home, { recursive: true, force: true });
});

test("the headline reads the same as before it moved out of the entrypoint", async () => {
  const { headline } = await import("../src/lib/advise.mjs");
  const facts = { approach_open: { reading: "yes" }, standalone: { reading: "yes" }, cross_cutting: { reading: "no" } };
  expect(headline({ level: "standard", sure: true, work_type: "debug", facts })).toBe("routr: standard, debug work; approach_open");
  expect(headline({ level: "standard", sure: false, between: ["standard", "strong"], work_type: "review", facts: {}, high_risk: true, worker: { suggestion: "split it across workers" }, notes: ["Fix the brief: it names no check"] }))
    .toBe("routr: SPLIT IT ACROSS WORKERS · standard (torn between standard and strong), review work; HIGH RISK; FIX THE BRIEF FIRST");
  expect(headline({ level: "basic", sure: false })).toBe("routr: basic (unsure), unknown work");
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
