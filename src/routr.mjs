#!/usr/bin/env bun
// routr: quick, calibrated advice for an agent that is about to hand out work. The commands, their flags, and every
// help text are in one table, src/lib/help.mjs: `routr --help` prints it.
// Jev (TypeSafe System One) judges the WORK in ~300 ms; routr adds usage and ranks by arithmetic (docs/ranking.md);
// the agent that asked makes the decision. Never names a model.
// Advice writes nothing of the user's and fails open; launch reports failures as JSON and exits nonzero.
// Each command's code is loaded only when that command runs: `statusline` runs on every Claude Code turn.
const argv = process.argv.slice(2);
const asksHelp = (args) => args.includes("--help") || args.includes("-h");
if (argv[0] === "statusline" && !asksHelp(argv)) { (await import("./lib/statusline.mjs")).statusline(); process.exit(0); }

const { COMMANDS, formatCommandHelp, formatTopLevelHelp, formatUnknownUsage } = await import("./lib/help.mjs");
// `routr help <command>`, `routr --help <command>` and `routr -h <command>` all show that command's help.
const isCommand = (name) => typeof name === "string" && Object.hasOwn(COMMANDS, name); // never an inherited key ("constructor")
if (["help", "--help", "-h"].includes(argv[0]) && !isCommand(argv[1])) {
  console.log(formatTopLevelHelp());
  process.exit(0);
}
if (["help", "--help", "-h"].includes(argv[0]) && isCommand(argv[1])) {
  console.log(formatCommandHelp(COMMANDS[argv[1]]));
  process.exit(0);
}
// `subagent` and `dispatch` take a brief, which may itself say "--help": only the word right after the command counts.
if (COMMANDS[argv[0]] && (["subagent", "dispatch"].includes(argv[0]) ? asksHelp(argv.slice(1, 2)) : asksHelp(argv.slice(1)))) {
  console.log(formatCommandHelp(COMMANDS[argv[0]]));
  process.exit(0);
}

const print = (r, indent) => console.log(JSON.stringify(r, null, indent));
const failed = (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 160) });
const { loadConfig } = await import("./lib/config.mjs");

// The commands that act, each given its own arguments as typed. Each returns the exit code.
const ACT = {
  launch: async (args) => { const r = await (await import("./lib/launch.mjs")).launch(args); print(r); return r.ok ? 0 : 1; },
  update: async (args) => {
    const u = await import("./lib/update.mjs");
    if (args.includes("--background")) { await u.backgroundUpdate(); return 0; }
    const r = await u.update({ checkOnly: args.includes("--check"), force: args.includes("--force") }); print(r); return r.ok ? 0 : 1;
  },
  key: async (args) => { const r = await (await import("./lib/key.mjs")).setKey({ verify: !args.includes("--no-verify") }); print(r); return r.ok ? 0 : 1; },
  uninstall: async (args) => {
    const r = await (await import("./lib/uninstall.mjs")).uninstall(args);
    if (args.includes("--json")) print(r, 1); else if (r.error) console.error(r.error); else if (r.dry_run) print(r, 1); else if (r.note) console.log(r.note);
    return r.ok ? 0 : 1;
  },
  // A person who stops the guided setup (Ctrl+C) has already been told nothing was written; 130 is the usual exit for it.
  // `--show` is JSON whatever else is passed: it is what an agent reads before it changes a setting.
  setup: async (args) => { const r = await (await import("./lib/setup.mjs")).setup(args); if (args.includes("--json") || args.includes("--show")) print(r, 1); else if (!r.ok && !r.cancelled) console.error(r.error); return r.ok ? 0 : r.cancelled ? 130 : 1; },
  telemetry: async (args) => {
    const { sendRows, telemetryCommand, telemetryStatus } = await import("./lib/telemetry.mjs");
    const ci = args.indexOf("--config"), cfg = ci >= 0 ? args[ci + 1] : undefined;
    const words = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--config"); // flags in any order
    const { config } = loadConfig(cfg);
    const st = telemetryStatus(config);
    const r = words[0] !== "send" ? telemetryCommand(words, config, cfg)
      : !st.on ? { ok: false, error: `telemetry is off (${st.why_off}): nothing was sent` }
      : await sendRows({ all: args.includes("--all") }).catch(failed);
    print(r, 1); return r.ok ? 0 : 1;
  },
  // The text is an argument, never read from stdin: a pipe left open would hang.
  feedback: async (args) => { const r = await (await import("./lib/telemetry.mjs")).sendFeedback(args.join(" ")); print(r); return r.ok ? 0 : 1; },
  skill: async (args) => { print((await import("./lib/skill-install.mjs")).installSkill({ dryRun: args.includes("--dry-run") }), 1); return 0; },
};
// Which of those a command line reaches (launch and update are dispatched first, below): `key set` and `skill install`
// only with their word, and `doctor --fix` is setup.
const WITH_WORD = { key: "set", skill: "install" };
const acting = (a) => (Object.hasOwn(WITH_WORD, a[0]) ? a[1] === WITH_WORD[a[0]] : a[0] === "doctor" ? a.includes("--fix") : Object.hasOwn(ACT, a[0]));

if (argv[0] === "launch") process.exit(await ACT.launch(argv.slice(1)));
if (argv.includes("--version")) { console.log((await import("./lib/version.mjs")).ROUTR_VERSION); process.exit(0); }
if (argv[0] === "update") process.exit(await ACT.update(argv.slice(1)));
if (acting(argv)) process.exit(await ACT[argv[0] === "doctor" ? "setup" : argv[0]](argv.slice(Object.hasOwn(WITH_WORD, argv[0]) ? 2 : 1)));

// The advice and file commands. `--config` and `--headroom` may stand anywhere on the line, as they always could.
// `take` removes the first `name <value>` from `argv` and returns the value; `takeAll` every one.
const take = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const takeAll = (name) => { const r = []; while (argv.includes(name)) r.push(take(name)); return r; };
const configPath = take("--config");
// --headroom cursor=0.97 : usage the caller read itself (repeatable); it overrides any reading
// Every --headroom is taken off the line, even an empty one, so none can end up in the brief. A share (0.97) or a
// percent (97%) is read; anything else is said in the answer, never dropped without a word.
const { given, notes: inputNotes } = (await import("./lib/commands.mjs")).parseHeadroom(takeAll("--headroom"));
const withNotes = (r) => (inputNotes.length && r && typeof r === "object" ? { ...r, input_notes: inputNotes } : r);
const [mode, ...rest] = argv;
const loaded = () => loadConfig(configPath);
// At most once a day this starts a detached background updater; it never delays or changes the command itself.
if (["subagent", "dispatch", "check", "record", "assess", "share", "doctor", "usage"].includes(mode)) (await import("./lib/update.mjs")).maybeAutoUpdate(loaded().config);

const commands = () => import("./lib/commands.mjs");
const ADVISE = {
  check: async () => print(await (await commands()).checkCommand({ brief: take("--brief"), report: take("--report") })),
  assess: async () => console.log((await commands()).assessCommand({ ledger: take("--ledger") }, loaded().config)),
  share: async () => console.log((await commands()).shareCommand({ ledger: take("--ledger"), out: take("--out") }, loaded().config)),
  // usage: routr dispatch "<brief>" > advice.json ... then: routr record --advice advice.json --subscription codex --model <m> --effort low [--level basic] --verdict done --check pass [--seconds 24] [--note "..."]
  record: async () => {
    const o = Object.fromEntries(["advice", "subscription", "model", "effort", "level", "verdict", "check", "seconds", "attempts", "note", "ledger", "report", "project"].map((f) => [f, take(`--${f}`)]));
    print((await commands()).recordCommand(o, takeAll("--subagent"), loaded().config)); // never blocks the agent; the config resolves a "default" effort
  },
  usage: async () => print(withNotes(await (await commands()).usageCommand(rest, loaded().config, given)), 1), // never blocks an agent
  doctor: async () => (await import("./lib/doctor.mjs")).doctor({ json: rest.includes("--json"), configPath }),
};
if (ADVISE[mode]) { await ADVISE[mode](); process.exit(0); }
if (mode !== "subagent" && mode !== "dispatch") { console.error(formatUnknownUsage()); process.exit(2); }

// A word that looks like a flag these commands do not take (--json) is never quietly advised on. Given alone with a
// brief on stdin, it is set aside and stdin is the brief (found 2026-09-26: `routr subagent --json < brief.txt` gave
// advice about the text "--json"). Otherwise it is the brief, or part of it (-Werror can be one), and the answer says so.
const flagLike = rest.filter((w) => /^--?[a-z][\w-]*$/i.test(w));
let piped = "";
if (!process.stdin.isTTY && (!rest.length || flagLike.length === rest.length)) { try { piped = (await import("node:fs")).readFileSync(0, "utf8").trim(); } catch {} }
const setAside = flagLike.length && flagLike.length === rest.length && piped;
if (flagLike.length) inputNotes.push(setAside
  ? `${flagLike.join(" ")}: not ${flagLike.length > 1 ? "flags" : "a flag"} routr ${mode} takes, so ignored; the brief was read from stdin`
  : `${flagLike.join(" ")} looks like ${flagLike.length > 1 ? "flags" : "a flag"} routr ${mode} does not take; read as ${flagLike.length === rest.length ? "the brief" : "part of the brief"}`);
const brief = rest.length && !setAside ? rest.join(" ").trim() : piped;
if (!brief) { console.error("routr: empty brief"); process.exit(2); }
print(withNotes(await (await commands()).adviseCommand(mode, brief, loaded(), given)));
