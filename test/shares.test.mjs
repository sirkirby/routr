// The launch share between metered accounts: the pure view, its place in the ranking, and the launch history it reads.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { recentLaunches, shareView } from "../src/lib/shares.mjs";
import { LAUNCH_HISTORY_DIR as LAUNCH_COUNTS_DIR, recordLaunch } from "../src/lib/launch-history.mjs";
// One launch of `subscription`, as launch records it (launch-history.test.mjs covers the decision fields).
const countLaunch = (subscription, opts) => recordLaunch(randomUUID(), { subscription }, opts);
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { loadConfig } from "../src/lib/config.mjs";
import { UNINSTALL_LOCK } from "../src/lib/runtime.mjs";
import { cfg, live, metered, scratch } from "./helpers.mjs";

const DAY = 86400000, NOW = 1_800_000_000_000;
const subs = (over = {}) => cfg({ subscriptions: {
  claude: { hardest_work: "strong", reserve: 0, use: "normal", share: 3, ...over.claude },
  codex: { hardest_work: "strong", reserve: 0, use: "normal", share: 1, ...over.codex },
  cursor: { hardest_work: "strong", reserve: 0.1, ...over.cursor },
} });
const rank = (c, counts, usage = [metered("claude"), metered("codex"), live("cursor", 0.6)], level = "strong") => rankSubscriptions(level, usage, c, counts && { counts });

test("3 to 1 with 9 of 20 launches on claude: claude is due, 30 points under its target; codex is over its own", () => {
  const r = rank(subs(), { claude: 9, codex: 11 });
  expect(r.share_due).toBe("claude");
  const by = Object.fromEntries(r.ranked.map((x) => [x.subscription, x]));
  expect(by.claude.share).toEqual({ weight: 3, target: 0.75, used_pct: 45, left: 0.3, launches: 9, of: 20 });
  expect(by.codex.share).toEqual({ weight: 1, target: 0.25, used_pct: 55, left: 0, launches: 11, of: 20 });
  expect(by.cursor.share).toBeUndefined();
  // A share is not a headroom: metered accounts keep no number, candidates keep their name order, most_room its meaning.
  expect([by.claude.headroom, by.claude.usable, by.codex.headroom]).toEqual([null, null, null]);
  expect(r.candidates.normal).toEqual(["claude", "codex", "cursor"]);
  expect(r.most_room).toBe("cursor");
  expect(r.note).toContain("claude is due: 9 of the 20 routr launches on these accounts in the last 7 days, target 75%");
});

test("the ratio orders the metered accounts among themselves, and leaves the included ones where headroom puts them", () => {
  const r = rank(subs(), { claude: 1, codex: 9 }, [metered("codex"), metered("claude"), live("cursor", 0.6)]);
  expect(r.ranked.map((x) => x.subscription)).toEqual(["cursor", "claude", "codex"]);
  const flipped = rank(subs(), { claude: 30, codex: 1 });
  expect(flipped.share_due).toBe("codex");
  expect(flipped.ranked.map((x) => x.subscription)).toEqual(["cursor", "codex", "claude"]);
});

test("no launches yet: the account with the larger weight is due; launches that match the ratio leave none due", () => {
  expect(rank(subs(), {}).share_due).toBe("claude");
  expect(rank(subs(), {}).ranked.find((x) => x.subscription === "claude").share).toMatchObject({ used_pct: 0, left: 0.75, of: 0 });
  expect(rank(subs(), {}).note).toContain("claude is due: no routr launches on these accounts in the last 7 days");
  const even = rank(subs(), { claude: 6, codex: 2 });
  expect(even.share_due).toBeNull();
  expect(even.note).toContain("match it: none is due");
  // Equal weights and equal counts: none due. Equal weights, no launches: a stable choice, by name.
  expect(rank(subs({ claude: { share: 2 }, codex: { share: 2 } }), { claude: 4, codex: 4 }).share_due).toBeNull();
  expect(rank(subs({ claude: { share: 2 }, codex: { share: 2 } }), {}).share_due).toBe("claude");
});

test("one account with a share and one without: the other counts as 1", () => {
  const r = rank(subs({ codex: { share: null } }), { claude: 0, codex: 4 });
  expect(r.ranked.find((x) => x.subscription === "codex").share).toMatchObject({ weight: 1, target: 0.25 });
  expect(r.share_due).toBe("claude");
});

test("a share shows only among two or more normal metered accounts, with at least one share set and a readable history", () => {
  const none = (r) => { expect(r.share_due).toBeUndefined(); expect(r.ranked.some((x) => x.share)).toBe(false); };
  // Claude on a plan with windows reads included: headroom balances it, and its share counts for nothing.
  none(rank(subs(), { claude: 1 }, [live("claude", 0.4), metered("codex"), live("cursor", 0.6)]));
  // One metered account has nothing to share with.
  none(rank(subs(), {}, [metered("claude"), live("codex", 0.5)]));
  // A fallback account is not everyday work: its share waits until it is normal again.
  none(rank(subs({ codex: { use: "fallback" } }), {}));
  // No share anywhere: today's advice, unchanged.
  none(rank(subs({ claude: { share: null }, codex: { share: null } }), {}));
  // Turned off, or a level one of them does not take: one sharer left, so none.
  none(rank(subs({ codex: { enabled: false } }), {}));
  none(rank(subs({ codex: { hardest_work: "standard" } }), {}));
  // No history given (the named `usage <subscription>` view): none.
  none(rankSubscriptions("strong", [metered("claude"), metered("codex")], subs(), null));
  // History that cannot be read is not zero launches: no share, and the note says why.
  const unreadable = rankSubscriptions("strong", [metered("claude"), metered("codex")], subs(), { counts: {}, unreadable: true });
  none(unreadable);
  expect(unreadable.note).toContain("Your share is not shown: routr's launch history could not be read.");
});

test("an exact tie goes to the larger weight, never to floating-point noise", () => {
  // Weights 1, 1, 2 with 2, 5, 5 of 12 launches: claude and kiro are both exactly 1/12 below their targets.
  const ranked = ["claude", "codex", "kiro"].map((subscription) => ({ subscription, class: "metered", use: "normal" }));
  const v = shareView(ranked, { counts: { claude: 2, codex: 5, kiro: 5 } }, { claude: { share: 1 }, codex: { share: 1 }, kiro: { share: 2 } });
  expect(v.due).toBe("kiro");
  expect(v.order).toEqual(["kiro", "claude", "codex"]);
});

test("unreadable history says the share is not shown only where a share would apply", () => {
  const unreadable = { counts: {}, unreadable: true };
  expect(rankSubscriptions("strong", [metered("claude"), metered("codex")], subs(), unreadable).note).toContain("Your share is not shown");
  // One metered sharer left (codex is fallback): no share would show, so the note says nothing about it.
  expect(rankSubscriptions("strong", [metered("claude"), metered("codex")], subs({ codex: { use: "fallback" } }), unreadable).note).not.toContain("share");
});

test("the pure view needs a ranked list and never reads a file", () => {
  const ranked = [{ subscription: "a", class: "metered", use: "normal" }, { subscription: "b", class: "metered", use: "normal" }];
  expect(shareView(ranked, { counts: { a: 1, b: 1 } }, { a: { share: 1 }, b: { share: 1 } })).toMatchObject({ due: null, order: ["a", "b"] });
  expect(shareView(ranked, { counts: {} }, { a: { share: 1 }, b: { share: 3 } })).toMatchObject({ due: "b", order: ["b", "a"] });
});

test("each launch keeps one file; recentLaunches counts the last 7 days", () => {
  const home = scratch("share-home");
  mkdirSync(join(home, ".local/state/routr"), { recursive: true });
  expect(recentLaunches({ home, now: NOW })).toEqual({ counts: {} });
  // A read writes nothing: no folder appears.
  expect(existsSync(LAUNCH_COUNTS_DIR(home))).toBe(false);
  expect(countLaunch("claude", { home, now: NOW - 8 * DAY })).toBe(true);
  expect(countLaunch("claude", { home, now: NOW - 6 * DAY })).toBe(true);
  expect(countLaunch("codex", { home, now: NOW - 1000 })).toBe(true);
  expect(countLaunch("codex", { home, now: NOW })).toBe(true);
  expect(recentLaunches({ home, now: NOW })).toEqual({ counts: { claude: 1, codex: 2 } });
  // The write swept the launch older than the window; the others stay. A launch given only its account has no decision.
  const files = readdirSync(LAUNCH_COUNTS_DIR(home));
  expect(files.length).toBe(3);
  for (const f of files) expect(Object.entries(JSON.parse(readFileSync(join(LAUNCH_COUNTS_DIR(home), f), "utf8"))).filter(([, v]) => v !== null).map(([k]) => k).sort()).toEqual(["at", "subscription"]);
  // Files that are not ours, half written, or from the future do not count, and are not removed.
  const dir = LAUNCH_COUNTS_DIR(home);
  writeFileSync(join(dir, "notes.json"), JSON.stringify({ subscription: "claude", at: new Date(NOW).toISOString() }));
  writeFileSync(join(dir, "11111111-1111-4111-8111-111111111111.json"), "{\"subscription\":\"cla");
  writeFileSync(join(dir, "22222222-2222-4222-8222-222222222222.json"), JSON.stringify({ subscription: "claude", at: new Date(NOW + 2 * DAY).toISOString() }));
  writeFileSync(join(dir, "33333333-3333-4333-8333-333333333333.json.tmp.123"), "{}");
  expect(recentLaunches({ home, now: NOW })).toEqual({ counts: { claude: 1, codex: 2 } });
  countLaunch("codex", { home, now: NOW });
  expect(readdirSync(dir)).toContain("notes.json");
  expect(readdirSync(dir)).toContain("22222222-2222-4222-8222-222222222222.json");
});

test("a launch writes nothing while routr is being uninstalled, and never throws", () => {
  const home = scratch("share-uninstall");
  mkdirSync(join(home, ".local/state/routr"), { recursive: true });
  writeFileSync(UNINSTALL_LOCK(home), "");
  expect(countLaunch("claude", { home, now: NOW })).toBe(false);
  expect(existsSync(LAUNCH_COUNTS_DIR(home))).toBe(false);
  expect(countLaunch("../claude", { home: scratch("share-bad") })).toBe(false);
  // A file where the folder should be: the count fails quietly, and the history reads as unreadable.
  const blocked = scratch("share-blocked");
  mkdirSync(join(blocked, ".local/state/routr"), { recursive: true });
  writeFileSync(LAUNCH_COUNTS_DIR(blocked), "");
  expect(countLaunch("claude", { home: blocked, now: NOW })).toBe(false);
  expect(recentLaunches({ home: blocked, now: NOW })).toEqual({ counts: {}, unreadable: true });
});

test("a linked history folder is never written through or swept, and reads as unreadable", () => {
  const home = scratch("share-link"), outside = scratch("share-outside");
  mkdirSync(join(home, ".local/state/routr"), { recursive: true });
  const old = join(outside, "44444444-4444-4444-8444-444444444444.json");
  writeFileSync(old, JSON.stringify({ subscription: "claude", at: new Date(NOW - 30 * DAY).toISOString() }));
  try { symlinkSync(outside, LAUNCH_COUNTS_DIR(home), "dir"); } catch { return; } // Windows without the right to make links
  expect(countLaunch("claude", { home, now: NOW })).toBe(false);
  expect(readdirSync(outside)).toEqual(["44444444-4444-4444-8444-444444444444.json"]);
  expect(recentLaunches({ home, now: NOW })).toEqual({ counts: {}, unreadable: true });
});

test("a linked state folder gets no history folder made in it, and its history reads as unreadable", () => {
  const home = scratch("share-state-link"), outside = scratch("share-state-outside");
  mkdirSync(join(home, ".local/state"), { recursive: true });
  try { symlinkSync(outside, join(home, ".local/state/routr"), "dir"); } catch { return; }
  expect(countLaunch("claude", { home, now: NOW })).toBe(false);
  expect(readdirSync(outside)).toEqual([]);
  mkdirSync(join(outside, "launch-counts"));
  writeFileSync(join(outside, "launch-counts/55555555-5555-4555-8555-555555555555.json"), JSON.stringify({ subscription: "claude", at: new Date(NOW).toISOString() }));
  expect(recentLaunches({ home, now: NOW })).toEqual({ counts: {}, unreadable: true });
});

test("accounts at or above their targets keep the larger weight first", () => {
  // Weights 3, 1, 1 with 8, 2, 0 launches: claude and codex are both at or above target (left 0); kiro is due.
  const ranked = ["claude", "codex", "kiro"].map((subscription) => ({ subscription, class: "metered", use: "normal" }));
  const v = shareView(ranked, { counts: { claude: 8, codex: 2, kiro: 0 } }, { claude: { share: 3 }, codex: { share: 1 }, kiro: { share: 1 } });
  expect(v.due).toBe("kiro");
  expect(v.order).toEqual(["kiro", "claude", "codex"]);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a record that is there but cannot be read makes the whole history unreadable, not a smaller count", () => {
  const home = scratch("share-perm");
  mkdirSync(join(home, ".local/state/routr"), { recursive: true });
  countLaunch("claude", { home, now: NOW }); countLaunch("codex", { home, now: NOW });
  const claude = readdirSync(LAUNCH_COUNTS_DIR(home)).find((f) => readFileSync(join(LAUNCH_COUNTS_DIR(home), f), "utf8").includes("claude"));
  chmodSync(join(LAUNCH_COUNTS_DIR(home), claude), 0o000);
  try { expect(recentLaunches({ home, now: NOW })).toEqual({ counts: {}, unreadable: true }); }
  finally { chmodSync(join(LAUNCH_COUNTS_DIR(home), claude), 0o600); }
});

test("config: share is a whole number from 1 to 99; anything else is reported and left out", () => {
  const dir = scratch("share-config"), path = join(dir, "config.json");
  const base = { hardest_work: "strong", reserve: 0 };
  writeFileSync(path, JSON.stringify({ subscriptions: { claude: { ...base, share: 3 }, codex: { ...base, share: 0 }, cursor: { ...base, share: 2.5 }, agy: { ...base, share: "3" }, kiro: { ...base } } }));
  const { config, notes } = loadConfig(path);
  expect(Object.fromEntries(Object.entries(config.subscriptions).map(([n, s]) => [n, s.share]))).toEqual({ claude: 3, codex: null, cursor: null, agy: null, kiro: null });
  expect(notes.filter((n) => n.includes(".share:")).length).toBe(3);
  expect(notes.find((n) => n.startsWith("subscriptions.codex.share"))).toContain("is not a whole number from 1 to 99, so it is left out");
});

const limited = (name, headroom) => ({ ...live(name, headroom), class: "metered", windows: [{ name: "spend_limit", usedPct: (1 - headroom) * 100, windowMin: null, resetsAt: null }] });
const twoToOne = () => subs({ claude: { share: 2, reserve: 0.1 }, codex: { reserve: 0.1 } });
const shareCases = [
  ["both metered", metered("claude"), metered("codex"), "cursor"],
  ["first limited", limited("claude", 0.9), metered("codex"), "claude"],
  ["second limited", metered("claude"), limited("codex", 0.9), "codex"],
  ["both limited", limited("claude", 0.9), limited("codex", 0.3), "claude"],
];
for (const [shape, first, second, mostRoom] of shareCases) test(`2:1 launch ratio with ${shape}: share order and capacity stay independent`, () => {
  const config = twoToOne(), usage = [first, second, live("cursor", 0.6)];
  const baseline = rankSubscriptions("strong", usage, config);
  for (const [counts, due] of [[{}, "claude"], [{ claude: 4, codex: 0 }, "codex"], [{ claude: 0, codex: 4 }, "claude"], [{ claude: 2, codex: 1 }, null]]) {
    const r = rank(config, counts, usage), rows = Object.fromEntries(r.ranked.map((x) => [x.subscription, x]));
    expect(r.share_due).toBe(due);
    expect(rows.claude.share).toMatchObject({ weight: 2, target: 0.67 });
    expect(rows.codex.share).toMatchObject({ weight: 1, target: 0.33 });
    expect(r.ranked.filter((x) => x.share)[0].subscription).toBe(due ?? "claude");
    expect(r.ranked.findIndex((x) => x.subscription === "cursor")).toBe(baseline.ranked.findIndex((x) => x.subscription === "cursor"));
    expect(r.most_room).toBe(mostRoom);
    expect(r.note).toContain(`${r.most_room} has the most usable headroom among accounts with a number`);
    expect(r.candidates.normal).toEqual(["claude", "codex", "cursor"]);
    if (due) expect(r.note).toContain(`${due} is due`); else expect(r.note).toContain("match it: none is due");
  }
});

test("a cap at its limit or reserve leaves the ratio; one remaining sharer stays a candidate without a share", () => {
  for (const room of [0, 0.1]) {
    const r = rank(twoToOne(), { claude: 8, codex: 1 }, [limited("claude", room), metered("codex"), live("cursor", 0.6)]);
    expect(r.share_due).toBeUndefined(); expect(r.ranked.some((x) => x.share)).toBe(false);
    expect(r.candidates.normal).toEqual(["codex", "cursor"]);
    expect(r.note).not.toContain("By your share");
  }
  const config = twoToOne(); config.subscriptions.kiro = { hardest_work: "strong", reserve: 0, use: "normal", share: 1 };
  const r = rank(config, { claude: 8, codex: 1, kiro: 3 }, [limited("claude", 0), metered("codex"), metered("kiro")]);
  expect(r.share_due).toBe("codex");
  expect(r.ranked.find((x) => x.subscription === "codex").share).toEqual({ weight: 1, target: 0.5, used_pct: 25, left: 0.25, launches: 1, of: 4 });
  expect(r.ranked.find((x) => x.subscription === "claude").share).toBeUndefined();
});

test("routr usage keeps the ratio through metered/limited readings and recorded launch history", async () => {
  const { usageCommand } = await import("./contract.mjs");
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = scratch("limited-share-usage");
  try {
    for (let i = 0; i < 4; i++) expect(countLaunch("claude")).toBe(true);
    for (const [, first, second, mostRoom] of shareCases) {
      const out = await usageCommand([], twoToOne(), {}, { read: async () => [first, second, live("cursor", 0.6)] });
      expect(out.ok).toBe(true); expect(out.subscriptions.share_due).toBe("codex");
      expect(out.subscriptions.most_room).toBe(mostRoom);
      expect(out.headline).toContain(`${mostRoom} has the most usable headroom`);
      const firstRow = out.subscriptions.ranked.find((x) => x.subscription === "claude");
      expect(firstRow.headroom).toBe(first.headroom);
      if (first.windows?.length) expect(firstRow.windows[0]).toMatchObject({ window: "spend_limit", usable: 0.8 });
      expect(out.subscriptions.ranked.filter((x) => x.share).map((x) => x.subscription)).toEqual(["codex", "claude"]);
      expect(out.subscriptions.ranked.find((x) => x.subscription === "claude").share).toEqual({ weight: 2, target: 0.67, used_pct: 100, left: 0, launches: 4, of: 4 });
      expect(out.subscriptions.candidates.normal).toEqual(["claude", "codex", "cursor"]);
    }
    const out = await usageCommand([], twoToOne(), {}, { read: async () => [limited("claude", 0), metered("codex"), live("cursor", 0.6)] });
    expect(out.subscriptions.share_due).toBeUndefined(); expect(out.subscriptions.ranked.some((x) => x.share)).toBe(false);
    expect(out.subscriptions.candidates.normal).toEqual(["codex", "cursor"]);
  } finally { Object.assign(process.env, previous); }
});
