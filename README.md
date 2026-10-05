# routr

![routr: the lead agent in your terminal hands work, through routr, to workers on the other AI subscriptions you pay for](assets/routr-banner.png)

routr lets one coding agent run a team of others across the AI subscriptions you already pay for: Claude Code,
Codex, Cursor, Antigravity, and Kiro.

**It uses what is already on your machine.** The workers are the harness CLIs you have installed and logged in to,
started in [herdr](https://github.com/herdrdev/herdr) panes (routr is named after it). There are no provider API
keys to hand over, no proxy, and no new accounts: your subscriptions, your logins, your settings. The one key routr
needs is for its own decision model.

**The questions are the product.** Each time the lead is about to hand out work, and again when the work comes
back, routr asks a fixed set of narrow yes-or-no questions about the text. They were tuned against real briefs and
real worker reports: the ones that separated easy work from hard work, and good reports from flawed ones, stayed,
and the rest were dropped ([the evidence](docs/evidence.md)). A System One model
([TypeSafe's Jev](https://docs.typesafe.ai)) answers them in about 300 ms with calibrated probabilities, the same
way every time. Code adds each subscription's live usage. The lead agent, your smartest model, stays the judge.

A long task on one subscription runs it hot, and an agent left to itself gives every subagent its own, largest
model. routr spreads the work across what you have, and starts each piece at the level it needs.

## The loop

1. **Plan.** The lead asks `routr dispatch < task.md`, on the exact task it will hand over, and gets a fixed set of narrow facts about it, plus
   each subscription's usable headroom. routr never names a model.
2. **Build.** The lead chooses suitable model and effort options on normal accounts, then compares their capacity.
   Fallback accounts are available when none suitably takes the task. `routr launch` starts the
   worker in a herdr pane with that harness's flags, handling shell prompts on the way and reporting any question a harness asks at startup.
3. **Judge.** When the worker reports, `routr check` takes a first read of the report against the brief. The lead
   then runs its own check, which is what decides.
4. **Fix.** Work that falls short goes back to the same worker. If it falls short again, the lead relaunches it one
   level up. There is no need to start high "to be safe": work that falls short comes back through this loop.
5. **Record.** `routr record` writes one line to a local ledger: what was advised, what was chosen, how it turned
   out, how many attempts it took, and what caused extra work. `routr assess` reports verified acceptance, execution
   corrections, review follow-ups and launch trouble separately, plus capacity observations. Attempts alone do not rate a model.

## What the advice looks like

    $ routr dispatch "The nightly export job times out on large accounts. Find the cause, fix it, add a regression test, run bun test."

    headline   routr: standard, debug work; approach_open, cause_unknown
    worker     worth a worker
    facts      names_location no · approach_open yes · cause_unknown yes · cross_cutting no
               concurrency_or_data unclear · hard_to_reverse no · states_check yes · standalone yes
    candidates normal: agy, claude, codex, cursor · fallback: none
    ranked     agy     0.86 usable   weekly 3% used, resets in 164 h · 5-hour 12% used, resets in 1 h
               cursor  0.82 usable   (given by the caller)
               codex   0.36 usable   weekly 50% used, resets in 116 h
               claude  0.35 usable   weekly 61% used, resets in 28 h · 5-hour 36% used, resets in 2 h

routr prints this as one JSON object; the listing shows what is in it.

- **worker**: is this worth handing out at all? `do it yourself` for one or two small edits, `settle it with the
  user first` when the brief leaves them a decision, `split it across workers` for independent pieces.
- **facts**: what the brief states, each read as yes, no, or unclear with its probability. `unclear` means the brief
  does not settle it; the lead can, because it knows the codebase. `states_check` and `standalone` are about the
  brief itself: when either reads no, fix the brief before sending it.
- **level**: `basic`, `standard`, or `strong`, a one-word summary, with `sure: false` when routr was split.
- **candidates**: eligible accounts grouped by your normal/fallback preference, listed alphabetically. The lead
  chooses suitable model and effort options on normal accounts first; fallback is available when none suitably takes the work.
- **ranked**: a capacity diagnostic, not a model recommendation. Usable headroom per subscription, with every
  usage window as the harness reports it. Your reserve is subtracted, and it shrinks as a window nears its reset, because unused capacity expires then. How the ranking
  works, step by step: [docs/ranking.md](docs/ranking.md).
- **notes**: your standing preferences and any risk warning. Advice, never an override.

The lead decides how much intelligence and reasoning the work needs. It starts at the advice and at your default
model, and goes higher only when a fact calls for it. When it settles on something else it says so
(`ROUTR: <advised> → <chosen> because <reason>`), and that goes in the ledger too.

## Commands

    routr <command> --help

| Command | What it does |
|---|---|
| `subagent "<brief>"` | An agent is about to spawn a subagent: facts, level, worth-a-worker. |
| `dispatch "<brief>"` | An orchestrator is about to launch a pane: the same, plus normal/fallback candidates and a capacity ranking. Give it the exact task the worker will get (`routr dispatch < task.md > advice.json`); `launch --advice advice.json` warns when they differ. `--headroom <name>=0.9` (or `90%`) overrides a reading. |
| `usage [cursor\|kiro]` | Each subscription's usage, candidates and capacity ranking, with no brief. `usage cursor` or `usage kiro` reads that one now. |
| `launch` | Start one worker in its own git worktree, nested under the repo in herdr: flags, model syntax, shell prompts, startup questions reported (never answered), readiness, prompt. `--dry-run` shows the plan. |
| `check --brief <f> --report <f>` | A first read of a worker's report: no verification named, part of the brief skipped, gaps admitted, a symptom patch, out of scope. |
| `record`, `assess` | Write one ledger line; read the ledger back as advice about your own settings. |
| `share` | Write exactly what telemetry sends to a file you can read. Sends nothing. |
| `telemetry on\|off\|status\|send` | Share anonymous outcomes once a day; off unless you turn it on ([details](docs/telemetry.md)). |
| `feedback "<text>"` | Send the maintainers a note in your own words. |
| `key set` | Store your TypeSafe API key: typed without echo, saved readable only by you, then tested. |
| `update` | Update to the newest release on your update channel now (routr also does this by itself in the background, at most once a day). |
| `setup` | Your settings. At a terminal, a guided screen: which subscriptions routr uses, then each one's model, effort, hardest work, reserve and account use; run again, a menu to change one thing. An agent changes a setting with a flag (`--model`, `--effort`, `--hardest`, `--reserve`, `--use`, `--enable`, `--disable`, `--channel`) and reads them first with `--show`. |
| `uninstall` | Remove routr: the binary, its two skills, the cache, and a `routr statusline` entry in Claude Code's settings (an older routr's setup set one). Keeps your config, key, and ledger; `--purge` removes those too. |
| `doctor` | Check the setup: harnesses found, live usage, key, config, each harness's current model list (for Claude Code, its aliases), and what to do next. Changes nothing. |

The advice commands write nothing and never block an agent: with no network or no key they still answer, marked as
a fallback.

## Install

routr is one standalone binary. It needs no Node, Bun, or packages.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/sirkirby/routr/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/sirkirby/routr/main/install.ps1 | iex
```

That puts `routr` in `~/.local/bin`, checks the download against the release checksums, and installs routr's skills
for your agents, and then starts `routr setup` (run it yourself any time; an agent running the installer is not asked
anything):

```sh
routr setup
```

It asks for your [TypeSafe API key](https://console.typesafe.ai/keys) if it has none (typed without echo, never
shown), finds the harnesses that are installed and signed in, and lets you choose which ones routr may use and each
one's everyday model, effort, hardest work, reserve and account use. Arrow keys choose, Esc goes back, and nothing is written
until you pick Save and exit. It also sets up Claude Code's usage reading. `routr doctor` then shows what is in place and lists anything left to do, and `routr doctor --fix` is
the same command as `routr setup`: safe to run again, it only fills in what is missing. Or ask your agent to "set up
routr", or paste [INSTALL.md](INSTALL.md) into it: it uses the same command and talks the choices through with you.
Later, ask your agent to change a setting ("switch Cursor to Grok 4.7", "stop using Antigravity"): every setting has
a command, and the skill tells it which.

routr keeps itself current. At most once a day a command starts a background check; a new release is downloaded,
verified against its checksums, and swapped in, and your next `routr` run uses it. Nothing you are running is
interrupted. `routr update` does it on demand, `routr doctor` shows when it last checked, and `"auto_update": false`
in the config turns it off. Updates also reinstall the bundled agent skills.
After updating, run `routr setup` to review your settings. See the
[release notes](https://github.com/sirkirby/routr/releases) for changes and upgrade details.

Updates follow stable releases. For early builds, choose the beta channel: the daily update and `routr update` then
follow betas and release candidates as well, and move you to a stable release once it is newer than your beta. Going back to stable
keeps your beta until a stable release passes it; `routr update --force` switches now:

    routr setup --channel beta
    routr setup --channel stable

To remove it, run `routr uninstall`. It shows what it will remove and asks first. Your config, key, and ledger stay
for a later reinstall unless you choose otherwise (`--purge`).

For orchestration you also need [herdr](https://herdr.dev) and its agent skill
(`npx skills add herdrdev/herdr --skill herdr -g`); setup offers to install both, and `routr doctor` tells you when
either is missing. Sizing subagents works without them.

To start an orchestration, open your lead agent in herdr and type your plan after the `routr-orchestrate` skill, which
routr installs beside the routr skill:

    /routr-orchestrate <your plan or task>

In Codex it is `$routr-orchestrate <your plan>`. The session becomes the routr orchestrator: the agent loads the routr
skill, runs `routr doctor`, and hands out every piece through routr. It is meant for you to type, not for an agent to
pick by itself: it carries `disable-model-invocation: true` (Claude Code, Cursor) and Codex's
`allow_implicit_invocation: false`. Measured 2026-10-05 by asking each harness to list the skills available to it:
Claude Code, Codex, Cursor (`cursor-agent`) and Antigravity left it out of the list, and Kiro, which documents no such
setting, listed it, so there its description is the only guard. Anywhere, the same works as a plain
prompt: "You're an orchestrator; use routr to manage the following work: …".

Something not working? `routr doctor` says what is missing, and [docs/troubleshooting.md](docs/troubleshooting.md)
covers the rest.

## Configuration

Everything in the config is a preference of yours. Nothing in it describes a model's ability or price, so nothing
goes stale when models change.

- Per subscription, asked by `routr setup` and changed with `routr setup --hardest <name>=<level>` or
  `--reserve <name>=<share>`: `reserve` (the share routr must never offer), `hardest_work` (the hardest work you would hand
  it), `default_model` and `default_effort` (your everyday choice there, picked from the harness's live list; for Claude Code, whose help says it also takes a model's full name, setup accepts an id it does not list), and
  `assumed_headroom` for a subscription whose usage cannot be read. For a seat billed per token with no quota (an
  Enterprise seat), remaining budget is unknown. `--use <name>=normal` makes an account a candidate for everyday
  work; `=fallback` keeps it for when normal accounts cannot suitably take the task. This is independent of billing.
  Without `use`, legacy metered `after` means fallback and `with` means normal; other accounts are normal.
  `billing` names the kind when the harness cannot show it.
- `prefer`: your standing preference per kind of work, for example `"review": "strong"`.

Usage is read live for Claude Code (from its own `/usage`, with your hooks and MCP servers off for that read; it
costs no tokens), Codex, and Antigravity. routr does not need Claude's statusline; if you run `routr statusline` there
anyway, a snapshot under 5 minutes old is used instead of starting Claude. Cursor's and Kiro's are read in the background about once per working session, since they take seconds. A seat with no quota reports no windows: measured on a
ChatGPT Enterprise seat, which routr detects and calls `metered`; for Claude the class is your `billing` setting,
because Claude shows nothing to tell a seat with no quota from a plan routr has not seen. A metered seat gets
no headroom number and is a normal or fallback candidate by your setting. A cap the vendor enforces is read as one
more window (Codex: from its protocol, not yet observed on a seat).

## Evidence

[docs/evidence.md](docs/evidence.md) shows how the decisions and the scoring were measured. In short: the facts
routr reads from a brief are decisive and came out the same on 107 of 108 repeat readings; the level is right on 29 of
36 real worker tasks (and on 53 to 54 of 68 short labelled briefs, where it runs high); the judge questions separate good worker reports from flawed ones; workers on all four harnesses follow the
skill; and end-to-end runs with a real lead delivered verified work across subscriptions. routr does not estimate
or manage context; harnesses own that.

## Telemetry

Off unless you turn it on. `routr telemetry on` shares anonymous outcomes with routr's maintainers once a day (what
routr read from each brief, what was chosen, how it went; never your briefs or any text) to help tune its questions.
`routr share` shows exactly what would be sent. Everything else, including where it goes and how to have it deleted,
is in [docs/telemetry.md](docs/telemetry.md).

## Contributing

The most useful contribution is your outcomes: `routr telemetry on` is enough. Notes on what worked and what did
not are next: `routr feedback`.

Code and wording changes come by pull request. A change to a question's wording is a new question-set version and
needs its measurement; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
