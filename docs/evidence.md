# What is measured

routr's claims rest on small evals run while it was built (2026-09). Sample sizes are small and most labels were
written by the people building it; each entry says so. "Jev" is TypeSafe's System One model, pinned at `jev-1.13.0`.

## Reading a brief

| Question | Ground truth | Result |
|---|---|---|
| Are narrow facts about a brief decisive? | 68 briefs: 28 written fixtures, 35 real prompts from the author's history, 5 real investigation briefs. Decisive = answer below 0.2 or above 0.8 | Facts stated in the brief: 63-88% decisive (says how to check 88%, names the location 84%, concurrency or data 79%, approach open 68%, cause unknown 66%, hard to reverse 65%, cross-cutting 63%). Estimates of what the work will take: 22-43% (wide search, whole picture, broad context, long iteration). routr asks the first kind only |
| Is the read the same every time? | 12 briefs × 5 repeats | 107 of 108 fact readings identical; largest swing in a probability 0.06; level identical 11/12 |
| Is the one-word level reliable? | the same 68 briefs, labels by the builders | 54/68 exact, 13 over, 1 under. Confidence is informative: 89% correct at ≥ 0.8, 56% below 0.5. Rounding up when unsure fixed nothing and only over-rated. A level derived by rule from the facts did no better (52/68) |
| Does the level separate work that needs a stronger model? | 5 real read-only investigations run on a mid and a top model, judged blind by a third | The top model clearly won 3 of 5; the level under-rated 1 of those 5 (an earlier question set: 3 of 5). n = 5, one kind of work. This is why routr is built around judge-and-escalate rather than prediction |
| Is it worth a worker at all? | tiny: 6 rote fixtures vs 24 others; separable, needs-the-user: 10 written briefs | tiny 27/30, never decisively wrong; separable 6/6; needs-the-user 4/4 (written for the eval: optimistic) |

## Judging a report

| Question | Ground truth | Result |
|---|---|---|
| Do the judge questions fire on the right reports? | 3 real worker reports, each with degraded copies carrying a known defect, plus 3 written fix reports | 20/23 expected readings, misses at the thresholds. Admitted gaps 3/3, symptom patch 0.91 vs root-cause fix 0.04, scope creep 0.98, claimed verdict 12/12. The degraded copies were written for the eval: optimistic |
| Can Jev structure a free-text review into a verdict? | 80 real reviewer reports with an explicit verdict line | 88% verdict accuracy, no approve/reject confusions; 66% with the verdict line hidden, so the report format requires one |

## Workers and leads

| Question | How it was checked | Result |
|---|---|---|
| Do workers follow the skill when only the launch prompt names it? | harness transcripts and session logs, not self-report | A soft mention: skipped, every subagent on the lead's own model. A firm, mandatory opening: Claude Code, Codex, and Cursor each asked routr per subagent and sized them differently; Cursor stayed on its own models. One run per harness |
| Can each harness be launched unattended in a herdr pane? | the orchestrator's own check of each result | 4/4. Found on the way: folder-trust dialogs (Claude Code, Codex), shell start-up prompts that swallow the launch command, Antigravity having no skill mechanism and silently running its high variant when given both a model and an effort, Cursor's `--model` persisting as the account default |
| Does a real lead, given only the skill, deliver across subscriptions? | three runs with an Opus lead; transcripts, ledger, and an independent re-check | All work delivered and verified, spread over four subscriptions. Left to itself the lead went above the advice on 5 of 7 briefs and set effort to high every time; after the guides said "start at the advice; go higher only on a fact", it stayed at the advice where no fact called for more, gave reasons where one did, and ran the judge loop (2 attempts on both pieces, recorded). One run after the change |
| Are the usage numbers right? | each harness's own usage screen | Claude Code matches its usage page; Antigravity and Codex are read from the harness itself. A flat reserve made a subscription look spent a day before its reset, so the reserve now shrinks toward the reset |

## Installing

| Question | How it was checked | Result |
|---|---|---|
| Does the install path work on a clean machine? | a clean temporary home on macOS, a macOS VM with no Node, Bun, or Homebrew, and an Ubuntu VM with Bun and no Node | `bunx skills add` installs with no Node present; the installed copy runs `--version`, `doctor`, fallback advice, `assess`, and `launch --dry-run`; the test suite passes on Linux. Two bugs found and fixed: `--version` read a file that is not installed with the skill, and the key lookup reached outside the skill folder |
| Can an agent install it from the pasted instructions? | Claude Code (Sonnet) in the Ubuntu VM, given INSTALL.md and the user's answers up front; every file it wrote was inspected afterwards | Yes, in about 2 minutes ($0.44): skill installed, config written with the requested reserve and a default model from the harness's list, statusline added to Claude's settings without disturbing the existing hooks, MCP servers, or permissions, launcher on PATH, clean `doctor`. Its notes on the instructions were applied. One run, installed from a local snapshot because the repository was still private |

## Not measured

- Whether choosing intelligence and reasoning effort separately, as the guides describe, gives better results.
- How often real worker reports need to be sent back, and whether escalating one level fixes them. The ledger is
  built to answer this from use.
- Windows. The code avoids shell dependencies, but has only been run on macOS and Linux.
- Installing straight from GitHub (the repository was private while this was written). The Claude Code plugin
  marketplace install was checked from a clean local clone: the plugin installs, registers the skill (about 114
  tokens per session), and its copy of the CLI runs.
- Usage pools routr cannot see: Claude's separate weekly limit for its largest model, and third-party models inside
  Cursor and Antigravity (routr routes to each harness's own models).
