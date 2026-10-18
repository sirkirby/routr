// The boundary for commands handed back to a lead. This deliberately small alphabet has the same meaning in bash,
// PowerShell 5.1/7 and cmd. Backslashes need quotes for bash; adjacent or final ones change double-quote parsing.
export function commandLine(argv) {
  if (!argv.length || argv.some((w) => typeof w !== "string" || !/^[A-Za-z0-9_.\/:=@+\-,\\ ]+$/.test(w) || w.includes("\\\\") || w.endsWith("\\"))) return null;
  return argv.map((w) => /[ \\@,]/.test(w) ? `"${w}"` : w).join(" ");
}
export const runNext = (why, argv, stdout_to) => ({ kind: "run", why, argv, command: commandLine(argv), ...(stdout_to == null ? {} : { stdout_to }) });
export const doNext = (why, template) => ({ kind: "do", why, ...(template == null ? {} : { template }) });
// History is display only. Unlike next, it can describe commands with placeholders and redacted prompt lengths.
export const displayCommand = (argv) => argv.map((w) => commandLine([w]) ?? JSON.stringify(w)).join(" ");

export function recordNext(o, { adopted = false } = {}) {
  const unknown = adopted || (o.dryRun && o.pane) || !o.model;
  const argv = ["routr", "record", "--advice", o.advice,
    ...(o["task-file"] ? ["--task-file", o["task-file"]] : []), "--subscription", o.kind,
    "--model", unknown ? "<model>" : o.model,
    ...(unknown || o.effort ? ["--effort", unknown ? "<effort>" : o.effort] : []),
    "--level", "<level>", "--verdict", "<done|partial|blocked>", "--check", "<pass|fail|none>"];
  return doNext("Verify this worker's result, then fill this record template; add --note and --report.", argv.map((w) => commandLine([w]) ?? (/^<.*>$/.test(w) ? w : JSON.stringify(w))).join(" "));
}
