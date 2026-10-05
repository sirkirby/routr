// `routr skill install`: write routr's skills (the routr skill with the guides agents read, and routr-orchestrate,
// which only the user starts) into the shared skills folder, and link each into every harness's own skills folder, so
// a machine with no Node and no Bun needs nothing but the routr binary. The files are embedded at build time.
// routr touches only what is provably its own (`owner` below): anything else of the same name is kept and reported.
import { accessSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { HARNESSES, KINDS, SKILLS } from "./harnesses.mjs";
import skillMd from "../../skills/routr/SKILL.md" with { type: "text" };
import worker from "../../skills/routr/references/worker.md" with { type: "text" };
import orchestrator from "../../skills/routr/references/orchestrator.md" with { type: "text" };
import harnesses from "../../skills/routr/references/harnesses.md" with { type: "text" };
import setup from "../../skills/routr/references/setup.md" with { type: "text" };
import orchestrateMd from "../../skills/routr-orchestrate/SKILL.md" with { type: "text" };
import orchestrateYaml from "../../skills/routr-orchestrate/agents/openai.yaml" with { type: "text" };
import { home as userHome } from "./runtime.mjs";
import { ROUTR_VERSION } from "./version.mjs";

// Every file of each skill in SKILLS, by its path inside the skill's folder (literal imports, so the binary bundles them).
export const FILES = {
  routr: { "SKILL.md": skillMd, "references/worker.md": worker, "references/orchestrator.md": orchestrator, "references/harnesses.md": harnesses, "references/setup.md": setup },
  "routr-orchestrate": { "SKILL.md": orchestrateMd, "agents/openai.yaml": orchestrateYaml },
};
// Harnesses that read their own skills folder rather than the shared one (`skills` in the registry). Codex and Cursor
// read ~/.agents/skills.
const LINKED = Object.fromEntries(KINDS.filter((n) => HARNESSES[n].skills).map((n) => [HARNESSES[n].label, HARNESSES[n].skills]));

// ---- What is routr's, by structure, never by reading a skill's text. Each folder routr writes holds a manifest,
// `.routr-install.json`: { skill, version, files } with every file routr wrote there. A folder is routr's when that
// manifest is a regular file that parses and names that skill (a Windows copy carries the same manifest). One
// exception, once: a `routr` folder written before manifests (routr up to 0.5.0-beta.1) is known by `name: routr` in
// its frontmatter and its guides, and gets its manifest at the next install. A harness link is routr's only when it
// points at routr's shared folder and that folder is itself routr's; any other link (a developer's, into a checkout, or
// to a shared folder that is itself their link) is never followed, replaced or removed.
export const MANIFEST = ".routr-install.json";
const LEGACY = { routr: ["references/worker.md", "references/orchestrator.md"] };
export const sharedPath = (home, skill) => join(home, ".agents/skills", skill);
// A relative path that stays inside the folder: a manifest is never a way to reach a file outside it.
const inside = (f) => typeof f === "string" && f && !isAbsolute(f) && !f.split(/[\\/]/).some((s) => s === ".." || s === "");
// The manifest routr wrote in `dir` for `skill`, or null.
export function manifest(dir, skill) {
  try {
    if (!lstatSync(join(dir, MANIFEST)).isFile()) return null;
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    return m?.skill === skill && Array.isArray(m.files) && m.files.every(inside) ? m : null;
  } catch { return null; }
}
const legacy = (dir, skill) => {
  if (!LEGACY[skill] || !LEGACY[skill].every((f) => existsSync(join(dir, f)))) return false;
  try { return new RegExp(`^name:\\s*${skill}\\s*$`, "m").test(readFileSync(join(dir, "SKILL.md"), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ""); } catch { return false; }
};
// "absent", "ours", or "theirs" for the thing at `path` that would be `skill`.
export function owner(home, skill, path) {
  let st; try { st = lstatSync(path); } catch { return "absent"; }
  const shared = sharedPath(home, skill);
  if (st.isSymbolicLink()) {
    if (path === shared) return "theirs"; // routr never makes its shared copy a link
    try { return resolve(dirname(path), readlinkSync(path)) === shared && owner(home, skill, shared) === "ours" ? "ours" : "theirs"; } catch { return "theirs"; }
  }
  if (!st.isDirectory()) return "theirs";
  return manifest(path, skill) || legacy(path, skill) ? "ours" : "theirs";
}
// The files routr wrote in an owned folder: its manifest's list, or (before manifests) what this routr ships.
export const ownedFiles = (dir, skill) => manifest(dir, skill)?.files ?? Object.keys(FILES[skill]);
// Every file routr's copy at `dir` should have that is not a readable regular file there (a folder in place of a file
// counts as missing): its manifest's list and what this routr ships, and the manifest itself.
export function missingFiles(skill, dir) {
  const want = [...new Set([...(manifest(dir, skill)?.files ?? []), ...Object.keys(FILES[skill]), MANIFEST])];
  return want.filter((f) => { try { if (!statSync(join(dir, f)).isFile()) return true; accessSync(join(dir, f), constants.R_OK); return false; } catch { return true; } });
}
// Every entry in a folder that is not a folder (files, links), as relative paths. Links are listed, never followed.
const entries = (dir, pre = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() && !e.isSymbolicLink() ? entries(join(dir, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]));
// What a user added to routr's folder: everything routr did not write there.
export const extraFiles = (dir, skill) => { const own = new Set([...ownedFiles(dir, skill), MANIFEST].map((f) => f.replace(/\\/g, "/"))); try { return entries(dir).filter((f) => !own.has(f)); } catch { return []; } };
// Remove routr's files from its folder, then each folder left empty; the folder itself only if nothing is left.
// Returns what stayed (the user's own files).
export function removeOwned(dir, skill) {
  if (lstatSync(dir).isSymbolicLink()) { unlinkSync(dir); return []; }
  const left = extraFiles(dir, skill);
  for (const f of [...ownedFiles(dir, skill), MANIFEST]) { try { const p = join(dir, f); if (!lstatSync(p).isDirectory()) unlinkSync(p); } catch {} }
  const prune = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) prune(join(d, e.name)); if (!readdirSync(d).length) rmdirSync(d); };
  prune(dir);
  return left;
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
// Replace routr's folder at `dest` (or make it): `fill` writes routr's files, and anything the user added to the old one
// comes along, unless it sits where routr now writes a file. Returns what was carried over.
function writeOwned(dest, skill, fill) {
  let extras = [];
  try { if (lstatSync(dest).isDirectory()) extras = extraFiles(dest, skill).filter((f) => !Object.hasOwn(FILES[skill], f)); } catch {}
  staged(dest, (tmp) => {
    fill(tmp);
    for (const f of extras) {
      const from = join(dest, f), to = join(tmp, f);
      mkdirSync(dirname(to), { recursive: true });
      if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to); else copyFileSync(from, to);
    }
  });
  return extras;
}

// Each skill the same way: written to ~/.agents/skills/<name>, then linked (copied on Windows) into each harness's folder
// that is set up. Only what is absent or routr's is written; the rest is reported in `kept`, a failure in `failed`.
export function installSkill({ home = userHome(), dryRun = false } = {}) {
  const done = [], kept = [], failed = [];
  for (const skill of SKILLS) {
    const places = skillPlaces(home).filter((p) => p.skill === skill), shared = places.at(-1);
    if (shared.state === "theirs") { kept.push({ skill, where: shared.path, why: NOT_OURS }); continue; } // nothing to link to
    const userFiles = (dir, extras) => { for (const f of extras) kept.push({ skill, where: join(dir, f), why: "yours, in routr's folder: kept" }); };
    try {
      if (!dryRun) {
        mkdirSync(dirname(shared.path), { recursive: true });
        // routr's files and its manifest, in the same staged write: the folder is routr's exactly when it is complete.
        userFiles(shared.path, writeOwned(shared.path, skill, (tmp) => {
          for (const [rel, text] of Object.entries(FILES[skill])) { const f = join(tmp, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
          writeFileSync(join(tmp, MANIFEST), JSON.stringify({ skill, version: ROUTR_VERSION, files: Object.keys(FILES[skill]) }, null, 1) + "\n");
        }));
      }
      done.push({ skill, where: shared.path, how: "written" });
    } catch (e) { failed.push({ skill, where: shared.path, error: String(e?.message ?? e).slice(0, 160) }); continue; }
    // Read each harness's place again now that routr's shared copy is in place: a link to it is routr's only from here.
    for (const p of places.slice(0, -1).filter((x) => x.set).map((x) => (dryRun ? x : { ...x, state: owner(home, skill, x.path) }))) {
      if (p.state === "theirs") { kept.push({ skill, where: p.path, why: NOT_OURS }); continue; }
      if (dryRun) { done.push({ skill, where: p.path, how: `for ${p.label}` }); continue; }
      try {
        mkdirSync(dirname(p.path), { recursive: true });
        // A link keeps one copy; Windows often refuses links without admin rights, so copy there (staged, like the shared
        // one, with its manifest). A copy routr made stays a copy, so nothing the user added to it is lost.
        let how;
        const copy = () => { userFiles(p.path, writeOwned(p.path, skill, (tmp) => cpSync(shared.path, tmp, { recursive: true }))); how = "copied"; };
        if (process.platform === "win32" || (p.state === "ours" && !lstatSync(p.path).isSymbolicLink())) copy();
        else try { if (p.state === "ours") unlinkSync(p.path); symlinkSync(shared.path, p.path, "dir"); how = "linked"; } catch { copy(); }
        done.push({ skill, where: p.path, how: `${how} for ${p.label}` });
      } catch (e) { failed.push({ skill, where: p.path, error: String(e?.message ?? e).slice(0, 160) }); }
    }
  }
  return { ok: !failed.length, skill: sharedPath(home, SKILLS[0]), skills: SKILLS.map((s) => sharedPath(home, s)), installed: done,
    ...(kept.length ? { kept } : {}), ...(failed.length ? { failed } : {}),
    next: "Ask your agent to set routr up: it will follow references/setup.md in the skill. To start an orchestration, type /routr-orchestrate <your plan> ($routr-orchestrate in Codex)." };
}
