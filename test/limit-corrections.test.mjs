import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, readUsage, refreshLimit } from "../src/lib/harnesses.mjs";
import { signInState } from "../src/lib/signin.mjs";
import { claudeSnapshot, codexSnapshot, NO_WINDOWS_AFTER_ANSWER, summarize } from "../src/lib/usage.mjs";
import { parseClaudePanel, readClaudePanel, refreshClaudePanel } from "../src/lib/claude-panel.mjs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { cfg, scratch } from "./helpers.mjs";
const T = Date.UTC(2026, 10, 3, 15) / 1000;
const panel = (section) => `Settings Status Config Usage Stats\nUsage credits\n${section}\nEsc to cancel`;
const limit = "████ 100% used\n$15.05 / $15.00 spent · Resets Dec 1 (America/Detroit)";
const primary = (extra = {}) => ({ pool: "claude", source: "claude /usage", headroom: null, windows: [], reason: NO_WINDOWS_AFTER_ANSWER, class: "unknown", ...extra });

for (const [name, u, b] of [
  ["print failure", primary({ failure: { code: "no_response" } }), { billing: "metered", when: "no_windows" }],
  ["signed-in unreadable auth", primary(), null],
]) test(`review 1: a trusted cap survives ${name}`, async () => {
  const file = join(scratch("cap-retained"), "panel.json");
  await refreshClaudePanel({ file, nowSec: T, read: async () => ({ ok: true, used_pct: 100, resets_at: T + 86400 }) });
  await refreshClaudePanel({ file, nowSec: T + 1, read: async () => ({ ok: false, code: "invalid_response" }) });
  const [row] = await readUsage(["claude"], {}, { why: async () => null, billing: async () => ({ billing: b }), sources: { claude: {
    read: async () => u, limit: { ...HARNESSES.claude.usage.limit, read: (o) => readClaudePanel({ ...o, file, nowSec: T + 1, background: false }) },
  } } });
  expect(row).toMatchObject({ class: "capped", headroom: 0, kept: { source: "claude snapshot" } });
  const c = cfg({ now: (T + 1) * 1000, subscriptions: { claude: { ...cfg().subscriptions.claude, billing: "metered" } } });
  expect(rankSubscriptions("basic", [row], c).candidates).toEqual({ normal: [], fallback: [] });
});

test("review 2: fresh readings after a reset stay full, while pre-reset kept readings roll", () => {
  const w = { name: "spend_limit", usedPct: 100, windowMin: null, resetsAt: T - 1 };
  expect(summarize({ pool: "x", source: "x", ts: T, nowSec: T + 1, windows: [w] }).headroom).toBe(0);
  expect(summarize({ pool: "x", source: "x", ts: T - 100, nowSec: T + 1, windows: [w] }).headroom).toBe(1);
  expect(claudeSnapshot({ ts: T, rate_limits: { five_hour: { used_percentage: 100, resets_at: T - 1 } } }, T + 1).headroom).toBe(0);
  expect(codexSnapshot({ individualLimit: { remainingPercent: 0, resetsAt: T - 1 }, spendControlReached: true }, "app-server", T, T + 1).headroom).toBe(0);
});

for (const [name, text] of [
  ["spent followed by limit", panel("$15.05 spent\n$15.00 limit · Resets Dec 1 (America/Detroit)")],
  ["spent followed by percent", panel("$15.05 spent\n████ 100% used")],
  ["spent followed by reached", panel("$15.05 spent\nSpend limit reached")],
  ["missing footer", "Settings Status Config Usage Stats\nUsage credits\n$15.05 spent"],
  ["two limits", panel(`████ 3% used\n$0.45 / $15.00 spent · Resets Dec 1 (America/Detroit)\n${limit}`)],
  ["grouped percent", panel(limit.replace("100%", "1,050%"))],
  ["unrelated extra text", panel(`${limit}\nAnother budget applies`)],
  ["garbled spent amount", panel("$,,,1.00 spent")],
  ["garbled ratio amount", panel(limit.replace("$15.05", "$1,,5.05"))],
  ["not a panel screen", `Usage credits\n${limit}\nEsc to cancel`],
]) test(`review 3: reject ${name}`, () => { expect(parseClaudePanel(text, T)).toBeNull(); });

test("review 4: a non-applicable refresh publishes nothing over a kept cap", async () => {
  const file = join(scratch("cap-not-applicable"), "panel.json"), name = "limit-refresh-fixture";
  await refreshClaudePanel({ file, nowSec: T, read: async () => ({ ok: true, used_pct: 100, resets_at: T + 86400 }) });
  const before = readFileSync(file, "utf8");
  const h = { executable: "fixture-not-a-harness", auth: { check: [], signedIn: () => true }, usage: {
    live: async () => primary({ headroom: 0.5, windows: [{ name: "five_hour", usedPct: 50 }] }),
    limit: { ...HARNESSES.claude.usage.limit, refresh: (o) => refreshClaudePanel({ ...o, file }), live: async () => { throw new Error("panel must not run"); } },
  } };
  HARNESSES[name] = h;
  try {
    await signInState(name, h, { fresh: true, ask: async () => ({ out: "fixture", code: 0 }) });
    await refreshLimit(name);
    expect(readFileSync(file, "utf8")).toBe(before);
  } finally { delete HARNESSES[name]; }
});

test("date-only reset handles year boundaries and DST without rolling a fresh full window", async () => {
  const { panelReset } = await import("../src/lib/claude-panel.mjs");
  const jan1 = Date.UTC(2027, 0, 1, 2) / 1000;
  expect(panelReset("Dec 31 (America/Detroit)", jan1)).toBe(Date.UTC(2027, 0, 1, 4, 59, 59) / 1000);
  expect(panelReset("Nov 1 (America/Detroit)", Date.UTC(2026, 10, 1, 6) / 1000)).toBe(Date.UTC(2026, 10, 2, 4, 59, 59) / 1000);
  expect(panelReset("Mar 8 (America/Detroit)", Date.UTC(2026, 2, 8, 6) / 1000)).toBe(Date.UTC(2026, 2, 9, 3, 59, 59) / 1000);
});

test("complete real panel fixtures pass through snapshots, readUsage and candidates without dollar text", async () => {
  const hit = readFileSync(new URL("./fixtures/admin-limits/claude-panel.txt", import.meta.url), "utf8");
  const none = readFileSync(new URL("./fixtures/admin-limits/claude-panel-no-limit.txt", import.meta.url), "utf8");
  for (const [text, used, candidate] of [[hit, 100, false], [panel("█████▋                                             11% used\n$11.28 / $100.00 spent · Resets Dec 1 (America/Detroit)"), 11, true], [none, null, true]]) {
    const file = join(scratch("panel-end-to-end"), "panel.json");
    const r = parseClaudePanel(text.replaceAll("\n", "\r\n"), T);
    expect(r.used_pct).toBe(used);
    await refreshClaudePanel({ file, nowSec: T, read: async () => ({ ok: true, ...r }) });
    const rows = await readUsage(["claude"], {}, { why: async () => null, billing: async () => ({ billing: { billing: "metered", when: "no_windows" } }), sources: { claude: {
      read: async () => primary(), limit: { ...HARNESSES.claude.usage.limit, read: () => readClaudePanel({ file, nowSec: T + 1, background: false }) },
    } } });
    const config = cfg({ now: (T + 1) * 1000, subscriptions: { claude: { ...cfg().subscriptions.claude, use: "normal", billing: "metered" } } });
    const ranked = rankSubscriptions("basic", rows, config);
    expect(ranked.candidates.normal.includes("claude")).toBe(candidate);
    expect(JSON.stringify(ranked)).not.toMatch(/\$\d|Usage credits|Plugin skill-listing/);
  }
});


test("unknown signed-in applicability fails the smoke instead of silently skipping the limit", async () => {
  const { smokeUsage } = await import("../scripts/smoke-usage.mjs");
  const lines = [];
  const failed = await smokeUsage({ config: { subscriptions: { claude: {} } }, ready: async () => null,
    billing: async () => ({ billing: null, limitStatus: null }), log: (s) => lines.push(s), sources: { claude: {
      source: "claude /usage", live: async () => primary(), limit: HARNESSES.claude.usage.limit,
    } }, live: { claude: async () => primary() } });
  expect(failed).toBeGreaterThan(0);
  expect(lines).toContain("claude limit: FAILED (limit_unverified)");
  expect(lines.join("\n")).not.toContain("NOT EXERCISED");
});

test("only successful print windows or recognised non-Enterprise status bypass the held limit", async () => {
  for (const [u, status, shouldRead] of [
    [primary({ headroom: 0.5, windows: [{ usedPct: 50 }] }), null, false],
    [primary({ headroom: 0.5, windows: [{ usedPct: 50 }], failure: { code: "no_response" } }), null, true],
    [primary({ source: "statusline", headroom: 0.5, windows: [{ usedPct: 50 }] }), null, true],
    [primary(), "not_applicable", false],
    [primary(), null, true],
  ]) {
    let read = false;
    const [row] = await readUsage(["claude"], {}, { why: async () => null, billing: async () => ({ limitStatus: status }), sources: { claude: {
      read: async () => u, limit: { ...HARNESSES.claude.usage.limit, read: async (o) => { read = true; expect(o.background).toBe(false); return summarize({ pool: "claude", cls: "capped", ts: T, nowSec: T, windows: [{ usedPct: 100 }] }); } },
    } } });
    expect(read).toBe(shouldRead);
    if (read) expect(row.kept.source).toBe("claude");
  }
});
