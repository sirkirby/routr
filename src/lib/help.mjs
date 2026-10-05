// Single source of truth for routr CLI commands, flags, descriptions, and help formatting.
import { HARDEST, RESERVE } from "./wording.mjs";
import { KINDS } from "./harnesses.mjs";
export const DESCRIPTION = "routr: quick, calibrated advice for an agent that is about to hand out work.";

export const COMMANDS = {
  subagent: {
    name: "subagent",
    description: "an agent is about to spawn a subagent → what the work demands",
    args: [
      { name: '"<brief>"', description: "task brief, word for word what the worker will get (or pipe it on stdin); a flag-like word given alone is set aside when stdin carries the brief, and is the brief otherwise", required: true },
    ],
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
    ],
  },
  dispatch: {
    name: "dispatch",
    description: "an orchestrator is about to launch a pane → work assessment plus eligible subscriptions and headroom; choose for quality, then compare capacity among suitable options",
    args: [
      { name: '"<brief>"', description: "task brief, word for word what the worker will get (or pipe it on stdin); a flag-like word given alone is set aside when stdin carries the brief, and is the brief otherwise", required: true },
    ],
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--headroom", arg: "<subscription>=<share>", description: "override a reading with usage you read yourself: the share left, 0.9 or 90% (not for a harness that is not signed in)", required: false, repeatable: true },
    ],
  },
  usage: {
    name: "usage",
    description: "what routr sees of each subscription's usage and how dispatch ranks it; changes nothing of yours. `routr usage cursor` takes a fresh reading of Cursor's own /usage screen now, in a private herdr session, and `routr usage kiro` runs Kiro's /usage now and deletes the empty session it leaves (routr otherwise does both in the background about once per working session)",
    args: [{ name: "[<subscription>]", description: "only this one; for cursor or kiro, read its /usage now (cursor needs herdr installed)", required: false }],
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--headroom", arg: "<subscription>=<share>", description: "usage you read yourself, as for dispatch (0.9 or 90%)", required: false, repeatable: true },
      { name: "--level", arg: "<basic|standard|strong>", description: "refresh eligible accounts for your chosen work level without reassessing the brief; unnamed usage only, once, without --background. Plain usage uses basic", required: false },
    ],
  },
  launch: {
    name: "launch",
    description: "start a worker, handle startup, and submit its task",
    flags: [
      { name: "--kind", arg: "<kind>", description: `harness kind (${KINDS.join(", ")})`, required: true },
      { name: "--name", arg: "<name>", description: "worker agent name ([a-z][a-z0-9_-]{0,31})", required: true },
      { name: "--model", arg: "<id>", description: "model id", required: "required unless --dry-run" },
      { name: "--cwd", arg: "<path>", description: "working directory", required: false, default: "." },
      { name: "--effort", arg: "<level>", description: "reasoning effort", required: false },
      { name: "--rules-file", arg: "<path>", description: "your process rules for the worker (what it may do, how to report, git steps): added after the task, and never read by routr, which judges only the task", required: false },
      { name: "--advice", arg: "<file>", description: "the advice file from `routr dispatch`: launch warns when it was given on a different text than this task", required: false },
      { name: "--pane", arg: "<id>", description: "existing herdr pane to run in: at a shell prompt, or with an agent of --kind already running in --cwd, idle or still starting, never working (it is adopted once ready, keeps its model and effort, and is sent the task)", required: false },
      { name: "--worktree", arg: "<branch>", description: "give the worker its own git worktree, opened as a workspace nested under the repo (the rule for workers)", required: false },
      { name: "--copy", arg: "<path>", description: "copy an untracked file or folder from the repo into the worktree (repeatable; with --worktree)", required: false, repeatable: true },
      { name: "--direction", arg: "<right|down>", description: "split direction", required: false, default: "right if wide else down" },
      { name: "--task", arg: "<text>", description: "task prompt string (mutually exclusive with --task-file)", required: false },
      { name: "--task-file", arg: "<path>", description: "file containing task prompt (mutually exclusive with --task)", required: false },
      { name: "--trust", arg: "<ask|auto>", description: "no longer used: routr answers no startup question (accepted so older launch lines still work)", required: false, default: "ask" },
      { name: "--timeout", arg: "<ms>", description: "readiness timeout in milliseconds", required: false, default: 120000 },
      { name: "--dry-run", arg: null, description: "plan commands without executing or writing files", required: false, default: false },
    ],
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
    description: "Claude Code's statusline command: prints model and usage, and saves the usage snapshot routr reads",
    flags: [],
  },
  skill: {
    name: "skill",
    description: "`routr skill install` writes the routr skill into ~/.agents/skills and links it for Claude Code",
    args: [{ name: "install", description: "install or update the skill", required: true }],
    flags: [{ name: "--dry-run", description: "show where it would be written", required: false }],
  },
  key: {
    name: "key",
    description: "`routr key set` stores your TypeSafe API key: typed with no echo (or piped in), saved owner-only, then tested",
    args: [{ name: "set", description: "store the key in ~/.config/routr/env", required: true }],
    flags: [{ name: "--no-verify", description: "skip the test call", required: false }],
  },
  setup: {
    name: "setup",
    description: "do what doctor says is missing: write your settings for the harnesses found, set Claude's usage statusline, ask for the key. At a terminal it is a guided screen (run again: a menu to change one thing; nothing is written until you review it); an agent passes --yes. Run it again with a flag to change one setting",
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
      { name: "--show", arg: null, description: "print your settings as routr reads them, and change nothing (asks no harness)", required: false },
      { name: "--no-statusline", description: "leave Claude Code's settings alone", required: false },
      { name: "--force", description: "rewrite an existing config (the old one is kept as config.json.bak)", required: false },
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--json", arg: null, description: "output JSON instead of text", required: false, default: false },
    ],
  },
  uninstall: {
    name: "uninstall",
    description: "remove routr from this machine: the binary, the skill, the cache, and its Claude statusline entry. Keeps your config, key, and ledger unless you say otherwise. Shows the plan and asks first",
    flags: [
      { name: "--purge", description: "also remove your config, TypeSafe key, and ledger", required: false },
      { name: "--yes", description: "ask nothing (needed when there is no terminal)", required: false },
      { name: "--dry-run", description: "show what would be removed and kept", required: false },
      { name: "--json", arg: null, description: "output JSON instead of text", required: false, default: false },
    ],
  },
  doctor: {
    name: "doctor",
    description: "check the setup and list what to do next; changes nothing",
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--json", arg: null, description: "output JSON instead of text", required: false, default: false },
      { name: "--fix", arg: null, description: "do what can be done of the next steps: the same as `routr setup` (takes its flags, such as --yes)", required: false, default: false },
    ],
  },
  check: {
    name: "check",
    description: "a quick first read of a worker's report (writes nothing); you remain the judge",
    flags: [
      { name: "--brief", arg: "<file>", description: "path to task brief file", required: true },
      { name: "--report", arg: "<file>", description: "path to worker report file", required: true },
    ],
  },
  record: {
    name: "record",
    description: "append what you chose and how it turned out to the ledger",
    flags: [
      { name: "--subscription", arg: "<name>", description: `subscription used (${KINDS.join(", ")})`, required: true },
      { name: "--model", arg: "<name>", description: "model chosen", required: true },
      { name: "--effort", arg: "<level>", description: "reasoning effort chosen. On Claude, Codex and Kiro, \"default\" is recorded as your configured default_effort; on Cursor and Antigravity, none or \"default\" is recorded as the effort word at the end of the model id, or just before a last qualifier (grok-4.7-high, grok-4.6-high-fast). Otherwise it is kept as written; chose.effort_from records which", required: true },
      { name: "--verdict", arg: "<done|partial|blocked>", description: "worker outcome verdict", required: true },
      { name: "--check", arg: "<pass|fail|none>", description: "verification outcome", required: true },
      { name: "--advice", arg: "<file>", description: "path to advice JSON file (or pipe on stdin)", required: false, default: "stdin" },
      { name: "--report", arg: "<file>", description: "path to worker report file", required: false },
      { name: "--subagent", arg: '"<subtask> → <level advised> → <model chosen>"', description: "subagent sizing decision", required: false, repeatable: true },
      { name: "--level", arg: "<level>", description: "actual work level chosen (basic, standard, strong); supply explicitly, even when unchanged. A larger model alone does not change the work level", required: false, default: "advised level" },
      { name: "--seconds", arg: "<n>", description: "elapsed seconds from handoff through verification (or stopping); omit when unknown", required: false },
      { name: "--attempts", arg: "<n>", description: "positive count of worker attempts; activity, not a quality score. Omit when unknown", required: false },
      { name: "--cause", arg: "<execution|brief|scope|review|launch|unknown|none>", description: "why extra work occurred, including lead corrections; repeatable, local only. none means no extra work and must be used alone", required: false, repeatable: true },
      { name: "--run-id", arg: "<id>", description: "revise an existing run from record's returned run_id; supply its updated outcome. Omitted note and subagent data are preserved. Otherwise records a new worker run. Local only", required: false },
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
      parts.push(arg.name);
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
