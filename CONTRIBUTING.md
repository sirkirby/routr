# Contributing

routr improves by pull request. It does not modify itself.

## Ground rules

- **Questions are about the work, never about models.** routr does not encode how good or how expensive a model is,
  and it never names one. Anything that would go stale with the next model release stays out, or becomes a plain
  user setting.
- **The agent decides.** routr advises the agent that asked; no code rule overrides it.
- **Measured, or marked unmeasured.** A claim in the guides or the README is backed by something in
  `docs/evidence.md`, or says plainly that it is not yet measured.
- **Standard mechanisms only**: skills, prompts, hooks. No dependence on a harness's private environment variables.
- **The advice commands stay side-effect free and fail open.** Only `record` writes to routr's state; only `launch`
  acts on panes.

## Changing a question

The question sets live in `skills/routr/scripts/lib/questions.mjs` and carry a version (`VERSION` for the advice,
`CHECK_VERSION` for the judge step). A wording change is a new version. In the pull request, say what you ran it
against (the briefs or reports, how they were labelled, by whom) and the result next to the old wording's result on
the same items. Narrow, literal questions about what a text states do well; questions that estimate what work will
take do not (see the evidence). TypeSafe's own agent skill (https://docs.typesafe.ai/agent-skill) is useful when you
design or debug a question. Users of routr do not need it: routr calls the API itself.

## Changing a harness recipe

`skills/routr/references/harnesses.md` and `lib/harness.mjs` record flags and failure modes that were observed, not
read from documentation. Say which version of the harness you ran and what you saw.

## Testing an install

Test installs against a **clean clone**, in a throwaway home (`HOME=$(mktemp -d)`), never against your working
checkout. `claude plugin marketplace add <folder>` and `skills add <folder>` copy the folder as it is on disk,
including untracked files such as a `.env` holding your key. Installs from GitHub only ever see tracked files.

## Building and releasing

The source is plain JavaScript under `skills/routr/scripts/`, run with Bun while developing
(`bun skills/routr/scripts/routr.mjs doctor`). Releases are standalone binaries built with `bun build --compile`.

Merging to `main` only runs the tests. **A release happens when a version tag is pushed, and only then:**

1. Set the new version in `skills/routr/scripts/lib/version.mjs`, the four plugin manifests (`plugin.json`,
   `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`), `package.json`, and the `version` line in
   `skills/routr/SKILL.md`. A test and the release workflow both refuse a mismatch. Merge that.
2. `git tag v0.2.0 && git push origin v0.2.0`. For a pre-release use `v0.2.0-rc.1` (`-alpha.N`, `-beta.N`, `-rc.N`);
   the files keep the base version `0.2.0`.

`.github/workflows/release.yml` then checks the tag against those files, runs the tests, builds the five binaries
(macOS ones on macOS, signed ad hoc, because Apple Silicon will not run an unsigned binary), and creates the GitHub
release with checksums, install commands, and a "What's Changed" list of the commit subjects since the previous
stable tag. Write commit subjects a user can read: they become the release notes. Pre-releases are marked as such
and are never "latest", so the install scripts ignore them unless `ROUTR_VERSION` names one. The guides are embedded
in the binary (`routr skill install`), so a guide change ships with the next release.

## Tests

    bun test

Tests cover the pure parts: reading answers into advice, ranking subscriptions, the ledger, help text, and the
launch planner. Nothing in the test suite calls a model or a harness.
