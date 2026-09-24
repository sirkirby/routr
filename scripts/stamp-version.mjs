// Release builds only: write the tag's version into the three files that carry one, in the CI workspace, before
// `bun build --compile` embeds them. In the repository they always read 0.0.0-dev: the git tag is the only place a
// version is set, so there is nothing to bump before a release and nothing to write back after one.
// usage: bun scripts/stamp-version.mjs <X.Y.Z[-rc.N]> [root]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, root = "."] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/.test(version ?? "")) { console.error(`not a release version: ${version}`); process.exit(1); }
const base = version.split("-")[0]; // the skill and package.json carry the base version; the binary reports the full one
const edits = [
  ["src/lib/version.mjs", /const BASE = "[^"]*";/, `const BASE = "${version}";`],
  ["package.json", /"version":"[^"]*"/, `"version":"${base}"`],
  ["skills/routr/SKILL.md", /^(\s*version:\s*)"[^"]*"/m, `$1"${base}"`],
];
for (const [file, re, to] of edits) {
  const path = join(root, file), text = readFileSync(path, "utf8");
  if (!re.test(text)) { console.error(`${file}: no version to stamp`); process.exit(1); }
  writeFileSync(path, text.replace(re, to));
}
console.log(`stamped ${version} (base ${base}) into ${edits.map(([f]) => f).join(", ")}`);
