// `routr skill install`: write routr's skills (the routr skill with the guides agents read, and routr-orchestrate,
// which only the user starts) into the shared skills folder, and link each into every harness's own skills folder, so
// a machine with no Node and no Bun needs nothing but the routr binary. The files are embedded at build time.
// routr touches only what is provably its own (`owner` below): anything else of the same name is kept and reported.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

// ---- What is routr's. Each SKILL.md routr ships carries `installed-by: routr` under `metadata`. A routr skill written
// before that mark (routr up to 0.5.0-beta.1) is known by its name and its guides. A harness link is routr's only when
// it points at routr's shared copy; any other link (a developer's, into a checkout) is never followed, replaced or removed.
const MARK = /^\s*installed-by:\s*routr\s*$/m;
const LEGACY = { routr: ["references/worker.md", "references/orchestrator.md"] };
export const sharedPath = (home, skill) => join(home, ".agents/skills", skill);
// "absent", "ours", or "theirs" for the thing at `path` that would be `skill`.
export function owner(home, skill, path) {
  let st; try { st = lstatSync(path); } catch { return "absent"; }
  const shared = sharedPath(home, skill);
  if (st.isSymbolicLink()) { try { return path !== shared && resolve(dirname(path), readlinkSync(path)) === shared ? "ours" : "theirs"; } catch { return "theirs"; } }
  if (!st.isDirectory()) return "theirs";
  let text = ""; try { text = readFileSync(join(path, "SKILL.md"), "utf8"); } catch { return "theirs"; }
  if (!new RegExp(`^name:\\s*${skill}\\s*$`, "m").test(text)) return "theirs";
  return MARK.test(text) || (LEGACY[skill] && LEGACY[skill].every((f) => existsSync(join(path, f)))) ? "ours" : "theirs";
}
// Every place a skill of routr's can be, harness folders first (links before the folder they point at), each with its
// owner. `set`: that harness is set up on this machine (the folder above its skills folder exists).
export function skillPlaces(home = userHome()) {
  return SKILLS.flatMap((skill) => [
    ...Object.entries(LINKED).map(([label, rel]) => ({ skill, label, path: join(home, rel, skill), set: existsSync(dirname(join(home, rel))) })),
    { skill, label: null, path: sharedPath(home, skill), set: true },
  ].map((p) => ({ ...p, state: owner(home, skill, p.path) })));
}
export const NOT_OURS = "not routr's: left as it is";

// A link is unlinked, never followed: a developer's skill folder is a link into their checkout.
export const removePath = (p) => { if (lstatSync(p).isSymbolicLink()) unlinkSync(p); else rmSync(p, { recursive: true, force: true }); };
// A folder is filled beside its place, then renamed into it, so a failure leaves the old one (or none), never half a skill.
export function staged(dest, fill) {
  const tmp = join(dirname(dest), `.${basename(dest)}.routr-new-${process.pid}`), old = join(dirname(dest), `.${basename(dest)}.routr-old-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  try { fill(tmp); } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  const had = existsSync(dest);
  if (had) { rmSync(old, { recursive: true, force: true }); renameSync(dest, old); }
  try { renameSync(tmp, dest); } catch (e) { if (had) renameSync(old, dest); rmSync(tmp, { recursive: true, force: true }); throw e; }
  if (had) rmSync(old, { recursive: true, force: true });
}

// Each skill the same way: written to ~/.agents/skills/<name>, then linked (copied on Windows) into each harness's folder
// that is set up. Only what is absent or routr's is written; the rest is reported in `kept`, a failure in `failed`.
export function installSkill({ home = userHome(), dryRun = false } = {}) {
  const done = [], kept = [], failed = [];
  for (const skill of SKILLS) {
    const places = skillPlaces(home).filter((p) => p.skill === skill), shared = places.at(-1);
    if (shared.state === "theirs") { kept.push({ skill, where: shared.path, why: NOT_OURS }); continue; } // nothing to link to
    try {
      if (!dryRun) {
        mkdirSync(dirname(shared.path), { recursive: true });
        staged(shared.path, (tmp) => { for (const [rel, text] of Object.entries(FILES[skill])) { const f = join(tmp, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); } });
      }
      done.push({ skill, where: shared.path, how: "written" });
    } catch (e) { failed.push({ skill, where: shared.path, error: String(e?.message ?? e).slice(0, 160) }); continue; }
    for (const p of places.slice(0, -1).filter((x) => x.set)) {
      if (p.state === "theirs") { kept.push({ skill, where: p.path, why: NOT_OURS }); continue; }
      if (dryRun) { done.push({ skill, where: p.path, how: `for ${p.label}` }); continue; }
      try {
        mkdirSync(dirname(p.path), { recursive: true });
        // A link keeps one copy; Windows often refuses links without admin rights, so copy there (staged, like the shared one).
        let how;
        try {
          if (process.platform === "win32") throw 0;
          if (p.state === "ours") removePath(p.path);
          symlinkSync(shared.path, p.path, "dir"); how = "linked";
        } catch { staged(p.path, (tmp) => cpSync(shared.path, tmp, { recursive: true })); how = "copied"; }
        done.push({ skill, where: p.path, how: `${how} for ${p.label}` });
      } catch (e) { failed.push({ skill, where: p.path, error: String(e?.message ?? e).slice(0, 160) }); }
    }
  }
  return { ok: !failed.length, skill: sharedPath(home, SKILLS[0]), skills: SKILLS.map((s) => sharedPath(home, s)), installed: done,
    ...(kept.length ? { kept } : {}), ...(failed.length ? { failed } : {}),
    next: "Ask your agent to set routr up: it will follow references/setup.md in the skill. To start an orchestration, type /routr-orchestrate <your plan> ($routr-orchestrate in Codex)." };
}
