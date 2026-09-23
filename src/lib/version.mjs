// The base version: keep in step with package.json and the version line in SKILL.md (a test checks it). A release build stamps the exact
// tag version (for example 0.2.0-rc.1) over it at compile time, so `routr --version` names the build you are running.
const BASE = "0.1.17";
export const ROUTR_VERSION = typeof ROUTR_BUILD_VERSION === "string" ? ROUTR_BUILD_VERSION : BASE;
