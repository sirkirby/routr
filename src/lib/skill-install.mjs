// `routr skill install`: write the routr skill (the guides agents read) into the shared skills folder, so a machine
// with no Node and no Bun needs nothing but the routr binary. The guides are embedded at build time.
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import skillMd from "../../skills/routr/SKILL.md" with { type: "text" };
import worker from "../../skills/routr/references/worker.md" with { type: "text" };
import orchestrator from "../../skills/routr/references/orchestrator.md" with { type: "text" };
import harnesses from "../../skills/routr/references/harnesses.md" with { type: "text" };
import setup from "../../skills/routr/references/setup.md" with { type: "text" };

const FILES = { "SKILL.md": skillMd, "references/worker.md": worker, "references/orchestrator.md": orchestrator, "references/harnesses.md": harnesses, "references/setup.md": setup };
// Harnesses that read their own skills folder rather than the shared one. Codex and Cursor read ~/.agents/skills; Kiro
// lists only ~/.kiro/skills (measured 2026-09-26: a skill in ~/.agents/skills alone was not offered).
const LINKED = { "Claude Code": ".claude/skills", Kiro: ".kiro/skills" };

export function installSkill({ home = homedir(), dryRun = false } = {}) {
  const dest = join(home, ".agents/skills/routr"), done = [];
  if (!dryRun) for (const [rel, text] of Object.entries(FILES)) { const f = join(dest, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
  done.push({ where: dest, how: "written" });
  for (const [name, rel] of Object.entries(LINKED)) {
    const dir = join(home, rel), link = join(dir, "routr");
    if (!existsSync(dirname(dir))) continue; // that harness is not set up on this machine
    if (!dryRun) {
      mkdirSync(dir, { recursive: true });
      try { if (lstatSync(link)) rmSync(link, { recursive: true, force: true }); } catch {}
      // A link keeps one copy; Windows often refuses links without admin rights, so copy there.
      try { if (process.platform === "win32") throw 0; symlinkSync(dest, link, "dir"); done.push({ where: link, how: `linked for ${name}` }); }
      catch { cpSync(dest, link, { recursive: true }); done.push({ where: link, how: `copied for ${name}` }); }
    } else done.push({ where: link, how: `for ${name}` });
  }
  return { skill: dest, installed: done, next: "Ask your agent to set routr up: it will follow references/setup.md in the skill." };
}
