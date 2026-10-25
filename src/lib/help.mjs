// Single source of truth for routr CLI commands, flags, descriptions, and help formatting.
import { HARDEST, RESERVE } from "./wording.mjs";
import { KINDS } from "./harnesses.mjs";
export const DESCRIPTION = "routr: quick, calibrated advice for an agent that is about to hand out work.";

export const COMMANDS = {
  subagent: {
    name: "subagent",
    description: "a worker, or an agent outside herdr, is about to spawn a subagent → what the work demands (an orchestrator, in herdr or not, uses dispatch); unavailable names missing readings, with a no-reading headline on fallback",
    args: [
      { name: '"<brief>"', description: "task brief, word for word what the worker will get (or pipe it on stdin or pass --task-file); unknown flag-led input without a stdin brief is refused; quote a multi-word inline brief containing flags", required: true },
    ],
    flags: [
      { name: "--lead-session", arg: "<id>", description: "your known session id when routr cannot read it from the harness environment; UUIDv4, UUIDv7 or 16–64 lowercase hex characters; never invent one", required: false },
      { name: "--task-file", arg: "<path>", description: "read the exact task from a file instead of inline text or stdin", required: false },
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
    ],
  },
  dispatch: {
    name: "dispatch",
    description: "an orchestrator is about to launch a worker → work assessment plus eligible subscriptions and headroom; choose for quality, then compare capacity among suitable options; unavailable names failed decision-model and usage readings, with recovery actions; fresh usable readings stay available",
    args: [
      { name: '"<brief>"', description: "task brief, word for word what the worker will get (or pipe it on stdin or pass --task-file); unknown flag-led input without a stdin brief is refused; quote a multi-word inline brief containing flags", required: true },
    ],
    flags: [
      { name: "--lead-session", arg: "<id>", description: "your known session id when routr cannot read it from the harness environment; UUIDv4, UUIDv7 or 16–64 lowercase hex characters; never invent one", required: false },
      { name: "--task-file", arg: "<path>", description: "read the exact task from a file instead of inline text or stdin", required: false },
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--headroom", arg: "<subscription>=<share>", description: "override a reading with usage you read yourself: the share left, 0.9 or 90% (not for a harness that is not signed in)", required: false, repeatable: true },
    ],
  },
  usage: {
    name: "usage",
    description: "what routr sees of each subscription's usage and how dispatch ranks it; changes nothing of yours. Claude Code's is read from its own /usage (hooks and MCP servers off), or from `routr statusline`'s snapshot when one is under 5 minutes old. `routr usage cursor` takes a fresh reading of Cursor's own /usage screen now, in a private herdr session, and `routr usage kiro` runs Kiro's /usage now and deletes the empty session it leaves (routr otherwise does both in the background about once per working session, and at once after an update when the last try got no reading)",
    args: [{ name: "[<subscription>]", description: "only this one; for cursor or kiro, read its /usage now (cursor needs herdr installed)", required: false }],
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--headroom", arg: "<subscription>=<share>", description: "usage you read yourself, as for dispatch (0.9 or 90%)", required: false, repeatable: true },
      { name: "--level", arg: "<basic|standard|strong>", description: "refresh eligible accounts for your chosen work level without reassessing the brief; unnamed usage only, once, without --background. Plain usage uses basic", required: false },
    ],
  },
  launch: {
    name: "launch",
    description: "start a worker with matching task advice: in a herdr pane, or outside herdr a headless Claude Code, Codex, Cursor, Antigravity or Kiro worker that `routr wait` follows; unavailable carries the saved decision-model entries and recovery action (older advice names no attempted model); follow next for recovery, recording and cleanup",
    flags: [
      { name: "--lead-session", arg: "<id>", description: "your known session id when routr cannot read it from the harness environment; UUIDv4, UUIDv7 or 16–64 lowercase hex characters; never invent one", required: false },
      { name: "--kind", arg: "<kind>", description: `harness kind (${KINDS.join(", ")})`, required: true },
      { name: "--name", arg: "<name>", description: "worker agent name ([a-z][a-z0-9_-]{0,31})", required: true },
      { name: "--model", arg: "<id>", description: "model id", required: true },
      { name: "--cwd", arg: "<path>", description: "working directory", required: false, default: "." },
      { name: "--effort", arg: "<level>", description: "reasoning effort", required: false },
      { name: "--rules-file", arg: "<path>", description: "your process rules for the worker (what it may do, how to report, git steps): added after the task, and never read by routr, which judges only the task", required: false },
      { name: "--advice", arg: "<file>", description: "the advice file from `routr dispatch`: launch refuses unreadable, malformed, nonmatching or `routr subagent` advice; dry runs refuse with ok:false and still plan", required: "required with a task" },
      { name: "--pane", arg: "<id>", description: "existing herdr pane to run in: at a shell prompt, or with an idle agent of --kind already running in --cwd (it is adopted, keeps its model and effort, and is sent the task; one not idle yet is never waited on: run the launch again once it is)", required: false },
      { name: "--worktree", arg: "<branch>", description: "give the worker its own git worktree on a new branch (the rule for workers): in herdr, opened as a workspace nested under the repo; outside herdr, made by routr under ~/.local/share/routr/worktrees", required: false },
      { name: "--base", arg: "<ref>", description: "the commit the worktree's new branch starts from: a branch, tag, or commit id (stacked work, a reviewer of one commit; with --worktree)", required: false, default: "the checkout's HEAD" },
      { name: "--copy", arg: "<path>", description: "copy an untracked file or folder from the repo into the worktree (repeatable; with --worktree)", required: false, repeatable: true },
      { name: "--direction", arg: "<right|down>", description: "split direction", required: false, default: "right if wide else down" },
      { name: "--task", arg: "<text>", description: "task prompt string (mutually exclusive with --task-file)", required: false },
      { name: "--task-file", arg: "<path>", description: "file containing task prompt (mutually exclusive with --task; outside herdr a task is required)", required: false },
      { name: "--timeout", arg: "<ms>", description: "readiness timeout in milliseconds (outside herdr: for the worker's process to start and the harness to take the task)", required: false, default: 120000 },
      { name: "--dry-run", arg: null, description: "plan commands without executing or writing files; advice checks can refuse with ok:false", required: false, default: false },
    ],
  },
  cleanup: {
    name: "cleanup",
    description: "finish a worker: remove the worktree `launch --worktree` made (closing its workspace), or close the pane launch split, or (`--worker`) a headless worker's worktree, through the same checks, and then its run folder and reports. The way to end every worker: closing a worktree's pane leaves the worktree behind. Refuses while anything it can see runs there (outside herdr it cannot see what runs in a worktree's folder), and never removes uncommitted changes, files the worker made, or a commit no branch or tag holds; files copied in with --copy and left unchanged go with it, and so do files git ignores. Keeps the branch unless --delete-branch. With no worker named, lists the repo's worktrees and what it would do with each",
    flags: [
      { name: "--cwd", arg: "<repo>", description: "the repository (the main checkout or any of its worktrees)", required: false, default: "." },
      { name: "--worktree", arg: "<branch>", description: "the worker's worktree, by the branch given to launch --worktree (name one worker: --worktree, --path, --pane, or --worker)", required: false },
      { name: "--path", arg: "<path>", description: "the worker's worktree, by its folder (one on no branch, or made by hand)", required: false },
      { name: "--pane", arg: "<id>", description: "a worker launched without --worktree: close its pane (a worktree's only pane is refused, with the command that removes the worktree). Takes no --cwd", required: false },
      { name: "--worker", arg: "<name>", description: "a headless worker (launched outside herdr): remove its worktree (with the same checks) and then its run folder and reports, once its process and its harness's process group have ended (it cannot see a command that left them). Takes no --cwd", required: false },
      { name: "--delete-branch", arg: null, description: "also delete the worktree's branch, once its work has landed: git deletes it only when it is merged (with --worktree, --path or --worker)", required: false, default: false },
      { name: "--dry-run", arg: null, description: "check and say what it would do; change nothing", required: false, default: false },
    ],
  },
  wait: {
    name: "wait",
    description: "outside herdr: wait for headless workers; returns when one finishes a turn (with its report's path), fails, stops or is lost, or at the timeout with the ones still running; changes nothing of yours",
    flags: [
      { name: "--name", arg: "<name>", description: "a worker to wait on (repeatable)", required: false, default: "every worker still running or with a turn not yet reported", repeatable: true },
      { name: "--timeout", arg: "<ms>", description: "how long to wait, at most 600000; keep it under your own shell tool's command limit (Claude Code's default is 2 minutes)", required: false, default: 90000 },
    ],
  },
  send: {
    name: "send",
    description: "outside herdr: a correction or follow-up for a headless worker, into its running turn where the harness takes it, or as the next turn of the same session; new work is a new launch with its own advice",
    flags: [
      { name: "--name", arg: "<name>", description: "the worker", required: true },
      { name: "--task", arg: "<text>", description: "the message (mutually exclusive with --task-file)", required: false },
      { name: "--task-file", arg: "<path>", description: "file containing the message (mutually exclusive with --task)", required: false },
    ],
  },
  workers: {
    name: "workers",
    description: "outside herdr: each headless worker's state, turn, seconds since its last event, last tool, session and the path of its latest report; never its text; changes nothing",
    flags: [{ name: "--name", arg: "<name>", description: "only this worker (repeatable)", required: false, repeatable: true }],
  },
  stop: {
    name: "stop",
    description: "outside herdr: stop a headless worker through its own process (macOS and Linux: SIGTERM to the harness's process group, then SIGKILL if the harness has not gone; Windows: taskkill /T); never by a saved process id",
    flags: [{ name: "--name", arg: "<name>", description: "the worker", required: true }],
  },
  share: {
    name: "share",
    description: "write exactly what telemetry sends (no briefs or any text, nothing identifying) to a file you can read; sends nothing",
    flags: [
      { name: "--out", arg: "<file>", description: "where to write it", required: false, default: "routr-ledger-<date>.jsonl beside the ledger it reads" },
      { name: "--ledger", arg: "<path>", description: "ledger to read", required: false, default: "~/.local/share/routr/ledger.jsonl" },
    ],
  },
  telemetry: {
    name: "telemetry",
    description: "share anonymous outcomes (never text) once a day to help tune routr's questions: off unless you turn it on; `routr share` shows exactly what",
    args: [{ name: "status|on|off|send", description: "show the setting, turn it on or off, or send the new rows now (send --all: also rows from before telemetry started here)", required: false }],
    flags: [{ name: "--config", arg: "<path>", description: "config file that on/off writes", required: false, default: "~/.config/routr/config.json" }],
  },
  feedback: {
    name: "feedback",
    description: 'send the maintainers a note, in your words: routr feedback "what worked, what did not"',
    args: [{ name: '"<text>"', description: "what you want to tell them; sent with routr's version and your OS", required: true }],
    flags: [],
  },
  update: {
    name: "update",
    description: "replace this routr with the newest release on your update channel now (checksum verified) and reinstall the skill. routr also does this by itself in the background at most once a day; \"auto_update\": false in the config turns that off. The channel is a setting, stable unless you choose beta: routr setup --channel beta|stable",
    flags: [
      { name: "--check", description: "only say whether a newer release exists", required: false },
      { name: "--force", description: "install the channel's newest release even if this one is current or newer (back to stable from a beta)", required: false },
    ],
  },
  statusline: {
    name: "statusline",
    description: "a statusline command for Claude Code, optional: prints model and usage, and saves a usage snapshot routr uses while it is under 5 minutes old (routr reads Claude's own /usage otherwise). Setup no longer sets it",
    flags: [],
  },
  skill: {
    name: "skill",
    description: "`routr skill install` writes routr's two skills into ~/.agents/skills (read by Codex and Cursor) and links them into the skills folder of each other harness set up here (Claude Code, Kiro, Antigravity): the routr skill, and routr-orchestrate, which you type to start a session as the orchestrator (`/routr-orchestrate <plan>`; `$routr-orchestrate` in Codex). It replaces only routr's own copies: a skill or link of the same name that routr did not write is kept, and listed",
    args: [{ name: "install", description: "install or update the skills", required: true }],
    flags: [{ name: "--dry-run", description: "show where it would be written", required: false }],
  },
  key: {
    name: "key",
    description: "`routr key set [typesafe|cloudflare|otel-headers]` stores provider keys or OpenTelemetry headers. Provider keys (TypeSafe: an API key; Cloudflare: an API token with Workers AI Read, and your account ID) are typed with no echo (the account ID is shown), or piped one per line; saved owner-only beside any other provider's, then tested. With no provider, the first entry that needs a key (a local-only list needs none). A provider outside your decision list is named with a setup command to add it; the list stays as it is. Ollama needs no key. otel-headers takes one hidden or piped OTLP header list and makes no test call (docs/opentelemetry.md)",
    args: [{ name: "set", description: "store it in ~/.config/routr/env", required: true }, { name: "typesafe|cloudflare|otel-headers", description: "the provider (default: the first entry that needs a key), or OTLP authentication headers: comma-separated name=value pairs, percent-decoded once; saved without a test call, never printed", required: false }],
    flags: [{ name: "--no-verify", description: "skip the test call", required: false }],
  },
  setup: {
    name: "setup",
    description: "do what doctor says is missing: write your settings for the harnesses found, and choose a first decision model and optional backup, and ask for their keys. It leaves Claude Code's settings alone. At a terminal it is a guided screen (run again: a menu to change one thing; nothing is written until you review it); an agent passes --yes. Run it again with a flag to change one setting",
    flags: [
      { name: "--yes", description: "ask nothing: take the defaults and the flags given (the way an agent runs it)", required: false },
      { name: "--model", arg: "<subscription>=<model id>", description: "your everyday model on a subscription, from the harness's live list (Claude Code also takes a model's full name, which it does not list); repeatable. Also changes it on an existing config", required: false, repeatable: true },
      { name: "--use", arg: "<subscription>=normal|fallback", description: "normal: consider for everyday work; fallback: when normal accounts cannot suitably take it. Independent of billing; repeatable", required: false, repeatable: true },
      { name: "--metered", arg: "<subscription>=after|with", description: "legacy metered setting: after sets fallback use, with sets normal use; --use wins when both are given. Remaining budget stays unknown", required: false, repeatable: true },
      { name: "--hardest", arg: "<subscription>=basic|standard|strong", description: `${HARDEST.flag}: basic, standard, or strong; repeatable. Also changes it on an existing config`, required: false, repeatable: true },
      { name: "--reserve", arg: "<subscription>=<share>", description: `${RESERVE.flag}; repeatable. Also changes it on an existing config`, required: false, repeatable: true },
      { name: "--effort", arg: "<subscription>=<level>", description: "your everyday effort there, one of the levels the harness takes for that model (Kiro: auto leaves it to the model); repeatable", required: false, repeatable: true },
      { name: "--enable", arg: "<subscription>", description: "let routr hand work to this subscription again (it kept its settings while off); repeatable", required: false, repeatable: true },
      { name: "--disable", arg: "<subscription>", description: "turn a subscription off: routr gives it no work, and it keeps its settings; repeatable", required: false, repeatable: true },
      { name: "--channel", arg: "stable|beta", description: "which releases updates install: stable (the default), or beta for beta and release-candidate builds too (a newer stable release still wins). Read by `routr update` and the daily update; nothing moves you back to an older stable by itself", required: false },
      { name: "--otel-endpoint", arg: "<url>", description: "turn on OpenTelemetry export to your endpoint (https, or http on loopback; no userinfo or query). Fresh consent every time. Only when the person asks; --yes alone never enables it. No spans yet: docs/opentelemetry.md", required: false },
      { name: "--otel-off", description: "turn OpenTelemetry export off; the detached sender removes old batches. Cannot be combined with --otel-endpoint", required: false },
      { name: "--decision", arg: "<provider>[:<model>],...", description: "ordered decision models (for example typesafe,cloudflare:clef-flash); first answer wins. Local Ollama models run after all hosted entries because they may need to load. Hosted attempts have an 8 s cut within one overall deadline (10 s hosted-only, 30 s with local). Choices: typesafe (Jev, the default), cloudflare (Clef on your Cloudflare account; cloudflare:clef-flash is its smaller model), or ollama (Clef Flash on this machine, free). Only models routr has measured (docs/evidence.md); the key is set apart, by the person, with routr key set", required: false },
      { name: "--show", arg: null, description: "print your settings and OpenTelemetry delivery status as routr reads them, and change nothing (asks no harness)", required: false },
      { name: "--no-statusline", description: "does nothing: setup no longer sets Claude's statusline (accepted for older scripts)", required: false },
      { name: "--force", description: "rewrite an existing config (the old one is kept as config.json.bak)", required: false },
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--json", arg: null, description: "output JSON instead of text", required: false, default: false },
    ],
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
  },
  doctor: {
    name: "doctor",
    description: "test every decision-list entry in order, showing which answer and each failure; check harnesses and settings and list what to do next; changes nothing",
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--json", arg: null, description: "output JSON instead of text", required: false, default: false },
      { name: "--fix", arg: null, description: "do what can be done of the next steps: the same as `routr setup` (takes its flags, such as --yes)", required: false, default: false },
    ],
  },
  check: {
    name: "check",
    description: "a quick first read of a worker's report (writes nothing); you remain the judge; unavailable names an unreadable brief/report or the attempted decision model and its failure",
    flags: [
      { name: "--brief", arg: "<file>", description: "path to task brief file", required: true },
      { name: "--report", arg: "<file>", description: "path to worker report file", required: true },
    ],
  },
  record: {
    name: "record",
    description: "append what you chose and how it turned out to the ledger; next integrates and cleans up only for done with check pass, otherwise sends back or escalates, and always includes a template to revise this run with absolute advice, task and ledger paths",
    flags: [
      { name: "--task-file", arg: "<path>", description: "compare this worker’s task with the advice before appending; omit only for inline tasks, or revisions when the original file is gone (say so in --note)", required: false },
      { name: "--subscription", arg: "<name>", description: `subscription used (${KINDS.join(", ")})`, required: true },
      { name: "--model", arg: "<name>", description: "model chosen", required: true },
      { name: "--effort", arg: "<level>", description: "reasoning effort chosen. On Claude, Codex and Kiro, \"default\" is recorded as your configured default_effort; on Cursor and Antigravity, \"default\" is recorded as the effort word at the end of the model id, or just before a last qualifier (grok-4.7-high, grok-4.6-high-fast). Otherwise it is kept as written; chose.effort_from records which", required: true },
      { name: "--verdict", arg: "<done|partial|blocked>", description: "worker outcome verdict", required: true },
      { name: "--check", arg: "<pass|fail|none>", description: "verification outcome", required: true },
      { name: "--advice", arg: "<file>", description: "path to advice JSON file (or pipe on stdin)", required: false, default: "stdin" },
      { name: "--report", arg: "<file>", description: "path to worker report file", required: false },
      { name: "--subagent", arg: '"<subtask> → <level advised> → <model chosen>"', description: "subagent sizing decision", required: false, repeatable: true },
      { name: "--level", arg: "<level>", description: "actual work level chosen (basic, standard, strong); supply explicitly, even when unchanged. A larger model alone does not change the work level", required: false, default: "advised level" },
      { name: "--seconds", arg: "<n>", description: "elapsed seconds from handoff through verification (or stopping); omit when unknown", required: false },
      { name: "--attempts", arg: "<n>", description: "positive count of worker attempts; activity, not a quality score. Omit when unknown", required: false },
      { name: "--cause", arg: "<execution|brief|scope|review|launch|unknown|none>", description: "why extra work occurred, including lead corrections; repeatable, local only. none means no extra work and must be used alone", required: false, repeatable: true },
      { name: "--run-id", arg: "<run_id>", description: "revise an existing run using the run_id field from record's earlier output, not id (the advice id); the row's run_id is also in the ledger. Use next's revision template with the original advice and updated outcome. Omitted note and subagent data are preserved. Otherwise records a new worker run. Local only", required: false },
      { name: "--project", arg: "<name>", description: "label for the row (default: the git repository's folder name; kept local, never shared)", required: false },
      { name: "--note", arg: "<text>", description: "note explaining choice or outcome", required: false },
      { name: "--ledger", arg: "<path>", description: "path to ledger file", required: false, default: "~/.local/share/routr/ledger.jsonl" },
    ],
  },
  assess: {
    name: "assess",
    description: "verified outcomes, correction causes and capacity observations from your ledger; explicit run revisions counted once",
    flags: [
      { name: "--ledger", arg: "<path>", description: "path to ledger file", required: false, default: "~/.local/share/routr/ledger.jsonl" },
    ],
  },
};

export function formatCommandSynopsis(cmd) {
  const parts = [`routr ${cmd.name}`];
  for (const flag of cmd.flags ?? []) {
    const str = flag.arg ? `${flag.name} ${flag.arg}` : flag.name;
    if (flag.required === true) {
      parts.push(str);
    } else if (flag.repeatable) {
      parts.push(`[${str}]...`);
    } else {
      parts.push(`[${str}]`);
    }
  }
  if (cmd.args) {
    for (const arg of cmd.args) {
      parts.push(arg.required === false && !arg.name.startsWith("[") ? `[${arg.name}]` : arg.name); // an optional word is bracketed, as a flag is
    }
  }
  return parts.join(" ");
}

export function formatUnknownUsage() {
  return Object.values(COMMANDS)
    .map((cmd, i) => (i === 0 ? "usage: " : "       ") + formatCommandSynopsis(cmd))
    .join("\n");
}

export function formatTopLevelHelp() {
  const maxCmdLen = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const lines = [
    DESCRIPTION,
    "",
    "usage: routr <command> [options]",
    "       routr [--help | -h]",
    "       routr --version",
    "",
    "commands:",
    ...Object.values(COMMANDS).map((cmd) => `  ${cmd.name.padEnd(maxCmdLen + 3)}${cmd.description}`),
    "",
    "flags:",
    "  --help, -h   print help",
    "  --version    print version",
    "",
    "Run 'routr <command> --help' for details on each command.",
  ];
  return lines.join("\n");
}

export function formatCommandHelp(cmd) {
  const lines = [
    `routr ${cmd.name}: ${cmd.description}`,
    "",
    `usage: ${formatCommandSynopsis(cmd)}`,
  ];
  if (cmd.args?.length) {
    const maxArgLen = Math.max(12, ...cmd.args.map((a) => a.name.length));
    lines.push("", "arguments:");
    for (const arg of cmd.args) {
      const req = typeof arg.required === "string" ? ` (${arg.required})` : arg.required ? " (required)" : "";
      const def = arg.default !== undefined ? ` (default: ${arg.default})` : "";
      lines.push(`  ${arg.name.padEnd(maxArgLen + 2)}${arg.description}${req}${def}`);
    }
  }
  {
    const flagStrs = (cmd.flags ??= []).map((f) => (f.arg ? `${f.name} ${f.arg}` : f.name));
    const maxFlagLen = Math.max(12, "--help, -h".length, ...flagStrs.map((s) => s.length));
    lines.push("", "flags:");
    for (let i = 0; i < cmd.flags.length; i++) {
      const flag = cmd.flags[i];
      const flagStr = flagStrs[i];
      const req = typeof flag.required === "string" ? ` (${flag.required})` : flag.required ? " (required)" : "";
      const def = flag.default !== undefined ? ` (default: ${flag.default})` : "";
      lines.push(`  ${flagStr.padEnd(maxFlagLen + 2)}${flag.description}${req}${def}`);
    }
    lines.push(`  ${"--help, -h".padEnd(maxFlagLen + 2)}print this help`);
  }
  return lines.join("\n");
}
