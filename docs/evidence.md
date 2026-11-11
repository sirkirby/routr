# Evidence

routr's claims rest on small evals run while it was built (2026-09). Sample sizes are small and most labels were
written by the people building it; each entry says so. "Jev" is TypeSafe's System One model. routr pins an exact version
and moves the pin when a new one does at least as well on these items (CONTRIBUTING.md). The pin is `jev-1.14.0` since
2026-10-27 ([Moving the pin](#moving-the-pin-jev-114-2026-10-27)). Unless an entry names another model, the results
below were measured on `jev-1.13.0`, the pin before it; [Decision models](#decision-models) compares the other models
routr can ask on the same items.

## Reading a brief

| Question | Ground truth | Result |
|---|---|---|
| Are narrow facts about a brief decisive? | 68 briefs: 28 written fixtures, 35 real prompts from the author's history, 5 real investigation briefs. Decisive = answer below 0.2 or above 0.8 | Facts stated in the brief: 63-88% decisive (says how to check 88%, names the location 84%, concurrency or data 79%, approach open 68%, cause unknown 66%, hard to reverse 65%, cross-cutting 63%). Estimates of what the work will take: 22-43% (wide search, whole picture, broad context, long iteration). routr asks the first kind only |
| Is the read the same every time? | 12 briefs × 5 repeats | 107 of 108 fact readings identical; largest swing in a probability 0.06; level identical 11/12 |
| Is the one-word level reliable? | the same 68 briefs, labels by the builders | Rounding the score: 54/68 exact, 13 over, 1 under. Confidence is informative: 34 of 38 right at ≥ 0.8. On the 30 unsure briefs the true level was the LOWER of the two most likely levels 27 times, the higher once. So routr rounded when sure and reported the lower of the two when torn (until r5, below): 61/68 on those saved answers. Asked afresh with the shipped question set by the model gate (2026-09-24, two runs): 59/68 (4 under, 5 over), and on the torn briefs the lower level was right 27 of 32 and 25 of 30 times, the higher 3 times each. Rounding up when unsure fixed nothing and only over-rated; a level derived by rule from the facts did no better (52/68) |
| Is the level right on real work? | 36 real tasks from the maintainer's worker runs (two projects), each labelled blind by two judges from different model families; the maintainer settled the 16 they split | Jev was torn on 31 of the 36. Scored by the model gate on the same answers (2026-09-27, two runs), asked with the work only (the lead's process rules removed, as `--rules-file` now keeps them): the most likely level when torn, 29/36 (7 one level low, none high); the lower of the two (r4's rule), 15/36 (21 low). On the 68 briefs above the same answers give 53-54/68 for the most likely level (13-14 over) and 59-60/68 for the lower one: there Jev reads high, on real tasks low. Over all 104, 82-83 against 74-75, so since r5 routr reports the most likely level, and the gate reports the real tasks on their own. One maintainer's work, n = 36 |
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
| Can each harness be launched unattended in a herdr pane? | the orchestrator's own check of each result | 5/5 (Kiro added 2026-09-26: one run, a one-file task, verified from the pane and the file). Found on the way: folder-trust dialogs (Claude Code, Codex), shell start-up prompts that swallow the launch command, Antigravity having no skill mechanism (then: its docs now describe one; see references/harnesses.md) and, before agy 1.2.11, silently running its high variant when given both a model and an effort (1.2.11, 2026-09-26, refuses an effort that disagrees with the model id, exit 1), Cursor's `--model` persisting as the account default, Kiro asking to confirm its trust-all-tools mode at every start (with an arrow key lost when sent together with enter), running its default on an unknown model id without a word, and ignoring `--effort` without a word on a model that has no effort levels (every model this Free account offered; Kiro's docs list effort for its newer Claude and GPT models) |
| Can a headless Claude Code worker run the whole loop outside herdr? | `routr launch`, `wait`, `send`, `workers` and `cleanup --worker` by hand with Claude Code (Haiku) on a one-file task, the result read from the files and each turn's report (2026-10-22); a fake harness for the edge cases in `test/workers.test.mjs`; the channel and process handling measured as prototypes beforehand (routr-lab p34 to p36) | macOS, Windows ARM64 and Windows x64: launch, the report, a follow-up on the same session (it remembered its first commit on macOS), cleanup, each 1 of 1. With `--worktree` (2026-10-22, macOS, 1 of 1): the worktree made, Claude ran in it with no trust question, cleanup removed it and kept the branch. Windows and Linux with `--worktree`: only the fake harness, with real git, in CI; `cleanup --cwd` through git and `--worker --delete-branch` on a real worker: not measured. Linux: only the fake harness in CI. A correction sent mid-turn through routr (measured only in prototype p36), stop mid-turn, a killed holder and a background command: not measured through routr. A fresh lead using only the guides, on a real task of 30 minutes or more with a mid-turn correction, has not been measured yet |
| Can a headless Codex worker run the whole loop outside herdr? | `routr launch --kind codex`, `send`, `wait`, `workers` and `cleanup --worker` by hand with Codex (gpt-6-luna, effort low) on a one-file task in a throwaway repository, the result read from its commits and each turn's report (2026-10-22, codex-cli 0.163.0); the app-server protocol measured beforehand (routr-lab p37, p38); a fake app-server for the edge cases in `test/workers.test.mjs` | macOS, 1 of 1: launch, a correction sent mid-turn that changed what it committed, the report (its final answer), a follow-up that resumed its thread (it placed the new function after the one it had added), cleanup with no app-server left. Windows and Linux: only the fake app-server in CI. With `--worktree`, stop mid-turn, a killed holder, a background command, a hook the user trusted, and a fresh lead using only the guides: not measured |
| Can a headless Antigravity worker run the whole loop outside herdr? | `routr launch --kind agy`, `send`, `wait`, `workers` and `cleanup --worker` by hand with Antigravity (gemini-3.8-flash-low) on a one-file task in a throwaway repository, the result read from its commits and each turn's report (2026-10-22, agy 1.4.5); its stream-json mode measured beforehand (routr-lab p37, p39); a fake for the edge cases in `test/workers.test.mjs` | macOS, 1 of 1: launch, a correction sent mid-turn that ran as the next turn (turn 1 committed the first version, turn 2 the correction), the reports, a follow-up that continued its conversation (it placed the new function after the one it had renamed), cleanup with nothing left running; two corrections sent during one turn ran as turns 2 and 3, one commit each, both when written straight to Antigravity mid-turn and when the holder keeps them and writes each after a turn ends (as routr now does; 1 of 1 each). Windows and Linux: only the fake in CI. With `--worktree`, stop mid-turn, a killed holder, a background command, and a fresh lead using only the guides: not measured |
| Can a headless Kiro worker run the whole loop outside herdr? | Its ACP mode measured with Kiro itself (2026-10-22, kiro-cli 2.33.1, model auto; routr-lab p40): a session, a turn and its text, a second prompt mid-turn refused ("Prompt already in progress"), the next turn in the same process, `session/load` replaying the history and then answering from its context, an id Kiro does not list taken without a word; a fake for the loop in `test/workers.test.mjs` | The protocol on macOS, 1 of 1. The loop through routr with a real Kiro: not measured (Kiro was turned off in the measuring machine's settings); `--model` other than auto, and `--effort` on `acp`: not measured. Windows and Linux: only the fake in CI. With `--worktree`, stop mid-turn, a killed holder, a background command, and a fresh lead using only the guides: not measured |
| Can a headless Cursor worker run the whole loop outside herdr? | `routr launch --kind cursor`, `send`, `wait`, `stop` and `cleanup --worker` by hand with Cursor (grok-4.7-medium-fast) on a one-file task in a throwaway repository, the result read from its commits, each turn's report and Cursor's own transcript (2026-10-22, cursor-agent 2026.10.22-27dcf5f); its stream-json mode measured beforehand (routr-lab p41, p43); a fake for the edge cases in `test/workers.test.mjs` | macOS, 1 of 1: launch, two corrections sent mid-turn that ran as turns 2 and 3 in new processes on the same session (one commit each), the reports, a follow-up once idle that resumed the session, cleanup with Cursor's own worker-server still running (left, and said); a stop mid-turn with a correction queued: stopped, the correction dropped and counted, no commit. Before the fix that reads Cursor's worker-server as Cursor's, both corrections ended `not_started` and cleanup refused. Windows and Linux: only the fake in CI. With `--worktree`, a killed holder, a background command, and a fresh lead using only the guides: not measured |
| Can two accounts of one harness run side by side? | Two signed-in Claude Code folders, the default with the variable unset and a second named in `CLAUDE_CONFIG_DIR`, Claude Code 2.1.322, macOS, 2026-11-10; a fake harness in `test/extra-accounts.test.mjs` for the rest | Each folder gave its own `/usage` reading and its own signed-in worker, headless and in a herdr pane, 1 of 1 each. `claude auth status` said `"loggedIn": true` with the variable unset and `false` with it set to `~/.claude`, so routr removes it for that folder. A second Codex account, the Herdr app, Linux and Windows: only fakes, in CI; not measured |
| Does `routr launch` deliver the task under load? | `routr launch --worktree` on `main`, a one-line task with a known answer, the answer read from each pane (2026-10-11) | Claude Code 5 of 5, Codex 4 of 4, Cursor 4 of 4, launched one at a time and three at once; each started within 7 s. Antigravity 0 of 2: agy 1.3.3 opened a "Terms of Service & Data Use" screen that herdr reads as idle, so the task landed on it; launch reported `needs_input` and did not resend. Kiro not run (turned off on that machine) |
| Does handing one task to subagents save anything? | the same audit of one codebase run solo and delegated to subagents, tokens, time, the lead's context and the findings compared (2026-09-20) | Delegated used about twice the usage or more and took longer, with no gain in what it found; it did cut the lead's peak context from 160k to 58k tokens. One task, so the guides' "about half" and "roughly doubled" rest on this one audit |
| Can a worker choose a subagent's model and effort on each harness? | one short run per setting on each harness, then one further precedence run each on Claude Code 2.1.316 and Codex 0.166.0, read from the subagent's own record (2026-11-02) | Model: yes on Claude Code, Codex, Cursor and Antigravity; on Kiro the setting is accepted but which model ran was not confirmed. Effort: yes on Claude Code and Codex; part of the model id on Cursor; no setting found on Antigravity or Kiro. With differing fallbacks from the exact launch plan, an explicit model and effort together on the spawn won on Claude Code and Codex (one child each, one-word replies). No test shows that smaller subagents keep quality, or whether this saves anything. In 60 days of Claude Code worker transcripts, 33 spawns set a model 31 times and effort 10 times |
| Should follow-up work go to the same worker or a fresh one? | 615 follow-ups to 352 workers in Claude Code and Codex session files (2026-09-03 to 2026-11-02), costed at API prices, not subscription charges; nothing ran the same follow-up both ways, so a fresh worker's cost is an estimate from similar workers in the same repository (routr-lab p45) | Claude Code: the first request after its prompt cache expired cost about 25 times a live one (medians, 40 cases against 322; a cache-miss pattern, not proof of the time limit). The cache lasted about an hour. A similar fresh worker's start-up was estimated at about the same as that expired request, so expiry alone does not favour starting fresh. No plain rule or System One question found a useful automatic switch, which is why the guide gives a rule of thumb. Codex's cache behaviour could not be read. "Unrelated work goes to a fresh worker" follows from how context is charged and was not measured; quality was not compared |
| Does a real lead, given only the skill, deliver across subscriptions? | three runs with an Opus lead; transcripts, ledger, and an independent re-check | All work delivered and verified, spread over four subscriptions. Left to itself the lead went above the advice on 5 of 7 briefs and set effort to high every time; after the guides said "start at the advice; go higher only on a fact", it stayed at the advice where no fact called for more, gave reasons where one did, and ran the judge loop (2 attempts on both pieces, recorded). One run after the change |
| Are the usage numbers right? | each harness's own usage screen | Claude Code matches its usage page (the statusline's numbers), and its own `/usage`, which routr now reads, agreed with the statusline within a point at the same minute, with identical reset times (one comparison, a Max plan, 2026-10-05); Antigravity and Codex are read from the harness itself, and Kiro from its own `/usage` command. Kiro's figure is its own estimate and lags: minutes after a turn Kiro billed at 0.10 credits, `/usage` still read 0.00 (one observation, a Free plan). A flat reserve made a subscription look spent a day before its reset, so the reserve now shrinks toward the reset |
| What does a seat with no quota report? | `codex app-server` `account/rateLimits/read` on a ChatGPT Enterprise seat with flexible pricing and on a Pro login, 2026-09-22 | The Enterprise seat: both windows null, `credits.unlimited: true`, and a plan name of `business`, so the shape is the key and the plan name is not. The Pro login: one weekly window, credits off. routr classes each pool from its shape (`included`, `metered`, `unknown`). A metered account has unknown remaining budget; its normal/fallback use is the user's setting. A Claude seat with quota windows reports the same `/usage` lines whatever the plan (Max and Team, `claude -p /usage`, 2026-10-07), so it is ranked as `included`. Claude signed in with an API key (2026-10-07): `/usage` shows only a session cost summary and no windows, the same as a subscription whose credentials were not available, while `claude auth status` says `"authMethod": "api_key"`, so routr reads the class from the auth status and ranks it as `metered`. A Claude usage-based Enterprise seat (2026-10-27, Claude Code 2.1.311): `/usage` shows no windows and only usage credits spent, and `claude auth status` says `"authMethod": "claude.ai"` with `"subscriptionType": "enterprise"`, so routr ranks it as `metered` when its `/usage` answered with no windows; an Enterprise seat with a quota keeps that plan name, so its windows decide. Codex member limits were later observed (below); Claude Enterprise budgets are not visible in print `/usage` |
| Does Codex report a member limit? | macOS, Codex 0.166.0, 2026-11-03; recorded replies in the admin-limit fixtures | Under the limit: `individualLimit.remainingPercent: 71`, `spendControlReached: false`; at the limit: remaining 0, spend control true, `workspace_owner_usage_limit_reached`. `hasCredits` stayed true. Resets at 1796083200 and 1796083201 both occurred. Not tried: a model request at the limit, a close-to-limit read, Linux or Windows |
| Can a user's own command replace a harness's `/usage`? | A project skill at `.claude/skills/usage` in a throwaway folder, Claude Code 2.1.317, macOS, 2026-11-03 | `claude -p /usage` ran the skill: `num_turns: 1`, `total_cost_usd: 0.1256974`, with Claude's own figure and not money billed on that plan. A skill in another folder with `name: usage` did not take over: 0 turns. `--disable-slash-commands` also removes the built-in, and `--max-turns 0` still ran a turn. routr's check looks at the user-level `skills/usage` and `commands/usage.md`, which were not measured directly. Plugin and managed skills, and other harnesses' `/usage`, were not tested. |
| Can Cursor's usage be read without herdr? | A compiled routr, cursor-agent 2026.10.22, macOS, herdr off PATH and a clean environment, five reads, 2026-11-03; routr-lab p51 | Five of five read `Included` from Cursor's `/usage` in Bun's own terminal, no prompt sent, 10 s the first time and 2 to 3 s after, with no config copy left. Linux was run only against a fake Cursor in that terminal, in CI. Bun documents the terminal as POSIX only, so Windows stays on a private herdr session. |
| What does Kiro CLI 3.0 do at an interactive start? | kiro-cli 3.0.0, macOS, one account with saved V2 sessions, 2026-11-03; routr-lab p50 | `kiro-cli chat` stopped at a choice between V3 and V2, whose notice says V2 "will be removed in January". `kiro-cli --v3 chat --trust-tools=*` skipped it, then asked to trust the workspace; past that, one small turn reported `working` then `done`. On 2026-11-04 its V3 screen asked approval to read a file outside its folder despite `--trust-tools`; `--trust-all-tools` read freely after a warning, and "Yes, and don't ask again" kept the next start in a trusted folder from asking. In a herdr pane (herdr 0.9.5) that start's folder trust read as idle and ready, and launch's Enter answered it, so a pane stays on V2 (`--v2`: from Kiro's docs, not yet measured). A new worktree of a trusted repository, an account with no saved sessions, `kiro-cli acp` and its `/usage` under V3 were not measured. |
| Do workers show in the Herdr app? | hc 0.1.17 with the real app, macOS, Claude Code, Codex and Cursor workers on one small task each, 2026-11-03; routr-lab p50. This measured headless workers with a watch terminal beside each; a harness running in the terminal itself through routr's runner is not yet measured | `routr launch` from an app terminal gave each a tab; the app's own list showed each `working`, then `done` under its harness's name; `cleanup --worker` removed the tabs; the person's focus did not move when a tab opened. How it looks was checked by screenshots with the real `routr watch` on fixture workers, no model: each of the five harnesses showed its own icon, in the tab and the Agents list; states set by hand showed a failed worker under "Needs you", and pop-ups for a finished and a failed worker. A terminal took the worker's name, and a second live worker of that name got its id added (private core, no app). On a private core from a core terminal, with `routr watch` beside each: an Antigravity worker ran a small task; a Codex worker was stopped mid-command and read `stopped`, its command gone; a Claude worker took two follow-ups that each started a new process, and its terminal showed turns 2 and 3. A correction into a running turn was not exercised there: that Claude turn had already ended. A Kiro worker, a core restart, Windows and Linux were not run. |
| Can a funded metered account be considered for ordinary work? | Pure fixtures in `test/routing-quality.test.mjs`, plus setup and usage tests, 2026-09-30 | Two normal enterprise accounts and mixed included/metered accounts remain candidates without invented metered headroom. Explicit account use, measured caps, reserves, sign-in and work-level exclusions are checked. These tests establish policy behavior, not a measured quality, cost or time improvement |
| Does a second attempt establish worker failure? | Local outcome fixtures in `test/routing-quality.test.mjs`, 2026-09-30 | Review follow-ups, launch trouble and execution corrections are reported separately. Missing attempts and causes stay unknown locally; explicit run revisions count once, while workers sharing advice stay distinct. First-pass acceptance requires a verified pass, one attempt and no extra work. No model comparison is inferred from these counts; telemetry retains its legacy projection |
| Can a lead refresh eligibility after changing the work level? | Pure fixtures and isolated CLI tests in `test/routing-quality.test.mjs`, 2026-10-01 | `usage --level` applies the same account policy for upgrades and downgrades, preserves ordinary usage output, rejects invalid or named-refresh combinations before reading usage, and leaves the original assessment intact for recording. A source CLI smoke returned the chosen level and real account diagnostics, including snapshot ages. These checks establish command behavior, not task outcomes |
| Does quality-first guidance change the lead's stated decisions? | Nine synthetic cases labelled by the implementing agent, old and revised guidance paired in each request to one Opus lead at medium effort, 2026-10-01 | In the initial seven cases, revised responses used task evidence instead of the everyday default, refreshed eligibility after overrides, and separated execution failures from brief gaps. They also inferred an unobserved attempt count and requested redundant permission for configured fallback use. After clarification, two new cases proceeded under existing fallback permission and left unknown attempts/time unset. Decision-only responses, no workers launched; optimistic fixtures, no independent judge, and paired prompts can contaminate the baseline. No measured improvement in real quality, time or spend |
| Does a fuller brief or a stronger worker model move the result more? | 24 headless Claude Code runs at effort high, one turn each in an isolated copy at the base of three merged pull requests (two in unifi-mcp, one in routr; routr read one standard and two strong). Each task's brief as its lead sent it, against a hurried few-sentence version pointing at the same material, on Opus and on Sonnet, two runs per cell. Judged blind by Codex (GPT-6.1-Sol, high) against the merged change, which no run could see, and scored on the merged pull request's own tests (2026-11-05, routr-lab P56) | On one task the hurried brief named the change and asked for tests but dropped the requirements (what must stay unchanged, what each part must prove): all four runs, on both models, drew the same 3 defects and failed the same 2 merged tests, against 0 (Opus) and 1 (Sonnet) with the full brief. routr (jev-1.14.0, asked twice, 2026-11-06) read that hurried brief `standalone` yes and `states_check` unclear (0.74, 0.76), so neither brief fact asked for a fix. No difference showed on the other two: one hurried brief still carried its issue's requirements, and the third task was more than either model finished in one turn. Opus cost about 2.9 times as much as Sonnet over all 24 runs (harness-reported list prices), from 2 to 7.6 times cell by cell; with the full brief, 2 to 2.9 times. The judge gave the same verdict on the 4 runs it judged twice. Three tasks, two runs per cell, one harness, no basic work, and no review loop, where a missing requirement would cost a round rather than the result |

## Decision models

routr tries the ordered decision models chosen in `routr setup` until one answers: TypeSafe's Jev (the default), or Cloudflare's
Clef, hosted on Workers AI or run on your own machine through Ollama. Both answer the same System One questions. Each
model below was run by the maintainers' gate on the saved items above, beside Jev in the same run (2026-10-11), with
routr's shipped questions (r5, c1). Those questions were worded and tuned on Jev, which favours it.

| | Jev 1.13.0 (TypeSafe) | Clef (Workers AI) | Clef Flash (Workers AI) | Clef Flash (Ollama, MLX) | Clef Flash (Ollama, GGUF) |
|---|---|---|---|---|---|
| Level right, 104 labelled briefs | 82-83 | 72 | 74 | 70 | 72 |
| One level too low / too high | 7-8 / 13-14 | 6 / 26 | 18 / 12 | 22 / 12 | 20 / 12 |
| Level right, the 36 real tasks | 29-30 | 26 | 23 | 19 | 21 |
| "Standalone" decisively wrong (78 briefs) | 2-3 | 11 | 3 | 3 | 3 |
| "Tiny" on the right side of 0.5 (30) | 27-28 | 26 | 25 | 24 | 24 |
| Yes/no facts more often decisive than Jev's (of 12) | | 11 | 7 | 9 | 8 |
| Report checks: expected readings (23) | 19-21 | 20 | 18 | 17 | 17 |
| Reviewer verdicts right (80) | 68-69 | 68 | 71 | 70 | 69 |
| Same readings on 5 repeats (144 facts, 12 levels) | 139-140, 11 | 144, 12 | 144, 12 | 144, 12 | 144, 12 |
| Time per brief | ~130 ms | ~420 ms | ~525 ms | 5-7 s (M4 Max) | ~5 s (M4 Max) |
| `sure_at` | 0.8 | 0.7 | 0.5 | 0.6 | 0.6 |

### Moving the pin: Jev 1.14 (2026-10-27)

routr moved its pin to `jev-1.14.0` as a maintainer decision, not on a clean gate pass. Two three-run gates on the same
items gave mixed results (one held 1.14 on the level, one passed it). Pooled, 1.14 is still slightly lower on the
labelled levels (under-rated 8.3 against 7.8 of 104), a difference about the size of the gate's run-to-run noise;
verified outcomes favoured it. `jev-1.13.0` is no longer offered.

**What a lead acts on.** Fresh Claude Code and Codex leads were given routr's real `dispatch` output on 12 real tasks
from the maintainer's work, with one fact's reading flipped at a time and the level unchanged, and asked to decide.
- Flipping a work fact (where to work, approach open, cause unknown, cross-cutting, concurrency or stored data, hard to
  undo, needs the user) changed the level, model or effort 0 of 40 times with Claude and 5 of 55 with Codex, about as
  often as Codex disagreed with itself.
- Flipping `standalone` to no made the lead rewrite the brief 12 of 12 and 11 of 12 times.
- Flipping the other brief and worker facts was mostly overridden: states a check 2 of 10, tiny 0 of 12, needs the
  user 0 of 4, separable 1 of 11.

So leads check most facts against the brief and override a wrong one, but follow `standalone`. The level was held
unchanged and not tested here; that leads act on it is inferred from their stated reasons, not measured. A flipped
reading is usually false for its brief, so this measures whether a lead acts on routr's reading against the brief's own
evidence, not the value of a true reading the lead would have missed. Small samples (12 tasks; 318 sessions, 316 valid
answers).

**The gate, since then** (CONTRIBUTING.md): the level (exact, under- and over-rated, the real tasks, stability),
`standalone`, and the report and reviewer verdicts are gated. The other facts are reported but not gated. Under-rating
may not rise at all, judged on the mean of three runs, because one run moves by about one item.

**The result, the first three-run gate:**

| | 1.13.0 | 1.14.0 |
|---|---|---|
| Level right, 104 labelled briefs | 82.7 | 81.3 |
| One level too low / too high | 7.7 / 13.7 | 8.7 / 14.0 |
| Level right, the 36 real tasks | 29.3 | 27.7 |
| Level the same on 5 repeats (of 12) | 11 | 11.7 |
| "Standalone" decisively wrong (78) | 2 | 2 |
| Report checks: expected readings (23) / claimed verdict (12) | 20.3 / 12 | 21.3 / 12 |
| Reviewer verdicts right (80) | 68.7 | 67.3 |
| Fact readings the same on 5 repeats (144, not gated) | 140.3 | 136.3 |

1.14 reads levels lower. Scored against verified outcomes on 339 real tasks from the maintainer's ledger (three asks
each), it over-rated less (9 against 14 of the 329 where the chosen level was enough), under-rated the same (10 of 10
that fell short below strong were read no higher), and read 35 fewer tasks as strong. On the labelled briefs it is right
a little less often. Changing `sure_at` changes no level (a torn reading is presented as its most likely level), so
presentation alone cannot close the gap. A second three-run gate on the same items passed 1.14 (under-rated 8 against
8, right 81.7 against 82.7, real tasks 28 against 29). Pooled over all six runs: right 81.5 against 82.7 of 104,
under-rated 8.3 against 7.8, real tasks 27.8 against 29.2. On the 104 briefs the two versions differ on 10, each at a
level boundary: 1.14 better on 5, worse on 5. Its profile: `sure_at` 0.7 (its sure levels right 145 of 160, against
1.13's 115 of 129 at 0.8); on the 36 real tasks 28 right, 7 one level low, 1 one level high.

### Backup model or constant fallback

Private workbench P33, 2026-10-18, compared the model gate's 104 labelled briefs with constant levels. The real
runs are one maintainer's work (n = 36), a subset of those briefs. No model was asked for the constant rows: each
row assigns that level to every brief. Jev and Clef use the gate readings from 2026-10-11. This supports trying a
backup model before the default constant fallback; it does not measure a live outage sequence or independent users.

| reading | exact /104 | over | under | real runs exact /36 |
|---|---|---|---|---|
| Jev 1.13.0 (gate 2026-10-11) | 83 | 14 | 7 | 30 |
| Clef on Workers AI (gate 2026-10-11) | 72 | 26 | 6 | 26 |
| constant standard (routr's default fallback_level) | 58 | 24 | 22 | 21 |
| constant basic | 24 | 0 | 80 | 4 |
| constant strong | 22 | 82 | 0 | 11 |

### Measurement details

Jev's ranges are from the four runs it took part in. The MLX build (`clef-flash:9b-mxfp8`) runs only on Apple Silicon;
the GGUF build (`clef-flash:9b-q8_0`) runs on every platform, and was measured on a Mac. On Windows (Ollama 0.40.3, an
NVIDIA RTX 5090 laptop GPU) the same build's answers to 5 briefs matched the Mac's to within 0.018 on every
probability, with no answer or level changed. Times are the gate's means from the maintainer's network, and,
for Ollama, a new brief each time with the model loaded.

- **Which way each is wrong.** Clef reads the level too high more often than Jev, the cheaper direction to be wrong
  in: a stronger worker than needed. Clef Flash reads it too low, the costlier direction: the work may come back
  shallow. Clef was more often decisive than Jev on 11 of the 12 yes/no facts, Clef Flash on 7 to 9, and both gave the
  same answer every time they were asked again. The two local builds of Clef Flash agree with the hosted one within a
  few briefs.
- **Calibration does not close the gap.** Weighting the three level probabilities per model, fitted with each brief
  left out of its own fit, left Clef at 71 and Clef Flash at 71. The difference is in how these models read the level
  question's wording, which was chosen on Jev (P23). Wording measured on Clef is open work.
- **Confidence.** Providers compute `confidence` differently: TypeSafe by its own formula, Clef by entropy, which reads
  a 0.92/0.08 split between two levels as 0.75 where TypeSafe reads 0.88. routr recomputes every non-TypeSafe answer on
  TypeSafe's scale in the shared decision caller. Each model's `sure_at` is the lowest bar from 0.5 to 0.8 at which its level,
  when sure, is right at least as often as Jev's at 0.8 (39 of 44): Clef 12 of 13 at 0.7, Clef Flash on Workers AI 27 of
  30 at 0.5, on Ollama 23 of 24 at 0.6 (both builds). Few briefs reach those bars, so these are small counts. A `sure_at` you set
  yourself applies to every model.
- **Pins.** Jev is asked by exact version. Cloudflare's model names (`clef`, `clef-flash`) are not versioned, so
  Cloudflare can change the model behind a name; these numbers are from 2026-10-11 and the gate is re-run on them.
  Ollama's `latest` is a different build on a Mac (MLX) than elsewhere (GGUF), so routr asks an exact tag, and
  `routr doctor` says when the build you pulled is not the one measured.
- **Local speed.** On an M4 Max, Clef 27B through Ollama took 13-26 s per brief (MLX) and about 20 s (GGUF), too slow
  to advise in, so routr does not offer it locally. Every request carries routr's questions, about 1,950 input tokens,
  so even a short brief costs that much. On Windows (2026-10-11, Ollama 0.40.3), Clef Flash (GGUF) on an RTX 5090
  laptop GPU took about 0.8 s for a whole `routr subagent` call; on the same laptop's CPU alone (Core Ultra 9 275HX) it
  took 36-41 s a brief, longer than routr waits (30 s), so a local model needs a GPU or Apple Silicon. Ollama 0.40.0
  could not run Clef there at all (`Clef: non-finite logit`, on the GPU and the CPU); 0.40.3 could, so routr asks for
  0.40.1, whose release notes name the fix.
- **Keys.** A Cloudflare API token with only Workers AI Read was enough: `routr key set cloudflare`, `setup`, `doctor`
  and both Clef models worked with it (2026-10-11, an account-owned token). Cloudflare's "Workers AI" token template
  also adds Edit, which routr does not use.
- **Price.** Clef bills input tokens only. Workers AI's free daily allowance (10,000 neurons) covers about 450,000
  Clef input tokens or 2.9 million Clef Flash input tokens: at about 2,000 tokens a brief, roughly 200 briefs a day on
  Clef, more on Flash. Above that, Cloudflare's Workers Paid plan ($5 a month) bills by use
  ([Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), as of 2026-10-11).

