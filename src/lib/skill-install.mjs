// `routr skill install`: write routr's skills (the routr skill with the guides agents read, and routr-orchestrate,
// which only the user starts) into the shared skills folder, and link each into every harness's own skills folder, so
// a machine with no Node and no Bun needs nothing but the routr binary. The files are embedded at build time.
// routr touches only what is provably its own (`owner` below): anything else of the same name is kept and reported.
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
// exception, once: a `routr` folder with no manifest at all, written before manifests (routr up to 0.5.0-beta.1), is
// known by `name: routr` in its frontmatter and its guides, and gets its manifest at the next install. A harness link is
// routr's only when it points at routr's shared folder and that folder is itself routr's; any other link (a
// developer's, into a checkout, or to a shared folder that is itself their link) is never followed, replaced or
// removed, and no file is written or removed through a link inside a skill folder. routr's folder holding anything it
// did not write is left as it is until the person clears it. Known limit: routr trusts its receipt, so a manifest the
// user copies into another folder makes routr treat that folder as its own.
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
// The first folder between the user's home (not home itself) and `path` (not `path` itself) that is a link, or null.
// From the final review: owner() looked only at the skill folder and linkAbove() only inside it, so with
// ~/.agents/skills itself a link into a developer's checkout holding the legacy routr skill, install took the checkout's
// folder for routr's, overwrote an uncommitted guide there, wrote a manifest into it, and uninstall planned to remove it.
// A place under a linked folder is never routr's, whatever it holds: routr writes, links and removes nothing there.
export function linkedAncestor(home, path) {
  const rel = relative(home, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  for (let i = 1; i < parts.length; i++) {
    const p = join(home, ...parts.slice(0, i));
    try { if (lstatSync(p).isSymbolicLink()) return p; } catch { return null; } // a missing folder: nothing below it exists
  }
  return null;
}
export const linkedWhy = (above) => `${above} is a link: routr writes, links and removes nothing through it, so this is left as it is`;
// "absent", "ours", or "theirs" for the thing at `path` that would be `skill`. Under a linked folder it is never "ours".
export function owner(home, skill, path) {
  let st; try { st = lstatSync(path); } catch { return "absent"; }
  if (linkedAncestor(home, path)) return "theirs";
  const shared = sharedPath(home, skill);
  if (st.isSymbolicLink()) {
    if (path === shared) return "theirs"; // routr never makes its shared copy a link
    try { return resolve(dirname(path), readlinkSync(path)) === shared && owner(home, skill, shared) === "ours" ? "ours" : "theirs"; } catch { return "theirs"; }
  }
  if (!st.isDirectory()) return "theirs";
  // The legacy rule fails closed: only where there is no manifest at all. One that is invalid, a link, or another
  // skill's makes the folder someone else's.
  return manifest(path, skill) || (!present(join(path, MANIFEST)) && legacy(path, skill)) ? "ours" : "theirs";
}
const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };
// The files routr wrote in an owned folder: its manifest's list, or (before manifests) what this routr ships. The second
// only for the grandfathered legacy folder (no manifest at all, and the legacy rule holds). From the final review: a
// folder with no manifest, swapped in while uninstall's prompt waited, had its SKILL.md and agents/openai.yaml deleted
// by this fallback. Any other folder lists nothing of routr's.
export const ownedFiles = (dir, skill) => manifest(dir, skill)?.files ?? (!present(join(dir, MANIFEST)) && legacy(dir, skill) ? Object.keys(FILES[skill]) : []);
// Is any folder between `root` and `rel` (not `root` itself, not the target) a link? routr never writes, renames or
// deletes through one: a link inside a skill folder could point anywhere (a user's real files).
export function linkAbove(root, rel) {
  const parts = String(rel).split(/[\\/]/);
  for (let i = 1; i < parts.length; i++) { try { if (lstatSync(join(root, ...parts.slice(0, i))).isSymbolicLink()) return true; } catch { return false; } }
  return false;
}
// Write one file of routr's inside a folder it is filling, never through a link.
function writeInside(root, rel, text) {
  if (linkAbove(root, rel)) throw new Error(`${join(root, rel)}: a folder above it is a link, not followed`);
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
// Every file routr's copy at `dir` should have that is not a readable regular file there (a folder in place of a file
// counts as missing): its manifest's list and what this routr ships, and the manifest itself.
export function missingFiles(skill, dir) {
  const want = [...new Set([...(manifest(dir, skill)?.files ?? []), ...Object.keys(FILES[skill]), MANIFEST])];
  return want.filter((f) => { try { if (!statSync(join(dir, f)).isFile()) return true; accessSync(join(dir, f), constants.R_OK); return false; } catch { return true; } });
}
// Every entry in a folder that is not a folder (files, links), as relative paths. Links are listed, never followed. A
// folder that cannot be read is listed as itself, marked unreadable: what it holds is unknown, so it counts as not
// routr's and the copy is left as it is (from the review of ef16898: an unreadable folder of the user's read as empty,
// and a reinstall moved it aside).
const entries = (dir, pre = "") => {
  let list; try { list = readdirSync(dir, { withFileTypes: true }); } catch { return [`${pre || "./"}(unreadable)`]; }
  return list.flatMap((e) => (e.isDirectory() && !e.isSymbolicLink() ? entries(join(dir, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]));
};
// What is in routr's folder that routr did not write there (a link where a folder was counts: it is not routr's).
export const extraFiles = (dir, skill) => { const own = new Set([...ownedFiles(dir, skill), MANIFEST].map((f) => f.replace(/\\/g, "/"))); return entries(dir).filter((f) => !own.has(f)); };
export const hasExtras = (dir, extras) => `${dir} has files routr didn't write (${extras.join(", ")}): remove them or the folder, then run \`routr skill install\``;
// Remove routr's files from its folder: each listed file, never through a link; the manifest only once all of them are
// gone; then each folder left empty, the folder itself only if nothing is left. Returns what stayed (`left`: the
// user's, `failed`: what could not be removed).
export function removeOwned(dir, skill) {
  if (lstatSync(dir).isSymbolicLink()) { unlinkSync(dir); return { left: [], failed: [] }; }
  const left = extraFiles(dir, skill), failed = [];
  for (const f of ownedFiles(dir, skill)) {
    const p = join(dir, f);
    if (linkAbove(dir, f)) { failed.push(`${p}: a folder above it is a link, not followed`); continue; }
    try { if (lstatSync(p).isDirectory()) failed.push(`${p}: a folder where routr wrote a file`); else unlinkSync(p); }
    catch (e) { if (e?.code !== "ENOENT") failed.push(`${p}: ${String(e?.message ?? e).slice(0, 100)}`); }
  }
  if (!failed.length) try { unlinkSync(join(dir, MANIFEST)); } catch (e) { if (e?.code !== "ENOENT") failed.push(`${join(dir, MANIFEST)}: ${String(e?.message ?? e).slice(0, 100)}`); }
  const prune = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) prune(join(d, e.name)); if (!readdirSync(d).length) rmdirSync(d); };
  try { prune(dir); } catch (e) { failed.push(`${dir}: ${String(e?.message ?? e).slice(0, 100)}`); }
  return { left, failed };
}
// Every place a skill of routr's can be, harness folders first (links before the folder they point at), each with its
// owner. `set`: that harness is set up on this machine (the folder above its skills folder exists).
export function skillPlaces(home = userHome()) {
  return SKILLS.flatMap((skill) => [
    ...Object.entries(LINKED).map(([label, rel]) => ({ skill, label, path: join(home, rel, skill), set: existsSync(dirname(join(home, rel))) })),
    { skill, label: null, path: sharedPath(home, skill), set: true },
  ].map((p) => { const above = linkedAncestor(home, p.path); return { ...p, state: owner(home, skill, p.path), ...(above ? { above } : {}) }; }));
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
// A real folder of routr's holding anything routr did not write is left exactly as it is: routr neither replaces nor
// merges it (the person decides what to keep). Returns that folder's extra entries, or none.
const extrasIn = (path, skill) => { try { return lstatSync(path).isDirectory() ? extraFiles(path, skill) : []; } catch { return []; } };

// Each skill the same way: written to ~/.agents/skills/<name>, then linked (copied on Windows) into each harness's folder
// that is set up. Only what is absent or routr's (and holds nothing else) is written; the rest is reported in `kept`,
// a failure in `failed`.
export function installSkill({ home = userHome(), dryRun = false } = {}) {
  const done = [], kept = [], failed = [];
  for (const skill of SKILLS) {
    const places = skillPlaces(home).filter((p) => p.skill === skill), shared = places.at(-1);
    // First, absent or not: under a linked folder nothing is written, not even a new folder (linkedAncestor).
    if (shared.above) { kept.push({ skill, where: shared.path, why: linkedWhy(shared.above) }); continue; } // nothing to link to
    if (shared.state === "theirs") { kept.push({ skill, where: shared.path, why: NOT_OURS }); continue; } // nothing to link to
    const extra = shared.state === "ours" ? extrasIn(shared.path, skill) : [];
    if (extra.length) { kept.push({ skill, where: shared.path, why: hasExtras(shared.path, extra) }); continue; }
    const receipt = JSON.stringify({ skill, version: ROUTR_VERSION, files: Object.keys(FILES[skill]) }, null, 1) + "\n";
    try {
      if (!dryRun) {
        mkdirSync(dirname(shared.path), { recursive: true });
        // routr's files and its manifest, in the same staged write: the folder is routr's exactly when it is complete.
        staged(shared.path, (tmp) => {
          for (const [rel, text] of Object.entries(FILES[skill])) writeInside(tmp, rel, text);
          writeInside(tmp, MANIFEST, receipt);
        });
      }
      done.push({ skill, where: shared.path, how: "written" });
    } catch (e) { failed.push({ skill, where: shared.path, error: String(e?.message ?? e).slice(0, 160) }); continue; }
    // Read each harness's place again now that routr's shared copy is in place: a link to it is routr's only from here.
    for (const p of places.slice(0, -1).filter((x) => x.set).map((x) => (dryRun ? x : { ...x, state: owner(home, skill, x.path) }))) {
      if (p.above) { kept.push({ skill, where: p.path, why: linkedWhy(p.above) }); continue; }
      if (p.state === "theirs") { kept.push({ skill, where: p.path, why: NOT_OURS }); continue; }
      const more = p.state === "ours" ? extrasIn(p.path, skill) : [];
      if (more.length) { kept.push({ skill, where: p.path, why: hasExtras(p.path, more) }); continue; }
      if (dryRun) { done.push({ skill, where: p.path, how: `for ${p.label}` }); continue; }
      try {
        mkdirSync(dirname(p.path), { recursive: true });
        // A link keeps one copy; Windows often refuses links without admin rights, so copy there (staged, like the shared
        // one, with its manifest: routr's files only, written afresh, never through a link). A copy routr made stays a copy.
        let how;
        const copy = () => { staged(p.path, (tmp) => { for (const [rel, text] of Object.entries(FILES[skill])) writeInside(tmp, rel, text); writeInside(tmp, MANIFEST, receipt); }); how = "copied"; };
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
