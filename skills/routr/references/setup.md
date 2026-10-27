# Setting up routr

Walk the user through this. Ask before you write or install anything, and show what you are about to write.
Requirements: the `routr` command (one standalone binary; `routr --version` shows it). Pane workers also
need herdr with its agent skill (step 5), and reading Cursor's usage needs herdr installed (see step 4); without herdr, an
orchestrator can launch headless Claude Code, Codex, Cursor, Antigravity and Kiro workers, and the worker and subagent
parts work as they are. If `routr` is missing, install it first:

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
each decision-list entry answers, and whether a config exists. A harness that is installed but not signed in gets no work
(dispatch, launch) until the user signs in, and setup neither adds it, turns it on, nor asks it for models or effort
levels; one already on can still be turned off. Setup shows the command to run beside it (greyed when it cannot be
chosen), `setup --yes` notes each one it did not add ("<name> left out: …"), doctor names the command, and routr never
starts a sign-in itself. Lines marked `!!` need fixing, and it ends with a numbered list of what to
do next. `routr setup` does the writing (step 3). A person can run it alone in a terminal and answer its
questions; you run it with `--yes` and the choices you settled with the user. `routr doctor --fix` is the same
command. It is safe to run again: it fills in what is missing (a skill left behind by an older routr, a harness
installed since) and leaves the rest alone.

## 2. Decision models

The first answering model in an ordered list reads each brief and report. Ask for a first choice and optional backup, and say what each needs and how it did on
routr's tests (`docs/evidence.md`, "Decision models"):

- **TypeSafe's Jev** (the default): reads the level most accurately on routr's tests (83 of 104 right). Needs a
  TypeSafe API key. They create one at https://console.typesafe.ai/keys
  (TypeSafe's quick start shows the step: https://docs.typesafe.ai/introduction/quickstart).
- **Cloudflare's Clef on Workers AI** (`cloudflare`): for someone who already has a Cloudflare account, or whose
  organisation does. 72 of 104 levels right, more often too high than too low. Needs a Cloudflare API token with
  Workers AI Read, the only permission routr needs (https://dash.cloudflare.com/profile/api-tokens), and their account ID. What Workers
  AI's free allowance covers is in `docs/evidence.md`. `cloudflare:clef-flash`, a smaller model, reads levels too low more often.
- **Clef Flash on their own machine through Ollama** (`ollama`): free, and nothing leaves the machine. Ollama 0.40.1 or
  later, then the build `routr doctor` names: `clef-flash:9b-mxfp8` on Apple Silicon (12 GB, 5-7 s a brief on an M4
  Max), `clef-flash:9b-q8_0` elsewhere (11 GB; under a second on an NVIDIA laptop GPU). It needs a GPU or Apple
  Silicon: on a CPU alone a brief takes longer than routr waits. 70 to 72 of 104 levels right,
  more often too low. Never pull a model for them without asking: it is a download of more than 10 GB.

Set the ordered list: `routr setup --yes --decision typesafe,cloudflare:clef-flash`. A single choice works too.
The guided screen offers a first model and an optional backup. Ollama is tried after every hosted entry, whatever
its position in the list, because it may need to load. Each hosted attempt has an 8 s cut; the whole decision has
one deadline (10 s hosted-only, 30 s when local is included). A temporary failure or absent key moves to the next;
a refused key or unreadable reply stops and is reported. If none answers, advice uses `fallback_level`.
`ROUTR_DECISION_MODEL` replaces the list with one model for that call.

A key is stored by the user **themselves**, so it never passes through this conversation. Ask them to run, in their
own terminal (in Claude Code they can type `! routr key set <provider>`):

    routr key set typesafe        # or: routr key set cloudflare (it asks for the token, then the account ID)

It asks without showing a secret, saves it to `~/.config/routr/env` readable only by them, and makes one test call.
Every provider, including Ollama, gets a command that appends it only when it is outside the list. Storing a key
keeps the list as it is. Plain `routr key set` chooses the first listed provider that needs a key; a local-only list
says none is needed. Equivalent decision settings are kept as they are; duplicate choices are dropped with a warning.
Do not ask the user to paste a key to you, and never print or log it. Then run `routr doctor`: each decision model gets its own line saying whether it answers and why it does not.

If the user would rather manage it themselves, exporting `TYPESAFE_API_KEY` (or `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`) in their shell profile works too, and wins over the saved file. Do not put a key in a project
`.env`: routr does not read one, and it risks being committed.
Without a decision model routr still answers, but only with the fallback level.

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

It writes `~/.config/routr/config.json` for the harnesses found, and nothing of Claude Code's (step 4). A subscription with no `--model` gets no default, and the orchestrator picks from the
live list; one with no `--hardest` or `--reserve` gets the suggestion. An existing config is kept: setup adds
harnesses found since, fills a missing `hardest_work` or `reserve`, and applies any flag given, leaving everything
else alone. Every write keeps the old file as `config.json.bak`. `--force` rebuilds it from the suggestions, keeping
telemetry, updates and channel, the decision models, which subscriptions are off, and account use and billing. **To change a setting later**, run
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
    Code stops taking one, a pane worker's pane says so, and a headless worker's turn fails. Kiro's are
    suggested as `auto` and `auto`: Kiro's own router, with effort left to the model (no `--effort` is passed, so
    nothing is saved to the user's Kiro settings).
  - `assumed_headroom`: used only when nothing better is known. Claude, Codex, and Antigravity are read live; Cursor's
    shows only in its own `/usage` screen and Kiro's `/usage` takes about 10 s, so routr reads those two in the
    background about once per working session (the first time during setup, and at once after an update when the last
    try got no reading). The advice marks the rest `assumed`.
    Metered remaining budget stays unknown, even with legacy `metered_rank: "with"`. `routr usage` shows each reading.
  - `billing`: `included` or `metered`, only when the harness cannot show which it is. A Codex Enterprise seat on
    flexible pricing is detected (measured: no windows, unlimited credits). So is Claude signed in with an API key,
    from `claude auth status` (measured: `"authMethod": "api_key"`), and Claude through a cloud provider such as
    Bedrock or Vertex (from Claude Code's docs, not measured): both read as `metered`. So is a usage-based Claude
    Enterprise seat (measured: `"subscriptionType": "enterprise"` and a `/usage` with no windows), but only when its
    `/usage` answered with no windows; an Enterprise seat with a quota is ranked on its windows. Any other Claude seat
    that shows no usage windows (a plan routr has not seen) is left to you: the advice says "no usage windows", and `routr doctor` lists it as a next step. Set
    `"billing": "metered"` for such a Claude seat by hand; `"billing": "included"` says the seat has a quota and clears
    the same step. Your setting wins over what routr detected, while no windows arrive. Leave it out otherwise.
  - `use`: `normal` or `fallback`, independent of billing. Normal accounts are considered for suitable model/effort
    options before comparing headroom. Fallback is considered when none suitably takes the task. This preference
    does not infer or enforce a shared prepaid balance or personal allowance. Set it with `--use name=normal|fallback`.
  - `share`: a whole number from 1 to 99, the account's weight in the user's ratio of launches between normal metered
    accounts: `claude` 3 and `codex` 1 is about three workers on Claude for every one on Codex. It counts only while
    the account reads `metered` and at least two normal metered accounts take the work (one without `share` counts as
    1); headroom balances included accounts. routr counts its own launches over the last 7 days and the advice names
    the account below its target (`share_due`); the lead still chooses model and effort fit first. Set it with
    `--share name=<1-99>`, remove it with `--share name=off`.
  - `metered_rank`: legacy preference, applied only when `use` is absent. Metered `after` (default) means fallback;
    `with` means normal. Nonmetered accounts default to normal. The legacy `--metered` flag also sets `use`; explicit
    `--use` wins if both flags are given. Actual observed caps remain windows, including with a billing override.
- `prefer`: the user's standing preference per kind of work (`implement`, `debug`, `refactor`, `review`, `research`,
  `test_writing`, `docs`), for example `"research": "strong"`. Shown to agents as advice, never forced.
- `sure_at` (unset: the decision model's own measured bar; Jev's is 0.8), `risk_above` (0.75), `fallback_level`
  (`standard`): leave at the defaults unless asked. A `sure_at` set by hand applies to every decision model.
- `auto_update` (`true`): routr checks for a new release in the background at most once a day and uses it from the
  next run. Set it to `false` if the user wants to update only by hand with `routr update`. `routr doctor` reports a
  newer release only from that daily check (it asks GitHub nothing itself); with it off, `routr update --check` looks.
- `update_channel` (`stable`): which releases updates install, the daily one and `routr update` alike. `beta` also
  takes `-beta.N` and `-rc.N` builds, and moves to a stable release once it is the newest. Set it with
  `routr setup --yes --channel beta|stable`. Going back to stable never installs an older version by itself: the user
  stays on the pre-release until a stable release is newer, or runs `routr update --force` to take the newest stable now.

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
| get early builds (beta and release candidates), or stop | `routr setup --yes --channel beta` / `routr setup --yes --channel stable` |
| set the ordered decision models | `routr setup --yes --decision typesafe,cloudflare:clef-flash` (a single choice also works); then the user stores its key with `routr key set <provider>` in their own terminal. Ollama needs none, but its model must be pulled: setup's note says when it is not, and the pull is the user's to agree to |
| share anonymous outcomes, or stop | `routr telemetry on` / `routr telemetry off`: only when the user says so |
| export OpenTelemetry to their endpoint, or stop | `routr setup --yes --otel-endpoint <url>` / `routr setup --yes --otel-off`: only when the person asks; the person sets headers with `routr key set otel-headers` in their own terminal |

A flag that routr cannot apply fails with the reason and changes nothing: a model the harness does not list (Claude Code excepted), an effort
it does not take for that model, a harness that is not signed in (the error says what to run). A subscription turned
off keeps every setting and gets no work, in dispatch or launch, until it is on again.

OpenTelemetry export is separate from anonymous telemetry. Never turn it on unasked. If the person requests it,
use their endpoint with `--otel-endpoint`: HTTPS, or HTTP on loopback, without userinfo or query; path prefixes are
kept. Do not ask for or pass header values through your transcript: the person runs `routr key set otel-headers`,
with hidden input or a pipe, for comma-separated OTLP `name=value` headers. `doctor` and `setup --show` report its
status and whether headers are set, absent or invalid. `--otel-off` revokes queued batches through the detached
sender. `--yes` alone never turns it on. `DO_NOT_TRACK` and CI do not turn it off; `OTEL_SDK_DISABLED=true` or
`ROUTR_OTEL=0` do. After reinstall, a valid endpoint can remain on while its queue folders are missing: ordinary
`routr setup` repairs them without changing consent. Export sends traces, logs and a subscription headroom gauge, including
repository names, relative paths and ids; never briefs, reports or secrets. See
[OpenTelemetry](https://github.com/sirkirby/routr/blob/main/docs/opentelemetry.md).

## 4. Claude usage (only if Claude Code is a subscription)

Nothing to set up. routr reads Claude's usage from Claude's own `/usage` in each call (`claude -p /usage`: no tokens,
about 4 to 5 s, run in the system temp folder with the user's hooks and MCP servers off for that read and their other
settings kept). It never needs Claude's statusline, and setup does not touch `~/.claude/settings.json`.
`routr statusline` still works as a statusline command for a user who wants it (it prints the model and usage and
saves a snapshot); routr uses that snapshot instead of starting Claude while it is under 5 minutes old. Do not
suggest replacing a statusline the user already has. Codex and Antigravity are also read from the harness directly
and need nothing; Cursor's usage is read from its `/usage` screen in a private herdr session, in the background: herdr must be installed.
Kiro's is read from its own `/usage` command in the background and needs nothing either; routr deletes the empty Kiro
session each reading leaves. `routr skill install` links the skill into `~/.kiro/skills`, the only folder Kiro reads.

## 5. herdr (for pane workers)

For pane workers, routr's orchestrator part runs workers in [herdr](https://herdr.dev) panes and uses herdr's own
skill for pane and agent commands. Both belong to herdr and are installed from herdr, not bundled with routr. If
`routr doctor` shows either missing and the user wants pane workers, offer to install them; headless Claude Code,
Codex, Cursor, Antigravity and Kiro workers need neither:

    curl -fsSL https://herdr.dev/install.sh | sh                 # herdr itself (see herdr.dev for brew and Windows)
    npx skills add herdrdev/herdr --skill herdr -g               # herdr's agent skill (bunx works where there is no Node)

Sizing subagents (`routr subagent`) needs neither. routr needs no TypeSafe or Cloudflare skill either: it calls the
decision model's API itself, and the only thing the user supplies is the key (or, for Ollama, the pulled model).

## 6. PATH

The install script says when `~/.local/bin` is not on the user's PATH (and `routr doctor` says when a harness's own
command is installed but not on it). Offer to add it to their
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
