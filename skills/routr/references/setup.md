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

It changes nothing. It reports which harnesses are installed and signed in, which have a live usage source, whether
the TypeSafe key works, and whether a config exists. A harness that is installed but not signed in gets no work
(dispatch, launch) until the user signs in, and setup neither adds it, turns it on, nor asks it for models or effort
levels; one already on can still be turned off. Setup shows the command to run beside it (greyed when it cannot be
chosen), `setup --yes` notes each one it did not add ("<name> left out: …"), doctor names the command, and routr never
starts a sign-in itself. Lines marked `!!` need fixing, and it ends with a numbered list of what to
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

Use the setup flags. For each subscription, settle their everyday model there
(doctor prints each harness's live list; Claude Code's is its aliases, and its help says it also takes a model's full name), the hardest work they will send it (`basic`, `standard`, or `strong`; say
what each means, below), and the reserve: the share routr holds back from workers, so the orchestrator and anything they run outside routr
still have room (0% holds nothing back). Also settle account use: `normal` for everyday work, including funded
enterprise usage, or `fallback` when normal accounts cannot suitably take the work. Offer setup's work-level and
reserve suggestions. Existing choices stand until the user changes them. Then run:

    routr setup --yes --model claude=<id> --hardest cursor=standard --reserve claude=25% --use codex=normal ...

A person can instead run `routr setup` alone in a terminal: it is a guided screen. The first time it asks which
subscriptions routr may use, then each one's model (from the harness's live list, typed to filter; for Claude Code a full model name that is not
listed is offered "as typed", chosen by its number in accessible mode), effort, hardest
work, reserve, and account use, then lists the changes with Save and exit as the default (nothing is written before it). Run again,
it shows what is set and a menu to change one thing, turn a subscription on or off, or walk through everything, then
Save and exit or Exit without saving. Arrow keys choose, Esc goes back,
Ctrl+C stops without writing. `ACCESSIBLE=1` asks the same questions as numbered lines, for a screen reader. Suggest it
to a user who would rather click through than tell you each setting; you cannot drive it yourself, because it needs a
terminal.

It writes `~/.config/routr/config.json` for the harnesses found and sets the Claude statusline (step 4;
`--no-statusline` leaves it). A subscription with no `--model` gets no default, and the orchestrator picks from the
live list; one with no `--hardest` or `--reserve` gets the suggestion. An existing config is kept: setup adds
harnesses found since, fills a missing `hardest_work` or `reserve`, and applies any flag given, leaving everything
else alone; `--force` rewrites it (the old file is kept as `config.json.bak`). **To change a setting later**, run
setup with just that flag, for example `routr setup --yes --hardest cursor=strong`. A subscription that reads as
metered when first written (billed per token, no quota: a ChatGPT Enterprise seat) gets `metered_rank` written out,
`after` unless `--metered <name>=with` is passed. An explicit `use` takes precedence. Every value is
the user's preference, and none describes a model. `routr doctor` flags a setting that is missing or invalid, with
the command that fixes it.

- `subscriptions`: one entry per subscription the orchestrator may launch on, named `claude`, `codex`, `cursor`, `agy`, `kiro`.
  - `reserve`: the share of that subscription routr never hands to workers, so the orchestrator and anything the user
    runs outside routr still have room (0.25 holds back a quarter; 0 holds nothing back).
  - `hardest_work`: the hardest work routr may send to it. `basic`: rote or well-specified work; a small, fast model
    is enough. `standard`: the worker must find something out or choose an approach. `strong`: a wrong or shallow
    result would be expensive and hard to notice. For Cursor this means
    Cursor's own models; other vendors' models inside Cursor draw on a different pool and are not routed to.
  - `default_model` and `default_effort`: the user's everyday model on that harness, chosen from the live list doctor
    prints (routr keeps no model list of its own). Claude Code lists only its aliases, and its help says it also takes a
    model's full name, so for Claude an id off the list is kept as typed. The orchestrator starts from it and moves up or down with the
    work. Doctor warns when the harness no longer offers it. It cannot check a Claude id off the alias list: if Claude
    Code stops taking one, the worker's pane says so. Kiro's are
    suggested as `auto` and `auto`: Kiro's own router, with effort left to the model (no `--effort` is passed, so
    nothing is saved to the user's Kiro settings).
  - `assumed_headroom`: used only when nothing better is known. Claude, Codex, and Antigravity are read live; Cursor's
    shows only in its own `/usage` screen and Kiro's `/usage` takes about 10 s, so routr reads those two in the
    background about once per working session (the first time during setup). The advice marks the rest `assumed`.
    Metered remaining budget stays unknown, even with legacy `metered_rank: "with"`. `routr usage` shows each reading.
  - `billing`: `included` or `metered`, only when the harness cannot show which it is. A Codex Enterprise seat on
    flexible pricing is detected (measured: no windows, unlimited credits). Claude is never detected: a plan with no
    quota (usage-based Enterprise, an API key) sends the statusline no windows, and so may a plan routr has not seen
    yet, so the advice says "no usage windows" and leaves the class to you. `routr doctor` lists it as a next step
    when Claude has answered a prompt and still sent no windows. Set `"billing": "metered"` for such a Claude seat
    by hand; `"billing": "included"` says the seat has a quota and clears the same step. Leave it out otherwise.
  - `use`: `normal` or `fallback`, independent of billing. Normal accounts are considered for suitable model/effort
    options before comparing headroom. Fallback is considered when none suitably takes the task. This preference
    does not infer or enforce a shared prepaid balance or personal allowance. Set it with `--use name=normal|fallback`.
  - `metered_rank`: legacy preference, applied only when `use` is absent. Metered `after` (default) means fallback;
    `with` means normal. Nonmetered accounts default to normal. The legacy `--metered` flag also sets `use`; explicit
    `--use` wins if both flags are given. Actual observed caps remain windows, including with a billing override.
- `prefer`: the user's standing preference per kind of work (`implement`, `debug`, `refactor`, `review`, `research`,
  `test_writing`, `docs`), for example `"research": "strong"`. Shown to agents as advice, never forced.
- `sure_at` (0.8), `risk_above` (0.75), `fallback_level` (`standard`): leave at the defaults unless asked.
- `auto_update` (`true`): routr checks for a new release in the background at most once a day and uses it from the
  next run. Set it to `false` if the user wants to update only by hand with `routr update`.

## Changing a setting for the user

The user can ask you to change any setting ("switch Cursor to Grok 4.7", "stop using Antigravity", "hold back more of
Claude"). Do it with a flag; never edit the file by hand. First read what is set now:

    routr setup --show

It prints the settings as routr reads them, as JSON, asks no harness, and changes nothing. Then run `routr setup --yes`
with the flag for what they asked, and tell them what changed (the output lists it). Each flag is repeatable and
can be combined with the others in one run.

| The user wants to… | Run |
|---|---|
| change the everyday model on a subscription | `routr setup --yes --model cursor=<id>` (from the harness's live list: `routr doctor` prints it; for Claude Code the list is its aliases, and its help says a model's full name also works) |
| change the everyday effort | `routr setup --yes --effort codex=high` (one of the levels that harness takes for that model; Kiro's `auto` leaves it to the model) |
| change the hardest work a subscription may take | `routr setup --yes --hardest cursor=strong` (`basic`, `standard`, or `strong`) |
| change how much routr holds back | `routr setup --yes --reserve claude=25%` (a share: 0.25 or 25%; 0% holds nothing back) |
| stop using a subscription, keeping its settings | `routr setup --yes --disable agy` |
| use it again | `routr setup --yes --enable agy` |
| add a harness installed since | `routr setup --yes` (it adds every harness that is installed and signed in) |
| use a funded account for everyday work | `routr setup --yes --use codex=normal` |
| keep an account for fallback | `routr setup --yes --use codex=fallback` |
| share anonymous outcomes, or stop | `routr telemetry on` / `routr telemetry off`: only when the user says so |
| let Claude Code's usage be read | `routr setup --yes` sets the statusline when there is none (`--no-statusline` leaves it) |

A flag that routr cannot apply fails with the reason and changes nothing: a model the harness does not list (Claude Code excepted), an effort
it does not take for that model, a harness that is not signed in (the error says what to run). A subscription turned
off keeps every setting and gets no work, in dispatch or launch, until it is on again.

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
Kiro's is read from its own `/usage` command in the background and needs nothing either; routr deletes the empty Kiro
session each reading leaves. `routr skill install` links the skill into `~/.kiro/skills`, the only folder Kiro reads.

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
