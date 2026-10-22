// The usage boundary's vocabulary, shared by live readers and the snapshot writer/reader. Outside exception and
// screen text never supplies a sentence. Unknown failures are read_failed; no caller parses a note to classify one.
export const USAGE_FAILURES = Object.freeze({
  internal_error: "An internal error stopped routr from ranking usage.",
  read_failed: "routr could not read this usage source.",
  no_response: "The usage source did not answer.",
  invalid_response: "The usage source returned a reply routr cannot read.",
  private_folder: "routr could not make a private folder for the usage read.",
  source_missing: "No usage reader is available for this subscription.",
});
export const usageFailure = (code) => {
  code = typeof code === "string" && Object.hasOwn(USAGE_FAILURES, code) ? code : "read_failed";
  return { code, why: USAGE_FAILURES[code] };
};
export const usageUnavailable = (rows) => rows.filter((r) => r.failure && r.signedIn !== false && (r.headroom == null || r.kept))
  .map((r) => ({ part: "usage", subscription: r.pool, source: r.source, ...usageFailure(r.failure.code),
    reading: r.kept ? "kept" : "assumed", ...(r.kept ? { reading_source: r.kept.source, age_sec: r.kept.ageSec } : {}) }));

// A reader that has not produced a reading for over a day and failed its last try: said in `warnings`, not only in a
// row's note. From the herdr 0.9.5 change of 2026-10-22: Cursor's reader failed on every try, ranking ran on the
// assumed headroom, and the only trace was a note inside a ranked row for 89 hours.
export const STALE_SEC = 24 * 3600;
// One that never read anything is already `assumed` in `unavailable`; this is for one that worked and stopped. A
// metered seat (said by its harness, or the user's `billing`) is ranked as unknown capacity, never assumed: it is not
// said here. Each is `{ pool, warning }`: the warning states what happened; trying again is a step in `next`.
export const staleReaders = (rows, config = {}) => rows
  .filter((r) => r.failure && r.signedIn !== false && r.headroom == null && r.class !== "metered" && config.subscriptions?.[r.pool]?.billing !== "metered"
    && r.ageSec != null && r.ageSec >= STALE_SEC)
  .map((r) => ({ pool: r.pool, warning: `${r.pool}'s usage has not been read for ${Math.round(r.ageSec / 3600)} h, and its last try failed (${r.failure.code}), so routing assumes its headroom: an update of ${r.pool} or herdr may have changed what routr reads` }));

// Shared by reader diagnostics and command next steps; never tucked into a ranked row's note.
export const USAGE_BY_HAND = {
  cursor: 'run `cursor-agent`, type /usage, read "Included N% used", and pass --headroom cursor=<1 - N/100>',
  kiro: 'run `kiro-cli chat --no-interactive /usage`, read "Credits (X of Y covered in plan)", and pass --headroom kiro=<1 - X/Y>',
  claude: 'open Claude Code and read /usage, then pass --headroom claude=<share left>',
  codex: 'open Codex and read /status, then pass --headroom codex=<share left>',
  agy: 'run `agy` and read /usage, then pass --headroom agy=<share left>',
};
