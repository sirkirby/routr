// Single source of truth for routr CLI commands, flags, descriptions, and help formatting.
export const DESCRIPTION = "routr: quick, calibrated advice for an agent that is about to hand out work.";

export const COMMANDS = {
  subagent: {
    name: "subagent",
    description: "an agent is about to spawn a subagent → what the work demands",
    args: [
      { name: '"<brief>"', description: "task brief (or pipe on stdin)", required: true },
    ],
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
    ],
  },
  dispatch: {
    name: "dispatch",
    description: "an orchestrator is about to launch a pane → the same, plus subscriptions ranked by usable headroom",
    args: [
      { name: '"<brief>"', description: "task brief (or pipe on stdin)", required: true },
    ],
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--headroom", arg: "<subscription>=<0..1>", description: "caller-reported usage headroom", required: false, repeatable: true },
    ],
  },
  launch: {
    name: "launch",
    description: "start a worker, handle startup, and submit its task",
    flags: [
      { name: "--kind", arg: "<kind>", description: "harness kind (claude, codex, cursor, agy)", required: true },
      { name: "--name", arg: "<name>", description: "worker agent name ([a-z][a-z0-9_-]{0,31})", required: true },
      { name: "--model", arg: "<id>", description: "model id", required: "required unless --dry-run" },
      { name: "--cwd", arg: "<path>", description: "working directory", required: false, default: "." },
      { name: "--effort", arg: "<level>", description: "reasoning effort", required: false },
      { name: "--pane", arg: "<id>", description: "existing herdr pane id to run in", required: false },
      { name: "--worktree", arg: "<branch>", description: "give the worker its own git worktree, opened as a workspace nested under the repo (the rule for workers)", required: false },
      { name: "--direction", arg: "<right|down>", description: "split direction", required: false, default: "right if wide else down" },
      { name: "--task", arg: "<text>", description: "task prompt string (mutually exclusive with --task-file)", required: false },
      { name: "--task-file", arg: "<path>", description: "file containing task prompt (mutually exclusive with --task)", required: false },
      { name: "--trust", arg: "<ask|auto>", description: "folder trust policy", required: false, default: "ask" },
      { name: "--timeout", arg: "<ms>", description: "readiness timeout in milliseconds", required: false, default: 120000 },
      { name: "--dry-run", arg: null, description: "plan commands without executing or writing files", required: false, default: false },
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
  doctor: {
    name: "doctor",
    description: "check the setup; changes nothing",
    flags: [
      { name: "--config", arg: "<path>", description: "path to config file", required: false, default: "~/.config/routr/config.json" },
      { name: "--json", arg: null, description: "output JSON instead of text", required: false, default: false },
    ],
  },
  check: {
    name: "check",
    description: "a quick first read of a worker's report (pure); you remain the judge",
    flags: [
      { name: "--brief", arg: "<file>", description: "path to task brief file", required: true },
      { name: "--report", arg: "<file>", description: "path to worker report file", required: true },
    ],
  },
  record: {
    name: "record",
    description: "append what you chose and how it turned out to the ledger",
    flags: [
      { name: "--subscription", arg: "<name>", description: "subscription used (claude, codex, cursor, agy)", required: true },
      { name: "--model", arg: "<name>", description: "model chosen", required: true },
      { name: "--effort", arg: "<level>", description: "reasoning effort chosen", required: true },
      { name: "--verdict", arg: "<done|partial|blocked>", description: "worker outcome verdict", required: true },
      { name: "--check", arg: "<pass|fail|none>", description: "verification outcome", required: true },
      { name: "--advice", arg: "<file>", description: "path to advice JSON file (or pipe on stdin)", required: false, default: "stdin" },
      { name: "--report", arg: "<file>", description: "path to worker report file", required: false },
      { name: "--subagent", arg: '"<subtask> → <level advised> → <model chosen>"', description: "subagent sizing decision", required: false, repeatable: true },
      { name: "--level", arg: "<level>", description: "level chosen (basic, standard, strong)", required: false, default: "advised level" },
      { name: "--seconds", arg: "<n>", description: "duration in seconds", required: false },
      { name: "--attempts", arg: "<n>", description: "number of attempts", required: false, default: 1 },
      { name: "--note", arg: "<text>", description: "note explaining choice or outcome", required: false },
      { name: "--ledger", arg: "<path>", description: "path to ledger file", required: false, default: "~/.local/share/routr/ledger.jsonl" },
    ],
  },
  assess: {
    name: "assess",
    description: "what the ledger says: where a level looks too low or too high, and how usage moved",
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
