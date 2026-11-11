// Reading a command line against the command table: which entry it reaches (the dispatcher and its trace both ask
// route, so a span is recorded only for a command that runs), the global flags it carries, a guarded flag a global took
// as its value, the flags of the commands that read a folder, and a brief. node: built-ins and wording only: every
// command but statusline loads this module, and board, top and dash read their flags with it.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { list } from "./wording.mjs";

// A table entry by its own name only: an inherited key ("constructor", "__proto__") is no command.
export const commandNamed = (table, name) => (typeof name === "string" && Object.hasOwn(table, name) ? table[name] : null);
const asksHelp = (words) => words.includes("--help") || words.includes("-h");

// The global flags, wherever they stand on the line: the first `--config <path>`, then every `--headroom <value>`, even
// an empty one, so none can end up in a brief. A missing value takes the next word, whatever it is (guarded flags below).
export function takeGlobals(line) {
  const words = [...line];
  const take = (name) => { const i = words.indexOf(name); return i >= 0 ? words.splice(i, 2)[1] : undefined; };
  const configPath = take("--config"), headroom = [];
  while (words.includes("--headroom")) headroom.push(take("--headroom"));
  return { words, configPath, headroom };
}

// Where a command line goes: { to: "help", entry } (null: the top-level help), { to: "version" }, { to: "unknown" },
// or { to: "run", entry } with `args` (reached first: its words as typed) or `line` (reached after the globals).
export function route(argv, table) {
  const first = commandNamed(table, argv[0]);
  if (["help", "--help", "-h"].includes(argv[0])) return { to: "help", entry: commandNamed(table, argv[1]) };
  // A brief may itself say "--help": a command that reads one hears help only in the word right after it.
  if (first && asksHelp(first.reach === "brief" ? argv.slice(1, 2) : argv.slice(1))) return { to: "help", entry: first };
  // An exception, by name: a line that starts with launch is launch's, even with --version on it (a task may say it).
  if (first === table.launch) return { to: "run", entry: first, args: argv.slice(1) };
  if (argv.includes("--version")) return { to: "version" };
  // An exception, by name: `doctor --fix` is setup, given doctor's words as typed (setup passes over --fix). Only as
  // the line's first word, as it always was: `routr --config x doctor --fix` is doctor.
  if (first === table.doctor && argv.includes("--fix")) return { to: "run", entry: table.setup, args: argv.slice(1) };
  if (first?.reach === "first" && (first.word == null || argv[1] === first.word)) return { to: "run", entry: first, args: argv.slice(first.word == null ? 1 : 2) };
  const line = takeGlobals(argv), entry = commandNamed(table, line.words[0]);
  return entry && ["globals", "brief"].includes(entry.reach) ? { to: "run", entry, line } : { to: "unknown" };
}

// A guarded flag a global took as its value (`--headroom --launch <id>`, the global's value missing) is refused, never
// read as absent: its count on the line as typed differs from its count once the globals are off. A "joined" guard
// counts `--flag=<value>` too. The refusal names the entry's guarded flags in table order; null when none was taken.
export function guardRefusal(entry, typed, words) {
  const guarded = (entry.flags ?? []).filter((f) => f.guard);
  const count = (ws, f) => ws.filter((w) => w === f.name || (f.guard === "joined" && w.startsWith(`${f.name}=`))).length;
  if (guarded.every((f) => count(typed, f) === count(words, f))) return null;
  const tail = entry.refusal?.tail ? `; ${entry.refusal.tail}` : "";
  return `${entry.name}: ${list(guarded.map((f) => f.name), "or")} cannot be a value for --config or --headroom${tail}`;
}

// The flags of a command that reads a folder (board, top, dash), each kind "folder" (an existing one), "file" (not a
// folder) or "switch", each given once. Anything else is refused with the command's synopsis; `ignored` words are
// passed over. Answers each flag by its name in camelCase (--no-open: noOpen), a path resolved.
export function readFlags(command, words, kinds, { ignored = [] } = {}) {
  const o = {}, rest = [...words], key = (flag) => flag.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase());
  const synopsis = `routr ${command} ${Object.entries(kinds).map(([f, kind]) => (kind === "switch" ? `[${f}]` : `[${f} <${kind}>]`)).join(" ")}`;
  while (rest.length) {
    const w = rest.shift();
    if (ignored.includes(w)) continue;
    if (!Object.hasOwn(kinds, w)) throw new Error(`${command}: unknown ${w.startsWith("-") ? "flag" : "argument"} ${w}; ${synopsis}`);
    if (o[key(w)] != null) throw new Error(`${command}: ${w} was given more than once`);
    if (kinds[w] === "switch") { o[key(w)] = true; continue; }
    const v = rest.shift();
    if (!v || v.startsWith("--")) throw new Error(`${command}: ${w} takes a ${kinds[w]}`);
    let dir = false; try { dir = statSync(resolve(v)).isDirectory(); } catch {}
    if (kinds[w] === "folder" && !dir) throw new Error(`${command}: ${w} ${v} is not a folder`);
    if (kinds[w] === "file" && dir) throw new Error(`${command}: ${w} ${v} is a folder`);
    o[key(w)] = resolve(v);
  }
  return o;
}

// The brief a command that reads one (subagent, dispatch) advises on, and its answer: the advice, or a refusal that says
// how to supply the exact task. `ctx` is the dispatcher's: the words after the command, the input notes so far.
export async function adviseOnBrief({ mode, args: rest, loaded, notes: inputNotes, given, lead, configPath }) {
  const { warning } = await import("./warnings.mjs"), { doNext } = await import("./next.mjs"), commands = await import("./commands.mjs");
  const briefRefusal = (error) => ({ ok: false, headline: `routr: no advice: ${error}`, unavailable: [], warnings: [...loaded().notes, ...inputNotes],
    next: [doNext("Supply the exact task: quote an inline brief, pipe it on stdin, or use this file form.", `routr ${mode} --task-file <path>`)], error });

  // File input is explicit: a missing value is refused rather than accidentally reading stdin or advising on a flag.
  if (rest.includes("--task-file")) {
    const at = rest.indexOf("--task-file");
    try {
      if (rest.length !== 2 || at !== 0) throw new Error("--task-file takes one path; quote the whole inline brief if it contains --task-file, or use --task-file <path>");
      const brief = (await import("./advice-file.mjs")).readTask(rest[1]).trim();
      if (!brief) throw new Error("--task-file: the task must not be empty");
      return await commands.adviseCommand(mode, brief, loaded(), given, { lead, warnings: inputNotes, otel: { configPath } });
    } catch (e) { return briefRefusal(e.message); }
  }

  // A word that looks like a flag these commands do not take (--json) is never quietly advised on. Given alone with a
  // brief on stdin, it is set aside and stdin is the brief (found 2026-09-26: `routr subagent --json < brief.txt` gave
  // advice about the text "--json"). Without a real stdin brief, a flag-led invocation is refused: a misspelled
  // --task-file and its path must not get a reading. Quote a flag-led multi-word brief to make that intent explicit.
  const flagLike = rest.filter((w) => /^--?[a-z][\w-]*$/i.test(w));
  let piped = "";
  if (!process.stdin.isTTY && (!rest.length || flagLike.length === rest.length)) { try { piped = (await import("node:fs")).readFileSync(0, "utf8").trim(); } catch {} }
  const setAside = flagLike.length && flagLike.length === rest.length && piped;
  const unknownFlag = !/\s/.test(rest[0] ?? "") && rest[0]?.match(/^--?[a-z][\w-]*/i)?.[0];
  if (unknownFlag && !setAside) return briefRefusal(`Unknown ${mode} flag: ${unknownFlag}. Quote an inline brief or use routr ${mode} --task-file <path>.`);
  if (flagLike.length) inputNotes.push(warning("brief_flag", setAside
    ? `${flagLike.join(" ")}: not ${flagLike.length > 1 ? "flags" : "a flag"} routr ${mode} takes, so ignored; the brief was read from stdin`
    : `${flagLike.join(" ")} looks like ${flagLike.length > 1 ? "flags" : "a flag"} routr ${mode} does not take; read as part of the brief`));
  const brief = rest.length && !setAside ? rest.join(" ").trim() : piped;
  if (!brief) return briefRefusal("empty brief");
  return await commands.adviseCommand(mode, brief, loaded(), given, { lead, warnings: inputNotes, otel: { configPath } });
}
