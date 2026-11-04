// Where a worker runs, decided here and nowhere else: launch asks, and what it returns is what anything later reads
// (traces, the launch index). Herdr's own session wins, as the lead is in it when both are set (the TUI started from a
// core terminal); anywhere else, a core terminal included, the worker runs headless. `kind` is the harness: none yet
// runs differently for its own sake. Whether a watch terminal shows a headless worker is presentation, not this decision
// (presenter-watch.mjs); what `cleanup --cwd` can see from where it is called is its own question, too.
export const executionFor = (env, kind) => (env.HERDR_ENV === "1" ? "pane" : "headless");
