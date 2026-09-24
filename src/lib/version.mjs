// The git tag is the only place a version is set. In the repository this, package.json and the version line in SKILL.md
// read 0.0.0-dev (a test checks they agree); a release build stamps the tag's version into all three before compiling
// (scripts/stamp-version.mjs) and defines ROUTR_BUILD_VERSION, so `routr --version` names the build you are running.
const BASE = "0.0.0-dev";
export const ROUTR_VERSION = typeof ROUTR_BUILD_VERSION === "string" ? ROUTR_BUILD_VERSION : BASE;
// The release a version belongs to: a pre-release (0.2.0-rc.1) and a source checkout (0.0.0-dev) carry a suffix that the
// skill's version line does not.
export const baseVersion = (v) => String(v ?? "").split("-")[0];
