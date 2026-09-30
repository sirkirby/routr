# How routr decides where work can go

When your orchestrator, the agent handing work out to workers, is about to launch one, it asks `routr dispatch`.
Three parties take part:

- **Jev judges the work.** A small, fast model reads the brief and says how demanding the work is (`basic`,
  `standard`, or `strong`), what kind of work it is, and whether the brief is ready to send. Jev knows nothing about
  your subscriptions or their usage.
- **routr lists candidates and capacity.** Your account-use settings decide which accounts are normal or fallback
  candidates. Separately, routr ranks the capacity it can read or that you have told it to assume.
  This is plain arithmetic on your usage and your settings: no model, the same inputs always give the same answer.
- **The orchestrator decides.** It chooses suitable model and effort options first, then compares capacity among
  those options. Headroom alone says nothing about quality, speed or the cost of finishing the task.

You can see the ranking any time, with no brief, by running `routr usage`.

## The usage routr sees

routr reads each subscription's usage from the harness itself: how much of each usage window is used and when it
resets. It reads usage the way the harness shows it to you, without sending it a prompt, and sends the numbers
nowhere. Every reading shows how old it is. If routr cannot read a subscription, it uses a number you set
(`assumed_headroom`) and says so.

## Your settings

You decide where work may go, with three settings per subscription. `routr setup` asks you for each, for every
subscription you let routr use, with each level's meaning beside it and the suggestion already chosen. It saves them
in `~/.config/routr/config.json` when you pick Save and exit.

To change them later, run `routr setup` again: it shows your settings and a menu to change one thing. Or change one
directly:

    routr setup --yes --hardest cursor=strong
    routr setup --yes --reserve claude=30%
    routr setup --yes --use codex=normal

A subscription you turn off (`routr setup --yes --disable agy`) keeps its settings and gets no work until it is on
again.

An agent setting routr up for you asks you the same questions and passes your answers the same way. A change applies
from the next call, `routr usage` shows the values in effect, and `routr doctor` tells you if a setting is missing or
invalid, with the command that fixes it.

- **`hardest_work`**: the most demanding level of work you are willing to send there.

  | Level | What Jev means by it |
  |---|---|
  | `basic` | rote or well-specified work; a small, fast model is enough |
  | `standard` | the worker must find something out or choose an approach |
  | `strong` | a wrong or shallow result would be expensive and hard to notice |

  The suggestion setup offers is a starting point, not a measurement. Raise it for a subscription you trust with your
  hardest work; lower it for one you would rather give only lighter work.
- **`reserve`**: the share of the subscription routr holds back from workers, for example 25%, so the orchestrator
  (which usually runs on one of your subscriptions) and anything you run outside routr still have room. routr stops
  sending workers to a subscription when less than its reserve is left; 0% holds nothing back.
- **`use`**: `normal` means consider this account for everyday work, including funded enterprise usage. `fallback`
  means use it when no normal account can suitably take the work. This is independent of billing: either an included
  subscription or a metered account can be normal or fallback. It does not set or enforce a spending budget.

`assumed_headroom` is the share routr assumes when it cannot read an included or unknown account's usage. It is
labelled assumed. Metered accounts always have unknown remaining budget.

Existing configurations keep their use preference: without `use`, a metered account with legacy `metered_rank:
"after"` (the default) is fallback; `"with"` is normal. Other accounts are normal. Reading config never rewrites it.
Explicit `use` wins. The legacy `--metered name=after|with` flag remains a setter for fallback or normal respectively;
when passed with `--use`, `--use` wins. Prefer `--use` for new settings, including seats whose billing is unknown.
After updating, run `routr setup` to review Account use and your other settings. Version-specific upgrade steps
are in the [release notes](https://github.com/sirkirby/routr/releases).

Your default model on each subscription is shown beside it in the ranking but does not change the order.

## Which subscriptions can take the work

A subscription takes work at its `hardest_work` level and below. For `strong` work, a subscription you set to
`standard` is left out of the ranking, and the output says why. A subscription whose harness is not signed in is left
out of every ranking, with the command that signs it in.

## How much room each subscription has

For each subscription that can take the work, routr works out a **usable** share between 0 and 1:

1. **Start with what is left** in each usage window. A subscription can have several, for example one that resets
   every few hours and one that resets weekly.
2. **Hold back your reserve.** The reserve shrinks as a window nears its reset, because whatever is unused at the
   reset is lost anyway: with half the window still to run, half the reserve is held back.
3. **Count the tightest window.** A subscription with plenty left this week but little left in the next few hours is
   only as usable as those few hours.

A seat billed per use with no quota has no window to measure. Its `headroom` and `usable` are null, including when
legacy `metered_rank: "with"` is set. Routr cannot infer a shared prepaid balance or a personal allowance from this.
A cap the harness reports is still enforced as a window, even with a `billing: "metered"` override.

## The order

`candidates.normal` and `candidates.fallback` list eligible names alphabetically, without ranking model quality.
Accounts at their reserve are absent. The lead starts with suitable model/effort options on normal accounts and may
use fallback when none suitably takes the work, including when the remaining normal models do not fit the task.

`ranked` remains a capacity diagnostic: accounts with a number come first, most usable at the top, then metered
accounts, then accounts at their reserve. `most_room` names only an account with a positive number; it is null when
only metered candidates remain. Numbers may be labelled assumed. Neither field is a recommendation to choose that
account. If there are no candidates, hold the work or ask the user. Routr never offers a reserve.

## An example

Subscription A has a reserve of 0.25 and two windows:

- The 5-hour window is 40% used and resets in 1.4 hours, so little of it is still to run and only 0.07 of the reserve
  is held back: 0.60 left − 0.07 = **0.53** usable.
- The weekly window is 19% used with most of the week to go: 0.81 left − 0.18 held back = 0.63 usable.
- A counts as **0.53**, its tighter window.

Beside it: B at 0.55 and C at 0.24, both set to `standard`, and D, a metered account set to normal use. For `standard`
work the capacity order is B, A, C, then D, but all four are normal candidates. For `strong` work B and C are left out.
A and D are candidates; the lead may select D for task fit even though its remaining budget is unknown.

## What routr leaves to the orchestrator

- **Which model.** routr never names or compares models, and knows no prices, so nothing in it goes out of date when
  models change.
- **How big the work is.** routr ranks by room left, not by whether a large task fits in it. Jev's level says
  something about size; the orchestrator judges the rest.
- **The decision.** routr advises; the orchestrator chooses.
