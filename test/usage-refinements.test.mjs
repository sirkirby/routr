import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { summarize, readClaude } from "../src/lib/usage.mjs";
import { HARNESSES, readUsage } from "../src/lib/harnesses.mjs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { claudeUsageMenu } from "../src/lib/claude-panel.mjs";
import { usageStateFile } from "../src/lib/usage-command.mjs";
import { STATE_DIR } from "../src/lib/runtime.mjs";
import { cfg, scratch } from "./helpers.mjs";
const T = 1_800_000_000;

test("only caps retain a fresh full counter after its reset; plan windows roll over", () => {
  const windows = [{ name: "monthly_cap", usedPct: 95, windowMin: 43200, resetsAt: T - 1 }];
  for (const cls of ["included", "capped"]) {
    const r = summarize({ pool: "codex", source: "fixture", cls, windows, ts: T, nowSec: T + 1 });
    expect(r.headroom).toBeCloseTo(cls === "capped" ? 0.05 : 1);
    const ranked = rankSubscriptions("basic", [r], cfg({ now: (T + 1) * 1000 }));
    const row = ranked.ranked.find((r) => r.subscription === "codex");
    expect(row.windows[0].reserve_now).toBe(0.2);
    expect(row.usable).toBe(cls === "capped" ? 0 : 0.8);
  }
});

test("print takeover is command_shadowed; zero-turn answers need no local_command field", async () => {
  const o = JSON.parse(readFileSync(new URL("./fixtures/admin-limits/claude-print-usage.json", import.meta.url), "utf8"));
  delete o.local_command;
  for (const turns of [0, 1]) {
    const r = await readClaude({ file: null, shadows: [], exec: async () => JSON.stringify({ ...o, num_turns: turns }) });
    if (turns) expect(r.failure?.code).toBe("command_shadowed"); else expect(r.failure).toBeUndefined();
  }
});

test("a fresh statusline with windows needs neither print nor fresh auth nor a limit snapshot", async () => {
  const file = join(scratch("statusline-proof"), "usage.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify({ ts: T, rate_limits: { five_hour: { used_percentage: 20 } } }));
  const u = await readClaude({ file, nowSec: T + 1, shadows: [file], exec: async () => { throw new Error("print must not run"); } });
  expect(u.headroom).toBe(0.8); expect(u.failure).toBeUndefined();
  for (const status of [null, ...["enterprise", "free", "max_5x"].map((subscriptionType) => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType }))]) {
    const [r] = await readUsage(["claude"], {}, { why: async () => null, billing: async (_, o) => { expect(o.fresh).toBe(false); return { status }; }, sources: { claude: {
      read: async () => u, limit: { ...HARNESSES.claude.usage.limit, read: () => { throw new Error("no panel observation needed"); } },
    } } });
    expect(r.headroom).toBe(0.8); expect(r.failure).toBeUndefined();
  }
});

test("menu guard counts exactly one highlighted usage row without comparing descriptions", () => {
  expect(claudeUsageMenu("❯ /usage  \n  /usage Any description\n")).toBe(false);
  expect(claudeUsageMenu("❯ /usage Reworded vendor description  \n❯ /usage   ")).toBe(true);
  expect(claudeUsageMenu("  /usage Any description")).toBe(false);
  expect(claudeUsageMenu("❯ /usage First\n  /usage Second")).toBe(false);
  expect(claudeUsageMenu("❯ /usage  ")).toBeNull(); // prompt alone is not a menu row
});

test("usage settings names follow content and linked folders are refused with private_folder", () => {
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = process.env.USERPROFILE = scratch("state-files");
    const a = usageStateFile("json", '{"disableAllHooks":true}'), b = usageStateFile("json", '{"disableAllHooks":false}');
    expect(a).not.toBe(b); expect(a).toBe(usageStateFile("json", '{"disableAllHooks":true}'));
    expect(readFileSync(a, "utf8")).toBe('{"disableAllHooks":true}');
    if (process.platform !== "win32") { expect(lstatSync(a).mode & 0o777).toBe(0o600); expect(lstatSync(join(STATE_DIR(), "usage-settings")).mode & 0o777).toBe(0o700); }
    process.env.HOME = process.env.USERPROFILE = scratch("linked-state");
    mkdirSync(STATE_DIR(), { recursive: true });
    const outside = scratch("outside-state");
    try { symlinkSync(outside, join(STATE_DIR(), "usage-settings"), "dir"); } catch { return; }
    expect(() => usageStateFile("json", "{}")).toThrow(expect.objectContaining({ usageCode: "private_folder" }));
  } finally { Object.assign(process.env, original); }
});

test("private rows config uses the content hash and replaces only this server's config", async () => {
  const { startServer } = await import("../src/lib/terminal.mjs");
  const { basename } = await import("node:path"), { createHash } = await import("node:crypto");
  let started;
  for (const rows of [200, 80]) {
    startServer("fixture", () => {}, { rows, spawn: (exe, args, opts) => { started = { exe, args, opts }; return { on() {}, unref() {} }; } });
    expect(started.exe).toBe("herdr"); expect(started.args).toEqual(["--session", "fixture", "server"]);
    const content = `[server]\nheadless_cols = 120\nheadless_rows = ${rows}\n`;
    expect(readFileSync(started.opts.env.HERDR_CONFIG_PATH, "utf8")).toBe(content);
    expect(basename(started.opts.env.HERDR_CONFIG_PATH)).toBe(`${createHash("sha256").update(content).digest("hex")}.toml`);
  }
});

test("settings failures keep their fixed folder code through the screen reader", async () => {
  const { fakePanel } = await import("./fixtures/panel-reader.mjs");
  const { claudePanelUsage } = await import("../src/lib/claude-panel.mjs");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = process.env.USERPROFILE = scratch("settings-refused");
    const file = usageStateFile("json", "{}"), contents = "{}";
    writeFileSync(file, "wrong"); expect(() => usageStateFile("json", contents)).toThrow(expect.objectContaining({ usageCode: "private_folder" }));
    unlinkSync(file); mkdirSync(file); expect(() => usageStateFile("json", contents)).toThrow(expect.objectContaining({ usageCode: "private_folder" }));
    for (const exists of [false, true]) {
      process.env.HOME = process.env.USERPROFILE = scratch("settings-file-link");
      const own = usageStateFile("json", contents), target = join(scratch("settings-file-target"), "target.json");
      unlinkSync(own); if (exists) writeFileSync(target, contents);
      try { symlinkSync(target, own); } catch { continue; }
      expect(() => usageStateFile("json", contents)).toThrow(expect.objectContaining({ usageCode: "private_folder" }));
    }
    process.env.HOME = process.env.USERPROFILE = scratch("settings-link-result");
    mkdirSync(STATE_DIR(), { recursive: true });
    try { symlinkSync(scratch("settings-link-target"), join(STATE_DIR(), "usage-settings"), "dir"); } catch { return; }
    const f = fakePanel("Claude Code\n❯ \n? for shortcuts");
    expect(await claudePanelUsage(f.options)).toMatchObject({ ok: false, code: "private_folder" });
    expect(f.calls.some((a) => a.includes("send-text"))).toBe(false);
  } finally { Object.assign(process.env, original); }
});

test("unknown limit applicability without a held cap returns the primary reading without a false failure", async () => {
  const u = summarize({ pool: "claude", source: "claude /usage", reason: "no_windows_after_answer" });
  const [r] = await readUsage(["claude"], {}, { why: async () => null, billing: async () => ({ status: null }), sources: { claude: {
    read: async () => u, limit: { ...HARNESSES.claude.usage.limit, read: () => ({ class: "metered", headroom: null, windows: [] }) },
  } } });
  expect(r).toBe(u); expect(r.failure).toBeUndefined();
});

test("the Claude cmd path refusal is for the settings argument actually typed", async () => {
  const { fakePanel } = await import("./fixtures/panel-reader.mjs");
  const { claudePanelUsage } = await import("../src/lib/claude-panel.mjs");
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = process.env.USERPROFILE = scratch("cmd-state%");
    const f = fakePanel("Claude Code\n❯ \n? for shortcuts"), run = f.options.run;
    f.options.run = async (...a) => {
      const r = await run(...a);
      if (a[0].includes("process-info")) r.data.result.process_info.foreground_processes[0].name = "cmd.exe";
      return r;
    };
    const r = await claudePanelUsage(f.options);
    expect(r).toMatchObject({ ok: false, code: "cmd_path" });
    expect(r.why).toContain("TEMP"); expect(f.calls.some((a) => a.includes("send-text"))).toBe(false);
  } finally { Object.assign(process.env, original); }
});

test("a zero or negative reset is no reset: a full window stays full", () => {
  const T = 1793700000;
  for (const resetsAt of [0, -62135596800]) for (const cls of ["included", "capped"]) {
    expect(summarize({ pool: "x", source: "test", ts: T, nowSec: T + 60, cls, windows: [{ name: "w", usedPct: 100, windowMin: 300, resetsAt }] }).headroom).toBe(0);
  }
});
