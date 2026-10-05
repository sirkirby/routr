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

test("the repository carries no version: the four version fields read 0.0.0-dev, and only the tag sets one", async () => {
  const { ROUTR_VERSION } = await import("../src/lib/version.mjs");
  const root = `${import.meta.dir}/..`;
  expect(ROUTR_VERSION).toBe("0.0.0-dev");
  expect(JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version).toBe("0.0.0-dev");
  expect(readFileSync(`${root}/skills/routr/SKILL.md`, "utf8")).toContain('version: "0.0.0-dev"');
  expect(readFileSync(`${root}/skills/routr-orchestrate/SKILL.md`, "utf8")).toContain('version: "0.0.0-dev"');
});

test("a release build stamps the tag's version into all four files, and refuses anything that is not a release version", () => {
  const root = scratch("stamp");
  try {
    for (const f of ["src/lib/version.mjs", "package.json", "skills/routr/SKILL.md", "skills/routr-orchestrate/SKILL.md"]) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), readFileSync(join(import.meta.dir, "..", f), "utf8"));
    }
    const stamp = (v) => Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/stamp-version.mjs"), v, root]);
    expect(stamp("0.3.0-rc.2").exitCode).toBe(0);
    expect(readFileSync(join(root, "src/lib/version.mjs"), "utf8")).toContain('const BASE = "0.3.0-rc.2";');
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("0.3.0");   // the base version
    expect(readFileSync(join(root, "skills/routr/SKILL.md"), "utf8")).toContain('  version: "0.3.0"'); // what doctor compares
    expect(readFileSync(join(root, "skills/routr-orchestrate/SKILL.md"), "utf8")).toContain('  version: "0.3.0"');
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

test("routr skill install writes both skills and links each into every harness folder that is set up, Kiro and Antigravity included", async () => {
  const { FILES, installSkill } = await import("../src/lib/skill-install.mjs");
  const { SKILLS, SKILL_FOLDERS } = await import("../src/lib/harnesses.mjs");
  const { existsSync, readdirSync } = await import("node:fs");
  expect(Object.keys(FILES)).toEqual(SKILLS);              // every skill in the registry's list has its files embedded
  expect(SKILLS).toEqual(["routr", "routr-orchestrate"]);
  // Every file under skills/ is installed: the folder holds exactly what ships.
  const tree = (d, pre = "") => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]));
  for (const s of SKILLS) expect(tree(join(import.meta.dir, "../skills", s)).sort()).toEqual(Object.keys(FILES[s]).sort());
  expect(SKILL_FOLDERS).toEqual([".agents/skills", ".claude/skills", ".gemini/config/skills", ".kiro/skills"]);

  const home = scratch("skill"); mkdirSync(`${home}/.claude`);
  const r = installSkill({ home });
  expect(r.installed.map((x) => [x.skill, x.how.replace("copied", "linked")])).toEqual([["routr", "written"], ["routr", "linked for Claude Code"], ["routr-orchestrate", "written"], ["routr-orchestrate", "linked for Claude Code"]]);
  expect(existsSync(`${home}/.agents/skills/routr/references/worker.md`)).toBe(true);
  for (const s of SKILLS) for (const f of SKILL_FOLDERS.slice(0, 2)) expect(readFileSync(`${home}/${f}/${s}/SKILL.md`, "utf8")).toContain(`name: ${s}`);
  expect(existsSync(`${home}/.kiro`) || existsSync(`${home}/.gemini`)).toBe(false); // neither is set up here: nothing made for them
  // Kiro (reads only ~/.kiro/skills, measured) and Antigravity (~/.gemini/config/skills, measured) once they are set up.
  mkdirSync(`${home}/.kiro`); mkdirSync(`${home}/.gemini/config`, { recursive: true });
  const all = installSkill({ home });
  expect(all.installed.filter((x) => x.skill === "routr-orchestrate").map((x) => x.how.replace("copied", "linked"))).toEqual(["written", "linked for Claude Code", "linked for Antigravity", "linked for Kiro"]);
  for (const s of SKILLS) for (const f of SKILL_FOLDERS) expect(readFileSync(`${home}/${f}/${s}/SKILL.md`, "utf8")).toContain(`name: ${s}`);
  // routr-orchestrate is only for the user to start: the documented fields, the same frontmatter everywhere, no setting.
  const md = readFileSync(`${home}/.kiro/skills/routr-orchestrate/SKILL.md`, "utf8");
  expect(md).toBe(readFileSync(join(import.meta.dir, "../skills/routr-orchestrate/SKILL.md"), "utf8"));
  expect(md).toMatch(/^---\r?\nname: routr-orchestrate\r?\ndescription: [^\n]*Use ONLY when the user explicitly invokes \/routr-orchestrate[^\n]*\n(?:[^\n]*\n)*?disable-model-invocation: true\r?\n[\s\S]*?\n---\r?\n/);
  expect(md).toContain("The work: $ARGUMENTS");
  expect(readFileSync(`${home}/.agents/skills/routr-orchestrate/agents/openai.yaml`, "utf8").replace(/\r\n/g, "\n")).toBe(
    'interface:\n  display_name: "routr orchestrate"\n  short_description: "Run this session as the routr orchestrator"\npolicy:\n  allow_implicit_invocation: false\n');
  expect(existsSync(`${home}/.kiro/prompts`)).toBe(false); // one mechanism: no prompt file
  expect(installSkill({ home, dryRun: true }).installed.length).toBe(8); // the plan names every place, and writes nothing new
  expect(installSkill({ home }).ok).toBe(true);            // installing again replaces routr's own, never fails
  expect(readdirSync(`${home}/.agents/skills`).sort()).toEqual(SKILLS); // no staging folder left behind
});

test("routr touches only its own skills: a same-named skill, a folder behind someone else's link, and a developer's link are kept", async () => {
  const { FILES, installSkill, owner } = await import("../src/lib/skill-install.mjs");
  const { uninstallPlan } = await import("../src/lib/uninstall.mjs");
  const { cpSync, existsSync, lstatSync, readlinkSync, symlinkSync } = await import("node:fs");
  const links = process.platform !== "win32";
  const home = scratch("own"); for (const d of [".claude", ".kiro", ".agents/skills/routr-orchestrate"]) mkdirSync(`${home}/${d}`, { recursive: true });
  // The user's own skill of the same name in the shared folder: not written over, nothing linked to it, and said.
  writeFileSync(`${home}/.agents/skills/routr-orchestrate/SKILL.md`, "---\nname: routr-orchestrate\ndescription: mine\n---\nmine\n");
  // In a harness folder: the user's own folder of that name.
  mkdirSync(`${home}/.kiro/skills/routr`, { recursive: true }); writeFileSync(`${home}/.kiro/skills/routr/SKILL.md`, "---\nname: routr\n---\nmine\n");
  const r = installSkill({ home });
  expect(r.kept.map((k) => k.where)).toEqual([join(home, ".kiro/skills/routr"), join(home, ".agents/skills/routr-orchestrate")]);
  expect(r.kept.every((k) => k.why === "not routr's: left as it is")).toBe(true);
  expect(readFileSync(`${home}/.agents/skills/routr-orchestrate/SKILL.md`, "utf8")).toContain("mine");
  expect(existsSync(`${home}/.claude/skills/routr-orchestrate`)).toBe(false);
  expect(readFileSync(`${home}/.kiro/skills/routr/SKILL.md`, "utf8")).toContain("mine");
  // The rest is installed, each folder with routr's manifest: the skill, this routr's version, every file it wrote.
  expect(JSON.parse(readFileSync(`${home}/.claude/skills/routr/.routr-install.json`, "utf8"))).toEqual({ skill: "routr", version: "0.0.0-dev", files: Object.keys(FILES.routr) });
  // Uninstall removes routr's and keeps the user's, and says so.
  const plan = uninstallPlan({ home });
  expect(plan.not_ours.map((x) => x.path)).toEqual([join(home, ".kiro/skills/routr"), join(home, ".agents/skills/routr-orchestrate")]);
  expect(plan.remove.map((x) => x.path)).toContain(join(home, ".agents/skills/routr"));
  expect(plan.remove.map((x) => x.path)).not.toContain(join(home, ".kiro/skills/routr"));
  // A copy routr made (the Windows branch) carries the manifest and is routr's. Holding a file the user added, it is
  // left exactly as it is and said; cleared, it is replaced, stays a copy, and a file an older routr listed goes.
  const copy = scratch("own-copy"), c = `${copy}/.claude/skills/routr`; mkdirSync(`${copy}/.claude/skills`, { recursive: true });
  installSkill({ home: copy });
  rmSync(c, { recursive: true, force: true }); cpSync(`${copy}/.agents/skills/routr`, c, { recursive: true });
  writeFileSync(`${c}/stale.md`, "a file an older routr shipped");
  writeFileSync(`${c}/.routr-install.json`, JSON.stringify({ skill: "routr", version: "0.4.9", files: [...Object.keys(FILES.routr), "stale.md"] }));
  writeFileSync(`${c}/mine.md`, "the user's");
  expect(owner(copy, "routr", c)).toBe("ours");
  const refused = installSkill({ home: copy });
  expect(refused.kept).toEqual([{ skill: "routr", where: c, why: `${c} has files routr didn't write (mine.md): remove them or the folder, then run \`routr skill install\`` }]);
  expect(readFileSync(`${c}/stale.md`, "utf8")).toBe("a file an older routr shipped"); // not touched at all
  rmSync(`${c}/mine.md`);
  installSkill({ home: copy });
  expect(lstatSync(c).isSymbolicLink()).toBe(false);
  expect(existsSync(`${c}/stale.md`)).toBe(false);
  expect(JSON.parse(readFileSync(`${c}/.routr-install.json`, "utf8")).files).toEqual(Object.keys(FILES.routr));
  const copied = scratch("own-copy-foreign"); mkdirSync(`${copied}/.claude/skills/routr`, { recursive: true });
  cpSync(join(import.meta.dir, "../skills/routr"), `${copied}/.claude/skills/routr`, { recursive: true }); // routr's text, copied by hand: no manifest
  expect(owner(copied, "routr", `${copied}/.claude/skills/routr`)).toBe("ours"); // a routr skill with its guides: the legacy rule
  rmSync(`${copied}/.claude/skills/routr/references`, { recursive: true });
  expect(owner(copied, "routr", `${copied}/.claude/skills/routr`)).toBe("theirs"); // without its guides, not provably routr's
  // A routr folder from before manifests (0.4.x: SKILL.md and its guides) is routr's once, and gets its manifest.
  const old = `${copy}/.agents/skills/routr`;
  rmSync(`${old}/.routr-install.json`); writeFileSync(`${old}/SKILL.md`, "---\nname: routr\nmetadata:\n  version: \"0.4.2\"\n---\n");
  expect(owner(copy, "routr", old)).toBe("ours");
  installSkill({ home: copy });
  expect(JSON.parse(readFileSync(`${old}/.routr-install.json`, "utf8")).skill).toBe("routr");
  if (!links) return;
  // The shared folder is itself a link (a maintainer's, into a checkout): never written through, and nothing linked to it.
  const dev = scratch("own-dev"), checkout = join(dev, "checkout"); mkdirSync(checkout); writeFileSync(join(checkout, "SKILL.md"), "---\nname: routr\n---\nthe checkout\n");
  mkdirSync(`${dev}/.agents/skills`, { recursive: true }); mkdirSync(`${dev}/.claude`); symlinkSync(checkout, `${dev}/.agents/skills/routr`, "dir");
  const d = installSkill({ home: dev });
  expect(d.kept.map((k) => k.where)).toContain(join(dev, ".agents/skills/routr"));
  expect(readdirSync(checkout)).toEqual(["SKILL.md"]);
  expect(readFileSync(join(checkout, "SKILL.md"), "utf8")).toContain("the checkout");
  expect(existsSync(`${dev}/.claude/skills/routr`)).toBe(false);
  // A harness link to anything but routr's copy is someone's own: kept by install and uninstall; one to routr's copy is routr's.
  rmSync(`${dev}/.claude/skills/routr-orchestrate`); symlinkSync(checkout, `${dev}/.claude/skills/routr-orchestrate`, "dir"); // in place of routr's link
  rmSync(`${dev}/.agents/skills/routr`); installSkill({ home: dev });
  expect(readlinkSync(`${dev}/.claude/skills/routr-orchestrate`)).toBe(checkout);
  expect(lstatSync(`${dev}/.claude/skills/routr`).isSymbolicLink() && readlinkSync(`${dev}/.claude/skills/routr`)).toBe(join(dev, ".agents/skills/routr"));
  expect(uninstallPlan({ home: dev }).not_ours.map((x) => x.path)).toEqual([join(dev, ".claude/skills/routr-orchestrate")]);
});

test("ownership is structural: no text in a skill grants it, only routr's manifest; a link through someone else's shared link is not routr's", async () => {
  const { installSkill, manifest, MANIFEST, owner } = await import("../src/lib/skill-install.mjs");
  const { uninstallPlan } = await import("../src/lib/uninstall.mjs");
  const { existsSync, symlinkSync } = await import("node:fs");
  const home = scratch("mark"), dir = `${home}/.agents/skills/routr-orchestrate`; mkdirSync(`${dir}/notes`, { recursive: true });
  // routr's old marker in every YAML shape a parser could be fooled by (a block scalar, a nested mapping, the body): none counts.
  for (const md of [
    "---\nname: routr-orchestrate\nmetadata:\n  note: |\n    installed-by: routr\n---\nmine\n",
    "---\nname: routr-orchestrate\nmetadata:\n  example:\n    installed-by: routr\n---\nmine\n",
    "---\nname: routr-orchestrate\nmetadata:\n  installed-by: routr\n---\nmine\n",
    "---\nname: routr-orchestrate\ndescription: mine\n---\nAn example:\n\n    metadata:\n      installed-by: routr\n",
  ]) { writeFileSync(`${dir}/SKILL.md`, md); expect(owner(home, "routr-orchestrate", dir)).toBe("theirs"); }
  // Nor does a manifest that is not routr's: another skill's, a folder, unparseable, or one reaching outside the folder.
  for (const m of [JSON.stringify({ skill: "routr", files: [] }), "not json", JSON.stringify({ skill: "routr-orchestrate", files: ["../../../.ssh/id_ed25519"] }), JSON.stringify({ skill: "routr-orchestrate", files: ["/etc/hosts"] })]) {
    writeFileSync(`${dir}/${MANIFEST}`, m); expect(manifest(dir, "routr-orchestrate")).toBeNull(); expect(owner(home, "routr-orchestrate", dir)).toBe("theirs");
  }
  rmSync(`${dir}/${MANIFEST}`); mkdirSync(`${dir}/${MANIFEST}`); expect(owner(home, "routr-orchestrate", dir)).toBe("theirs"); rmSync(`${dir}/${MANIFEST}`, { recursive: true });
  writeFileSync(`${dir}/notes/personal.md`, "my notes");
  const mine = readFileSync(`${dir}/SKILL.md`, "utf8");
  installSkill({ home });
  expect(readFileSync(`${dir}/SKILL.md`, "utf8")).toBe(mine);
  expect(readFileSync(`${dir}/notes/personal.md`, "utf8")).toBe("my notes");
  expect(uninstallPlan({ home }).remove.map((x) => x.path)).not.toContain(join(home, ".agents/skills/routr-orchestrate"));
  if (process.platform === "win32") return;
  // A developer links the shared folder to a checkout (even one carrying routr's mark), and Claude's to the shared one:
  // neither is routr's, so install and uninstall leave both, and the checkout.
  const dev = scratch("mark-dev"), checkout = join(dev, "checkout"); mkdirSync(`${dev}/.agents/skills`, { recursive: true }); mkdirSync(`${dev}/.claude/skills`, { recursive: true });
  mkdirSync(checkout); writeFileSync(join(checkout, "SKILL.md"), readFileSync(join(import.meta.dir, "../skills/routr/SKILL.md"), "utf8"));
  symlinkSync(checkout, `${dev}/.agents/skills/routr`, "dir"); symlinkSync(join(dev, ".agents/skills/routr"), `${dev}/.claude/skills/routr`, "dir");
  expect(owner(dev, "routr", `${dev}/.claude/skills/routr`)).toBe("theirs");
  const r = installSkill({ home: dev });
  expect(r.kept.map((k) => k.where)).toEqual([join(dev, ".agents/skills/routr")]); // nothing linked or written for routr
  const plan = uninstallPlan({ home: dev });
  expect(plan.not_ours.map((x) => x.path)).toEqual([join(dev, ".claude/skills/routr"), join(dev, ".agents/skills/routr")]);
  expect(plan.remove.map((x) => x.path).filter((p) => p.includes("skills/routr") && !p.includes("orchestrate"))).toEqual([]);
  expect(existsSync(join(checkout, "SKILL.md"))).toBe(true);
});

test("legacy ownership fails closed: a routr folder with any manifest that is not routr's valid one is not routr's", async () => {
  const { MANIFEST, owner } = await import("../src/lib/skill-install.mjs");
  const { cpSync, symlinkSync } = await import("node:fs");
  const home = scratch("legacy"), dir = `${home}/.agents/skills/routr`; mkdirSync(dirname(dir), { recursive: true });
  cpSync(join(import.meta.dir, "../skills/routr"), dir, { recursive: true }); // a routr skill with its guides, as 0.4.x wrote it
  expect(owner(home, "routr", dir)).toBe("ours");                             // no manifest at all: grandfathered
  for (const bad of ["not json", JSON.stringify({ skill: "routr-orchestrate", files: [] }), JSON.stringify({ skill: "routr", files: ["../x"] })]) {
    writeFileSync(`${dir}/${MANIFEST}`, bad); expect(owner(home, "routr", dir)).toBe("theirs");
  }
  rmSync(`${dir}/${MANIFEST}`); mkdirSync(`${dir}/${MANIFEST}`); expect(owner(home, "routr", dir)).toBe("theirs"); rmSync(`${dir}/${MANIFEST}`, { recursive: true });
  if (process.platform === "win32") return;
  writeFileSync(join(home, "real.json"), JSON.stringify({ skill: "routr", files: ["SKILL.md"] })); symlinkSync(join(home, "real.json"), `${dir}/${MANIFEST}`);
  expect(owner(home, "routr", dir)).toBe("theirs");                           // a manifest that is a link
});

test("nothing is written or removed through a link inside routr's folder, and uninstall reports what it could not remove", async () => {
  if (process.platform === "win32") return; // links need admin rights there
  const { installSkill } = await import("../src/lib/skill-install.mjs");
  const { existsSync, symlinkSync } = await import("node:fs");
  const home = scratch("through"), ext = join(home, "elsewhere"); mkdirSync(ext); mkdirSync(`${home}/.claude`);
  writeFileSync(join(ext, "openai.yaml"), "someone's real file");
  installSkill({ home });
  // routr's folder, its manifest authentic, with `agents` replaced by a link to a folder outside it.
  const dir = `${home}/.agents/skills/routr-orchestrate`;
  rmSync(`${dir}/agents`, { recursive: true }); symlinkSync(ext, `${dir}/agents`, "dir");
  const again = installSkill({ home });                                        // not replaced: it holds what routr did not write
  expect(again.kept.find((k) => k.where === dir).why).toContain("has files routr didn't write (agents)");
  expect(readFileSync(join(ext, "openai.yaml"), "utf8")).toBe("someone's real file");
  const env = cliEnv(home, { PATH: home });
  const doc = JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json"], { env }).stdout.toString());
  expect(doc.next_steps).toContain(`~/.agents/skills/routr-orchestrate has files routr didn't write (agents): remove them or the folder, then run \`routr skill install\``);
  const un = Bun.spawnSync([process.execPath, SCRIPT, "uninstall", "--yes", "--json"], { env });
  expect(un.exitCode).toBe(1);                                                // a failure is a failure
  const r = JSON.parse(un.stdout.toString());
  expect(r.ok).toBe(false);
  expect(r.failed).toEqual([`${join(dir, "agents/openai.yaml")}: a folder above it is a link, not followed`]);
  expect(readFileSync(join(ext, "openai.yaml"), "utf8")).toBe("someone's real file"); // the link's target is untouched
  expect(existsSync(`${dir}/.routr-install.json`)).toBe(true);                 // kept until every listed file is gone
  expect(existsSync(`${dir}/SKILL.md`)).toBe(false);
  expect(r.kept_files).toEqual([join(dir, "agents")]);
  expect(existsSync(`${home}/.agents/skills/routr`)).toBe(false);              // the other skill went in full
});

test("routr skill install and setup report a failed step as a failure, and claim only what was installed", () => {
  const home = scratch("skill-fail"); writeFileSync(join(home, ".agents"), "a file where the folder goes");
  const env = cliEnv(home, { PATH: home });
  const install = Bun.spawnSync([process.execPath, SCRIPT, "skill", "install"], { env });
  expect(install.exitCode).toBe(1);
  const out = JSON.parse(install.stdout.toString());
  expect(out.ok).toBe(false);
  expect(out.installed).toEqual([]);
  expect(out.failed.map((f) => f.skill)).toEqual(["routr", "routr-orchestrate"]);
  const setup = Bun.spawnSync([process.execPath, SCRIPT, "setup", "--yes", "--json"], { env });
  expect(setup.exitCode).toBe(1);
  const s = JSON.parse(setup.stdout.toString());
  expect(s.ok).toBe(false);
  expect(s.error).toContain("routr's skills were not fully installed");
  expect(s.did.join(" ")).not.toContain("installed the routr skills");
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
  expect(a.input_notes).toEqual(["--json: not a flag routr subagent takes, so ignored; the brief was read from stdin"]);
  const inside = JSON.parse(run(["dispatch", "Add", "a", "--verbose", "flag", "to", "the", "CLI"]).out);
  expect(inside.brief_chars).toBe("Add a --verbose flag to the CLI".length);
  expect(inside.input_notes).toEqual(["--verbose looks like a flag routr dispatch does not take; read as part of the brief"]);
  // With nothing on stdin, flag-like words are the brief (-Werror can be one), and the note says so (from the review of #41).
  const alone2 = JSON.parse(run(["subagent", "-Werror"]).out);
  expect(alone2.brief_chars).toBe("-Werror".length);
  expect(alone2.input_notes).toEqual(["-Werror looks like a flag routr subagent does not take; read as the brief"]);
});
