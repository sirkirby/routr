// The command table: every routr command, one entry each, and the one place that knows a command. Help, unknown usage
// and the contract tests read its help fields (name, description, args, flags) and `contract`, which marks a command
// whose output docs/contracts.md covers: `fields`, its own top-level fields beside the five every answer starts with,
// or `text` for a screen. The dispatcher (routr.mjs) and tracing read the rest. Every entry writes out each rule below,
// false or null being a decision, so a new command cannot skip one by leaving it out (a test holds them all):
//   reach: "first": only as the line's first word, given its words as typed (with `word`: only with that word right
//          after it, given the words after the word). "globals": the first word left once --config and --headroom are
//          taken off the line, wherever they stand. "brief": as globals, and it reads a brief: --lead-session is taken
//          off too, and help is only the word right after it. "early": dispatched before this table loads (statusline,
//          which runs on every Claude Code turn); its entry is its help.
//   exit:  "zero": prints run's answer, if it returns one, and exits 0 whatever it says (an advice command fails open).
//          "natural": as zero, but an answer that is ok ends without forcing an exit, so work the command started
//          finishes first (a usage read it is stopping: on Windows its taskkill must end, or the reader's tree is left
//          running); a refusal exits 0. "ok": prints run's answer and exits 0 when it is ok, else 1. "own": run prints,
//          and returns its exit code (null: keep running, as the holder does).
//   trace: false, or { state, lead, links }: a span `routr <name>`, with `routr.<name>.state`, the lead's session id,
//          links to a worker's launch. `untraced(line)`: routr's own forms of the command, as typed, never traced.
//   autoUpdate: start the detached daily updater (at most once a day) before the command runs.
//   decisionModel: "assessment" or "check": its answer carries that decision-model reading, or an `unavailable` naming
//          the model; "probe": it calls a decision model to test it; null: neither.
//   advice: an advice command (docs/guarantees.md): it changes nothing of the user's and fails open.
//   run(ctx): the command; its module is imported inside, so loading the table loads no command code. null: early.
//          ctx, reached first: { args, settings, print, failed, loadConfig }. Reached after the globals: { mode, args,
//          take, takeAll (each takes from args), configPath, loaded, given, notes (the input notes), warnings(why) (the
//          input notes, and headroom_unused, "<why>; --headroom is for ...", when --headroom was given), lead, print }.
// A flag's `guard`: the line is refused when a global flag took it as its value ("joined": `--flag=<value>` counts
// too), with the entry's `refusal`: { headline, tail, extra, indent, beforeUpdate } for a JSON answer, or "screen" for
// text on stderr and exit 2. `indent` is how the entry's JSON answer is printed.
import { HARDEST, list, RESERVE } from "./wording.mjs";
import { HARNESSES, KINDS, TAKES_EFFORT } from "./harnesses.mjs";
import { NAME_RULE } from "./worker-record.mjs";
// What help says of the harnesses comes from the registry: which ones have a property, and what it says of itself.
const having = (test) => KINDS.filter((n) => test(HARNESSES[n]));
const labels = (kinds, key = "label") => kinds.map((n) => HARNESSES[n][key]);
const FRESH = having((h) => h.usage.check);
// Help is one text for every platform, so a reader that needs herdr names the platforms where it does.
const PLATFORMS = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const NEEDS_HERDR = having((h) => h.usage.needsHerdrOn?.length).map((n) => `${n} needs herdr installed on ${list(HARNESSES[n].usage.needsHerdrOn.map((p) => PLATFORMS[p] ?? p), "and")}`).join("; ");
// The harnesses with a skills folder of their own, in the order help has always named them (a test holds it to the registry).
export const OWN_SKILL_FOLDERS = "Claude Code, Kiro, Antigravity";
const SUBAGENT_DEFAULTS = list(labels(having((h) => h.subagents)), "or");
const USAGE_HELP = [...having((h) => h.usage.readHelp).map((n) => HARNESSES[n].usage.readHelp),
  `${FRESH.map((n) => `\`routr usage ${n}\` ${HARNESSES[n].usage.checkHelp}`).join(", and ")} (routr otherwise does ${FRESH.length === 1 ? "it" : FRESH.length === 2 ? "both" : "each"} in the background about once per working session, and at once after an update when the last try got no reading)`].join(" ");
const NOT_TRACED = false;
const commands = () => import("./commands.mjs");
const okCode = (r) => (r.ok ? 0 : 1);

export const COMMANDS = {
  subagent: {
    name: "subagent",
    contract: { fields: ["id", "ts", "mode", "question_set", "brief_sha", "brief_chars", "provider", "decision_model", "unmeasured", "ms", "answers", "level", "sure", "between", "work_type", "high_risk", "worker", "facts", "notes", "meaning"] },
    description: "a worker, or an agent outside herdr, is about to spawn a subagent → what the work demands (an orchestrator, in herdr or not, uses dispatch); unavailable names missing readings, with a no-reading headline on fallback",
    args: [
      { name: '"<brief>"', description: "task brief, word for word what the worker will get (or pipe it on stdin or pass --task-file); unknown flag-led input without a stdin brief is refused; quote a multi-word inline brief containing flags", required: true },
    ],
    flags: [
      { name: "--lead-session", arg: "<id>", description: "your known session id when routr cannot read it from the harness environment; UUIDv4, UUIDv7 or 16–64 lowercase hex characters; only a valid id is consumed from inline advice; other words stay in the brief with a flag-like note; invalid file-based values are ignored with a fixed warning; never invent one", required: false },
      { name: "--task-file", arg: "<path>", description: "read the exact task from a file instead of inline text or stdin", required: false },
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
    ],
    reach: "brief", exit: "natural", trace: { state: false, lead: true, links: false }, autoUpdate: true, decisionModel: "assessment", advice: true,
    run: async (ctx) => (await import("./command-line.mjs")).adviseOnBrief(ctx),
  },
  dispatch: {
    name: "dispatch",
    contract: { fields: ["id", "ts", "mode", "question_set", "brief_sha", "brief_chars", "provider", "decision_model", "unmeasured", "ms", "answers", "level", "sure", "between", "work_type", "high_risk", "worker", "facts", "notes", "meaning", "subscriptions"] },
    description: "an orchestrator is about to launch a worker → work assessment plus eligible subscriptions and headroom; choose for quality, then compare capacity among suitable options; unavailable names failed decision-model and usage readings, with recovery actions; fresh usable readings stay available",
    args: [
      { name: '"<brief>"', description: "task brief, word for word what the worker will get (or pipe it on stdin or pass --task-file); unknown flag-led input without a stdin brief is refused; quote a multi-word inline brief containing flags", required: true },
    ],
    flags: [
      { name: "--lead-session", arg: "<id>", description: "your known session id when routr cannot read it from the harness environment; UUIDv4, UUIDv7 or 16–64 lowercase hex characters; only a valid id is consumed from inline advice; other words stay in the brief with a flag-like note; invalid file-based values are ignored with a fixed warning; never invent one", required: false },
      { name: "--task-file", arg: "<path>", description: "read the exact task from a file instead of inline text or stdin", required: false },
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--headroom", arg: "<subscription>=<share>", description: "override a reading with usage you read yourself: the share left, 0.9 or 90% (not for a harness that is not signed in)", required: false, repeatable: true },
    ],
    reach: "brief", exit: "natural", trace: { state: false, lead: true, links: false }, autoUpdate: true, decisionModel: "assessment", advice: true,
    run: async (ctx) => (await import("./command-line.mjs")).adviseOnBrief(ctx),
  },
  usage: {
    name: "usage",
    contract: { fields: ["level", "subscriptions", "subscription", "reading"] },
    description: `what routr sees of each subscription's usage and how dispatch ranks it; most_room prefers a normal account with a positive number, otherwise the largest positive number; changes nothing of yours. ${USAGE_HELP}`,
    args: [{ name: "[<subscription>]", description: `only this one; for ${list(FRESH, "or")}, read its /usage now${NEEDS_HERDR ? ` (${NEEDS_HERDR})` : ""}`, required: false }],
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--headroom", arg: "<subscription>=<share>", description: "usage you read yourself, as for dispatch (0.9 or 90%)", required: false, repeatable: true },
      { name: "--level", arg: "<basic|standard|strong>", description: "refresh eligible accounts for your chosen work level without reassessing the brief; unnamed usage only, once, without --background. Plain usage uses basic", required: false, guard: "joined" },
    ],
    // A refused line refreshes nothing, not even the updater: usage's refusal has always come before it (record's after).
    refusal: { headline: "no usage view", tail: "eligibility was not refreshed", extra: { level: "basic" }, beforeUpdate: true },
    reach: "globals", exit: "zero", indent: 1, autoUpdate: true, decisionModel: null, advice: true,
    // `usage --background` is the detached refresh routr starts itself.
    trace: { state: false, lead: false, links: false, untraced: (line) => line.includes("--background") },
    // Never blocks an agent.
    run: async ({ args, loaded, given, notes, configPath }) => (await commands()).usageCommand(args, loaded().config, given, { warnings: [...loaded().notes, ...notes], otel: { configPath } }),
  },
  launch: {
    name: "launch",
    contract: { fields: ["state", "kind", "name", "pane", "cwd", "model", "effort", "start", "steps", "ran", "would_run", "prompt_chars", "advice", "worktree", "needs_input", "screen", "launch_id", "worker"] },
    description: `start a worker with matching task advice: in a herdr pane; in a herdr-core terminal (the Herdr app), the harness itself in a tab of its own, which you follow with hc; or anywhere else a headless ${list(labels(KINDS), "or")} worker that \`routr wait\` follows; unavailable carries the saved decision-model entries and recovery action (older advice names no attempted model); follow next for recovery, recording and cleanup`,
    flags: [
      { name: "--lead-session", arg: "<id>", description: "your known session id when routr cannot read it from the harness environment; UUIDv4, UUIDv7 or 16–64 lowercase hex characters; malformed values are ignored with a fixed warning; never invent one", required: false },
      { name: "--kind", arg: "<kind>", description: `harness kind (${KINDS.join(", ")})`, required: true },
      { name: "--name", arg: "<name>", description: `worker agent name (${NAME_RULE})`, required: true },
      { name: "--model", arg: "<id>", description: "model id; model, effort and fallback values refuse PowerShell quote characters (ASCII quotes or U+2018–U+201E) on every path", required: true },
      { name: "--cwd", arg: "<path>", description: "working directory", required: false, default: "." },
      { name: "--effort", arg: "<level>", description: "reasoning effort", required: false },
      { name: "--subagent-model", arg: "<id>", description: `opt-in fallback for a spawn that names no model (${SUBAGENT_DEFAULTS}); leave off unless this worker needs it; independent of --subagent-effort; existing panes get no environment fallback, existing agents keep their settings, with a warning`, required: false },
      { name: "--subagent-effort", arg: "<level>", description: `opt-in fallback for a spawn that names no effort (${SUBAGENT_DEFAULTS}); leave off unless this worker needs it; independent of --subagent-model; Anthropic's changelog dates it to 2.1.316, earlier versions untested; existing panes get no environment fallback, existing agents keep their settings, with a warning`, required: false },
      { name: "--rules-file", arg: "<path>", description: "your process rules for the worker (what it may do, how to report, git steps): added after the task, and never read by routr, which judges only the task", required: false },
      { name: "--advice", arg: "<file>", description: "the advice file from `routr dispatch`: launch refuses unreadable, malformed, nonmatching or `routr subagent` advice; dry runs refuse with ok:false and still plan", required: "required with a task" },
      { name: "--pane", arg: "<id>", description: "existing herdr pane to run in: at a shell prompt, or with an idle agent of --kind already running in --cwd (it is adopted, keeps its model and effort, and is sent the task; one not idle yet is never waited on: run the launch again once it is)", required: false },
      { name: "--worktree", arg: "<branch>", description: "give the worker its own git worktree on a new branch (the rule for workers): in herdr, opened as a workspace nested under the repo; outside herdr, in the Herdr app too, made by routr under ~/.local/share/routr/worktrees", required: false },
      { name: "--base", arg: "<ref>", description: "the commit the worktree's new branch starts from: a branch, tag, or commit id (stacked work, a reviewer of one commit; with --worktree)", required: false, default: "the checkout's HEAD" },
      { name: "--copy", arg: "<path>", description: "copy an untracked file or folder from the repo into the worktree (repeatable; with --worktree)", required: false, repeatable: true },
      { name: "--direction", arg: "<right|down>", description: "split direction", required: false, default: "right if wide else down" },
      { name: "--task", arg: "<text>", description: "task prompt string (mutually exclusive with --task-file)", required: false },
      { name: "--task-file", arg: "<path>", description: "file containing task prompt (mutually exclusive with --task; outside herdr, in the Herdr app too, a task is required)", required: false },
      { name: "--timeout", arg: "<ms>", description: "readiness timeout in milliseconds (outside herdr: for the worker's process to start and the harness to take the task; in a herdr-core terminal: for it to report working)", required: false, default: 120000 },
      { name: "--dry-run", arg: null, description: "plan worker actions without executing them; advice checks can refuse with ok:false; enabled OpenTelemetry export may queue the plan span (no launch index entry)", required: false, default: false },
    ],
    reach: "first", exit: "ok", trace: { state: true, lead: true, links: false }, autoUpdate: false, decisionModel: null, advice: false,
    run: async ({ args, settings }) => (await import("./launch.mjs")).launch(args, settings),
  },
  cleanup: {
    name: "cleanup",
    contract: { fields: ["state", "steps", "ran", "cwd", "pane", "worktrees", "worktree", "branch", "name"] },
    description: "finish a worker: remove the worktree `launch --worktree` made (closing its workspace), or close the pane launch split, or (`--worker`) a headless or terminal worker's worktree, through the same checks, and then its run folder and reports; a terminal worker's terminal is ended first. The way to end every worker: closing a worktree's pane leaves the worktree behind. Refuses while anything it can see runs there (outside herdr it cannot see what runs in a worktree's folder), and never removes uncommitted changes, files the worker made, or a commit no branch or tag holds; files copied in with --copy and left unchanged go with it, and so do files git ignores. Keeps the branch unless --delete-branch. With no worker named, lists the repo's worktrees and what it would do with each",
    flags: [
      { name: "--cwd", arg: "<repo>", description: "the repository (the main checkout or any of its worktrees)", required: false, default: "." },
      { name: "--worktree", arg: "<branch>", description: "the worker's worktree, by the branch given to launch --worktree (name one worker: --worktree, --path, --pane, or --worker)", required: false },
      { name: "--path", arg: "<path>", description: "the worker's worktree, by its folder (one on no branch, or made by hand)", required: false },
      { name: "--pane", arg: "<id>", description: "a worker launched without --worktree: close its pane (a worktree's only pane is refused, with the command that removes the worktree). Takes no --cwd", required: false },
      { name: "--worker", arg: "<name>", description: "a worker launched outside herdr: remove its worktree (with the same checks) and then its run folder and reports, once a headless worker's process and its harness's process group have ended (it cannot see a command that left them), or once a terminal worker that is not working has had its terminal ended with hc. Takes no --cwd", required: false },
      { name: "--delete-branch", arg: null, description: "also delete the worktree's branch, once its work has landed: git deletes it only when it is merged (with --worktree, --path or --worker)", required: false, default: false },
      { name: "--dry-run", arg: null, description: "check and say what it would do; with export off, change nothing; when export is on, may queue records and start the detached sender", required: false, default: false },
    ],
    reach: "first", exit: "ok", trace: { state: true, lead: false, links: true }, autoUpdate: false, decisionModel: null, advice: false,
    run: async ({ args, settings }) => (await import("./cleanup.mjs")).cleanup(args, settings),
  },
  wait: {
    name: "wait",
    contract: { fields: ["state", "workers"] },
    description: "wait for headless workers and status-reporting terminal workers; returns when one finishes a turn, fails, stops or is lost, or at the timeout with the ones still running; a headless turn has its report's path, while a terminal turn says to read its tab with hc. Cursor reports no terminal status, so wait says to follow it with hc",
    flags: [
      { name: "--name", arg: "<name>", description: "a worker to wait on (repeatable)", required: false, default: "every worker still running or with a turn not yet reported", repeatable: true },
      { name: "--timeout", arg: "<ms>", description: "how long to wait; in a foreground call, keep it under your own shell tool's command limit (Claude Code's default is 2 minutes)", required: false, default: 90000 },
    ],
    reach: "first", exit: "zero", trace: { state: true, lead: false, links: true }, autoUpdate: false, decisionModel: null, advice: false,
    run: async ({ args, settings }) => (await import("./workers.mjs")).waitCommand(args, settings),
  },
  send: {
    name: "send",
    contract: { fields: ["state", "name", "message"] },
    description: "a correction or follow-up for a worker: through a headless worker's holder, or through hc to a terminal worker using an owner-only message file; new work is a new launch with its own advice",
    flags: [
      { name: "--name", arg: "<name>", description: "the worker", required: true },
      { name: "--task", arg: "<text>", description: "the message (mutually exclusive with --task-file)", required: false },
      { name: "--task-file", arg: "<path>", description: "file containing the message (mutually exclusive with --task)", required: false },
    ],
    reach: "first", exit: "ok", trace: { state: true, lead: false, links: true }, autoUpdate: false, decisionModel: null, advice: false,
    run: async ({ args, settings }) => (await import("./workers.mjs")).sendCommand(args, settings),
  },
  workers: {
    name: "workers",
    contract: { fields: ["workers"] },
    description: "outside herdr: each headless worker's state, turn, seconds since its last event, last tool, session and the path of its latest report; never its text; a terminal worker's row says which terminal to follow it in with hc; with export off, changes nothing; when export is on, may queue records and start the detached sender",
    flags: [{ name: "--name", arg: "<name>", description: "only this worker (repeatable)", required: false, repeatable: true }],
    reach: "first", exit: "own", autoUpdate: false, decisionModel: null, advice: false,
    // `workers --hold <run folder>` is the holder itself, which launch and send start detached; it prints nothing and keeps
    // running. `workers --run <run folder> --id <id>` is a terminal worker's own program, the one hc runs in its terminal:
    // the harness has that terminal to itself, and its exit code is this one's. Neither is traced.
    trace: { state: true, lead: false, links: true, untraced: (line) => ["--hold", "--run"].includes(line[1]) && Boolean(line[2]) },
    run: async ({ args, settings, print }) => {
      if (args[0] === "--hold" && args[1]) { await (await import("./headless.mjs")).hold(args[1]); return null; }
      if (args[0] === "--run" && args[1] && args[2] === "--id" && args[3]) return await (await import("./backend-terminal.mjs")).runWorker(args[1], args[3]);
      print(await (await import("./workers.mjs")).workersCommand(args, settings)); return 0;
    },
  },
  stop: {
    name: "stop",
    contract: { fields: ["state", "name"] },
    description: "stop a headless worker through its own process (macOS and Linux: SIGTERM to the harness's process group, then SIGKILL if the harness has not gone; Windows: taskkill /T), never by a saved process id; stop a terminal worker through hc after checking its id",
    flags: [{ name: "--name", arg: "<name>", description: "the worker", required: true }],
    reach: "first", exit: "ok", trace: { state: true, lead: false, links: true }, autoUpdate: false, decisionModel: null, advice: false,
    run: async ({ args, settings }) => (await import("./workers.mjs")).stopCommand(args, settings),
  },
  watch: {
    name: "watch",
    description: "a person's view of one headless worker: its state, tools and report paths as they change, never its text, until it is cleaned up; changes nothing, and closing it stops nothing. A terminal worker's own tab shows it instead",
    flags: [{ name: "--name", arg: "<name>", description: "the worker", required: true }],
    reach: "first", exit: "own", trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false,
    // Text for a person, not an answer for an agent: it runs until the worker is cleaned up.
    run: async ({ args }) => { try { return await (await import("./watch.mjs")).watchCommand(args); } catch (e) { console.error(`routr: ${e?.message ?? e}`); return 1; } },
  },
  share: {
    name: "share",
    description: "write exactly what telemetry sends (no briefs or any text, nothing identifying) to a file you can read; sends nothing",
    flags: [
      { name: "--out", arg: "<file>", description: "where to write it", required: false, default: "routr-ledger-<date>.jsonl beside the ledger it reads" },
      { name: "--ledger", arg: "<path>", description: "ledger to read", required: false, default: "~/.local/share/routr/ledger.jsonl" },
    ],
    reach: "globals", exit: "zero", trace: NOT_TRACED, autoUpdate: true, decisionModel: null, advice: false,
    run: async ({ take, loaded }) => { console.log((await commands()).shareCommand({ ledger: take("--ledger"), out: take("--out") }, loaded().config)); },
  },
  telemetry: {
    name: "telemetry",
    description: "share anonymous outcomes (never text) once a day to help tune routr's questions: off unless you turn it on; `routr share` shows exactly what",
    args: [{ name: "status|on|off|send", description: "show the setting, turn it on or off, or send the new rows now (send --all: also rows from before telemetry started here)", required: false }],
    flags: [{ name: "--config", arg: "<path>", description: "config file that on/off writes", required: false, default: "~/.config/routr/config.json" }],
    reach: "first", exit: "ok", indent: 1, trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false,
    run: async ({ args, loadConfig, failed }) => {
      const { sendRows, telemetryCommand, telemetryStatus } = await import("./telemetry.mjs");
      const ci = args.indexOf("--config"), cfg = ci >= 0 ? args[ci + 1] : undefined;
      const words = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--config"); // flags in any order
      const { config } = loadConfig(cfg);
      const st = telemetryStatus(config);
      return words[0] !== "send" ? telemetryCommand(words, config, cfg)
        : !st.on ? { ok: false, error: `telemetry is off (${st.why_off}): nothing was sent` }
        : await sendRows({ all: args.includes("--all") }).catch(failed);
    },
  },
  feedback: {
    name: "feedback",
    description: 'send the maintainers a note, in your words: routr feedback "what worked, what did not"',
    args: [{ name: '"<text>"', description: "what you want to tell them; sent with routr's version and your OS", required: true }],
    flags: [],
    reach: "first", exit: "ok", trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false,
    // The text is an argument, never read from stdin: a pipe left open would hang.
    run: async ({ args }) => (await import("./telemetry.mjs")).sendFeedback(args.join(" ")),
  },
  update: {
    name: "update",
    description: "replace this routr with the newest release on your update channel now (checksum verified) and reinstall the skill. routr also does this by itself in the background at most once a day; \"auto_update\": false in the config turns that off. The channel is a setting, stable unless you choose beta: routr setup --channel beta|stable",
    flags: [
      { name: "--check", description: "only say whether a newer release exists", required: false },
      { name: "--force", description: "install the channel's newest release even if this one is current or newer (back to stable from a beta)", required: false },
    ],
    reach: "first", exit: "own", trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false,
    run: async ({ args, print }) => {
      const u = await import("./update.mjs");
      if (args.includes("--background")) { await u.backgroundUpdate(); return 0; } // the daily job routr starts itself
      // By hand under the daily job's lock too (lockedUpdate): never two swaps at once.
      const r = await u.lockedUpdate({ checkOnly: args.includes("--check"), force: args.includes("--force") }); print(r); return okCode(r);
    },
  },
  statusline: {
    name: "statusline",
    description: "a statusline command for Claude Code, optional: prints model and usage, and saves a usage snapshot routr uses while it is under 5 minutes old (routr reads Claude's own /usage otherwise). Setup no longer sets it",
    flags: [],
    reach: "early", exit: "own", trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false, run: null,
  },
  skill: {
    name: "skill",
    description: `\`routr skill install\` writes routr's two skills into ~/.agents/skills (read by ${list(labels(having((h) => !h.skills)), "and")}) and links them into the skills folder of each other harness set up here (${OWN_SKILL_FOLDERS}): the routr skill, and routr-orchestrate, which you type to start a session as the orchestrator (\`/routr-orchestrate <plan>\`; \`$routr-orchestrate\` in Codex). It replaces only routr's own copies: a skill or link of the same name that routr did not write is kept, and listed`,
    args: [{ name: "install", description: "install or update the skills", required: true }],
    flags: [{ name: "--dry-run", description: "show where it would be written", required: false }],
    reach: "first", word: "install", exit: "ok", indent: 1, trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false,
    run: async ({ args }) => (await import("./skill-install.mjs")).installSkill({ dryRun: args.includes("--dry-run") }),
  },
  key: {
    name: "key",
    description: "`routr key set [typesafe|cloudflare|otel-headers]` stores provider keys or OpenTelemetry headers. Provider keys (TypeSafe: an API key; Cloudflare: an API token with Workers AI Read, and your account ID) are typed with no echo (the account ID is shown), or piped one per line; saved owner-only beside any other provider's, then tested. With no provider, the first entry that needs a key (a local-only list needs none). A provider outside your decision list is named with a setup command to add it; the list stays as it is. Ollama needs no key. otel-headers takes one hidden or piped OTLP header list and makes no test call (docs/opentelemetry.md)",
    args: [{ name: "set", description: "store it in ~/.config/routr/env", required: true }, { name: "typesafe|cloudflare|otel-headers", description: "the provider (default: the first entry that needs a key), or OTLP authentication headers: comma-separated name=value pairs, percent-decoded once; saved without a test call, never printed", required: false }],
    flags: [{ name: "--no-verify", description: "skip the test call", required: false }],
    reach: "first", word: "set", exit: "ok", trace: NOT_TRACED, autoUpdate: false, decisionModel: "probe", advice: false,
    // `routr key set [typesafe|cloudflare]`: the provider named, or the one the config asks.
    run: async ({ args, loadConfig }) => {
      const ci = args.indexOf("--config"), named = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--config" && a !== "set")[0];
      const config = loadConfig(ci >= 0 ? args[ci + 1] : undefined).config;
      return (await import("./key.mjs")).setKey({ provider: named, config, verify: !args.includes("--no-verify") });
    },
  },
  setup: {
    name: "setup",
    description: "do what doctor says is missing: write your settings for the harnesses found, and choose a first decision model and optional backup, and ask for their keys. It leaves Claude Code's settings alone. At a terminal it is a guided screen (run again: a menu to change one thing; nothing is written until you review it); an agent passes --yes. Run it again with a flag to change one setting. Unknown flags are refused before any changes; saving removes obsolete account settings",
    flags: [
      { name: "--yes", description: "ask nothing: take the defaults and the flags given (the way an agent runs it)", required: false },
      { name: "--model", arg: "<subscription>=<model id>", description: `your everyday model on a subscription, from the harness's live list (${having((h) => h.openList).map((n) => `${HARNESSES[n].label} also ${HARNESSES[n].openList}`).join("; ")}); repeatable. Also changes it on an existing config`, required: false, repeatable: true },
      { name: "--use", arg: "<subscription>=normal|fallback", description: "normal: consider for everyday work; fallback: when normal accounts cannot suitably take it. Independent of billing; repeatable", required: false, repeatable: true },
      { name: "--share", arg: "<subscription>=<1-99>|off", description: "this account's weight in your ratio of launches between normal metered accounts with room (claude=3 and codex=1: about three workers on claude for every one on codex); advice, never enforced; off removes it; repeatable", required: false, repeatable: true },
      { name: "--hardest", arg: "<subscription>=basic|standard|strong", description: `${HARDEST.flag}: basic, standard, or strong; repeatable. Also changes it on an existing config`, required: false, repeatable: true },
      { name: "--reserve", arg: "<subscription>=<share>", description: `${RESERVE.flag}; repeatable. Also changes it on an existing config`, required: false, repeatable: true },
      { name: "--effort", arg: "<subscription>=<level>", description: `your everyday effort there, one of the levels the harness takes for that model (${having((h) => h.autoEffort).map((n) => `${HARNESSES[n].label}: ${HARNESSES[n].autoEffort} leaves it to the model`).join("; ")}); repeatable`, required: false, repeatable: true },
      { name: "--enable", arg: "<subscription>", description: "let routr hand work to this subscription again (it kept its settings while off); repeatable", required: false, repeatable: true },
      { name: "--disable", arg: "<subscription>", description: "turn a subscription off: routr gives it no work, and it keeps its settings; repeatable", required: false, repeatable: true },
      { name: "--channel", arg: "stable|beta", description: "which releases updates install: stable (the default), or beta for beta and release-candidate builds too (a newer stable release still wins). Read by `routr update` and the daily update; nothing moves you back to an older stable by itself", required: false },
      { name: "--otel-endpoint", arg: "<url>", description: "turn on OpenTelemetry export to your endpoint (https, or http on loopback; no userinfo or query). Fresh consent every time. Only when the person asks; --yes alone never enables it. Sends traces, logs and a subscription headroom gauge; repository names, relative paths and ids; never briefs, reports or secrets. Schema: https://github.com/sirkirby/routr/blob/main/docs/opentelemetry.md", required: false },
      { name: "--otel-off", description: "turn OpenTelemetry export off; the detached sender removes old batches. Cannot be combined with --otel-endpoint", required: false },
      { name: "--decision", arg: "<provider>[:<model>],...", description: "ordered decision models (for example typesafe,cloudflare:clef-flash); first answer wins. Local Ollama models run after all hosted entries because they may need to load. Hosted attempts have an 8 s cut within one overall deadline (10 s hosted-only, 30 s with local). Choices: typesafe (Jev, the default), cloudflare (Clef on your Cloudflare account; cloudflare:clef-flash is its smaller model), or ollama (Clef Flash on this machine, free). Only models routr has measured (docs/evidence.md); the key is set apart, by the person, with routr key set", required: false },
      { name: "--show", arg: null, description: "print your settings and OpenTelemetry delivery status as routr reads them, and change nothing (asks no harness)", required: false },
      { name: "--no-statusline", description: "does nothing: setup no longer sets Claude's statusline (accepted for older scripts)", required: false },
      { name: "--force", description: "rewrite an existing config (the old one is kept as config.json.bak)", required: false },
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--json", arg: null, description: "output JSON instead of text", required: false, default: false },
    ],
    reach: "first", exit: "own", trace: NOT_TRACED, autoUpdate: false, decisionModel: "probe", advice: false,
    // A person who stops the guided setup (Ctrl+C) has already been told nothing was written; 130 is the usual exit for it.
    // `--show` is JSON whatever else is passed: it is what an agent reads before it changes a setting.
    run: async ({ args, print }) => {
      const r = await (await import("./setup.mjs")).setup(args);
      if (args.includes("--json") || args.includes("--show")) print(r, 1); else if (!r.ok && !r.cancelled) console.error(r.error);
      return r.ok ? 0 : r.cancelled ? 130 : 1;
    },
  },
  uninstall: {
    name: "uninstall",
    description: "remove routr from this machine: the binary, both skills (routr and routr-orchestrate) and their links, the cache, and a `routr statusline` entry in Claude Code's settings (an older routr's setup set one), and routr's own state. Keeps your config, key, and ledger unless you say otherwise. Removes nothing while a headless worker is still here (finish each with `routr cleanup --worker`), nor with --purge while a worktree a headless launch made is. Shows the plan and asks first",
    flags: [
      { name: "--purge", description: "also remove your config, your decision provider's key, and ledger (everything in ~/.local/share/routr)", required: false },
      { name: "--yes", description: "ask nothing (needed when there is no terminal)", required: false },
      { name: "--dry-run", description: "show what would be removed and kept", required: false },
      { name: "--json", arg: null, description: "output JSON instead of text", required: false, default: false },
    ],
    reach: "first", exit: "own", trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false,
    run: async ({ args, print }) => {
      const r = await (await import("./uninstall.mjs")).uninstall(args);
      if (args.includes("--json")) print(r, 1); else if (r.error) console.error(r.error); else if (r.dry_run) print(r, 1); else if (r.note && !r.otel_sender_running) console.log(r.note);
      return okCode(r);
    },
  },
  doctor: {
    name: "doctor",
    description: "test every decision-list entry in order, showing which answer and each failure; check harnesses and settings and list what to do next; changes nothing",
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--json", arg: null, description: "output JSON instead of text", required: false, default: false },
      { name: "--fix", arg: null, description: "do what can be done of the next steps: the same as `routr setup` (takes its flags, such as --yes)", required: false, default: false },
    ],
    reach: "globals", exit: "zero", trace: NOT_TRACED, autoUpdate: true, decisionModel: "probe", advice: true,
    // It prints itself, text or JSON. `doctor --fix` is setup (command-line.mjs).
    run: async ({ args, configPath }) => { await (await import("./doctor.mjs")).doctor({ json: args.includes("--json"), configPath }); },
  },
  check: {
    name: "check",
    contract: { fields: ["mode", "question_set", "provider", "decision_model", "unmeasured", "ms", "claimed", "flags", "unclear", "checks"] },
    description: "a quick first read of a worker's report (writes nothing); you remain the judge; unavailable names an unreadable brief/report or the attempted decision model and its failure",
    flags: [
      { name: "--brief", arg: "<file>", description: "path to task brief file", required: true },
      { name: "--report", arg: "<file>", description: "path to worker report file", required: true },
    ],
    reach: "globals", exit: "zero", trace: { state: false, lead: false, links: false }, autoUpdate: true, decisionModel: "check", advice: true,
    run: async ({ take, loaded, notes, configPath }) => (await commands()).checkCommand({ brief: take("--brief"), report: take("--report") }, { config: loaded().config, warnings: [...loaded().notes, ...notes], otel: { configPath } }),
  },
  record: {
    name: "record",
    contract: { fields: ["id", "run_id", "ledger"] },
    description: "append what you chose and how it turned out to the ledger; next integrates and cleans up only for done with check pass, otherwise sends back or escalates, and always includes a template to revise this run with absolute advice, task and ledger paths",
    flags: [
      { name: "--task-file", arg: "<path>", description: "compare this worker’s task with the advice before appending; omit only for inline tasks, or revisions when the original file is gone (say so in --note)", required: false },
      { name: "--subscription", arg: "<name>", description: `subscription used (${KINDS.join(", ")})`, required: true },
      { name: "--model", arg: "<name>", description: "model chosen", required: true },
      { name: "--effort", arg: "<level>", description: `reasoning effort chosen. On ${list(labels(TAKES_EFFORT, "shortLabel"), "and")}, "default" is recorded as your configured default_effort; on ${list(labels(KINDS.filter((n) => !TAKES_EFFORT.includes(n)), "shortLabel"), "and")}, "default" is recorded as the effort word at the end of the model id, or just before a last qualifier (grok-4.7-high, grok-4.6-high-fast). Otherwise it is kept as written; chose.effort_from records which`, required: true },
      { name: "--verdict", arg: "<done|partial|blocked>", description: "worker outcome verdict", required: true },
      { name: "--check", arg: "<pass|fail|none>", description: "verification outcome", required: true },
      { name: "--advice", arg: "<file>", description: "path to advice JSON file (or pipe on stdin)", required: false, default: "stdin" },
      { name: "--report", arg: "<file>", description: "path to worker report file", required: false },
      { name: "--subagent", arg: '"<subtask> → <level advised> → <model chosen> → <effort chosen>"', description: "subagent sizing decision", required: false, repeatable: true },
      { name: "--level", arg: "<level>", description: "actual work level chosen (basic, standard, strong); supply explicitly, even when unchanged. A larger model alone does not change the work level", required: false, default: "advised level" },
      { name: "--seconds", arg: "<n>", description: "elapsed seconds from handoff through verification (or stopping); omit when unknown", required: false },
      { name: "--attempts", arg: "<n>", description: "positive count of worker attempts; activity, not a quality score. Omit when unknown", required: false },
      { name: "--cause", arg: "<execution|brief|scope|review|launch|unknown|none>", description: "why extra work occurred, including lead corrections; repeatable, local only. none means no extra work and must be used alone", required: false, repeatable: true },
      { name: "--run-id", arg: "<run_id>", description: "revise an existing run using the run_id field from record's earlier output, not id (the advice id); the row's run_id is also in the ledger. Use next's revision template with the original advice and updated outcome. Omitted note and subagent data are preserved. Otherwise records a new worker run. Local only", required: false },
      { name: "--launch", arg: "<launch_id>", description: "the launch_id from launch's answer (its record template carries it): the row names its launch, and takes that launch's project unless --project is given. A revision keeps its run's launch. Local only", required: false, guard: true },
      { name: "--project", arg: "<name>", description: "label for the row (default: the project of the launch named by --launch, else the git repository's folder name of the folder record runs in; kept local, never shared)", required: false },
      { name: "--note", arg: "<text>", description: "note explaining choice or outcome", required: false },
      { name: "--ledger", arg: "<path>", description: "path to ledger file", required: false, default: "~/.local/share/routr/ledger.jsonl" },
    ],
    refusal: { headline: "nothing recorded", tail: "nothing was recorded" },
    reach: "globals", exit: "zero", trace: { state: true, lead: false, links: false }, autoUpdate: true, decisionModel: null, advice: false,
    // usage: routr dispatch "<brief>" > advice.json ... then: routr record --advice advice.json --subscription codex --model <m> --effort low [--level basic] --verdict done --check pass [--seconds 24] [--note "..."]
    // `--launch` first, before any other flag can take it as its value (`--note --launch <id>`): with no value, or twice,
    // record refuses it, never reads it as absent (its guard covers a global flag that took it).
    run: async ({ args, take, takeAll, loaded, notes, configPath }) => {
      const launchFlags = args.filter((w) => w === "--launch").length, launch = launchFlags ? take("--launch") ?? "" : undefined;
      const revising = args.includes("--run-id"), comparing = args.includes("--task-file");
      const taskFile = take("--task-file");
      const o = Object.fromEntries(["advice", "subscription", "model", "effort", "level", "verdict", "check", "seconds", "attempts", "note", "ledger", "report", "project"].map((f) => [f, take(`--${f}`)]));
      o.task_file = taskFile ?? (comparing ? "" : undefined);
      o.run_id = take("--run-id") ?? (revising ? "" : undefined); o.causes = takeAll("--cause");
      o.launch = launch; o.launch_repeated = launchFlags > 1;
      // Never blocks the agent; the config resolves a "default" effort.
      return (await commands()).recordCommand(o, takeAll("--subagent"), loaded().config, { warnings: [...loaded().notes, ...notes], otel: { configPath } });
    },
  },
  board: {
    name: "board",
    contract: { fields: ["project", "level", "subscriptions", "decisions", "outcomes"] },
    description: "what only routr knows, for a folder's project: each account's room as usage ranks it (from routr's kept readings: no harness is called, and a detached usage read is started for those that are due: over 10 minutes old, 4 hours for Cursor and Kiro), each launch's decision joined to its recorded outcome, and the last 7 days' counts. Never the ledger's notes; changes nothing of yours. `routr top` draws it for a person",
    flags: [
      { name: "--cwd", arg: "<folder>", description: "the project to show, by the git repository that folder is in (a worktree counts as its repository); omitted, every project on this machine", required: false, guard: true },
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
    ],
    refusal: { headline: "no board", indent: 1 },
    reach: "globals", exit: "zero", indent: 1, trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false,
    // Kept readings only, no harness called: `routr top` asks it every few seconds. Given --headroom is not used, and said.
    run: async ({ args, loaded, warnings, configPath }) => (await import("./board.mjs")).boardCommand(args, loaded().config, { configPath, warnings: [...loaded().notes, ...warnings("board ranks routr's kept readings")] }),
  },
  top: {
    name: "top",
    contract: { text: true },
    description: "a person's view of routr board, kept current in a terminal (a pane or split beside the lead): each account's room, each launch's decision and outcome, and the last 7 days' counts, every 5 seconds. Keys: up/down pick a decision, Enter its detail, a this project or all, u read usage now (runs the harnesses' usage commands), q quit. Shows only what board does; changes nothing of yours. Piped: one plain snapshot; ACCESSIBLE=1: a plain snapshot per Enter",
    flags: [
      { name: "--cwd", arg: "<folder>", description: "the project to show, by the git repository that folder is in (a worktree counts as its repository); outside a repository, every project", required: false, default: "the current folder", guard: true },
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
    ],
    refusal: "screen",
    reach: "globals", exit: "own", trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false,
    // A person's screen, not an answer for an agent: text, kept current until they quit. Board's folder rule.
    run: async ({ args, warnings, configPath }) => (await import("./top.mjs")).topCommand(args, { configPath, warnings: warnings("top draws routr's kept readings") }),
  },
  dash: {
    name: "dash",
    contract: { fields: ["file", "opened", "runs", "project"] },
    description: "one page of this machine's ledger: what you asked routr, what you chose, and how it turned out, written to an HTML file and opened in your browser. It counts; it does not judge. No harness is called. Piped, or with --no-open, it only writes the file and prints its path",
    flags: [
      { name: "--cwd", arg: "<folder>", description: "the project to preselect, by the git repository that folder is in (a worktree counts as its repository); outside a repository, every project", required: false, default: "the current folder", guard: true },
      { name: "--out", arg: "<file>", description: "where to write the page", required: false, default: "dash.html in routr's cache folder", guard: true },
      { name: "--no-open", description: "write the file and do not open it", required: false, guard: true },
    ],
    refusal: { headline: "no dash", indent: 1 },
    reach: "globals", exit: "zero", indent: 1, trace: NOT_TRACED, autoUpdate: false, decisionModel: null, advice: false,
    // The ledger only: no config, no harness, no network.
    run: async ({ args, warnings }) => (await import("./dash.mjs")).dashCommand(args, { warnings: warnings("dash reads this machine's ledger only") }),
  },
  assess: {
    name: "assess",
    description: "verified outcomes, correction causes and capacity observations from your ledger; explicit run revisions counted once",
    flags: [
      { name: "--ledger", arg: "<path>", description: "path to ledger file", required: false, default: "~/.local/share/routr/ledger.jsonl" },
    ],
    reach: "globals", exit: "zero", trace: NOT_TRACED, autoUpdate: true, decisionModel: null, advice: true,
    run: async ({ take, loaded }) => { console.log((await commands()).assessCommand({ ledger: take("--ledger") }, loaded().config)); },
  },
};
