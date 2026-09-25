# How routr decides where work can go

When your orchestrator, the agent handing work out to workers, is about to launch one, it asks `routr dispatch`.
Three parties take part:

- **Jev judges the work.** A small, fast model reads the brief and says how demanding the work is (`basic`,
  `standard`, or `strong`), what kind of work it is, and whether the brief is ready to send. Jev knows nothing about
  your subscriptions or their usage.
- **routr works out where there is room.** It looks at how much of each subscription you have left and ranks them.
  This is plain arithmetic on your usage and your settings: no model, the same inputs always give the same answer.
- **The orchestrator decides.** It gets both answers and picks the subscription and model. It may go against the
  ranking, because it knows things routr does not: what is already running and what comes next.

You can see the ranking any time, with no brief, by running `routr usage`.

## The usage routr sees

routr reads each subscription's usage from the harness itself: how much of each usage window is used and when it
resets. It reads usage the way the harness shows it to you, without sending it a prompt, and sends the numbers
nowhere. Every reading shows how old it is. If routr cannot read a subscription, it uses a number you set
(`assumed_headroom`) and says so.

## Your settings

You decide where work may go, with two settings per subscription. `routr setup` asks you for both, for each
subscription it finds, and explains them as it goes; press Enter to take the suggestion. It saves them in
`~/.config/routr/config.json`.

To change one later, run setup again with just that setting, for example:

    routr setup --hardest cursor=strong
    routr setup --reserve claude=30%

An agent setting routr up for you asks you the same questions and passes your answers the same way. A change applies
from the next call, `routr usage` shows the values in effect, and `routr doctor` tells you if a setting is missing or
invalid, with the command that fixes it.

- **`hardest_work`**: the most demanding level of work you are willing to send there.

  | Level | What Jev means by it |
  |---|---|
  | `basic` | Rote or well-specified work; a small, fast model is enough |
  | `standard` | The worker has to find something out or choose an approach |
  | `strong` | A wrong or shallow result would be expensive and hard to notice |

  The suggestion setup offers is a starting point, not a measurement. Raise it for a subscription you trust with your
  hardest work; lower it for one you want to keep for your own.
- **`reserve`**: the share you keep for your own work, for example 25%. routr never offers it to a worker.

Two more you rarely need, set in the file: `assumed_headroom`, the share routr assumes is left when it cannot read a
subscription's usage, and `metered_rank`, where a seat billed per use with no quota goes in the order (see below).

Your default model on each subscription is shown beside it in the ranking but does not change the order.

## Which subscriptions can take the work

A subscription takes work at its `hardest_work` level and below. For `strong` work, a subscription you set to
`standard` is left out of the ranking, and the output says why.

## How much room each subscription has

For each subscription that can take the work, routr works out a **usable** share between 0 and 1:

1. **Start with what is left** in each usage window. A subscription can have several, for example one that resets
   every few hours and one that resets weekly.
2. **Hold back your reserve.** The reserve shrinks as a window nears its reset, because whatever is unused at the
   reset is lost anyway: with half the window still to run, half the reserve is held back.
3. **Count the tightest window.** A subscription with plenty left this week but little left in the next few hours is
   only as usable as those few hours.

A seat billed per use with no quota has no window to measure. By default it is listed after every subscription that
still has room, so it takes the overflow: your subscriptions' included usage expires, billed usage does not.
`metered_rank: "with"` ranks it alongside your subscriptions instead.

## The order

Subscriptions with room come first, most usable at the top, then billed seats, then subscriptions already at their
reserve. The first one with room is named `most_room`. If every subscription that can take the work is at its
reserve, routr says to hold the work or ask you. It never offers a reserve.

## An example

Subscription A has a reserve of 0.25 and two windows:

- The 5-hour window is 40% used and resets in 1.4 hours, so little of it is still to run and only 0.07 of the reserve
  is held back: 0.60 left − 0.07 = **0.53** usable.
- The weekly window is 19% used with most of the week to go: 0.81 left − 0.18 held back = 0.63 usable.
- A counts as **0.53**, its tighter window.

Beside it: B at 0.55 and C at 0.24, both set to `standard`, and D, a seat billed per use. For `standard` work the order
is B, A, C, then D. For `strong` work B and C are left out, so A comes first and D takes the overflow.

## What routr leaves to the orchestrator

- **Which model.** routr never names or compares models, and knows no prices, so nothing in it goes out of date when
  models change.
- **How big the work is.** routr ranks by room left, not by whether a large task fits in it. Jev's level says
  something about size; the orchestrator judges the rest.
- **The decision.** routr advises; the orchestrator chooses.
