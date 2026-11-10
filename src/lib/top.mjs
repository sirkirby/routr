// `routr top`: `routr board` for a person, kept current in a terminal: a pane beside the lead, a split in the Herdr app,
// a terminal over SSH. It draws board's answer (boardCommand, in this process) and nothing else, so it shows no more
// than board does: never a ledger note or a brief. It changes nothing of the user's: board only reads, and starts at
// most one background usage read per 10 minutes; `u` starts one now, because the person asked. Drawn with tui.mjs's
// rules: node built-ins only, glyphs and colour as this terminal takes them, the terminal always restored. A pipe gets
// one plain snapshot; ACCESSIBLE (or TERM=dumb) gets a plain snapshot per Enter, never a redrawn screen.
// The renderer and the key handler are pure (tests draw them at any width); the loop below them is the only impure part.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { boardCommand } from "./board.mjs";
import { loadConfig } from "./config.mjs";
import { HARNESSES } from "./harnesses.mjs";
import { repositoryName } from "./ledger.mjs";
import { spawnSelf } from "./processes.mjs";
import { accessibleOk, colourOk, glyphsFor, styler, wrap } from "./tui.mjs";

export const REFRESH_MS = 5000; // board answers in ~30 ms from kept readings: a redraw this often costs nothing
export const WIDE = 120; // from this many columns, Room and Decisions side by side: below it a decision's choice would be cut
const LEFT = 36; // Room's column when wide

// What a board holds is the user's own (names, models), never routr's prose: no control or format character reaches
// the terminal from it.
const t = (s) => String(s ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "");
const label = (n) => t(HARNESSES[n]?.label ?? n);
// Terminal columns, by grapheme: a combining mark takes none, an East Asian wide or fullwidth character or an emoji
// shown as emoji (Emoji_Presentation, or asked for with VS16) two, the rest one. Close to wcwidth; what an emoji
// sequence takes still varies by terminal.
const SEGMENTER = new Intl.Segmenter();
const graphemes = (s) => Array.from(SEGMENTER.segment(s), (x) => x.segment);
const WIDE_CHAR = /^[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}|\ufe0f/u;
const glyphColumns = (x) => (/^\p{M}+$/u.test(x) ? 0 : WIDE_CHAR.test(x) ? 2 : 1);
export const columns = (s) => graphemes(stripVTControlCharacters(String(s))).reduce((n, x) => n + glyphColumns(x), 0);
// Plain text cut to `w` columns, the cut marked with `more`; never a wide character split.
function cut(s, w, more) {
  if (w <= 0) return "";
  if (columns(s) <= w) return s;
  const room = columns(more) < w ? w - columns(more) : w;
  let out = "", n = 0;
  for (const x of graphemes(s)) { const k = glyphColumns(x); if (n + k > room) break; out += x; n += k; }
  return room < w ? `${out}${more}` : out;
}
const pad = (s, w) => s + " ".repeat(Math.max(0, w - columns(s)));
// How long, in the largest whole unit: now, 12m, 5h, 3d.
export const span = (sec) => (!Number.isFinite(sec) || sec < 0 ? "" : sec < 60 ? "now" : sec < 3600 ? `${Math.floor(sec / 60)}m` : sec < 86400 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 86400)}d`);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

// Styled parts cut to `width` columns, the cut marked with the "more" glyph: every line is drawn through this.
function fit(parts, width, more) {
  let left = Math.max(0, width), out = "";
  for (const [text, style] of parts) {
    if (left <= 0) break;
    let s = String(text);
    const n = columns(s);
    if (n > left) { s = cut(s, left, more); left = 0; } else left -= n;
    out += style && s ? style(s) : s;
  }
  return out;
}
// A cell `w` columns wide: cut, or padded (to the left with `right`).
const cell = (s, w, more, right = false) => { const x = cut(s, w, more), gap = " ".repeat(Math.max(0, w - columns(x))); return right ? gap + x : x + gap; };

// ---- the parts of the screen -------------------------------------------------------------------------------------------

function roomLines(b, { width, g, c }) {
  const s = b.subscriptions;
  if (!s) return [fit([[" not read", c.dim]], width, g.more)];
  const ranked = s.ranked ?? [], excluded = s.excluded ?? [];
  if (!ranked.length && !excluded.length) return [fit([[" no subscription is set up: routr setup", c.dim]], width, g.more)];
  const nameW = Math.min(12, Math.max(...[...ranked, ...excluded].map((r) => columns(label(r.subscription)))));
  const barW = Math.max(4, Math.min(20, width - nameW - 15));
  const lines = ranked.map((r) => {
    const name = [` ${cell(label(r.subscription), nameW, g.more)} `];
    const tags = [r.use === "fallback" ? "fallback" : null, r.usage === "assumed" ? "assumed" : null, r.age_sec >= 3600 ? `${span(r.age_sec)} old` : null].filter(Boolean).join(" ");
    if (!Number.isFinite(r.usable)) return fit([name, [r.class === "metered" ? "metered" : "unknown", c.dim], [tags ? ` ${tags}` : "", c.dim]], width, g.more);
    const u = Math.max(0, Math.min(1, r.usable)), filled = Math.round(u * barW), tone = u <= 0 ? c.red : u < 0.2 ? c.yellow : c.green;
    // The window that leaves the least is the one that binds: its reset is when the room comes back.
    const binding = (r.windows ?? []).filter((w) => Number.isFinite(w.usable)).sort((a, z) => a.usable - z.usable)[0];
    const reset = Number.isFinite(binding?.resets_in_h) ? span(binding.resets_in_h * 3600) : "";
    return fit([name, [g.full.repeat(filled), tone], [g.empty.repeat(barW - filled), c.dim], [` ${`${Math.round(u * 100)}%`.padStart(4)}`], [reset ? ` ${reset.padStart(3)}` : ""], [tags ? ` ${tags}` : "", c.dim]], width, g.more);
  });
  for (const e of excluded) lines.push(fit([[` ${cell(label(e.subscription), nameW, g.more)} `], [/^turned off/.test(e.why ?? "") ? "off" : t(e.why), c.dim]], width, g.more));
  return lines;
}

// What board could not read, and what it says about this call: routr's own fixed words, one line each.
function noticeLines(b, { width, g, c }, max = 3) {
  const said = [...(b.unavailable ?? []).map((u) => u.why), ...(b.warnings ?? []).map((w) => w.message ?? w.why ?? w.code)].filter(Boolean).map(t);
  const lines = said.slice(0, max).map((s) => fit([[` ! ${s}`, c.yellow]], width, g.more));
  if (said.length > max) lines.push(fit([[` ! and ${said.length - max} more: routr board shows them all`, c.yellow]], width, g.more));
  return lines;
}

const verdictOf = (d, c) => {
  const o = d.outcome;
  if (!o) return d.launched_at ? ["open", c.cyan] : ["", null];
  if (o.check === "fail") return ["check failed", c.red];
  return [t(o.verdict ?? "recorded"), o.verdict === "done" ? c.green : c.yellow];
};
// The advised level, `~` when routr was torn, and the level the lead chose when it differs.
const levelOf = (d, g) => {
  const a = d.advised ?? {}, chosen = d.chose?.level;
  return `${t(a.level ?? "?")}${a.sure === false ? "~" : ""}${chosen && a.level && chosen !== a.level ? ` ${g.arrow} ${t(chosen)}` : ""}`;
};
const choiceOf = (d, g) => [d.chose?.subscription ? label(d.chose.subscription) : null, d.chose?.model, d.chose?.effort].filter(Boolean).map(t).join(g.sep);
const ageOf = (d, now) => span((now - Date.parse(d.recorded_at ?? d.launched_at)) / 1000);
const nameOf = (d) => (d.name ? t(d.name) : d.launched_at ? "launch" : "recorded run");
// A run recorded without routr launch has no name: its work type says what it was.
const titleOf = (d, g) => (d.name ? `${t(d.name)}${d.advised?.work_type ? `${g.sep}${t(d.advised.work_type)}` : ""}` : t(d.advised?.work_type ?? nameOf(d)));

// Two lines a decision in a narrow pane, one when wide.
function decisionItem(d, picked, { width, g, c, now, wide, snapshot }) {
  const mark = snapshot ? "" : picked ? g.pick : " ", strong = picked ? c.bold : null;
  const [verdict, tone] = verdictOf(d, c), age = ageOf(d, now), risk = d.advised?.high_risk ? " risk" : "";
  if (wide) {
    const rest = width - mark.length - 13 - 11 - 16 - 5 - 12, level = levelOf(d, g);
    const shown = columns(level) + risk.length > 15 ? cut(level, 15 - risk.length, g.more) : level;
    return [fit([[mark], [`${cell(nameOf(d), 12, g.more)} `, strong ?? (d.name ? null : c.dim)], [`${cell(t(d.advised?.work_type ?? ""), 10, g.more)} `], [shown], [risk, c.yellow], [" ".repeat(Math.max(0, 16 - columns(shown) - risk.length))],
      [`${cell(choiceOf(d, g), Math.max(1, rest), g.more)} `, c.dim], [`${age.padStart(4)} `], [verdict, tone]], width, g.more)];
  }
  const right = `${age.padStart(3)}  ${verdict}`, left = titleOf(d, g);
  const room = Math.max(1, width - mark.length - columns(right) - 1);
  return [
    fit([[mark], [cell(left, room, g.more), strong], [` ${age.padStart(3)}  `], [verdict, tone]], width, g.more),
    fit([[`${" ".repeat(mark.length)}  ${levelOf(d, g)}`], [risk, c.yellow], ["  "], [choiceOf(d, g), c.dim]], width, g.more),
  ];
}

// The decisions that fit in `rows`, scrolled to keep the picked one in view.
function decisionLines(b, o, rows) {
  const ds = b.decisions ?? [], per = o.wide ? 1 : 2;
  if (!ds.length) return [fit([[` no decision yet in ${o.scope === "project" && o.project ? t(o.project) : "any project"}`, o.c.dim]], o.width, o.g.more)];
  const n = o.snapshot ? ds.length : Math.max(1, Math.floor(rows / per)), sel = Math.min(Math.max(0, o.selected ?? 0), ds.length - 1);
  const from = Math.min(Math.max(0, sel - Math.floor(n / 2)), Math.max(0, ds.length - n));
  return ds.slice(from, from + n).flatMap((d, i) => decisionItem(d, !o.snapshot && from + i === sel, o));
}

// Everything board says about one decision: its fields, nothing more.
export function detailLines(d, { width, g, c, now }) {
  const k = 10, lines = [fit([[`${nameOf(d)}${d.backend ? `${g.sep}${t(d.backend)}` : ""}`, c.bold]], width, g.more)];
  const field = (key, value) => wrap(value, Math.max(10, width - k - 1)).forEach((l, i) => lines.push(fit([[i ? " ".repeat(k + 1) : `${key.padEnd(k)} `, c.dim], [l]], width, g.more)));
  // Under a minute span says "now", and for a time ahead of this clock nothing: neither is "<that> ago".
  const when = (iso) => { const ms = Date.parse(iso); if (!Number.isFinite(ms)) return null; const ago = span((now - ms) / 1000); return ago === "now" ? `now, ${clock(ms)}` : ago ? `${ago} ago, ${clock(ms)}` : clock(ms); };
  const a = d.advised ?? {}, ch = d.chose ?? {}, o = d.outcome;
  field("launched", d.launched_at ? when(d.launched_at) : "not started with routr launch");
  field("recorded", d.recorded_at ? when(d.recorded_at) : "not yet");
  field("advised", !a.level ? "not kept" : `${t(a.level)}${a.sure === false && Array.isArray(a.between) ? `, torn between ${a.between.map(t).join(" and ")}` : ""}${a.work_type ? `${g.sep}${t(a.work_type)}` : ""}${a.high_risk ? `${g.sep}high risk` : ""}${a.fallback ? `${g.sep}fallback advice` : ""}`);
  field("chose", `${choiceOf(d, g) || "?"}${g.sep}level ${ch.level ? t(ch.level) : "not recorded yet"}`);
  field("outcome", o ? [t(o.verdict ?? "?"), `check ${t(o.check ?? "?")}`, Number.isInteger(o.attempts) && o.attempts > 0 ? `${o.attempts} attempt${o.attempts === 1 ? "" : "s"}` : null,
    Array.isArray(o.causes) && o.causes.length ? `extra work: ${o.causes.map(t).join(", ")}` : null, Number.isFinite(o.seconds) ? `${o.seconds}s` : null].filter(Boolean).join(g.sep) : "not recorded yet");
  field("ids", [d.launch_id ? `launch ${t(d.launch_id).slice(0, 8)}` : null, d.run_id ? `run ${t(d.run_id).slice(0, 8)}` : null, d.id ? `advice ${t(d.id)}` : null].filter(Boolean).join(g.sep) || "none");
  return lines;
}

function footerLines(b, { width, g, c, wide }) {
  const n = b.outcomes ?? {}, v = (x) => (Number.isFinite(x) ? String(x) : "?");
  const items = [`${v(n.launches)} launched`, `${v(n.recorded)} recorded`, `${v(n.done_first_time)} done first time`, `${v(n.level_changed)} level changed`, `${v(n.check_failed)} check failed`];
  const lead = wide ? "7 days: " : "7 days  ";
  // Whole items to a line: a count is never split from its words.
  const lines = [];
  for (const it of items) { const last = lines.length - 1; if (last >= 0 && lead.length + lines[last].length + g.sep.length + it.length <= width) lines[last] += `${g.sep}${it}`; else lines.push(it); }
  return lines.map((l, i) => fit([[i ? " ".repeat(lead.length) : lead, c.dim], [l]], width, g.more));
}

const help = (o) => {
  const words = o.open ? ["esc back", "q quit"]
    : [`${o.g.updown} ${o.g.enter} open`, o.project ? `a ${o.scope === "project" ? "all" : "project"}` : null, "u usage", "q quit"].filter(Boolean);
  return fit([[words.join(o.g.sep), o.c.dim]], o.width, o.g.more);
};

// The whole screen, as lines that fit `width` (the last column is left free: a line that fills it can wrap or lose its
// last character) and, unless it is a snapshot, `height`. `b` is board's answer, or null before the first one.
export function renderTop(b, o) {
  const width = Math.max(0, o.width - 1), wide = o.width >= WIDE, snapshot = Boolean(o.snapshot), height = snapshot ? Infinity : Math.max(1, o.height);
  const v = { ...o, width, wide, snapshot, now: o.now ?? Date.now() }, { g, c } = v;
  const where = o.scope === "project" && o.project ? t(o.project) : "all projects";
  const right = `${o.note ? `${t(o.note)}  ` : ""}${snapshot ? "" : clock(v.now)}`;
  const top = [fit([["routr top", c.bold], [`${g.sep}${where}`], [" ".repeat(Math.max(1, width - 9 - columns(g.sep) - columns(where) - columns(right)))], [right, c.dim]], width, g.more)];
  if (!o.project) top.push(fit([[" not in a git repository: every project", c.dim]], width, g.more));
  if (!b) return [...top, fit([[" reading routr's board…", c.dim]], width, g.more)].slice(0, height);
  const notices = noticeLines(b, v), foot = footerLines(b, v), keys = snapshot ? [] : [help(v)];
  const ds = b.decisions ?? [], sel = Math.min(Math.max(0, o.selected ?? 0), Math.max(0, ds.length - 1));
  const heading = fit([["Decisions", c.bold], [ds.length && !snapshot ? `  ${sel + 1}/${ds.length}` : "", c.dim]], wide ? width - LEFT - 2 : width, g.more);
  const picked = o.open && ds[sel];
  let body;
  if (wide) {
    const rightW = width - LEFT - 2, left = [fit([["Room", c.bold]], LEFT, g.more), ...roomLines(b, { ...v, width: LEFT })];
    const rows = height - top.length - notices.length - foot.length - keys.length;
    const list = picked ? detailLines(picked, { ...v, width: rightW }) : [heading, ...decisionLines(b, { ...v, width: rightW }, rows - 1)];
    const n = snapshot ? Math.max(left.length, list.length) : Math.max(left.length, rows);
    body = Array.from({ length: n }, (_, i) => `${pad(left[i] ?? "", LEFT)}  ${list[i] ?? ""}`).concat(notices);
  } else {
    const room = [fit([["Room", c.bold]], width, g.more), ...roomLines(b, v), ...notices];
    const rows = height - top.length - room.length - foot.length - keys.length;
    const list = picked ? detailLines(picked, v) : [heading, ...decisionLines(b, v, rows - 1)];
    body = [...room, ...list, ...(snapshot ? [] : Array(Math.max(0, rows - list.length)).fill(""))];
  }
  if (!snapshot) body = body.slice(0, Math.max(0, height - top.length - foot.length - keys.length));
  const all = [...top, ...body, ...foot, ...keys].slice(0, height);
  return snapshot ? all.map((l) => l.trimEnd()) : all;
}

// ---- keys ------------------------------------------------------------------------------------------------------------

// The next state for a key, and what the loop should do: "quit", "scope" (read the board for the other scope), "usage"
// (read usage now), or null. `count` is how many decisions there are; `scopes` whether there is a project to switch to.
export function topKey(state, str, k = {}, { count = 0, scopes = true } = {}) {
  const s = { ...state }, name = k.name;
  if ((k.ctrl && name === "c") || str === "q") return [s, "quit"];
  if (s.open) return [name === "escape" || name === "return" || name === "enter" || name === "backspace" || name === "left" ? { ...s, open: false } : s, null];
  if (name === "escape") return [s, "quit"];
  const to = (i) => ({ ...s, selected: Math.max(0, Math.min(Math.max(0, count - 1), i)) });
  if (name === "up" || str === "k") return [to(s.selected - 1), null];
  if (name === "down" || str === "j") return [to(s.selected + 1), null];
  if (name === "pageup") return [to(s.selected - 10), null];
  if (name === "pagedown") return [to(s.selected + 10), null];
  if (name === "home" || str === "g") return [to(0), null];
  if (name === "end" || str === "G") return [to(count - 1), null];
  if (name === "return" || name === "enter" || name === "right") return [count ? { ...s, open: true } : s, null];
  if (str === "a" && scopes) return [{ ...s, scope: s.scope === "project" ? "all" : "project", selected: 0, open: false }, "scope"];
  if (str === "u") return [s, "usage"];
  return [s, null];
}

// A decision's identity across refreshes: a new launch at the top must not move the pick onto another decision.
export const decisionKey = (d) => (d ? d.launch_id ?? d.run_id ?? null : null);
// The pick after a refresh: the same decision where it is now, or the nearest index; a detail whose decision went closes.
export function reselect(state, decisions, key) {
  const at = key == null ? -1 : decisions.findIndex((d) => decisionKey(d) === key);
  const selected = at >= 0 ? at : Math.max(0, Math.min(state.selected, decisions.length - 1));
  return { ...state, selected, open: state.open && at >= 0 };
}

// ---- the loop --------------------------------------------------------------------------------------------------------

function parse(words) {
  const o = {}, rest = [...words];
  while (rest.length) {
    const w = rest.shift();
    if (w !== "--cwd") throw new Error(`top: unknown ${w.startsWith("-") ? "flag" : "argument"} ${w}; routr top [--cwd <folder>]`);
    if (o.cwd != null) throw new Error("top: --cwd was given more than once");
    const v = rest.shift();
    if (!v || v.startsWith("--")) throw new Error("top: --cwd takes a folder");
    let dir; try { dir = statSync(resolve(v)).isDirectory(); } catch { dir = false; }
    if (!dir) throw new Error(`top: --cwd ${v} is not a folder`);
    o.cwd = resolve(v);
  }
  return o;
}

// Runs until the person quits; answers the exit code. `warnings` are the command line's own (an unused --headroom).
// The rest are seams for tests.
export async function topCommand(words, { configPath, warnings = [], input = process.stdin, output = process.stdout, errors = process.stderr, env = process.env,
  platform = process.platform, cwd = process.cwd(), board = boardCommand, load = loadConfig, spawn = spawnSelf, every = REFRESH_MS, now = () => Date.now() } = {}) {
  let o;
  try { o = parse(words); } catch (e) { errors.write(`routr: ${e.message}\n`); return 2; }
  const folder = o.cwd ?? resolve(cwd), project = repositoryName(folder);
  const g = glyphsFor(env, platform), write = (s) => output.write(s);
  let scope = project ? "project" : "all";
  const read = async () => {
    try { const { config, notes } = load(configPath); return await board(scope === "project" ? ["--cwd", folder] : [], config, { configPath, warnings: [...notes, ...warnings] }); }
    catch { return null; } // board fails open; anything else keeps the last screen, said in the header
  };
  const usageArgs = ["usage", ...(configPath ? ["--config", resolve(configPath)] : [])];
  const snapshot = (b, c) => renderTop(b, { width: output.columns || 80, g, c, now: now(), scope, project, snapshot: true }).join("\n");

  // Not a terminal: one snapshot, as text a file or a pipe can keep.
  if (!output.isTTY) { write(`${snapshot(await read(), styler(colourOk(output, env)))}\n`); return 0; }
  // Accessible: a plain snapshot, and another on each line typed.
  if (accessibleOk(env) || !input.isTTY) {
    const c = styler(false), keys = () => `Enter: read again${project ? `, a: ${scope === "project" ? "all projects" : "this project"}` : ""}, u: read usage now, q: quit`;
    write(`${snapshot(await read(), c)}\n${keys()}\n`);
    if (!input.isTTY && !accessibleOk(env)) return 0;
    const rl = createInterface({ input, terminal: false });
    let reading = false, quit = false;
    // A usage read is never waited on: the board is shown again when it ends, and q works meanwhile.
    const ended = async () => { reading = false; if (!quit) { const b = await read(); if (!quit) write(`usage read\n${snapshot(b, c)}\n${keys()}\n`); } };
    for await (const line of rl) {
      const a = line.trim().toLowerCase();
      if (a === "q") break;
      if (a === "a" && project) scope = scope === "project" ? "all" : "project";
      if (a === "u") {
        if (reading) write("a usage read is already running\n");
        else if ((reading = spawn(usageArgs, { onExit: () => void ended().catch(() => {}) }))) { write("reading usage…; the board is shown again when it ends\n"); continue; }
        else write("could not start a usage read\n");
      }
      write(`${snapshot(await read(), c)}\n${keys()}\n`);
    }
    quit = true;
    rl.close();
    return 0;
  }

  const c = styler(colourOk(output, env)), SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
  return await new Promise((exit) => {
    let b = null, state = { selected: 0, open: false, scope }, note = null, reading = false, busy = false, again = false, keep = true, ended = false, restored = false, timer = null;
    // Raw mode off first, then the screen back: a terminal left raw is the worst way to leave.
    const restore = () => {
      if (restored) return; restored = true;
      try { input.setRawMode?.(false); } catch {}
      try { write("\x1b[?25h\x1b[?1049l"); } catch {}
    };
    const finish = (code, why) => {
      if (ended) return; ended = true;
      clearInterval(timer); input.removeListener("keypress", onKey); output.removeListener?.("resize", onResize);
      for (const sig of SIGNALS) process.removeListener(sig, onSignal);
      process.removeListener("exit", restore);
      restore(); try { input.pause?.(); } catch {}
      if (why) try { errors.write(`routr: top stopped: ${why}\n`); } catch {}
      exit(code);
    };
    // Every way in (a key, the timer, a resize, a usage read ending) goes through this: a failure ends top with the
    // terminal restored, never left raw on the alternate screen.
    const guard = (fn) => (...args) => {
      if (ended) return;
      try { const r = fn(...args); if (r && typeof r.catch === "function") r.catch(() => finish(1, "the screen could not be drawn")); } catch { finish(1, "the screen could not be drawn"); }
    };
    const draw = () => {
      if (ended) return;
      const lines = renderTop(b, { width: output.columns || 80, height: output.rows || 24, g, c, now: now(), ...state, project, note: reading ? "reading usage…" : note });
      write(`\x1b[?2026h\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\r\n")}\x1b[J\x1b[?2026l`);
    };
    const refresh = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        do {
          again = false;
          const next = await read();
          if (ended) return;
          // The pick is the decision picked now, on the board shown now: a new launch at the top must not move it.
          const pick = keep ? decisionKey(b?.decisions?.[state.selected]) : null;
          keep = true;
          if (next) { b = next; if (note === "could not read the board") note = null; } else note = "could not read the board";
          state = reselect(state, b?.decisions ?? [], pick);
        } while (again && !ended);
      } finally { busy = false; }
      draw();
    };
    const onRefresh = guard(refresh), onResize = guard(draw), onSignal = () => finish(0);
    const onKey = guard((str, k = {}) => {
      const [next, act] = topKey(state, str, k, { count: b?.decisions?.length ?? 0, scopes: Boolean(project) });
      state = next;
      if (act === "quit") return finish(0);
      if (act === "scope") { scope = state.scope; keep = false; draw(); return refresh(); }
      if (act === "usage" && !reading) {
        note = null;
        reading = spawn(usageArgs, { onExit: guard(() => { reading = false; note = `usage read ${clock(now())}`; return refresh(); }) });
        if (!reading) note = "could not start a usage read";
      }
      draw();
    });
    process.once("exit", restore);
    for (const sig of SIGNALS) process.on(sig, onSignal);
    guard(() => {
      write("\x1b[?1049h\x1b[?25l");
      emitKeypressEvents(input);
      input.setRawMode?.(true); input.resume?.(); input.on("keypress", onKey);
      output.on?.("resize", onResize);
      draw();
      timer = setInterval(onRefresh, every);
      return refresh();
    })();
  });
}
