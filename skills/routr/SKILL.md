---
name: routr
description: Spread coding work across several AI subscriptions and harnesses (Claude Code, Codex, Cursor, Antigravity, Kiro) from one orchestrating agent, with workers in herdr panes or headless outside herdr, and size subagents to the work. Use when the user asks to orchestrate, fan out, or delegate work across panes, harnesses, or subscriptions; when your launch prompt says you are a routr worker; before a routr worker, or an agent outside herdr, spawns a subagent; or when asked to set up, configure, or check routr.
metadata:
  version: "0.0.0-dev"
---

# routr

routr gives you a quick, calibrated read at the moment you hand out work. The first answering decision model in
the user's ordered list (TypeSafe's Jev by default, or Cloudflare's Clef) reads the brief you are about to give and
answers a fixed set of questions: facts about
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
itself can run it from a checkout with Bun instead (CONTRIBUTING.md says how).

The advice commands change nothing of the user's and never fail: if no configured model answers, they still print
advice, with a `no reading` headline and one entry per failed decision model in `unavailable`. Matching fallback advice is valid for
launch: read `unavailable`, tell the user in the launch line that the advice was a fallback and what was unavailable,
and judge that part yourself.

## Which part applies to you

- Your launch prompt says you are a **routr worker** → read `references/worker.md`; it covers sizing your subagents.
- You are **outside herdr**, with no routr worker launch prompt, and about to spawn a subagent for a piece of your
  own work → read only "Before you spawn a subagent" in `references/worker.md`: the rest is for routr workers. Handing
  work out, outside herdr too, is the orchestrator's job (next).
- You are the **orchestrator**: you plan the work, hand it out, judge what comes back, and send it back when it
  falls short → read `references/orchestrator.md`, then `references/harnesses.md` before you launch anything. A user
  can start a session this way by typing `/routr-orchestrate <plan>` (`$routr-orchestrate` in Codex). Outside
  herdr, `routr launch` starts Claude Code, Codex, Cursor, Antigravity and Kiro workers headless, followed with `routr wait` (the guide's "Outside herdr"
  section).
  Never spawn your harness’s own subagents and never run `routr subagent` (it is the workers' command), in herdr or
  not. Every piece you hand out, research and reviews included, is a routr worker (a pane worker in herdr, a headless
  one outside it). Every worker starts with `routr launch` (`--worktree <branch>`, and `--base <ref>` to start from another
  branch or commit) and ends with `routr cleanup`, the command in its launch result’s `next`. Never close a worker's pane to
  finish it: that leaves its worktree behind.
- The user wants routr **set up, configured, or checked**, or **a setting changed** (a model, an effort, a reserve,
  turning a subscription off) → read `references/setup.md`: every setting has a command.

## Reading the advice

Every run command starts with `ok`, `headline`, `unavailable`, `warnings` and `next`. `ok` says whether the command
produced what it is for; a stopped command also carries `error`. Follow `next` for instructions.

`routr subagent "<brief>"` and `routr dispatch "<brief>"` print one JSON object. The brief can also be piped on stdin
or read with `--task-file <path>`.
Ask about the exact text the worker will get, not a summary of it: for a launch, `routr dispatch --task-file <path>`
(`references/orchestrator.md` has the whole flow, and `launch --advice` requires matching advice).

- `headline`: the advice in one line. Read it first; the rest is the detail behind it. When the decision-model
  list gives no answer, it starts with `no reading`, names the last failed model and provider, and states the fallback
  level. A reading names the model that answered.
- `unavailable`: what routr could not read, as a list (`[]` when nothing was missing). A `decision model` entry names
  `provider`, the attempted `model`, a fixed failure `code` and its recovery action in `why` (`status` also records a provider error's HTTP status). A `usage` entry names `subscription`, `source`,
  `code` and `why`. Fresh usable readings stay available even after a failed refresh. Otherwise `reading` says
  `assumed` or `kept`; a kept older reading adds `reading_source` and `age_sec`. An internal usage-ranking error
  names `source: "routr"` with no subscription. Read these before deciding, tell the user in the launch line when advice was a fallback, and
  judge the missing part yourself. `check` uses the same field, adding `brief` or `report` for unreadable files.
  A later model's answer is ordinary advice: its headline names that model, and earlier failures in `unavailable`
  do not make it fallback advice. Tell the user the backup answered and why the first choice could not answer.
  Only true fallback and missing usage need your own reading of those parts. `launch` carries all the saved decision-model entries; older fallback advice
  says it does not name the attempted model. `decision_model` still means the model that answered, so it is absent on fallback advice.
- `worker`: whether the work is worth handing out at all: `do it yourself` (one or two small edits), `settle it with
  the user first` (the brief leaves them a decision), `split it across workers` (independent pieces), or `worth a
  worker`. A suggestion with its reason; you know what else is running. From `routr subagent`, a worker is a
  subagent; from `routr dispatch`, a worker you start with `routr launch`.
- `facts`: yes / no / unclear readings of what the brief says, each with its probability: does it name where to
  work, is the approach left open, is the cause unknown, is the change cross-cutting, are concurrency or stored data
  involved, is it expensive to undo. In testing, 63 to 88% of these readings were decisive, and the same brief got
  the same reading 107 times out of 108. `unclear` means the brief does not settle it: you can, from the codebase.
  Two facts are about your brief, not the work: `states_check` and `standalone`. When either reads `no`, fix the
  brief before you send it.
- `level`: a one-word summary: `basic` (rote or well-specified), `standard` (must find something out or choose an
  approach), or `strong` (a wrong or shallow result would be expensive and hard to notice). `sure: false` means routr
  was torn between the two levels in `between`; it then reports the more likely one (the lower, if they are equally likely; and when the model gives
  no spread there is no `between`, and the level is its score rounded). Its note says how often that was right on 36
  real tasks for the model that answered (`decision_model`), and which way it was wrong: Jev 1.14, 28 times, one level too
  low 7 times and too high once. routr never names a model for the work.
- `notes`: the user's standing preferences and any risk warning, written for you to weigh. They are advice.
- `warnings` (always a list): facts about this call: a config setting routr could not use, an input it ignored or
  read differently, a skipped check, or something left behind. Input examples include an unreadable `--headroom`,
  a flag-like word set aside while stdin supplied the brief, or a flag-like word kept as part of a prose brief.
  Follow `next` for any action the warning calls for; changing the task needs fresh dispatch advice before launch.
- A flag-led invocation without a stdin brief is refused with `ok: false`, without a reading. Quote the whole inline
  brief if it contains flags, or use `--task-file <path>`; follow `next` to correct the input.
- `subscriptions` (`dispatch` and `usage`). `candidates.normal` lists accounts for everyday work; `candidates.fallback` lists
  accounts for when no normal candidate can suitably take it. Choose model/effort fit first, then compare capacity
  among suitable options. `most_room` is only a capacity observation. `ranked` lists usable headroom, marked `live`, `given`
  (you passed it in), or `assumed`. `age_sec` is how old the reading is, and `note` says what the harness showed beside
  the number (Cursor: its Auto and API pools; Kiro: its plan and credits) or why a number is assumed. A snapshot too
  old to use stays `assumed` with its age in `age_sec`; age alone is not a read failure. A metered account with
  unknown capacity is a valid reading. Under `windows` it shows each usage window as the harness reports it: percent
  used and hours until it resets. The user's reserve shrinks as a window nears its reset, because unused capacity
  expires then. `your_default` is the user's everyday model on that subscription. `excluded` lists subscriptions the
  user does not give work this hard, any the user turned off, and any whose harness is not signed in (its `why`
  says what to run). Never spend a reserve: when everything is at its reserve, hold the work or ask
  the user. `class` says what kind of pool each one is: `included` (a subscription whose windows expire), `capped`
  (a spend cap the vendor enforces, shown as one more window), `metered` (a seat with no quota, billed per token:
  no headroom number or known remaining budget), or `unknown`. `use` is the user's normal/fallback preference,
  independent of billing. A normal metered account is considered alongside normal included accounts. When the user
  set a launch `share` and two or more normal metered accounts are ranked, each carries `share` (`weight`, `target`,
  `used_pct`, `left`, `launches` and `of`, read like a window: its weight and that weight's fraction, the percent of
  routr's launches on these accounts it took in the last 7 days, how far it is below its target, and the counts) and `share_due` names the one furthest below. It is a ratio
  of launches the user asked for, not a budget or a headroom.

## Deciding

**Quality first; efficiency among suitable options.** Choose a model and effort you have reason to trust to deliver
a verified result. Include the time and usage spent correcting work when judging efficiency. Costly or hard-to-detect
failures can justify stronger initial execution; a larger model needs a reason tied to the work or relevant experience.

1. **Work level:** start with the advised level, facts and uncertainty. Weigh the user's preferences and concrete
   repository context, including facts the brief did not give routr. Explain any change to the level. If you change it,
   refresh eligible accounts for that level before choosing one (see `references/orchestrator.md`).
2. **Model and effort:** identify suitable options on eligible normal accounts. `your_default` is an everyday
   preference, not a mapping from difficulty to model. Consider smaller models when you trust them to meet the
   quality requirements. Choosing a larger model does not itself change the work's level. Judge effort separately:
   an unknown cause or a long chain of dependent changes may call for more reasoning; size alone does not.
3. **Account:** among suitable options, weigh usable capacity and its age, user preferences, and known time or
   spending constraints. Use fallback accounts when normal options lack suitability or capacity. Respect disabled
   accounts, sign-in requirements, `hardest_work` and reserves. Configured normal/fallback use already supplies
   permission in those circumstances. Weigh unknown capacity or budget alongside explicit spending limits; an
   assumed reading is the user's assumption, not a measurement. Headroom does not estimate whether a task fits.
   Among suitable metered options, prefer `share_due` unless the work has a reason to go elsewhere, and say why in
   the launch line when you don't. Whether leads following it reach the user's ratio is not measured.

You own the final choice within those boundaries. Before launch, state the advised and chosen level, model, effort
and account, with separate reasons for model and effort; keep those reasons in the record's `--note`. After inspecting
the result, you may change model, effort or harness when the evidence warrants it. The orchestrator guide covers
verification, recovery and recording.

This is working guidance, not a measured guarantee of better quality or efficiency.

When you choose a different level, also say so where the user will see it:

    ROUTR: <advised> → <chosen> because <reason>

Record the chosen level explicitly so the original assessment and your decision remain distinguishable.
