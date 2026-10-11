// config.mjs: settings are validated and a broken config still answers
import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { DEFAULTS, loadConfig } from "../src/lib/config.mjs";
import { SCRATCH, scratch } from "./helpers.mjs";
test("billing and metered_rank are validated like the shares", () => {
  const odd = join(SCRATCH, "odd2.json"); writeFileSync(odd, JSON.stringify({ subscriptions: { x: { hardest_work: "strong", reserve: 0.1, billing: "free", metered_rank: "first" }, y: { hardest_work: "strong", reserve: 0.1, billing: "metered", metered_rank: "with" } } }));
  const r = loadConfig(odd);
  expect(r.config.subscriptions.x).toMatchObject({ billing: null, metered_rank: "after" }); expect(r.config.subscriptions.y).toMatchObject({ billing: "metered", metered_rank: "with" }); expect(r.notes.length).toBe(2);
});

test("broken or missing config falls back to defaults with a note", () => {
  const bad = join(SCRATCH, "bad.json"); writeFileSync(bad, "{ not json");
  for (const path of [bad, "/nonexistent/config.json"]) { const r = loadConfig(path); expect(r.config.fallback_level).toBe("standard"); expect(r.notes.length).toBe(1); }
  const odd = join(SCRATCH, "odd.json"); writeFileSync(odd, JSON.stringify({ prefer: { debug: "huge" }, subscriptions: { x: { reserve: 0.3 } } }));
  const r = loadConfig(odd); expect(r.config.prefer.debug).toBeUndefined(); expect(r.config.subscriptions.x.hardest_work).toBe("strong"); expect(r.notes.length).toBe(2);
  expect(r.notes.find((n) => n.includes("hardest_work is not set"))).toContain("routr setup --hardest x=basic|standard|strong"); // the user's to set: the note says how
});

test("a config share outside 0..1 is reported and replaced: a negative reserve must not create capacity", () => {
  const f = join(scratch("cfg"), "config.json");
  writeFileSync(f, JSON.stringify({ sure_at: 7, subscriptions: { claude: { hardest_work: "strong", reserve: -1, assumed_headroom: 2 }, codex: { hardest_work: "strong", reserve: 0.2 } } }));
  const { config, notes } = loadConfig(f);
  expect(config.sure_at).toBe(DEFAULTS.sure_at);
  expect(config.subscriptions.claude.reserve).toBe(0);
  expect(config.subscriptions.claude.assumed_headroom).toBe(0.5);
  expect(config.subscriptions.codex.reserve).toBe(0.2);
  expect(notes.length).toBe(3);
});

test("a hardest_work that is not a level is quoted the way a bad reserve is, whatever its type", async () => {
  const { HARDEST, RESERVE } = await import("../src/lib/wording.mjs");
  expect(HARDEST.invalid("x", 3)).toBe("subscriptions.x.hardest_work: 3 is not a level, so strong is used");
  expect(HARDEST.invalid("x", "huge")).toBe('subscriptions.x.hardest_work: "huge" is not a level, so strong is used');
  expect(HARDEST.invalid("x", { a: 1 })).not.toContain("[object Object]");
  expect(RESERVE.invalid("x", "lots")).toContain('"lots"');
});

test("the decision model is a setting: a provider routr knows and a model it has measured there, else the default and a note", () => {
  const at = (decision, extra = {}) => { const p = join(SCRATCH, `decision-${Math.random()}.json`); writeFileSync(p, JSON.stringify({ ...extra, ...(decision === undefined ? {} : { decision }) })); return loadConfig(p); };
  expect(at(undefined).config.decision).toEqual({ provider: "typesafe", model: null });
  expect(at({ provider: "cloudflare" }).config.decision).toEqual({ provider: "cloudflare", model: null });
  expect(at({ provider: "cloudflare", model: "clef-flash" }).config.decision).toEqual({ provider: "cloudflare", model: "clef-flash" });
  const unknown = at({ provider: "openrouter" });
  expect(unknown.config.decision).toEqual({ provider: "typesafe", model: null });
  expect(unknown.notes.join(" ")).toContain('decision.provider: "openrouter" is not one of typesafe, cloudflare, ollama');
  const unmeasured = at({ provider: "cloudflare", model: "clef-omni" });
  expect(unmeasured.config.decision).toEqual({ provider: "cloudflare", model: null });
  expect(unmeasured.notes.join(" ")).toContain('"clef-omni" is not one routr has measured on cloudflare');
  // sure_at follows the model unless the person sets one.
  expect(DEFAULTS.sure_at).toBeNull();
  expect(at(undefined).config.sure_at).toBeNull();
  expect(at(undefined, { sure_at: 0.9 }).config.sure_at).toBe(0.9);
});
