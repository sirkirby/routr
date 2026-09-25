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
  `VERSION` / `CHECK_VERSION` in `src/lib/questions.mjs`. Public summary: `docs/evidence.md`.
- Jev is pinned to an exact version (`JEV_MODEL`), and the pin moves to each new official release once the model gate
  shows no question does worse (CONTRIBUTING.md). Never ship an alias.
- The advice commands (`subagent`, `dispatch`, `check`, `doctor`, `assess`) write nothing (`doctor --fix` is `setup`
  under another name) and fail open: any error
  still prints usable output and exits 0. Only `record`, `setup`, `uninstall`, `key set`, `skill install`, `share`, `update`, `telemetry on|off|send`,
  `feedback`, `launch`, and `usage cursor` act (the last two drive herdr panes), and each says so.
- Updates are automatic but never in the way: at most once a day a command may start a DETACHED updater and carry
  on. The command itself MUST NOT wait for it, make a network call for it, or change its own output because of it.
  The updater verifies the release checksum, swaps the binary in place, and reinstalls the skill; a run in progress
  keeps its binary. `"auto_update": false` turns it off. Never from a source checkout, never from `statusline`.
- Usage is re-read on every call and never cached. A reserve is never offered.
- Standard mechanisms only: skills, prompts, the harness's own CLI flags. No dependence on a harness's private
  environment variables or config internals beyond what `references/harnesses.md` records as observed.
- The code lives in `src/` and compiles into the binary. `skills/routr/` holds exactly what is installed for agents
  (`SKILL.md` and the guides) and no code.
- The binary is self-contained: the guides under `skills/routr/` are embedded at build time, and it MUST NOT depend on a repository checkout at run time. It reads the user's harness state read-only
  (usage sources, settings, model lists) and writes only under `~/.config/routr`, `~/.cache/routr`,
  `~/.local/share/routr`, the skill folders on `skill install`, and temporary files it removes. One exception:
  `setup` sets `statusLine` in `~/.claude/settings.json` when there is none, after a backup, and never replaces one; `uninstall` removes that
  entry again, and only that entry.
- No runtime dependencies. `node:` built-ins only, so the same source runs under Bun and compiles for every target.
- Works on macOS, Linux, and Windows: no shelling out to `sh`, no Unix-only paths in product code.
- Never print, log, or store a secret or the text of a brief. The ledger stores a hash and a length.
- Telemetry is OFF unless the person turns it on (`routr telemetry on`, or yes to setup's question, default no). An
  agent never turns it on for them. It sends ledger rows with no text of any kind, only from the detached daily job or
  `routr telemetry send`, and stays off under `ROUTR_TELEMETRY=0`, `DO_NOT_TRACK=1`, or CI. A new field in a sent row
  is a `docs/telemetry.md` change in the same PR.
  `routr feedback` is the only text sent, and only what the person typed.
- Claims in `README.md`, the guides, and `docs/evidence.md` are either measured or say they are not.

## Quality gates

- `bun test` MUST pass. Tests cover the pure parts and call no model and no harness.
- A change to the guides or the CLI surface updates `src/lib/help.mjs` (one table drives all help text) and the guide
  that mentions it; the launch prompt text in `references/orchestrator.md` is checked word for word by a test.
- Installs are tested from a clean clone into a throwaway `HOME`, never from a working checkout: installers copy
  untracked files, including `.env`.
- Before spending subscription usage on an eval or a worker run: one item as a smoke test, then watch the first
  results. Verify outcomes from transcripts and session files, not from an agent's own account.

## Releasing

Merging to `main` only runs tests. A release happens when a `vX.Y.Z` tag is pushed (`-alpha.N` / `-beta.N` / `-rc.N`
for a pre-release). The tag is the ONLY place a version is set: `src/lib/version.mjs`, `package.json`, and the
`version` line of `skills/routr/SKILL.md` stay `0.0.0-dev` in the repository and are stamped from the tag at build time.
Never commit a real version into them. Commit subjects become the release notes: write them for a user. Details: `CONTRIBUTING.md`.

## Working style

- Changes reach `main` by pull request from a branch, squash-merged. The PR title becomes the commit subject and a
  release-note line: write it for a user. `main` and the `v*` tags are protected by rulesets that the maintainer
  can bypass.
- An agent working for the maintainer MAY squash-merge its own pull request with the admin bypass
  (`gh pr merge <n> --squash --admin`) once all three test jobs are green. It MUST NOT use the bypass to push to
  `main` directly, to merge with a failing or pending check, or to move a release tag.
- After merging, the agent MAY cut a release by pushing a NEW `vX.Y.Z` tag, one above the latest release. It never
  moves or deletes an existing tag.
- Evals, tuning data, and working notes live in a separate private workbench, not here. This repo holds what ships.
- Match the surrounding code: dense, commented where a decision is non-obvious, with the measurement that justified
  it named in the comment.
- Prose for users and agents is plain and specific. No marketing claims routr cannot back with `docs/evidence.md`.
