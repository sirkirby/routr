// What a launch says, whichever backend ran it: launch and each backend write its answer through these.

// A launch that failed, said the one way in launch's answer: `submitted` when its prompt had been tried by then.
export function launchFailed(out, e, submitted) {
  out.ok = false; out.state = "failed"; out.error = `${submitted ? "Launch failed after prompt submission: " : ""}${String(e?.message ?? e)}`;
  out.steps.push({ step: "failed", ok: false, detail: out.error });
}
