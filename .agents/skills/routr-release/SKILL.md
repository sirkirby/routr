---
name: routr-release
description: Prepare, publish, or verify a release of the routr repository, including upgrade guidance, squash merge, version tagging, and published artifact checks. Use for routr maintainer releases, not updating an installed copy.
---

# Release routr

Work from the repository root. Read [AGENTS.md](../../../AGENTS.md), the release section of
[CONTRIBUTING.md](../../../CONTRIBUTING.md), and the current
[release workflow](../../../.github/workflows/release.yml) before choosing commands. These are the authority
for permissions, versioning and platform gates. Apply the user's existing authorization; a request to prepare
or review a release ends with a reviewable candidate, while an authorized release continues through publication
and verification. Do not turn skill creation or documentation work into a new release.

## Prepare the release

1. Refresh the worktree status, PR head and base, remote tags, and latest GitHub releases. Establish the exact
   changes being released and the requested version increment. Choose an unused tag above the latest relevant
   release; account for existing prereleases. Source version fields stay `0.0.0-dev`.
2. Read the release-note authoring requirements in CONTRIBUTING.md. Prepare `docs/releases/<exact-tag>.md`
   in a PR before tagging, including for prereleases. Cover the final release scope, user-visible behavior,
   configuration defaults and JSON compatibility. Commit titles supply the generated change list; this file
   supplies the explanation and upgrade steps. Ensure its tag matches the planned tag.
3. When new settings or configuration choices ship, recommend running `routr setup` after upgrading. It is the
   normal place to review existing choices, change one subscription or walk through everything. Explain what
   to review and which choices are preserved. Distinguish required migrations from this recommended review;
   backward compatibility is not a reason to discourage setup. Use flags as an alternative for choices already
   settled with the user. Ordinary review uses setup without `--force`.
4. Check README, INSTALL, affected docs, bundled agent guides and CLI help against actual behavior. Agent guides
   are embedded in the binary; repository edits reach installed users at the next release. Updates reinstall
   the bundled skill, but an agent that already loaded it may need to reread it or start a new session.
5. Run `bun test` and the applicable gates from AGENTS.md and CONTRIBUTING.md. Match smoke checks to the changed
   behavior. Test installs from a clean clone into a throwaway home. Keep the real user's settings, credentials,
   ledger and installed binary out of artifact tests. If a live worker/eval is needed, smoke one item first and
   verify transcripts. Report simulated inputs and unmeasured quality/cost/time claims explicitly.

Ready to merge means the release note file and relevant documentation are reviewed, the candidate is identified
by commit, and its required checks pass. A missing note is fixed in the PR before any tag is pushed.

## Merge and tag

Refresh the PR head and all three platform checks immediately before merging. Pending checks are not green.
Squash-merge the checked head with `gh pr merge <number> --squash --admin --match-head-commit <checked-sha>`
when permitted by AGENTS.md and the user's task. If the head changes, verify that head before proceeding.

Fetch the squash commit and verify its tree matches the reviewed candidate. If intervening base changes make
the trees differ, inspect the difference and verify the resulting candidate before tagging. Confirm the exact-tag
notes are present in that commit and the planned tag is still unused locally and remotely. Create a new annotated
tag pointing explicitly to that verified commit, then push that tag alone. Merging a PR does not publish a release.

Existing release tags are immutable: never move or delete one. If a release fails, inspect the failing job before
retrying. Retry the same commit only for a transient failure; a source correction goes through a PR and a new tag.
Do not rerun an already published release to edit prose: the workflow can replace assets. Edit its notes directly
with `gh release edit <tag> --notes-file <file>` and reconcile the versioned note in a PR when authorized.

## Verify publication

Follow the release workflow for the exact tag through completion. Confirm the expected platform artifacts,
macOS signing/notarization and stable-release Gatekeeper checks, native binary smoke jobs, checksums and the
GitHub release job. Keep CI proof distinct from local execution and from real worker behavior.

Read back the published release: correct tag/commit, stable or prerelease status, expected assets and the reviewed
notes included in the body. Download the matching native binary and SHA256SUMS to a temporary directory. Verify
its checksum, signature where applicable, reported version, and the affected CLI behavior. Use an isolated
HOME/USERPROFILE, disable updates and telemetry, and avoid inherited keys or access to installed harnesses.
Check embedded skill installation there when guides changed. A local ad-hoc build is not proof of the published
artifact's signature or notarization.

Finish with the PR and release links, commit/tag, tests and artifact checks actually completed, and any unresolved
limitations. State the recommended user upgrade action. Never claim publication from a successful tag push alone.
