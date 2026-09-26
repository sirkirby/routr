// The prompts `routr setup` asks with: node built-ins only (readline keypress events, raw mode, ANSI escapes).
// The look and the keys follow @clack/prompts (a │ gutter, ◆ on the question being answered, ◇ once answered, each
// answer collapsed to one dim line) and Charm's huh (an accessible mode of numbered questions for screen readers).
// Research notes: routr-lab, 2026-09-26. Every prompt returns its value, BACK (Esc: one step back), or CANCEL (Ctrl+C).
// Drawn on stderr, so stdout stays free for --json; the terminal is always restored (cursor shown, raw mode off).
import { emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters } from "node:util";

export const BACK = Symbol("back"), CANCEL = Symbol("cancel");

// Unicode where the terminal draws it (is-unicode-supported's rules), ASCII in the old Windows console and TERM=linux.
export function unicodeOk(env = process.env, platform = process.platform) {
  if (platform !== "win32") return env.TERM !== "linux";
  return Boolean(env.WT_SESSION || env.TERMINUS_SUBLIME || env.ConEmuTask === "{cmd::Cmder}" || env.TERM_PROGRAM === "Terminus-Sublime"
    || env.TERM_PROGRAM === "vscode" || env.TERM === "xterm-256color" || env.TERM === "alacritty" || env.TERMINAL_EMULATOR === "JetBrains-JediTerm");
}
// Colour only for a terminal, never under NO_COLOR (https://no-color.org) or TERM=dumb; FORCE_COLOR wins.
export function colourOk(stream, env = process.env) {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return Boolean(stream?.isTTY) && !env.NO_COLOR && env.TERM !== "dumb";
}
// Accessible mode: numbered questions, one line at a time, no redrawing (huh's ACCESSIBLE; TERM=dumb has no cursor).
export const accessibleOk = (env = process.env) => (env.ACCESSIBLE && !/^(0|false)$/i.test(env.ACCESSIBLE)) || env.TERM === "dumb";

const GLYPHS = {
  unicode: { bar: "│", start: "┌", end: "└", active: "◆", done: "◇", error: "▲", cancel: "■", on: "●", off: "○", checked: "◼", unchecked: "◻", more: "…", arrow: "→", spin: ["◒", "◐", "◓", "◑"] },
  ascii: { bar: "|", start: "T", end: "-", active: "*", done: "o", error: "x", cancel: "x", on: ">", off: " ", checked: "[+]", unchecked: "[ ]", more: "...", arrow: "->", spin: ["-", "\\", "|", "/"] },
};
const SGR = { cyan: 36, green: 32, yellow: 33, red: 31, gray: 90, dim: 2, bold: 1, strike: 9 };

// The number of screen rows a frame takes at this width (wide characters are counted as one column: a known limit).
const rows = (text, width) => text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(stripVTControlCharacters(line).length / Math.max(1, width))), 0);

// `input` and `output` are streams (a test passes fakes: an EventEmitter with setRawMode, and a writer).
// `ask(question)` reads one line: accessible mode's only way in.
export function createUI({ input = process.stdin, output = process.stderr, env = process.env, platform = process.platform, accessible = accessibleOk(env), ask } = {}) {
  const g = GLYPHS[unicodeOk(env, platform) ? "unicode" : "ascii"];
  const colour = colourOk(output, env);
  const c = Object.fromEntries(Object.entries(SGR).map(([k, n]) => [k, (s) => (colour ? `\x1b[${n}m${s}\x1b[${n === 1 || n === 2 ? 22 : n === 9 ? 29 : 39}m` : String(s))]));
  const write = (s) => output.write(s);
  const width = () => output.columns || 80, height = () => output.rows || 24;
  let rawOn = false, shown = 0;
  const restore = () => { if (!accessible) write("\x1b[?25h"); if (rawOn) { try { input.setRawMode(false); } catch {} rawOn = false; } };
  process.once?.("exit", restore);
  if (!accessible && typeof input.read === "function") emitKeypressEvents(input);

  // Redraw in place: back to the start of what was drawn, erase below, write the new frame in one write.
  const draw = (lines) => {
    const frame = lines.join("\n");
    const up = shown > 1 ? `\x1b[${shown - 1}A` : "";
    write(`\x1b[?2026h${shown ? `\r${up}\x1b[J` : "\x1b[?25l"}${frame}\x1b[?2026l`);
    shown = rows(frame, width());
  };
  const settle = (lines) => { draw(lines); write("\n"); shown = 0; };

  // One prompt: `view(state, error)` gives its lines, `key(state, str, k)` gives the next state, or { submit }, BACK, CANCEL.
  const run = ({ message, view, key, init, answer }) => new Promise((resolve) => {
    let state = init, error = null;
    const frame = (mark) => [c.gray(g.bar), `${mark}  ${message}`, ...view(state, error).map((l) => `${c.cyan(g.bar)}  ${l}`), error ? c.yellow(`${g.end}  ${error}`) : c.cyan(g.end)];
    const onKey = (str, k = {}) => {
      if (k.ctrl && k.name === "c") return finish(CANCEL);
      if (k.name === "escape") return finish(BACK);
      const next = key(state, str, k);
      if (next && typeof next === "object" && "error" in next) { error = next.error; return draw(frame(c.yellow(g.error))); }
      error = null;
      if (next && typeof next === "object" && "submit" in next) return finish(next.submit);
      state = next ?? state;
      draw(frame(c.cyan(g.active)));
    };
    const finish = (value) => {
      input.removeListener("keypress", onKey);
      const said = value === CANCEL ? c.strike(c.dim("cancelled")) : value === BACK ? c.dim("back") : c.dim(answer(value));
      settle([c.gray(g.bar), `${value === CANCEL ? c.red(g.cancel) : c.green(g.done)}  ${message}`, `${c.gray(g.bar)}  ${said}`]);
      resolve(value);
    };
    if (!rawOn) { try { input.setRawMode?.(true); rawOn = true; } catch {} input.resume?.(); }
    input.on("keypress", onKey);
    draw(frame(c.cyan(g.active)));
  });

  const help = (s) => c.dim(s);
  const plain = async (question) => (await ask(question)).trim();
  const listed = (opts, current) => opts.map((o, i) => `  ${String(i + 1).padStart(2)}. ${o.label}${o.hint ? ` (${o.hint})` : ""}${o.value === current ? " [current]" : ""}`).join("\n");

  const ui = {
    glyphs: g, style: c, accessible,
    intro: (title) => write(`${c.gray(g.start)}  ${c.bold(title)}\n`),
    outro: (text) => write(`${c.gray(g.bar)}\n${c.gray(g.end)}  ${text}\n`),
    cancel: (text) => write(`${c.gray(g.bar)}\n${c.red(g.end)}  ${text}\n`),
    // A boxed block of lines under a title, for the settings summary and the review.
    note: (title, lines) => write(`${c.gray(g.bar)}\n${c.green(g.done)}  ${title}\n${lines.map((l) => `${c.gray(g.bar)}  ${l}`).join("\n")}\n`),
    line: (text) => write(`${c.gray(g.bar)}  ${text}\n`),
    // A step that takes a while; `stop(summary)` replaces it with its result.
    spinner: (message) => {
      if (accessible) { write(`${message}\n`); return { stop: (summary) => { if (summary) write(`${summary}\n`); } }; }
      let i = 0; write("\x1b[?25l");
      const tick = () => write(`\r\x1b[2K${c.cyan(g.spin[i++ % g.spin.length])}  ${message}`);
      tick(); const timer = setInterval(tick, 80); timer.unref?.();
      return { stop: (summary) => { clearInterval(timer); write(`\r\x1b[2K${c.green(g.done)}  ${summary ?? message}\n`); } };
    },

    // One of `options` ({ value, label, hint }). ↑/↓ (or j/k) move, a number jumps, Enter chooses.
    select: async ({ message, options, initial }) => {
      if (accessible) {
        for (;;) {
          const cur = options.findIndex((o) => o.value === initial);
          const a = await plain(`${message}\n${listed(options, initial)}\nNumber${cur >= 0 ? ` [Enter = ${cur + 1}]` : ""} (b = back): `);
          if (!a && cur >= 0) return options[cur].value;
          if (/^b(ack)?$/i.test(a)) return BACK;
          if (/^\d+$/.test(a) && options[Number(a) - 1]) return options[Number(a) - 1].value;
        }
      }
      return run({ message, init: Math.max(0, options.findIndex((o) => o.value === initial)),
        view: (i) => [...options.map((o, j) => (j === i ? `${c.green(g.on)} ${o.label}${o.hint ? ` ${c.dim(`(${o.hint})`)}` : ""}` : c.dim(`${g.off} ${o.label}`))), help("↑/↓ move · enter choose · esc back")],
        key: (i, s, k) => (k.name === "up" || s === "k" ? (i - 1 + options.length) % options.length
          : k.name === "down" || s === "j" ? (i + 1) % options.length
          : /^[1-9]$/.test(s ?? "") && options[Number(s) - 1] ? Number(s) - 1
          : k.name === "return" ? { submit: options[i].value } : i),
        answer: (v) => options.find((o) => o.value === v)?.label ?? String(v) });
    },

    // Any of `options`. Space toggles, `a` toggles all, Enter confirms; `min` is how many must be chosen.
    multiselect: async ({ message, options, initial = [], min = 0 }) => {
      const need = `choose at least ${min}`;
      if (accessible) {
        const chosen = new Set(initial);
        for (;;) {
          const a = await plain(`${message}\n${options.map((o, i) => `  ${String(i + 1).padStart(2)}. [${chosen.has(o.value) ? "x" : " "}] ${o.label}${o.hint ? ` (${o.hint})` : ""}`).join("\n")}\nNumbers to switch on or off, Enter when done (b = back): `);
          if (/^b(ack)?$/i.test(a)) return BACK;
          if (!a) { if (chosen.size >= min) return options.filter((o) => chosen.has(o.value)).map((o) => o.value); continue; }
          for (const n of a.split(/[\s,]+/)) { const o = options[Number(n) - 1]; if (o) chosen.has(o.value) ? chosen.delete(o.value) : chosen.add(o.value); }
        }
      }
      return run({ message, init: { i: 0, on: new Set(initial) },
        view: ({ i, on }) => [...options.map((o, j) => `${on.has(o.value) ? c.green(g.checked) : c.dim(g.unchecked)} ${j === i ? o.label : c.dim(o.label)}${j === i && o.hint ? ` ${c.dim(`(${o.hint})`)}` : ""}`), help("↑/↓ move · space choose · a all · enter confirm · esc back")],
        key: ({ i, on }, s, k) => {
          if (k.name === "up" || s === "k") return { i: (i - 1 + options.length) % options.length, on };
          if (k.name === "down" || s === "j") return { i: (i + 1) % options.length, on };
          if (k.name === "space") { const n = new Set(on); n.has(options[i].value) ? n.delete(options[i].value) : n.add(options[i].value); return { i, on: n }; }
          if (s === "a") return { i, on: on.size === options.length ? new Set() : new Set(options.map((o) => o.value)) };
          if (k.name === "return") return on.size >= min ? { submit: options.filter((o) => on.has(o.value)).map((o) => o.value) } : { error: need };
          return { i, on };
        },
        answer: (vs) => (vs.length ? options.filter((o) => vs.includes(o.value)).map((o) => o.label).join(", ") : "none") });
    },

    // One of a long list: typing filters it (every word must appear), ↑/↓ move within what matches, Enter chooses.
    search: async ({ message, options, initial, pinned = [] }) => {
      const all = [...pinned, ...options];
      const match = (q) => { const words = q.toLowerCase().split(/\s+/).filter(Boolean); return all.filter((o) => words.every((w) => `${o.label} ${o.value}`.toLowerCase().includes(w))); };
      if (accessible) {
        let shown = all.length <= 20 ? all : [];
        for (;;) {
          const cur = initial != null ? ` [Enter = ${all.find((o) => o.value === initial)?.label ?? initial}]` : "";
          const a = await plain(`${message}${shown.length ? `\n${listed(shown, initial)}` : ` (${all.length} to choose from)`}\n${shown.length ? "Number, or" : ""} text to search${cur} (b = back): `);
          if (!a && initial != null) return initial;
          if (/^b(ack)?$/i.test(a)) return BACK;
          if (/^\d+$/.test(a) && shown[Number(a) - 1]) return shown[Number(a) - 1].value;
          const hits = match(a);
          if (hits.length === 1) return hits[0].value;
          shown = hits.slice(0, 40);
        }
      }
      const size = () => Math.max(5, Math.min(10, height() - 8));
      return run({ message, init: { q: "", i: Math.max(0, all.findIndex((o) => o.value === initial)) },
        view: ({ q, i }) => {
          const hits = match(q), n = size(), top = Math.min(Math.max(0, i - Math.floor(n / 2)), Math.max(0, hits.length - n));
          const lines = [`${c.dim("search:")} ${q}${c.dim(q ? ` (${hits.length} match${hits.length === 1 ? "" : "es"})` : ` (${all.length}, type to filter)`)}`];
          if (!hits.length) lines.push(c.yellow("nothing matches"));
          if (top > 0) lines.push(c.dim(g.more));
          hits.slice(top, top + n).forEach((o, j) => lines.push(top + j === i ? `${c.green(g.on)} ${o.label}${o.hint ? ` ${c.dim(`(${o.hint})`)}` : ""}` : c.dim(`${g.off} ${o.label}`)));
          if (top + n < hits.length) lines.push(c.dim(g.more));
          return [...lines, help("type to filter · ↑/↓ move · enter choose · esc back")];
        },
        key: ({ q, i }, s, k) => {
          const hits = match(q);
          if (k.name === "up") return { q, i: Math.max(0, i - 1) };
          if (k.name === "down") return { q, i: Math.min(Math.max(0, hits.length - 1), i + 1) };
          if (k.name === "return") return hits[i] ? { submit: hits[i].value } : { error: "nothing matches: change the search" };
          if (k.name === "backspace") return { q: q.slice(0, -1), i: 0 };
          if (s && !k.ctrl && !k.meta && s.length === 1 && s >= " ") return { q: q + s, i: 0 };
          return { q, i };
        },
        answer: (v) => all.find((o) => o.value === v)?.label ?? String(v) });
    },

    // Yes or no. y/n answer at once, ←/→ switch, Enter confirms.
    confirm: async ({ message, initial = true }) => {
      if (accessible) {
        for (;;) {
          const a = await plain(`${message} ${initial ? "[Y/n]" : "[y/N]"} (b = back): `);
          if (!a) return initial;
          if (/^b(ack)?$/i.test(a)) return BACK;
          if (/^y/i.test(a)) return true;
          if (/^n/i.test(a)) return false;
        }
      }
      return run({ message, init: initial,
        view: (v) => [`${v ? `${c.green(g.on)} Yes` : c.dim(`${g.off} Yes`)} ${c.dim("/")} ${!v ? `${c.green(g.on)} No` : c.dim(`${g.off} No`)}`, help("y/n · ←/→ switch · enter confirm · esc back")],
        key: (v, s, k) => (s === "y" || s === "Y" ? { submit: true } : s === "n" || s === "N" ? { submit: false }
          : k.name === "left" || k.name === "right" ? !v : k.name === "return" ? { submit: v } : v),
        answer: (v) => (v ? "Yes" : "No") });
    },

    // A line of text; `parse(text)` gives the value, or throws with what is wrong (shown in yellow until the next key).
    text: async ({ message, initial = "", placeholder = "", parse = (t) => t }) => {
      if (accessible) {
        for (;;) {
          const a = await plain(`${message}${initial ? ` [Enter = ${initial}]` : ""} (b = back): `);
          if (/^b(ack)?$/i.test(a)) return BACK;
          try { return parse(a || initial); } catch (e) { write(`  ${e.message}\n`); }
        }
      }
      return run({ message, init: initial,
        view: (t) => [t ? `${t}${c.cyan("▏")}` : c.dim(placeholder || " "), help("enter confirm · esc back")],
        key: (t, s, k) => {
          if (k.name === "return") { try { return { submit: parse(t) }; } catch (e) { return { error: e.message }; } }
          if (k.name === "backspace") return t.slice(0, -1);
          if (s && !k.ctrl && !k.meta && s.length === 1 && s >= " ") return t + s;
          return t;
        },
        answer: (v) => String(v) });
    },

    close: () => { restore(); input.pause?.(); process.removeListener?.("exit", restore); },
  };
  return ui;
}
