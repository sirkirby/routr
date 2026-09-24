# Evidence

routr's claims rest on small evals run while it was built (2026-09). Sample sizes are small and most labels were
written by the people building it; each entry says so. "Jev" is TypeSafe's System One model. routr pins an exact version
and moves the pin when a new one does at least as well on these items (CONTRIBUTING.md). Every result below was measured on
`jev-1.13.0`, the current pin.

## Reading a brief

| Question | Ground truth | Result |
|---|---|---|
| Are narrow facts about a brief decisive? | 68 briefs: 28 written fixtures, 35 real prompts from the author's history, 5 real investigation briefs. Decisive = answer below 0.2 or above 0.8 | Facts stated in the brief: 63-88% decisive (says how to check 88%, names the location 84%, concurrency or data 79%, approach open 68%, cause unknown 66%, hard to reverse 65%, cross-cutting 63%). Estimates of what the work will take: 22-43% (wide search, whole picture, broad context, long iteration). routr asks the first kind only |
| Is the read the same every time? | 12 briefs × 5 repeats | 107 of 108 fact readings identical; largest swing in a probability 0.06; level identical 11/12 |
| Is the one-word level reliable? | the same 68 briefs, labels by the builders | Rounding the score: 54/68 exact, 13 over, 1 under. Confidence is informative: 34 of 38 right at ≥ 0.8. On the 30 unsure briefs the true level was the LOWER of the two most likely levels 27 times, the higher once. So routr rounds when sure and reports the lower of the two when torn: 61/68 on those saved answers. Asked afresh with the shipped question set by the model gate (2026-09-24, two runs): 59/68 (4 under, 5 over), and on the torn briefs the lower level was right 27 of 32 and 25 of 30 times, the higher 3 times each. Rounding up when unsure fixed nothing and only over-rated; a level derived by rule from the facts did no better (52/68) |
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
| What does a seat with no quota report? | `codex app-server` `account/rateLimits/read` on a ChatGPT Enterprise seat with flexible pricing and on a Pro login, 2026-09-22 | The Enterprise seat: both windows null, `credits.unlimited: true`, and a plan name of `business`, so the shape is the key and the plan name is not. The Pro login: one weekly window, credits off. routr now classes each pool from its shape (`included`, `capped`, `metered`, `unknown`) and ranks a metered seat by the user's setting instead of an assumed number. Not yet observed: a cap set on the seat (parsed from the protocol's struct: claimed), a Claude Team seat, and a Claude usage-based Enterprise seat (the statusline docs say it sends no `rate_limits`: claimed) |
