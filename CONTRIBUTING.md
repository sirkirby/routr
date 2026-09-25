# Contributing

routr improves by pull request. It does not modify itself.

`main` is protected: changes arrive as pull requests, the tests must pass on Linux, macOS, and Windows, and the
maintainer (see `.github/CODEOWNERS`) reviews them. Pull requests are squash-merged, so the PR title becomes the
commit subject and, at the next tag, a line in the release notes: write it for a user.

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

The question sets live in `src/lib/questions.mjs` and carry a version (`VERSION` for the advice,
`CHECK_VERSION` for the judge step). A wording change is a new version. In the pull request, say what you ran it
against (the briefs or reports, how they were labelled, by whom) and the result next to the old wording's result on
the same items. Narrow, literal questions about what a text states do well; questions that estimate what work will
take do not (see the evidence). TypeSafe's own agent skill (https://docs.typesafe.ai/agent-skill) is useful when you
design or debug a question. Users of routr do not need it: routr calls the API itself.

## Moving to a new Jev version

routr asks an exact Jev version (`JEV_MODEL` in `src/lib/questions.mjs`), never an alias, because every result in
`docs/evidence.md` and every threshold routr applies was measured on that version. The pin is meant to move: TypeSafe
improves Jev often, and routr should run on the newest version that does at least as well.

1. The maintainers' workbench watches `jev-latest` and `jev-preview` daily and flags a version that differs from the pin.
2. The candidate is run side by side with the pinned version on the saved items behind the evidence (labelled briefs,
   worker reports, reviewer reports, repeated readings), and each question is compared: exact, under- and
   over-rating, how decisive the answers are, and stability. A candidate that does worse on any question is not taken
   until that question is re-worded or the regression is understood.
3. A version that passes moves the pin in a pull request that names the gate's result, updates `docs/evidence.md`, and
   ships in the next release. A preview is tested but not pinned until it becomes the official release.

`ROUTR_JEV_MODEL=<version or alias>` runs routr on another version without a release, for the gate and for trying a
preview on real work. Every ledger row records the version that answered (`jev_model`), so real outcomes can be compared
across versions.

## Changing what telemetry sends

Telemetry is opt-in and its promise is in [docs/telemetry.md](docs/telemetry.md). A change to `src/lib/telemetry.mjs`
must keep two failure modes out, and the tests check both: text getting OUT (every field is an exact list or a narrow
shape), and real values getting LOST (a value seen in real rows arriving as "other").

1. A new field changes the table in `docs/telemetry.md` in the same pull request (a test checks every field is listed).
2. A value seen in real use goes into `test/fixtures/seen-values.json` and the allowlist (a test checks it survives).
3. Re-read every message that describes sending (`share`, `telemetry status`, setup, doctor, installers) against
   what the code now does; a test covers `share` in each state.
4. Before release, on a machine that has opted in: `bun run smoke:telemetry`. It reads the real ledger, sends nothing,
   and fails on any value that would arrive as "other" or any string the endpoint would refuse.

## Changing a harness recipe

`skills/routr/references/harnesses.md` and `src/lib/harness.mjs` record flags and failure modes that were observed, not
read from documentation. Say which version of the harness you ran and what you saw.

## Testing an install

Test installs against a **clean clone**, in a throwaway home (`HOME=$(mktemp -d)`), never against your working
checkout. Tools that install from a folder copy it as it is on disk, including untracked files such as a `.env`
holding your key. The install scripts only ever download release assets.

## Building and releasing

The source is plain JavaScript under `src/`, run with Bun while developing
(`bun src/routr.mjs doctor`). Releases are standalone binaries built with `bun build --compile`.

Merging to `main` only runs the tests. **A release happens when a version tag is pushed, and only then:**

    git tag v0.2.0 && git push origin v0.2.0

For a pre-release use `v0.2.0-rc.1` (`-alpha.N`, `-beta.N`, `-rc.N`). The tag is the only place a version is set:
in the repository `src/lib/version.mjs`, `package.json`, and the `version` line in `skills/routr/SKILL.md` all read
`0.0.0-dev` (a test checks it), so there is nothing to bump before a release and nothing to write back after one.

`.github/workflows/release.yml` then checks the tag's form, runs the tests, stamps the tag's version into those three
files in each build (`scripts/stamp-version.mjs`; the skill and `package.json` get the base version `0.2.0`), builds the five binaries
(macOS ones on macOS, signed ad hoc, because Apple Silicon will not run an unsigned binary), and creates the GitHub
release with checksums, install commands, and a "What's Changed" list of the commit subjects since the previous
stable tag. Write commit subjects a user can read: they become the release notes. Pre-releases are marked as such
and are never "latest", so the install scripts ignore them unless `ROUTR_VERSION` names one. The guides are embedded
in the binary (`routr skill install`), so a guide change ships with the next release.

## Tests

    bun test

Tests cover the pure parts: reading answers into advice, ranking subscriptions, the ledger, help text, and the
launch planner. Nothing in the test suite calls a model or a harness.
