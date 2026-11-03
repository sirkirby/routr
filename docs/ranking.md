# How routr picks an account

The decision model reads the brief and advises a work level. routr adds the eligible accounts and their capacity;
the lead chooses the account, model and effort. See the [command contracts](contracts.md) for output fields and
[guarantees](guarantees.md) for how readings are kept and refreshed. `routr usage` shows the basic-work view without
a brief; `routr usage --level standard` refreshes eligibility when the lead chooses a different level.

## What you set per account

| Setting | Means | If unset |
|---|---|---|
| On or off | Off gets no work | On |
| Hardest work | The most demanding level it may take: basic, standard or strong | Asked in setup |
| Use | `normal`: everyday work. `fallback`: only when no normal account suitably fits | Normal |
| Reserve | Share of a usage window to hold back; `0` uses it until exhausted | Asked in setup |
| Share | Weight in your launch ratio between normal metered accounts | No ratio |
| Default model and effort | Where the lead starts; never changes which account gets work | Lead chooses |
| `billing` | Corrects the kind when routr reads it wrong; most people never set it | Read from the harness |

Run `routr setup` to review these choices, or change one directly:

    routr setup --yes --hardest cursor=strong
    routr setup --yes --reserve claude=30%
    routr setup --yes --use codex=fallback
    routr setup --yes --share claude=2 --share codex=1

Hardest work uses these levels:

| Level | Meaning |
|---|---|
| basic | rote or well-specified work; a small, fast model is enough |
| standard | the worker must find something out or choose an approach |
| strong | a wrong or shallow result would be expensive and hard to notice |

For reserve, 0% holds nothing back.

Use is only ever your choice. routr never changes it because of what it reads. A metered seat with no `use` set
gets everyday work. To prefer included plans, set the metered seat to `fallback`. Reading config never rewrites it.
The removed settings `metered_rank` and `assumed_headroom` do nothing; an old config containing either gets a warning.
A setup change removes them, or you can delete them by hand.

## What routr reads

- **Kind: how it is paid for.** `included` is a plan; `metered` is pay per use; `unknown` means routr cannot tell.
  Setting a budget does not change the kind. `billing` corrects the kind when no usable window arrived; a window
  the harness reports always counts, and `--headroom` remains a number the caller supplies.
- **Windows: how much is left.** A plan's windows, or an admin budget the harness reports, which is simply one
  more window. Today only Codex reports an admin budget in a form routr reads. routr does not see a Claude
  Enterprise budget.
- **Sign-in.** From the harness itself.

For each window, routr subtracts your reserve from what is left and uses the tightest result. The reserve shrinks
as a window nears its reset, because unused capacity expires then. A window of unknown length, or with a past
reset, holds the full reserve. A metered account with a budget window has a usable number by this same arithmetic.

No usable reading means room is unknown: `usable: null`, with a note saying why. This includes an included plan
whose usage cannot be read and a metered seat with no window. Both stay offered. A failed read also appears in
`unavailable`; a kept reading is used as before. Unknown room is never treated as full.

## How one launch gets its account

1. **Left out, with the reason:** off, not signed in, or the work is harder than its hardest-work setting.
2. **Is there room?** A window at its limit or reserve leaves the account out of candidates. No reading leaves
   room unknown and keeps the account in.
3. **Normal accounts first.** Fallback accounts count only when no normal account suitably fits.
4. **The lead chooses, model and effort fit first.** Among included accounts that fit, prefer the most room,
   because unused capacity expires at the reset. Among normal metered accounts, follow the launch ratio until
   one is out of room. Between an included plan and a metered seat, there is no preference rule: the lead chooses.
5. **Nothing left:** the lead holds the work or asks you. routr never spends a reserve.

The capacity diagnostic puts positive usable numbers first, then unknown room, then accounts at their reserve.
`most_room` names only an account with a positive number. The candidate lists are alphabetical permissions,
not recommendations about model quality.

## Your launch ratio

With at least two eligible normal metered accounts and a `share` set, routr orders those accounts among their
existing positions by how far each is below its target. A metered account qualifies with unknown room or a
positive usable number. A limit at its reserve leaves the ratio; launches split among those left.

With Claude weight 2 and Codex weight 1, about two Claude launches are due per Codex launch. A Codex budget at
40% does not change that ratio. At the budget, Codex leaves candidates; after the budget is raised, it returns on
the next call. A budget on Claude is invisible to routr, so its ratio continues until Anthropic stops the seat.

The ratio counts routr's own launches over seven days, whatever kind the account read as when launched. An unset
weight counts as 1; `--share name=off` removes a weight. `share_due` names the account furthest below its target,
with ties to the larger weight and then the name; it is null when none is due. Each row's `share` shows the weight,
target fraction, percent of launches used, fraction below target, and launch counts. This is a ratio of launches,
separate from capacity: `most_room` still names the largest positive usable number. Whether leads following the
ratio reach it is not measured.

routr only advises. Vendors enforce their own limits; when a budget is gone, the seat stops and the lead moves a
worker that fails there. routr sets no spending limit, reads no Claude budget from its screen, and puts no money,
prices or worker model names in advice. Quality comes first; the lead verifies outcomes and weighs corrections
when choosing future work. An improvement in quality or efficiency from this procedure is not measured.
