import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, readUsage } from "../src/lib/harnesses.mjs";
import { readClaudePanel, refreshClaudePanel } from "../src/lib/claude-panel.mjs";
import { staleReaders, usageUnavailable, USAGE_FAILURES } from "../src/lib/usage-failure.mjs";
import { usageStatus, nextSteps } from "../src/lib/doctor.mjs";
import { adviseCommand, usageCommand } from "./contract.mjs";
import { smokeUsage } from "../scripts/smoke-usage.mjs";
import { cfg, scratch } from "./helpers.mjs";
const T = 1_800_000_000;

test("screen readers are recipes, and shared commands select only registry capabilities", () => {
  for (const p of ["src/lib/commands.mjs", "scripts/smoke-usage.mjs"]) {
    const text = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    expect(text).not.toMatch(/needsClaudePanel|claude-panel|name\s*===\s*["']claude["']/);
  }
  const harnesses = readFileSync(new URL("../src/lib/harnesses.mjs", import.meta.url), "utf8");
  expect(harnesses).not.toContain("needsClaudePanel");
  for (const p of ["cursor-usage", "claude-panel"]) {
    const text = readFileSync(new URL(`../src/lib/${p}.mjs`, import.meta.url), "utf8");
    expect(text).toContain("screenUsage("); expect(text).not.toMatch(/for\s*\(\s*;\s*;/);
  }
  expect(readFileSync(new URL("../src/lib/screen-usage.mjs", import.meta.url), "utf8")).not.toMatch(/cursor|claude/i);
  for (const sentence of Object.values(USAGE_FAILURES)) expect(sentence).not.toMatch(/Claude|Cursor|Codex|Kiro|Antigravity/);
});

test("a never-successful limit read stays visible, ages through retries, and reaches usage, advice and doctor", async () => {
  const file = join(scratch("limit-outage"), "panel.json"), config = cfg({ subscriptions: { claude: { ...cfg().subscriptions.claude, billing: "metered" } } });
  const fail = async () => ({ ok: false, code: "herdr_missing" });
  await refreshClaudePanel({ file, nowSec: T, read: fail });
  for (const elapsed of [1, 86400 - 1, 86400 + 1]) {
    // A retry changes tried but must not restart the first-failure clock.
    await refreshClaudePanel({ file, nowSec: T + elapsed, read: fail });
    const row = readClaudePanel({ file, nowSec: T + elapsed, background: false });
    expect(row).toMatchObject({ class: "metered", ageSec: null, failureAgeSec: elapsed, limitReader: true });
    const unavailable = usageUnavailable([row]);
    expect(unavailable).toMatchObject([{ code: "herdr_missing" }]);
    expect(unavailable[0].why).toContain("Claude Code");
    expect(unavailable[0].why).toContain("The limit cannot be seen, so routr will not stop at it");
    const read = async () => [row];
    for (const out of [await usageCommand([], config, {}, { read }), await usageCommand(["claude"], config, {}, { read }),
      await adviseCommand("dispatch", "Read a fixture", { config }, {}, { read, askFn: async () => { throw new Error("offline fixture"); } })]) {
      expect(out.unavailable.filter((u) => u.part === "usage")).toHaveLength(1);
      expect(out.warnings.some((w) => w.includes("limit cannot be seen"))).toBe(elapsed >= 86400);
    }
    const status = usageStatus(row, config);
    expect(Boolean(status.usage_stale)).toBe(elapsed >= 86400);
    const steps = nextSteps({ decision: [], config: { exists: true, subscriptions: ["claude"] }, harnesses: { claude: { installed: true, signed_in: true, ...status } }, skill: [], herdr: { path: "herdr", skill: true } });
    expect(steps.some((s) => s.includes("limit cannot be seen"))).toBe(elapsed >= 86400);
  }
  await refreshClaudePanel({ file, nowSec: T + 90000, read: async () => ({ ok: true, used_pct: null, resets_at: null }) });
  const recovered = readClaudePanel({ file, nowSec: T + 90001, background: false });
  expect(recovered.note).toBe("Claude's panel shows no spend limit: still metered");
  expect(usageUnavailable([recovered])).toEqual([]); expect(staleReaders([recovered], config)).toEqual([]);
  await refreshClaudePanel({ file, nowSec: T + 90002, read: fail });
  expect(readClaudePanel({ file, nowSec: T + 90003, background: false }).failureAgeSec).toBe(1);
});

test("a failed refresh of even a fresh kept cap is unavailable; it still ranks the trusted cap", async () => {
  const file = join(scratch("limit-kept"), "panel.json");
  await refreshClaudePanel({ file, nowSec: T, read: async () => ({ ok: true, used_pct: 100, resets_at: T + 30 * 86400 }) });
  await refreshClaudePanel({ file, nowSec: T + 1, read: async () => ({ ok: false, code: "invalid_response" }) });
  const row = readClaudePanel({ file, nowSec: T + 2, background: false });
  expect(row).toMatchObject({ class: "capped", headroom: 0, kept: { ageSec: 2 } });
  expect(usageUnavailable([row])).toMatchObject([{ code: "invalid_response", reading: "kept", age_sec: 2 }]);
});

test("metered seats with no applicable limit reader, or a successful last limit read, do not warn", async () => {
  let limitReads = 0;
  const primary = { pool: "claude", class: "metered", headroom: null, windows: [], ageSec: 90000, failure: { code: "read_failed" } };
  const [row] = await readUsage(["claude"], {}, { why: async () => null, billing: async () => ({ billing: { billing: "metered" }, status: JSON.stringify({ loggedIn: true, authMethod: "api_key" }) }), sources: { claude: {
    read: async () => primary, limit: { ...HARNESSES.claude.usage.limit, read: async () => { limitReads++; throw new Error(); } },
  } } });
  expect(limitReads).toBe(0); expect(row.limitReader).toBeUndefined(); expect(staleReaders([row])).toEqual([]);
  expect(usageUnavailable([{ ...row, failure: undefined }])).toEqual([]);
  expect(staleReaders([{ ...row, limitReader: true, failure: undefined, failureAgeSec: 90000 }])).toEqual([]);
  expect(staleReaders([{ ...row, limitReader: true, signedIn: false, failureAgeSec: 90000 }])).toEqual([]);
  const [quota] = await readUsage(["claude"], {}, { why: async () => null, billing: async () => ({ status: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "enterprise" }) }), sources: { claude: {
    read: async () => ({ ...primary, class: "included", source: "claude /usage", failure: undefined, headroom: 0.5, windows: [{ usedPct: 50 }] }),
    limit: { ...HARNESSES.claude.usage.limit, read: async () => { limitReads++; throw new Error(); } },
  } } });
  expect(limitReads).toBe(0); expect(usageUnavailable([quota])).toEqual([]); expect(staleReaders([quota])).toEqual([]);

});

test("smoke reports conditional limit reads independently, through arbitrary registry recipes", async () => {
  const lines = [], config = { subscriptions: { fixture: {} } }, ready = async () => null;
  let exercised = 0;
  const sources = { fixture: { source: "fixture usage", live: async () => ({ pool: "fixture", class: "metered", headroom: null, windows: [] }), limit: {
    state: (u) => u.windows.length ? "skip" : "read", live: async () => { exercised++; return { ok: true, used_pct: null }; }, describe: () => "no spend limit showing (metered)",
  } } };
  const check = () => smokeUsage({ config, sources, ready, billing: async () => ({}), log: (s) => lines.push(s.replace(/ \([\d.]+ s\)$/, "").replace(/ \(fixture usage, [\d.]+ s\)$/, "")) });
  expect(await check()).toBe(0);
  expect(lines).toEqual(["fixture: ok: metered", "fixture limit: read: no spend limit showing (metered)"]); expect(exercised).toBe(1);
  lines.length = 0; sources.fixture.live = async () => ({ headroom: 0.5, windows: [{ usedPct: 50 }] });
  expect(await check()).toBe(0); expect(exercised).toBe(1);
  expect(lines).toEqual(["fixture: ok: 50% left", "fixture limit: NOT EXERCISED (this seat shows windows)"]);
  lines.length = 0; sources.fixture.live = async () => ({ class: "metered", windows: [] }); sources.fixture.limit.live = async () => ({ ok: false, code: "invalid_response" });
  expect(await check()).toBe(1); expect(lines).toContain("fixture limit: FAILED (invalid_response)");
});


test("an unexpected limit-reader exception remains a visible metered limit failure", async () => {
  const { NO_WINDOWS_AFTER_ANSWER } = await import("../src/lib/usage.mjs");
  const [row] = await readUsage(["claude"], {}, { why: async () => null, billing: async () => ({ status: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "enterprise" }) }), sources: { claude: {
    read: async () => ({ pool: "claude", source: "claude /usage", reason: NO_WINDOWS_AFTER_ANSWER, headroom: null, windows: [] }),
    limit: { ...HARNESSES.claude.usage.limit, read: async () => { throw new Error("PRIVATE SCREEN"); } },
  } } });
  expect(row).toMatchObject({ class: "metered", limitReader: true, failure: { code: "read_failed" } });
  expect(usageUnavailable([row])).toMatchObject([{ code: "read_failed" }]);
  expect(JSON.stringify(row)).not.toContain("PRIVATE SCREEN");
});


test("an older failed limit snapshot retains its known outage date through marking and refresh", async () => {
  for (const background of [false, true]) {
    const file = join(scratch("old-limit-outage"), "panel.json");
    writeFileSync(file, JSON.stringify({ ts: null, tried: T, by: "0.0.0-dev", reading: null, failure: { code: "read_failed" } }));
    let token;
    if (background) readClaudePanel({ file, nowSec: T + 86400, off: false, refresh: (t) => { token = t; return true; } });
    await refreshClaudePanel({ file, nowSec: T + 86400, background, token, read: async () => ({ ok: false, code: "read_failed" }) });
    const row = readClaudePanel({ file, nowSec: T + 86401, background: false });
    expect(row.failureAgeSec).toBe(86401); expect(staleReaders([row])).toHaveLength(1);
  }
});
