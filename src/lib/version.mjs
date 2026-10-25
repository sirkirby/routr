// The git tag is the only place a version is set. In the repository this, package.json and the version line in SKILL.md
// read 0.0.0-dev (a test checks they agree); a release build stamps the tag's version into all three before compiling
// (scripts/stamp-version.mjs) and defines ROUTR_BUILD_VERSION, so `routr --version` names the build you are running.
const BASE = "0.0.0-dev";
export const ROUTR_VERSION = typeof ROUTR_BUILD_VERSION === "string" ? ROUTR_BUILD_VERSION : BASE;
// The release a version belongs to: a pre-release (0.2.0-rc.1) and a source checkout (0.0.0-dev) carry a suffix that the
// skill's version line does not.
export const baseVersion = (v) => String(v ?? "").split("-")[0];
// A version as routr writes one: semver's three numbers and an optional pre-release (0.8.1, 0.8.1-beta.2,
// 0.0.0-dev), numbers without leading zeros, in the pre-release too (semver 2.0). Anything else read back from
// a file is no version: compareVersions orders any string (0.9.invalid, 0.9.0-beta.01).
const N = String.raw`(?:0|[1-9]\d*)`, PRE = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION = new RegExp(`^${N}\\.${N}\\.${N}(?:-${PRE}(?:\\.${PRE})*)?$`);
export const isVersion = (v) => typeof v === "string" && VERSION.test(v);

// Semver 2.0 precedence, -1/0/1: the numeric core first; a release ranks above its own pre-releases; then the
// pre-release identifiers one by one, numbers numerically and below words, words by ASCII order (alpha < beta < rc),
// and a shorter set below a longer one that starts the same. Build metadata (+...) does not count. The first version
// compared any two pre-releases as equal, so 0.5.0-beta.2 never replaced 0.5.0-beta.1.
export function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v).trim().replace(/^v/, "").split("+")[0], i = s.indexOf("-"); // the first hyphen only: "rc-2" is one identifier
    return { n: (i < 0 ? s : s.slice(0, i)).split(".").map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0)), pre: i < 0 ? [] : s.slice(i + 1).split(".") };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0) ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  const num = (t) => /^\d+$/.test(t);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (num(p) && num(q)) return Number(p) > Number(q) ? 1 : -1;
    if (num(p) !== num(q)) return num(p) ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}
// True when a is newer than b.
export const newer = (a, b) => compareVersions(a, b) > 0;
