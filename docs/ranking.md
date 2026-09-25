# How routr ranks subscriptions

`routr dispatch` answers two separate questions and puts the answers side by side:

1. **What does the work need?** Jev, a System One model, reads the brief and judges the work: its level (`basic`,
   `standard`, `strong`), its kind, its risk, and whether the brief is complete. Jev never sees usage.
2. **Where is there room?** routr reads each subscription's usage and ranks the subscriptions with the arithmetic
   below. No model is involved: the same numbers always give the same ranking, and every number in it can be checked
   against the harness's own usage screen.

The two run at the same time and meet only in step 1 of the ranking, where Jev's level decides which subscriptions
take the work. The orchestrator, the lead agent that asked, gets both and decides. It may go against the ranking: it
knows what is already running and what comes next.

`routr usage` prints the ranking with no brief, for checking.

## What routr reads

| Subscription | Source | In a call |
|---|---|---|
| Claude Code | The snapshot `routr statusline` writes after each Claude Code turn: its 5-hour and 7-day windows, or a spend cap | a file read |
| Codex | `codex app-server`, asked for its rate limits (no tokens); the newest session log if that fails | about 1 to 1.5 s, measured 2026-09-25 |
| Antigravity | `agy -p /usage` (no tokens). Only the Gemini pool counts: routr routes to the harness's own models | about 2 s; up to 9 s when the command hangs, measured 2026-09-25 |
| Cursor | Its `/usage` screen, read in a private herdr session in the background about once per working session (when the last try is over 4 hours old) and kept as a snapshot. Only **Included** is ranked; Auto and API are shown in the note | a file read |

Usage reading runs beside the call to Jev, so a call takes as long as the slower of the two. Details and the shapes
each harness reports: `skills/routr/references/harnesses.md`.

Each reading carries its age (`age_sec`). A window whose reset time has passed since the reading is treated as empty.
A Cursor reading more than 24 hours old is not used, because refreshes are failing and the plan may have reset since.
A subscription whose usage cannot be read uses your `assumed_headroom` and is marked `assumed`, with the reason in
`note`. `--headroom <name>=<0..1>` overrides any reading and is marked `given`.

## The ranking, step by step

The code is `rankSubscriptions` in `src/lib/pick.mjs`.

1. **Drop what does not take this work.** A subscription whose `hardest_work` is below the level of the work goes to
   `excluded`, with the reason. Strong work skips a subscription you give only standard work.
2. **Class each pool.** From the shape the harness reports, never from a plan name:
   - `included`: windows that expire (a subscription);
   - `capped`: a spend cap the vendor enforces, read as one more window;
   - `metered`: billed usage with no quota (measured on a ChatGPT Enterprise seat);
   - `unknown`: nothing readable.

   Your `billing` setting overrides the class. A `--headroom` value counts as `included`.
3. **A metered pool gets a position, not a number.** It has no window, so there is nothing to subtract. With
   `metered_rank: "after"` (the default) it is listed after every pool that still has room, so it takes the overflow:
   included usage expires and billed usage does not. With `"with"`, it is ranked by your `assumed_headroom`.
4. **Every other pool, window by window:**
   - `left` = 1 − the share used;
   - `reserve_now` = your `reserve` × the share of the window still to run. The reserve shrinks as the reset nears,
     because capacity not used by then expires. A window whose length is unknown (a spend cap, Cursor's plan) holds
     the full reserve;
   - `usable` = `left` − `reserve_now`, never below 0.

   The pool's `usable` is its **tightest** window. A pool with no windows (assumed or given) is its headroom minus the
   full reserve.
5. **Sort.** Pools with room, most usable first; then metered pools; then pools at their reserve.
6. **Name the one with most room.** `most_room` is the first pool with room, else the first metered pool. With
   neither, the note says every pool that takes this work is at its reserve: hold the work or ask the user. A reserve
   is never offered.

## A worked example

Claude with a `reserve` of 0.25, read at a moment when:

| Window | Used | Left of the window | `left` | `reserve_now` | `usable` |
|---|---|---|---|---|---|
| 5-hour | 40% | 1.4 of 5 h (28%) | 0.60 | 0.25 × 0.28 = 0.07 | 0.53 |
| 7-day | 19% | 120 of 168 h (71%) | 0.81 | 0.25 × 0.71 = 0.18 | 0.63 |

Claude's `usable` is 0.53, its tightest window. Beside it on that machine: Antigravity 0.55 (weekly Gemini pool 40%
used, reserve 0.1), Cursor 0.24 (Included 66% used, reserve 0.1, full reserve since the plan's reset time is not
shown), and Codex metered, so last. For `standard` work Antigravity comes first. For `strong` work, Antigravity and
Cursor are excluded by their `hardest_work`, and Claude comes first.

## What changes the ranking

Only your settings in `~/.config/routr/config.json`, per subscription: `reserve`, `hardest_work`,
`assumed_headroom`, `billing`, and `metered_rank`. `default_model` and `default_effort` are passed through as
`your_default` and do not change the order. `prefer` bears on the level of the work, not on the ranking.

## What it does not do

- It never names or compares models, and it knows no prices: nothing in it goes stale when models change.
- It does not weigh how big the work is against the room left. The level and the `tiny` fact say something about
  size; the orchestrator weighs the rest.
- It does not decide. The orchestrator does.
