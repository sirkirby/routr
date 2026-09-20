# routr

routr helps one coding agent run a team of others across the AI subscriptions you already pay for: Claude Code,
Codex, Cursor, and Antigravity. It pairs with [herdr](https://github.com/herdrdev/herdr), which provides the panes
the workers run in, and is named after it.

A long task on one subscription runs it hot, and an agent left to itself gives every subagent its own, largest
model. routr spreads the work instead. The lead agent stays the judge. routr gives it the same fast, consistent
read every time it is about to hand out work, and again when the work comes back.

## The loop

1. **Plan.** The lead asks `routr dispatch "<brief>"`. A small decision model
   ([TypeSafe's Jev](https://docs.typesafe.ai)) reads the brief in about 300 ms and answers a fixed set of narrow
   questions. Code adds each subscription's live usage. routr never names a model.
2. **Build.** The lead picks the subscription, the model, and the reasoning effort, and `routr launch` starts the
   worker in a herdr pane with that harness's flags, handling shell prompts and trust dialogs on the way.
3. **Judge.** When the worker reports, `routr check` takes a first read of the report against the brief. The lead
   then runs its own check, which is what decides.
4. **Fix.** Work that falls short goes back to the same worker. If it falls short again, the lead relaunches it one
   level up. Starting high "to be safe" is not needed, because the loop catches what a lower level misses.
5. **Record.** `routr record` writes one line to a local ledger: what was advised, what was chosen, how it turned
   out, how many attempts it took. `routr assess` reads the ledger back.

## What the advice looks like

    $ routr dispatch "The nightly export job times out on large accounts. Find the cause, fix it, add a regression test, run bun test."

    headline   routr: standard, debug work; approach_open, cause_unknown
    worker     worth a worker
    facts      names_location no · approach_open yes · cause_unknown yes · cross_cutting no
               concurrency_or_data unclear · hard_to_reverse no · states_check yes · standalone yes
    ranked     agy     0.86 usable   weekly 3% used, resets in 164 h · 5-hour 12% used, resets in 1 h
               cursor  0.82 usable   (given by the caller)
               codex   0.36 usable   weekly 50% used, resets in 116 h
               claude  0.35 usable   weekly 61% used, resets in 28 h · 5-hour 36% used, resets in 2 h

The real output is one JSON object; this is its content.

- **worker**: is this worth handing out at all? `do it yourself` for one or two small edits, `settle it with the
  user first` when the brief leaves them a decision, `split it across workers` for independent pieces.
- **facts**: what the brief states, each read as yes, no, or unclear with its probability. `unclear` means the brief
  does not settle it; the lead can, because it knows the codebase. `states_check` and `standalone` are about the
  brief itself: when either reads no, fix the brief before sending it.
- **level**: `basic`, `standard`, or `strong`, a one-word summary, with `sure: false` when routr was split.
- **ranked**: usable headroom per subscription, with every usage window as the harness reports it. Your reserve is
  subtracted, and it shrinks as a window nears its reset, because unused capacity expires then.
- **notes**: your standing preferences and any risk warning. Advice, never an override.

The lead decides how much intelligence and reasoning the work needs. It starts at the advice and at your default
model, and goes higher only when a fact calls for it. When it settles on something else it says so
(`ROUTR: <advised> → <chosen> because <reason>`), and that goes in the ledger too.

## Commands

    bun <skill folder>/scripts/routr.mjs <command> --help

| Command | What it does |
|---|---|
| `subagent "<brief>"` | An agent is about to spawn a subagent: facts, level, worth-a-worker. |
| `dispatch "<brief>"` | An orchestrator is about to launch a pane: the same, plus subscriptions ranked by usable headroom. `--headroom cursor=0.9` passes usage the caller read itself. |
| `launch` | Start one worker in a herdr pane: flags, model syntax, shell prompts, trust dialog, readiness, prompt. `--dry-run` shows the plan. |
| `check --brief <f> --report <f>` | A first read of a worker's report: no verification named, part of the brief skipped, gaps admitted, a symptom patch, out of scope. |
| `record`, `assess` | Write one ledger line; read the ledger back. `record` is the only command that writes to routr's own state. |
| `doctor` | Check the setup: harnesses found, live usage, key, config, each harness's current model list. Changes nothing. |

The advice commands write nothing and never block an agent: with no network or no key they still answer, marked as
a fallback.

## Install

You need [Bun](https://bun.sh), a [TypeSafe](https://typesafe.ai) API key, and herdr for orchestration (sizing
subagents works without it).

The easy way: paste [INSTALL.md](INSTALL.md) into your coding agent and ask it to install routr. By hand:

    npx skills add sirkirby/routr -g      # every harness on this machine
    bunx skills add sirkirby/routr -g     # the same, if you have no Node: bunx comes with Bun
    # or, for Claude Code alone: /plugin marketplace add sirkirby/routr, then /plugin install routr

Then ask your agent to set routr up. It follows `skills/routr/references/setup.md`: `routr doctor`, the key in
`~/.config/routr/env`, and a config at `~/.config/routr/config.json` that it writes with you.

## Configuration

Everything in the config is a preference of yours. Nothing in it describes a model's ability or price, so nothing
goes stale when models change.

- Per subscription: `reserve` (the share routr must never offer), `hardest_work` (the hardest work you would hand
  it), `default_model` and `default_effort` (your everyday choice there, picked from the harness's live list), and
  `assumed_headroom` for a subscription whose usage cannot be read.
- `prefer`: your standing preference per kind of work, for example `"review": "strong"`.

Usage is read live for Claude Code (through a small statusline script that ships with the skill), Codex, and
Antigravity. Cursor has no local source; the orchestrator reads its `/usage` panel through a pane and passes the
number in. Usage is re-read on every call and never cached.

## What is measured, and what is not

[docs/evidence.md](docs/evidence.md) lists what has been measured and how. In short: the facts are decisive and
stable, the judge questions separate good reports from flawed ones, workers on all four harnesses follow the skill,
and three end-to-end runs with a real lead delivered verified work across subscriptions. Predicting the right
capability level from a brief alone is not reliable, which is why routr is built around the loop rather than the
prediction. routr does not estimate or manage context; harnesses own that.

## Contributing

Improvements come by pull request. A change to a question's wording is a new question-set version and needs its
measurement; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
