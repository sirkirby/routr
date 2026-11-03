// The usage boundary's vocabulary, shared by live readers and the snapshot writer/reader. Outside exception and
// screen text never supplies a sentence. Unknown failures are read_failed; no caller parses a note to classify one.
import { warning } from "./warnings.mjs";
export const USAGE_FAILURES = Object.freeze({
  herdr_missing: "The screen usage reader needs herdr installed on PATH.",
  open_once: "Open the harness once to finish its first-run screens, then retry the usage read.",
  limit_unverified: "The usage or sign-in answer no longer confirms whether the limit reader applies.",
  command_shadowed: "A user command replaces the built-in usage command, or the built-in menu entry could not be confirmed; routr will not run it because that could spend usage.",
  internal_error: "An internal error stopped routr from ranking usage.",
  read_failed: "routr could not read this usage source.",
  no_response: "The usage source did not answer.",
  invalid_response: "The usage source returned a reply routr cannot read.",
  private_folder: "routr could not make a private folder for the usage read.",
  source_missing: "No usage reader is available for this subscription.",
  // Launch says the same of a work folder (herdr's CMD_PATH); here it applies to actual typed arguments.
  cmd_path: "The pane shell is cmd, which expands % and ! in typed arguments even inside quotes. Set TEMP to a safe path for temporary reads; otherwise use a path without those characters, or a PowerShell pane when the reader uses your shell settings.",
});
export const usageFailure = (code, label) => {
  code = typeof code === "string" && Object.hasOwn(USAGE_FAILURES, code) ? code : "read_failed";
  return { code, why: `${label && ["herdr_missing", "open_once"].includes(code) ? `${label}: ` : ""}${USAGE_FAILURES[code]}` };
};
const limitUnseen = "The limit cannot be seen, so routr will not stop at it.";
export const usageUnavailable = (rows) => rows.filter((r) => r.failure && r.signedIn !== false && (r.limitReader || r.headroom == null || r.kept))
  .map((r) => {
    const failure = usageFailure(r.failure.code, r.label);
    return { part: "usage", subscription: r.pool, source: r.source, ...failure,
      ...(r.limitReader ? { why: `${failure.why} ${r.headroom == null ? limitUnseen : "The current limit could not be read; routing uses the kept reading."}` } : {}),
      reading: r.kept ? "kept" : r.limitReader ? r.class === "metered" ? "metered" : "unknown" : "assumed", ...(r.kept ? { reading_source: r.kept.source, age_sec: r.kept.ageSec } : {}) };
  });

// A reader that has not produced a reading for over a day and failed its last try: said in `warnings`, not only in a
// row's note. From the herdr 0.9.5 change of 2026-10-22: Cursor's reader failed on every try, ranking ran on the
// assumed headroom, and the only trace was a note inside a ranked row for 89 hours.
export const STALE_SEC = 24 * 3600;
// A metered seat has no capacity reading to make unless an applicable limit reader failed. That failure must
// remain visible, including when it never succeeded; its first consecutive failure dates the warning.
export const staleReaders = (rows, config = {}) => rows
  .filter((r) => r.failure && r.signedIn !== false && r.headroom == null && (r.limitReader
    ? (r.failureAgeSec ?? r.ageSec) >= STALE_SEC
    : r.class !== "metered" && config.subscriptions?.[r.pool]?.billing !== "metered" && r.ageSec != null && r.ageSec >= STALE_SEC))
  .map((r) => ({ pool: r.pool, warning: warning("usage_stale", r.limitReader
    ? `${r.pool}'s spend limit reader has failed for ${Math.round((r.failureAgeSec ?? r.ageSec) / 3600)} h (${r.failure.code}). ${limitUnseen}`
    : `${r.pool}'s usage has not been read for ${Math.round(r.ageSec / 3600)} h, and its last try failed (${r.failure.code}), so routing assumes its headroom: an update of ${r.pool} or herdr may have changed what routr reads`) }));

// Public background-only usage commands cannot force a refresh within their interval.
export const usageRetryText = (name, backgroundOnly = false) => backgroundOnly
  ? `Fix the reported cause and read capacity by hand. routr usage ${name} reports the saved reading; its detached refresh starts only when due, so repeating it within the interval does not retry now.`
  : `Try reading ${name}'s usage again.`;

// Shared by reader diagnostics and command next steps; never tucked into a ranked row's note.
export const USAGE_BY_HAND = {
  cursor: 'run `cursor-agent`, type /usage, read "Included N% used", and pass --headroom cursor=<1 - N/100>',
  kiro: 'run `kiro-cli chat --no-interactive /usage`, read "Credits (X of Y covered in plan)", and pass --headroom kiro=<1 - X/Y>',
  claude: 'open Claude Code and read /usage; for a spend limit read its percent used, then pass --headroom claude=<share left>',
  codex: 'open Codex and read /status, then pass --headroom codex=<share left>',
  agy: 'run `agy` and read /usage, then pass --headroom agy=<share left>',
};
