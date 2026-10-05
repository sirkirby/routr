// `routr skill install`: write routr's skills (the routr skill with the guides agents read, and routr-orchestrate,
// which only the user starts) into the shared skills folder, and link each into every harness's own skills folder, so
// a machine with no Node and no Bun needs nothing but the routr binary. The files are embedded at build time.
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HARNESSES, KINDS, SKILLS } from "./harnesses.mjs";
import skillMd from "../../skills/routr/SKILL.md" with { type: "text" };
import worker from "../../skills/routr/references/worker.md" with { type: "text" };
import orchestrator from "../../skills/routr/references/orchestrator.md" with { type: "text" };
import harnesses from "../../skills/routr/references/harnesses.md" with { type: "text" };
import setup from "../../skills/routr/references/setup.md" with { type: "text" };
import orchestrateMd from "../../skills/routr-orchestrate/SKILL.md" with { type: "text" };
import orchestrateYaml from "../../skills/routr-orchestrate/agents/openai.yaml" with { type: "text" };
import { home as userHome } from "./runtime.mjs";

// Every file of each skill in SKILLS, by its path inside the skill's folder (literal imports, so the binary bundles them).
export const FILES = {
  routr: { "SKILL.md": skillMd, "references/worker.md": worker, "references/orchestrator.md": orchestrator, "references/harnesses.md": harnesses, "references/setup.md": setup },
  "routr-orchestrate": { "SKILL.md": orchestrateMd, "agents/openai.yaml": orchestrateYaml },
};
// Harnesses that read their own skills folder rather than the shared one (`skills` in the registry). Codex and Cursor
// read ~/.agents/skills.
const LINKED = Object.fromEntries(KINDS.filter((n) => HARNESSES[n].skills).map((n) => [HARNESSES[n].label, HARNESSES[n].skills]));

// Each skill the same way: written to ~/.agents/skills/<name>, then linked into each harness's folder that is set up.
export function installSkill({ home = userHome(), dryRun = false } = {}) {
  const done = [], dests = [];
  for (const skill of SKILLS) {
    const dest = join(home, ".agents/skills", skill);
    dests.push(dest);
    if (!dryRun) for (const [rel, text] of Object.entries(FILES[skill])) { const f = join(dest, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
    done.push({ skill, where: dest, how: "written" });
    for (const [name, rel] of Object.entries(LINKED)) {
      const dir = join(home, rel), link = join(dir, skill);
      if (!existsSync(dirname(dir))) continue; // that harness is not set up on this machine
      if (!dryRun) {
        mkdirSync(dir, { recursive: true });
        try { if (lstatSync(link)) rmSync(link, { recursive: true, force: true }); } catch {}
        // A link keeps one copy; Windows often refuses links without admin rights, so copy there.
        try { if (process.platform === "win32") throw 0; symlinkSync(dest, link, "dir"); done.push({ skill, where: link, how: `linked for ${name}` }); }
        catch { cpSync(dest, link, { recursive: true }); done.push({ skill, where: link, how: `copied for ${name}` }); }
      } else done.push({ skill, where: link, how: `for ${name}` });
    }
  }
  return { skill: dests[0], skills: dests, installed: done,
    next: "Ask your agent to set routr up: it will follow references/setup.md in the skill. To start an orchestration, type /routr-orchestrate <your plan> ($routr-orchestrate in Codex)." };
}
