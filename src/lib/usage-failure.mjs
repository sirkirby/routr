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

// Shared by reader diagnostics and command next steps; never tucked into a ranked row's note.
export const USAGE_BY_HAND = {
  cursor: 'run `cursor-agent`, type /usage, read "Included N% used", and pass --headroom cursor=<1 - N/100>',
  kiro: 'run `kiro-cli chat --no-interactive /usage`, read "Credits (X of Y covered in plan)", and pass --headroom kiro=<1 - X/Y>',
  claude: 'open Claude Code and read /usage, then pass --headroom claude=<share left>',
  codex: 'open Codex and read /status, then pass --headroom codex=<share left>',
  agy: 'run `agy` and read /usage, then pass --headroom agy=<share left>',
};
