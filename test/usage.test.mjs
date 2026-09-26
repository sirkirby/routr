// usage readers: Claude's statusline, Codex, Cursor's screen, Kiro's /usage, the background snapshots, and `routr usage`
import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rankSubscriptions } from "../src/lib/pick.mjs";
import { claudeSnapshot, codexSnapshot, monthMinutes } from "../src/lib/usage.mjs";
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

// A fake herdr for the Cursor read: a private session that starts on the third look, a shell that asks the dotenv
// question once, then Cursor and its /usage panel. Every pane command must go to the private session, never a split.
// Stale sessions: one left by a routr that is gone (pid 99) is removed; one whose routr is alive (pid 7) is not.
const CU_TMP = scratch("cu");


function fakeCursorUsage({ delayPanel = false, neverDraws = false, cursorRuns = true, failCreate = false, spawnFails = false, sessions = null } = {}) {
  let stage = "shell", dotenv = true, ticks = 0, extraEnter = false, up = 0;
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
        if (stage === "shell") return herdrOK({ text: dotenv ? "found '.env' file. Source it? ([y]es/[N]o/[a]lways/n[e]ver)" : "chris % " });
        if (neverDraws) return herdrOK({ text: "chris % " });
        if (stage === "usage") return herdrOK({ text: delayPanel && !extraEnter ? CURSOR_UI : CURSOR_USAGE_PANEL });
        return herdrOK({ text: CURSOR_UI });
      }
      if (a[1] === "process-info") return stage === "starting" && cursorRuns ? shellInfo([{ pid: 1 }, { pid: 2 }]) : shellInfo();
      if (a[1] === "send-keys") {
        if (stage === "shell") { expect(a.slice(3)).toEqual(["n", "enter"]); dotenv = false; }
        else if (a[3] === "enter" && stage === "starting") stage = "usage";
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
