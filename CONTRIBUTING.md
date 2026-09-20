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
take do not (see the evidence).

## Changing a harness recipe

`skills/routr/references/harnesses.md` and `lib/harness.mjs` record flags and failure modes that were observed, not
read from documentation. Say which version of the harness you ran and what you saw.

## Testing an install

Test installs against a **clean clone**, in a throwaway home (`HOME=$(mktemp -d)`), never against your working
checkout. `claude plugin marketplace add <folder>` and `skills add <folder>` copy the folder as it is on disk,
including untracked files such as a `.env` holding your key. Installs from GitHub only ever see tracked files.

## Tests

    bun test

Tests cover the pure parts: reading answers into advice, ranking subscriptions, the ledger, help text, and the
launch planner. Nothing in the test suite calls a model or a harness.
