// Where a worker runs, decided here and nowhere else: launch asks, and what it returns is what anything later reads
// (traces, the launch index). Herdr's own session wins, as the lead is in it when both are set (the TUI started from a
// core terminal); anywhere else, a core terminal included, the worker runs headless. `kind` is the harness: none yet
// runs differently for its own sake. Whether a watch terminal shows a headless worker is presentation, not this decision
// (presenter-watch.mjs); what `cleanup --cwd` can see from where it is called is its own question, too.
export const executionFor = (env, kind) => (env.HERDR_ENV === "1" ? "pane" : "headless");

// A launch that failed, said the one way in launch's answer: `submitted` when its prompt had been tried by then.
export function launchFailed(out, e, submitted) {
  out.ok = false; out.state = "failed"; out.error = `${submitted ? "Launch failed after prompt submission: " : ""}${String(e?.message ?? e)}`;
  out.steps.push({ step: "failed", ok: false, detail: out.error });
}
