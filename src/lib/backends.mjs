// Where a worker runs, decided here and nowhere else: launch asks, and what it returns is what anything later reads
// (the worker's record, traces, the launch index). Herdr's own session wins, as the lead is in it when both are set (the
// TUI started from a core terminal); then a core terminal, where the harness runs for a person to see, in a terminal of
// its own; anywhere else it runs headless. `kind` is the harness: none yet runs differently for its own sake, and what
// differs between them in a core terminal is data in harnesses.mjs. Whether a watch terminal shows a headless worker is
// presentation, not this decision (presenter-watch.mjs); what `cleanup --cwd` can see from where it is called is its own
// question, too.
export const executionFor = (env, kind) => (env.HERDR_ENV === "1" ? "pane" : env.HC_TERMINAL_ID ? "terminal" : "headless");
