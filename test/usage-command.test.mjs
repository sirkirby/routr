import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readClaude } from "../src/lib/usage.mjs";
import { claudePanelUsage, claudeUsageMenu, parseClaudePanel } from "../src/lib/claude-panel.mjs";
import { HARNESSES, claudeLimitStatus } from "../src/lib/harnesses.mjs";
import { fakePanel } from "./fixtures/panel-reader.mjs";
import { scratch } from "./helpers.mjs";
const ready = "Claude Code\n❯ \n? for shortcuts";
const hit = readFileSync(new URL("./fixtures/admin-limits/claude-panel.txt", import.meta.url), "utf8");
const none = readFileSync(new URL("./fixtures/admin-limits/claude-panel-no-limit.txt", import.meta.url), "utf8");

test("documented user command names block both reads before a terminal or print process starts", async () => {
  const original = process.env.CLAUDE_CONFIG_DIR;
  try {
    for (const name of ["skills/usage", "commands/usage.md"]) {
      const config = scratch("shadow-command"); process.env.CLAUDE_CONFIG_DIR = config;
      if (name.endsWith(".md")) { mkdirSync(join(config, "commands")); writeFileSync(join(config, name), "contents must never be read"); }
      else mkdirSync(join(config, name), { recursive: true });
      expect(HARNESSES.claude.usage.shadows()).toContain(join(config, name));
      let printed = false;
      expect(await readClaude({ exec: async () => { printed = true; throw new Error(); } })).toMatchObject({ failure: { code: "command_shadowed" } });
      expect(printed).toBe(false);
      const f = fakePanel(ready, hit);
      expect(await claudePanelUsage(f.options)).toMatchObject({ ok: false, code: "command_shadowed" });
      expect(f.calls).toEqual([]);
    }
  } finally { if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original; }
});

test("the file preflight also uses the default config folder, by name alone", async () => {
  const { claudeUsageShadows } = await import("../src/lib/usage.mjs");
  const original = process.env.CLAUDE_CONFIG_DIR;
  try { delete process.env.CLAUDE_CONFIG_DIR; expect(claudeUsageShadows()).toEqual([join(process.env.USERPROFILE && process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME, ".claude/skills/usage"), join(process.env.USERPROFILE && process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME, ".claude/commands/usage.md")]); }
  finally { if (original !== undefined) process.env.CLAUDE_CONFIG_DIR = original; }
});

test("a skill-highlighted row, an unhighlighted built-in, and no menu fail without Enter", async () => {
  expect(claudeUsageMenu("❯ /usage A user skill\n  /usage Show session cost, plan usage, and activity stats")).toBe(false);
  for (const menu of ["❯ /usage A user skill\n  /usage Show session cost, plan usage, and activity stats", "No commands match", ""]) {
    const f = fakePanel(ready, hit, { menu });
    expect(await claudePanelUsage(f.options)).toMatchObject({ ok: false, code: "command_shadowed" });
    expect(f.calls.some((a) => a.includes("send-keys") && a.at(-1) === "enter")).toBe(false);
    expect(f.calls.some((a) => a.includes("send-keys") && a.at(-1) === "escape")).toBe(true);
  }
});

test("a stale ready banner cannot authorise typing into an exited shell", async () => {
  const f = fakePanel(ready, hit, { running: false });
  expect(await claudePanelUsage(f.options)).toMatchObject({ ok: false, code: "no_response" });
  expect(f.calls.some((a) => a.includes("send-text"))).toBe(false);
});

test("trust is answered only with No, exit highlighted", async () => {
  const f = fakePanel("Quick safety check: trust this folder?\n  No, exit\n❯ Yes, I trust this folder", hit);
  expect(await claudePanelUsage(f.options)).toMatchObject({ ok: false, code: "open_once" });
  expect(f.calls.some((a) => a.includes("send-keys"))).toBe(false);
});

test("a spent-only draw settles, and a limit arriving during the settle wins", async () => {
  const f = fakePanel(ready, (ticks) => ticks < 750 ? none : hit);
  expect(await claudePanelUsage(f.options)).toMatchObject({ ok: true, used_pct: 100 });
  expect(parseClaudePanel(none.replace(/Esc to cancel\s*$/, ""))).toBeNull();
});

test("renamed or unreadable signed-in status is not proof that a limit reader no longer applies", () => {
  expect(claudeLimitStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}')).toBe("not_applicable");
  expect(claudeLimitStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"enterprise"}')).toBe("applicable");
  expect(claudeLimitStatus('{"loggedIn":true,"authMethod":"claude.ai","renamedPlan":"enterprise"}')).toBeNull();
  expect(claudeLimitStatus('"loggedIn": true not json')).toBeNull();
});


test("print responses must identify the built-in with zero turns", async () => {
  const text = readFileSync(new URL("./fixtures/admin-limits/claude-print-usage.json", import.meta.url), "utf8");
  const original = JSON.parse(text);
  for (const extra of [{ num_turns: 1 }, { local_command: undefined }]) {
    const r = await readClaude({ file: null, shadows: [], exec: async () => JSON.stringify({ ...original, ...extra }) });
    expect(r).toMatchObject({ failure: { code: "invalid_response" } });
  }
});
