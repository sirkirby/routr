// The maintainer's setups: reader replies flow through the command's real ranking and launch history.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeSnapshot, codexSnapshot, failedUsage, readAgy } from "../src/lib/usage.mjs";
import { claudeBilling, withBilling } from "../src/lib/harnesses.mjs";
import { cursorReading, parseCursorUsage } from "../src/lib/cursor-usage.mjs";
import { memoryStore, usageReadings } from "../src/lib/usage-readings.mjs";
import { randomUUID } from "node:crypto";
import { recordLaunch } from "../src/lib/launch-history.mjs";
const countLaunch = (subscription) => recordLaunch(randomUUID(), { subscription });
import { DEFAULTS } from "../src/lib/config.mjs";
import { adviseCommand, usageCommand } from "./contract.mjs";
import { ans, scratch } from "./helpers.mjs";

const T = Date.UTC(2026, 10, 3) / 1000;
const recorded = (file) => JSON.parse(readFileSync(new URL(`./fixtures/admin-limits/${file}.json`, import.meta.url))).rateLimits;
const codex = (reply = recorded("codex-before-saved")) => codexSnapshot(reply, "app-server", T, T);
const noBudget = () => { const reply = recorded("codex-before-saved"); delete reply.individualLimit; return reply; };
const claude = () => withBilling("claude", claudeSnapshot({ ts: T, answered: true }, T), claudeBilling(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "enterprise" })));
const work = () => ({ ...DEFAULTS, now: T * 1000, subscriptions: {
  claude: { hardest_work: "strong", reserve: 0, use: "normal", share: 2 },
  codex: { hardest_work: "strong", reserve: 0, use: "normal", share: 1 },
} });
// Cursor's row as routr serves its kept reading, taken at T.
const keptCursor = (screen) => usageReadings({ configPath: null, store: memoryStore({ entries: { cursor: { reading: cursorReading(screen, T) } } }), clock: { now: () => T },
  signIn: { kept: () => null, why: () => "" } }).kept(["cursor"], { mayRefresh: [] }).served[0].row;
const row = (out, name) => out.subscriptions.ranked.find((r) => r.subscription === name);
async function view(config, readings, level = "strong") {
  return usageCommand(["--level", level], config, {}, { read: async () => readings });
}
async function ratio(reply, config = work(), other = claude()) {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = scratch("account-ratio");
  try {
    const counts = { claude: 0, codex: 0 };
    for (let i = 0; i < 12; i++) {
      const out = await view(config, [other, codex(reply)]);
      expect(out.ok).toBe(true);
      const due = out.subscriptions.share_due ?? out.subscriptions.candidates.normal[0];
      expect(out.subscriptions.candidates.normal).toContain(due);
      counts[due]++; expect(countLaunch(due)).toBe(true);
    }
    return counts;
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test("Personal: included Claude Code and Codex, strong work; Cursor and Antigravity, standard work; reserve 0", async () => {
  const config = { ...DEFAULTS, now: T * 1000, subscriptions: Object.fromEntries(["claude", "codex", "cursor", "agy"].map((name) => [name, { hardest_work: ["claude", "codex"].includes(name) ? "strong" : "standard", reserve: 0 }])) };
  for (const used of [0, 99, 100]) {
    const cursor = parseCursorUsage(`Usage • Pro\nIncluded ${used}% used`);
    const readings = [claudeSnapshot({ ts: T, rate_limits: { five_hour: { used_percentage: used, resets_at: T + 300 } } }, T),
      codex({ primary: { usedPercent: used, windowDurationMins: 300, resetsAt: T + 300 } }),
      keptCursor(cursor),
      await readAgy({ exec: async () => JSON.stringify({ command: { data: { groups: [{ name: "Gemini", buckets: [{ window: "weekly", remaining_fraction: 1 - used / 100, reset_time: "2030-01-01T00:00:00Z" }] }] } } }) })];
    const standard = await view(config, readings, "standard");
    expect(standard.subscriptions.candidates.normal).toEqual(used < 100 ? ["agy", "claude", "codex", "cursor"] : []);
    const strong = await view(config, readings);
    expect(strong.subscriptions.candidates.normal).toEqual(used < 100 ? ["claude", "codex"] : []);
    expect(strong.subscriptions.excluded.map((r) => r.subscription)).toEqual(["cursor", "agy"]);
  }
});

test("Work: two metered Enterprise seats, both normal, share Claude 2, Codex 1, no budgets", async () => {
  expect(await ratio(noBudget())).toEqual({ claude: 8, codex: 4 });
});
test("Same, budget on Codex at 40%", async () => {
  const reply = recorded("codex-before-saved"); reply.individualLimit.remainingPercent = 60; // synthetic percentage on the recorded reply
  expect(await ratio(reply)).toEqual({ claude: 8, codex: 4 });
  const config = work(); config.subscriptions.codex.reserve = 0.2;
  const out = await view(config, [claude(), codex(reply)]);
  expect(row(out, "codex")).toMatchObject({ class: "metered", headroom: 0.6, usable: 0.41, windows: [{ window: "monthly_cap" }] });
});
test("Same, Codex at its budget", async () => {
  const reply = recorded("codex-at-limit"), out = await view(work(), [claude(), codex(reply)]);
  expect(out.subscriptions.candidates.normal).toEqual(["claude"]);
  expect(row(out, "codex")).toMatchObject({ usable: 0, note: expect.stringContaining("spend control reached") });
  expect(await ratio(reply)).toEqual({ claude: 12, codex: 0 });
});
test("Same, a budget on Claude", async () => {
  // Claude's Enterprise reply has no budget window; routr cannot observe the admin budget.
  expect(claude()).toMatchObject({ class: "metered", headroom: null, windows: [] });
  expect(await ratio(noBudget())).toEqual({ claude: 8, codex: 4 });
});
test("Budget on Codex raised after being hit", async () => {
  const config = work();
  const hit = await view(config, [claude(), codex(recorded("codex-at-limit"))]);
  expect(hit.subscriptions.candidates.normal).toEqual(["claude"]);
  const raised = await view(config, [claude(), codex()]);
  expect(raised.subscriptions.candidates.normal).toEqual(["claude", "codex"]);
  expect(row(raised, "codex")).toMatchObject({ class: "metered", usable: 0.71 });
});
test("A metered seat set to fallback", async () => {
  const config = work(); config.subscriptions.codex.use = "fallback";
  const out = await view(config, [claude(), codex()]);
  expect(out.subscriptions.candidates).toEqual({ normal: ["claude"], fallback: ["codex"] });
  const full = claudeSnapshot({ ts: T, rate_limits: { five_hour: { used_percentage: 100 } } }, T);
  expect((await view(config, [full, codex()])).subscriptions.candidates).toEqual({ normal: [], fallback: ["codex"] });
});
test("An included plan whose usage cannot be read", async () => {
  for (const billing of [undefined, "included"]) {
    const config = work(); config.subscriptions.claude.billing = billing;
    const out = await view(config, [failedUsage("claude", "claude /usage"), codex()]);
    expect(row(out, "claude")).toMatchObject({ class: billing ?? "unknown", usable: null, headroom: null, usage: "unknown", note: expect.stringContaining("could not read") });
    expect(out.subscriptions.candidates.normal).toContain("claude");
    expect(out.unavailable).toMatchObject([{ subscription: "claude", reading: "unknown" }]);
    expect(out.subscriptions.most_room).toBe("codex");
  }
});

test("An unset use on a metered seat is normal", async () => {
  const config = work(); delete config.subscriptions.codex.use;
  for (const reply of [noBudget(), recorded("codex-before-saved")]) expect(row(await view(config, [claude(), codex(reply)]), "codex").use).toBe("normal");
});
test("A reading never changes use", async () => {
  for (const use of [undefined, "normal", "fallback"]) {
    const config = work(); config.subscriptions.codex.use = use;
    for (const reading of [codex(noBudget()), codex(), codex(recorded("codex-at-limit")), codex({ primary: { usedPercent: 20 } }), failedUsage("codex", "app-server")]) {
      expect(row(await view(config, [claude(), reading]), "codex").use).toBe(use ?? "normal");
      expect(config.subscriptions.codex.use).toBe(use);
    }
  }
});

test("most_room and the usage headline prefer a normal account's number before fallback", async () => {
  const config = work(); config.subscriptions.codex.use = "fallback";
  const normal = claudeSnapshot({ ts: T, rate_limits: { five_hour: { used_percentage: 50 } } }, T);
  const out = await view(config, [normal, codex()]);
  expect(out.subscriptions.ranked.map((r) => r.subscription)).toEqual(["codex", "claude"]);
  expect(out.subscriptions.most_room).toBe("claude");
  expect(out.subscriptions.note).toContain("claude has the most usable headroom");
  expect(out.headline).toContain("claude has the most usable headroom");
  expect((await view(config, [failedUsage("claude", "claude /usage"), codex()])).subscriptions.most_room).toBe("codex");
});

test("dispatch includes share_due from recorded launches with a stubbed decision model", async () => {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = scratch("account-dispatch");
  try {
    expect(countLaunch("claude")).toBe(true);
    const out = await adviseCommand("dispatch", "Fix the parser", { config: work(), notes: [] }, {}, {
      askFn: async () => ({ provider: "typesafe", model: "jev-test", latencyMs: 1, answers: ans(2, 0.9) }),
      read: async () => [claude(), codex()],
    });
    expect(out.subscriptions.share_due).toBe("codex");
    expect(row(out, "claude").share).toMatchObject({ launches: 1, of: 1 });
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
