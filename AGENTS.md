# routr — project rules

routr is a skill plus one standalone CLI that helps a lead coding agent hand work to workers on the user's own AI
subscriptions (Claude Code, Codex, Cursor, Antigravity, Kiro), inside herdr panes. A System One model answers fixed,
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
- The advice commands (`subagent`, `dispatch`, `check`, `doctor`, `assess`, `usage` with no name) write nothing of the
  user's (`doctor --fix` is `setup` under another name); the only thing they may start is one of routr's detached
  background jobs below (the updater, Cursor's and Kiro's usage refresh), which write only under `~/.cache/routr`. They fail open: any error
  still prints usable output and exits 0. Only `record`, `setup`, `uninstall`, `key set`, `skill install`, `share`, `update`, `telemetry on|off|send`,
  `feedback`, `launch`, `cleanup`, `usage cursor`, and `usage kiro` act, and each says so. `launch` drives panes in the user's herdr session;
  `cleanup` removes a worker's worktree (through herdr, or git when no workspace is open) or closes its pane, never
  while anything runs there or it cannot tell, never with `--force`, and never one holding uncommitted changes, files
  the worker made, files git is told not to check, or a commit no branch or tag holds (ignored files go with it, as
  with `git worktree remove`); it deletes a branch only when asked and `git branch -d` agrees it is merged;
  `usage cursor` drives only a private headless herdr session it makes and removes, never the user's own, and keeps
  the reading in `~/.cache/routr`. `usage kiro` runs Kiro's own `/usage` in the system temp folder and deletes the
  empty session that leaves with Kiro's own `--delete-session`, and keeps the reading in `~/.cache/routr`.
- Updates are automatic but never in the way: at most once a day a command may start a DETACHED updater and carry
  on. The command itself MUST NOT wait for it, make a network call for it, or change its own output because of it.
  The updater verifies the release checksum, swaps the binary in place, and reinstalls the skill; a run in progress
  keeps its binary. It follows the user's `update_channel` (stable, or beta: also `-beta.N` and `-rc.N`, never alpha) and
  never downgrades by itself. `"auto_update": false` turns it off. Never from a source checkout, never from `statusline`.
- Every call reads each usage source's newest reading and shows its age. Claude's is read in the call from its own
  `/usage`, hooks and MCP servers off; a statusline snapshot under 5 minutes old is used instead when one exists. Claude, Codex and
  Antigravity are read in the call (1 to 9 s, beside Jev). routr never has to own a harness feature (a statusline
  slot, a hook) to get its usage: it asks the harness's own CLI. Cursor's own screen takes seconds more and starts
  Cursor, and Kiro's `/usage` takes ~10 s plus its cleanup, so their readings are snapshots: when the last try is over
  4 hours old, a call starts a detached `routr usage cursor` (or `kiro`) to refresh it and carries on, as it does for the updater (unlike the updater, also from a
  source checkout: it swaps nothing). How usage is ranked:
  `docs/ranking.md`. A reserve is never offered.
- Installed is not enough: a harness is used only once its own status command (the registry's `auth`) says it is
  signed in. One that is not gets no model list, no usage read, no refresh, and no launch, because asking it anything
  else can open its sign-in in the user's browser. routr never starts a harness's sign-in; it says what to run.
- Standard mechanisms only: skills, prompts, the harness's own CLI flags. No dependence on a harness's private
  environment variables or config internals beyond what `references/harnesses.md` records as observed.
- The code lives in `src/` and compiles into the binary. `skills/` holds exactly what is installed for agents (the
  `routr` skill with its guides, and the user-invoked `routr-orchestrate`) and no code. Every skill is installed the
  same way: written to `~/.agents/skills` and linked into each harness's own skills folder (the registry's `skills`).
  Install and uninstall touch only what is provably routr's, by structure, never by reading a skill's text: a folder
  holding routr's manifest `.routr-install.json` (written in the same staged write as the skill, naming it and every
  file routr wrote), or a link to such a folder in `~/.agents/skills`. Nothing is written or removed through a link
  inside a skill folder. A folder above one may be a link (dotfiles), but a pre-manifest `routr` folder below a link
  is never adopted.
  Install leaves routr's folder as it is while it holds a file routr did not write, and says so; uninstall removes only
  the listed files and reports the rest. Known limit: routr trusts its manifest, so one the user copies into another
  folder makes routr treat that folder as its own.
- The binary is self-contained: the files under `skills/` are embedded at build time, and it MUST NOT depend on a repository checkout at run time. It reads the user's harness state read-only
  (usage sources, settings, model lists) and writes only under `~/.config/routr`, `~/.cache/routr`,
  `~/.local/share/routr`, the skill folders on `skill install`, the files `launch --copy` copies into a worker's
  worktree (which `cleanup` removes again only while they are unchanged), and temporary files it removes (including the private
  herdr session `usage cursor` makes, the empty Kiro session `usage kiro` deletes again, and the private folder each
  Claude `/usage` read runs in, with the empty `~/.claude/projects` folder Claude makes for it, removed after a normal
  exit; a timed-out read can leave that one empty folder). One exception:
  `uninstall` removes the `statusLine` entry an earlier routr's `setup` set in `~/.claude/settings.json`, after a
  backup, and only when it runs `routr statusline`.
- No runtime dependencies. `node:` built-ins only, so the same source runs under Bun and compiles for every target.
- Works on macOS, Linux, and Windows: no shelling out to `sh`, no Unix-only paths in product code. Every process
  routr starts directly goes through `src/lib/runtime.mjs`, which hides its console on Windows, gives harness reads
  an environment without herdr's pane variables, and on Windows resolves a command as the shell would, starting an
  npm `.cmd` shim's script directly.
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
- A change to what telemetry sends passes `bun test` (leaks out, values lost, the doc table, share's message in each
  state, and an end-to-end run against a mock endpoint) and `bun run smoke:telemetry` on an opted-in machine.
- Before spending subscription usage on an eval or a worker run: one item as a smoke test, then watch the first
  results. Verify outcomes from transcripts and session files, not from an agent's own account.

## Releasing

For release preparation, publication or verification, read [.agents/skills/routr-release/SKILL.md](.agents/skills/routr-release/SKILL.md).

Merging to `main` only runs tests. A release happens when a `vX.Y.Z` tag is pushed (`-alpha.N` / `-beta.N` / `-rc.N`
for a pre-release). The tag is the ONLY place a version is set: `src/lib/version.mjs`, `package.json`, and the
`version` lines of `skills/routr/SKILL.md` and `skills/routr-orchestrate/SKILL.md` stay `0.0.0-dev` in the repository and are stamped from the tag at build time.
Never commit a real version into them. Reviewed `docs/releases/<tag>.md` supplies upgrade guidance; commit subjects
supply the generated change list. Write both for a user. Details: `CONTRIBUTING.md`.

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
