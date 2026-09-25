# How routr decides where work can go

When your lead agent is about to hand work to a worker, it asks `routr dispatch`. Three parties take part:

- **Jev judges the work.** A small, fast model reads the brief and says how demanding the work is (`basic`,
  `standard`, or `strong`), what kind of work it is, and whether the brief is ready to send. Jev knows nothing about
  your subscriptions or their usage.
- **routr works out where there is room.** It looks at how much of each subscription you have left and ranks them.
  This is plain arithmetic on your usage and your settings: no model, the same inputs always give the same answer.
- **Your lead agent decides.** It gets both answers and picks the subscription and model. It may go against the
  ranking, because it knows things routr does not: what is already running and what comes next.

You can see the ranking any time, with no brief, by running `routr usage`.

## The usage routr sees

routr reads each subscription's usage from the harness itself: how much of each usage window is used and when it
resets. It asks the way the harness shows usage to you, without sending it a prompt, and sends the numbers nowhere.

Most subscriptions are read the moment you ask. Cursor takes several seconds to read, so routr reads it in the
background about once per working session and uses that reading until the next one. Every reading shows how old it
is. If routr cannot read a subscription, it falls back to a number you set (`assumed_headroom`) and says so.

## Which subscriptions can take the work

Each subscription in your config has a `hardest_work` setting: the most demanding level of work you are willing to
send there.

| Level | What Jev means by it |
|---|---|
| `basic` | Rote or well-specified work; a small, fast model is enough |
| `standard` | The worker has to find something out or choose an approach |
| `strong` | A wrong or shallow result would be expensive and hard to notice |

A subscription takes work at its `hardest_work` level and below. For `strong` work, a subscription set to `standard`
is left out of the ranking, and the output says why.

When `routr setup` writes your config it starts every subscription somewhere: `strong` for Claude Code and Codex,
`standard` for Cursor and Antigravity. These are starting points, not measurements. They are yours to change: set
Cursor to `strong` if you trust it with your hardest work, or Claude Code to `standard` if you want to keep it for
your own. Nothing else in routr decides what a subscription is good for.

## How much room each subscription has

For each subscription, routr works out a **usable** share between 0 and 1:

1. **Start with what is left** in each usage window. Claude Code, for example, has a 5-hour window and a weekly one.
2. **Hold back your reserve.** `reserve` is the share you keep for your own work, and routr never offers it to a
   worker. The reserve shrinks as a window nears its reset, because whatever is unused at the reset is lost anyway:
   with half the window still to run, half the reserve is held back.
3. **Count the tightest window.** A subscription with plenty left this week but little left in the next few hours is
   only as usable as those few hours.

Seats billed per use with no quota, such as a ChatGPT Enterprise seat, have no window to measure. By default they are
listed after every subscription that still has room, so they take the overflow: your subscriptions' included usage
expires, billed usage does not. `metered_rank: "with"` ranks them alongside your subscriptions instead.

## The order

Subscriptions with room come first, most usable at the top, then billed seats, then subscriptions already at their
reserve. The first one with room is named `most_room`. If every subscription that can take the work is at its
reserve, routr says to hold the work or ask you. It never offers a reserve.

## An example

A developer's Claude Code subscription, with a reserve of 0.25:

- The 5-hour window is 40% used and resets in 1.4 hours, so little of it is still to run and only 0.07 of the reserve
  is held back: 0.60 left − 0.07 = **0.53** usable.
- The weekly window is 19% used with most of the week to go: 0.81 left − 0.18 held back = 0.63 usable.
- Claude Code counts as **0.53**, its tighter window.

Beside it: Antigravity at 0.55, Cursor at 0.24, and a Codex Enterprise seat billed per use. For `standard` work,
Antigravity comes first and Claude Code second. For `strong` work, Antigravity and Cursor are left out (both set to
`standard`), so Claude Code comes first and Codex takes the overflow.

## Changing it

Everything that changes the ranking is a setting of yours in `~/.config/routr/config.json`, per subscription:
`hardest_work`, `reserve`, `assumed_headroom`, and, for a billed seat, `metered_rank`. Your default model on each
subscription is shown beside it but does not change the order.

## What routr leaves to your lead agent

- **Which model.** routr never names or compares models, and knows no prices, so nothing in it goes out of date when
  models change.
- **How big the work is.** routr ranks by room left, not by whether a large task fits in it. Jev's level says
  something about size; the lead agent judges the rest.
- **The decision.** routr advises; the lead agent chooses.

routr is open source: the ranking is `rankSubscriptions` in `src/lib/pick.mjs`.
