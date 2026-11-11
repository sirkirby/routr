#!/usr/bin/env bun
// routr: quick, calibrated advice for an agent that is about to hand out work. Every command is one entry of the command
// table (src/lib/command-table.mjs): its flags and help text (`routr --help` prints them), how a line reaches it, how it
// exits, and whether it is traced and keeps routr up to date. This file walks it.
// A System One decision model (TypeSafe's Jev, or Cloudflare's Clef: providers.mjs) judges the WORK in well under a second; routr adds usage and ranks by arithmetic (docs/ranking.md);
// the agent that asked makes the decision. Never names a model.
// Advice writes nothing of the user's and fails open; launch reports failures as JSON and exits nonzero.
// Each command's code is loaded only when that command runs: `statusline` runs on every Claude Code turn, so it and the
// detached OTLP sender are reached before the table loads.
const argv = process.argv.slice(2);
if (argv[0] === "--otel-sender") {
  await (await import("./lib/otel.mjs")).sendOtel({ configPath: argv[1] === "--config" ? argv[2] : undefined });
  process.exit(0);
}
const asksHelp = (args) => args.includes("--help") || args.includes("-h");
if (argv[0] === "statusline" && !asksHelp(argv)) { (await import("./lib/statusline.mjs")).statusline(); process.exit(0); }

const { COMMANDS } = await import("./lib/command-table.mjs");
const { guardRefusal, route } = await import("./lib/command-line.mjs");
// Where this line goes, read once: the command runs there, and its trace is that command's.
const way = route(argv, COMMANDS);
if (way.to === "help") {
  const { formatCommandHelp, formatTopLevelHelp } = await import("./lib/help.mjs");
  console.log(way.entry ? formatCommandHelp(way.entry) : formatTopLevelHelp());
  process.exit(0);
}

let traceOutput = () => {};
const print = (r, indent) => { traceOutput(r); console.log(JSON.stringify(r, null, indent)); };
const failed = (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 160) });
const { loadConfig } = await import("./lib/config.mjs");
// One reading of a config file per run: a command's trace and the command itself see the same settings, read once.
const readings = new Map();
const configAt = (path) => { if (!readings.has(path)) readings.set(path, loadConfig(path)); return readings.get(path); };
const settings = { settings: () => configAt(undefined) }; // the commands reached first read the user's own file
// The commands that name --headroom in their help, for the note of one that does not use it.
const headroomFor = Object.values(COMMANDS).filter((c) => c.flags?.some((f) => f.name === "--headroom")).map((c) => c.name);

// The entry's exit rule, applied to what its run answered.
function exited(entry, out) {
  if (entry.exit === "own") return out; // null: the holder keeps running until its worker is done, then exits by itself
  if (out !== undefined) print(out, entry.indent);
  if (entry.exit === "natural" && out?.ok) return undefined; // ends when the work it started does
  return entry.exit === "ok" ? (out.ok ? 0 : 1) : 0;
}

async function main() {
  const { warning } = await import("./lib/warnings.mjs"), { list } = await import("./lib/wording.mjs");
  if (way.to === "version") { console.log((await import("./lib/version.mjs")).ROUTR_VERSION); return 0; }
  if (way.to === "unknown") { console.error((await import("./lib/help.mjs")).formatUnknownUsage()); return 2; }
  const { entry } = way;
  if (entry.reach === "first") return exited(entry, await entry.run({ args: way.args, settings, print, failed, loadConfig }));

  // Reached after the global flags. --headroom cursor=0.97 : usage the caller read itself (repeatable); it overrides any
  // reading. A share (0.97) or a percent (97%) is read; anything else is said in the answer, never dropped without a word.
  const { words, configPath, headroom } = way.line;
  const { given, notes } = (await import("./lib/commands.mjs")).parseHeadroom(headroom);
  let line = words, lead = null;
  if (entry.reach === "brief") {
    const taken = (await import("./lib/trace-context.mjs")).takeLeadSession(words, { inline: !words.includes("--task-file") });
    ({ args: line, lead } = taken); notes.push(...taken.warnings);
  }
  const args = line.slice(1), loaded = () => configAt(configPath);
  const refused = guardRefusal(entry, argv, args);
  const refuse = async () => {
    if (entry.refusal === "screen") { console.error(`routr: ${refused}`); return 2; } // a screen refuses as unknown usage does
    const { headline, extra, indent } = entry.refusal;
    print({ ...(await import("./lib/output.mjs")).refusal(headline, refused), ...extra }, indent);
    return 0;
  };
  if (refused && entry.refusal.beforeUpdate) return await refuse();
  // At most once a day this starts a detached background updater; it never delays or changes the command itself.
  if (entry.autoUpdate) (await import("./lib/update.mjs")).maybeAutoUpdate(loaded().config);
  if (refused) return await refuse();
  // `take` removes the first `name <value>` from args and returns the value; `takeAll` every one.
  const take = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const takeAll = (name) => { const r = []; while (args.includes(name)) r.push(take(name)); return r; };
  const warnings = (why) => [...notes, ...(Object.keys(given).length ? [warning("headroom_unused", `${why}; --headroom is for ${list(headroomFor, "and")}`)] : [])];
  return exited(entry, await entry.run({ mode: entry.name, args, take, takeAll, configPath, loaded, given, notes, warnings, lead, print }));
}

// Start before argument/file I/O, finish after output. Module commands share this context; early CLI refusals do too.
// Only a command this line runs is traced, never routr's own forms of one.
const value = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
const traced = way.to === "run" && way.entry.trace && !way.entry.trace.untraced?.(argv) ? way.entry.name : null;
let invoke = main;
if (traced) {
  try {
    const tracing = await import("./lib/traces.mjs"), configPath = value("--config"), { takeLeadSession } = await import("./lib/trace-context.mjs"); traceOutput = tracing.traceOutput;
    invoke = () => tracing.commandTrace(traced, () => ({ config: configAt(configPath).config, otel: { configPath },
      lead: takeLeadSession(argv).lead, cwd: value("--cwd"), explicitLevel: argv.includes("--level") }), main);
  } catch {} // Optional tracing must not prevent a command from starting.
}
const code = await invoke();
if (code != null) process.exit(code);
