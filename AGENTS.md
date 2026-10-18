# routr — project rules

routr is a skill plus one standalone CLI that helps a lead coding agent hand work to workers on the user's own AI
subscriptions (Claude Code, Codex, Cursor, Antigravity, Kiro), inside herdr panes. A System One model answers fixed,
measured questions about a brief or a worker report; code adds live usage; the lead agent decides. Plain JavaScript
(`.mjs`), developed with Bun, shipped as compiled binaries.

## Non-goals

- routr is NOT the judge. It advises; no code rule overrides the lead agent or the user's settings.
- It MUST NOT encode how good or how expensive any model the work goes to is: no model names in advice, no cost
  formulas, no weights that go stale at the next model release. What routr's own decision models were measured to do
  is in `docs/evidence.md`, with a date, and their prices nowhere else. What varies by user is a plain setting in
  `~/.config/routr/config.json`.
- It does not estimate or manage context, proxy model traffic, or hold provider API keys for workers. Workers are the
  harness CLIs the user already has installed and signed in.
- There is ONE install path: the install scripts, which download a release binary that installs its own skill. Not a
  published package, not a marketplace plugin. Do not add a second one.

## Invariants

What each of these means on a user's machine, in full, is `docs/guarantees.md`. A change to any of them updates that
page and its tests in the same PR.

- Questions judge the WORK or the REPORT, never a model: narrow and literal, about what the text states. A question's
  wording changes only with a measurement against the old wording on the same items and a bumped question-set
  version. Public summary: `docs/evidence.md`.
- A decision model is pinned as exactly as its provider allows, never by an alias, and offered only with a profile
  measured by the model gate (CONTRIBUTING.md). Where a provider cannot version its models, `docs/evidence.md` says so
  and the gate is re-run. What differs between providers lives in the provider boundary and nowhere else.
- The advice commands change nothing of the user's and fail open: any error still prints usable output and exits 0.
  A command that acts says what it did.
- routr removes only what it has checked is its own and safe to remove, and says what its checks cannot see. When
  it cannot tell, it stops and says what to do; it never forces.
- Nothing waits on background work: the updater and slow usage refreshes run detached, and a command never waits for
  them or makes a network call for them. It may report what they last did.
- A harness is used only once its own status command says it is signed in. routr never starts a sign-in.
- routr gets what it needs from a harness through standard mechanisms (skills, prompts, the harness's own CLI). It
  never takes over a harness feature (a statusline slot, a hook) and depends on no private internals beyond what
  `references/harnesses.md` records as observed.
- The binary is self-contained (no repository checkout at run time) and has no runtime dependencies (`node:`
  built-ins only). It runs on macOS, Linux and Windows. It starts its own processes directly, never through `sh`; in
  a pane, it types commands for that pane's own shell.
- routr writes only in its own folders and what a command was asked to write.
- A brief goes only to the decision model and the worker it is for, and a key only to its provider. Neither is ever printed, logged, or put
  in the ledger or telemetry.
- Telemetry is OFF unless the person turns it on; an agent never turns it on for them. A new field in a sent row is a
  `docs/telemetry.md` change in the same PR.
- Claims in `README.md`, the guides, and `docs/evidence.md` are either measured or say they are not.

## Design

- One module owns each outside boundary: the processes routr starts, the decision-model providers, the commands
  routr hands back to an agent. Text from outside (a provider's reply, a harness's output, a pane's screen) is
  classified there into what routr knows how to say. It reaches output only where a command's contract names it (a
  pane's screen shown to the lead when a worker needs input), and MUST NOT reach the ledger or telemetry.
- Fix the pattern, not the instance. A bug found in one harness, provider or command is fixed in the shared code
  they all go through, after checking every place with the same shape; where no shared code exists, make it.
- Each command has a documented contract: the inputs it requires, the ones it only uses when given, and the fields
  it returns. A field that means the same thing has one name in every command, and a new field follows those names.
- A contract and its tests change together. Do not keep an old field or flag beside its replacement: the binary and
  the guides ship and update together.
- An input a command is only correct with is a required input: the command refuses without it. Failing open covers
  the advice commands' output, never a skipped required input.
- Rules and guides name concepts, not source files: a source path in prose goes stale when the code moves.

## Quality gates

- `bun test` MUST pass. Tests cover the pure parts and call no model and no harness.
- A rule that holds everywhere (no secret, no brief text) has a test that checks the whole output of every command,
  not one call site.
- A change to the guides or the CLI surface updates the one table that drives all help text and the guide that
  mentions it. The launch prompt in the orchestrator guide is checked word for word by a test.
- Installs are tested from a clean clone into a throwaway `HOME`, never from a working checkout: installers copy
  untracked files, including `.env`.
- A change to what telemetry sends passes `bun test` and `bun run smoke:telemetry` on an opted-in machine.
- Before spending subscription usage on an eval or a worker run: one item as a smoke test, then watch the first
  results. Verify outcomes from transcripts and session files, not from an agent's own account.

## Releasing

For release preparation, publication or verification, read [.agents/skills/routr-release/SKILL.md](.agents/skills/routr-release/SKILL.md).

Merging to `main` only runs tests. A release happens when a `vX.Y.Z` tag is pushed (`-alpha.N` / `-beta.N` / `-rc.N`
for a pre-release). The tag is the ONLY place a version is set: the repository's version fields stay `0.0.0-dev` and
are stamped from the tag at build time (CONTRIBUTING.md lists them). Never commit a real version. Reviewed
`docs/releases/<tag>.md` supplies upgrade guidance; commit subjects supply the generated change list. Write both for
a user. `CHANGELOG.md` is the short history beside them: a pull request with a user-facing change adds one line for it under Unreleased, with its PR number; a stable
release moves those lines into a new `## vX.Y.Z — YYYY-MM-DD` section linking its notes file, and leaves an empty
Unreleased above it; pre-releases stay under Unreleased. The release workflow refuses a stable tag
without its section.

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
- Match the surrounding code's style: dense, commented where a decision is non-obvious, with the measurement that
  justified it named in the comment. Match its style, not its mistakes: when nearby code breaks a Design rule, fix
  the shared piece instead of copying it.
- Prose for users and agents is plain and specific. No marketing claims routr cannot back with `docs/evidence.md`.
