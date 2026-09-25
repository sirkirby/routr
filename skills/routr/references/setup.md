# Setting up routr

Walk the user through this. Ask before you write or install anything, and show what you are about to write.
Requirements: the `routr` command (one standalone binary; `routr --version` shows it) and, for orchestration, herdr
with its agent skill (step 5). The worker and subagent parts work without herdr. If `routr` is missing, install it first:

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/sirkirby/routr/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/sirkirby/routr/main/install.ps1 | iex
```

## 1. Check

    routr doctor

It changes nothing. It reports which harnesses are installed, which have a live usage source, whether the TypeSafe
key works, and whether a config exists. Lines marked `!!` need fixing, and it ends with a numbered list of what to
do next. `routr setup` does the writing (steps 3 and 4). A person can run it alone in a terminal and answer its
questions; you run it with `--yes` and the choices you settled with the user. `routr doctor --fix` is the same
command. It is safe to run again: it fills in what is missing (a skill left behind by an older routr, a harness
installed since) and leaves the rest alone.

## 2. TypeSafe key

routr needs one secret: an API key for TypeSafe, whose small decision model reads each brief. A call costs a small
fraction of a cent. Walk the user through it:

1. They sign in (or create an account) at https://console.typesafe.ai/keys and create an API key. TypeSafe's quick
   start shows the same step: https://docs.typesafe.ai/introduction/quickstart
2. They store it **themselves**, so the key never passes through this conversation. Ask them to run, in their own
   terminal (in Claude Code they can type `! routr key set`):

       routr key set

   It asks for the key without showing it, saves it to `~/.config/routr/env` readable only by them, and makes one
   test call. Do not ask the user to paste the key to you, and never print or log it.
3. Run `routr doctor`: the TypeSafe line should read "works".

If the user would rather manage it themselves, exporting `TYPESAFE_API_KEY` in their shell profile works too. Do not
put the key in a project `.env`: workers run in worktrees and other folders where that file does not exist, and it
risks being committed. Without a key routr still answers, but only with the fallback level.

## 3. Config

Do not write the file by hand. For each subscription, settle three things with the user: their everyday model there
(doctor prints each harness's live list), the hardest work they will send it (`basic`, `standard`, or `strong`; say
what each means, below), and the share they keep for their own work. Offer the suggestion setup prints for the last
two; the user can take it. Then run:

    routr setup --yes --model claude=<id> --hardest cursor=standard --reserve claude=25% [--metered codex=after|with] ...

At a terminal, `routr setup` asks the person the same questions itself, with the suggestion as the default.

It writes `~/.config/routr/config.json` for the harnesses found and sets the Claude statusline (step 4;
`--no-statusline` leaves it). A subscription with no `--model` gets no default, and the orchestrator picks from the
live list; one with no `--hardest` or `--reserve` gets the suggestion. An existing config is kept: setup adds
harnesses found since, fills a missing `hardest_work` or `reserve`, and applies any flag given, leaving everything
else alone; `--force` rewrites it (the old file is kept as `config.json.bak`). **To change a setting later**, run
setup with just that flag, for example `routr setup --yes --hardest cursor=strong`. A subscription that reads as
metered when first written (billed per token, no quota: a ChatGPT Enterprise seat) gets `metered_rank` written out,
`after` unless `--metered <name>=with` is passed or the person answers the question at the terminal. Every value is
the user's preference, and none describes a model. `routr doctor` flags a setting that is missing or invalid, with
the command that fixes it.

- `subscriptions`: one entry per subscription the orchestrator may launch on, named `claude`, `codex`, `cursor`, `agy`.
  - `reserve`: the share of that subscription routr must never offer (0.25 keeps a quarter for the user's own work).
  - `hardest_work`: the hardest work the user would hand it. `basic`: rote or well-specified work, a small fast model
    is enough. `standard`: the worker must find something out or choose an approach. `strong`: a wrong or shallow
    result would be expensive and hard to notice. For Cursor this means
    Cursor's own models; other vendors' models inside Cursor draw on a different pool and are not routed to.
  - `default_model` and `default_effort`: the user's everyday model on that harness, chosen from the live list doctor
    prints (routr keeps no model list of its own). The orchestrator starts from it and moves up or down with the
    work. Doctor warns when the harness no longer offers it; that is the only time it needs attention.
  - `assumed_headroom`: used only when nothing better is known. Claude, Codex, and Antigravity are read live; Cursor's
    shows only in its own `/usage` screen, which routr reads in the background about once per working session (the
    first time during setup). The advice marks the rest `assumed`. `routr usage` shows what routr sees of each one.
  - `billing`: `included` or `metered`, only when the harness cannot show which it is. A Codex Enterprise seat on
    flexible pricing is detected (measured: no windows, unlimited credits). Claude is never detected: a plan with no
    quota (usage-based Enterprise, an API key) sends the statusline no windows, and so may a plan routr has not seen
    yet, so the advice says "no usage windows" and leaves the class to you. `routr doctor` lists it as a next step
    when Claude has answered a prompt and still sent no windows. Set `"billing": "metered"` for such a Claude seat
    by hand; `"billing": "included"` says the seat has a quota and clears the same step. Leave it out otherwise.
  - `metered_rank`: where a metered seat (billed per token, no quota) goes in the ranking. `after` (default): after
    every subscription that still has room, so it takes the overflow, because included usage expires and billed
    usage does not. `with`: ranked with the rest by its `assumed_headroom`. A cap the vendor enforces is read as a
    window and needs neither.
- `prefer`: the user's standing preference per kind of work (`implement`, `debug`, `refactor`, `review`, `research`,
  `test_writing`, `docs`), for example `"research": "strong"`. Shown to agents as advice, never forced.
- `sure_at` (0.8), `risk_above` (0.75), `fallback_level` (`standard`): leave at the defaults unless asked.
- `auto_update` (`true`): routr checks for a new release in the background at most once a day and uses it from the
  next run. Set it to `false` if the user wants to update only by hand with `routr update`.

## 4. Claude usage (only if Claude Code is a subscription)

Claude Code reports usage only to its statusline. `routr statusline` is a statusline command: it prints the model and
usage there and saves each snapshot to `~/.cache/routr/claude-usage.json`, which routr reads. If the user agrees,
`routr setup` sets it when Claude Code has no statusline yet (the old settings are kept as
`settings.json.bak-before-routr`); it never replaces a statusline the user already has. By hand, it is

    "statusLine": { "type": "command", "command": "<full path to routr> statusline" }

in `~/.claude/settings.json`. Use the full path (`~/.local/bin/routr`, written out), because Claude's PATH may not
include it. If the user already has a statusline, keep theirs and have it call `routr statusline` for the snapshot,
or ask them which they prefer. The first snapshot appears after the next Claude Code turn. Codex and Antigravity are
read from the harness directly and need nothing; Cursor's usage is read from its `/usage` screen in a private herdr session, in the background: herdr must be installed.

## 5. herdr (only for orchestration)

routr's orchestrator part runs workers in [herdr](https://herdr.dev) panes and uses herdr's own skill for pane and
agent commands. Both belong to herdr and are installed from herdr, not bundled with routr. If `routr doctor` shows
either missing and the user wants orchestration, offer to install them:

    curl -fsSL https://herdr.dev/install.sh | sh                 # herdr itself (see herdr.dev for brew and Windows)
    npx skills add herdrdev/herdr --skill herdr -g               # herdr's agent skill (bunx works where there is no Node)

Sizing subagents (`routr subagent`) needs neither. routr needs no TypeSafe skill either: it calls TypeSafe's API
itself, and the only thing the user supplies is the key.

## 6. PATH

`routr doctor` and the install script both say when `~/.local/bin` is not on the user's PATH. Offer to add it to their
shell profile (or the user PATH on Windows), so that agents and herdr panes can run `routr` by name.

## 7. Telemetry

Telemetry is off unless the user turns it on, and `routr setup --yes` never turns it on. Ask them once, in one or two
lines: routr can share anonymous outcomes with its maintainers once a day (what it read from each brief, what was
chosen, how it went; never a brief or any text) to help tune its questions; `routr share` shows exactly what would be
sent, and https://github.com/sirkirby/routr/blob/main/docs/telemetry.md has the details. Only if they say yes, run
`routr telemetry on`. Do not ask again.

## 8. Confirm

Run doctor again, then one real call, and show the user the result:

    routr dispatch "Rename getUsr to getUser in src/api/users.ts and update its call sites"
