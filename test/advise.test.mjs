// advise.mjs and pick.mjs: the level, the facts, and how subscriptions are ranked
import { expect, test } from "bun:test";
import { advise } from "../src/lib/advise.mjs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { NOW, ans, cfg, fact, live, none, scratch, win } from "./helpers.mjs";

test("rounds to the nearest level and never adjusts it", () => {
  expect(advise(ans(0.4, 0.9), cfg()).level).toBe("basic");
  expect(advise(ans(1.4, 0.9), cfg()).level).toBe("standard");
  expect(advise(ans(1.6, 0.9), cfg()).level).toBe("strong");
});

test("says when Jev is unsure and hands the decision to the agent", () => {
  const a = advise(ans(1.2, 0.3), cfg());
  expect(a.sure).toBe(false); expect(a.notes[0]).toContain("routr is between");
  expect(advise(ans(1.2, 0.85), cfg()).sure).toBe(true);
});

test("a user preference is advice beside the level, not an override", () => {
  const a = advise(ans(0, 1, "review"), cfg());
  expect(a.level).toBe("basic");                                   // a rote count stays basic
  expect(a.notes.join(" ")).toContain("prefers strong for review");
  expect(advise(ans(2, 1, "review"), cfg()).notes).toEqual([]);      // nothing to say when already at the preference
});

test("preferences cover every plausible kind of work", () => {
  const a = advise(ans(1, 1, "implement", 0.1, { implement: 0.5, research: 0.4, docs: 0.1 }), cfg());
  expect(a.notes.join(" ")).toContain("research");
});

test("facts are read as yes, no, or unclear, and unclear ones go back to the agent", () => {
  const a = advise(fact(ans(1, 0.9), { names_location: 0.95, approach_open: 0.1, cause_unknown: 0.5 }), cfg());
  expect(a.facts.names_location.reading).toBe("yes"); expect(a.facts.approach_open.reading).toBe("no");
  expect(a.facts.cause_unknown.reading).toBe("unclear"); expect(a.notes.join(" ")).toContain("routr could not tell from the brief: cause_unknown");
});

test("gaps in the brief are flagged for fixing before it is sent", () => {
  const a = advise(fact(ans(1, 0.9), { states_check: 0.05, standalone: 0.1 }), cfg());
  expect(a.notes.filter((n) => n.startsWith("Fix the brief first")).length).toBe(2);
  expect(advise(fact(ans(1, 0.9), { states_check: 0.95, standalone: 0.95 }), cfg()).notes).toEqual([]);
});

test("the user's default model is passed through, and caller-read headroom is used", () => {
  const c = cfg(); c.subscriptions.cursor = { ...c.subscriptions.cursor, default_model: "some-model", default_effort: "low" };
  const r = rankSubscriptions("basic", [live("claude", 0.3), { pool: "cursor", source: "given by caller", given: true, ageSec: 0, windows: [], headroom: 0.97 }], c);
  expect(r.ranked[0]).toMatchObject({ subscription: "cursor", usable: 0.87, usage: "given", your_default: "some-model @ low" });
});

test("high risk is called out", () => {
  const a = advise(ans(0.1, 1, "implement", 0.9), cfg());
  expect(a.high_risk).toBe(true); expect(a.notes.join(" ")).toContain("costly");
});

test("ranks by usable headroom after reserves; assumed usage is labelled", () => {
  const r = rankSubscriptions("basic", [live("claude", 0.6), live("codex", 0.5), none("cursor")], cfg());
  expect(r.ranked.map((x) => x.subscription)).toEqual(["cursor", "claude", "codex"]); // 0.40, 0.35, 0.30
  expect(r.ranked[0].usage).toBe("assumed"); expect(r.most_room).toBe("cursor");
});

test("a subscription is never offered work harder than the user allows", () => {
  const r = rankSubscriptions("strong", [live("claude", 0.3), live("codex", 0.35), none("cursor")], cfg());
  expect(r.most_room).toBe("codex"); expect(r.excluded[0].subscription).toBe("cursor");
});

test("never offers a reserve: all at reserve means no suggestion", () => {
  expect(rankSubscriptions("strong", [live("claude", 0.2), live("codex", 0.2)], cfg()).most_room).toBeNull();
});

test("usage is read per call: a drained subscription drops down the ranking (P9)", () => {
  expect(rankSubscriptions("strong", [live("claude", 0.4), live("codex", 0.9)], cfg()).most_room).toBe("codex");
  expect(rankSubscriptions("strong", [live("claude", 0.4), live("codex", 0.15)], cfg()).most_room).toBe("claude");
});

test("the reserve shrinks as the window runs out, and each window is shown", () => {
  const c = { ...cfg(), now: NOW };
  const early = rankSubscriptions("basic", [{ pool: "claude", source: "t", ageSec: 1, headroom: 0.39, windows: [win(61, 160)] }], c).ranked.find((x) => x.subscription === "claude");
  const late = rankSubscriptions("basic", [{ pool: "claude", source: "t", ageSec: 1, headroom: 0.39, windows: [win(61, 28)] }], c).ranked.find((x) => x.subscription === "claude");
  expect(early.usable).toBe(0.15);                       // 0.39 left − 0.25 × (160/168)
  expect(late.usable).toBe(0.35);                        // 0.39 left − 0.25 × (28/168): a day from the reset, use it
  expect(late.windows[0]).toMatchObject({ window: "seven_day", used_pct: 61, resets_in_h: 28, left: 0.39, reserve_now: 0.04 });
});

test("the tightest window decides", () => {
  const c = { ...cfg(), now: NOW };
  const r = rankSubscriptions("basic", [{ pool: "claude", source: "t", ageSec: 1, headroom: 0.05, windows: [win(20, 100), { ...win(95, 1, 300), name: "five_hour" }] }], c).ranked.find((x) => x.subscription === "claude");
  expect(r.usable).toBe(0);                              // 5% left in the five-hour window − 0.25 × (1/5) reserve
});

test("worth a worker: tiny work stays with the agent, a user decision comes first, independent pieces are split", () => {
  expect(advise(fact(ans(0, 1), { tiny: 0.95 }), cfg()).worker.suggestion).toBe("do it yourself");
  expect(advise(fact(ans(1, 1), { tiny: 0.95, needs_user: 0.9 }), cfg()).worker.suggestion).toBe("settle it with the user first");
  expect(advise(fact(ans(1, 1), { separable: 0.9, tiny: 0.1 }), cfg()).worker.suggestion).toBe("split it across workers");
  expect(advise(fact(ans(1, 1), { tiny: 0.5 }), cfg()).worker.suggestion).toBe("worth a worker");
});

test("a torn level reads as the more likely of the two (r5)", () => {
  const torn = (probabilities, score) => ({ level: { score, confidence: 0.3, probabilities }, work_type: { choice: "implement", confidence: 1, probabilities: { implement: 1 } }, high_blast_radius: { noul: 0.1 } });
  const a = advise(torn({ 0: 0.05, 1: 0.45, 2: 0.5 }, 1.45), cfg());
  expect(a.level).toBe("strong"); expect(a.between).toEqual(["standard", "strong"]);
  expect(advise(torn({ 0: 0.48, 1: 0.52, 2: 0 }, 0.52), cfg()).level).toBe("standard");
  // Two of the real tasks behind r5 (P32): r4 advised standard and basic; both were labelled one level higher.
  expect(advise(torn({ 0: 0, 1: 0.2, 2: 0.8 }, 1.8), cfg()).level).toBe("strong");
  expect(advise(torn({ 0: 0.27, 1: 0.7, 2: 0.03 }, 0.76), cfg()).level).toBe("standard");
  expect(advise(torn({ 0: 0.5, 1: 0.5, 2: 0 }, 0.5), cfg()).level).toBe("basic"); // a tie goes to the lower level
  expect(a.notes.join(" ")).toContain("Start at strong, the more likely");
  // Said as decided (from the review of #42): a tie is the lower of two equals, and no spread is the rounded score.
  expect(advise(torn({ 0: 0.1, 1: 0.45, 2: 0.45 }, 1.35), cfg()).notes.join(" ")).toContain("Start at standard: the two are equally likely, so the lower one.");
  const flat = advise({ level: { score: 1.6, confidence: 0.3 }, work_type: { choice: "implement", confidence: 1, probabilities: { implement: 1 } }, high_blast_radius: { noul: 0.1 } }, cfg());
  expect(flat.level).toBe("strong");
  expect(flat.notes.join(" ")).toContain("routr is unsure of the level. Start at strong, its score rounded.");
  expect(flat.notes.join(" ")).not.toContain("more likely");
  expect(advise(ans(1.6, 0.9), cfg()).between).toBeUndefined();             // sure: plain rounding, no range
});

test("dispatch and subagent answer from a function: Jev's reading, the ranking, and the user's fallback when Jev is down", async () => {
  const { adviseCommand } = await import("../src/lib/commands.mjs");
  const jev = async () => ({ model: "jev-test", latencyMs: 12.4, answers: fact(ans(1.1, 0.9), {}) });
  const read = async (names) => names.map((n) => live(n, n === "cursor" ? 0.9 : 0.3));
  const d = await adviseCommand("dispatch", "Fix the parser", { config: cfg(), notes: [] }, {}, { askFn: jev, read });
  expect(d).toMatchObject({ mode: "dispatch", level: "standard", jev_model: "jev-test", ms: 12, brief_chars: 14 });
  expect(d.subscriptions.most_room).toBe("cursor");
  expect(d.rule).toContain("Choose suitable model and effort options from normal candidates");
  expect(JSON.stringify(d)).not.toContain("Fix the parser"); // the brief itself is never in the output
  const down = await adviseCommand("subagent", "Fix it", { config: cfg(), notes: ["a note"] }, {}, { askFn: async () => { throw new Error("offline"); } });
  expect(down).toMatchObject({ fallback: true, level: "standard", config_notes: ["a note"] });
  expect(down.subscriptions).toBeUndefined();
  expect(down.notes[0]).toContain("Router unavailable (offline)");
  const none = await adviseCommand("dispatch", "x", { config: { ...cfg(), subscriptions: {} }, notes: [] }, {}, { askFn: jev, read });
  expect(none.subscriptions.note).toContain("has not run `routr setup`");
});

test("the headline gives the level, the kind of work, what the brief leaves open, and any warning in capitals", async () => {
  const { headline } = await import("../src/lib/advise.mjs");
  const facts = { approach_open: { reading: "yes" }, standalone: { reading: "yes" }, cross_cutting: { reading: "no" } };
  expect(headline({ level: "standard", sure: true, work_type: "debug", facts })).toBe("routr: standard, debug work; approach_open");
  expect(headline({ level: "standard", sure: false, between: ["standard", "strong"], work_type: "review", facts: {}, high_risk: true, worker: { suggestion: "split it across workers" }, notes: ["Fix the brief: it names no check"] }))
    .toBe("routr: SPLIT IT ACROSS WORKERS · standard (torn between standard and strong), review work; HIGH RISK; FIX THE BRIEF FIRST");
  expect(headline({ level: "basic", sure: false })).toBe("routr: basic (unsure), unknown work");
});

test("a subscription turned off keeps its settings, is left out of dispatch with how to turn it on, and is not read", async () => {
  const { loadConfig, enabledSubscriptions } = await import("../src/lib/config.mjs");
  const { adviseCommand } = await import("../src/lib/commands.mjs");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = join(scratch("off"), "config.json");
  writeFileSync(file, JSON.stringify({ subscriptions: { agy: { enabled: false, hardest_work: "standard", reserve: 0.1, default_model: "g" }, codex: { hardest_work: "strong", reserve: 0.2 }, kiro: { enabled: "no", hardest_work: "basic", reserve: 0 } } }));
  const { config, notes } = loadConfig(file);
  expect(config.subscriptions.agy).toMatchObject({ enabled: false, default_model: "g", reserve: 0.1 });
  expect(config.subscriptions.kiro.enabled).toBe(true);
  expect(notes).toContain('subscriptions.kiro.enabled: "no" is not true or false, so it stays on');
  expect(enabledSubscriptions(config)).toEqual(["codex", "kiro"]);
  const read = [];
  const d = await adviseCommand("dispatch", "x", { config, notes: [] }, {}, { askFn: async () => { throw new Error("offline"); }, read: async (names) => { read.push(...names); return names.map((n) => live(n, 0.9)); } });
  expect(read).toEqual(["codex", "kiro"]);
  expect(d.subscriptions.excluded).toContainEqual({ subscription: "agy", reason: "turned off in your settings: routr setup --enable agy" });
});
