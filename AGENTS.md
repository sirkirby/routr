# routr — project rules

routr is a skill plus one standalone CLI that helps a lead coding agent hand work to workers on the user's own AI
subscriptions (Claude Code, Codex, Cursor, Antigravity), inside herdr panes. A System One model answers fixed,
measured questions about a brief or a worker report; code adds live usage; the lead agent decides. Plain JavaScript
(`.mjs`), developed with Bun, shipped as compiled binaries.

## Non-goals

- routr is NOT the judge. It advises; no code rule overrides the lead agent or the user's settings.
- It MUST NOT encode how good or how expensive any model is: no model names in advice, no cost formulas, no weights
  that go stale at the next model release. What varies by user is a plain setting in `~/.config/routr/config.json`.
- It does not estimate or manage context, proxy model traffic, or hold provider API keys. Workers are the harness
  CLIs the user already has installed and logged in.
- It is not a published package or a marketplace plugin. There is ONE install path: the install scripts, which
  download a release binary and have it install its own skill. Do not add a second one.

## Invariants

- Questions judge the WORK or the REPORT, never a model. They are narrow and literal, about what the text states.
- A question's wording changes only with a measurement against the old wording on the same items, and a bumped
  `VERSION` / `CHECK_VERSION` in `skills/routr/scripts/lib/questions.mjs`. Public summary: `docs/evidence.md`.
- The advice commands (`subagent`, `dispatch`, `check`, `doctor`, `assess`) write nothing and fail open: any error
  still prints usable output and exits 0. Only `record`, `key set`, `skill install`, `launch`, and `usage cursor` act (the last two drive herdr panes), and each says so.
- Usage is re-read on every call and never cached. A reserve is never offered.
- Standard mechanisms only: skills, prompts, the harness's own CLI flags. No dependence on a harness's private
  environment variables or config internals beyond what `references/harnesses.md` records as observed.
- The binary is self-contained: everything it needs lives under `skills/routr/` (the guides are embedded at build
  time), and it MUST NOT depend on a repository checkout at run time. It reads the user's harness state read-only
  (usage sources, settings, model lists) and writes only under `~/.config/routr`, `~/.cache/routr`,
  `~/.local/share/routr`, the skill folders on `skill install`, and temporary files it removes.
- No runtime dependencies. `node:` built-ins only, so the same source runs under Bun and compiles for every target.
- Works on macOS, Linux, and Windows: no shelling out to `sh`, no Unix-only paths in product code.
- Never print, log, or store a secret or the text of a brief. The ledger stores a hash and a length.
- Claims in `README.md`, the guides, and `docs/evidence.md` are either measured or say they are not.

## Quality gates

- `bun test` MUST pass. Tests cover the pure parts and call no model and no harness.
- A change to the guides or the CLI surface updates `lib/help.mjs` (one table drives all help text) and the guide
  that mentions it; the launch prompt text in `references/orchestrator.md` is checked word for word by a test.
- Installs are tested from a clean clone into a throwaway `HOME`, never from a working checkout: installers copy
  untracked files, including `.env`.
- Before spending subscription usage on an eval or a worker run: one item as a smoke test, then watch the first
  results. Verify outcomes from transcripts and session files, not from an agent's own account.

## Releasing

Merging to `main` only runs tests. A release happens when a `vX.Y.Z` tag is pushed (`-alpha.N` / `-beta.N` / `-rc.N`
for a pre-release); the version in `lib/version.mjs`, `package.json`, and the `version` line of
`skills/routr/SKILL.md` MUST match the tag's base version. Commit subjects become the release notes: write them for a user. Details: `CONTRIBUTING.md`.

## Working style

- Evals, tuning data, and working notes live in a separate private workbench, not here. This repo holds what ships.
- Match the surrounding code: dense, commented where a decision is non-obvious, with the measurement that justified
  it named in the comment.
- Prose for users and agents is plain and specific. No marketing claims routr cannot back with `docs/evidence.md`.
