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
import { scratch } from "./helpers.mjs";

const str = (v) => typeof v === "string" && v.length > 0;
const strs = (v) => Array.isArray(v) && v.every(str);
const fn = (v) => typeof v === "function";
const bool = (v) => typeof v === "boolean";
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Each field routr reads from an entry: `true` when every entry must declare it, and the shape it must have.
const FIELDS = {
  label: [true, str], executable: [true, str], app: [true, str], installAs: [true, str], otelProvider: [true, str],
  permissions: [true, strs], model: [true, str], models: [true, fn],
  auth: [true, (a) => obj(a) && strs(a.check) && fn(a.signedIn) && str(a.signIn) && (a.billing === undefined || fn(a.billing))],
  suggested: [true, (s) => obj(s) && ["basic", "standard", "strong"].includes(s.hardest_work) && typeof s.reserve === "number"],
  usage: [true, (u) => obj(u) && str(u.source) && fn(u.read) && str(u.byHand) && strs(u.windows) && u.windows.length > 0
    && ["check", "used"].every((k) => u[k] === undefined || fn(u[k])) && (u.fields === undefined || strs(u.fields)) && (u.left === undefined || obj(u.left))],
  skills: [false, str], effort: [false, str], effortValue: [false, fn], autoEffort: [false, str], noEffort: [false, str],
  remembersEffort: [false, str], dirFlag: [false, str], notes: [false, fn], subagents: [false, fn], trust: [false, fn],
  startup: [false, str], unknownModelRunsDefault: [false, bool], list: [false, str], openList: [false, bool], efforts: [false, fn],
  quiet: [false, strs], interactive: [false, strs], promptFlag: [false, str], noStatus: [false, bool],
  core: [false, (c) => obj(c) && Object.keys(c).every((k) => ["interactive", "permissions", "trust", "startup"].includes(k))],
  helper: [false, (h) => obj(h) && fn(h.command) && Array.isArray(h.children) && fn(h.left)],
  // A plain name: it is typed into a pane's shell (herdr.mjs's SHELLS) without quoting.
  privateConfig: [false, (c) => obj(c) && str(c.file) && /^[A-Z_][A-Z0-9_]*$/.test(c.variable)],
};

test("every harness declares every field routr reads from it, in the shape routr reads, and no field routr does not know", () => {
  for (const kind of KINDS) {
    const h = HARNESSES[kind];
    for (const [field, [required, shape]] of Object.entries(FIELDS)) {
      if (required) expect([kind, field, Object.hasOwn(h, field)]).toEqual([kind, field, true]);
      if (Object.hasOwn(h, field)) expect([kind, field, shape(h[field])]).toEqual([kind, field, true]);
    }
    expect(Object.keys(h).filter((k) => !Object.hasOwn(FIELDS, k)).map((k) => `${kind}.${k}`)).toEqual([]);
    // A harness with no effort flag says why one is refused (plan throws it).
    expect([kind, Boolean(h.effort || h.noEffort)]).toEqual([kind, true]);
    if (h.remembersEffort) expect([kind, Boolean(h.effort)]).toEqual([kind, true]);
  }
});

test("the lists routr sends and checks are the registry's own", () => {
  expect(SUBSCRIPTIONS).toEqual(KINDS);
  expect(Object.keys(SOURCES)).toEqual(KINDS);
  expect(new Set(USAGE_WINDOWS)).toEqual(new Set(KINDS.flatMap((k) => HARNESSES[k].usage.windows)));
  // A headless adapter is for a harness the registry knows.
  expect(Object.keys(ADAPTERS).filter((k) => !KINDS.includes(k))).toEqual([]);
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
