// Where a worker runs, decided here and nowhere else: launch asks, and what it returns is what anything later reads
// (the worker's record, traces, the launch index). Herdr's own session wins, as the lead is in it when both are set (the
// TUI started from a core terminal); then a core terminal, where the harness runs for a person to see, in a terminal of
// its own; anywhere else it runs headless. The harness plays no part: what differs between harnesses in a core terminal
// is data in harnesses.mjs.
export const executionFor = (env) => (env.HERDR_ENV === "1" ? "pane" : env.HC_TERMINAL_ID ? "terminal" : "headless");
// Whether the caller is in a core terminal (the Herdr app) by the same rule. A few questions ask it for themselves
// rather than the backend a worker got: what `cleanup` can see of what runs in a folder, which core terminals finishing
// a worker checks, whether `watch` reports program status to its terminal, and doctor's report.
export const inCore = (env) => executionFor(env) === "terminal";
