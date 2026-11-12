// The boundary for commands handed back to a lead. Backslashes need quotes for bash; adjacent or final ones change
// double-quote parsing. PowerShell 5.1 also splits dotted/colon-bearing dash arguments unless quoted.
import { resolve } from "node:path";
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

// Causes are in both templates because a flag the template leaves out is a flag leads skip: on one ledger, 280 of 650
// runs (2026-11-12) were recorded with no cause at all. A revision carries the run's own causes and details, so revising
// it to say what changed keeps them.
const CAUSE_PLACEHOLDER = "<execution|brief|scope|review|launch|unknown|none>";
const CAUSE_HINT = "--cause none when there was no extra work; otherwise each cause, and --cause-detail <tag> in your own words for what kind it was.";
const causeWords = (o) => !Array.isArray(o.causes) ? ["--cause", CAUSE_PLACEHOLDER] : !o.causes.length ? ["--cause", "none"]
  : [...o.causes.flatMap((c) => ["--cause", c]), ...(o.cause_details ?? []).flatMap((d) => ["--cause-detail", d])];
export function recordNext(o, { adopted = false, undelivered = false, launchId = null } = {}) {
  const unknown = adopted || (o.dryRun && o.pane) || !o.model;
  const argv = ["routr", "record", "--advice", o.advice, ...(launchId ? ["--launch", launchId] : []),
    ...(o["task-file"] ? ["--task-file", o["task-file"]] : []), "--subscription", o.subscription ?? o.kind,
    "--model", unknown ? "<model>" : o.model,
    "--effort", unknown ? "<effort>" : o.effort ?? "default",
    "--level", "<level>", "--verdict", undelivered ? "blocked" : "<done|partial|blocked>", "--check", undelivered ? "none" : "<pass|fail|none>",
    "--cause", undelivered ? "launch" : CAUSE_PLACEHOLDER];
  return doNext(undelivered ? "No task was delivered. Record this launch as blocked with --check none and explain the launch failure in --note." : `Verify this worker's result, then fill this record template; add --note and --report. ${CAUSE_HINT}`, templateCommand(argv));
}

export function recordRevisionNext(o, entry, ledger) {
  const argv = ["routr", "record", "--advice", o.advice != null ? resolve(o.advice) : "<advice-file>",
    ...(o.task_file != null ? ["--task-file", resolve(o.task_file)] : []), "--subscription", entry.chose.subscription,
    "--model", entry.chose.model, "--effort", entry.chose.effort, "--level", entry.chose.level,
    "--project", entry.project, ...(entry.launch_id ? ["--launch", entry.launch_id] : []), "--ledger", resolve(ledger), "--run-id", entry.run_id,
    "--verdict", "<done|partial|blocked>", "--check", "<pass|fail|none>", ...causeWords(entry.outcome), "--note", "<note>"];
  return doNext(`To revise this worker's outcome, fill this template with the updated verdict, check and note, and change the causes if they changed; use the original advice file. ${CAUSE_HINT}`, templateCommand(argv));
}

export function launchNext(next, { record, cleanup, adopted, attempted, planned, submitted, failed, launchId = null }) {
  return [...next, ...(record && (planned || attempted) ? [recordNext(record, { adopted, launchId, undelivered: failed && attempted && !submitted && !planned })] : []),
    ...(cleanup ? [runNext("After verification, finish this worker.", cleanup)] : [])];
}
