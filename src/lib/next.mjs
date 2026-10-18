// The boundary for commands handed back to a lead. Backslashes need quotes for bash; adjacent or final ones change
// double-quote parsing. PowerShell 5.1 also splits dotted/colon-bearing dash arguments unless quoted.
const safeWord = (w) => typeof w === "string" && /^[A-Za-z0-9_.\/:=@+\-,\\ ~]+$/.test(w) && !w.startsWith("~") && !w.includes("\\\\") && !w.endsWith("\\");
const needsQuotes = (w) => /[ \\@,~]/.test(w) || (w.startsWith("-") && (/[.:]/.test(w) || w === "--"));
const word = (w) => needsQuotes(w) ? `"${w}"` : w;
export function commandLine(argv) {
  // A quoted executable is a string in PowerShell, and an assignment is not an executable in bash.
  if (!argv.length || argv.some((w) => !safeWord(w)) || needsQuotes(argv[0]) || argv[0].includes("=")) return null;
  return argv.map(word).join(" ");
}
export const runNext = (why, argv, stdout_to) => ({ kind: "run", why, argv, command: commandLine(argv), ...(stdout_to == null ? {} : { stdout_to }) });
export const doNext = (why, template) => ({ kind: "do", why, ...(template == null ? {} : { template }) });
// History is display only. Unlike next, it can describe commands with redacted prompt lengths and shell syntax.
export const displayCommand = (argv) => argv.map((w) => safeWord(w) ? word(w) : JSON.stringify(w)).join(" ");
// Templates are instructions, not runnable strings. Never turn an unsafe path/model into an expanding double-quoted
// value: name the argument the lead must fill instead. Only our narrow placeholder alphabet passes through verbatim.
export const templateCommand = (argv) => argv.map((w, i) => /^<[A-Za-z0-9_| -]+>$/.test(w) ? w : safeWord(w) ? word(w)
  : `<${/^--[a-z][\w-]*$/.test(argv[i - 1] ?? "") ? argv[i - 1].slice(2) : `argument-${i + 1}`}>`).join(" ");

export function recordNext(o, { adopted = false } = {}) {
  const unknown = adopted || (o.dryRun && o.pane) || !o.model;
  const argv = ["routr", "record", "--advice", o.advice,
    ...(o["task-file"] ? ["--task-file", o["task-file"]] : []), "--subscription", o.kind,
    "--model", unknown ? "<model>" : o.model,
    ...(unknown || o.effort ? ["--effort", unknown ? "<effort>" : o.effort] : []),
    "--level", "<level>", "--verdict", "<done|partial|blocked>", "--check", "<pass|fail|none>"];
  return doNext("Verify this worker's result, then fill this record template; add --note and --report.", templateCommand(argv));
}

export function launchNext(next, { record, cleanup, adopted, attempted, planned }) {
  return [...next, ...(record && (planned || attempted) ? [recordNext(record, { adopted })] : []),
    ...(cleanup ? [runNext("After verification, finish this worker.", cleanup)] : [])];
}
