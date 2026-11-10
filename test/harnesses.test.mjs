// The harness registry is the one place that knows a harness: every entry declares every field the rest of routr reads
// from it, so a new harness that misses one fails here, not on a user's machine.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, KINDS, SOURCES } from "../src/lib/harnesses.mjs";
import { claudeSnapshot, codexSnapshot, readAgy } from "../src/lib/usage.mjs";
import { readCursor, refreshCursor } from "../src/lib/cursor-usage.mjs";
import { readKiro, refreshKiro } from "../src/lib/kiro-usage.mjs";
import { ADAPTERS } from "../src/lib/headless.mjs";
import { SUBSCRIPTIONS, USAGE_WINDOWS } from "../src/lib/otel-schema.mjs";
import { OWN_SKILL_FOLDERS } from "../src/lib/help.mjs";
import { scratch } from "./helpers.mjs";

const str = (v) => typeof v === "string" && v.length > 0;
const strs = (v) => Array.isArray(v) && v.every(str);
const fn = (v) => typeof v === "function";
const bool = (v) => typeof v === "boolean";
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Each field routr reads from an entry: `true` when every entry must declare it, and its shape. A shape returns the
// paths that are wrong ("" for the field itself), so a nested field is named when it is the one at fault.
const is = (ok) => (ok ? [] : [""]);
const plain = (check) => (v) => is(check(v));
const need = (o, keys) => keys.filter((k) => o[k] === undefined);
// Each key a shape knows, checked when present; any key it does not know is wrong, as is a value that is no object.
const strict = (spec, required = []) => (o) => {
  if (!obj(o)) return [""];
  return [...Object.entries(spec).flatMap(([k, check]) => (o[k] === undefined ? [] : check(o[k]).map((p) => (p ? `${k}.${p}` : k)))),
    ...Object.keys(o).filter((k) => !Object.hasOwn(spec, k)), ...need(o, required)];
};
const PLATFORMS = ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"];
const USAGE = strict({ source: plain(str), read: plain(fn), byHand: plain(str), windows: plain((v) => strs(v) && v.length > 0),
  check: plain(fn), fields: plain(strs), used: plain(fn), checkHelp: plain(str), readHelp: plain(str),
  // What `routr usage <name>` says when a fresh read leaves something behind: its warning, and the step for it.
  left: strict({ warning: plain(fn), next: plain(str) }, ["warning", "next"]),
  needsHerdrOn: plain((v) => strs(v) && v.every((p) => PLATFORMS.includes(p))), unexplainedNoWindows: plain(bool) }, ["source", "read", "byHand", "windows"]);
const FIELDS = {
  label: [true, plain(str)], executable: [true, plain(str)], app: [true, plain(str)], installAs: [true, plain(str)], shortLabel: [true, plain(str)],
  otelProvider: [true, plain(str)], permissions: [true, plain(strs)], model: [true, plain(str)], models: [true, plain(fn)],
  auth: [true, strict({ check: plain(strs), signedIn: plain(fn), signIn: plain(str), billing: plain(fn) }, ["check", "signedIn", "signIn"])],
  suggested: [true, (s) => is(obj(s) && ["basic", "standard", "strong"].includes(s.hardest_work) && typeof s.reserve === "number")],
  usage: [true, USAGE],
  skills: [false, plain(str)], effort: [false, plain(str)], effortValue: [false, plain(fn)], autoEffort: [false, plain(str)], autoEffortMeans: [false, plain(str)],
  noEffort: [false, plain(str)], remembersEffort: [false, plain(str)], dirFlag: [false, plain(str)], notes: [false, plain(fn)], subagents: [false, plain(fn)],
  trust: [false, plain(fn)], startup: [false, plain(str)], unknownModelRunsDefault: [false, plain(bool)], list: [false, plain(str)], openList: [false, plain(str)],
  efforts: [false, plain(fn)], quiet: [false, plain(strs)], interactive: [false, plain(strs)], promptFlag: [false, plain(str)], noStatus: [false, plain(bool)],
  // What differs in a herdr-core terminal: the same fields, each as plan() reads it.
  core: [false, strict({ interactive: plain(strs), permissions: plain(strs), trust: plain(fn), startup: plain(str) })],
  helper: [false, strict({ command: plain(fn), children: plain((v) => Array.isArray(v) && v.every((x) => x instanceof RegExp)), left: plain(fn) }, ["command", "children", "left"])],
  // A plain name: it is typed into a pane's shell (herdr.mjs's SHELLS) without quoting.
  privateConfig: [false, strict({ file: plain(str), variable: plain((v) => typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/.test(v)) }, ["file", "variable"])],
};
// What one entry gets wrong, as `field` or `field.nested` paths; [] when it is whole. A field read only when another is
// there is required with it: a fresh read (`usage.check`) keeps `fields`, heads its answer with `used` and is described
// by `checkHelp`; an effort meaning "the model's own default" (`autoEffort`) says what that means; one that is
// remembered (`remembersEffort`) needs an effort flag; and a harness with no effort flag says why one is refused.
function problems(h) {
  const out = [];
  for (const [field, [required, shape]] of Object.entries(FIELDS)) {
    if (!Object.hasOwn(h, field)) { if (required) out.push(field); continue; }
    out.push(...shape(h[field]).map((p) => (p ? `${field}.${p}` : field)));
  }
  out.push(...Object.keys(h).filter((k) => !Object.hasOwn(FIELDS, k)));
  if (obj(h.usage) && h.usage.check) out.push(...need(h.usage, ["fields", "used", "checkHelp"]).map((k) => `usage.${k}`));
  if (h.autoEffort && !h.autoEffortMeans) out.push("autoEffortMeans");
  if (h.remembersEffort && !h.effort) out.push("effort");
  if (!h.effort && !h.noEffort) out.push("noEffort");
  return out;
}

test("every harness declares every field routr reads from it, in the shape routr reads, and no field routr does not know", () => {
  for (const kind of KINDS) expect([kind, problems(HARNESSES[kind])]).toEqual([kind, []]);
});

test("an entry missing a field routr reads only in some cases, or with a nested field of the wrong shape, is caught", () => {
  const kiro = HARNESSES.kiro, cursor = HARNESSES.cursor;
  const without = (o, key) => { const c = { ...o }; delete c[key]; return c; };
  const broken = [
    [{ ...cursor, usage: without(cursor.usage, "fields") }, "usage.fields"],
    [{ ...cursor, usage: without(cursor.usage, "used") }, "usage.used"],
    [{ ...cursor, usage: without(cursor.usage, "checkHelp") }, "usage.checkHelp"],
    [{ ...kiro, usage: { ...kiro.usage, left: {} } }, "usage.left.warning"],
    [{ ...kiro, usage: { ...kiro.usage, left: {} } }, "usage.left.next"],
    [{ ...kiro, usage: { ...kiro.usage, left: { warning: "text", next: "step" } } }, "usage.left.warning"],
    [{ ...kiro, usage: { ...kiro.usage, left: { warning: () => null } } }, "usage.left.next"],
    [{ ...kiro, usage: { ...kiro.usage, windows: [] } }, "usage.windows"],
    [{ ...kiro, usage: { ...kiro.usage, stray: 1 } }, "usage.stray"],
    [{ ...cursor, usage: { ...cursor.usage, needsHerdrOn: ["windows"] } }, "usage.needsHerdrOn"],
    [{ ...kiro, core: { ...kiro.core, interactive: "chat" } }, "core.interactive"],
    [{ ...kiro, core: { ...kiro.core, permissions: "--trust-all-tools" } }, "core.permissions"],
    [{ ...kiro, core: { ...kiro.core, trust: ["--trust-workspace"] } }, "core.trust"],
    [{ ...kiro, core: { ...kiro.core, startup: 1 } }, "core.startup"],
    [{ ...kiro, core: { ...kiro.core, interactve: ["chat"] } }, "core.interactve"],
    [{ ...cursor, privateConfig: { file: ".cursor/cli-config.json" } }, "privateConfig.variable"],
    [{ ...cursor, privateConfig: { ...cursor.privateConfig, variable: "A B" } }, "privateConfig.variable"],
    [without(kiro, "autoEffortMeans"), "autoEffortMeans"],
    [without(kiro, "shortLabel"), "shortLabel"],
    [{ ...HARNESSES.claude, openList: true }, "openList"],
    [without(cursor, "noEffort"), "noEffort"],
    [{ ...cursor, remembersEffort: "/effort" }, "effort"],
  ];
  for (const [entry, path] of broken) expect([path, problems(entry)]).toEqual([path, expect.arrayContaining([path])]);
});

test("the lists routr sends and checks are the registry's own", () => {
  expect(SUBSCRIPTIONS).toEqual(KINDS);
  expect(Object.keys(SOURCES)).toEqual(KINDS);
  expect(new Set(USAGE_WINDOWS)).toEqual(new Set(KINDS.flatMap((k) => HARNESSES[k].usage.windows)));
  // Every harness runs headless (help names them all as headless workers), each by an adapter of its own.
  expect(Object.keys(ADAPTERS).sort()).toEqual([...KINDS].sort());
  // The one list help keeps in its own order: the harnesses with a skills folder of their own.
  expect(OWN_SKILL_FOLDERS.split(", ").sort()).toEqual(KINDS.filter((k) => HARNESSES[k].skills).map((k) => HARNESSES[k].label).sort());
  // The dashboard colours each account by its key, in both themes: a new harness needs its colour there.
  const page = readFileSync(new URL("../src/lib/dash.html", import.meta.url), "utf8");
  for (const kind of KINDS) expect([kind, page.match(new RegExp(`--${kind}: #`, "g"))?.length]).toEqual([kind, 2]);
});

test("each usage reader names only the windows its harness declares", async () => {
  const now = 1_800_000_000, names = (r) => r.windows.map((w) => w.name);
  const declared = (kind, got) => expect([kind, got.filter((n) => !HARNESSES[kind].usage.windows.includes(n))]).toEqual([kind, []]);
  const limit = (used_percentage) => ({ used_percentage, resets_at: now + 600 });
  declared("claude", names(claudeSnapshot({ ts: now, rate_limits: { five_hour: limit(10), seven_day: limit(20), spend_limit: limit(30) } }, now)));
  const win = { usedPercent: 10, windowDurationMins: 300, resetsAt: now + 600 };
  declared("codex", names(codexSnapshot({ primary: win, secondary: win, individualLimit: { remainingPercent: 50, resetsAt: Date.UTC(2027, 1, 1) / 1000 } }, "app-server", now, now)));
  declared("codex", names(codexSnapshot({ spendControlReached: true }, "app-server", now, now)));
  const groups = [{ name: "Gemini", buckets: ["5h", "weekly"].map((window) => ({ window, remaining_fraction: 0.5, reset_time: new Date((now + 600) * 1000).toISOString() })) }];
  const agy = await readAgy({ exec: async () => JSON.stringify({ command: { data: { groups } } }) });
  expect(names(agy)).toEqual(["5h", "weekly"]); declared("agy", names(agy));
  const dir = scratch("registry-windows");
  const cursorFile = join(dir, "cursor.json"), kiroFile = join(dir, "kiro.json");
  await refreshCursor({ file: cursorFile, nowSec: now, read: async () => ({ ok: true, subscription: "cursor", plan: "Pro", included_used_pct: 10, auto_used_pct: null, api_used_pct: null, headroom: 0.9 }) });
  const cursor = readCursor({ file: cursorFile, nowSec: now, off: true });
  expect(cursor.windows.length).toBeGreaterThan(0); declared("cursor", names(cursor));
  await refreshKiro({ file: kiroFile, nowSec: now, read: async () => ({ ok: true, subscription: "kiro", plan: "KIRO FREE", credits_used: 5, credits_limit: 50, used_pct: 10, resets_at: now + 86400, unrecognized_lines: 0, headroom: 0.9 }) });
  const kiro = readKiro({ file: kiroFile, nowSec: now, off: true });
  expect(kiro.windows.length).toBeGreaterThan(0); declared("kiro", names(kiro));
});
