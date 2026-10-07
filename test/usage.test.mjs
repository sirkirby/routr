// usage readers: Claude's statusline, Codex, Cursor's screen, Kiro's /usage, the background snapshots, and `routr usage`
import { expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { tmpdir } from "node:os";
import { claudeProjectFolders, claudeSnapshot, codexSnapshot, monthMinutes, NO_WINDOWS_AFTER_ANSWER, parseClaudeReset, parseClaudeUsage, readClaude, summarize } from "../src/lib/usage.mjs";
import { KIRO_BY_HAND, kiroUsage, parseKiroUsage, readKiro, refreshKiro } from "../src/lib/kiro-usage.mjs";
import { HARNESSES, readUsage } from "../src/lib/harnesses.mjs";
import { olderThan, takeLock } from "../src/lib/runtime.mjs";
import { usageCommand } from "../src/lib/commands.mjs";
import { snapshotFrom } from "../src/lib/statusline.mjs";
import { CURSOR_BY_HAND, parseCursorUsage, cursorUsage, readCursor, refreshCursor } from "../src/lib/cursor-usage.mjs";
import { cfg, cliEnv, herdrError, herdrOK, live, metered, none, NOW, scratch, SCRIPT, shellInfo, win } from "./helpers.mjs";
// Recorded 2026-09-22 from `codex app-server` (`account/rateLimits/read`, CLI 0.155.1), identifiers removed: a ChatGPT
// Enterprise seat on flexible pricing, and a Pro login. The capped shape follows the protocol's `SpendControlLimitSnapshot`
// (openai/codex, codex-rs/protocol/src/protocol.rs); it is claimed until a cap is set on a seat and read.
const ENTERPRISE_SEAT = { limitId: "codex", limitName: null, normalModelSlug: null, primary: null, secondary: null, credits: { hasCredits: true, unlimited: true, balance: null }, individualLimit: null, spendControlReached: false, planType: "business", rateLimitReachedType: null };

const PRO_LOGIN = { ...ENTERPRISE_SEAT, primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: NOW / 1000 + 3 * 86400 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "pro" };

const capped = (resetsAt, remainingPercent, over = {}) => ({ ...ENTERPRISE_SEAT, credits: { hasCredits: true, unlimited: false, balance: "1000" }, individualLimit: { limit: "5000", used: String(5000 - 50 * remainingPercent), remainingPercent, resetsAt }, ...over });

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

// `claude -p /usage --output-format json` on a Max plan, Claude Code 2.1.289, 2026-10-05 (the `result` text, verbatim
// up to the local breakdown, which is cut short here).
const CLAUDE_USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 1% used · resets Oct 5 at 3:59pm (America/Detroit)
Current week (all models): 90% used · resets Oct 5 at 9:59pm (America/Detroit)
Current week (Fable): 0% used · resets Oct 5 at 10pm (America/Detroit)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.`;
const OCT5 = Date.UTC(2026, 9, 5, 17, 35) / 1000; // 1:35pm in Detroit, when it was read
const utc = (...a) => Date.UTC(...a) / 1000;
// A displayed reset is the END of the minute it shows: the last second of it.
const endOf = (...a) => utc(...a) + 59;
const claudeAnswer = (result, over = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, total_cost_usd: 0, result, ...over });

test("Claude's /usage text: the session and all-models week are the statusline's windows; a model's own week is counted, never named", () => {
  const p = parseClaudeUsage(CLAUDE_USAGE, OCT5);
  expect(p.windows).toEqual([
    { name: "five_hour", usedPct: 1, windowMin: 300, resetsAt: endOf(2026, 9, 5, 19, 59) },
    { name: "seven_day", usedPct: 90, windowMin: 10080, resetsAt: endOf(2026, 9, 6, 1, 59) }]);
  expect(p.note).toBe("plus 1 model-specific weekly limit (highest 0% used), not ranked on");
  expect(p.note).not.toContain("Fable");
  // A reset that does not read exactly so is left unset, and said; the window still counts.
  const odd = parseClaudeUsage("Current week (all models): 40% used · resets next Tuesday", OCT5);
  expect(odd.windows).toEqual([{ name: "seven_day", usedPct: 40, windowMin: 10080, resetsAt: null }]);
  expect(odd.note).toContain("reset time not read for seven_day");
  expect(parseClaudeUsage("Current week (Opus): 80% used\nCurrent week (Sonnet): 95% used", OCT5)).toEqual({ windows: [], note: "plus 2 model-specific weekly limits (highest 95% used), not ranked on" });
  expect(parseClaudeUsage("You are using an API key", OCT5)).toEqual({ windows: [], note: undefined });
});

test("Claude's reset times read in their own zone, across DST, midnight and noon, and the year that makes sense", () => {
  expect(parseClaudeReset("Oct 5 at 4pm (America/Detroit)", OCT5)).toBe(endOf(2026, 9, 5, 20));
  expect(parseClaudeReset("Oct 5 at 10pm (America/Los_Angeles)", OCT5)).toBe(endOf(2026, 9, 6, 5));
  expect(parseClaudeReset("Oct 5 at 3:05pm (America/Detroit)", OCT5)).toBe(endOf(2026, 9, 5, 19, 5));
  expect(parseClaudeReset("Oct 6 at 12am (America/Detroit)", OCT5)).toBe(endOf(2026, 9, 6, 4));   // midnight
  expect(parseClaudeReset("Oct 6 at 12pm (America/Detroit)", OCT5)).toBe(endOf(2026, 9, 6, 16));  // noon
  // US daylight time ends Nov 1 2026 and starts Mar 14 2027: the offset is the one at that wall time.
  expect(parseClaudeReset("Oct 31 at 3pm (America/Detroit)", OCT5)).toBe(endOf(2026, 9, 31, 19));
  expect(parseClaudeReset("Nov 1 at 3pm (America/Detroit)", OCT5)).toBe(endOf(2026, 10, 1, 20));
  const mar = utc(2027, 2, 10);
  expect(parseClaudeReset("Mar 13 at 3pm (America/Los_Angeles)", mar)).toBe(endOf(2027, 2, 13, 23));
  expect(parseClaudeReset("Mar 14 at 3pm (America/Los_Angeles)", mar)).toBe(endOf(2027, 2, 14, 22));
  expect(parseClaudeReset("Mar 14 at 1:30am (America/Los_Angeles)", mar)).toBe(endOf(2027, 2, 14, 9, 30));
  expect(parseClaudeReset("Mar 14 at 3:30am (America/Los_Angeles)", mar)).toBe(endOf(2027, 2, 14, 10, 30));
  // The hour a clock skips does not exist: unread, never moved an hour. The hour it repeats takes the later instant,
  // so a window is not rolled over (headroom invented) before its reset: here the earlier one has already passed.
  expect(parseClaudeReset("Mar 14 at 2:30am (America/Los_Angeles)", mar)).toBeNull();
  expect(parseClaudeReset("Nov 1 at 1:30am (America/Detroit)", utc(2026, 10, 1, 6))).toBe(endOf(2026, 10, 1, 6, 30));
  const full = parseClaudeUsage("Current session: 100% used · resets Nov 1 at 1:30am (America/Detroit)", utc(2026, 10, 1, 6));
  expect(summarize({ pool: "claude", source: "t", ts: utc(2026, 10, 1, 6), windows: full.windows, nowSec: utc(2026, 10, 1, 6) }).headroom).toBe(0);
  // No year is shown: the nearest of last, this and next year's. December's "Jan 1" is next year's; just after New
  // Year, last night's reset is last year's; yesterday's stays yesterday (and its window rolls over), never next year.
  expect(parseClaudeReset("Jan 1 at 12am (America/Detroit)", utc(2026, 11, 31, 20))).toBe(endOf(2027, 0, 1, 5));
  expect(parseClaudeReset("Dec 31 at 11pm (America/Detroit)", utc(2027, 0, 1, 6))).toBe(endOf(2027, 0, 1, 4));
  expect(parseClaudeReset("Oct 4 at 12pm (America/Detroit)", utc(2026, 9, 5, 17))).toBe(endOf(2026, 9, 4, 16));
  // Further from now than the window and a day: not this window's reset.
  expect(parseClaudeReset("Oct 9 at 4pm (America/Detroit)", OCT5, 300 * 60 + 86400)).toBeNull();
  expect(parseClaudeReset("Oct 9 at 4pm (America/Detroit)", OCT5, 10080 * 60 + 86400)).toBe(endOf(2026, 9, 9, 20));
  expect(parseClaudeUsage("Current session: 5% used · resets Oct 9 at 4pm (America/Detroit)", OCT5).windows[0].resetsAt).toBeNull();
  for (const bad of ["", "soon", "Oct 5 at 4pm", "Oct 5 at 13pm (America/Detroit)", "Oct 5 at 4:75pm (America/Detroit)", "Feb 30 at 4pm (America/Detroit)", "Foo 5 at 4pm (America/Detroit)", "Oct 5 at 4pm (Not/AZone)", "Oct 5 at 4pm (America/Detroit) extra", null])
    expect([bad, parseClaudeReset(bad, OCT5)]).toEqual([bad, null]);
});

// From the final review: "resets Oct 5 at 3:59pm" was read as 3:59:00, so for up to a minute before the real reset a
// full window was rolled over and its headroom invented. The reset is the minute's end.
test("a full Claude window is not rolled over during the minute its reset shows", () => {
  const read = utc(2026, 9, 5, 19, 59, 30); // 3:59:30pm in Detroit
  const full = parseClaudeUsage("Current session: 100% used · resets Oct 5 at 3:59pm (America/Detroit)", read);
  expect(full.windows[0].resetsAt).toBe(utc(2026, 9, 5, 19, 59, 59));
  expect(summarize({ pool: "claude", source: "t", ts: read, windows: full.windows, nowSec: read }).headroom).toBe(0);
});

test("Claude: a recent statusline snapshot is used as it is; otherwise its own /usage is read, hooks and MCP servers off, from the temp folder", async () => {
  const dir = scratch("claude-usage"), file = join(dir, "claude-usage.json");
  const rl = { five_hour: { used_percentage: 20, resets_at: OCT5 + 3600 }, seven_day: { used_percentage: 30, resets_at: OCT5 + 86400 } };
  const calls = [];
  const exec = (answer) => async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return answer; };
  const read = (o) => HARNESSES.claude.usage.read({ file, nowSec: OCT5, ...o }); // the registry's read: its own quiet arguments
  // Under five minutes old: the snapshot, and Claude is not started.
  writeFileSync(file, JSON.stringify({ ts: OCT5 - 60, rate_limits: rl, answered: true }));
  expect(await read({ exec: exec(claudeAnswer(CLAUDE_USAGE)) })).toMatchObject({ source: "statusline", headroom: 0.7, ageSec: 60 });
  expect(calls).toEqual([]);
  // Older: read live, with exactly these arguments, in the system temp folder.
  writeFileSync(file, JSON.stringify({ ts: OCT5 - 600, rate_limits: rl, answered: true }));
  const fresh = await read({ exec: exec(claudeAnswer(CLAUDE_USAGE)) });
  expect(calls.map(({ cmd, args, opts }) => ({ cmd, args, timeoutMs: opts.timeoutMs }))).toEqual([{ cmd: "claude", args: ["-p", "/usage", "--output-format", "json", "--no-session-persistence", "--settings", '{"disableAllHooks":true}', "--strict-mcp-config"], timeoutMs: 12000 }]);
  expect(dirname(calls[0].opts.cwd)).toBe(tmpdir()); expect(basename(calls[0].opts.cwd)).toMatch(/^routr-claude-/); // a private folder of its own
  expect(existsSync(calls[0].opts.cwd)).toBe(false);                                                                  // removed after the read
  expect(fresh).toMatchObject({ pool: "claude", source: "claude /usage", ageSec: 0, class: "included" });
  expect(fresh.headroom).toBeCloseTo(0.1);
  expect(fresh.windows.map((w) => w.name)).toEqual(["five_hour", "seven_day"]);
  // A snapshot with no windows yet is no reason to skip the live read.
  calls.length = 0;
  writeFileSync(file, JSON.stringify({ ts: OCT5 - 5, rate_limits: null, answered: false, seen: null }));
  expect((await read({ exec: exec(claudeAnswer(CLAUDE_USAGE)) })).source).toBe("claude /usage"); expect(calls.length).toBe(1);
  // Nor is one stamped in the future (a clock set back): its age says nothing.
  writeFileSync(file, JSON.stringify({ ts: OCT5 + 120, rate_limits: rl, answered: true }));
  expect((await read({ exec: exec(claudeAnswer(CLAUDE_USAGE)) })).source).toBe("claude /usage"); expect(calls.length).toBe(2);
});

test("Claude's read runs in a private folder of its own and removes only what Claude made for it, after a normal exit", async () => {
  const home = scratch("claude-home"), projects = join(home, ".claude", "projects"), tmp = scratch("claude-tmp");
  // What Claude does (measured): an empty memory folder under the project folder named for the folder it ran in.
  const folderOf = (cwd) => join(projects, realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
  const claude = (then, answer = claudeAnswer(CLAUDE_USAGE)) => async (cmd, args, { cwd }) => { const f = folderOf(cwd); expect(claudeProjectFolders(cwd, projects)).toContain(f); mkdirSync(join(f, "memory"), { recursive: true }); then?.(f, cwd); return answer; };
  const read = (exec) => readClaude({ file: join(home, "none.json"), nowSec: OCT5, exec, tmp, projects });
  const left = () => readdirSync(tmp);
  let seen;
  expect((await read(claude((f) => { seen = f; }))).source).toBe("claude /usage");
  expect([existsSync(seen), left()]).toEqual([false, []]);                    // the project folder and the private folder: gone
  expect(existsSync(projects)).toBe(true);                                    // Claude's own folder stays
  // Another read's or the user's project folder, made meanwhile under another name: never touched.
  const other = join(projects, "-private-tmp"); mkdirSync(join(other, "memory"), { recursive: true });
  await read(claude());
  expect(existsSync(join(other, "memory"))).toBe(true);
  // Anything written there: kept (rmdir only removes what is empty).
  await read(claude((f) => writeFileSync(join(f, "memory", "note.md"), "x")));
  expect(readdirSync(projects).some((n) => existsSync(join(projects, n, "memory", "note.md")))).toBe(true);
  await read(claude((f) => writeFileSync(join(f, "s.jsonl"), "{}")));
  expect(readdirSync(projects).some((n) => existsSync(join(projects, n, "s.jsonl")))).toBe(true);
  // A project folder that is a symlink (a junction on Windows) is not followed: the empty memory it points at stays.
  const elsewhere = scratch("elsewhere"); mkdirSync(join(elsewhere, "memory"));
  await read(async (cmd, args, { cwd }) => { symlinkSync(elsewhere, folderOf(cwd), process.platform === "win32" ? "junction" : "dir"); return claudeAnswer(CLAUDE_USAGE); });
  expect(existsSync(join(elsewhere, "memory"))).toBe(true);
  // Timed out (or no answer): Claude may still be writing, so its project folder stays; the empty private folder goes.
  let timedOut;
  await read(claude((f) => { timedOut = f; }, null));
  expect(existsSync(join(timedOut, "memory"))).toBe(true); expect(left()).toEqual([]);
  // A private folder Claude wrote into is not removed either.
  await read(claude((f, cwd) => writeFileSync(join(cwd, "x"), "")));
  expect(left().length).toBe(1);
});

test("Claude's cleanup is fixed before the read: a private folder swapped for a link meanwhile steers it nowhere", async () => {
  const home = scratch("claude-swap"), projects = join(home, ".claude", "projects"), tmp = scratch("claude-swap-tmp");
  const folderOf = (dir) => join(projects, realpathSync(dir).replace(/[^A-Za-z0-9]/g, "-"));
  const victim = scratch("victim"); mkdirSync(join(folderOf(victim), "memory"), { recursive: true }); // someone else's, empty
  let ours;
  await readClaude({ file: join(home, "none.json"), nowSec: OCT5, tmp, projects, exec: async (cmd, args, { cwd }) => {
    ours = folderOf(cwd); mkdirSync(join(ours, "memory"), { recursive: true });
    rmdirSync(cwd); symlinkSync(victim, cwd, process.platform === "win32" ? "junction" : "dir"); // swapped during the read
    return claudeAnswer(CLAUDE_USAGE);
  } });
  expect(existsSync(join(folderOf(victim), "memory"))).toBe(true); // never followed to the victim's project folder
  expect(existsSync(join(ours, "memory"))).toBe(true);             // not the folder routr made any more: nothing touched
});

test("no private folder, no read: Claude is not started in the shared temp folder", async () => {
  const dir = scratch("claude-nodir"), file = join(dir, "claude-usage.json"), tmp = join(dir, "missing", "deeper");
  let started = false;
  const read = (f) => readClaude({ file: f, nowSec: OCT5, tmp, exec: async () => { started = true; return claudeAnswer(CLAUDE_USAGE); } });
  const none = await read(join(dir, "none.json"));
  expect(started).toBe(false);
  expect(none).toMatchObject({ headroom: null, class: "unknown" }); expect(none.note).toContain("could not make a private folder"); expect(none.note).toContain("assumed headroom");
  writeFileSync(file, JSON.stringify({ ts: OCT5 - 3600, rate_limits: { seven_day: { used_percentage: 40, resets_at: OCT5 + 86400 } }, answered: true }));
  const old = await read(file);
  expect(started).toBe(false);
  expect(old).toMatchObject({ source: "statusline", headroom: 0.6 }); expect(old.note).toContain("this is the statusline's last reading");
});

test("Claude's live read fails open: the old snapshot however old, else the assumed headroom, and the note says why", async () => {
  const dir = scratch("claude-fallback"), file = join(dir, "claude-usage.json"), missing = join(dir, "none.json");
  const rl = { seven_day: { used_percentage: 40, resets_at: OCT5 + 86400 } };
  writeFileSync(file, JSON.stringify({ ts: OCT5 - 3 * 3600, rate_limits: rl, answered: true }));
  const read = (exec, f = file) => readClaude({ file: f, nowSec: OCT5, exec: async () => exec });
  const old = await read(null); // timed out, or no claude
  expect(old).toMatchObject({ source: "statusline", headroom: 0.6, ageSec: 3 * 3600 });
  expect(old.note).toBe("`claude -p /usage` did not answer in 12 s: this is the statusline's last reading");
  expect((await read("not json")).note).toContain("did not answer as expected: this is the statusline's last reading");
  expect((await read(claudeAnswer("x", { is_error: true }))).note).toContain("did not answer as expected");
  const nothing = await read(null, missing);
  expect(nothing).toMatchObject({ source: "claude /usage", headroom: null, class: "unknown" });
  expect(nothing.note).toBe("`claude -p /usage` did not answer in 12 s; using the assumed headroom");
  // It answered, and showed no windows: the seat may have no quota; doctor's step keys on the reason.
  const bare = await read(claudeAnswer("You are using an API key"), missing);
  expect(bare).toMatchObject({ headroom: null, class: "unknown", reason: NO_WINDOWS_AFTER_ANSWER }); expect(bare.note).toContain('billing: "metered"');
  // From the final review: Claude answered and shows no windows (now an API key or a metered seat), while an old
  // snapshot still holds the previous subscription's exhausted windows. The answer wins: that snapshot is not ranked.
  writeFileSync(file, JSON.stringify({ ts: OCT5 - 3 * 3600, rate_limits: { seven_day: { used_percentage: 100, resets_at: OCT5 + 86400 } }, answered: true }));
  const switched = await read(claudeAnswer("You are using an API key"));
  expect(switched).toMatchObject({ source: "claude /usage", headroom: null, class: "unknown", reason: NO_WINDOWS_AFTER_ANSWER });
  expect(switched.note).not.toContain("statusline's last reading");
  // A snapshot saying Claude sent no windows after a prompt keeps its reason when the live read fails.
  writeFileSync(file, JSON.stringify({ ts: OCT5 - 3 * 3600, rate_limits: null, answered: true, seen: null }));
  expect((await read(null)).reason).toBe(NO_WINDOWS_AFTER_ANSWER);
});

test("no model name from Claude's /usage reaches routr usage's output", async () => {
  const dir = scratch("claude-names");
  const sources = { claude: { read: () => readClaude({ file: join(dir, "none.json"), exec: async () => claudeAnswer(CLAUDE_USAGE) }) } };
  const c = cfg({ subscriptions: { claude: cfg().subscriptions.claude } });
  const out = await usageCommand([], c, {}, { read: (names, given, o) => readUsage(names, given, { ...o, why: async () => null }), sources });
  expect(out.ok).toBe(true); expect(out.ranked[0]).toMatchObject({ subscription: "claude", usage: "live" });
  expect(JSON.stringify(out)).toContain("model-specific weekly limit");
  expect(JSON.stringify(out)).not.toContain("Fable");
});

test("metered capacity stays unknown while legacy settings determine normal or fallback use", () => {
  const r = rankSubscriptions("strong", [live("claude", 0.6), metered("codex")], cfg());
  expect(r.ranked.map((x) => [x.subscription, x.usable])).toEqual([["claude", 0.35], ["codex", null]]);
  expect(r.ranked[1]).toMatchObject({ class: "metered", usage: "metered", headroom: null }); expect(r.ranked[1].note).toContain("billed"); expect(r.most_room).toBe("claude");
  const spill = rankSubscriptions("strong", [live("claude", 0.2), metered("codex")], cfg());
  expect(spill.ranked.map((x) => x.subscription)).toEqual(["codex", "claude"]); expect(spill.most_room).toBeNull(); expect(spill.candidates).toEqual({ normal: [], fallback: ["codex"] });
  const c = cfg(); c.subscriptions.codex.metered_rank = "with";
  const w = rankSubscriptions("strong", [live("claude", 0.6), metered("codex")], c);
  expect(w.ranked.map((x) => [x.subscription, x.usable, x.usage])).toEqual([["claude", 0.35, "live"], ["codex", null, "metered"]]);
  expect(w.candidates).toEqual({ normal: ["claude", "codex"], fallback: [] });
  expect(rankSubscriptions("strong", [metered("codex")], cfg({ subscriptions: { codex: cfg().subscriptions.codex } })).note).toContain("remaining capacity is unknown");
  const g = cfg(); g.subscriptions.cursor.billing = "metered";                                  // a number the caller read wins over the class
  expect(rankSubscriptions("basic", [{ pool: "cursor", source: "given by caller", given: true, ageSec: 0, windows: [], headroom: 0.9 }], g).ranked[0]).toMatchObject({ class: "included", usable: 0.8, usage: "given" });
  const b = cfg(); b.subscriptions.claude.billing = "metered";                                   // the reader sees nothing; the user knows
  expect(rankSubscriptions("strong", [none("claude"), live("codex", 0.5)], b).ranked.map((x) => [x.subscription, x.class])).toEqual([["codex", "included"], ["claude", "metered"]]);
  expect(rankSubscriptions("strong", [live("claude", 0.6), { ...metered("codex"), windows: [win(40, 100, null)], headroom: 0.6, class: "capped" }], cfg()).ranked[0]).toMatchObject({ subscription: "codex", class: "capped", usable: 0.4 }); // a cap is a number: ranked by it; unknown length holds the full reserve
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

const CURSOR_UI = "  Cursor Agent\n  Grok 4.6 High\n  /tmp";

// A fake herdr for the Cursor read: a private session that starts on the third look, a shell at its prompt (routr
// answers no shell question; the session starts in the temp folder), then Cursor and its /usage panel. Every pane command must go to the private session, never a split.
// Stale sessions: one left by a routr that is gone (pid 99) is removed; one whose routr is alive (pid 7) is not.
const CU_TMP = scratch("cu");


function fakeCursorUsage({ delayPanel = false, neverDraws = false, cursorRuns = true, failCreate = false, spawnFails = false, sessions = null, shellAsks = null } = {}) {
  let stage = "shell", ticks = 0, extraEnter = false, up = 0;
  const calls = [], started = [], privateDirs = [];
  const tmp = CU_TMP, cursorConfig = join(tmp, "real-cli-config.json");
  writeFileSync(cursorConfig, '{"model":"mine"}');
  const deps = {
    tmp, cursorConfig, now: () => ticks, sleep: async (ms) => { ticks += ms; },
    terminal: { pid: 4242, alive: (pid) => pid === 7 || pid === 8, age: (dir) => (dir === "/old" ? 11 * 60 * 1000 : 1000),
      start: (name, failed) => { started.push(name); if (spawnFails) failed(Object.assign(new Error("spawn herdr EACCES"), { code: "EACCES" })); } },
    run: async (all) => {
      calls.push(all);
      if (all[0] === "session" && all[1] === "list") return { ok: true, data: { sessions: sessions ?? [{ name: "default" }, { name: "routr-scratch-99-abc123" }, { name: "routr-scratch-7-def456", session_dir: "/new" }] } };
      if (all[0] === "session") return herdrOK({});
      expect(all.slice(0, 2)).toEqual(["--session", started[0]]);
      const a = all.slice(2);
      if (a[0] === "workspace" && a[1] === "list") return ++up < 3 ? herdrError("server_not_running") : herdrOK({ workspaces: [] });
      if (a[0] === "workspace" && a[1] === "create") {
        expect(a).toEqual(["workspace", "create", "--cwd", tmp, "--no-focus"]);
        return failCreate ? herdrError("boom") : herdrOK({ root_pane: { pane_id: "w1:p1" } });
      }
      if (a[1] === "read") {
        if (stage === "shell") return herdrOK({ text: shellAsks ?? "chris % " });
        if (neverDraws) return herdrOK({ text: "chris % " });
        if (stage === "usage") return herdrOK({ text: delayPanel && !extraEnter ? CURSOR_UI : CURSOR_USAGE_PANEL });
        return herdrOK({ text: CURSOR_UI });
      }
      if (a[1] === "process-info") return stage === "starting" && cursorRuns ? shellInfo([{ pid: 1 }, { pid: 2 }]) : shellInfo();
      if (a[1] === "send-keys") {
        if (stage === "shell") throw new Error("routr typed into the shell: it answers no shell question");
        if (a[3] === "enter" && stage === "starting") stage = "usage";
        else if (a[3] === "enter") extraEnter = true;
        return herdrOK({});
      }
      if (a[1] === "send-text") { expect(a.slice(3)).toEqual(["/usage"]); return herdrOK({}); }
      if (a[1] === "run") {
        // Cursor runs on a private copy of its config, never the user's own (it writes to it as it runs).
        const dir = a[3].match(/CURSOR_CONFIG_DIR=([^'"\s]+)/)?.[1]; // quoted on Windows (a drive letter and backslashes)
        expect(a[2]).toBe("w1:p1");
        expect(a[3]).toContain("cursor-agent");
        expect(a[3]).toContain("--trust");
        expect(readFileSync(join(dir, "cli-config.json"), "utf8")).toBe('{"model":"mine"}');
        privateDirs.push(dir); stage = "starting"; return herdrOK({});
      }
      throw new Error(`Unexpected command ${all.join(" ")}`);
    },
  };
  const sessionCalls = () => calls.filter((a) => a[0] === "session").map((a) => a.slice(1, 3).join(" "));
  return { calls, started, deps, sessionCalls, privateDirs, tmp };
}

test("cursorUsage reads /usage in a private herdr session, removes it, and removes one a dead routr left", async () => {
  const f = fakeCursorUsage();
  const r = await cursorUsage(f.deps);
  expect(r).toEqual({ ok: true, subscription: "cursor", plan: "Pro", included_used_pct: 3, auto_used_pct: 3, api_used_pct: 1, headroom: 0.97 });
  expect(f.started).toHaveLength(1);
  expect(f.started[0]).toMatch(/^routr-scratch-4242-[0-9a-f]{6}$/);
  expect(f.calls.filter((a) => a[3] === "send-keys" && a[5] === "enter")).toHaveLength(1);
  expect(f.calls.some((a) => a.includes("split"))).toBe(false); // never the user's own session
  expect(f.sessionCalls()).toEqual(["list --json", "stop routr-scratch-99-abc123", "delete routr-scratch-99-abc123", `stop ${f.started[0]}`, `delete ${f.started[0]}`]);
  expect(f.privateDirs).toHaveLength(1);
  expect(existsSync(f.privateDirs[0])).toBe(false); // the private config is removed with the read
});

test("cursorUsage sends a second enter if the panel is slow, and still removes the session", async () => {
  const f = fakeCursorUsage({ delayPanel: true });
  expect((await cursorUsage(f.deps)).ok).toBe(true);
  expect(f.calls.filter((a) => a[3] === "send-keys" && a[5] === "enter").length).toBeGreaterThanOrEqual(2);
  expect(f.sessionCalls().slice(-2)).toEqual([`stop ${f.started[0]}`, `delete ${f.started[0]}`]);
});

test("cursorUsage removes the session when Cursor never draws or the session fails half way", async () => {
  for (const [opts, says] of [[{ neverDraws: true }, "timed out"], [{ failCreate: true }, "boom"], [{ spawnFails: true }, "EACCES"]]) {
    const f = fakeCursorUsage(opts);
    const r = await cursorUsage({ ...f.deps, timeout: 1000 });
    expect(r).toMatchObject({ ok: false, read_yourself: CURSOR_BY_HAND });
    expect(r.error).toContain(says);
    expect(f.sessionCalls().slice(-2)).toEqual([`stop ${f.started[0]}`, `delete ${f.started[0]}`]);
  }
});

test("a question the private session's shell asks is not answered: the read stops, Cursor never starts, the session goes", async () => {
  const f = fakeCursorUsage({ shellAsks: "found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)" });
  const r = await cursorUsage({ ...f.deps, timeout: 5000 });
  expect(r).toMatchObject({ ok: false, read_yourself: CURSOR_BY_HAND });
  expect(f.calls.some((a) => ["send-keys", "run"].includes(a[3]))).toBe(false); // no key, no cursor-agent
  expect(f.sessionCalls().slice(-2)).toEqual([`stop ${f.started[0]}`, `delete ${f.started[0]}`]);
});

test("cursor-agent missing is said in seconds, not at the 90 s timeout", async () => {
  const f = fakeCursorUsage({ neverDraws: true, cursorRuns: false });
  const r = await cursorUsage(f.deps); // the default 90 s budget
  expect(r.error).toContain("cursor-agent did not start");
  expect(f.deps.now()).toBeLessThan(10000);
  expect(f.sessionCalls().slice(-2)).toEqual([`stop ${f.started[0]}`, `delete ${f.started[0]}`]);
});

test("a stale private session is removed even when its pid now belongs to something else", async () => {
  const f = fakeCursorUsage({ sessions: [{ name: "routr-scratch-8-aaa111", session_dir: "/old" }, { name: "routr-scratch-7-bbb222", session_dir: "/new" }] });
  expect((await cursorUsage(f.deps)).ok).toBe(true);
  expect(f.sessionCalls().slice(1, 3)).toEqual(["stop routr-scratch-8-aaa111", "delete routr-scratch-8-aaa111"]);
  expect(f.sessionCalls().some((c) => c.includes("bbb222"))).toBe(false);
});

test("cursorUsage without herdr fails open, says how to read it by hand, and starts nothing", async () => {
  const started = [];
  const r = await cursorUsage({ run: async () => { throw Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" }); }, terminal: { start: (n) => started.push(n) } });
  expect(r).toMatchObject({ ok: false, read_yourself: CURSOR_BY_HAND });
  expect(r.error).toContain("herdr is not installed");
  expect(started).toEqual([]);
});

test("usage cursor with no Cursor to ask says so, starts nothing, prints JSON and exits 0", () => {
  const home = scratch("home"); // it keeps what it read: never in the real cache
  const cleanEnv = cliEnv(home, { PATH: "" }); // no cursor-agent and no herdr
  delete cleanEnv.HERDR_ENV;
  const res = Bun.spawnSync([process.execPath, SCRIPT, "usage", "cursor"], { env: cleanEnv });
  expect(res.exitCode).toBe(0);
  const out = JSON.parse(res.stdout.toString());
  expect(out).toMatchObject({ ok: false, error: "`cursor-agent` did not answer its sign-in check (not installed, or it hung)" });
  expect(JSON.parse(readFileSync(join(home, ".cache/routr/cursor-usage.json"), "utf8")).error).toBe(out.error);
  expect(JSON.parse(readFileSync(join(home, ".cache/routr/signed-in.json"), "utf8")).cursor.state).toBe("no answer");
});

const KIRO_USAGE = "Estimated Usage | resets on 2026-10-01 | KIRO FREE\nCredits (0.00 of 50 covered in plan), 0.0%\nManage your plan at https://app.kiro.dev/account/usage\n";

test("Kiro's /usage text: monthly plan credits and the reset day; unknown lines are kept, never guessed at", () => {
  expect(parseKiroUsage(KIRO_USAGE)).toEqual({ plan: "KIRO FREE", credits_used: 0, credits_limit: 50, used_pct: 0, resets_at: Date.UTC(2026, 9, 1) / 1000 });
  expect(parseKiroUsage(KIRO_USAGE.replace("0.00 of 50", "1,234.5 of 2,000"))).toMatchObject({ credits_used: 1234.5, credits_limit: 2000, used_pct: 61.7 });
  expect(parseKiroUsage(`${KIRO_USAGE}Overage: 12.00 credits\n`).other).toBe("Overage: 12.00 credits");
  for (const junk of [null, "", "Credits (5 of 0 covered in plan)", "You are out of credits"]) expect(parseKiroUsage(junk)).toBeNull();
});

test("kiroUsage runs /usage outside the user's project and deletes the session it leaves", async () => {
  const calls = [];
  const stream = [{ type: "runStarted", data: {} }, { type: "metadata", data: { sessionId: "s-1" } }, { type: "runFinished", data: { sessionId: "s-1", finalText: KIRO_USAGE } }].map((o) => JSON.stringify(o)).join("\n");
  const exec = (deleteCode = 0, out = stream) => async (cmd, args, o) => { calls.push({ cmd, args, o }); return args.includes("--delete-session") ? deleteCode : out; };
  const r = await kiroUsage({ exec: exec(), cwd: "/tmp/scratch" });
  expect(r).toMatchObject({ ok: true, subscription: "kiro", plan: "KIRO FREE", headroom: 1 });
  expect(r.note).toBeUndefined();
  expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([["kiro-cli", "chat", "--output-format", "stream-json", "/usage"], ["kiro-cli", "chat", "--delete-session", "s-1"]]);
  expect(calls.every((c) => c.o.cwd === "/tmp/scratch")).toBe(true);
  expect((await kiroUsage({ exec: exec(1) })).note).toContain("kiro-cli chat --delete-session s-1"); // left behind: says how to remove it
  expect(await kiroUsage({ exec: exec(0, null) })).toMatchObject({ ok: false, read_yourself: KIRO_BY_HAND });
  expect(await kiroUsage({ exec: exec(0, stream.replace("covered in plan", "left")) })).toMatchObject({ ok: false, read_yourself: KIRO_BY_HAND });
});

test("Kiro is a snapshot like Cursor's, a monthly window that tapers the reserve toward its reset", async () => {
  const dir = scratch("kiro"), file = join(dir, "kiro-usage.json"), T = Date.UTC(2026, 8, 26) / 1000;
  const started = [];
  expect(readKiro({ file, nowSec: T, refresh: () => started.push(T), off: false })).toMatchObject({ pool: "kiro", headroom: null });
  expect(started).toHaveLength(1);
  const reading = { ok: true, subscription: "kiro", ...parseKiroUsage(KIRO_USAGE.replace("0.00 of 50", "40.00 of 50")), headroom: 0.2 };
  await refreshKiro({ file, nowSec: T + 20, read: async () => reading });
  const got = readKiro({ file, nowSec: T + 60, refresh: () => started.push("again"), off: false });
  expect(got.headroom).toBeCloseTo(0.2, 9);
  expect(got).toMatchObject({ class: "included", note: "KIRO FREE: 40 of 50 credits used", windows: [{ name: "monthly_credits", windowMin: 30 * 24 * 60 }] });
  expect(started).toHaveLength(1);
  await refreshKiro({ file, nowSec: T + 80, read: async () => ({ ...reading, resets_at: T + 3600 }) });
  expect(readKiro({ file, nowSec: T + 7200 }).headroom).toBe(1); // past the reset: a new month, whatever the reading said
  await refreshKiro({ file, nowSec: T + 100, read: async () => ({ ok: false, error: "kiro-cli did not answer", read_yourself: KIRO_BY_HAND }) });
  expect(readKiro({ file, nowSec: T + 101 }).note).toContain("the last try failed: kiro-cli did not answer");
});

test("Cursor is a snapshot every call reads at once, refreshed in the background about once a session", async () => {
  const dir = scratch("cursor"), file = join(dir, "cursor-usage.json"), T = 1_800_000_000;
  const started = [];
  const read = (nowSec) => readCursor({ file, nowSec, refresh: () => started.push(nowSec), off: false });
  // A new install: nothing yet. The call answers at once, assumed, and starts one background reading.
  const first = read(T);
  expect(first).toMatchObject({ pool: "cursor", headroom: null });
  expect(first.note).toContain("being taken in the background");
  expect(read(T + 1).headroom).toBeNull();
  expect(started).toEqual([T]); // a burst of calls starts one reading, not one each
  // The background reading lands (what `routr usage cursor` does).
  const screen = { ok: true, plan: "Team", included_used_pct: 66, auto_used_pct: 61, api_used_pct: 93, headroom: 0.34 };
  expect(await refreshCursor({ file, nowSec: T + 5, read: async () => screen })).toEqual(screen);
  const got = read(T + 600);
  expect(got.headroom).toBeCloseTo(0.34, 9);
  expect(got).toMatchObject({ ageSec: 595, class: "included", note: "Included 66% used (Auto 61%, API 93%)" });
  const row = rankSubscriptions("standard", [got], cfg()).ranked.find((x) => x.subscription === "cursor");
  expect(row).toMatchObject({ usage: "live", usable: 0.24, age_sec: 595 });
  expect(started).toEqual([T]);
  // Hours later (a new session): the old reading still answers, and a fresh one is started behind it.
  const later = read(T + 5 + 4 * 3600 + 1);
  expect(later.headroom).toBeCloseTo(0.34, 9);
  expect(later.note).toContain("a fresh reading is being taken");
  expect(started).toHaveLength(2);
  // A failed reading keeps the last good one and says why.
  await refreshCursor({ file, nowSec: T + 20000, read: async () => ({ ok: false, error: "herdr is not installed", read_yourself: CURSOR_BY_HAND }) });
  const kept = read(T + 20001);
  expect(kept.headroom).toBeCloseTo(0.34, 9);
  expect(kept.note).toContain("the last try failed: herdr is not installed");
  // Only the background reading releases the lock: one asked for by hand must not free a lock it does not hold.
  const byHand = join(dir, "byhand.json"), held = `${byHand}.lock`;
  writeFileSync(held, "");
  await refreshCursor({ file: byHand, nowSec: T, read: async () => screen });
  expect(existsSync(held)).toBe(true);
  await refreshCursor({ file: byHand, nowSec: T, read: async () => screen, background: true });
  expect(existsSync(held)).toBe(false);
  // Never read, and the try failed: assumed, with how to read it by hand.
  const never = join(dir, "never.json");
  await refreshCursor({ file: never, nowSec: T, read: async () => ({ ok: false, error: "no herdr", read_yourself: CURSOR_BY_HAND }) });
  expect(readCursor({ file: never, nowSec: T + 1, refresh: () => {}, off: false }).note).toContain(CURSOR_BY_HAND);
  // Turned off (tests), a call neither starts a reading nor writes the stamp.
  const quiet = join(dir, "quiet.json");
  expect(readCursor({ file: quiet, nowSec: T, refresh: () => started.push("quiet") }).headroom).toBeNull();
  expect(existsSync(quiet)).toBe(false);
  // A day without a good reading: too old to use (the plan may have reset), so assumed, and it says so.
  const stale = readCursor({ file, nowSec: T + 5 + 25 * 3600, refresh: () => true, off: false });
  expect(stale.headroom).toBeNull();
  expect(stale.note).toContain("25 h old, too old to use");
  // Doctor, for a harness installed but not configured: reads, never starts a refresh.
  const before = started.length;
  readCursor({ file, nowSec: T + 40 * 3600, refresh: () => started.push("doctor"), background: false, off: false });
  expect(started).toHaveLength(before);
  // A refresh that cannot start gives the lock back and the reading still answers.
  const lockFile = join(dir, "spawnfail.json.lock");
  writeFileSync(join(dir, "spawnfail.json"), JSON.stringify({ ts: T, tried: T, reading: { included_used_pct: 50 } }));
  expect(readCursor({ file: join(dir, "spawnfail.json"), nowSec: T + 5 * 3600, refresh: () => false, off: false }).headroom).toBe(0.5);
  expect(existsSync(lockFile)).toBe(false);
  // An unwritable cache starts nothing: no lock, no refresh, not one per call.
  const blocked = join(dir, "not-a-dir");
  writeFileSync(blocked, "");
  const tries = [];
  for (let k = 0; k < 3; k++) readCursor({ file: join(blocked, "cursor-usage.json"), nowSec: T, refresh: () => tries.push(k), off: false });
  expect(tries).toEqual([]);
  // What the caller passes still wins, and the snapshot is not consulted for it.
  const [given] = await readUsage(["cursor"], { cursor: 0.9 }, { sources: { cursor: { read: () => { throw new Error("read"); } } }, why: async () => null });
  expect(given).toMatchObject({ source: "given by caller", headroom: 0.9 });
  // …but not for a harness that is not signed in: launch would refuse it, so dispatch must not rank it.
  const [signedOut] = await readUsage(["cursor"], { cursor: 0.9 }, { sources: {}, why: async () => "not signed in: run `cursor-agent login`" });
  expect(signedOut).toMatchObject({ signedIn: false, headroom: null });
});

test("the refresh lock lets one caller in at a time and gives up a lock left by a dead refresh", () => {
  const dir = scratch("lock"), lock = join(dir, "x.lock");
  const stale = (nowMs = Date.now()) => olderThan(120 * 1000, nowMs);
  expect(takeLock(lock, stale())).toBe(true);
  expect(takeLock(lock, stale())).toBe(false); // a second call in the burst
  expect(takeLock(lock, stale(Date.now() + 121 * 1000))).toBe(true); // older than any reading can take
  expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  expect(takeLock(join(dir, "missing", "x.lock"), stale())).toBe(false); // cannot write: no lock, so no refresh
});

test("routr usage ranks what it sees without a brief, and a name narrows it or opens the harness's screen", async () => {
  const c = cfg();
  const read = async (names, given) => names.map((n) => (n === "cursor" && given.cursor != null ? { pool: n, source: "given by caller", given: true, ageSec: 0, windows: [], headroom: given.cursor } : n === "claude" ? live("claude", 0.6) : none(n)));
  const all = await usageCommand([], c, {}, { read });
  expect(all.ok).toBe(true);
  expect(all.ranked.map((x) => x.subscription).sort()).toEqual(Object.keys(c.subscriptions).sort());
  expect(all.ranked.every((x) => x.hardest_work)).toBe(true);
  expect((await usageCommand([], c, { cursor: 0.4 }, { read })).ranked.find((x) => x.subscription === "cursor").usage).toBe("given");
  expect((await usageCommand(["claude"], c, {}, { read })).ranked.map((x) => x.subscription)).toEqual(["claude"]);
  expect((await usageCommand(["nope"], c, {}, { read })).error).toContain("not a configured subscription");
  expect((await usageCommand(["claude", "x"], c, {}, { read })).ok).toBe(false);
  expect((await usageCommand(["--json"], c, {}, { read })).ok).toBe(true); // doctor's flag: the output is JSON already
  expect((await usageCommand(["claude", "--json"], c, {}, { read })).ranked.map((x) => x.subscription)).toEqual(["claude"]);
  expect((await usageCommand(["--bogus"], c, {}, { read })).error).toContain("unknown: --bogus");
  expect(await usageCommand(["cursor"], c, {}, { read, sources: { cursor: { check: async () => ({ ok: true, opened: true }) } } })).toEqual({ ok: true, opened: true });
  const broken = await usageCommand([], c, {}, { read: async () => { throw new Error("gone"); } });
  expect(broken).toMatchObject({ ok: false, error: "gone" });
});

// Each harness's own status output, signed in and signed out, as measured on 2026-09-26 (stdout and stderr together).
const STATUS = {
  claude: { yes: ['{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}', 0], no: ['{\n  "loggedIn": false,\n  "authMethod": "none"\n}', 1] },
  codex: { yes: ["Logged in using ChatGPT\n", 0], no: ["Not logged in\n", 1] },
  cursor: { yes: ["✓ Logged in as someone@example.com\n", 0], no: ["Not logged in\n", 0] }, // exit 0 both ways
  agy: { yes: ["Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n", 0], no: ["Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n", 1] },
  kiro: { yes: ['{"accountType":"SocialGitHub","email":"someone@example.com"}\n', 0], no: ['{"account":null}\n', 1] },
};
test("every harness says whether it is signed in, read from its own status text, not its exit code alone", () => {
  expect(Object.keys(STATUS).sort()).toEqual(Object.keys(HARNESSES).sort()); // a harness added later brings its outputs
  for (const [n, { yes, no }] of Object.entries(STATUS)) {
    expect([n, HARNESSES[n].auth.signedIn(...yes)]).toEqual([n, true]);
    expect([n, HARNESSES[n].auth.signedIn(...no)]).toEqual([n, false]);
    expect([n, HARNESSES[n].auth.signedIn(no[0], 0)]).toEqual([n, false]); // the text alone says signed out, whatever the exit code
  }
});
test("the sign-in answer is kept: signed in for hours, signed out for minutes, and no answer is not signed in", async () => {
  const { signInState } = await import("../src/lib/signin.mjs");
  const file = join(scratch("signin"), "signed-in.json"), T = 1_800_000_000;
  const asked = [];
  const ask = (answer) => async (cmd, args) => { asked.push([cmd, ...args]); return answer; };
  const kiro = HARNESSES.kiro, o = (answer, nowSec, extra = {}) => ({ file, nowSec, ask: ask(answer), ...extra });
  expect(await signInState("kiro", kiro, o({ out: STATUS.kiro.yes[0], code: 0 }, T))).toBe("yes");
  expect(asked).toEqual([["kiro-cli", "whoami", "--format", "json"]]);
  expect(await signInState("kiro", kiro, o(null, T + 5 * 3600))).toBe("yes"); // kept: not asked again
  expect(asked).toHaveLength(1);
  expect(await signInState("kiro", kiro, o({ out: STATUS.kiro.no[0], code: 1 }, T + 7 * 3600))).toBe("no"); // past 6 h: asked
  expect(await signInState("kiro", kiro, o({ out: STATUS.kiro.yes[0], code: 0 }, T + 7 * 3600 + 11 * 60))).toBe("yes"); // "no" lasts 10 min
  expect(await signInState("kiro", kiro, o(null, T + 7 * 3600 + 12 * 60, { fresh: true }))).toBe("no answer"); // fresh always asks
  expect(asked).toHaveLength(4);
});
// `claude auth status`, measured 2026-10-07 (macOS): an API key login and a Max login. The email, organisation and ids
// are made up here, and must never reach the cache.
const AUTH_API_KEY = JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY", analyticsDisabled: false }, null, 2);
const AUTH_MAX = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "someone@example.com", orgId: "00000000-0000-0000-0000-000000000000", orgName: "Example Org", subscriptionType: "max" }, null, 2);
test("Claude's sign-in status says how it bills: an API key is metered, a subscription leaves it to the windows", () => {
  const billing = HARNESSES.claude.auth.billing;
  expect(billing(AUTH_API_KEY, 0)).toMatchObject({ billing: "metered" }); expect(billing(AUTH_API_KEY, 0).why).toContain("API key");
  expect(billing(AUTH_MAX, 0)).toBeNull();
  // A cloud provider is billed per token (its docs: claimed); a gateway's spend limit arrives as a window, so it is not.
  expect(billing(JSON.stringify({ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }), 0)).toMatchObject({ billing: "metered" });
  expect(billing(JSON.stringify({ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }), 0).why).toContain("bedrock");
  expect(billing(JSON.stringify({ loggedIn: true, authMethod: "third_party", apiProvider: "evil <x>" }), 0).why).toContain("a cloud provider");
  expect(billing(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "gateway" }), 0)).toBeNull();
  expect(billing(JSON.stringify({ loggedIn: true, authMethod: "api_key_helper", apiProvider: "firstParty" }), 0)).toMatchObject({ billing: "metered" });
  // Unreadable, signed out, or anything else: no reading, nothing guessed.
  for (const out of ["", "not json", "{", '{"loggedIn": false, "authMethod": "api_key"}', "null", "[1]", '"api_key"', '{"loggedIn": true, "authMethod": "oauth_token"}'])
    expect([out, billing(out, 0)]).toEqual([out, null]);
  expect(billing("warning: something\n" + AUTH_API_KEY, 0)).toMatchObject({ billing: "metered" }); // stderr before the JSON
  // Every other harness: none, so nothing changes for them.
  expect(Object.keys(HARNESSES).filter((n) => HARNESSES[n].auth.billing)).toEqual(["claude"]);
});
test("the billing reading is kept with the sign-in answer, the same lifetime, and only its class and reason", async () => {
  const { billingFromSignIn, signInState } = await import("../src/lib/signin.mjs");
  const file = join(scratch("signin-billing"), "signed-in.json"), T = 1_800_000_000, name = "claude-fixture"; // not "claude": other tests read that name
  const o = (out, nowSec, extra = {}) => ({ file, nowSec, ask: async () => (out == null ? null : { out, code: 0 }), ...extra });
  expect(await signInState(name, HARNESSES.claude, o(AUTH_API_KEY, T))).toBe("yes");
  expect(billingFromSignIn(name)).toMatchObject({ billing: "metered" });
  expect(JSON.parse(readFileSync(file, "utf8"))[name]).toEqual({ ts: T, state: "yes", billing: { billing: "metered", why: billingFromSignIn(name).why } });
  expect(await signInState(name, HARNESSES.claude, o(null, T + 5 * 3600))).toBe("yes"); // kept: not asked, still metered
  expect(billingFromSignIn(name)).toMatchObject({ billing: "metered" });
  // A subscription login: no reading, and none of what the status printed about the account is kept.
  expect(await signInState(name, HARNESSES.claude, o(AUTH_MAX, T + 7 * 3600))).toBe("yes");
  expect(billingFromSignIn(name)).toBeNull();
  const kept = readFileSync(file, "utf8");
  expect(JSON.parse(kept)[name]).toEqual({ ts: T + 7 * 3600, state: "yes" });
  for (const leak of ["someone@example.com", "Example Org", "00000000-0000", "max", "orgId", "email"]) expect(kept).not.toContain(leak);
  // A reader that throws is no reading, never a failed sign-in check.
  expect(await signInState(name, { ...HARNESSES.claude, auth: { ...HARNESSES.claude.auth, billing: () => { throw new Error("x"); } } }, o(AUTH_API_KEY, T, { fresh: true }))).toBe("yes");
  expect(billingFromSignIn(name)).toBeNull();
});
test("an API-key Claude with no windows ranks as metered, with no doctor step asking for billing; the user's billing still wins", async () => {
  const dir = scratch("claude-apikey");
  // What the API key's /usage printed (2026-10-07): a cost summary, no windows.
  const costOnly = claudeAnswer("Total cost: $0.0000\nTotal duration (API): 0s\nUsage: 0 input, 0 output, 0 cache read, 0 cache write");
  const sources = { claude: { read: () => readClaude({ file: join(dir, "none.json"), nowSec: OCT5, exec: async () => costOnly }) } };
  const read = (b) => readUsage(["claude"], {}, { sources, why: async () => null, billing: () => b });
  const [plain] = await read(null);
  expect(plain).toMatchObject({ class: "unknown", reason: NO_WINDOWS_AFTER_ANSWER }); // without the auth reading: as before
  const [u] = await read(HARNESSES.claude.auth.billing(AUTH_API_KEY, 0));
  expect(u).toMatchObject({ class: "metered", headroom: null, source: "claude auth status", billing: { billing: "metered", source: "claude auth status" } });
  expect(u.reason).toBeUndefined(); expect(u.note).toContain("API key"); expect(u.note).not.toContain("set `billing");
  const c = cfg({ subscriptions: { claude: cfg().subscriptions.claude } });
  expect(rankSubscriptions("standard", [u], c).ranked[0]).toMatchObject({ subscription: "claude", class: "metered", usage: "metered", usable: null });
  // The user's `billing: "included"` wins over the auth reading: the assumed headroom, as for any seat without windows.
  const mine = rankSubscriptions("standard", [u], cfg({ subscriptions: { claude: { ...cfg().subscriptions.claude, billing: "included" } } })).ranked[0];
  expect(mine).toMatchObject({ class: "included", usage: "assumed", use: "normal" });
  // doctor: the usage line names the billing and where it was read, and no step asks for `billing`.
  const { nextSteps } = await import("../src/lib/doctor.mjs");
  const { ROUTR_VERSION } = await import("../src/lib/version.mjs");
  const v = ROUTR_VERSION.split("-")[0];
  const r = (h) => ({ key: { works: true }, config: { exists: true, subscriptions: ["claude"], path: "config.json" }, herdr: { path: "/x", skill: true },
    skill: [{ where: "~/.agents/skills/routr", version: v }, { name: "routr-orchestrate", where: "~/.agents/skills/routr-orchestrate", version: v }],
    harnesses: { claude: { installed: true, signed_in: true, usage_class: h.class, usage_note: h.note, ...(h.reason ? { usage_reason: h.reason } : {}), ...(h.billing ? { usage_billing: h.billing } : {}) } } });
  expect(nextSteps(r(plain)).join(" ")).toContain('"billing": "metered"');
  expect(nextSteps(r(u))).toEqual([]);
});
test("windows that arrive while the sign-in status says metered are kept, and the disagreement is noted", async () => {
  const sources = { claude: { read: async () => live("claude", 0.6) } };
  const [u] = await readUsage(["claude"], {}, { sources, why: async () => null, billing: () => HARNESSES.claude.auth.billing(AUTH_API_KEY, 0) });
  expect(u).toMatchObject({ headroom: 0.6 }); expect(u.class).not.toBe("metered"); expect(u.billing).toBeUndefined();
  expect(u.note).toContain("yet usage windows arrived: ranked on the windows");
  expect(rankSubscriptions("standard", [u], cfg()).ranked.find((x) => x.subscription === "claude")).toMatchObject({ usage: "live", class: "included" });
});
test("a harness that is not signed in is never read, and dispatch leaves it out and says how to sign in", async () => {
  const reads = [];
  const sources = { codex: { read: async () => { reads.push("codex"); return live("codex", 0.8); } }, cursor: { read: async () => { reads.push("cursor"); return live("cursor", 0.9); } } };
  const usage = await readUsage(["codex", "cursor"], {}, { sources, why: (n) => (n === "cursor" ? "not signed in: cursor-agent login" : null) });
  expect(reads).toEqual(["codex"]);
  expect(usage.find((u) => u.pool === "cursor")).toMatchObject({ signedIn: false, headroom: null, note: "not signed in: cursor-agent login" });
  const r = rankSubscriptions("basic", usage, cfg());
  expect(r.ranked.map((x) => x.subscription)).not.toContain("cursor");
  expect(r.excluded).toContainEqual({ subscription: "cursor", reason: "not signed in: cursor-agent login" });
});
test("a background reading of a harness that is not signed in never starts it, keeps why, and gives the lock back", async () => {
  const dir = scratch("gate"), file = join(dir, "kiro-usage.json"), lock = `${file}.lock`;
  writeFileSync(lock, "");
  const r = await refreshKiro({ file, background: true, ready: async () => "not signed in: kiro-cli login", read: async () => { throw new Error("must not read"); } });
  expect(r).toEqual({ ok: false, error: "not signed in: kiro-cli login" });
  expect(JSON.parse(readFileSync(file, "utf8")).error).toBe("not signed in: kiro-cli login");
  expect(existsSync(lock)).toBe(false);
});

test("routr usage leaves a turned-off subscription out, says how to turn it on, and never reads it", async () => {
  const read = [];
  const config = cfg({ subscriptions: { codex: { enabled: true, hardest_work: "strong", reserve: 0.2, assumed_headroom: 0.5 }, cursor: { enabled: false, hardest_work: "standard", reserve: 0.1, assumed_headroom: 0.5 } } });
  const r = await usageCommand([], config, {}, { read: async (names) => { read.push(...names); return names.map((n) => live(n, 0.9)); } });
  expect(read).toEqual(["codex"]);
  expect(r.ranked.map((x) => x.subscription)).toEqual(["codex"]);
  expect(r.excluded).toEqual([{ subscription: "cursor", reason: "turned off in your settings: routr setup --enable cursor" }]);
});
