---
name: routr
description: Spread coding work across several AI subscriptions and harnesses (Claude Code, Codex, Cursor, Antigravity) from one orchestrating agent in herdr, and size subagents to the work. Use when the user asks to orchestrate, fan out, or delegate work across panes, harnesses, or subscriptions; when your launch prompt says you are a routr worker; before spawning subagents in a routr-managed session; or when asked to set up, configure, or check routr.
metadata:
  version: "0.1.12"
---

# routr

routr gives you a quick, calibrated read at the moment you hand out work. A small decision model (Jev, from
TypeSafe) reads the brief you are about to give and answers a fixed set of questions in about 300 ms: facts about
what the brief says, what kind of work it is, how costly a mistake would be, and an overall level. Code adds the
live usage of each subscription. **You make the decision**: how much intelligence and reasoning the work needs, and
so which model and effort. You know the codebase and the purpose of the work; routr does not. It gives you the same
consistent starting point every time, so the decision is not made from habit.

routr is one standalone command, `routr`, normally at `~/.local/bin/routr` (`routr.exe` on Windows). If it is not on
your PATH, call it by that full path.

**If `routr` is not installed:** tell the user routr needs its command, ask whether you may install it, and run the
installer for their system. It takes a few
seconds, needs no Node or Bun, verifies the download's checksum, and installs to `~/.local/bin`.

```sh
curl -fsSL https://raw.githubusercontent.com/sirkirby/routr/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/sirkirby/routr/main/install.ps1 | iex
```

Then run `routr doctor`; if it reports no key or no config, read `references/setup.md`. Someone working on routr
itself can run it from source instead: `bun <this skill's folder>/scripts/routr.mjs`.

The advice commands write nothing and never fail: with no network or no key they still print advice, marked as a
fallback.

## Which part applies to you

- Your launch prompt says you are a **routr worker**, or you are about to spawn a subagent → read `references/worker.md`.
- You are the **orchestrator**: you plan the work, hand it out, judge what comes back, and send it back when it
  falls short → read `references/orchestrator.md`, then `references/harnesses.md` before you launch anything.
- The user wants routr **set up, configured, or checked** → read `references/setup.md`.

## Reading the advice

`routr subagent "<brief>"` and `routr dispatch "<brief>"` print one JSON object. The brief can also be piped on stdin.

- `headline`: the advice in one line. Read it first; the rest is the detail behind it.
- `worker`: whether the work is worth handing out at all: `do it yourself` (one or two small edits), `settle it with
  the user first` (the brief leaves them a decision), `split it across workers` (independent pieces), or `worth a
  worker`. A suggestion with its reason; you know what else is running.
- `facts`: yes / no / unclear readings of what the brief says, each with its probability: does it name where to
  work, is the approach left open, is the cause unknown, is the change cross-cutting, are concurrency or stored data
  involved, is it expensive to undo. In testing, 63 to 88% of these readings were decisive, and the same brief got
  the same reading 107 times out of 108. `unclear` means the brief does not settle it: you can, from the codebase.
  Two facts are about your brief, not the work: `states_check` and `standalone`. When either reads `no`, fix the
  brief before you send it.
- `level`: a one-word summary: `basic` (rote or well-specified), `standard` (must find something out or choose an
  approach), or `strong` (a wrong or shallow result would be expensive and hard to notice). `sure: false` means routr
  was torn between the two levels in `between`; it then reports the lower one, which testing showed is right nine
  times in ten. routr never names a model.
- `notes`: the user's standing preferences and any risk warning, written for you to weigh. They are advice.
- `subscriptions` (dispatch only). `ranked` lists each subscription with its usable headroom, marked `live`, `given`
  (you passed it in), or `assumed`. Under `windows` it shows each usage window as the harness reports it: percent
  used and hours until it resets. The user's reserve shrinks as a window nears its reset, because unused capacity
  expires then. `your_default` is the user's everyday model on that subscription. `excluded` lists subscriptions the
  user does not give work this hard. Never spend a reserve: when everything is at its reserve, hold the work or ask
  the user.

## Deciding

**Start at the advice, not above it.** The loop is ask, build, judge, fix: work that falls short gets sent back or
relaunched one level up, so starting high "to be safe" only costs more. (Measured: a lead left to itself went above
the advice on 5 of 7 briefs and set effort to high every time.)

- **Intelligence** (which model): start from the advised level and the user's default model. Go higher only when a
  fact that calls for it reads `yes`: approach open, cross-cutting, concurrency or stored data, expensive to undo,
  high risk. For `basic` work go below the user's default when the harness has a smaller model.
- **Reasoning effort**: start at the user's default effort. Raise it only for work that needs many steps held
  together: an unknown cause to run down, a long chain of changes that must agree. Size alone is not a reason.
- Give one reason for the intelligence you chose and a separate one for the effort, in the record's `--note`.

The split between intelligence and reasoning effort is routr's working guidance. It has not been measured.

When you settle on something other than what was advised, say so where the user will see it:

    ROUTR: <advised> → <chosen> because <reason>

Those lines are how the questions get better, so do not skip them.
