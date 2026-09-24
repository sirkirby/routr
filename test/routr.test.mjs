import { expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advise } from "../src/lib/advise.mjs";
import { readReport } from "../src/lib/check.mjs";
import { DEFAULTS, loadConfig } from "../src/lib/config.mjs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { claudeSnapshot, codexSnapshot, monthMinutes } from "../src/lib/usage.mjs";
import { snapshotFrom } from "../src/lib/statusline.mjs";
import { plan } from "../src/lib/harness.mjs";
import { parseCursorUsage, cursorUsage } from "../src/lib/cursor-usage.mjs";
import { composePrompt, promptSettled, launch, paneText, parseLaunchArgs, quote, shellPrompt, trustDialog, WORKER_GUIDE } from "../src/lib/launch.mjs";
import { COMMANDS, DESCRIPTION, formatCommandHelp, formatTopLevelHelp, formatUnknownUsage } from "../src/lib/help.mjs";

const cfg = (over = {}) => ({ ...DEFAULTS, subscriptions: {
  claude: { hardest_work: "strong", reserve: 0.25, assumed_headroom: 0.5 },
  codex: { hardest_work: "strong", reserve: 0.2, assumed_headroom: 0.5 },
  cursor: { hardest_work: "standard", reserve: 0.1, assumed_headroom: 0.5 },
}, ...over });
const ans = (score, confidence, kind = "implement", blast = 0.1, kinds = { [kind]: 1 }) =>
  ({ level: { score, confidence, probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 } }, work_type: { choice: kind, confidence: 1, probabilities: kinds }, high_blast_radius: { noul: blast } });
const live = (pool, headroom) => ({ pool, source: "t", ageSec: 5, windows: [{}], headroom });
const NOW = 1_800_000_000_000, win = (usedPct, hoursLeft, windowMin = 10080) => ({ name: "seven_day", usedPct, windowMin, resetsAt: NOW / 1000 + hoursLeft * 3600 });
const none = (pool) => ({ pool, source: "none", ageSec: null, windows: [], headroom: null });
const fact = (a, over) => ({ ...a, ...Object.fromEntries(Object.entries(over).map(([k, p]) => [k, { noul: p }])) });

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
  const r = rankSubscriptions("basic", [live("claude", 0.3), { pool: "cursor", source: "given by caller", ageSec: 0, windows: [], headroom: 0.97 }], c);
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
// Recorded 2026-09-22 from `codex app-server` (`account/rateLimits/read`, CLI 0.155.1), identifiers removed: a ChatGPT
// Enterprise seat on flexible pricing, and a Pro login. The capped shape follows the protocol's `SpendControlLimitSnapshot`
// (openai/codex, codex-rs/protocol/src/protocol.rs); it is claimed until a cap is set on a seat and read.
const ENTERPRISE_SEAT = { limitId: "codex", limitName: null, normalModelSlug: null, primary: null, secondary: null, credits: { hasCredits: true, unlimited: true, balance: null }, individualLimit: null, spendControlReached: false, planType: "business", rateLimitReachedType: null };
const PRO_LOGIN = { ...ENTERPRISE_SEAT, primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: NOW / 1000 + 3 * 86400 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "pro" };
const capped = (resetsAt, remainingPercent, over = {}) => ({ ...ENTERPRISE_SEAT, credits: { hasCredits: true, unlimited: false, balance: "1000" }, individualLimit: { limit: "5000", used: String(5000 - 50 * remainingPercent), remainingPercent, resetsAt }, ...over });
const metered = (pool) => ({ pool, source: "app-server", ageSec: 1, windows: [], headroom: null, class: "metered", note: "metered: unlimited credits, usage is billed, no quota reported" });

test("Codex pool classes come from the shape, not the plan name: an Enterprise seat reports `business` and no windows", () => {
  const ent = codexSnapshot(ENTERPRISE_SEAT, "app-server", NOW / 1000, NOW / 1000);
  expect(ent).toMatchObject({ class: "metered", headroom: null, windows: [] }); expect(ent.note).toContain("unlimited credits");
  const pro = codexSnapshot(PRO_LOGIN, "app-server", NOW / 1000, NOW / 1000);
  expect(pro).toMatchObject({ class: "included", headroom: 0.4 }); expect(pro.windows).toEqual([{ name: "primary", usedPct: 60, windowMin: 10080, resetsAt: PRO_LOGIN.primary.resetsAt }]);
  // the session log spells the same fields in snake_case
  expect(codexSnapshot({ primary: { used_percent: 25, window_minutes: 300, resets_at: NOW / 1000 + 60 }, credits: { has_credits: false, unlimited: false } }, "session log", 1, NOW / 1000)).toMatchObject({ class: "included", headroom: 0.75 });
});
test("a member credit cap is one more window with its own period, and the tightest window still wins", () => {
  const feb1 = Date.UTC(2027, 1, 1) / 1000;
  const c = codexSnapshot(capped(feb1, 10), "app-server", NOW / 1000, NOW / 1000);
  expect(c.class).toBe("capped"); expect(c.headroom).toBeCloseTo(0.1);
  expect(c.windows).toEqual([{ name: "monthly_cap", usedPct: 90, windowMin: 31 * 1440, resetsAt: feb1 }]); // January
  expect(monthMinutes(Date.UTC(2027, 0, 1) / 1000)).toBe(31 * 1440);                                       // December
  expect(monthMinutes(Date.UTC(2027, 0, 15) / 1000)).toBeNull();                                            // not a month boundary: length unknown
  const both = codexSnapshot(capped(feb1, 10, { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: NOW / 1000 + 60 } }), "app-server", NOW / 1000, NOW / 1000);
  expect(both.headroom).toBeCloseTo(0.1); expect(both.windows.map((w) => w.name)).toEqual(["primary", "monthly_cap"]);
  const at = codexSnapshot(capped(feb1, 0, { spendControlReached: true, rateLimitReachedType: "workspace_member_credits_depleted" }), "app-server", NOW / 1000, NOW / 1000);
  expect(at.headroom).toBe(0); expect(at.note).toContain("workspace_member_credits_depleted"); expect(at.note).toContain("spend control reached");
  // credits beside windows leave the windows in charge (claimed shape); a finite balance with no windows is metered and named
  expect(codexSnapshot({ ...PRO_LOGIN, credits: { hasCredits: true, unlimited: true, balance: null } }, "app-server", NOW / 1000, NOW / 1000)).toMatchObject({ class: "included", headroom: 0.4 });
  expect(codexSnapshot({ ...ENTERPRISE_SEAT, credits: { hasCredits: true, unlimited: false, balance: "250" } }, "app-server", NOW / 1000, NOW / 1000).note).toContain("balance 250");
});
test("the statusline writes every render and keeps the last windows seen; absence of windows is unknown, never a class", () => {
  const t = NOW / 1000, at = (snap, nowSec = t) => claudeSnapshot(snap, nowSec);
  const pre = snapshotFrom({ model: { id: "m" } }, null, t);                                   // a session's first render
  expect(pre).toMatchObject({ ts: t, model: "m", rate_limits: null, answered: false, seen: null });
  expect(at(pre)).toMatchObject({ class: "unknown", headroom: null }); expect(at(pre).note).toContain("no windows yet");
  const rl = { five_hour: { used_percentage: 5, resets_at: t + 3600 }, seven_day: { used_percentage: 1, resets_at: t + 86400 } };
  const withWs = snapshotFrom({ model: { id: "m" }, rate_limits: rl, prompt_cache: {} }, pre, t + 1);
  expect(withWs.seen).toEqual({ ts: t + 1, rate_limits: rl });
  expect(at(withWs)).toMatchObject({ class: "included", headroom: 0.95 });
  const next = snapshotFrom({ model: { id: "m" } }, withWs, t + 2);                            // next session, before its first response
  expect(next.seen).toEqual(withWs.seen); expect(at(next)).toMatchObject({ class: "included", headroom: 0.95, ageSec: -1 });
  expect(at(next, t + 5 * 3600)).toMatchObject({ class: "included", headroom: 0.99, ageSec: 5 * 3600 - 1 });  // hours later: still served, aged, the 5h window rolled over
  const noWs = snapshotFrom({ model: { id: "m" }, prompt_cache: { warm: true } }, null, t);    // after a response, still no windows: not classed, the note says what to do
  expect(noWs.answered).toBe(true); expect(at(noWs)).toMatchObject({ class: "unknown", headroom: null }); expect(at(noWs).note).toContain("billing");
  expect(at({ ts: t, model: "m", rate_limits: rl })).toMatchObject({ class: "included" });      // a snapshot from an older routr
  const gw = snapshotFrom({ rate_limits: { spend_limit: { used_percentage: 130, resets_at: t + 86400 } } }, null, t);
  expect(at(gw)).toMatchObject({ class: "capped", headroom: 0 }); expect(at(gw).windows[0]).toMatchObject({ name: "spend_limit", usedPct: 100, windowMin: null });
});
test("a metered seat gets a position, not a number: after every pool with room, and it takes the overflow", () => {
  const r = rankSubscriptions("strong", [live("claude", 0.6), metered("codex")], cfg());
  expect(r.ranked.map((x) => [x.subscription, x.usable])).toEqual([["claude", 0.35], ["codex", null]]);
  expect(r.ranked[1]).toMatchObject({ class: "metered", usage: "metered", headroom: null }); expect(r.ranked[1].note).toContain("billed"); expect(r.most_room).toBe("claude");
  const spill = rankSubscriptions("strong", [live("claude", 0.2), metered("codex")], cfg());
  expect(spill.ranked.map((x) => x.subscription)).toEqual(["codex", "claude"]); expect(spill.most_room).toBe("codex"); expect(spill.note).toContain("every token there is billed");
  const c = cfg(); c.subscriptions.codex.metered_rank = "with";
  const w = rankSubscriptions("strong", [live("claude", 0.6), metered("codex")], c);
  expect(w.ranked.map((x) => [x.subscription, x.usable, x.usage])).toEqual([["codex", 0.5, "assumed"], ["claude", 0.35, "live"]]);
  expect(rankSubscriptions("strong", [metered("codex")], cfg({ subscriptions: { codex: cfg().subscriptions.codex } })).note).toBe("codex is metered: every token there is billed");
  const g = cfg(); g.subscriptions.cursor.billing = "metered";                                  // a number the caller read wins over the class
  expect(rankSubscriptions("basic", [{ pool: "cursor", source: "given by caller", ageSec: 0, windows: [], headroom: 0.9 }], g).ranked[0]).toMatchObject({ class: "included", usable: 0.8, usage: "given" });
  const b = cfg(); b.subscriptions.claude.billing = "metered";                                   // the reader sees nothing; the user knows
  expect(rankSubscriptions("strong", [none("claude"), live("codex", 0.5)], b).ranked.map((x) => [x.subscription, x.class])).toEqual([["codex", "included"], ["claude", "metered"]]);
  expect(rankSubscriptions("strong", [live("claude", 0.6), { ...metered("codex"), windows: [win(40, 100, null)], headroom: 0.6, class: "capped" }], cfg()).ranked[0]).toMatchObject({ subscription: "codex", class: "capped", usable: 0.4 }); // a cap is a number: ranked by it; unknown length holds the full reserve
});
test("billing and metered_rank are validated like the shares", () => {
  const odd = `${import.meta.dir}/.odd2.json`; writeFileSync(odd, JSON.stringify({ subscriptions: { x: { billing: "free", metered_rank: "first" }, y: { billing: "metered", metered_rank: "with" } } }));
  const r = loadConfig(odd);
  expect(r.config.subscriptions.x).toMatchObject({ billing: null, metered_rank: "after" }); expect(r.config.subscriptions.y).toMatchObject({ billing: "metered", metered_rank: "with" }); expect(r.notes.length).toBe(2);
});
test("broken or missing config falls back to defaults with a note", () => {
  const bad = `${import.meta.dir}/.bad.json`; writeFileSync(bad, "{ not json");
  for (const path of [bad, "/nonexistent/config.json"]) { const r = loadConfig(path); expect(r.config.fallback_level).toBe("standard"); expect(r.notes.length).toBe(1); }
  const odd = `${import.meta.dir}/.odd.json`; writeFileSync(odd, JSON.stringify({ prefer: { debug: "huge" }, subscriptions: { x: { reserve: 0.3 } } }));
  const r = loadConfig(odd); expect(r.config.prefer.debug).toBeUndefined(); expect(r.config.subscriptions.x.hardest_work).toBe("strong"); expect(r.notes.length).toBe(1);
});

test("launch plans use each harness's measured permissions and model syntax", () => {
  expect(plan({ kind: "claude", model: "sonnet", effort: "medium" }).argv)
    .toEqual(["--dangerously-skip-permissions", "--model", "sonnet", "--effort", "medium"]);
  expect(plan({ kind: "codex", model: "gpt-5.6-sol", effort: "high" }).argv)
    .toEqual(["--yolo", "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=high"]);
  expect(plan({ kind: "cursor", model: "composer-2.5", cursorConfigDir: "/private/config" }))
    .toMatchObject({ executable: "cursor-agent", argv: ["--yolo", "--trust", "--model", "composer-2.5"], env: { CURSOR_CONFIG_DIR: "/private/config" } });
  expect(plan({ kind: "agy", model: "gemini-3.8-flash-low", cwd: "/work" }).argv)
    .toEqual(["--dangerously-skip-permissions", "--add-dir", "/work", "--model", "gemini-3.8-flash-low"]);
});
test("agy rejects separate effort, even when it agrees with the model suffix", () => {
  for (const effort of ["low", "high"]) expect(() => plan({ kind: "agy", model: "gemini-3.8-flash-low", effort, cwd: "/work" })).toThrow("omit --effort");
  expect(() => plan({ kind: "agy", model: "gemini-3.8-flash-low" })).toThrow("--add-dir");
  expect(() => plan({ kind: "cursor", model: "composer-2.5", effort: "low" })).toThrow("no separate --effort");
});
test("a model is required except when only planning; unknown kinds are rejected", () => {
  expect(() => plan({ kind: "claude" })).toThrow("--model is required");
  expect(plan({ kind: "claude", dryRun: true }).warnings).toHaveLength(1);
  expect(() => plan({ kind: "toString", model: "x" })).toThrow("--kind");
});
test("launch prompt preserves the required opening, task with verification, and closing verbatim", () => {
  const task = "TASK\nFix the parser. Work only in /work.\n\nHOW TO VERIFY\nbun test";
  const prompt = composePrompt(task);
  const doc = readFileSync(new URL("../skills/routr/references/orchestrator.md", import.meta.url), "utf8");
  const opening = doc.match(/       You are a routr worker\.[\s\S]*?orchestrator parses\./)[0].trim().replace(/\s*\n\s*/g, " ").replace("~/.agents/skills/routr/references/worker.md", WORKER_GUIDE);
  expect(isAbsolute(WORKER_GUIDE)).toBe(true);
  expect(prompt).toBe(`${opening}\n\n${task}\n\nFinish with the report block from the worker guide, starting with the line \`VERDICT: done | partial | blocked\`.`);
});
test("shell detection distinguishes dotenv, a clean prompt, and unfinished startup", () => {
  expect(shellPrompt("found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver) ")).toBe("dotenv");
  for (const text of ["chris@host repo % ", "user@host:~/repo$ ", "❯ ", "\x1b[32m❯\x1b[0m ", "root #", "found '.env' file. Source it? ([y]es/[N]o)\n❯ "])
    expect(shellPrompt(text)).toBe("ready");
  expect(shellPrompt("")).toBe("waiting");
  expect(shellPrompt("Install the plugin? [y/N]")).toBe("question");
  expect(shellPrompt(" dev@workstation  ~/Repos/routr  ↱ routr-skill ")).toBe("ready");
  expect(shellPrompt("> ")).toBe("question");
  for (const text of ["Loading...", "❯ bun test", "100% complete"])
    expect(shellPrompt(text)).toBe("unrecognized");
});
test("shell output that merely ends like a prompt never counts on its own", () => {
  // Found by an audit of this code: these come from the shell itself, so no foreground process gives them away.
  for (const text of ["Downloading plugins 45%", "nvm: installed 100%", "plugin cache rebuilt: 12 files $"])
    expect(promptSettled(text, "something else")).toBe(false);
  expect(promptSettled("Downloading plugins 45%", "Downloading plugins 45%")).toBe(true); // settled: the launcher then also requires an idle shell
});
test("a trust dialog's options come only from the dialog", () => {
  const withTips = "Tips for getting started:\n  1. Run /init\n  2. Ask questions\n\nDo you trust the files in this folder?\n\n  1. Yes, I trust this folder\n❯ 2. No, exit";
  expect(trustDialog(withTips)).toMatchObject({ affirmative: { text: "Yes, I trust this folder" }, keys: ["up", "enter"] });
  expect(trustDialog(withTips).options).toHaveLength(2);   // the tip list above the question is not an option
});
test("an unrecognized prompt counts only once it has stopped changing", () => {
  const powerline = " dev@workstation  ~/Repos/routr  ↱ routr-skill ";
  expect(promptSettled(powerline, powerline.trim())).toBe(true);   // same line twice: settled
  expect(promptSettled(powerline, "Loading...")).toBe(false);       // still changing
  expect(promptSettled("", "")).toBe(false);                        // nothing on the line is never a prompt
});
const claudeTrust = "Do you trust the files in this folder?\n\n  1. Yes, I trust this folder\n❯ 2. No, exit\n\nEnter to confirm · Esc to cancel";
const codexTrust = "Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\nPress enter to continue";
test("trust detection chooses the affirmative option even when No is selected", () => {
  expect(trustDialog(claudeTrust)).toMatchObject({ affirmative: { number: "1", text: "Yes, I trust this folder" }, keys: ["up", "enter"] });
  expect(trustDialog(codexTrust)).toMatchObject({ affirmative: { number: "1" }, keys: ["enter"] });
  expect(trustDialog("Trust this workspace?\n› 1. No, exit\n  2. Yes, continue")?.keys).toEqual(["down", "enter"]);
  expect(trustDialog(claudeTrust.replace("❯", " "))?.keys).toBeNull();
  expect(trustDialog("Do you trust the files in this folder?" )?.keys).toBeNull();
  expect(trustDialog("Folder trust is configured.\nReady\n❯")).toBeNull();
  expect(trustDialog("Ready\n❯")).toBeNull();
});
const CURSOR_USAGE_PANEL = ` Usage • Pro
 Monthly plan and on-demand usage
 Category        Current             Usage
 Included        3% used             ████░░░░
   Auto          3% used             ████░░░░
   API           1% used             █░░░░░░░
 On-Demand       Disabled            ————————
 View in dashboard: cursor.com/dashboard?tab=usage
 Esc to close
  Cursor Grok 4.6 High · 8.7%`;

test("parseCursorUsage reads Included, Auto, API, and the plan, and ignores the footer meter", () => {
  expect(parseCursorUsage(CURSOR_USAGE_PANEL)).toEqual({
    plan: "Pro", included_used_pct: 3, auto_used_pct: 3, api_used_pct: 1,
  });
  expect(parseCursorUsage(" Usage • Pro                                                                     Resets Oct 9\n Included        4% used").plan).toBe("Pro");
});
test("parseCursorUsage accepts a panel that only has the Included line", () => {
  expect(parseCursorUsage("Included        3% used             ████░░░░")).toEqual({
    plan: null, included_used_pct: 3, auto_used_pct: null, api_used_pct: null,
  });
});
test("parseCursorUsage returns null for the footer context meter alone", () => {
  expect(parseCursorUsage("  Cursor Grok 4.6 High · 8.7%")).toBeNull();
});
test("parseCursorUsage returns null for empty text", () => {
  expect(parseCursorUsage("")).toBeNull();
  expect(parseCursorUsage("   \n  ")).toBeNull();
});

test("pane reads extract text from JSON without mistaking envelope fields for pane contents", () => {
  expect(paneText({ id: "cli:pane:read", result: { text: claudeTrust, type: "pane_read" } })).toBe(claudeTrust);
  expect(paneText({ result: { snapshot: { lines: ["hello", "❯"] } } })).toBe("hello\n❯");
  expect(paneText("❯")).toBe("❯");
  expect(() => paneText({ result: { type: "unknown" } })).toThrow("Unrecognized");
});
test("launch options are validated before any pane operation", () => {
  const base = ["--kind", "claude", "--name", "worker"];
  for (const extra of [["--timeout", "0"], ["--timeout", "NaN"], ["--trust", "yes"], ["--direction", "left"], ["--task", "a", "--task-file", "b"], ["--model"], ["--bogus"], ["--name", "duplicate"]])
    expect(() => parseLaunchArgs([...base, ...extra])).toThrow();
  expect(parseLaunchArgs(base)).toMatchObject({ trust: "ask", timeout: 120000, dryRun: false });
  expect(quote("a'$(touch /tmp/no);`whoami`\n")).toBe("'a'\\''$(touch /tmp/no);`whoami`\n'");
});

function fakeHerdr({ kind = "claude", trust = null, notReady = false, foreground = false, stuck = false, reply = () => undefined } = {}) {
  let stage = "shell", dotenv = true, ticks = 0;
  const calls = [];
  const ok = (result) => ({ ok: true, data: { result } });
  const deps = {
    env: { HERDR_ENV: "1" }, now: () => ticks, sleep: async (ms) => { ticks += ms; },
    run: async (a, ms) => {
      calls.push(a);
      const override = await reply(a, ms);
      if (override !== undefined) return override;
      if (a[0] === "pane" && a[1] === "current") return ok({ pane: { pane_id: "w1:p1" } });
      if (a[1] === "layout") return ok({ layout: { panes: [{ pane_id: "w1:p1", rect: { width: 100, height: 40 } }] } });
      if (a[1] === "split") return ok({ pane: { pane_id: "w1:p2" } });
      if (a[1] === "read") return ok({ text: stage === "shell" ? (dotenv ? "found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)" : "chris % ") : stage === "trust" ? trust : "Welcome\n❯" });
      if (a[1] === "process-info") return ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: foreground ? 2 : 1, cwd: process.cwd() }] } });
      if (a[1] === "send-keys") {
        if (stage === "shell") { expect(a.slice(3)).toEqual(["n", "enter"]); dotenv = false; }
        else { expect(a.slice(3)).toEqual(trustDialog(trust).keys); stage = "starting"; }
        return ok({});
      }
      if (a[1] === "run") return ok({});
      if (a[1] === "close" || a[1] === "rename") return ok({});
      if (a[1] === "start") {
        expect(dotenv).toBe(false); stage = trust ? "trust" : "starting";
        return notReady ? { ok: false, data: { error: { code: "agent_not_ready", message: "blocked on startup" } } } : ok({});
      }
      if (a[1] === "wait") { expect(stage).not.toBe("trust"); if (!stuck) stage = "ready"; return ok({}); }
      if (a[1] === "get") return ok({ agent: { agent: kind, agent_status: stage === "ready" ? "idle" : "unknown", interactive_ready: stage === "ready" } });
      if (a[1] === "prompt") { expect(stage).toBe("ready"); expect(a).toContain("--wait"); return ok({}); }
      throw new Error(`Unexpected command ${a.join(" ")}`);
    },
  };
  return { calls, deps };
}
const launchArgs = ["--kind", "claude", "--name", "worker", "--model", "sonnet"];
test("startup answers the shell, recovers agent_not_ready, selects trust, then prompts", async () => {
  const f = fakeHerdr({ trust: claudeTrust, notReady: true });
  const r = await launch([...launchArgs, "--trust", "auto", "--task", "Fix the parser. Verify with bun test."], f.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted", pane: "w1:p2", needs_human: null });
  expect(r.warnings.join(" ")).toContain("Answered no");
  expect(r.steps.find((s) => s.step === "trust").detail).toContain("1. Yes, I trust this folder; sent up, enter");
  expect(r.steps.map((s) => s.step).indexOf("ready")).toBeLessThan(r.steps.map((s) => s.step).indexOf("prompt"));
});
test("Codex idle at trust still needs a human under the default policy", async () => {
  const f = fakeHerdr({ kind: "codex", trust: codexTrust });
  const r = await launch(["--kind", "codex", "--name", "worker", "--model", "gpt-5.6-sol", "--task", "Task"], f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_human", needs_human: { pane_text: codexTrust } });
  expect(f.calls.some((a) => a[1] === "prompt" || a[1] === "close")).toBe(false);
  expect(f.calls.filter((a) => a[1] === "send-keys")).toHaveLength(1); // dotenv only
});
test("auto trust leaves an ambiguous menu alive without guessing an answer", async () => {
  const f = fakeHerdr({ trust: claudeTrust.replace("❯", " "), notReady: true });
  const r = await launch([...launchArgs, "--trust", "auto"], f.deps);
  expect(r.state).toBe("needs_human");
  expect(f.calls.filter((a) => a[1] === "send-keys")).toHaveLength(1);
});
test("an existing occupied pane receives no input and is never closed", async () => {
  const f = fakeHerdr({ foreground: true });
  const r = await launch([...launchArgs, "--pane", "w1:p9"], f.deps);
  expect(r.state).toBe("needs_human");
  expect(f.calls.every((a) => ["read", "process-info"].includes(a[1]))).toBe(true);
});
test("startup timeout fails without ever prompting or closing the pane", async () => {
  const f = fakeHerdr({ stuck: true });
  const r = await launch([...launchArgs, "--timeout", "1500", "--task", "Task"], f.deps);
  expect(r.state).toBe("failed");
  expect(r.steps.at(-1).detail).toContain("timeout");
  expect(f.calls.some((a) => ["prompt", "close"].includes(a[1]))).toBe(false);
});
test("dry runs perform no transport calls, including for Cursor isolation", async () => {
  for (const [kind, model] of [["claude", "sonnet"], ["codex", "gpt-5.6-sol"], ["cursor", "composer-2.5"], ["agy", "gemini-3.8-flash-low"]]) {
    const r = await launch(["--kind", kind, "--name", "t", "--model", model, "--dry-run"], { run: () => { throw new Error("Dry run called Herdr"); } });
    expect(r).toMatchObject({ ok: true, state: "planned", pane: null, command: [] });
    expect(r.planned_command.length).toBeGreaterThan(0);
    if (kind === "cursor") expect(existsSync(r.env.CURSOR_CONFIG_DIR)).toBe(false);
  }
});
test("task files are read and wrapped before any launch operation", async () => {
  const file = `${import.meta.dir}/../package.json`;
  const r = await launch([...launchArgs, "--task-file", file, "--dry-run"]);
  expect(r.state).toBe("planned");
  expect(r.prompt_chars).toBe(composePrompt(readFileSync(file, "utf8")).length);
  const missing = await launch([...launchArgs, "--task-file", "/does-not-exist", "--dry-run"]);
  expect(missing).toMatchObject({ ok: false, state: "failed", command: [] });
});
test("launch CLI emits one JSON object for invalid input and preserves --version", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const result = Bun.spawnSync(["bun", script, "launch", ...launchArgs, "--timeout", "bad"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString()).state).toBe("failed");
  const version = Bun.spawnSync(["bun", script, "--version"]);
  expect(version.exitCode).toBe(0);
  expect(version.stdout.toString().trim()).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

const herdrOK = (result = {}) => ({ ok: true, data: { result } });
const herdrError = (code) => ({ ok: false, data: { error: { code, message: code } } });
const shellInfo = (foreground_processes = [{ pid: 1, cwd: process.cwd() }]) => herdrOK({ process_info: { shell_pid: 1, foreground_processes } });
const CURSOR_UI = "  Cursor Agent\n  Grok 4.6 High\n  /tmp";

function fakeCursorUsage({ delayPanel = false } = {}) {
  let stage = "shell", dotenv = true, ticks = 0, extraEnter = false;
  const calls = [];
  const deps = {
    env: { HERDR_ENV: "1" }, tmp: "/tmp", now: () => ticks, sleep: async (ms) => { ticks += ms; },
    run: async (a) => {
      calls.push(a);
      if (a[0] === "pane" && a[1] === "split") {
        expect(a).toEqual(["pane", "split", "--current", "--direction", "down", "--cwd", "/tmp", "--no-focus"]);
        return herdrOK({ pane: { pane_id: "w1:p2" } });
      }
      if (a[1] === "read") {
        if (stage === "shell") return herdrOK({ text: dotenv ? "found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)" : "chris % " });
        if (stage === "usage") return herdrOK({ text: delayPanel && !extraEnter ? CURSOR_UI : CURSOR_USAGE_PANEL });
        return herdrOK({ text: CURSOR_UI });
      }
      if (a[1] === "process-info") return shellInfo();
      if (a[1] === "send-keys") {
        if (stage === "shell") { expect(a.slice(3)).toEqual(["n", "enter"]); dotenv = false; }
        else if (a[3] === "enter" && stage === "starting") stage = "usage";
        else if (a[3] === "enter") extraEnter = true;
        return herdrOK({});
      }
      if (a[1] === "send-text") { expect(a.slice(3)).toEqual(["/usage"]); return herdrOK({}); }
      if (a[1] === "run") { expect(a[3]).toBe("cursor-agent --trust"); stage = "starting"; return herdrOK({}); }
      if (a[1] === "close") return herdrOK({});
      throw new Error(`Unexpected command ${a.join(" ")}`);
    },
  };
  return { calls, deps };
}

test("cursorUsage answers dotenv, opens /usage, and always closes the pane", async () => {
  const f = fakeCursorUsage();
  const r = await cursorUsage(["cursor"], f.deps);
  expect(r).toEqual({ ok: true, subscription: "cursor", plan: "Pro", included_used_pct: 3, auto_used_pct: 3, api_used_pct: 1, headroom: 0.97, pass_as: "--headroom cursor=0.97" });
  expect(f.calls.some((a) => a[1] === "run" && a[3] === "cursor-agent --trust")).toBe(true);
  expect(f.calls.filter((a) => a[1] === "send-keys" && a[3] === "enter")).toHaveLength(1);
  expect(f.calls.at(-2)).toEqual(["pane", "send-keys", "w1:p2", "esc"]);
  expect(f.calls.at(-1)).toEqual(["pane", "close", "w1:p2"]);
});
test("cursorUsage sends a second enter if the panel is slow, and still closes the pane", async () => {
  const f = fakeCursorUsage({ delayPanel: true });
  const r = await cursorUsage(["cursor"], f.deps);
  expect(r.ok).toBe(true);
  expect(f.calls.filter((a) => a[1] === "send-keys" && a[3] === "enter").length).toBeGreaterThanOrEqual(2);
  expect(f.calls.at(-1)).toEqual(["pane", "close", "w1:p2"]);
});
test("cursorUsage closes a created pane when Cursor never draws", async () => {
  const f = fakeCursorUsage();
  f.deps.run = async (a) => {
    f.calls.push(a);
    if (a[1] === "split") return herdrOK({ pane: { pane_id: "w1:p2" } });
    if (a[1] === "read") return herdrOK({ text: "chris % " });
    if (a[1] === "process-info") return shellInfo();
    if (a[1] === "run" || a[1] === "send-keys" || a[1] === "close") return herdrOK({});
    throw new Error(`Unexpected command ${a.join(" ")}`);
  };
  const r = await cursorUsage(["cursor"], { ...f.deps, timeout: 1000 });
  expect(r).toMatchObject({ ok: false });
  expect(r.error).toContain("timed out");
  expect(f.calls.at(-1)).toEqual(["pane", "close", "w1:p2"]);
});
test("cursorUsage outside herdr fails open without touching a pane", async () => {
  const calls = [];
  const r = await cursorUsage(["cursor"], { env: {}, run: async (a) => { calls.push(a); throw new Error("no pane"); } });
  expect(r).toMatchObject({ ok: false });
  expect(r.error).toContain("HERDR_ENV");
  expect(calls).toEqual([]);
});
test("usage cursor outside herdr prints JSON and exits 0", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const cleanEnv = { ...process.env };
  delete cleanEnv.HERDR_ENV;
  const res = Bun.spawnSync(["bun", script, "usage", "cursor"], { env: cleanEnv });
  expect(res.exitCode).toBe(0);
  expect(JSON.parse(res.stdout.toString())).toMatchObject({ ok: false });
  expect(JSON.parse(res.stdout.toString()).error).toContain("HERDR_ENV");
});

test("launch rejects missing kinds, flag values, empty values, NUL, and every repeated option", () => {
  for (const args of [[], ["--name", "worker"], ["--kind", "toString", "--name", "worker"], ["--kind", "claude"]])
    expect(() => parseLaunchArgs(args)).toThrow();
  for (const option of ["kind", "name", "cwd", "model", "effort", "pane", "direction", "task", "task-file", "trust", "timeout"]) {
    for (const value of ["-h", "--bogus", "", "  ", "a\0b"])
      expect(() => parseLaunchArgs([`--${option}`, value, ...launchArgs])).toThrow();
    expect(() => parseLaunchArgs([`--${option}`, "value", `--${option}`, "again", ...launchArgs])).toThrow("Repeated");
  }
  expect(() => parseLaunchArgs([...launchArgs, "--dry-run", "--dry-run"])).toThrow("Repeated");
  for (const value of ["-1", "1.5", "Infinity", "9007199254740992"])
    expect(() => parseLaunchArgs([...launchArgs, "--timeout", value])).toThrow();
  expect(parseLaunchArgs([...launchArgs, "--task", "- Fix this\n- Run tests"]).task).toStartWith("- Fix");
});

test("preflight failures never read an adopted pane, even for dry runs or outside Herdr", async () => {
  for (const args of [
    ["--kind", "claude", "--name", "worker"],
    [...launchArgs, "--cwd", "/does-not-exist", "--dry-run"],
    [...launchArgs, "--task-file", "/does-not-exist", "--dry-run"],
    [...launchArgs],
  ]) {
    const f = fakeHerdr(); f.deps.env = {};
    const r = await launch([...args, "--pane", "w1:p9"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "failed", command: [] });
    expect(f.calls).toEqual([]);
  }
});

test("launch dispatch cannot be intercepted by a --version option or task value", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  for (const suffix of [["--version"], ["--task", "--version"]]) {
    const r = Bun.spawnSync(["bun", script, "launch", ...launchArgs, ...suffix]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ ok: false, state: "failed", command: [] });
  }
});

test("terminal normalization handles CRLF, redraws, backspaces, and shell input questions", () => {
  for (const text of ["old output\r\n\x1b[32m❯\x1b[0m ", "Loading...\r❯         ", "❯x\b "])
    expect(shellPrompt(text)).toBe("ready");
  expect(shellPrompt("Loading...\r❯")).toBe("unrecognized"); // CR moves the cursor; it does not erase a line.
  expect(shellPrompt("❯x\b")).toBe("unrecognized");
  expect(promptSettled("Loading...\r❯         ", "❯")).toBe(true);
  for (const text of ["Continue [y/N]", "Continue (yes/no)", "Password:", "quote>", "heredoc>"])
    expect(shellPrompt(text)).toBe("question");
  expect(paneText({ text: "envelope", result: { text: "actual pane" } })).toBe("actual pane");
  expect(paneText(["hello", "❯"])).toBe("hello\n❯");
  expect(() => paneText({ error: { message: "failed" }, text: "stale pane" })).toThrow();
  expect(() => paneText({ text: "envelope", result: {} })).toThrow();
});

test("stable arbitrary shell text and partial input never authorize a launch", async () => {
  for (const text of ["Loading...", "Downloading plugins 45%", "❯ bun test", "Password:", "> "]) {
    const f = fakeHerdr({ reply: (a) => a[1] === "read" ? herdrOK({ text }) : undefined });
    const r = await launch([...launchArgs, "--pane", "w1:p9", "--timeout", "1000"], f.deps);
    expect(r.ok).toBe(false);
    expect(f.calls.some((a) => ["send-keys", "run", "start", "close"].includes(a[1]))).toBe(false);
  }
});

test("shell questions receive no keys without evidence that the shell is foreground", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "process-info" ? shellInfo([]) : undefined });
  const r = await launch([...launchArgs, "--pane", "w1:p9", "--timeout", "1000"], f.deps);
  expect(r.ok).toBe(false);
  expect(f.calls.some((a) => ["send-keys", "start", "run"].includes(a[1]))).toBe(false);
});

test("a long shell startup respects --timeout instead of an unrelated 240-poll cap", async () => {
  let polls = 0;
  const f = fakeHerdr({ reply: (a) => a[1] === "process-info" && ++polls <= 245 ? shellInfo([{ pid: 2 }]) : undefined });
  const r = await launch([...launchArgs, "--timeout", "70000"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "ready" });
  expect(f.deps.now()).toBeGreaterThan(60000);
});

test("a prompt must settle again after an intervening foreground command", async () => {
  let polls = 0;
  const f = fakeHerdr({ reply: (a) => {
    if (a[1] === "read" && !f.calls.some((c) => c[1] === "start")) return herdrOK({ text: "❯" });
    if (a[1] === "process-info") return shellInfo(++polls === 2 ? [{ pid: 2 }] : undefined);
    if (a[1] === "start") { expect(polls).toBe(4); return herdrOK(); }
  } });
  expect((await launch(launchArgs, f.deps)).ok).toBe(true);
});

test("a fixed prompt line does not hide changing startup output above it", async () => {
  expect(promptSettled("Loading 2\n❯", "Loading 1\n❯")).toBe(false);
  let reads = 0, started = false;
  const f = fakeHerdr({ reply: (a) => {
    if (a[1] === "read" && !started) return herdrOK({ text: `Loading ${Math.min(++reads, 3)}\n❯` });
    if (a[1] === "start") { started = true; expect(reads).toBe(4); return herdrOK(); }
  } });
  expect((await launch(launchArgs, f.deps)).ok).toBe(true);
});

test("unchanged dotenv questions stop after one answer and leave the pane for a human", async () => {
  let sent = 0;
  const f = fakeHerdr({ reply: (a) => {
    if (a[1] === "send-keys") { sent++; return herdrOK(); }
  } });
  const r = await launch(launchArgs, f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_human" });
  expect(r.needs_human.why).toContain("did not clear");
  expect(sent).toBe(1);
  expect(f.deps.now()).toBe(5000);
});

test("a settled shell in the wrong directory is reported rather than started", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "process-info" ? shellInfo([{ pid: 1, cwd: "/" }]) : undefined });
  const r = await launch(launchArgs, f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_human" });
  expect(r.needs_human.why).toContain("wrong directory");
  expect(f.calls.some((a) => a[1] === "start")).toBe(false);
});

test("trust parsing ignores old dialogs and refuses ambiguous menus", () => {
  expect(trustDialog(`${claudeTrust}\nReady\n❯`)).toBeNull();
  expect(trustDialog(`Folder trust is configured.\n1. Yes, continue\n› 2. No`)).toBeNull();
  expect(trustDialog(`${claudeTrust}\n\n${codexTrust}`).keys).toEqual(["enter"]);
  expect(trustDialog(codexTrust.replace("?", "?\n/projects/$")).keys).toEqual(["enter"]);
  expect(trustDialog(codexTrust.split("\n").map((line) => `│ ${line} │`).join("\n")).keys).toEqual(["enter"]);
  for (const options of [
    "› 1. Yes, continue\n❯ 2. No, quit",
    "› 1. Yes, continue\n2. Yes, I trust this folder",
    "› 1. No, quit\n3. Yes, continue",
    "› 1. Yes, delete all files\n2. No, quit",
    "› 1. No, quit\nUnrelated menu:\n2. Yes, continue",
  ]) expect(trustDialog(`Do you trust this folder?\n${options}`).keys).toBeNull();
});

test("a persistent trust dialog is answered once, then requires a human", async () => {
  const f = fakeHerdr({ trust: claudeTrust, reply: (a) =>
    a[1] === "send-keys" && a[3] !== "n" ? herdrOK() : undefined });
  const r = await launch([...launchArgs, "--trust", "auto"], f.deps);
  expect(r).toMatchObject({ ok: false, state: "needs_human" });
  expect(r.needs_human.why).toContain("did not clear");
  expect(f.calls.filter((a) => a[1] === "send-keys" && a[3] !== "n")).toHaveLength(1);
  expect(r.warnings.join(" ")).toContain("Accepted folder trust");
  expect(f.deps.now()).toBeLessThan(6000);
});

test("a different trust menu after one acceptance stops without sending more keys", async () => {
  let answered = false;
  const f = fakeHerdr({ trust: claudeTrust, reply: (a) => {
    if (a[1] === "send-keys" && a[3] !== "n") { answered = true; return herdrOK(); }
    if (a[1] === "read" && answered) return herdrOK({ text: codexTrust });
  } });
  const r = await launch([...launchArgs, "--trust", "auto"], f.deps);
  expect(r.state).toBe("needs_human");
  expect(r.needs_human.why).toContain("different");
  expect(f.calls.filter((a) => a[1] === "send-keys" && a[3] !== "n")).toHaveLength(1);
});

test("fatal start, wait, and inspection errors cannot be masked by UI or polled forever", async () => {
  for (const op of ["start", "wait", "get"]) {
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === op) return herdrError("invalid_request");
      if (op === "start" && a[1] === "read" && f.calls.some((c) => c[1] === "start")) return herdrOK({ text: claudeTrust });
    } });
    const r = await launch([...launchArgs, "--trust", "auto"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "failed" });
    expect(f.calls.filter((a) => a[1] === op)).toHaveLength(1);
    expect(f.calls.some((a) => a[1] === "prompt" || (a[1] === "send-keys" && a[3] !== "n"))).toBe(false);
    expect(r.command.length).toBe(f.calls.length); // Includes the diagnostic read.
  }
});

test("explicitly false interactive readiness cannot authorize prompt submission", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "get" ? herdrOK({ agent: { agent: "claude", agent_status: "idle", interactive_ready: false } }) : undefined });
  const r = await launch([...launchArgs, "--timeout", "1000", "--task", "Task"], f.deps);
  expect(r.ok).toBe(false);
  expect(f.calls.some((a) => a[1] === "prompt")).toBe(false);
});

for (const readiness of [undefined, null, false]) test(`Cursor idle readiness ${readiness} is handled after pane run`, async () => {
  const root = mkdtempSync(join(import.meta.dir, ".cursor-readiness-"));
  const source = join(root, "source.json");
  writeFileSync(source, '{"model":"original"}');
  try {
    let started = false;
    const f = fakeHerdr({ kind: "cursor", reply: (a) => {
      if (a[1] === "run") started = true;
      if (started && a[1] === "read") return herdrOK({ text: "Welcome to Cursor\n❯" });
      if (a[1] === "get") return herdrOK({ agent: { agent: "cursor", agent_status: "idle",
        ...(readiness === undefined ? {} : { interactive_ready: readiness }) } });
    } });
    const r = await launch(["--kind", "cursor", "--name", "worker", "--model", "composer-2.5", "--timeout", "1500", "--task", "Task"],
      { ...f.deps, cursorConfigSource: source, tempRoot: root });
    const ready = readiness !== false;
    expect(started).toBe(true);
    expect(r).toMatchObject({ ok: ready, state: ready ? "prompted" : "failed" });
    expect(f.calls.filter((a) => a[1] === "prompt")).toHaveLength(ready ? 1 : 0);
    expect(f.calls.some((a) => a[1] === "rename")).toBe(ready);
    if (!ready) expect(r.steps.find((s) => s.step === "failed").detail).toContain("timeout");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prompt results distinguish blocked, unknown, wrong-agent, refusal, and observed work", async () => {
  for (const { status, response, kind = "claude", expected } of [
    { status: "blocked", response: herdrOK(), expected: "needs_human" },
    { status: "blocked", response: herdrError("agent_blocked"), expected: "needs_human" },
    { status: "unknown", response: herdrOK(), expected: "failed" },
    { status: "working", response: herdrError("agent_prompt_stalled"), expected: "failed" },
    { status: "working", response: herdrError("timeout"), expected: "prompted" },
    { status: "idle", response: herdrError("timeout"), expected: "failed" },
    { status: "done", response: herdrOK(), expected: "prompted" },
    { status: "working", response: herdrOK(), kind: "codex", expected: "needs_human" },
  ]) {
    let submitted = false;
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === "prompt") { submitted = true; return response; }
      if (a[1] === "get" && submitted) return herdrOK({ agent: { agent: kind, agent_status: status } });
    } });
    const r = await launch([...launchArgs, "--task", "Task"], f.deps);
    expect(r.state).toBe(expected);
    expect(r.ok).toBe(expected === "prompted");
    expect(f.calls.filter((a) => a[1] === "prompt")).toHaveLength(1);
    if (expected !== "prompted") expect(r.warnings.join(" ")).toContain("before retrying");
    if (response.data.error?.code === "agent_blocked") expect(r.steps.find((s) => s.step === "prompt").ok).toBe(false);
  }
});

test("prompt waits request activity and reserve deadline budget for the status read", async () => {
  let submitted = false;
  const f = fakeHerdr({ reply: async (a, ms) => {
    if (a[1] === "prompt") {
      submitted = true;
      expect(a.slice(4, -2)).toEqual(["--wait", "--until", "working", "--until", "idle", "--until", "done", "--until", "blocked"]);
      expect(ms).toBeLessThanOrEqual(1500 - f.deps.now());
      expect(Number(a.at(-1))).toBeLessThan(ms);
      await f.deps.sleep(ms);
      return herdrError("timeout");
    }
    if (a[1] === "get" && submitted) return herdrOK({ agent: { agent: "claude", agent_status: "working" } });
    expect(ms).toBeGreaterThan(0);
  } });
  const r = await launch([...launchArgs, "--timeout", "1500", "--task", "Task"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "prompted" });
  expect(f.deps.now()).toBeLessThan(1500);
});

test("transport failures after prompt submission return JSON and warn against retrying", async () => {
  for (const failed of ["prompt", "get"]) {
    let submitted = false;
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === "prompt") submitted = true;
      if (submitted && a[1] === failed) throw new Error("connection lost");
    } });
    const r = await launch([...launchArgs, "--task", "Task"], f.deps);
    expect(r).toMatchObject({ ok: false, state: "failed" });
    expect(r.warnings.join(" ")).toContain("Prompt may have been submitted");
    expect(f.calls.filter((a) => a[1] === "prompt")).toHaveLength(1);
  }
});

test("deadline boundaries and large safe timeouts never pass zero or negative durations", async () => {
  for (const timeout of ["1", "9007199254740991"]) {
    const f = fakeHerdr({ reply: (_a, ms) => { expect(Number.isSafeInteger(ms) && ms > 0).toBe(true); } });
    const clock = f.deps.now;
    f.deps.now = () => Number.MAX_SAFE_INTEGER - 100 + clock();
    const r = await launch([...launchArgs, "--timeout", timeout], f.deps);
    expect(r.state).toBe(timeout === "1" ? "failed" : "ready");
  }
});

test("failure before start closes only newly created panes and reports cleanup failure", async () => {
  for (const adopted of [false, true]) for (const closeOK of [false, true]) {
    const f = fakeHerdr({ reply: (a) => {
      if (a[1] === "process-info") throw new Error("inspection failed");
      if (a[1] === "close") return closeOK ? herdrOK() : herdrError("close_failed");
    } });
    const r = await launch([...launchArgs, ...(adopted ? ["--pane", "w1:p9"] : [])], f.deps);
    expect(r.ok).toBe(false);
    expect(f.calls.filter((a) => a[1] === "close")).toHaveLength(adopted ? 0 : 1);
    if (!adopted) {
      expect(r.steps.find((s) => s.step === "cleanup_pane").ok).toBe(closeOK);
      expect(r.warnings.join(" ").includes("left alive")).toBe(!closeOK);
    }
  }
});

// The next two tests stand in for cursor-agent and herdr with /bin/sh stubs, so they run on macOS and Linux only.
// `routr launch` has not been run against herdr on Windows at all (docs/evidence.md).
const unixOnly = test.skipIf(process.platform === "win32");
unixOnly("Cursor removes configs on pre-start failure and on worker exit without changing the source", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".cursor-launch-"));
  const source = join(root, "source.json");
  writeFileSync(source, '{"model":"original"}');
  const args = ["--kind", "cursor", "--name", "worker", "--model", "composer-2.5"];
  try {
    for (const missing of [true, false]) {
      const f = fakeHerdr({ reply: (a) => a[1] === "split" ? herdrError("split_failed") : undefined });
      const r = await launch(args, { ...f.deps, cursorConfigSource: missing ? join(root, "missing") : source, tempRoot: root });
      expect(r.ok).toBe(false);
      expect(existsSync(r.env.CURSOR_CONFIG_DIR)).toBe(false);
      expect(readdirSync(root)).toEqual(["source.json"]);
      if (missing) expect(f.calls).toHaveLength(0);
    }
    const bin = join(root, "bin"); mkdirSync(bin);
    // This executable is a shell stub, never an agent. It proves the actual wrapper's exit cleanup.
    const stub = join(bin, "cursor-agent");
    writeFileSync(stub, '#!/bin/sh\nprintf modified > "$CURSOR_CONFIG_DIR/cli-config.json"\nexit 7\n'); chmodSync(stub, 0o755);
    let started = false, privateDir;
    const f = fakeHerdr({ kind: "cursor", reply: (a) => {
      if (a[1] === "run") {
        started = true;
        privateDir = join(root, readdirSync(root).find((name) => name.startsWith("routr-cursor-")));
        expect(statSync(privateDir).mode & 0o777).toBe(0o700);
        expect(statSync(join(privateDir, "cli-config.json")).mode & 0o777).toBe(0o600);
        const result = Bun.spawnSync(["sh", "-c", a[3]], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
        expect(result.exitCode).toBe(7);
        return herdrOK();
      }
      if (started && a[1] === "read") return herdrOK({ text: "❯" });
    } });
    const r = await launch(args, { ...f.deps, cursorConfigSource: source, tempRoot: root });
    expect(r.state).toBe("ready");
    expect(existsSync(privateDir)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe('{"model":"original"}');
    expect(f.calls.some((a) => a[1] === "rename")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dry-run plans include geometry and shell checks, and skip geometry for explicit direction", async () => {
  const r = await launch([...launchArgs, "--dry-run"]);
  expect(r.planned_command.some((s) => s.includes("pane current --current"))).toBe(true);
  expect(r.planned_command.some((s) => s.includes("pane process-info --pane"))).toBe(true);
  const explicit = await launch([...launchArgs, "--direction", "down", "--dry-run"]);
  expect(explicit.planned_command.some((s) => /pane (current|layout)/.test(s))).toBe(false);
});

unixOnly("transport timeouts return a timeout code, even if the subprocess printed JSON", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".herdr-stub-"));
  try {
    const executable = join(root, "herdr");
    writeFileSync(executable, '#!/bin/sh\nprintf \'{"result":{}}\'\nexec sleep 30\n'); chmodSync(executable, 0o755);
    const modulePath = new URL("../src/lib/launch.mjs", import.meta.url).href;
    const result = Bun.spawnSync(["bun", "-e", `import { runHerdr } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await runHerdr([], 50)));`],
      { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, data: { error: { code: "timeout" } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const rep = (over = {}, kind = "debug", verdict = "done") => ({ work_type: { choice: kind }, verdict: { choice: verdict },
  ...Object.fromEntries(Object.entries({ states_verification: 0.95, covers_brief: 0.95, admits_gaps: 0.05, symptom_patch: 0.05, out_of_scope: 0.05, ...over }).map(([k, p]) => [k, { noul: p }])) });
test("a clean report gives no reason to send it back, and says the orchestrator's own check decides", () => {
  const r = readReport(rep()); expect(r.flags).toEqual([]); expect(r.next).toContain("your own check");
});
test("a symptom patch, an admitted gap, and a non-done verdict are each flagged", () => {
  expect(readReport(rep({ symptom_patch: 0.92 })).flags.join(" ")).toContain("symptom");
  expect(readReport(rep({ admits_gaps: 0.97 }, "debug", "partial")).flags.length).toBe(2);
  expect(readReport(rep({ states_verification: 0.05 })).headline).toContain("1 reason");
});
test("the symptom-patch answer is ignored on work that is not a fix", () => {
  const r = readReport(rep({ symptom_patch: 0.95 }, "review")); expect(r.flags).toEqual([]); expect(r.checks.symptom_patch).toBeUndefined();
});

test("help table covers every command the CLI dispatches", () => {
  const dispatched = ["subagent", "dispatch", "launch", "usage", "doctor", "setup", "uninstall", "check", "record", "assess", "share", "update", "statusline", "skill", "key", "telemetry", "feedback"];
  expect(Object.keys(COMMANDS).sort()).toEqual(dispatched.sort());

  // Every command has a valid description, non-empty synopsis, and flags/args
  for (const name of dispatched) {
    const cmd = COMMANDS[name];
    expect(cmd.name).toBe(name);
    expect(typeof cmd.description).toBe("string");
    expect(cmd.description.length).toBeGreaterThan(10);
    const help = formatCommandHelp(cmd);
    expect(help).toContain(`routr ${name}: ${cmd.description}`);
    expect(help).toContain("--help, -h");
    if (cmd.flags) {
      for (const flag of cmd.flags) {
        expect(flag.name.startsWith("--")).toBe(true);
        expect(typeof flag.description).toBe("string");
        expect(help).toContain(flag.name);
      }
    }
  }

  // launch flags match parseLaunchArgs options
  const launchFlags = COMMANDS.launch.flags.map((f) => f.name.replace(/^--/, ""));
  for (const opt of ["kind", "name", "cwd", "model", "effort", "pane", "direction", "task", "task-file", "trust", "timeout", "dry-run"]) {
    expect(launchFlags).toContain(opt);
  }
  expect(COMMANDS.launch.flags.find((f) => f.name === "--model").required).toBe("required unless --dry-run");

  // Unknown usage string contains every command
  const unknownUsage = formatUnknownUsage();
  for (const name of dispatched) {
    expect(unknownUsage).toContain(`routr ${name}`);
  }

  // Top-level help contains routr description, --version, and all commands
  const topHelp = formatTopLevelHelp();
  expect(topHelp).toContain(DESCRIPTION);
  expect(topHelp).toContain("--version");
  for (const name of dispatched) {
    expect(topHelp).toContain(name);
  }
});

test("top-level help flags and help command print usage and exit 0", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  for (const flag of ["--help", "-h", "help"]) {
    const res = Bun.spawnSync(["bun", script, flag]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toBe("");
    const stdout = res.stdout.toString();
    expect(stdout).toContain(DESCRIPTION);
    expect(stdout).toContain("--version");
    for (const cmd of ["subagent", "dispatch", "launch", "doctor", "check", "record", "assess"]) {
      expect(stdout).toContain(cmd);
    }
  }
});

test("command help prints usage for each command and exits 0", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const commands = ["subagent", "dispatch", "launch", "usage", "doctor", "check", "record", "assess"];
  for (const cmd of commands) {
    for (const flag of ["--help", "-h"]) {
      const res = Bun.spawnSync(["bun", script, cmd, flag]);
      expect(res.exitCode).toBe(0);
      expect(res.stderr.toString()).toBe("");
      const stdout = res.stdout.toString();
      expect(stdout).toContain(`routr ${cmd}: ${COMMANDS[cmd].description}`);
      expect(stdout).toContain(`usage: routr ${cmd}`);
      expect(stdout).toContain("--help, -h");
    }
  }

  // routr launch --help works without HERDR_ENV, does not touch herdr, and exits 0
  const cleanEnv = { ...process.env };
  delete cleanEnv.HERDR_ENV;
  const launchRes = Bun.spawnSync(["bun", script, "launch", "--help"], { env: cleanEnv });
  expect(launchRes.exitCode).toBe(0);
  expect(launchRes.stderr.toString()).toBe("");
  expect(launchRes.stdout.toString()).toContain("routr launch: start a worker");
  expect(launchRes.stdout.toString()).toContain("--kind <kind>");
  expect(launchRes.stdout.toString()).toContain("--model <id>");
  expect(launchRes.stdout.toString()).toContain("required unless --dry-run");

  // routr record --help exits 0 without reading stdin
  const recordRes = Bun.spawnSync(["bun", script, "record", "--help"], { stdin: "ignore" });
  expect(recordRes.exitCode).toBe(0);
  expect(recordRes.stderr.toString()).toBe("");
  expect(recordRes.stdout.toString()).toContain("routr record: append what you chose");
  expect(recordRes.stdout.toString()).toContain("--subscription <name>");
});

test("a brief containing --help as a separate word is routed as a brief, not as help", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  for (const cmd of ["subagent", "dispatch"]) {
    // A throwaway HOME with no key and no config: the command falls back at once instead of calling the network,
    // so this test is about argument handling only and cannot time out on a slow connection.
    const home = mkdtempSync(join(tmpdir(), "routr-nokey-"));
    const res = Bun.spawnSync(["bun", script, cmd, "add", "--help", "to", "the", "CLI"], { env: { ...process.env, HOME: home, USERPROFILE: home, TYPESAFE_API_KEY: "" } });
    rmSync(home, { recursive: true, force: true });
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toBe("");
    const data = JSON.parse(res.stdout.toString());
    expect(data.mode).toBe(cmd);
    expect(data.brief_chars).toBe("add --help to the CLI".length);
  }
});

test("unrecognized mode prints usage from table to stderr and exits 2", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  for (const args of [["unknown-mode"], []]) {
    const res = Bun.spawnSync(["bun", script, ...args]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout.toString()).toBe("");
    const stderr = res.stderr.toString();
    expect(stderr).toContain("usage: routr subagent");
    for (const cmd of ["dispatch", "launch", "doctor", "check", "record", "assess"]) {
      expect(stderr).toContain(`routr ${cmd}`);
    }
  }
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

test("the repository carries no version: the three version fields read 0.0.0-dev, and only the tag sets one", async () => {
  const { ROUTR_VERSION } = await import("../src/lib/version.mjs");
  const root = `${import.meta.dir}/..`;
  expect(ROUTR_VERSION).toBe("0.0.0-dev");
  expect(JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version).toBe("0.0.0-dev");
  expect(readFileSync(`${root}/skills/routr/SKILL.md`, "utf8")).toContain('version: "0.0.0-dev"');
});
test("a release build stamps the tag's version into all three files, and refuses anything that is not a release version", () => {
  const root = mkdtempSync(join(tmpdir(), "routr-stamp-"));
  try {
    for (const f of ["src/lib/version.mjs", "package.json", "skills/routr/SKILL.md"]) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), readFileSync(join(import.meta.dir, "..", f), "utf8"));
    }
    const stamp = (v) => Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/stamp-version.mjs"), v, root]);
    expect(stamp("0.3.0-rc.2").exitCode).toBe(0);
    expect(readFileSync(join(root, "src/lib/version.mjs"), "utf8")).toContain('const BASE = "0.3.0-rc.2";');
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("0.3.0");   // the base version
    expect(readFileSync(join(root, "skills/routr/SKILL.md"), "utf8")).toContain('  version: "0.3.0"'); // what doctor compares
    expect(stamp("v0.3.0").exitCode).not.toBe(0);                                                  // the tag name, not the version
    expect(stamp("0.3").exitCode).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("a pre-release or source build and its skill count as the same release", async () => {
  const { baseVersion } = await import("../src/lib/version.mjs");
  expect(baseVersion("0.3.0-rc.2")).toBe("0.3.0");
  expect(baseVersion("0.0.0-dev")).toBe(baseVersion("0.0.0-dev"));
  expect(baseVersion(undefined)).toBe("");
});

test("routr skill install writes the guides and links them for Claude Code", async () => {
  const { installSkill } = await import("../src/lib/skill-install.mjs");
  const { mkdtempSync, mkdirSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(`${tmpdir()}/routr-skill-`); mkdirSync(`${home}/.claude`);
  const r = installSkill({ home });
  expect(readFileSync(`${home}/.agents/skills/routr/SKILL.md`, "utf8")).toContain("name: routr");
  expect(existsSync(`${home}/.agents/skills/routr/references/worker.md`)).toBe(true);
  expect(readFileSync(`${home}/.claude/skills/routr/SKILL.md`, "utf8")).toContain("name: routr");
  expect(r.installed.length).toBe(2);
  installSkill({ home });                                  // installing again replaces, never fails
});

test("routr key set stores a piped key owner-only, never prints it, and refuses junk", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const home = mkdtempSync(join(tmpdir(), "routr-key-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYPESAFE_API_KEY: "" };
  const good = Bun.spawnSync(["bun", script, "key", "set", "--no-verify"], { env, stdin: Buffer.from("ts_test_0123456789abcdef\n") });
  expect(good.exitCode).toBe(0);
  expect(good.stdout.toString()).not.toContain("0123456789abcdef");
  const file = join(home, ".config/routr/env");
  expect(readFileSync(file, "utf8")).toBe("TYPESAFE_API_KEY=ts_test_0123456789abcdef\n");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  const bad = Bun.spawnSync(["bun", script, "key", "set", "--no-verify"], { env, stdin: Buffer.from("nope\n") });
  expect(bad.exitCode).toBe(1);
  expect(readFileSync(file, "utf8")).toContain("0123456789abcdef");    // the earlier key is untouched
  rmSync(home, { recursive: true, force: true });
});

test("unnumbered trust menus are parsed: Antigravity selects Yes already, Claude Code defaults to No", async () => {
  const { trustDialog } = await import("../src/lib/launch.mjs");
  const agy = trustDialog("Accessing workspace:\n\n/w/x\n\nDo you trust the contents of this project?\n\nAntigravity CLI requires permission to read, edit, and execute files here.\n\n> Yes, I trust this folder\n  No, exit\n\n  ↑/↓ Navigate · enter Confirm\n");
  expect(agy.affirmative.text).toBe("Yes, I trust this folder"); expect(agy.keys).toEqual(["enter"]);
  const claude = trustDialog(" Accessing workspace:\n /w/x\n Quick safety check: Is this a project you created or one you trust? If not, review it first.\n Do you trust the files in this folder?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n");
  expect(claude.keys).toEqual(["down", "enter"]);
  // A menu with no selection marker is never guessed at.
  expect(trustDialog("Do you trust the contents of this project?\n  Yes, I trust this folder\n  No, exit\n").keys).toBeNull();
});

test("launch --copy is repeatable, needs --worktree, and refuses paths outside the repository", async () => {
  const { parseLaunchArgs } = await import("../src/lib/launch.mjs");
  const base = ["--kind", "codex", "--name", "w", "--model", "m"];
  expect(parseLaunchArgs([...base, "--worktree", "b", "--copy", ".env.test", "--copy", "fixtures"]).copy).toEqual([".env.test", "fixtures"]);
  expect(() => parseLaunchArgs([...base, "--copy", "x"])).toThrow("--worktree");
  expect(() => parseLaunchArgs([...base, "--worktree", "b", "--copy", "../secrets"])).toThrow("inside the repository");
  expect(() => parseLaunchArgs([...base, "--worktree", "b", "--copy", "/etc/passwd"])).toThrow("inside the repository");
});

test("an unsure level reads as the lower of the two most likely levels", () => {
  const torn = (probabilities, score) => ({ level: { score, confidence: 0.3, probabilities }, work_type: { choice: "implement", confidence: 1, probabilities: { implement: 1 } }, high_blast_radius: { noul: 0.1 } });
  const a = advise(torn({ 0: 0.05, 1: 0.45, 2: 0.5 }, 1.45), cfg());
  expect(a.level).toBe("standard"); expect(a.between).toEqual(["standard", "strong"]);
  expect(advise(torn({ 0: 0.48, 1: 0.52, 2: 0 }, 0.52), cfg()).level).toBe("basic");
  expect(advise(ans(1.6, 0.9), cfg()).between).toBeUndefined();             // sure: plain rounding, no range
});
test("parsing of →, ->, none, and malformed lines for subagents", async () => {
  const { parseSubagent, parseReportSubagents } = await import("../src/lib/ledger.mjs");

  // unicode arrow →
  expect(parseSubagent("Count Python files → basic → haiku")).toEqual({
    subtask: "Count Python files",
    advised: "basic",
    model: "haiku",
  });

  // ascii arrow ->
  expect(parseSubagent("Review runtime.py error handling -> standard -> sonnet")).toEqual({
    subtask: "Review runtime.py error handling",
    advised: "standard",
    model: "sonnet",
  });

  // extra spaces and mixed arrows
  expect(parseSubagent("   Count Python files   →   basic   ->   haiku   ")).toEqual({
    subtask: "Count Python files",
    advised: "basic",
    model: "haiku",
  });

  // none and SUBAGENTS: none
  expect(parseSubagent("none")).toBeNull();
  expect(parseSubagent("SUBAGENTS: none")).toBeNull();
  expect(parseSubagent("  none  ")).toBeNull();
  expect(parseSubagent("SUBAGENTS: none (one line per subagent, or \"none\")")).toBeNull();

  // malformed lines
  expect(parseSubagent("Count Python files")).toEqual({
    subtask: "Count Python files",
    advised: null,
    model: null,
  });
  expect(parseSubagent("Count Python files → medium → haiku")).toEqual({
    subtask: "Count Python files → medium → haiku",
    advised: null,
    model: null,
  });
  expect(parseSubagent("Count Python files -> basic")).toEqual({
    subtask: "Count Python files -> basic",
    advised: null,
    model: null,
  });

  // parsing from report file
  const reportText = [
    "VERDICT: done",
    "SUMMARY: fixed the bugs",
    "CHECKED: bun test",
    "FILES: file.ts",
    "SUBAGENTS: Count Python files → basic → haiku",
    "SUBAGENTS: none",
    "SUBAGENTS: Review runtime.py error handling -> standard -> sonnet",
    "SUBAGENTS: Malformed text without level",
  ].join("\n");

  expect(parseReportSubagents(reportText)).toEqual([
    { subtask: "Count Python files", advised: "basic", model: "haiku" },
    { subtask: "Review runtime.py error handling", advised: "standard", model: "sonnet" },
    { subtask: "Malformed text without level", advised: null, model: null },
  ]);
});

test("toEntry stores subagents correctly and never stores brief or report text", async () => {
  const { toEntry } = await import("../src/lib/ledger.mjs");
  const advice = {
    id: "a1b2c3d4",
    ts: "2026-09-21T12:00:00.000Z",
    mode: "dispatch",
    question_set: "r3",
    brief_sha: "123456789abc",
    brief_chars: 42,
    level: "standard",
    sure: true,
    work_type: "feature",
    high_risk: false,
    facts: { tiny: { p: 0.1 } },
    subscriptions: { ranked: [{ subscription: "codex", usable: 0.8, usage: "live" }] },
  };

  // With subagents
  const entryWithSubagents = toEntry(advice, {
    subscription: "codex",
    model: "gpt-5",
    effort: "medium",
    verdict: "done",
    check: "pass",
    subagents: [
      "Count Python files → basic → haiku",
      "Review runtime.py error handling -> standard -> sonnet",
      "Count Python files → unknownlevel → haiku",
    ],
    report: "/tmp/report.txt",
    brief: "secret brief text",
  });

  expect(entryWithSubagents.subagents).toEqual([
    { subtask: "Count Python files", advised: "basic", model: "haiku" },
    { subtask: "Review runtime.py error handling", advised: "standard", model: "sonnet" },
    { subtask: "Count Python files → unknownlevel → haiku", advised: null, model: null },
  ]);
  expect(entryWithSubagents.brief).toBeUndefined();
  expect(entryWithSubagents.report).toBeUndefined();
  expect(JSON.stringify(entryWithSubagents)).not.toContain("secret brief text");
  expect(JSON.stringify(entryWithSubagents)).not.toContain("/tmp/report.txt");

  // Without subagents
  const entryEmpty = toEntry(advice, {
    subscription: "codex",
    model: "gpt-5",
    effort: "medium",
    verdict: "done",
    check: "pass",
  });
  expect(entryEmpty.subagents).toEqual([]);

  // Subagents with "none"
  const entryNone = toEntry(advice, {
    subscription: "codex",
    model: "gpt-5",
    effort: "medium",
    verdict: "done",
    check: "pass",
    subagents: ["none"],
  });
  expect(entryNone.subagents).toEqual([]);
});

test("assess includes subagent section with counts and models by advised level", async () => {
  const { toEntry, assess } = await import("../src/lib/ledger.mjs");
  const advice = {
    id: "a1",
    ts: "2026-09-21T12:00:00.000Z",
    mode: "dispatch",
    question_set: "r3",
    brief_sha: "sha1",
    brief_chars: 20,
    level: "standard",
    sure: true,
    work_type: "refactor",
    high_risk: false,
    facts: {},
    subscriptions: { ranked: [] },
  };

  const entry = toEntry(advice, {
    subscription: "codex",
    model: "m",
    effort: "low",
    verdict: "done",
    check: "pass",
    subagents: [
      "Task 1 → basic → haiku",
      "Task 2 → basic → haiku",
      "Task 3 → basic → haiku",
      "Task 4 → basic → sonnet",
      "Task 5 → standard → sonnet",
    ],
  });

  const report = assess([entry]);
  expect(report).toContain("subagents: 5 recorded");
  expect(report).toContain("basic: haiku 3, sonnet 1");
  expect(report).toContain("standard: sonnet 1");
});

test("old ledger rows without a subagents field assess without error", async () => {
  const { assess } = await import("../src/lib/ledger.mjs");
  const oldRow = {
    ts: "2026-09-20T10:00:00.000Z",
    id: "old12345",
    asked_at: "2026-09-20T10:00:00.000Z",
    mode: "dispatch",
    question_set: "r3",
    brief_sha: "abc123456789",
    brief_chars: 30,
    advised: { level: "basic", sure: true, work_type: "fix", high_risk: false, fallback: false, facts: {} },
    headroom: {},
    chose: { subscription: "claude", model: "sonnet", effort: "medium", level: "basic" },
    outcome: { verdict: "done", check: "pass", seconds: 12, attempts: 1, note: null },
    // Notice: NO subagents field
  };

  expect(() => assess([oldRow])).not.toThrow();
  const report = assess([oldRow]);
  expect(report).toContain("1 recorded pieces of work");
  expect(report).not.toContain("subagents:");
});

test("CLI round trip for record with repeatable --subagent and --report flags", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const tempDir = mkdtempSync(join(tmpdir(), "routr-record-test-"));
  const adviceFile = join(tempDir, "advice.json");
  const reportFile = join(tempDir, "report.txt");
  const ledgerFile = join(tempDir, "ledger.jsonl");

  writeFileSync(
    adviceFile,
    JSON.stringify({
      id: "test1234",
      ts: "2026-09-21T12:00:00.000Z",
      mode: "dispatch",
      question_set: "r3",
      brief_sha: "abc",
      brief_chars: 10,
      level: "basic",
      sure: true,
      work_type: "fix",
      high_risk: false,
      facts: {},
      subscriptions: { ranked: [] },
    })
  );

  writeFileSync(
    reportFile,
    [
      "VERDICT: done",
      "SUMMARY: fixed the bug",
      "CHECKED: bun test",
      "FILES: test.js",
      "SUBAGENTS: Count files → basic → haiku",
      "SUBAGENTS: Review diff -> standard -> sonnet",
    ].join("\n")
  );

  // Run record with both --report and repeatable --subagent
  const rec = Bun.spawnSync([
    "bun",
    script,
    "record",
    "--advice", adviceFile,
    "--report", reportFile,
    "--subagent", "Extra task → strong → opus",
    "--subagent", "Another extra -> basic -> haiku",
    "--subscription", "codex",
    "--model", "m",
    "--effort", "low",
    "--verdict", "done",
    "--check", "pass",
    "--ledger", ledgerFile,
  ]);
  expect(rec.exitCode).toBe(0);
  const recOut = JSON.parse(rec.stdout.toString().trim());
  expect(recOut.recorded).toBe("test1234");

  // Read ledger entry
  const entry = JSON.parse(readFileSync(ledgerFile, "utf8").trim());
  expect(entry.subagents).toEqual([
    { subtask: "Count files", advised: "basic", model: "haiku" },
    { subtask: "Review diff", advised: "standard", model: "sonnet" },
    { subtask: "Extra task", advised: "strong", model: "opus" },
    { subtask: "Another extra", advised: "basic", model: "haiku" },
  ]);

  // Run assess
  const ass = Bun.spawnSync(["bun", script, "assess", "--ledger", ledgerFile]);
  expect(ass.exitCode).toBe(0);
  const assOut = ass.stdout.toString();
  expect(assOut).toContain("subagents: 4 recorded");
  expect(assOut).toContain("basic: haiku 2");
  expect(assOut).toContain("standard: sonnet 1");
  expect(assOut).toContain("strong: opus 1");

  rmSync(tempDir, { recursive: true, force: true });
});


test("Windows shell prompts count as ready; a bare continuation prompt still does not", () => {
  for (const text of ["PS C:\\Users\\chris>", "PS C:\\Users\\chris\\AppData\\Local\\Temp\\routr-wintest> ", "C:\\Users\\chris>", "Windows PowerShell\nCopyright (C) Microsoft\n\nPS D:\\work\\my repo>"])
    expect(shellPrompt(text)).toBe("ready");
  expect(shellPrompt("> ")).toBe("question");
  expect(shellPrompt(">> ")).not.toBe("ready");
  expect(shellPrompt("Do you want to continue? C:\\temp>no")).not.toBe("ready");
});

const row = (over = {}) => ({ ts: "2026-09-21T10:11:12.000Z", id: "abc12345", asked_at: "2026-09-21T10:11:00.000Z", mode: "dispatch", question_set: "r4", brief_sha: "deadbeefcafe", brief_chars: 300,
  advised: { level: "standard", sure: true, between: null, work_type: "research", high_risk: false, fallback: false, facts: { approach_open: 0.9 } },
  headroom: { codex: { usable: 0.3, usage: "live" } }, chose: { subscription: "codex", model: "big-model", effort: "medium", level: "standard" },
  outcome: { verdict: "done", check: "pass", seconds: 60, attempts: 1, note: "private note about the client's billing bug" }, subagents: [{ subtask: "count files in the acme repo", advised: "basic", model: "small-model" }], ...over });
test("shared rows carry what tuning needs and nothing that identifies the user or the work", async () => {
  const { shareRows } = await import("../src/lib/ledger.mjs");
  const text = JSON.stringify(shareRows([row()]));
  for (const secret of ["abc12345", "deadbeefcafe", "billing", "acme", "10:11", "big-model", "small-model", "usable"]) expect(text).not.toContain(secret);
  const [r] = shareRows([row()]);
  expect(r).toMatchObject({ v: 1, day: "2026-09-21", advised: { level: "standard", facts: { approach_open: 0.9 } }, chose: { subscription: "codex", level: "standard" }, outcome: { attempts: 1 }, subagents: [{ advised: "basic" }] });
  expect(JSON.stringify(shareRows([row()], { withModels: true }))).toContain("big-model");
});
test("the Jev version that answered travels from the advice into the ledger and the shared rows", async () => {
  const { toEntry, shareRows } = await import("../src/lib/ledger.mjs");
  const e = toEntry({ id: "x", level: "basic", sure: true, facts: {}, question_set: "r4", jev_model: "jev-9.9.9" }, { verdict: "done", check: "pass" });
  expect(e.jev_model).toBe("jev-9.9.9");
  expect(shareRows([e])[0].jev_model).toBe("jev-9.9.9");                   // routr's model, not the user's: it identifies nothing
  expect(toEntry({ id: "y", level: "basic", sure: false, facts: {}, fallback: true }, {}).jev_model).toBeNull(); // fallback advice: Jev never answered
  expect(shareRows([row()])[0].jev_model).toBeNull();                         // rows written before the field existed
});
test("telemetry rows carry what tuning needs, never text or anything that points back at the user's work", async () => {
  const { telemetryRows } = await import("../src/lib/telemetry.mjs");
  const [r] = telemetryRows([row({ jev_model: "jev-1.13.0" })], "install-a");
  const text = JSON.stringify(r);
  for (const secret of ["abc12345", "deadbeefcafe", "billing", "acme", "10:11", "usable", "count files"]) expect(text).not.toContain(secret);
  expect(r).toMatchObject({ day: "2026-09-21", jev_model: "jev-1.13.0", chose: { model: "big-model" }, seconds: 60, subagents: [{ advised: "basic", model: "small-model" }] });
  expect(r.row_key).toMatch(/^[0-9a-f]{32}$/);
  expect(telemetryRows([row({ jev_model: "jev-1.13.0" })], "install-a")[0].row_key).toBe(r.row_key); // resending is harmless
  expect(telemetryRows([row()], "install-b")[0].row_key).not.toBe(r.row_key);                         // and unlinkable across installs
  // The endpoint refuses any string longer than 80 characters: a row must never need one.
  const long = []; JSON.stringify(r, (k, v) => { if (typeof v === "string" && v.length > 80) long.push(k); return v; });
  expect(long).toEqual([]);
});
test("telemetry is on by default and off by any of the usual switches, and always in CI", async () => {
  const { telemetryStatus } = await import("../src/lib/telemetry.mjs");
  expect(telemetryStatus({}, {}).on).toBe(true);
  expect(telemetryStatus({ telemetry: false }, {}).on).toBe(false);
  expect(telemetryStatus({}, { DO_NOT_TRACK: "1" }).why_off).toBe("DO_NOT_TRACK is set");
  expect(telemetryStatus({}, { DO_NOT_TRACK: "0" }).on).toBe(true);
  expect(telemetryStatus({}, { ROUTR_TELEMETRY: "off" }).on).toBe(false);
  expect(telemetryStatus({}, { CI: "true" }).why_off).toBe("running in CI");
  const { loadConfig } = await import("../src/lib/config.mjs");
  const dir = mkdtempSync(join(tmpdir(), "routr-tel-"));
  try {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ telemetry: false, prefer: { review: "standard" } }));
    expect(loadConfig(join(dir, "c.json")).config.telemetry).toBe(false);
    expect(loadConfig(join(dir, "missing.json")).config.telemetry).toBe(true);
    const { setTelemetry } = await import("../src/lib/telemetry.mjs");
    expect(setTelemetry(true, join(dir, "c.json")).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "c.json"), "utf8"))).toEqual({ telemetry: true, prefer: { review: "standard" } }); // the rest is kept
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("telemetry sends only rows it has not sent, and moves on only after the endpoint accepts them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routr-send-"));
  try {
    const ledger = join(dir, "ledger.jsonl");
    writeFileSync(ledger, [row({ ts: "2026-09-21T10:00:00.000Z" }), row({ ts: "2026-09-22T10:00:00.000Z" })].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { sendRows } = await import("../src/lib/telemetry.mjs");
    const bodies = [];
    let status = 500;
    const fetchFn = async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response("{}", { status }); };
    const failed = await sendRows({ ledger, fetchFn });
    expect(failed.ok).toBe(false);
    status = 200;
    expect((await sendRows({ ledger, fetchFn })).sent).toBe(2);   // the failed batch is sent again
    expect((await sendRows({ ledger, fetchFn })).sent).toBe(0);   // and not a third time
    expect(bodies[1].rows.length).toBe(2);
    expect(bodies[1]).toMatchObject({ version: expect.any(String), os: `${process.platform}-${process.arch}` });
    expect(JSON.stringify(bodies)).not.toContain("private note");
    expect(JSON.parse(readFileSync(join(dir, "telemetry.json"), "utf8")).sent_through).toBe("2026-09-22T10:00:00.000Z"); // beside the ledger it read
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("feedback sends what the person wrote, and nothing when there is nothing to send", async () => {
  const { sendFeedback } = await import("../src/lib/telemetry.mjs");
  const dir = mkdtempSync(join(tmpdir(), "routr-fb-")), ledger = join(dir, "ledger.jsonl");
  const sent = [];
  const fetchFn = async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  expect((await sendFeedback("  ", { fetchFn, ledger })).ok).toBe(false);
  expect((await sendFeedback("x".repeat(4001), { fetchFn, ledger })).ok).toBe(false);
  expect((await sendFeedback("the cursor usage read failed twice", { fetchFn, ledger })).ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toBe("the cursor usage read failed twice");
  rmSync(dir, { recursive: true, force: true });
});
test("Jev is asked for the pinned version unless ROUTR_JEV_MODEL names another", async () => {
  const { JEV_MODEL } = await import("../src/lib/questions.mjs");
  const { ask, jevModel } = await import("../src/lib/jev.mjs");
  expect(JEV_MODEL).toMatch(/^jev-\d+\.\d+\.\d+$/);                          // an exact version, never an alias that moves under the evidence
  const saved = { env: process.env.ROUTR_JEV_MODEL, key: process.env.TYPESAFE_API_KEY, fetch: globalThis.fetch };
  const sent = [];
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init.body).model); return new Response(JSON.stringify({ model: "jev-x", answers: {} })); };
  process.env.TYPESAFE_API_KEY = "test-key";
  try {
    delete process.env.ROUTR_JEV_MODEL;
    expect(jevModel()).toBe(JEV_MODEL);
    await ask({}, {});
    process.env.ROUTR_JEV_MODEL = " jev-preview ";
    expect(jevModel()).toBe("jev-preview");
    await ask({}, {});
    expect(sent).toEqual([JEV_MODEL, "jev-preview"]);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [["ROUTR_JEV_MODEL", saved.env], ["TYPESAFE_API_KEY", saved.key]]) v == null ? delete process.env[k] : (process.env[k] = v);
  }
});
test("assess turns the ledger into suggestions about the user's own settings, and only with enough runs", async () => {
  const { assess } = await import("../src/lib/ledger.mjs");
  const c = { prefer: { research: "strong" }, subscriptions: { codex: { hardest_work: "standard", reserve: 0.2 } } };
  expect(assess([row(), row()], c)).toContain("Nothing here argues for changing your settings yet");
  const six = Array.from({ length: 6 }, () => row());                       // six research pieces run BELOW the preference, all delivered
  const report = assess(six, c);
  expect(report).toContain('prefer.research is "strong": agents went lower 6 times and 6 delivered');
  expect(report).toContain("If you trust it with more, raise hardest_work");
  const struggling = Array.from({ length: 5 }, () => row({ outcome: { verdict: "done", check: "pass", attempts: 2 } }));
  expect(assess(struggling, c)).toContain("subscriptions.codex.hardest_work");
  expect(report).not.toContain("TOO LOW");                                    // the level review is for the lab, not the user
});

test("ledger rows are labelled with their project, a worktree counts as its repository, and the label is never shared", async () => {
  const { projectName, toEntry, shareRows, assess } = await import("../src/lib/ledger.mjs");
  const root = mkdtempSync(join(tmpdir(), "routr-proj-"));
  mkdirSync(join(root, "acme-api", ".git"), { recursive: true }); mkdirSync(join(root, "acme-api", "src", "deep"), { recursive: true });
  expect(projectName(join(root, "acme-api", "src", "deep"))).toBe("acme-api");
  mkdirSync(join(root, "wt", "fix-branch"), { recursive: true });
  writeFileSync(join(root, "wt", "fix-branch", ".git"), `gitdir: ${join(root, "acme-api", ".git", "worktrees", "fix-branch")}\n`);
  expect(projectName(join(root, "wt", "fix-branch"))).toBe("acme-api");
  const e = toEntry({ id: "x", level: "basic", sure: true, facts: {} }, { project: "acme-api", verdict: "done", check: "pass" });
  expect(e.project).toBe("acme-api");
  expect(JSON.stringify(shareRows([e]))).not.toContain("acme-api");
  const other = { ...e, project: "site" };
  expect(assess([e, other])).toContain("by project");
  expect(assess([e])).not.toContain("by project");                        // one project: no breakdown to show
  rmSync(root, { recursive: true, force: true });
});

test("update picks the right release asset and compares versions like semver", async () => {
  const { assetName, newer } = await import("../src/lib/update.mjs");
  expect(assetName("darwin", "arm64")).toBe("routr-darwin-arm64");
  expect(assetName("linux", "x64")).toBe("routr-linux-x64");
  expect(assetName("win32", "arm64")).toBe("routr-windows-x64.exe");
  expect(assetName("freebsd", "x64")).toBeNull();
  expect(newer("0.1.10", "0.1.9")).toBe(true);
  expect(newer("v0.2.0", "0.1.99")).toBe(true);
  expect(newer("0.1.6", "0.1.6")).toBe(false);
  expect(newer("0.1.6", "0.1.6-rc.1")).toBe(true);        // the release is newer than its own pre-release
  expect(newer("0.1.5", "0.1.6")).toBe(false);
});

test("the background update check is due at most once a day, and the config can turn it off", async () => {
  const { dueForCheck } = await import("../src/lib/update.mjs");
  const now = 1_800_000_000_000;
  expect(dueForCheck(NaN, now)).toBe(true);                               // never checked
  expect(dueForCheck(now - 2 * 3600 * 1000, now)).toBe(false);            // two hours ago
  expect(dueForCheck(now - 25 * 3600 * 1000, now)).toBe(true);
  const off = `${import.meta.dir}/.noupdate.json`; writeFileSync(off, JSON.stringify({ auto_update: false }));
  expect(loadConfig(off).config.auto_update).toBe(false);
  expect(loadConfig("/nonexistent/config.json").config.auto_update).toBe(true);
});

test("doctor's next steps name the command for each thing missing, most important first", async () => {
  const { nextSteps, starterConfig } = await import("../src/lib/doctor.mjs");
  const { ROUTR_VERSION } = await import("../src/lib/version.mjs");
  const base = { key: { works: true }, config: { exists: true, subscriptions: ["claude"] }, harnesses: { claude: { installed: true } }, claude_usage_statusline: "installed", skill: [{ version: ROUTR_VERSION.split("-")[0] }], herdr: { path: "/x", skill: true } };
  expect(nextSteps(base)).toEqual([]);
  const fresh = nextSteps({ ...base, key: { works: false, found: false }, config: { exists: false, subscriptions: [] }, claude_usage_statusline: "missing: without it Claude usage is assumed, not read" });
  expect(fresh[0]).toContain("routr key set");
  expect(fresh[1]).toContain("routr setup");
  expect(fresh.length).toBe(3);
  expect(nextSteps({ ...base, harnesses: { claude: { installed: true }, codex: { installed: true } } })[0]).toContain("codex");
  // Claude answered and sent no windows: the user says whether the seat has a quota; once `billing` is set, nothing to do.
  const reading = (snap) => { const u = claudeSnapshot(snap, NOW / 1000); return { installed: true, usage_class: u.class, usage_note: u.note, ...(u.reason ? { usage_reason: u.reason } : {}) }; };
  const noWindows = { ...base, harnesses: { claude: reading({ ts: NOW / 1000, rate_limits: null, answered: true, seen: null }) } };
  expect(nextSteps(noWindows)[0]).toContain('"billing": "metered"'); expect(nextSteps(noWindows)[0]).toContain('"billing": "included"');
  expect(nextSteps({ ...noWindows, config: { ...base.config, billing: { claude: "metered" } } })).toEqual([]);
  expect(nextSteps({ ...noWindows, config: { ...base.config, billing: { claude: "included" } } })).toEqual([]);
  expect(nextSteps({ ...noWindows, harnesses: { claude: reading({ ts: NOW / 1000, rate_limits: null, answered: false, seen: null }) } })).toEqual([]); // before the first response: nothing to say yet
  // The starter config never carries a placeholder: a model is there only when the user chose one.
  const c = starterConfig(["claude", "agy"], { claude: "sonnet" });
  expect(c.subscriptions.claude).toEqual({ hardest_work: "strong", reserve: 0.25, default_model: "sonnet", default_effort: "medium" });
  expect(c.subscriptions.agy).toEqual({ hardest_work: "standard", reserve: 0.1 });
  expect(starterConfig(["codex"], {}, { codex: "with" }).subscriptions.codex).toMatchObject({ metered_rank: "with" });
  const { parseMetered, meteredRanks } = await import("../src/lib/setup.mjs");
  expect(parseMetered(["--metered", "codex=with", "--metered", "agy=after"])).toEqual({ codex: "with", agy: "after" });
  for (const bad of [["--metered", "codex=first"], ["--metered", "nope=after"], ["--metered"]]) expect(() => parseMetered(bad)).toThrow("--metered takes");
  // The rank question: only for a fresh pool that reads as metered and has no flag; Enter or anything but "w…" is after; --yes (no ask) is after.
  const hs = { codex: { usage_class: "metered", usage_note: "n" }, claude: { usage_class: "included" } };
  const asked = [];
  expect(await meteredRanks(["codex", "claude"], hs, {}, async (n) => { asked.push(n); return " With "; })).toEqual({ codex: "with" }); expect(asked).toEqual(["codex"]);
  expect(await meteredRanks(["codex"], hs, {}, async () => "")).toEqual({ codex: "after" });
  expect(await meteredRanks(["codex"], hs, { codex: "with" }, async () => { throw new Error("must not ask"); })).toEqual({ codex: "with" });
  expect(await meteredRanks(["codex"], hs, {}, null)).toEqual({ codex: "after" });
});

test("setup never replaces a statusline the user already has", async () => {
  const { statuslinePlan, parseModels } = await import("../src/lib/setup.mjs");
  expect(statuslinePlan(null, "/b/routr statusline")).toEqual({ action: "write", settings: { statusLine: { type: "command", command: "/b/routr statusline" } } });
  expect(statuslinePlan('{"model":"opus"}', "/b/routr statusline").settings.model).toBe("opus");
  expect(statuslinePlan('{"statusLine":{"command":"~/mine.sh"}}', "x").action).toBe("skip");
  expect(statuslinePlan('{"statusLine":{"command":"/b/routr statusline"}}', "x").action).toBe("none");
  expect(statuslinePlan("{not json", "x").action).toBe("skip");
  expect(parseModels(["--yes", "--model", "claude=sonnet", "--model", "codex=m"])).toEqual({ claude: "sonnet", codex: "m" });
  expect(() => parseModels(["--model", "gpt=4"])).toThrow();
});

test("routr setup --yes writes the config once, keeps it afterwards, and starts no harness", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const home = mkdtempSync(join(tmpdir(), "routr-setup-"));
  // An empty PATH: no harness is found, so none is started (a logged-out harness opens a browser to sign in).
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: home, TYPESAFE_API_KEY: "", ROUTR_NO_UPDATE: "1" };
  const first = Bun.spawnSync([process.execPath, script, "setup", "--yes", "--json"], { env });
  expect(first.exitCode).toBe(0);
  const file = join(home, ".config/routr/config.json");
  expect(JSON.parse(first.stdout.toString()).did.join("\n")).toContain("wrote");
  expect(existsSync(join(home, ".agents/skills/routr/SKILL.md"))).toBe(true);              // a missing skill is repaired too
  expect(JSON.parse(readFileSync(file, "utf8")).subscriptions).toEqual({});
  writeFileSync(file, JSON.stringify({ subscriptions: {}, sure_at: 0.9 }));
  const again = Bun.spawnSync([process.execPath, script, "doctor", "--fix", "--yes", "--json"], { env }); // the same command under its familiar name
  expect(JSON.parse(again.stdout.toString()).did).toEqual([]);
  expect(JSON.parse(readFileSync(file, "utf8")).sure_at).toBe(0.9);
  const bad = Bun.spawnSync([process.execPath, script, "setup", "--yes", "--model", "codex=m"], { env });
  expect(bad.exitCode).toBe(1);
  expect(Bun.spawnSync([process.execPath, script, "setup", "--yes", "--metered", "codex=with"], { env }).exitCode).toBe(1); // codex is not found on an empty PATH
});

test("setup searches a long model list instead of printing it", async () => {
  const { narrow, pickModel } = await import("../src/lib/setup.mjs");
  const list = Array.from({ length: 230 }, (_, i) => `vendor-model-${i}`).concat(["cursor-grok-4.6-high", "cursor-grok-4.7-high", "cursor-grok-4.7-low"]);
  expect(narrow(list, "grok high")).toEqual(["cursor-grok-4.6-high", "cursor-grok-4.7-high"]);
  const drive = async (answers, l = list) => { const said = []; const got = await pickModel(l, async () => answers.shift(), (s) => said.push(s)); return { got, said }; };
  const r = await drive(["grok", "2"]);
  expect(r.got).toBe("cursor-grok-4.7-high");
  expect(r.said.length).toBeLessThan(8);                                 // the count and three matches, never 233 lines
  expect((await drive(["grok 4.7 low"])).got).toBe("cursor-grok-4.7-low"); // a single match is taken
  expect((await drive(["vendor", "zzz", ""])).got).toBeUndefined();        // too many, then none, then Enter: left to the lead
  expect((await drive(["2"], ["a", "b"])).got).toBe("b");                  // a short list is printed and picked by number
});

test("routr uninstall keeps the user's data unless purged, unlinks a linked skill, and removes only its own statusline", async () => {
  const { uninstallPlan } = await import("../src/lib/uninstall.mjs");
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const home = mkdtempSync(join(tmpdir(), "routr-un-"));
  const checkout = join(home, "checkout"); mkdirSync(checkout); writeFileSync(join(checkout, "SKILL.md"), "mine");
  for (const d of [".config/routr", ".local/share/routr", ".cache/routr", ".agents/skills/routr", ".claude/skills"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".config/routr/config.json"), "{}");
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "opus", statusLine: { type: "command", command: "/x/routr statusline" } }));
  const linked = process.platform !== "win32";
  if (linked) (await import("node:fs")).symlinkSync(checkout, join(home, ".claude/skills/routr"), "dir");
  expect(uninstallPlan({ home }).keep.length).toBe(2);
  expect(uninstallPlan({ home, purge: true }).keep.length).toBe(0);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYPESAFE_API_KEY: "" };
  expect(Bun.spawnSync([process.execPath, script, "uninstall"], { env, stdin: Buffer.from("") }).exitCode).toBe(1); // no terminal and no --yes: refuses
  expect(Bun.spawnSync([process.execPath, script, "uninstall", "--dry-run"], { env }).exitCode).toBe(0);
  expect(existsSync(join(home, ".cache/routr"))).toBe(true);
  expect(Bun.spawnSync([process.execPath, script, "uninstall", "--yes"], { env }).exitCode).toBe(0);
  expect(existsSync(join(home, ".agents/skills/routr"))).toBe(false);
  expect(existsSync(join(home, ".cache/routr"))).toBe(false);
  expect(existsSync(join(home, ".config/routr/config.json"))).toBe(true);
  if (linked) expect(readFileSync(join(checkout, "SKILL.md"), "utf8")).toBe("mine");    // the link went, its target did not
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"))).toEqual({ model: "opus" });
  expect(Bun.spawnSync([process.execPath, script, "uninstall", "--yes", "--purge"], { env }).exitCode).toBe(0);
  expect(existsSync(join(home, ".config/routr"))).toBe(false);
  // Someone else's statusline is not ours to remove.
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ statusLine: { command: "~/mine.sh" } }));
  expect(uninstallPlan({ home }).statusline).toBe(false);
});

// ---- Findings from the independent review (2026-09-21) ----

test("launch never puts the brief in its result: not in the command log, not in a dry run", async () => {
  const { launch } = await import("../src/lib/launch.mjs");
  const secret = "REFACTOR-THE-PAYMENTS-LEDGER-7731";
  const r = await launch(["--kind", "codex", "--name", "w", "--cwd", process.cwd(), "--worktree", "b", "--model", "m", "--task", `Do this: ${secret}`, "--dry-run"]);
  expect(r.prompt_chars).toBeGreaterThan(secret.length);
  expect(JSON.stringify(r)).not.toContain(secret);
  expect(r.planned_command.join("\n")).toContain("<prompt: ");
});

test("a failed binary swap puts the old binary back", async () => {
  const { swapBinary } = await import("../src/lib/update.mjs");
  const dir = mkdtempSync(join(tmpdir(), "routr-swap-")), self = join(dir, "routr");
  writeFileSync(self, "old");
  let calls = 0;
  const failSecond = (a, b) => { if (++calls === 2) throw new Error("locked"); (require("node:fs")).renameSync(a, b); };
  expect(() => swapBinary(self, Buffer.from("new"), { rename: failSecond })).toThrow("locked");
  expect(readFileSync(self, "utf8")).toBe("old");
  expect(existsSync(`${self}.new`)).toBe(false);
  swapBinary(self, Buffer.from("new"));
  expect(readFileSync(self, "utf8")).toBe("new");
});

test("an update lock is taken over only when its owner is gone", async () => {
  const { lockIsStale } = await import("../src/lib/update.mjs");
  const f = join(mkdtempSync(join(tmpdir(), "routr-lock-")), "update.lock");
  writeFileSync(f, String(process.pid));
  expect(lockIsStale(f)).toBe(false);                                    // we are alive
  expect(lockIsStale(f, { alive: () => false })).toBe(true);
  writeFileSync(f, "");                                                  // a lock from an older routr: no pid, fresh
  expect(lockIsStale(f)).toBe(false);
});

test("a config share outside 0..1 is reported and replaced: a negative reserve must not create capacity", () => {
  const f = join(mkdtempSync(join(tmpdir(), "routr-cfg-")), "config.json");
  writeFileSync(f, JSON.stringify({ sure_at: 7, subscriptions: { claude: { reserve: -1, assumed_headroom: 2 }, codex: { reserve: 0.2 } } }));
  const { config, notes } = loadConfig(f);
  expect(config.sure_at).toBe(DEFAULTS.sure_at);
  expect(config.subscriptions.claude.reserve).toBe(0);
  expect(config.subscriptions.claude.assumed_headroom).toBe(0.5);
  expect(config.subscriptions.codex.reserve).toBe(0.2);
  expect(notes.length).toBe(3);
});

test("only routr's own statusline counts as ours", async () => {
  const { isOurStatusline } = await import("../src/lib/statusline.mjs");
  for (const c of ["/home/u/.local/bin/routr statusline", '"C:\\Users\\u\\.local\\bin\\routr.exe" statusline', "routr statusline", "~/.claude/claude-statusline-usage.sh"]) expect(isOurStatusline(c)).toBe(true);
  for (const c of ["myroutr statusline", "~/mine.sh", "routr-statusline-fork", "", undefined]) expect(isOurStatusline(c)).toBe(false);
});

test("record --project labels the row, assess answers on an unreadable ledger, and share never writes into the current folder", () => {
  const script = `${import.meta.dir}/../src/routr.mjs`;
  const home = mkdtempSync(join(tmpdir(), "routr-cli-")), work = join(home, "work"); mkdirSync(work);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYPESAFE_API_KEY: "", ROUTR_NO_UPDATE: "1" };
  const advice = JSON.stringify({ id: "a1", mode: "dispatch", level: "basic", sure: true, facts: {} });
  const rec = Bun.spawnSync([process.execPath, script, "record", "--subscription", "codex", "--model", "m", "--effort", "low", "--verdict", "done", "--check", "pass", "--project", "other"], { env, cwd: work, stdin: Buffer.from(advice) });
  expect(rec.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(home, ".local/share/routr/ledger.jsonl"), "utf8").trim()).project).toBe("other");
  expect(Bun.spawnSync([process.execPath, script, "share"], { env, cwd: work }).exitCode).toBe(0);
  expect(readdirSync(work)).toEqual([]);
  expect(readdirSync(join(home, ".local/share/routr")).some((f) => f.startsWith("routr-ledger-"))).toBe(true);
  const bad = Bun.spawnSync([process.execPath, script, "assess", "--ledger", home], { env, cwd: work }); // a folder, not a file
  expect(bad.exitCode).toBe(0);
  expect(bad.stdout.toString()).toContain("could not read the ledger");
});

test("the headline reads the same as before it moved out of the entrypoint", async () => {
  const { headline } = await import("../src/lib/advise.mjs");
  const facts = { approach_open: { reading: "yes" }, standalone: { reading: "yes" }, cross_cutting: { reading: "no" } };
  expect(headline({ level: "standard", sure: true, work_type: "debug", facts })).toBe("routr: standard, debug work; approach_open");
  expect(headline({ level: "standard", sure: false, between: ["standard", "strong"], work_type: "review", facts: {}, high_risk: true, worker: { suggestion: "split it across workers" }, notes: ["Fix the brief: it names no check"] }))
    .toBe("routr: SPLIT IT ACROSS WORKERS · standard (torn between standard and strong), review work; HIGH RISK; FIX THE BRIEF FIRST");
  expect(headline({ level: "basic", sure: false })).toBe("routr: basic (unsure), unknown work");
});

test("the file-and-ledger commands answer instead of failing", async () => {
  const { checkCommand, recordCommand } = await import("../src/lib/commands.mjs");
  const missing = await checkCommand({ brief: "/nonexistent/brief", report: "/nonexistent/report" });
  expect(missing.fallback).toBe(true);
  expect(recordCommand({ advice: "/nonexistent/advice.json" }).recorded).toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "routr-check-"));
  writeFileSync(join(dir, "b"), "Fix the typo in README.md and run bun test."); writeFileSync(join(dir, "r"), "VERDICT: done");
  const seen = [];
  const out = await checkCommand({ brief: join(dir, "b"), report: join(dir, "r") }, { askFn: async (input) => { seen.push(input); return { answers: {}, latencyMs: 12 }; } });
  expect(out.warning).toContain("very short");
  expect(seen[0].report.text).toBe("VERDICT: done");
  expect(out.ms).toBe(12);
});

test("launch types each shell's own syntax: Cursor's private config is set and removed in PowerShell and cmd too", async () => {
  const { SHELLS, shellFamily } = await import("../src/lib/launch.mjs");
  expect(["zsh", "bash", "fish", undefined].map(shellFamily)).toEqual(["posix", "posix", "posix", "posix"]);
  expect(["powershell.exe", "pwsh", "cmd.exe", "CMD"].map(shellFamily)).toEqual(["powershell", "powershell", "cmd", "cmd"]);
  const dir = "C:\\Users\\u\\AppData\\Local\\Temp\\routr-cursor-1";
  // Windows shells only set the variable; herdr then starts Cursor itself, because it cannot see a Cursor a shell started.
  expect(SHELLS.powershell.cursor).toBeUndefined();
  // This exact line was run on Windows 11: the watcher appeared, and the folder was gone once the shell exited.
  expect(SHELLS.powershell.cursorEnv(dir)).toBe(`$env:CURSOR_CONFIG_DIR='${dir}'; $w = 'powershell -NoProfile -WindowStyle Hidden -Command "Wait-Process -Id ' + $PID + '; Remove-Item -LiteralPath ''${dir}'' -Recurse -Force -ErrorAction SilentlyContinue"'; ([wmiclass]'Win32_Process').Create($w) | Out-Null`);
  expect(SHELLS.powershell.cd("C:\\it's here")).toBe("Set-Location -LiteralPath 'C:\\it''s here'");
  expect(SHELLS.cmd.cursorEnv(dir)).toBe(`set "CURSOR_CONFIG_DIR=${dir}"`);
  expect(SHELLS.cmd.cd("C:\\a b")).toBe('cd /d "C:\\a b"');
  expect(SHELLS.posix.cursor("/tmp/x", "cursor-agent", ["--trust"])).toMatch(/^env CURSOR_CONFIG_DIR=\/tmp\/x sh -c 'trap .*cursor-agent --trust'$/);
  expect(SHELLS.posix.cd("/a b")).toBe("cd -- '/a b'");
});

test("routr update reports a real swap as an update and reinstalls the skill (the 0.1.14 regression)", async () => {
  const { update } = await import("../src/lib/update.mjs");
  const dir = mkdtempSync(join(tmpdir(), "routr-upd-")), self = join(dir, "routr");
  writeFileSync(self, "OLD");
  const fresh = Buffer.from("NEW-BINARY");
  const sum = (await import("node:crypto")).createHash("sha256").update(fresh).digest("hex");
  const { assetName } = await import("../src/lib/update.mjs");
  const fetchFn = async (u) => ({ ok: true, status: 200, arrayBuffer: async () => (String(u).endsWith("SHA256SUMS") ? Buffer.from(`${sum}  ${assetName()}\n`) : fresh) });
  const calls = [];
  const spawn = (file, args) => { calls.push([file, args[0]]); return { status: 0, stdout: args[0] === "--version" ? "9.9.9\n" : "" }; };
  const r = await update({ base: "http://fake.invalid/r", self, fetchFn, spawn, isStandalone: () => true });
  expect(r).toMatchObject({ ok: true, updated: true, now: "9.9.9", skill_reinstalled: true });
  expect(readFileSync(self, "utf8")).toBe("NEW-BINARY");
  expect(calls).toEqual([[self, "--version"], [self, "skill install".split(" ")[0]]]);
  // A failure after the swap is still an update, and says so.
  writeFileSync(self, "OLD");
  const bad = await update({ base: "http://fake.invalid/r", self, fetchFn, spawn: () => { throw new Error("spawn broke"); }, isStandalone: () => true });
  expect(bad.updated).toBe(true); expect(bad.ok).toBe(false); expect(bad.note).toContain("updated to");
  expect(readFileSync(self, "utf8")).toBe("NEW-BINARY");
});
