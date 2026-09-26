// tui.mjs: the prompts setup asks with, driven by key events on a fake terminal.
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "bun:test";
import { accessibleOk, BACK, CANCEL, colourOk, createUI, unicodeOk } from "../src/lib/tui.mjs";

// A terminal routr can draw on and type into: `keys(...)` sends key presses after the prompt is drawn.
function terminal({ env = { TERM: "xterm-256color" }, platform = "darwin", colour = true, columns = 80 } = {}) {
  const input = new EventEmitter();
  const raw = [];
  input.setRawMode = (on) => raw.push(on);
  input.resume = () => {}; input.pause = () => {};
  let out = "";
  const output = { isTTY: colour, columns, rows: 24, write: (s) => { out += s; } };
  const ui = createUI({ input, output, env, platform, accessible: false });
  const press = (...keys) => setTimeout(() => { for (const k of keys) input.emit("keypress", typeof k === "string" && k.length === 1 ? k : undefined, typeof k === "string" ? (k.length === 1 ? { name: k === " " ? "space" : k } : { name: k }) : k); }, 0);
  return { ui, press, raw, output: () => stripVTControlCharacters(out), rawOutput: () => out };
}

test("select: arrows and j/k move, a number jumps, Enter chooses; the answer collapses to one line", async () => {
  const t = terminal();
  const options = [{ value: "basic", label: "basic" }, { value: "standard", label: "standard", hint: "find something out" }, { value: "strong", label: "strong" }];
  t.press("down", "down", "up", "return");
  expect(await t.ui.select({ message: "Hardest work", options, initial: "basic" })).toBe("standard");
  expect(t.output()).toContain("◆  Hardest work");
  expect(t.output()).toContain("◇  Hardest work"); // collapsed once answered
  expect(t.output()).toContain("find something out"); // the hint of the highlighted option
  t.press("3", "return"); // a number moves to that option; Enter still chooses
  expect(await t.ui.select({ message: "Again", options, initial: "basic" })).toBe("strong");
  t.press("j", "return");
  expect(await t.ui.select({ message: "Vim keys", options, initial: "basic" })).toBe("standard");
});

test("Esc goes back one step and Ctrl+C cancels, and closing restores the terminal", async () => {
  const t = terminal();
  const options = [{ value: 1, label: "one" }];
  t.press("escape");
  expect(await t.ui.select({ message: "m", options })).toBe(BACK);
  t.press({ name: "c", ctrl: true });
  expect(await t.ui.select({ message: "m", options })).toBe(CANCEL);
  t.ui.close();
  expect(t.raw).toEqual([true, false]); // raw mode on for the prompts, off at the end
  expect(t.rawOutput().endsWith("\x1b[?25h")).toBe(true); // the cursor shown again
});

test("multiselect: Space toggles, a toggles all, and a required choice says so until one is made", async () => {
  const t = terminal();
  const options = ["claude", "codex", "agy"].map((v) => ({ value: v, label: v }));
  t.press(" ", "down", "down", " ", "return");
  expect(await t.ui.multiselect({ message: "Which?", options })).toEqual(["claude", "agy"]);
  t.press("a", "a", "return", " ", "return");
  expect(await t.ui.multiselect({ message: "Which?", options, min: 1 })).toEqual(["claude"]);
  expect(t.output()).toContain("choose at least 1");
});

test("search: typing filters a long list, Backspace widens it, and nothing matching is said", async () => {
  const t = terminal();
  const options = [...Array.from({ length: 230 }, (_, i) => `vendor-model-${i}`), "cursor-grok-4.6-high", "grok-4.7-high"].map((v) => ({ value: v, label: v }));
  t.press(..."4.7 hig".split(""), "return");
  expect(await t.ui.search({ message: "Model", options })).toBe("grok-4.7-high");
  expect(t.output()).toContain("(1 match)");
  expect(t.output()).toContain("…"); // a window over the long list, never all 232
  t.press(..."zzz".split(""), "return", "backspace", "backspace", "backspace", ..."grok high".split(""), "down", "return");
  expect(await t.ui.search({ message: "Model", options, pinned: [{ value: "", label: "leave it to the lead agent" }] })).toBe("grok-4.7-high");
  expect(t.output()).toContain("nothing matches");
});

test("confirm and text: y/n answer at once, and a bad value is shown in yellow until it is fixed", async () => {
  const t = terminal();
  t.press("y");
  expect(await t.ui.confirm({ message: "Share?", initial: false })).toBe(true);
  const parse = (s) => { const n = Number(s.replace("%", "")); if (!(n >= 0 && n <= 100)) throw new Error("a share from 0% to 100%"); return n / 100; };
  t.press("2", "0", "0", "return", "backspace", "backspace", "5", "return");
  expect(await t.ui.text({ message: "Reserve", parse })).toBe(0.25);
  expect(t.output()).toContain("▲");
  expect(t.output()).toContain("a share from 0% to 100%");
});

test("the look falls back: ASCII where the terminal cannot draw it, no colour when asked, numbered questions for screen readers", () => {
  expect(unicodeOk({}, "win32")).toBe(false); // the old Windows console
  expect(unicodeOk({ WT_SESSION: "1" }, "win32")).toBe(true); // Windows Terminal
  expect(unicodeOk({ TERM: "linux" }, "linux")).toBe(false);
  expect(colourOk({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
  expect(colourOk({ isTTY: false }, {})).toBe(false);
  expect(colourOk({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
  expect(Boolean(accessibleOk({ ACCESSIBLE: "1" }))).toBe(true);
  expect(Boolean(accessibleOk({ ACCESSIBLE: "false" }))).toBe(false);
  expect(Boolean(accessibleOk({ TERM: "dumb" }))).toBe(true);
  const plain = terminal({ env: { NO_COLOR: "1" }, platform: "win32" });
  expect(plain.ui.glyphs.active).toBe("*");
  plain.press("return");
  return plain.ui.select({ message: "m", options: [{ value: 1, label: "one" }] }).then(() => expect(plain.rawOutput()).not.toMatch(/\x1b\[3\dm/));
});

test("accessible mode asks numbered questions line by line, and b goes back", async () => {
  const lines = ["9", "2", "b", "", "n"], asked = [];
  const ui = createUI({ accessible: true, ask: async (q) => { asked.push(q); return lines.shift(); }, output: { write: () => {} } });
  const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
  expect(await ui.select({ message: "Pick", options, initial: "a" })).toBe("b"); // 9 is not an option: asked again
  expect(asked[0]).toContain("  1. A [current]");
  expect(await ui.select({ message: "Pick", options })).toBe(BACK);
  expect(await ui.confirm({ message: "Sure?", initial: true })).toBe(true); // Enter keeps the default
  expect(await ui.confirm({ message: "Sure?", initial: true })).toBe(false);
});

test("long lines wrap inside the gutter, at word boundaries", async () => {
  const { wrap } = await import("../src/lib/tui.mjs");
  expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  expect(wrap("a https://example.com/a/very/long/url b", 10)).toEqual(["a", "https://example.com/a/very/long/url", "b"]);
  const t = terminal({ columns: 30 });
  t.ui.line("routr can share anonymous outcomes with its maintainers once a day");
  const lines = t.output().split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThan(2);
  expect(lines.every((l) => l.startsWith("│  ") && l.length <= 30)).toBe(true);
});
