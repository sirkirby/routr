// `routr top`: the renderer at every width, the keys, the loop's terminal handling, and the command line. No harness.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { columns, decisionKey, renderTop, reselect, span, topCommand, topKey } from "../src/lib/top.mjs";
import { repositoryName, projectName } from "../src/lib/ledger.mjs";
import { glyphsFor, styler } from "../src/lib/tui.mjs";
import { cliEnv, scratch, SCRIPT } from "./helpers.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const UNI = glyphsFor({ TERM: "xterm-256color" }, "darwin"), ASCII = glyphsFor({ TERM: "linux" }, "linux");
const win = (usable, resets_in_h) => ({ window: "weekly", used_pct: Math.round((1 - usable) * 100), resets_in_h, left: usable, reserve_now: 0, usable });
const decision = (over = {}) => ({ launch_id: "aaaa1111-0000-4000-8000-000000000000", run_id: "bbbb2222-0000-4000-8000-000000000000", id: "ab12cd34", name: "rev", backend: "pane", project: "myco",
  launched_at: "2026-11-04T10:00:00Z", recorded_at: "2026-11-04T11:00:00Z",
  advised: { level: "standard", sure: false, between: ["standard", "strong"], work_type: "review", high_risk: true, fallback: false },
  chose: { subscription: "codex", model: "gpt-x", effort: "high", effort_from: "given", level: "strong" },
  outcome: { verdict: "done", check: "pass", attempts: 2, causes: ["review"], seconds: 40 }, ...over });
const board = (over = {}) => ({ ok: true, headline: "", unavailable: [], warnings: [], next: [], project: "myco", level: "basic",
  subscriptions: { most_room: "claude", ranked: [
    { subscription: "claude", class: "included", use: "normal", usable: 0.87, windows: [win(0.87, 100)], usage: "live", age_sec: 30 },
    { subscription: "codex", class: "included", use: "fallback", usable: 0.1, windows: [win(0.1, 5), win(0.5, 90)], usage: "assumed", age_sec: 7200 },
    { subscription: "cursor", class: "metered", use: "normal", usable: null, windows: [], usage: "live", age_sec: 10 }],
  excluded: [{ subscription: "kiro", why: "turned off in your settings: routr setup --enable kiro" }, { subscription: "agy", why: "not signed in: run agy login" }] },
  decisions: [decision(), decision({ launch_id: "cccc", run_id: null, name: "impl", recorded_at: null, outcome: null, chose: { subscription: "claude", model: "opus", effort: "medium", level: null } }),
    decision({ launch_id: null, run_id: "dddd", name: null, backend: null, launched_at: null, outcome: { verdict: "partial", check: "fail", attempts: 1, causes: ["execution"], seconds: null } })],
  outcomes: { launches: 2, recorded: 2, done_first_time: 1, level_changed: 1, check_failed: 1 }, ...over });
const draw = (b, o = {}) => renderTop(b, { width: 80, height: 30, g: UNI, c: styler(false), now: NOW, selected: 0, scope: "project", project: "myco", ...o });

test("every line fits the width it is drawn at, and the screen its height, in Unicode and ASCII, colour or not", () => {
  for (const width of [24, 40, 44, 80, 119, 120, 160]) for (const height of [8, 24, 50]) for (const g of [UNI, ASCII]) for (const colour of [false, true]) for (const open of [false, true]) {
    const lines = renderTop(board(), { width, height, g, c: styler(colour), now: NOW, selected: 1, open, scope: "project", project: "myco" });
    expect(lines.length).toBeLessThanOrEqual(height);
    for (const l of lines) expect(columns(l)).toBeLessThanOrEqual(width - 1);
  }
  // ASCII terminals get no glyph they cannot draw: every character is plain.
  const ascii = renderTop(board(), { width: 80, height: 30, g: ASCII, c: styler(false), now: NOW, selected: 0, scope: "project", project: "myco" }).join("\n");
  expect(/^[\x20-\x7e\n]*$/.test(ascii)).toBe(true);
  expect(ascii).toContain("#");
});

test("the narrow screen: room per account, decisions with their level and outcome, the counts, the keys", () => {
  const s = draw(board(), { width: 44 }).join("\n");
  expect(s).toMatch(/^routr top · myco +\d\d:\d\d/);
  expect(s).toMatch(/Claude Code +█+░+ +87% +4d/); // the window's reset
  expect(s).toMatch(/Codex +█+░+ +10% +5h/); // the binding window: the one leaving least
  expect(draw(board()).join("\n")).toMatch(/Codex +█+░+ +10% +5h fallback assumed 2h old/);
  expect(s).toMatch(/Cursor +metered/);
  expect(s).toMatch(/Kiro +off/);
  expect(s).toContain("Antigravity not signed in: run agy login");
  expect(s).toContain("Decisions  1/3");
  expect(s).toMatch(/›rev · review +1h {2}done/);
  expect(s).toContain("standard~ → strong risk  Codex · gpt-x");
  expect(s).toMatch(/ impl · review +2h {2}open/);
  expect(s).toMatch(/ review +1h {2}check failed/); // a recorded run with no launch: its work type
  expect(s).toContain("7 days  2 launched · 2 recorded");
  expect(s).toContain("1 check failed");
  expect(s).toContain("↑/↓ ⏎ open · a all · u usage · q quit");
});

test("wide: room and decisions side by side, a decision to a line", () => {
  const lines = draw(board(), { width: 140 });
  expect(lines[1]).toMatch(/^Room +Decisions {2}1\/3$/);
  expect(lines[2]).toMatch(/Claude Code .+ 87% .+›rev +review +standard~… risk Codex · gpt-x · high +1h done$/);
  expect(lines.join("\n")).toContain("7 days: 2 launched · 2 recorded · 1 done first time · 1 level changed · 1 check failed");
});

test("the detail: board's fields for one decision, and nothing it does not have", () => {
  const s = draw(board(), { open: true, selected: 0 }).join("\n");
  for (const want of ["rev · pane", "launched   2h ago", "recorded   1h ago", "advised    standard, torn between standard and strong · review · high risk",
    "chose      Codex · gpt-x · high · level strong", "outcome    done · check pass · 2 attempts · extra work: review · 40s", "ids        launch aaaa1111 · run bbbb2222 · advice ab12cd34", "esc back · q quit"]) expect(s).toContain(want);
  const open = draw(board(), { open: true, selected: 1 }).join("\n");
  expect(open).toContain("recorded   not yet");
  expect(open).toContain("level not recorded yet");
  expect(draw(board(), { open: true, selected: 2 }).join("\n")).toContain("launched   not started with routr launch");
  // A launch kept without its name or advice (an older history row) says so, never that it was recorded.
  const bare = board({ decisions: [decision({ name: null, advised: null, recorded_at: null, run_id: null, outcome: null })] });
  expect(draw(bare).join("\n")).toMatch(/›launch +2h {2}open\n {3}\? {2}Codex/);
  expect(draw(bare, { open: true }).join("\n")).toContain("advised    not kept");
  // Launched this minute, or by a clock ahead of this one: never "now ago", or " ago" with nothing before it.
  const at = (launched_at) => draw(board({ decisions: [decision({ launched_at })] }), { open: true }).join("\n");
  expect(at(new Date(NOW - 5000).toISOString())).toMatch(/launched {3}now, \d/);
  expect(at(new Date(NOW + 60_000).toISOString())).toMatch(/launched {3}\d/);
});

test("what board could not read is said, and a missing count is ? (never 0)", () => {
  const b = board({ subscriptions: null, decisions: [], outcomes: { launches: null, recorded: null, done_first_time: null, level_changed: null, check_failed: null },
    unavailable: [1, 2, 3, 4].map((i) => ({ part: "ledger", code: "unreadable", why: `reason ${i}` })) });
  const s = draw(b).join("\n");
  expect(s).toContain("Room\n not read");
  expect(s).toContain(" ! reason 1\n ! reason 2\n ! reason 3\n ! and 1 more: routr board shows them all");
  expect(s).toContain("no decision yet in myco");
  expect(s).toContain("7 days  ? launched · ? recorded · ? done first time");
  expect(draw(null).join("\n")).toContain("reading routr's board…");
  expect(draw(board({ subscriptions: { ranked: [], excluded: [] } })).join("\n")).toContain("no subscription is set up: routr setup");
  // Outside a repository: every project, and the screen says so; there is no project to switch to.
  const all = draw(board(), { project: null, scope: "all" }).join("\n");
  expect(all).toMatch(/^routr top · all projects/);
  expect(all).toContain("not in a git repository: every project");
  expect(all).toContain("⏎ open · u usage");
});

test("no control character from the user's data reaches the terminal", () => {
  const evil = "x\x1b]0;owned\x07\x1b[2J\u202e";
  const b = board({ decisions: [decision({ name: evil, chose: { subscription: evil, model: evil, effort: evil, level: evil }, advised: { level: evil, work_type: evil } })] });
  for (const open of [false, true]) for (const width of [44, 140]) {
    const s = renderTop(b, { width, height: 30, g: UNI, c: styler(false), now: NOW, selected: 0, open, scope: "project", project: evil }).join("\n");
    expect(s).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f\u202e]/);
  }
});

test("a snapshot is every decision, with no pick, no keys and no clock", () => {
  const many = board({ decisions: Array.from({ length: 30 }, (_, i) => decision({ launch_id: `l${i}`, name: `w${i}` })) });
  const s = renderTop(many, { width: 80, g: UNI, c: styler(false), now: NOW, scope: "project", project: "myco", snapshot: true }).join("\n");
  expect(s.split("\n")[0]).toBe("routr top · myco");
  expect(s).toContain("\nw29 · review");
  expect(s).not.toContain("›");
  expect(s).not.toContain("q quit");
  expect(s).not.toMatch(/ +$/m);
});

test("keys: move within the list, open and close a detail, switch scope only with a project, read usage, quit", () => {
  const s = { selected: 0, open: false, scope: "project" }, k = (name, extra = {}) => ({ name, ...extra });
  expect(topKey(s, undefined, k("down"), { count: 3 })).toEqual([{ ...s, selected: 1 }, null]);
  expect(topKey(s, "j", k("j"), { count: 3 })[0].selected).toBe(1);
  expect(topKey(s, undefined, k("up"), { count: 3 })[0].selected).toBe(0);
  expect(topKey({ ...s, selected: 2 }, undefined, k("down"), { count: 3 })[0].selected).toBe(2);
  expect(topKey(s, "G", k("g", { shift: true }), { count: 3 })[0].selected).toBe(2);
  expect(topKey(s, undefined, k("pagedown"), { count: 30 })[0].selected).toBe(10);
  expect(topKey(s, "\r", k("return"), { count: 3 })).toEqual([{ ...s, open: true }, null]);
  expect(topKey(s, "\r", k("return"), { count: 0 })).toEqual([s, null]);
  expect(topKey({ ...s, open: true }, undefined, k("escape"), { count: 3 })).toEqual([s, null]); // esc closes a detail
  expect(topKey({ ...s, open: true }, "j", k("j"), { count: 3 })).toEqual([{ ...s, open: true }, null]);
  expect(topKey({ ...s, selected: 2 }, "a", k("a"), { count: 3 })).toEqual([{ ...s, scope: "all", selected: 0 }, "scope"]);
  expect(topKey(s, "a", k("a"), { count: 3, scopes: false })).toEqual([s, null]);
  expect(topKey(s, "u", k("u"))[1]).toBe("usage");
  for (const [str, key] of [["q", k("q")], [undefined, k("escape")], ["\x03", k("c", { ctrl: true })]]) expect(topKey(s, str, key)[1]).toBe("quit");
  expect(topKey({ ...s, open: true }, "q", k("q"))[1]).toBe("quit");
});

test("a refresh keeps the pick on the same decision, and closes a detail whose decision went", () => {
  const a = decision({ launch_id: "a" }), b = decision({ launch_id: "b" }), fresh = decision({ launch_id: "new" });
  expect(reselect({ selected: 1, open: true }, [fresh, a, b], decisionKey(a))).toEqual({ selected: 1, open: true });
  expect(reselect({ selected: 1, open: true }, [fresh, a, b], decisionKey(b))).toEqual({ selected: 2, open: true });
  expect(reselect({ selected: 5, open: true }, [a], "gone")).toEqual({ selected: 0, open: false });
  expect(reselect({ selected: 0, open: false }, [], null)).toEqual({ selected: 0, open: false });
  expect(decisionKey(decision({ launch_id: null, run_id: "r" }))).toBe("r");
  expect(span(30)).toBe("now"); expect(span(7200)).toBe("2h"); expect(span(-5)).toBe(""); expect(span(NaN)).toBe("");
});

test("a folder's project is its repository's; outside any repository there is none", () => {
  const dir = scratch("top-repo"), repo = join(dir, "myco"), plain = join(dir, "plain");
  mkdirSync(join(repo, ".git", "worktrees", "x"), { recursive: true }); mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(plain);
  const wt = join(dir, "myco-wt"); mkdirSync(wt); writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "x")}\n`);
  expect([repositoryName(join(repo, "src")), repositoryName(wt), repositoryName(plain), projectName(plain)]).toEqual(["myco", "myco", null, "plain"]);
});

// ---- the loop, with fake streams ------------------------------------------------------------------------------------
function terminal() {
  const input = Object.assign(new EventEmitter(), { isTTY: true, raw: [], setRawMode(on) { this.raw.push(on); }, resume() {}, pause() {} });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 60, rows: 30, text: "", write(s) { this.text += s; return true; } });
  return { input, output };
}
const seams = (calls, extra = {}) => ({ load: () => ({ config: { subscriptions: {} }, notes: [] }), env: { TERM: "xterm-256color" }, platform: "darwin", every: 60_000,
  board: async (words) => { calls.push(words); return board(); }, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 5));

test("the screen: drawn on the alternate screen, kept current, and the terminal restored on q", async () => {
  const dir = scratch("top-loop"), repo = join(dir, "myco"); mkdirSync(join(repo, ".git"), { recursive: true });
  const { input, output } = terminal(), calls = [], spawned = [];
  let exit;
  const running = topCommand([], { ...seams(calls), cwd: repo, input, output, configPath: "cfg.json", spawn: (args, { onExit }) => { spawned.push(args); exit = onExit; return true; } });
  await tick();
  expect(output.text.startsWith("\x1b[?1049h\x1b[?25l")).toBe(true);
  expect(input.raw).toEqual([true]);
  expect(calls).toEqual([["--cwd", repo]]);
  expect(stripVTControlCharacters(output.text)).toContain("rev · review");
  input.emit("keypress", "u", { name: "u" });
  expect(spawned).toEqual([["usage", "--config", resolve("cfg.json")]]);
  expect(stripVTControlCharacters(output.text)).toContain("reading usage…");
  input.emit("keypress", "u", { name: "u" }); // one read at a time
  expect(spawned.length).toBe(1);
  exit(); await tick();
  expect(calls.length).toBe(2); // the read's end draws the board again
  expect(stripVTControlCharacters(output.text)).toMatch(/usage read \d\d:\d\d/);
  input.emit("keypress", "a", { name: "a" }); await tick();
  expect(calls.at(-1)).toEqual([]); // every project
  input.emit("keypress", "q", { name: "q" });
  expect(await running).toBe(0);
  expect(input.raw).toEqual([true, false]);
  expect(output.text.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
});

test("a board that cannot be read keeps the last screen and says so; SIGTERM restores the terminal", async () => {
  const { input, output } = terminal(); let n = 0;
  const running = topCommand([], { ...seams([], { board: async () => { if (n++) throw new Error("boom"); return board(); } }), cwd: scratch("top-fail"), input, output, every: 10 });
  await new Promise((r) => setTimeout(r, 40));
  const s = stripVTControlCharacters(output.text);
  expect(s).toContain("could not read the board");
  expect(s.slice(s.lastIndexOf("routr top"))).toContain("rev · review");
  process.emit("SIGTERM");
  expect(await running).toBe(0);
  expect(input.raw.at(-1)).toBe(false);
  expect(output.text.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
  expect(process.listeners("SIGTERM").length).toBe(0);
});

test("piped: one plain snapshot; ACCESSIBLE: a snapshot per line; a bad flag is refused", async () => {
  const pipe = { isTTY: false, text: "", write(s) { this.text += s; } }, calls = [];
  expect(await topCommand([], { ...seams(calls), cwd: scratch("top-pipe"), output: pipe, input: { isTTY: false } })).toBe(0);
  expect(calls).toEqual([[]]); // outside a repository: every project
  expect(pipe.text).toMatch(/^routr top · all projects\n not in a git repository/);
  expect(pipe.text).not.toContain("\x1b");

  const { output } = terminal(), acalls = [];
  const input = Object.assign(new (await import("node:stream")).PassThrough(), { isTTY: true });
  const running = topCommand([], { ...seams(acalls), env: { ACCESSIBLE: "1" }, cwd: scratch("top-a11y"), input, output, spawn: (_a, { onExit }) => { setTimeout(onExit, 1); return true; } });
  await tick(); input.write("\n"); await tick(); input.write("u\n"); await tick(); await tick(); input.write("q\n");
  expect(await running).toBe(0);
  expect(acalls.length).toBe(3);
  expect(output.text).not.toContain("\x1b");
  expect(output.text).toContain("reading usage…");
  expect(output.text).toContain("Enter: read again, u: read usage now, q: quit");

  for (const [args, why] of [[["--cwd"], "takes a folder"], [["--nope"], "unknown flag"], [["--cwd", "/no/such/folder"], "is not a folder"], [["--cwd", ".", "--cwd", "."], "more than once"]]) {
    const err = { text: "", write(s) { this.text += s; } };
    expect(await topCommand(args, { ...seams([]), errors: err, output: pipe })).toBe(2);
    expect(err.text).toContain(why);
  }
});

test("routr top on the command line: a snapshot when piped, never a ledger note; a --cwd a global flag took is refused", () => {
  const home = scratch("top-cli"), repo = join(home, "myco"); mkdirSync(join(repo, ".git"), { recursive: true });
  const ledger = join(home, ".local/share/routr/ledger.jsonl"); mkdirSync(join(home, ".local/share/routr"), { recursive: true });
  writeFileSync(ledger, `${JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", project: "myco", id: "ab12cd34", advised: { level: "basic" }, chose: { subscription: "codex", level: "basic" },
    outcome: { verdict: "done", check: "pass", note: "SECRET-NOTE-TOP" } })}\n`);
  const r = Bun.spawnSync([process.execPath, SCRIPT, "top", "--cwd", repo], { env: cliEnv(home) });
  const out = r.stdout.toString();
  expect([r.exitCode, out.split("\n")[0]]).toEqual([0, expect.stringMatching(/^routr top (·|-) myco$/)]); // ASCII in the Windows console
  expect(out).toContain("1 recorded");
  expect(out + r.stderr.toString()).not.toContain("SECRET-NOTE-TOP");
  for (const extra of [["--headroom", "--cwd"], ["--config", "--cwd"]]) {
    const bad = Bun.spawnSync([process.execPath, SCRIPT, "top", ...extra, repo], { env: cliEnv(home) });
    expect([bad.exitCode, bad.stderr.toString()]).toEqual([2, expect.stringContaining("--cwd cannot be a value")]);
  }
});

// ---- found in review (rev159) ---------------------------------------------------------------------------------------
test("a terminal smaller than the screen gets no line wider or row more than it has", () => {
  for (let width = 1; width <= 30; width++) for (let height = 1; height <= 8; height++) for (const open of [false, true]) {
    for (const b of [board(), null]) for (const project of ["myco", null]) {
      const lines = renderTop(b, { width, height, g: UNI, c: styler(true), now: NOW, selected: 0, open, scope: project ? "project" : "all", project });
      expect(lines.length).toBeLessThanOrEqual(height);
      for (const l of lines) expect(columns(l)).toBeLessThanOrEqual(width - 1);
    }
  }
});

test("wide and combining characters are measured in columns, and never split", () => {
  expect([columns("漢字"), columns("e\u0301"), columns("👍"), columns("🚀⌚"), columns("❤\ufe0f"), columns("🇺🇸"), columns("█⏎›…░·→"), columns("\x1b[1mab\x1b[22m")]).toEqual([4, 1, 2, 4, 2, 2, 7, 2]);
  const b = board({ decisions: [decision({ name: "漢🚀".repeat(10), chose: { subscription: "codex", model: "모델".repeat(10), effort: "high", level: "strong" } })] });
  for (const width of [40, 44, 80, 140]) for (const open of [false, true]) {
    const lines = renderTop(b, { width, height: 30, g: UNI, c: styler(false), now: NOW, selected: 0, open, scope: "project", project: "프로젝트" });
    for (const l of lines) { expect(columns(l)).toBeLessThanOrEqual(width - 1); expect(l).not.toContain("�"); }
  }
});

test("every field from the user's records is cleaned, including numbers that are not numbers", () => {
  const b = board({ decisions: [decision({ outcome: { verdict: "done", check: "pass", attempts: "\x1b[2JINJECTED", causes: "\x1b[2J", seconds: "\x1b[2J" } })] });
  const s = renderTop(b, { width: 80, height: 30, g: UNI, c: styler(false), now: NOW, selected: 0, open: true, scope: "project", project: "myco" }).join("\n");
  expect(s).not.toContain("\x1b");
  expect(s).toContain("outcome    done · check pass\n");
});

test("a draw that fails on a refresh ends top with the terminal restored, and says why", async () => {
  const { input, output } = terminal(), err = { text: "", write(s) { this.text += s; } };
  let n = 0, fail = false; const write = output.write.bind(output);
  output.write = (s) => { if (fail && !s.includes("\x1b[?1049l")) { fail = false; throw new Error("EIO"); } return write(s); };
  const running = topCommand([], { ...seams([], { board: async () => { if (n++) fail = true; return board(); } }), cwd: scratch("top-drawfail"), input, output, errors: err, every: 10 });
  expect(await running).toBe(1);
  expect(input.raw.at(-1)).toBe(false);
  expect(output.text.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
  expect(err.text).toContain("top stopped: the screen could not be drawn");
});

test("SIGINT from outside restores the terminal too, and no signal listener is left", async () => {
  const before = Object.fromEntries(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => [s, process.listenerCount(s)]));
  const { input, output } = terminal();
  const running = topCommand([], { ...seams([]), cwd: scratch("top-sigint"), input, output });
  await tick();
  expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
  process.emit("SIGINT");
  expect(await running).toBe(0);
  expect(output.text.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(process.listenerCount(s)).toBe(before[s]);
});

test("ACCESSIBLE: a usage read that never ends does not stop q", async () => {
  const { output } = terminal(), input = Object.assign(new (await import("node:stream")).PassThrough(), { isTTY: true });
  const running = topCommand([], { ...seams([]), env: { ACCESSIBLE: "1" }, cwd: scratch("top-a11y-hung"), input, output, spawn: () => true });
  await tick(); input.write("u\n"); await tick(); input.write("u\n"); await tick(); input.write("q\n");
  expect(await running).toBe(0);
  expect(output.text).toContain("a usage read is already running");
});

test("the pick stays on its decision when one arrives before any key is pressed", async () => {
  const { input, output } = terminal(), first = board(), later = board({ decisions: [decision({ launch_id: "new", name: "newest" }), ...first.decisions] });
  let n = 0;
  const running = topCommand([], { ...seams([], { board: async () => (n++ ? later : first) }), cwd: scratch("top-pick"), input, output, every: 10 });
  await new Promise((r) => setTimeout(r, 40));
  const s = stripVTControlCharacters(output.text);
  expect(s.slice(s.lastIndexOf("routr top"))).toMatch(/Decisions {2}2\/4[\s\S]*›rev · review/);
  input.emit("keypress", "q", { name: "q" });
  expect(await running).toBe(0);
});
