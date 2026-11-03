import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudePanelScreen, claudePanelUsage, panelReset, parseClaudePanel, readClaudePanel, refreshClaudePanel } from "../src/lib/claude-panel.mjs";
import { codexSnapshot, monthMinutes, NO_WINDOWS_AFTER_ANSWER, readClaude, readCodex, readCodexLive, summarize } from "../src/lib/usage.mjs";
import { HARNESSES, readUsage } from "../src/lib/harnesses.mjs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { cfg, scratch } from "./helpers.mjs";
import { fakePanel } from "./fixtures/panel-reader.mjs";
const fixture = (name) => readFileSync(new URL(`./fixtures/admin-limits/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const T = Date.UTC(2026, 10, 3, 15) / 1000;
const hit = fixture("claude-panel.txt"), noLimitPanel = fixture("claude-panel-no-limit.txt");
// p46 addendum, 2026-11-03: verbatim section from the earlier under-limit panel.
const under = `Settings Status Config Usage Stats
Usage credits
█████▋                                             11% used
$11.28 / $100.00 spent · Resets Dec 1 (America/Detroit)
Esc to cancel`;
const trust = "Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder";
const ready = "❯ \n? for shortcuts";

test("recorded Codex admin caps, both reset seconds, and no misleading credits note", () => {
  for (const [name, used] of [["codex-before-saved.json", 29], ["codex-at-limit.json", 100]]) {
    const rl = JSON.parse(fixture(name)).rateLimits;
    for (const seconds of [0, 1]) {
      rl.individualLimit.resetsAt = 1796083200 + seconds;
      const r = codexSnapshot(rl, "app-server", T, T);
      expect(r).toMatchObject({ class: "capped", windows: [{ name: "monthly_cap", usedPct: used, windowMin: 30 * 1440 }] });
      expect(r.note ?? "").not.toContain("keeps working");
      const c = cfg({ now: T * 1000, subscriptions: { codex: { ...cfg().subscriptions.codex, billing: "metered" } } });
      const ranked = rankSubscriptions("basic", [r], c);
      expect(ranked.note).not.toContain("Metered budget");
      if (used === 100) expect([...ranked.candidates.normal, ...ranked.candidates.fallback]).toEqual([]);
    }
  }
  expect(monthMinutes(1796083202)).toBeNull();
});

test("a spend-control-only stop expires instead of making an old fallback log block forever", async () => {
  const rl = { credits: { hasCredits: true, unlimited: true }, spendControlReached: true };
  expect(codexSnapshot(rl, "app-server", T, T)).toMatchObject({ class: "capped", headroom: 0 });
  const sessions = scratch("codex-stopped"), dir = join(sessions, "2026/11/03"); mkdirSync(dir, { recursive: true });
  const f = join(dir, "s.jsonl");
  for (const [age, cls] of [[299, "capped"], [300, "unknown"], [864000, "unknown"], [-1, "unknown"]]) {
    writeFileSync(f, JSON.stringify({ timestamp: new Date((T - age) * 1000).toISOString(), payload: { rate_limits: { spend_control_reached: true } } }));
    const fallback = () => readCodex({ sessions, nowSec: T });
    const r = await readCodexLive({ exec: async () => null, fallback, nowSec: T });
    expect(r.class).toBe(cls); expect(r.headroom).toBe(cls === "capped" ? 0 : null);
  }
});

test("real Claude panels reduce to percent and conservative date-only reset; other text is not room", () => {
  expect(parseClaudePanel(hit, T)).toEqual({ used_pct: 100, resets_at: Date.UTC(2026, 11, 2, 4, 59, 59) / 1000 });
  expect(parseClaudePanel(under, T)).toMatchObject({ used_pct: 11 });
  expect(parseClaudePanel(noLimitPanel, T)).toEqual({ used_pct: null, resets_at: null });
  expect(parseClaudePanel(noLimitPanel.replace("$23.96 spent", "$23.96 / ??? spent"), T)).toBeNull();
  expect(parseClaudePanel(hit.replace(/.*\$15\.05.*\n/, "$23.96 spent\n"), T)).toBeNull();
  expect(parseClaudePanel(hit.replace(/.*\$15\.05.*\n/, ""), T)).toBeNull();
  expect(parseClaudePanel("garbled", T)).toBeNull();
  expect(panelReset("Feb 30 (America/Detroit)", T)).toBeNull();
  expect(panelReset("Dec 1 (Bad/Zone)", T)).toBeNull();
  expect(claudePanelScreen(trust)).toBe("trust");
  expect(claudePanelScreen("Claude Code\n❯ \nshift+tab to cycle")).toBe("ready");
  expect(claudePanelScreen("Choose a theme\n❯ Dark\nLight")).toBe("unknown");
});

test("private panel read answers only empty-folder trust, no other first-run screen, and always cleans up", async () => {
  const f = fakePanel(); expect(await claudePanelUsage(f.options)).toMatchObject({ ok: true, used_pct: 100 });
  expect(f.calls.filter((a) => a.includes("send-keys")).flatMap((a) => a.slice(a.indexOf("send-keys") + 2))).toEqual(["down", "enter", "enter"]);
  expect(f.calls.slice(-2).map((a) => a[1])).toEqual(["stop", "delete"]);
  for (const first of ["Choose a theme", "Sign in to continue", "garbled"]) {
    const f = fakePanel(first); expect(await claudePanelUsage(f.options)).toMatchObject({ ok: false, code: "open_once" });
    expect(f.calls.some((a) => a.includes("send-keys") || a.includes("send-text"))).toBe(false);
    expect(f.calls.slice(-2).map((a) => a[1])).toEqual(["stop", "delete"]);
  }
  const missing = fakePanel(); missing.options.run = async () => ({ ok: false, missing: true, code: "herdr_unreachable", data: {} });
  expect(await claudePanelUsage(missing.options)).toMatchObject({ ok: false, code: "herdr_missing" });
  const noLimit = fakePanel(ready, noLimitPanel);
  expect(await claudePanelUsage(noLimit.options)).toMatchObject({ ok: true, used_pct: null, resets_at: null });
  expect(noLimit.elapsed()).toBeGreaterThanOrEqual(750); // no-limit draws must settle before they can remove a cap
  for (const panel of [hit.replace(/.*\$15\.05.*\n/, ""), hit.replace(/Usage credits[^]*/, "Esc to cancel"),
    noLimitPanel.replace("$23.96 spent", "unrecognised credits format"), "garbled"]) {
    const unread = fakePanel(ready, panel);
    const r = await claudePanelUsage(unread.options);
    expect(r).toMatchObject({ ok: false, code: "invalid_response" });
    expect(unread.elapsed()).toBeGreaterThanOrEqual(12000);
    const file = join(scratch("panel-unread"), "snapshot.json");
    await refreshClaudePanel({ file, nowSec: T, read: async () => r });
    const row = readClaudePanel({ file, nowSec: T + 1, background: false });
    expect(row).toMatchObject({ class: "metered", headroom: null, failure: { code: "invalid_response" } });
    expect(row.note).toContain("the limit cannot be seen, so routr will not stop at it");
  }
});

test("Claude limit snapshots use the shared refresh, keep and 24-hour trust rule without inventing room", async () => {
  const file = join(scratch("panel-snap"), "panel.json");
  const read = (nowSec = T) => readClaudePanel({ file, nowSec, background: false });
  expect(read()).toMatchObject({ class: "metered", headroom: null });
  await refreshClaudePanel({ file, nowSec: T, read: async () => ({ ok: true, used_pct: 100, resets_at: T + 60 }) });
  expect(read(T + 59)).toMatchObject({ class: "capped", headroom: 0 });
  expect(read(T + 61)).toMatchObject({ class: "capped", headroom: 1 });
  await refreshClaudePanel({ file, nowSec: T + 80, read: async () => ({ ok: false, code: "open_once", error: "SECRET" }) });
  expect(read(T + 100)).toMatchObject({ class: "capped", failure: { code: "open_once" } });
  expect(read(T + 86400)).toMatchObject({ class: "metered", headroom: null });
  expect(readFileSync(file, "utf8")).not.toContain("SECRET");
  await refreshClaudePanel({ file, nowSec: T, read: async () => ({ ok: true, used_pct: null }) });
  expect(read()).toMatchObject({ class: "metered", headroom: null, windows: [], note: "Claude's panel shows no spend limit: still metered" });
});

test("only answered no-window Enterprise print usage can start the detached panel refresh", async () => {
  const file = join(scratch("panel-gate"), "none.json");
  const print = await readClaude({ file, nowSec: T, exec: async () => fixture("claude-print-usage.json") });
  expect(print.reason).toBe(NO_WINDOWS_AFTER_ANSWER);
  for (const [u, b, starts] of [[print, { billing: "metered", when: "no_windows" }, 1], [print, { billing: "metered" }, 0],
    [print, null, 0], [summarize({ pool: "claude", source: "test", windows: [{ name: "five_hour", usedPct: 11 }] }), { billing: "metered", when: "no_windows" }, 0],
    [{ ...print, failure: { code: "no_response" } }, { billing: "metered", when: "no_windows" }, 0]]) {
    let called = 0;
    const [r] = await readUsage(["claude"], {}, { why: async () => null, billing: async () => ({ billing: b, limitStatus: b && !b.when ? "not_applicable" : null }), sources: { claude: { read: async () => u, limit: { applies: HARNESSES.claude.usage.limit.applies, excludes: HARNESSES.claude.usage.limit.excludes, read: (o) => { if (o.background) called++; return readClaudePanel({ file, background: false, nowSec: T }); } } } } });
    expect(called).toBe(starts); if (starts) expect(r.class).toBe("metered");
  }
});

test("public Claude usage reports its saved age without waiting for a terminal, even when named", async () => {
  const { usageCommand } = await import("./contract.mjs");
  const c = cfg({ subscriptions: { claude: cfg().subscriptions.claude } });
  const sources = { claude: { backgroundOnly: true, check: async () => { throw new Error("public command waited for a panel"); } } };
  const read = async () => [{ ...summarize({ pool: "claude", source: "claude /usage", ts: T - 60, nowSec: T, cls: "capped", windows: [{ name: "spend_limit", usedPct: 100, windowMin: null, resetsAt: T + 86400 }] }) }];
  for (const words of [[], ["claude"]]) {
    const out = await usageCommand(words, c, {}, { read, sources });
    expect(out.ok).toBe(true); expect(out.subscriptions.ranked[0]).toMatchObject({ class: "capped", age_sec: 60, usable: 0 });
    expect(out.subscriptions.candidates).toEqual({ normal: [], fallback: [] });
  }
});

test("the panel refuses a nonempty work folder before any terminal call", async () => {
  const f = fakePanel(); writeFileSync(join(f.options.cwd, "file"), "user content");
  expect(await claudePanelUsage(f.options)).toMatchObject({ ok: false, code: "private_folder" });
  expect(f.calls).toEqual([]);
});

test("Claude refreshes after one hour while Cursor and Kiro retain four, with 24-hour trust unchanged", async () => {
  const { readCursor, refreshCursor } = await import("../src/lib/cursor-usage.mjs");
  const { readKiro, refreshKiro } = await import("../src/lib/kiro-usage.mjs");
  for (const [name, read, refresh, good, interval] of [
    ["claude", readClaudePanel, refreshClaudePanel, { used_pct: 100, resets_at: T + 30 * 86400 }, 3600],
    ["cursor", readCursor, refreshCursor, { included_used_pct: 100 }, 4 * 3600],
    ["kiro", readKiro, refreshKiro, { used_pct: 100, resets_at: T + 30 * 86400 }, 4 * 3600],
  ]) {
    const file = join(scratch(`interval-${name}`), "snapshot.json");
    await refresh({ file, nowSec: T, read: async () => ({ ok: true, ...good }) });
    const starts = [];
    const view = (at) => read({ file, nowSec: at, off: false, refresh: (token) => { starts.push(token); return true; } });
    expect(view(T + interval - 1).headroom).toBe(0); expect(starts).toEqual([]);
    expect(view(T + interval).headroom).toBe(0); expect(starts).toHaveLength(1);
    await refresh({ file, nowSec: T + interval, background: true, token: starts[0], read: async () => ({ ok: false, code: "invalid_response" }) });
    const kept = read({ file, nowSec: T + interval + 1, background: false });
    expect(kept).toMatchObject({ headroom: 0, failure: { code: "invalid_response" }, kept: { ageSec: interval + 1 } });
    expect(read({ file, nowSec: T + 86400 - 1, background: false }).headroom).toBe(0);
    expect(read({ file, nowSec: T + 86400, background: false }).headroom).toBeNull();
  }
});
