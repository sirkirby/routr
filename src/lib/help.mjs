// Help text for routr and each of its commands, formatted from the command table: `routr --help`, `routr <command>
// --help`, and the usage an unknown command line gets.
import { COMMANDS } from "./command-table.mjs";

export const DESCRIPTION = "routr: quick, calibrated advice for an agent that is about to hand out work.";

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
