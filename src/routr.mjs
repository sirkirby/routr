#!/usr/bin/env bun
// routr: quick, calibrated advice for an agent that is about to hand out work. The commands, their flags, and every
// help text are in one table, src/lib/help.mjs: `routr --help` prints it.
// A System One decision model (TypeSafe's Jev, or Cloudflare's Clef: providers.mjs) judges the WORK in well under a second; routr adds usage and ranks by arithmetic (docs/ranking.md);
// the agent that asked makes the decision. Never names a model.
// Advice writes nothing of the user's and fails open; launch reports failures as JSON and exits nonzero.
// Each command's code is loaded only when that command runs: `statusline` runs on every Claude Code turn.
const argv = process.argv.slice(2);
if (argv[0] === "--otel-sender") {
  await (await import("./lib/otel.mjs")).sendOtel({ configPath: argv[1] === "--config" ? argv[2] : undefined });
  process.exit(0);
}
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

let traceOutput = () => {};
const print = (r, indent) => { traceOutput(r); console.log(JSON.stringify(r, null, indent)); };
const failed = (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 160) });
const { loadConfig } = await import("./lib/config.mjs");

async function main() {
const { warning } = await import("./lib/warnings.mjs");
// The commands that act, each given its own arguments as typed. Each returns the exit code.
const ACT = {
  launch: async (args) => { const r = await (await import("./lib/launch.mjs")).launch(args); print(r); return r.ok ? 0 : 1; },
  cleanup: async (args) => { const r = await (await import("./lib/cleanup.mjs")).cleanup(args); print(r); return r.ok ? 0 : 1; },
  update: async (args) => {
    const u = await import("./lib/update.mjs");
    if (args.includes("--background")) { await u.backgroundUpdate(); return 0; }
    // By hand under the daily job's lock too (lockedUpdate): never two swaps at once.
    const r = await u.lockedUpdate({ checkOnly: args.includes("--check"), force: args.includes("--force") }); print(r); return r.ok ? 0 : 1;
  },
  // `routr key set [typesafe|cloudflare]`: the provider named, or the one the config asks.
  key: async (args) => {
    const ci = args.indexOf("--config"), named = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--config" && a !== "set")[0];
    const config = loadConfig(ci >= 0 ? args[ci + 1] : undefined).config;
    const r = await (await import("./lib/key.mjs")).setKey({ provider: named, config, verify: !args.includes("--no-verify") });
    print(r); return r.ok ? 0 : 1;
  },
  uninstall: async (args) => {
    const r = await (await import("./lib/uninstall.mjs")).uninstall(args);
    if (args.includes("--json")) print(r, 1); else if (r.error) console.error(r.error); else if (r.dry_run) print(r, 1); else if (r.note && !r.otel_sender_running) console.log(r.note);
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
  // Headless workers (outside herdr). wait and workers read; send and stop act. `workers --hold` is the holder
  // itself, which launch and send start detached; it prints nothing.
  wait: async (args) => { print(await (await import("./lib/workers.mjs")).waitCommand(args)); return 0; },
  workers: async (args) => {
    if (args[0] === "--hold" && args[1]) { await (await import("./lib/headless.mjs")).hold(args[1]); return null; }
    print(await (await import("./lib/workers.mjs")).workersCommand(args)); return 0;
  },
  send: async (args) => { const r = await (await import("./lib/workers.mjs")).sendCommand(args); print(r); return r.ok ? 0 : 1; },
  stop: async (args) => { const r = await (await import("./lib/workers.mjs")).stopCommand(args); print(r); return r.ok ? 0 : 1; },
  skill: async (args) => { const r = (await import("./lib/skill-install.mjs")).installSkill({ dryRun: args.includes("--dry-run") }); print(r, 1); return r.ok ? 0 : 1; },
};
// Which of those a command line reaches (launch and update are dispatched first, below): `key set` and `skill install`
// only with their word, and `doctor --fix` is setup.
const WITH_WORD = { key: "set", skill: "install" };
const acting = (a) => (Object.hasOwn(WITH_WORD, a[0]) ? a[1] === WITH_WORD[a[0]] : a[0] === "doctor" ? a.includes("--fix") : Object.hasOwn(ACT, a[0]));

if (argv[0] === "launch") return await ACT.launch(argv.slice(1));
if (argv.includes("--version")) { console.log((await import("./lib/version.mjs")).ROUTR_VERSION); return 0; }
if (argv[0] === "update") return await ACT.update(argv.slice(1));
if (acting(argv)) {
  const code = await ACT[argv[0] === "doctor" ? "setup" : argv[0]](argv.slice(Object.hasOwn(WITH_WORD, argv[0]) ? 2 : 1));
  if (code != null) return code; // the holder keeps running until its worker is done, then exits by itself
} else {

// The advice and file commands. `--config` and `--headroom` may stand anywhere on the line, as they always could.
// `take` removes the first `name <value>` from `argv` and returns the value; `takeAll` every one.
// Keep the raw level count: a missing global value can otherwise consume --level before usage sees it, even when
// globals precede the command. Other commands retain their existing value/brief parsing.
const levelFlags = argv.filter((word) => /^--level(?:=|$)/.test(word)).length;
const take = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const takeAll = (name) => { const r = []; while (argv.includes(name)) r.push(take(name)); return r; };
const configPath = take("--config");
// --headroom cursor=0.97 : usage the caller read itself (repeatable); it overrides any reading
// Every --headroom is taken off the line, even an empty one, so none can end up in the brief. A share (0.97) or a
// percent (97%) is read; anything else is said in the answer, never dropped without a word.
const { given, notes: inputNotes } = (await import("./lib/commands.mjs")).parseHeadroom(takeAll("--headroom"));
const withNotes = (r) => (inputNotes.length && r && typeof r === "object" ? { ...r, warnings: [...(r.warnings ?? []), ...inputNotes] } : r);
const leadInput = ["dispatch", "subagent"].includes(argv[0]) ? (await import("./lib/trace-context.mjs")).takeLeadSession(argv, { inline: !argv.includes("--task-file") }) : { args: [...argv], lead: null, warnings: [] };
argv.splice(0, argv.length, ...leadInput.args); inputNotes.push(...leadInput.warnings);
const leadSession = leadInput.lead;
const [mode, ...rest] = argv;
if (mode === "usage" && levelFlags !== rest.filter((word) => /^--level(?:=|$)/.test(word)).length) {
  print({ ...(await import("./lib/output.mjs")).refusal("no usage view", "usage: --level cannot be a value for --config or --headroom; eligibility was not refreshed"), level: "basic" });
  return 0;
}
const loaded = () => loadConfig(configPath);
// At most once a day this starts a detached background updater; it never delays or changes the command itself.
if (["subagent", "dispatch", "check", "record", "assess", "share", "doctor", "usage"].includes(mode)) (await import("./lib/update.mjs")).maybeAutoUpdate(loaded().config);

const commands = () => import("./lib/commands.mjs");
const ADVISE = {
  check: async () => print(withNotes(await (await commands()).checkCommand({ brief: take("--brief"), report: take("--report") }, { config: loaded().config, warnings: loaded().notes, otel: { configPath } }))),
  assess: async () => console.log((await commands()).assessCommand({ ledger: take("--ledger") }, loaded().config)),
  share: async () => console.log((await commands()).shareCommand({ ledger: take("--ledger"), out: take("--out") }, loaded().config)),
  // usage: routr dispatch "<brief>" > advice.json ... then: routr record --advice advice.json --subscription codex --model <m> --effort low [--level basic] --verdict done --check pass [--seconds 24] [--note "..."]
  record: async () => {
    const revising = argv.includes("--run-id"), comparing = argv.includes("--task-file");
    const taskFile = take("--task-file");
    const o = Object.fromEntries(["advice", "subscription", "model", "effort", "level", "verdict", "check", "seconds", "attempts", "note", "ledger", "report", "project"].map((f) => [f, take(`--${f}`)]));
    o.task_file = taskFile ?? (comparing ? "" : undefined);
    o.run_id = take("--run-id") ?? (revising ? "" : undefined); o.causes = takeAll("--cause");
    print((await commands()).recordCommand(o, takeAll("--subagent"), loaded().config, { warnings: [...loaded().notes, ...inputNotes], otel: { configPath } })); // never blocks the agent; the config resolves a "default" effort
  },
  usage: async () => print(withNotes(await (await commands()).usageCommand(rest, loaded().config, given, { warnings: loaded().notes, otel: { configPath } })), 1), // never blocks an agent
  doctor: async () => (await import("./lib/doctor.mjs")).doctor({ json: rest.includes("--json"), configPath }),
};
if (ADVISE[mode]) { await ADVISE[mode](); return 0; }
if (mode !== "subagent" && mode !== "dispatch") { console.error(formatUnknownUsage()); return 2; }

const { doNext } = await import("./lib/next.mjs");
const briefRefusal = (error) => print({ ok: false, headline: `routr: no advice: ${error}`, unavailable: [], warnings: [...loaded().notes, ...inputNotes],
  next: [doNext("Supply the exact task: quote an inline brief, pipe it on stdin, or use this file form.", `routr ${mode} --task-file <path>`)], error });

// File input is explicit: a missing value is refused rather than accidentally reading stdin or advising on a flag.
if (rest.includes("--task-file")) {
  const at = rest.indexOf("--task-file");
  try {
    if (rest.length !== 2 || at !== 0) throw new Error("--task-file takes one path; quote the whole inline brief if it contains --task-file, or use --task-file <path>");
    const brief = (await import("./lib/advice-file.mjs")).readTask(rest[1]).trim();
    if (!brief) throw new Error("--task-file: the task must not be empty");
    print(withNotes(await (await commands()).adviseCommand(mode, brief, loaded(), given, { lead: leadSession, otel: { configPath } })));
  } catch (e) { briefRefusal(e.message); }
  return 0;
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
if (unknownFlag && !setAside) {
  briefRefusal(`Unknown ${mode} flag: ${unknownFlag}. Quote an inline brief or use routr ${mode} --task-file <path>.`);
  return 0;
}
if (flagLike.length) inputNotes.push(warning("brief_flag", setAside
  ? `${flagLike.join(" ")}: not ${flagLike.length > 1 ? "flags" : "a flag"} routr ${mode} takes, so ignored; the brief was read from stdin`
  : `${flagLike.join(" ")} looks like ${flagLike.length > 1 ? "flags" : "a flag"} routr ${mode} does not take; read as part of the brief`));
const brief = rest.length && !setAside ? rest.join(" ").trim() : piped;
if (!brief) { briefRefusal("empty brief"); return 0; }
print(withNotes(await (await commands()).adviseCommand(mode, brief, loaded(), given, { lead: leadSession, otel: { configPath } })));
}

}

// Start before argument/file I/O, finish after output. Module commands share this context; early CLI refusals do too.
const value = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
const emitting = ["dispatch", "subagent", "check", "usage", "launch", "send", "wait", "workers", "stop", "cleanup", "record"];
const words = [...argv];
for (const flag of ["--config", "--headroom"]) while (words.includes(flag)) words.splice(words.indexOf(flag), 2);
const command = emitting.includes(words[0]) && (words[0] === "launch" || !argv.includes("--version")) ? words[0] : null;
let invoke = main;
if (command && !(argv[0] === "workers" && argv[1] === "--hold" && argv[2]) && !(command === "usage" && argv.includes("--background"))) {
  try {
    const tracing = await import("./lib/traces.mjs"), configPath = value("--config"), { takeLeadSession } = await import("./lib/trace-context.mjs"); traceOutput = tracing.traceOutput;
    invoke = () => tracing.commandTrace(command, () => ({ config: loadConfig(configPath).config, otel: { configPath },
      lead: takeLeadSession(argv).lead, cwd: value("--cwd"), explicitLevel: argv.includes("--level") }), main);
  } catch {} // Optional tracing must not prevent a command from starting.
}
const code = await invoke();
if (code != null) process.exit(code);
