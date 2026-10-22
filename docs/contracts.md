# Output contracts

What each routr command an orchestrator reads takes, and what it prints. This page specifies the command output.
The field maps document the migration from the previous output, and the reader inventory records the baseline
that the implementation changed together. In those migration notes, "today" means the output before this change.

Commands covered: `subagent`, `dispatch`, `check`, `launch` (dry run, in herdr, and headless), `record`, `cleanup` (each mode),
`wait`, `send`, `workers`, `stop`, and
`usage` (no name, `--level`, and each named reader: `claude`, `codex`, `agy`, `cursor`, `kiro`). Setup, doctor and key output for decision models is covered below; other maintenance commands are not covered.

## What every answer says

Each command fits its job (a reading, a worker, a verdict on a report, a ledger row, a removal), and each answers the
same five things in the same fields, first in the object:

| field | type | always | meaning |
|---|---|---|---|
| `ok` | boolean | yes | Whether the command produced what it is for, so the next step can go ahead as designed. Defined per command below. It never means routr accepts work, and never means nothing was missing: `unavailable` says that. |
| `headline` | string | yes | What happened, in one plain line starting `routr: `. The line to read first and to show the user. Never the brief, never a pane's screen. |
| `unavailable` | list | yes | What routr could not read, and why (`[]` when nothing was missing). Each entry has `part`, a fixed `code`, and `why`, a fixed sentence with the recovery action; parts add their own identifying fields (below). Text from outside routr never supplies a `why`. |
| `warnings` | list of strings | yes | What the lead should know about this call: an input routr ignored or read differently, a setting it could not use, a check it skipped, something it left behind. Stated as facts; what to do about one is a `next` step. Never a repeat of an `unavailable` entry or of `headline`. |
| `next` | list | yes | What comes next: `{ kind: "run", why, argv, command, stdout_to? }` or `{ kind: "do", why, template? }`, as today. Every step routr asks the lead to take in this run, because of this answer, is a `next` entry. Other fields explain; where they name a remedy, it is what fixes the entry they sit in, not a request to act now (see "Explanation or instruction", below). |
| `error` | string | only on an error | Present exactly when the command stopped on an error: it refused its input (a required input missing or unusable), or something failed that the command does not report as one of its outcomes. `ok` is then false. An `ok: false` without `error` is an outcome routr reached on purpose (a worker that needs input, a refused removal, a report it could not read), described by `headline` and the command's own fields. |

Acting commands (`launch`, `cleanup`) also return `state`, one word for the outcome, from a fixed list per command.

Names that mean one thing everywhere:

- `why`: the reason for the entry it sits in (a `next` step, an `unavailable` entry, an excluded subscription, a
  worktree cleanup cannot remove, a launch that needs input). Never a field of its own at the top level.
- `note`: an explanation that travels with a number or a setting, for the lead to weigh: why a usage number is
  assumed, what a harness showed beside it, how the ranking treats the user's settings, what routr knows about a
  harness's startup question. A note is not a warning: nothing is wrong with the call.
- `notes`: in `subagent` and `dispatch` only, the advice's own reasoning (the user's preferences, a risk warning, how a
  torn level was settled, a brief to fix). Part of the advice, not about the call.
- `screen`: what a pane showed when routr stopped, or the fixed sentence saying it is withheld because the task was
  sent. The only place a pane's text reaches output.
- `subscription`: a subscription's name, wherever one is named (`unavailable` entries, ranked and excluded rows, a
  named usage reading).
- `ran` and `would_run`: display lines of the herdr and git commands a command ran, or in a dry run would run. Display
  only (prompt text replaced by its length); never something to execute. Runnable lines are only ever in `next`.

`unavailable` parts and their extra fields:

| `part` | extra fields | from |
|---|---|---|
| `decision model` | `provider`, `model` (attempted), `status` (a provider error's HTTP status) | `subagent`, `dispatch`, `check`; `launch` copies the saved advice's entries |
| `usage` | `subscription` (null for routr's own ranking failure), `source`, `reading` (`assumed` or `kept`), `reading_source` and `age_sec` for a kept reading | `dispatch`, `usage` |
| `brief`, `report` | none | `check` |
| `model list` | `subscription` | `launch` (a harness whose model list routr checks could not be read) |
| `pane`, `worktree` | `pane` or `path` | `cleanup` (what runs in a pane, or a worktree's git state, could not be read) |

Codes are the fixed lists routr already has (the decision-model failure codes, the usage failure codes) plus
`unreadable` for a file, a model list, a pane or a worktree.

## Ordered decision models

`decision` in settings is an ordered list of `{ provider, model }`. A single object in an existing user file reads
as a list of one. Each entry must name a known provider and a measured model that runs on this machine (`model:
null` uses that provider's default). Bad entries and duplicate resolved provider/model pairs are dropped, keeping the first occurrence.
Each warning names the dropped entry, the reason and a concrete setup command preserving the surviving entries
(or the default when none survives). A non-object entry says it must be an object and shows the required shape. An empty or all-bad list uses the default, TypeSafe's Jev. `ROUTR_DECISION_MODEL`
replaces the whole list with one model for that call, retaining the model gate's unmeasured-model override.

`dispatch`, `subagent` and `check` share the same traversal. Hosted entries retain their order; local Ollama entries
come after every hosted entry, whatever their position in settings, because a local model may need to load. One
overall deadline bounds the decision: 10 seconds for hosted-only lists, 30 seconds when a local model is included.
Each hosted attempt, including retries, gets at most 8 seconds of the remaining deadline. Entries with no time left
are reported as `timeout` without a request. The first answer supplies the reading and its own measured profile
(`sure_at` and torn record); the list never combines readings.

Failures that move on: `timeout`, `unreachable`, `provider_error`, `no_key`, `model_unsupported`, and the existing
`daily_allowance` and `model_missing` cases. `key_refused` and `invalid_response` stop: the person must fix a refused
key, and an unreadable reply is not a reason to ask someone else. `secrets_unreadable` and `internal_error` also stop.
When none answers, advice uses `fallback_level` as before; check asks the lead to judge the report.

Each failed entry produces one `decision model` entry in `unavailable`, in attempted order, naming its provider,
model, code, fixed recovery sentence and, for `provider_error`, HTTP status. Provider text never supplies a sentence.
A later successful reading has these earlier failures beside it. Its headline names the answering model and provider
(`reading by <model> on <provider label>`); it is ordinary advice, with `decision_model` and `provider` naming that
answer. Launch copies all saved decision failures, rebuilding their sentences. Launch and record use one fallback
check: an explicit older `fallback: true`, or decision failures without an answering `decision_model` (or older
`jev_model`). Thus a backup reading records its answering identity and `advised.fallback: false` in the ledger.
When no model answers, `provider` and the headline both identify the last failed entry; the full ordered failure
list remains in `unavailable`. No unavailable diagnostics enter the ledger or telemetry; their schemas do not change.
Dispatch asks the lead to tell the user when a backup answered and why the first choice could not answer. Its
request to judge missing readings applies only to true fallback or unavailable usage, not to a backup reading.

### Setup, doctor and key output

- `setup --decision <provider>[:<model>],...` accepts an ordered comma-separated list, for example
  `typesafe,cloudflare:clef-flash`. The guided screen chooses a first model and an optional backup, and explains
  that local models run last. The command writes a list, reports the change in `did`, preserves a backup of an
  existing settings file and says which keys or local models still need attention in `skipped`. Duplicate flag
  entries are dropped with their warnings in `skipped`. An equivalent list (including an older single-object
  setting or an omitted default) changes nothing and creates no backup when all entries are valid. A file with
  dropped entries is repaired even when the effective list is unchanged; setup says it repaired the file and names
  the effective list it kept. Comparisons use the shared settings check, so ignored entries never become the old
  model in a change message. A first run reports the file it wrote; only a real change to an existing effective
  list is described as a changed decision list.
- `doctor` tests every entry independently in effective order, even after a ready entry or a refused key. Text has
  one decision-model line per entry. JSON has `decision`, a list replacing the former single `key` object: each
  entry carries `provider`, `label`, `asked`, `measured`, `local`, `where`, optional `unversioned`, `found`, `works`;
  on success `model`, `ms`, `note`; on failure `code`, `error` (fixed wording). `next_steps` includes each repair.
- `key set <provider>` keeps the existing owner-only key storage and test output (`ok`, `provider`, `file`, `works`,
  `model`, `ms`, `error` as applicable). For a provider outside the configured list, `note` names that fact and the
  `routr setup --decision ...` command that appends it while retaining existing choices. It changes no settings.
  This rule applies to every provider, including Ollama; a provider already listed gets no setup command.
  With no provider it uses the first configured entry that needs a key, skipping local models. A local-only list
  reports that it needs no key. Its test asks only the named provider, independent of overrides.

## Text from outside routr

AGENTS.md lets outside text reach output only where a command's contract names it. This contract names one place for
free text: `screen`, what a pane showed, and only before the task was sent (after that it may show the brief, and
`screen` is the fixed withheld sentence, as today). Everything else a herdr or git call returns is classified where
routr starts the process: what leaves that point is routr's own words, and the structured herdr values below, each
checked against a fixed shape.

Structured herdr values. Launch reports herdr's reading of an agent (`needs_input.herdr`) and builds `needs_input.why`
from it; today it copies herdr's values as they come and interpolates them. Each is checked at the boundary, before any
`why`, `headline`, step `detail` or `herdr` field is built, and a value outside its shape is never printed:

| value | from herdr | accepted shape | outside the shape |
|---|---|---|---|
| agent state (`herdr.state`, `herdr.explained`, and the state named in `why`) | `agent get`'s status, `agent explain`'s state, a prompt's outcome | one of the lifecycle states routr handles: `idle`, `working`, `blocked`, `done` | `unknown`, said as "a state routr does not know"; treated as not ready, as an unreported state is today |
| matched rule (`herdr.rule`) | `agent explain`'s matched rule id | lowercase letters, digits and `_`, starting with a letter, at most 64 characters (`trust_directory`, `live_blocked_form`, `osc_title_idle`) | left out, as when herdr matched none |
| rules version (`herdr.rules`) | `agent explain`'s manifest version | a dotted date and serial, `YYYY.MM.DD.N` (`2026.10.01.1`) | left out |
| agent kind (in `why`: "the pane runs …") | `agent get`'s agent | one of routr's harness kinds | "another agent" |
| agent folder (in `why`: "works in …") | `agent get`'s working folder | an absolute path of at most 512 characters with no control characters | "a folder herdr does not report", as today when none is given |
| readiness | `agent get`'s interactive-ready flag | `true`, `false` or absent | absent |

Pane, workspace and worktree ids and the worktree path herdr creates are routr's values once checked (launch already
checks they are strings; cleanup checks the pane list's shape), and are printed as identifiers.

Before these contracts, two commands broke this; a review proved it by planting a marker in each. Cleanup printed
git’s first line of stderr ("git did not remove <path>: <git's own reason>", and the same for a branch git kept), and launch printed herdr’s
error message (and, for a failed start, herdr's whole JSON answer) in a step's `detail`, which this map would also have
put in `error` and `headline`. Cleanup also named the processes herdr says run in a pane.

The rule, as #82 made it for the decision-model providers:

- The process boundary (the one place routr starts herdr and git) returns a result or a classified failure: a fixed
  `code` and a fixed `why`, naming the call by routr's own words for it (`herdr worktree create`, `git worktree
  remove`), never by the process's message. Codes: `herdr_unreachable` (herdr not found, no answer, timed out),
  `herdr_refused` (herdr answered with an error), `herdr_invalid_response` (an answer without what routr asked for),
  `git_unreachable`, `git_refused` (a nonzero exit), `git_invalid_response`. herdr's own error code may choose among
  routr's codes (as launch already treats `agent_not_running` and `timeout` apart) but is never printed.
- A missing herdr executable retains `herdr_unreachable`, says herdr is not installed or not on PATH, and adds
  an installation/PATH step in `next`. Other unreachable calls say they did not answer.
- `headline`, `warnings`, `steps[].detail`, `error`, `unavailable[].why` and `why` anywhere are built from those
  codes and from values routr already holds (its arguments, pane and workspace ids, paths it was given or created).
- What herdr says runs in a pane is counted, not named: "w1:p3 is running 2 commands besides its shell", with a `next`
  step to read the pane, which shows them to the lead without routr printing them.
- The post-submission redaction stays: once a task may have been sent, no pane read is printed.

## Explanation or instruction

A field other than `next` may explain: what is true (of the brief, a number, a setting, the ranking), why, and what
would change it. When it names a remedy, it is the fix for the entry it sits in, phrased as what fixes it ("turned off
in your settings: routr setup --enable cursor", "the local server is not running: start it"), so the lead knows the
cause without being asked to act; the lead does not turn a subscription on or change a setting unasked. An
instruction, something the lead should do now in this run because of this answer (choose, start at, go higher, hold
the work, ask or tell the user, fix the brief, read by hand, review, inspect), is a `next` step, added only in the
situation that calls for it. This keeps one place to follow and lets a note be read without being obeyed.

What moves (the `subscriptions.note` and reading rows apply wherever the ranking appears: `dispatch`, and `usage`
plain, with `--level`, or named):

| today | stays as explanation | becomes a `next` step |
|---|---|---|
| advice note "Fix the brief first: …" | (the fact is in `facts` and the headline) | "Fix the brief: …, then dispatch it again", when a brief fact reads `no` and the work goes to a worker |
| advice note on a torn or unsure level | "routr is between standard and strong (…); strong is the more likely: on 36 real tasks …" | "Start at strong; go higher if a fact calls for it" |
| advice note "routr could not tell from the brief: …. You can: you know the codebase." | "routr could not tell from the brief: …" | "Settle these from the codebase: …" |
| advice note on a user preference | "The user prefers strong for debugging work; routr reads this piece as standard." | "Go with strong unless the work is plainly rote" |
| advice note on high risk | "A mistake here could be costly (85% likely high risk)." | "Do not go below standard, and review the result" |
| `subscriptions.note`, normal | "codex has the most usable headroom among accounts with a number. Metered budget is unknown." | "Choose a suitable model and effort from normal candidates first; use fallback when none suitably takes the work" (part of dispatch's choose step) |
| `subscriptions.note`, everything at its reserve | "every subscription that takes strong work is at its reserve" | "Hold the work or ask the user: every subscription that takes strong work is at its reserve", first in `next`, in place of the launch step |
| `subscriptions.note`, nothing takes the level | "no eligible subscriptions for strong work", followed by each exclusion’s reason | "Hold the work, or choose a lower level and refresh with routr usage --level, or ask the user" when the level excluded an account; otherwise use an eligible subscription or ask the user. Never offer a level below basic |
| `subscriptions.note`, nothing configured | "no subscriptions are configured: routr setup has not been run" | "Tell the user routr is not set up (routr setup), and ask which subscription to use meanwhile" |
| a ranked row's note "… By hand: run `cursor-agent`, …" | "the last try failed: …; using the assumed headroom" | "Read Cursor's usage by hand: …, and pass --headroom cursor=<share left>", with that row's `usage` entry |
| a Claude row's note "… set `billing: \"metered\"` for claude in the config" | reworded as the remedy: "a seat with no quota is set with `billing: \"metered\"`" | (none: the user's setting) |
| `unavailable` `internal_error` why "… Read capacity yourself before choosing an account." | "An internal error stopped routr from ranking usage." | "Read capacity yourself before choosing an account" |
| decision-model `why` ("Try again; if it keeps timing out, check the decision provider") | kept: the recovery action that makes the read work again, as #85 set | (the lead's step is the fallback's "judge the level yourself") |
| launch warnings "Pane w1:p2 was left alive; inspect it …", "Prompt may have been submitted; inspect the pane …", "Cursor config … is retained …; remove it if …", "Could not rename …: address it by its pane" | the fact, alone | "Inspect pane w1:p2 before closing it or retrying", "Remove the private Cursor config if the launch command did not run", "Address this worker by its pane, w1:p2" |
| launch's harness notes ("… check the model's /effort panel") and "Plan only: choose --model before launching." | "Kiro remembers --effort as the user's default for this model" | "Check the model's /effort panel in the pane"; "Choose --model before launching" |
| record warning "… Omit --task-file only for an inline task, or to revise …; say so in --note." | "The advice was not checked against a task." | "If this task came from a file, revise this row with --run-id and --task-file; otherwise say why in --note" |
| `needs_input.note` (how a harness stops asking at startup) | kept: it says what makes the harness stop asking | (the step is `next`'s answer-then-continue) |

`worker.suggestion` and `level` are the reading's answers, not instructions: `next` turns them into steps.

## Settled questions

**`notes`, `config_notes` and `input_notes` against `warnings`.** `notes` stays: it is the advice's own reasoning,
written for the lead to weigh, and it is the same for the same brief and settings. Its instructions move to `next`
("Explanation or instruction", above). `config_notes` (a setting routr
could not use, a missing config) and `input_notes` (a `--headroom` it ignored, a flag-like word it set aside or kept
in the brief) move into `warnings`: both are about this call, not the work, and they are what `warnings` is for in
every other command. Every command that reads the config now reports its config warnings, not only `subagent` and
`dispatch` (today `usage` and `check` drop them), and `check` gets the input warnings it can produce.

**`rule`.** Removed. Its sentences become `next` steps. `next` is the field the lead is told to follow on every
command; a second field of standing instructions competes with it, and as a fixed paragraph repeated on every call it
reads as boilerplate. The incident it guards against (seen 2026-10-14: an orchestrator read `worth a worker` as leave
to spawn its own subagents) is answered as well by a `next` step in the same answer, so the text stays in the output.
`subagent`'s steps: choose the subagent's model and effort yourself, never stronger than yourself and not your own by
default, and report `ROUTR: <advised> → <chosen> because <reason>` when the level differs; an orchestrator in herdr
never runs `subagent` or spawns its own subagents. `dispatch`'s steps: settle the level (refresh with
`routr usage --level <chosen>` if it changed, keeping this advice); choose model, effort and an eligible account,
quality first; launch with this saved advice on the exact task (a template), telling the user what was unavailable
when `unavailable` is not empty; record from launch's template.

**Launch's `command` and `argv`.** Both are renamed, because `command` and `argv` inside `next` mean a runnable line
and its exact words, and a field meaning the same thing has one name. Launch's `command` (the herdr commands it ran,
prompt shown as its length) becomes `ran`; its dry-run `planned_command` becomes `would_run`; `cleanup`'s `command`
becomes `ran` too. The prompt's length stays in the display line (`<prompt: N chars>`) and in `prompt_chars`. Launch's
top-level `argv` and `env` (the harness command started in the pane, and its environment) move into
`start: { executable, argv, env }`, which says what they are; `executable` is added so the line reads whole.

**Record's `recorded`.** Renamed `id`. It holds the advice's id, which the advice and the ledger row both call `id`
(beside the row's `run_id`), so the answer names it as the row it wrote does. `recorded: null` on a failure is removed:
`ok: false` with `error` already says nothing was recorded.

**Cleanup's `refused` and each worktree's `why`.** `refused` (an object holding only `why`) is removed: `state:
"refused"` says it was refused, and the reason is the `headline` (`routr: kept <path>: 3 uncommitted changes …`). What
to do is in `next`, as today. Each listed worktree's `why` stays: it is the reason for the entry it sits in, which is
what `why` means everywhere. When a refusal comes from something cleanup could not read (what runs in a pane, a
worktree's commit, status or file flags), that read is also an `unavailable` entry; a refusal from what it did read
(a working agent, uncommitted changes) is not.

**Usage's `note`.** Kept, and not a warning. `subscriptions.note` explains the ranking and the user's account policy
(who has the most room, normal before fallback, metered budget unknown, everything at its reserve, nothing
configured); each ranked row's `note` explains its number (what the harness showed beside it, why it is assumed).
Nothing is wrong with the call when they appear, and the lead reads them to choose. Plain `usage`'s top-level `note`
moves to `subscriptions.note`, the same place as in `dispatch`.

**The named readers' `read_yourself`.** Moved into `next`, as a `do` step whose template is the `--headroom` flag to
pass (`--headroom cursor=<share left>`), and whose `why` says how to read the harness's screen by hand. It is an
instruction, and instructions are `next` entries. (Today it never reaches the output: the fresh-reading path rebuilds a
failed reading from its code alone and drops it, so the troubleshooting page's promise is unmet.) The failure itself
(`code`, `why`, at the top level today) becomes a `usage` entry in `unavailable`.

**Kiro's cleanup note.** Moved into `warnings`. "Kiro kept an empty usage session" is something routr left behind and
could not remove, which the lead should know about and may act on; it explains no number, so it is not a `note`.
(Today it reaches the output only when the reading succeeded.)

**`fallback` beside `unavailable`.** Removed from `subagent`, `dispatch` and `check`. In the advice commands it is
exactly "`unavailable` holds a `decision model` entry"; in `check` it is set when a file could not be read and no
model was asked, so one name has two meanings. Two fields for one fact can disagree, and `candidates.fallback` (an
account use) shares the word. The ledger's `advised.fallback` does not change: `record` fills it from the advice's
`decision model` entry (and from `fallback: true` in advice saved by an older routr, which it reads as it already
reads `jev_model`). `launch` decides it was given fallback advice the same way.

Further decisions this map makes, each for the reason given:

- Excluded subscriptions' `reason` becomes `why`: the reason for that entry, named as everywhere else.
- Launch's `needs_input.screen` and its failure-time `pane_text` become one top-level `screen`: both are what the pane
  showed when launch stopped. `needs_input.pane` is removed (the top-level `pane` is the same pane). `needs_input` is
  present only when `state` is `needs_input`, as the other optional fields are present only when they apply.
- Plain `usage` returns `subscriptions`, the same object `dispatch` returns, so a lead reads both the same way. Ranked
  rows carry `hardest_work` in both (today only `usage` has it), so a row has one shape. `level` is always present
  (`basic` when none was given). The fixed `how` sentence is removed: it is the same on every call, and the ranking page
  says it.
- Launch's "Fallback advice: …" warning is removed: it repeats the `decision model` entry `launch` already puts in
  `unavailable`. The advice commands' "Router unavailable (…)" note is removed from `notes` for the same reason; "judge
  the level yourself" becomes a `next` step.
- `check` refuses (with `error`) when `--brief` or `--report` is not given, as a required input; a given file it cannot
  read stays an `unavailable` entry. `subagent` and `dispatch` refuse an empty brief as JSON and exit 0, like their
  other refusals (today: a line on stderr and exit 2).
- `record` refuses without `--subscription`, `--model`, `--effort`, `--verdict` or `--check`, which its help already
  marks required; today a row is written with nulls and `unknown`. Launch's record template therefore always carries
  `--effort`: the effort it launched with; `default` when it passed none (a default-effort launch, or Cursor and
  Antigravity, whose model id carries the effort: record already resolves `default` to the configured default effort
  or the id's effort word); or the `<effort>` placeholder wherever the model is a placeholder (an adopted agent, a
  dry run naming `--pane`, no model). Today the template leaves `--effort` out when none was given, and following it
  would be refused.
- `record` and `launch` accept only usable advice ("Usable advice", under record): a saved refusal is not advice.
- A launch dry run whose real launch would be refused (no advice, or advice on another text) returns `ok: false` with
  that refusal in `error`, and still plans (`would_run`). Today it returns `ok: true` with the refusal in `warnings`,
  which tells a lead the launch is good to go.
- A harness model list that launch could not read (today a warning) is an `unavailable` entry: a read routr could not
  make.
- Usage's ranking failing outright reports a fixed `internal_error` entry in `unavailable`, as `dispatch` does; today
  it prints the exception's text as `error`.
- Launch's `--trust` is accepted and ignored with a warning, kept for older launch lines. The guides and binary ship
  together, so this map drops it: it becomes an unknown option.

## subagent and dispatch

A reading of a brief. `subagent` sizes a subagent a worker (or an agent outside herdr) is about to spawn; `dispatch`
does the same for a pane worker and adds the subscriptions ranked by usage. The saved `dispatch` answer is the advice
file `launch --advice` and `record --advice` take.

Inputs:

- Required: a nonempty brief, exactly one of an inline brief, stdin, or `--task-file <path>`. Refused (with `error`)
  when missing, empty, unreadable, or a flag-led word without a stdin brief.
- Used when given: `--config <path>`; `--headroom <subscription>=<share>` (repeatable; `dispatch` only, it outranks a
  reading).

`ok`:

| case | `ok` |
|---|---|
| a reading made | true |
| no decision model answers: the advice is the user's fallback level | true. The answer is still advice the lead acts on and launch accepts. `unavailable` holds each failed `decision model` entry, `headline` starts `routr: no reading`, and `next` says to judge the level yourself. |
| some usage readings failed (`dispatch`) | true; each is a `usage` entry in `unavailable`, and its ranked row says `assumed` or `kept` |
| the brief refused | false, with `error`; no reading fields |

`headline`: today's (the worker suggestion, level, kind of work, facts that bear on difficulty, `HIGH RISK`, `FIX THE
BRIEF FIRST`, followed by the answering model and provider; or `no reading` and the fallback level). On a refusal: `routr: no advice: <error>`.

Shared fields: all six. `warnings` holds config and input warnings. `next` holds `rule`'s steps and, in their
situations, the steps moved out of `notes` and `subscriptions.note` ("Explanation or instruction").

Own fields:

- The advice's identity, read by `launch` and `record`: `id`, `ts`, `mode`, `question_set`, `brief_sha`,
  `brief_chars`.
- Who answered: `provider` (on fallback, the last failed entry's provider), `decision_model` (absent on fallback), `unmeasured`
  (when the model has no measured profile), `ms`, and `answers` (the raw judgments: `level` `{ score, confidence,
  probabilities }`, `work_type` `{ choice, confidence }`, `high_blast_radius`), absent on fallback.
- The advice: `level`, `sure`, `between` (when torn), `work_type`, `high_risk`, `worker` `{ suggestion, why }`,
  `facts` (each `{ reading, p, means? }`), `notes`, `meaning`.
- `dispatch` only: `subscriptions` `{ most_room, candidates: { normal, fallback }, ranked, excluded, note }`. A ranked
  row: `subscription`, `class`, `use`, `reserve`, `hardest_work`, `your_default`?, `usable`, `headroom`, `windows`? (each
  `{ window, used_pct, resets_in_h, left, reserve_now, usable }`), `usage` (`live`, `given`, `assumed`, `metered`),
  `age_sec`, `note`?. An excluded row: `{ subscription, why }`.

## check

A first read of a worker's report against its brief. It never accepts or rejects work: the lead's own check decides.

Inputs:

- Required: `--brief <file>` and `--report <file>`. Refused (with `error`) when either flag is missing.
- Used when given: `--config <path>`.

`ok`:

| case | `ok` |
|---|---|
| a reading made, no flags | true |
| a reading made, flagged (reasons to send it back) | true. `ok` says routr read the report; it never means routr accepts the work, flagged or not. The flags are in `flags` and `headline`. |
| a given file unreadable | false, no `error`; `unavailable` names `brief` or `report` |
| the decision model unavailable | false, no `error`; `unavailable` names it. Unlike `dispatch`, there is no fallback product: without a reading there is nothing to act on. |
| a flag missing | false, with `error` |

`headline`: today's (`routr: N reasons to send this back`, `routr: the report gives no reason to send this back`, or
`routr: no reading (…); judge the report yourself`); successful readings append the answering model and provider.

Shared fields: all six. `warnings`: a very short report ("make sure it is the worker's full report"), config warnings.
`next`: send it back to the same worker, or run your own check, or (no reading) judge the report yourself.

Own fields: `mode`, `question_set`, `provider`, `decision_model`, `unmeasured`?, `ms`, `claimed` (the report's own
verdict), `flags`, `unclear`, `checks` (each `{ reading, p }`). On no reading only `mode`, `question_set` and, for a
decision-model failure, `provider`.

## launch

Starts a worker in a pane (a new worktree, a split, or a given pane) and sends it its task.

Inputs:

- Required: `--kind`, `--name`; `--model` (real and dry run); `--advice <file>` whenever a task is given (matching
  `dispatch` advice on that exact task; `subagent` advice ranks no accounts and is refused). Refused with `error` before any herdr call when missing or unusable; real launches
  use `state: "failed"`, and dry runs follow the `ok` rule below while still planning.
- Used when given: `--cwd` (default `.`), `--worktree <branch>`, `--base <ref>` and `--copy <path>` (with `--worktree`),
  `--pane <id>`, `--direction`, `--task` or `--task-file`, `--rules-file` (with a task), `--effort`, `--timeout`,
  `--dry-run`.

`state`: `planned`, `ready`, `prompted`, `needs_input`, `failed`.

`ok`:

| case | `ok` |
|---|---|
| dry run (`planned`) | true when the inputs pass every check a real launch makes before touching herdr that a dry run can make (arguments, folder, task, advice). False, with `error`, when a real launch would refuse (including a missing model or missing or nonmatching advice); the plan is still printed. A dry run does not check the environment, the subscription's on/off setting or sign-in; its `plan` step says so. |
| `ready` (no task given) or `prompted` | true |
| `needs_input` | false, no `error` |
| `failed` | false, with `error` |

`headline`: `routr: <name> (<kind>) took its task in pane <pane>`; `routr: <name> is ready in pane <pane>; no task
sent`; `routr: <name> needs input in pane <pane>: <why>`; `routr: launch failed: <error>`; `routr: planned <kind>
launch, nothing ran` (adding `; a real launch would refuse: <error>`).

Shared fields: all six. `unavailable`: the saved advice's `decision model` entries, a `model list` entry. `warnings`:
harness notes (an effort the harness remembers), a skipped `--copy`, a pane or private config left behind, a prompt
that may have been submitted, a rename that failed, each as a fact. `next`: as today (continue after input, record
template with an explicit `--effort`, cleanup), plus the steps those facts call for. A startup question uses its
answer-then-continue steps without a competing inspect-before-retry step. The startup instruction is the guide's
exact rule, embedded from that single source: read the pane and its options before sending keys (the default can be
"No, exit"); accept folder trust only for a directory the lead created or a worktree of the repository the user
already has it working in; otherwise ask the user and leave the pane waiting. Secrets and sign-in also wait for the
user. If launch failed before any task submission,
the record step says no task was delivered and uses `--verdict blocked --check none`. herdr's own messages and answers
never reach `steps[].detail`, `error` or `headline`: a failed herdr call is said by its classified code ("Text from
outside routr").

Own fields: `state`, `kind`, `name`, `pane`, `cwd`, `model`, `effort`, `start` `{ executable, argv, env }`, `steps`
(each `{ step, ok, detail }`), `ran`, `would_run` (dry run only), `prompt_chars`, `advice` `{ file, matches }` (when a
task was given), `worktree` `{ branch, base?, path, workspace }` (when one was made), `needs_input` `{ why, herdr?,
note? }` (only in `needs_input`; `herdr` is `{ state, rule?, explained?, rules? }`), `screen` (when launch stopped at
a pane: needs input, or failed after reading the pane).

### launch outside herdr (headless)

Outside herdr (`HERDR_ENV` is not `1`), a real launch starts a headless Claude Code worker instead of a pane. A dry run
plans the pane launch as before: it does not check the environment.

- Required, beyond launch's own: `--kind claude`, a task (`--task-file` or `--task`, at most 3 MB with launch's
  wrapping) with its matching `--advice`. Refused (with `error`, `state: "failed"`), before a run folder is written or a
  holder or worker started: another kind; `--pane` or `--direction`; no task; a task too large; a lead's sandbox it can
  see (`SANDBOX_RUNTIME`, `CODEX_SANDBOX`); a name whose run folder exists; a home whose socket path would be too long;
  with `--worktree`, a `--cwd` git finds no repository at, a branch that exists, or a worktree folder that exists; the
  subscription turned off; Claude not signed in.
- `--worktree <branch>` (with `--base`, `--copy`): launch makes the worktree with git under
  `~/.local/share/routr/worktrees`, on that new branch, and the worker runs there; `worktree` is `{ branch, base?, path,
  workspace: null }`, `cwd` its path, and `steps` add `worktree` and `copy`. git refusing to make it (a `--base` it
  cannot find) is a failure with `error`. When no holder could have started, launch removes the copies, the worktree
  (through cleanup's checks) and its branch while that still points at the commit it started on, as it does the run
  folder; what it cannot remove is a warning. When it keeps the run folder (the holder is starting or does not answer),
  it keeps the worktree too, and `cleanup --worker` removes both. `--copy` paths are relative to `--cwd`, as in herdr,
  and never copied through a link or over a file the worktree has.
- `--timeout` (default 120000) sets budgets, not a bound on the whole call: polling for the holder gets up to 15
  seconds of it (a probe under way when that runs out finishes), and the request handing Claude the task gets between
  35 and 45 seconds (the holder itself answers after 30). The sign-in check, the lock and each channel handshake can
  add time.
- `state`: `prompted` or `failed`. `prompted` means the task was written to Claude's input and Claude named its
  session, or 30 seconds passed without one; it does not prove Claude read or accepted the task. `wait` says how the
  turn went.
- `headline`: `routr: <name> (claude) took its task, running headless`, or the failure as for a pane launch.
- Own fields as a pane launch, with `pane: null` and `worker` `{ name, backend: "headless", run, session }` (`run`:
  the run folder; `session`: Claude's session id, or null). `start.argv` is Claude's headless command line; `ran`
  displays it. `steps`: `reserve`, `holder`, `prompt`. When no holder could have started, launch removes the run folder
  it made and `worker` is null; when the holder is starting or does not answer, it keeps the folder and `worker`, and
  `next` says to look at it with `routr workers --name <name>` before retrying.
- `next`: `routr wait --name <name>` (run), the record template, and `routr cleanup --worker <name>` (run). A failure
  after the task was handed over warns that it may have been sent, with `routr workers --name <name>` (run) to look
  before retrying.

## record

Appends one row to the ledger: the advice, what the lead chose, and how it went. The only command that appends to the
ledger. (Others keep caches of routr's own: named `usage cursor` and `usage kiro` write their usage snapshots, and any
command that checks a harness's sign-in keeps that answer.)

Inputs:

- Required: advice (`--advice <file>`, or JSON on stdin), `--subscription`, `--model`, `--effort`, `--verdict`,
  `--check`. With `--run-id`, the same advice the run was recorded with. Refused (with `error`) when missing,
  unreadable, or not matching `--task-file`.
- Used when given: `--task-file` (compared with the advice before anything is read or written), `--level` (default:
  the advised level; the guides ask for it always), `--report`, `--subagent` (repeatable), `--seconds`, `--attempts`,
  `--cause` (repeatable), `--run-id`, `--project`, `--note`, `--ledger`.

Usable advice. Today `record` without `--task-file` appends a row from any JSON, a saved refusal envelope
(`{ ok: false, error, … }`) included, with no advice id. One check, at the advice-file boundary that `launch` and
`record` share, runs before any task comparison, report read or append. Advice is usable when it is a JSON object
with a nonempty string `id` and a nonempty string `brief_sha`, and is not a refusal (`ok: false`, or an `error`
field). The new `ok` field is not required, so advice saved by an older routr is read as before.

| advice file | result |
|---|---|
| new success (`ok: true`, `id`, `brief_sha`) | accepted |
| new fallback (`ok: true`, decision failures and no answering model) | accepted; `advised.fallback` is true |
| backup reading (`ok: true`, `decision_model`, earlier decision failures) | accepted; `advised.fallback` is false |
| older success (no `ok`, `id`, `brief_sha`) | accepted |
| older fallback (no `ok`, `fallback: true`, with or without an `unavailable` entry) | accepted; `advised.fallback` is true, and launch says the attempted model is unknown when no entry names it, as today |
| a refusal, new or older (`ok: false` or `error`; no `id` or `brief_sha`) | refused: "--advice: this is a refused dispatch, not advice; dispatch the exact task again" |
| any other object without `id` or `brief_sha` | refused, naming the missing field |
| not JSON, or unreadable | refused, as today |

`ok`: true when the row was appended; false, with `error`, when nothing was.

`headline`: `routr: recorded run <run_id> (advice <id>) in <ledger>`, or `routr: nothing recorded: <error>`.

Shared fields: all six; `unavailable` is always `[]` (a file record cannot read refuses the call). `warnings`: the
advice was not checked against a task. `next`:

- Only `done` with `check pass`: integrate the verified result, then follow launch's cleanup step when the worker
  is finished. Every other outcome: send the work back or escalate, then verify and revise the row; no cleanup yet.
  This applies to a new row and a `--run-id` revision alike.
- A `kind: "do"` revision template on every successful record: the original `--advice`, `--task-file` when given,
  recorded `--subscription`, `--model`, resolved `--effort`, chosen `--level`, `--project`, `--ledger`, and this
  `--run-id`, with `--verdict`, `--check` and `--note` placeholders. Resolving effort and retaining project and ledger
  keep the original choice and row identity when the template is followed. Advice, task and ledger paths in the
  template are absolute, resolved from record's working directory, so it can be followed from another folder.
  Stdin advice uses an `<advice-file>`
  placeholder for the lead to save that same advice; other identity fields are already filled.
- When the advice was not checked, revise with `--task-file` or say why in `--note`.
- A malformed or unknown `--run-id` refuses the call and says it takes the `run_id` field from record's earlier
  output, not `id` (the advice id). A `kind: "do"` step points to that output and this worker's row for the advice
  id in the selected ledger to recover `run_id`; only a new worker run omits the flag.

Own fields: `id` (the advice's id), `run_id`, `ledger`.

## cleanup

Finishes a worker: removes its worktree, or closes its pane, after checking nothing of it would be lost.

Inputs:

- Required: at most one of `--worktree <branch>`, `--path <path>`, `--pane <id>`, `--worker <name>`; `--delete-branch`
  only with `--worktree`, `--path` or `--worker`; `--pane` and `--worker` take no `--cwd`. Refused (with `error`)
  otherwise.
- Outside herdr (`HERDR_ENV` is not `1`), the list and `--worktree`/`--path` modes read and remove worktrees through
  git, with the same checks, and `warnings` says cleanup cannot see whether anything runs in a worktree's folder.
- `--worker` refuses (`refused`) while the worker runs or does not answer, or while a process group it recorded still
  has members; for a worker launch gave a worktree, it first removes the worktree as `--path` would (`--delete-branch`
  and `--dry-run` pass on), and keeps the worker whole, with that refusal's reason and `next`, when it would not;
  `worktree` and `branch` are then as for `--path`. It refuses too when the worktree at that path is on another
  branch than the one launch made (it is someone else's), or when git lists no worktree there but a folder is.
  `headline` `routr: removed worker <name>`, `routr: kept
  <name>: <why>`, `routr: would remove <folder>[ and <worktree path>]`; a worktree it could not check is refused
  ("its worktree could not be checked"). `warnings` says what it cannot see: a command the worker started that left
  Claude's process group or detached itself (on Windows, anything once Claude has ended). For a worker launched
  without a worktree it removes only the run folder and its reports, inspects no repository, and warns that the
  worker's changes in its folder are the lead's to check. Own field: `name`.
- Used when given: `--cwd` (default `.`), `--delete-branch`, `--dry-run`.

Modes and `state`:

| mode | states |
|---|---|
| `--pane <id>` | `closed`, `absent`, `planned`, `refused`, `failed` |
| `--cwd` with no worker named: list | `listed`, `failed` |
| `--worktree` or `--path`: remove | `removed`, `absent`, `planned`, `refused`, `failed` |
| `--worker <name>`: a headless worker's worktree, then its run folder | `removed`, `absent`, `planned`, `refused`, `failed` |

`ok`:

| case | `ok` |
|---|---|
| `closed`, `removed`, `absent` | true: the worker's pane or worktree is gone, or was not there |
| `listed` | true when the list was made, whatever it holds |
| `planned` (dry run) | true: a real run would remove or close it now |
| `removed`, but the branch kept (`--delete-branch` on an unmerged branch) | true; `branch.deleted` is false and `warnings` says why. The branch is extra to the worker. |
| `refused` | false, no `error`, including a partial run: files copied in at launch were removed, then a later check refused the worktree (its `steps` show both) |
| `failed` | false, with `error` |

`headline`: `routr: removed <path>`; `routr: closed <pane>`; `routr: nothing to remove: no worktree <name>`; `routr:
would remove <path>` (dry run); `routr: N worktrees, M can be removed now`; `routr: kept <path or pane>: <why>`;
`routr: cleanup failed: <error>`.

Shared fields: all six. `unavailable`: a `pane` or `worktree` entry when a refusal comes from a read cleanup could not
make. `warnings`: a branch git kept, the repository's other worktrees when the named one is absent. `next`: what to
do about a refusal, the command that removes a worktree instead of closing its only pane, the list's removal template.
A refusal's reason, and so the headline, is routr's own sentence: "git refused `worktree remove` for <path>",
"git kept branch <name>: it deletes only a merged branch", "<pane> is running 2 commands besides its shell", never
git's or herdr's text or a process's name ("Text from outside routr").

Own fields: `state`, `steps`, `ran`; `cwd` (worktree modes); `pane` (pane mode); `worktrees` (list: each `{ branch,
path, workspace, detached, removable, why? }`); `worktree` `{ branch, path, workspace, detached }` (remove mode, once
found); `branch` `{ name, deleted }` (removed, when the worktree had one).

## wait

Waits for headless workers. Changes nothing of yours; it writes, in each worker's run folder, the highest turn it has
reported and the last state it gave notice of, so a later wait reports only what is newer.

Inputs: used when given: `--name <name>` (repeatable; default: every worker still running or with a turn not yet
reported), `--timeout <ms>` (default 90000, at most 600000; keep it under the command limit of your own shell tool,
2 minutes by default in Claude Code). A name with no worker is refused (`error`).

`state`: `finished` (a watched worker has a turn not reported before, or has newly `failed`, `stopped`, `lost`,
`no_task` or become `unreachable`: each said once per holder generation), `running` (the timeout came first), `idle`
(nothing watched is running and nothing is new), `none` (no worker to wait on), `failed` (refused).

`ok`: true unless refused. `headline`: `routr: <name> finished a turn` (or `finished N turns`, or `<name> <state>` for
a notice), joined with `; `; `routr: still running: <names>`; `routr: nothing running: <name> <state>, …`; `routr: no
headless worker to wait on`.

Own fields: `state`, `workers` (each as `workers` prints it, plus `gen`, the holder generation, and `turns` holding
only the turns reported now: `{ turn, outcome, report, delivered }`; `outcome` is `finished`, `failed`, `no_finish`
(the process ended without finishing the turn), `not_started`, `stopped` or `running`; `report` is a path or null;
`delivered` counts messages written into that turn). A report is Claude's final message of that turn, cut at 1 MB; a
turn can end without one. `next`: for each new report a `do` step with the `routr check` template on its path, and
for a turn without one a `do` step to look at the worker's work yourself; a step for a worker that is `lost` or has a
process group left; a note when background commands may start another turn; `routr wait` again (run) for the
workers still running. Inside a sandbox it can see, `warnings` says the sandbox may hide a worker's channel.

## send

A correction or follow-up for a headless worker launched with advice; the original advice and rules carry over. The
message is the text given, with the report reminder appended, at most 3 MB.

Inputs: required: `--name`, and one of `--task` or `--task-file`. Refused (`error`): an unknown worker, an empty or too
large message, the subscription turned off; and when a new holder must start: a worker whose process does not answer,
a process group of its still running, a sandbox it can see, a worker with no session to resume, Claude not signed in.

`state`: `delivered` (written into the running Claude's input: `message.code` `handed_to_harness`; not proven read),
`queued` (that Claude's input had closed: the holder keeps the message in memory and, once that Claude has exited,
starts a new Claude process resuming the same session with it; lost if the holder dies first), `resumed` (a new
holder resumed the session with it: `prompted`), `refused` (the holder did not take it: `message.why` is a fixed code,
such as `no_session`, `stopping`, `queue_full`, or `harness_ended` when the resumed Claude ended before taking it),
`unknown` (no answer after it was handed over), `failed` (refused input).

`ok`: true for `delivered`, `queued`, `resumed`. Own fields: `state`, `name`, `message` `{ code, why? }`. `next`:
`routr wait --name <name>` (run); for `unknown`, `routr workers --name <name>` (run) to look before sending again.

## workers

Each headless worker as its holder last recorded it, checked against whether its channel answers. Changes nothing.

Inputs: used when given: `--name` (repeatable). Own fields: `workers`, each `{ name, kind, model, effort, cwd, state,
turn, seconds_since_event, last_tool, tasks, queued, session, report, harness_group? }`. `state` is `starting`,
`working`, `waiting` (between turns: background commands running, a message queued, or Claude exiting), `idle`,
`failed`, `stopped`, `no_task` (its process started and no task came), `lost` (its process ended mid-turn without
settling), or `unreachable` (its channel does not answer). `last_tool` is one of Claude's tool names, `mcp`, `other`,
or null. `report` is the path of the latest turn's report that has one, or null. `harness_group`: a process group it
recorded that still has members (a lost worker's Claude, or a command that outlived Claude), on macOS and Linux.
Never worker text. Inside a sandbox it can see, `warnings` says so.

## stop

Stops a headless worker through its own process. Inputs: required: `--name`.

`state`: `stopped` (Claude and its process group are gone), `still_exiting` (told to stop; Claude not gone within six
seconds, or something of its group still there after it went), `absent` (not running), `lost` (its process is gone, or a group it recorded still has members),
`unreachable`, `unknown`, `failed` (refused). `ok`: true for `stopped` and `absent`. For `lost` and `unreachable`,
`warnings` says routr never stops a process by a saved id and `next` says what to look at. Own fields: `state`,
`name`. `next`: `routr cleanup --worker <name>` (run).

## usage

What routr sees of each subscription's usage, and how dispatch would rank it, with no brief. A capacity view, never a
reassessment of work.

Inputs:

- Required: none.
- Used when given: one subscription name (`claude`, `codex`, `agy`, `cursor`, `kiro`); `--level <basic|standard|strong>`
  (once, unnamed only, without `--background`); `--config`; `--headroom` (repeatable); `--json` (accepted, changes
  nothing); `--background` (routr's own refresh job, which no one reads). Refused (with `error`) for an unknown flag, a
  second name, a bad `--level`, or a name that is not configured (except `cursor` and `kiro`, which can be read
  unconfigured).

`ok`:

| case | `ok` |
|---|---|
| no name, or `--level`: the view made | true, also when some readings failed (each is a `usage` entry in `unavailable`, its row `assumed` or `kept`) or a subscription is excluded |
| the ranking itself failed | false, no `error`; `unavailable` holds routr's `internal_error` entry |
| named `claude`, `codex` or `agy` | as no name, for that one subscription: these are read on every call, and naming one narrows the view. A failed read is `ok: true` with its entry; a signed-out one is `ok: true` with it in `excluded`. |
| named `cursor` or `kiro`: a fresh reading taken and kept | true |
| named `cursor` or `kiro`: the reading failed | false, no `error`; a `usage` entry in `unavailable` (with the last good reading `kept`, when there is one) and a `next` step to read it by hand |
| named `cursor` or `kiro`: not signed in | false, no `error`; it is in `subscriptions.excluded` with its `why` (the sign-in command), and nothing is read |
| refused input | false, with `error` |

`headline`: `routr: <name> has the most usable headroom for <level> work; normal: …, fallback: …`, or `routr: every
subscription that takes <level> work is at its reserve`, adding `; N readings unavailable`. Named `cursor` or `kiro`:
`routr: Cursor, Included 40% used, read now` or `routr: no fresh Cursor reading (<code>)`. An unranked view names
each actual exclusion (turned off, not configured, or not signed in) and its remedy; a fresh reading can succeed while
the subscription remains unranked. The headline includes that fact.

Shared fields: all six. `warnings`: config and input warnings; Kiro's leftover usage session; a named `cursor` or
`kiro` that is not configured, so not ranked (also named in `subscriptions.excluded`). `next`, each step only in its situation ("Explanation or instruction"),
for plain usage, `--level` and a named subscription alike:

- every subscription that takes the level is at its reserve: hold the work or ask the user (first);
- no eligible subscription: hold the work, use an eligible subscription or ask the user. Only an unnamed view
  above basic with an exclusion due to work level offers choosing a lower level and refreshing with `routr usage --level`;
- no subscription is configured: tell the user routr is not set up (`routr setup`), and ask which subscription to use
  meanwhile;
- a reading failed, live or cached (a `usage` entry in `unavailable`), for a harness with a by-hand way: read it by hand
  and pass `--headroom <name>=<share left>` (named `cursor` and `kiro` too);
- the ranking failed (routr's `internal_error` entry): read capacity yourself before choosing an account;
- with `--level`, when there are candidates: choose from `subscriptions.candidates`, normal before fallback, and keep the
  original dispatch advice for launch and record.

`[]` only when none of these applies: a plain view with nothing at its reserve and every reading made.

Own fields: `level`; `subscriptions` (the same object as `dispatch`'s; for a named subscription, its row alone);
named only: `subscription`; named `cursor` or `kiro` with a fresh reading: `reading`, the harness's own numbers for a
person to check against its screen (Cursor `{ plan, included_used_pct, auto_used_pct, api_used_pct, headroom }`; Kiro
`{ plan, credits_used, credits_limit, used_pct, resets_at, unrecognized_lines?, headroom }`).

## The ledger and telemetry

Neither schema changes. `record` writes the same row from these advice fields, whose names do not change: `id`, `ts`,
`mode`, `question_set`, `provider`, `decision_model`, `brief_sha`, `brief_chars`, `level`, `sure`, `between`,
`work_type`, `high_risk`, `facts.*.p`, and each ranked row's `subscription`, `usable` and `usage`. One removal touches
how a column is filled, not the column: `advised.fallback` uses the shared fallback check above; earlier decision
failures beside an answering model are ordinary advice. Telemetry rows are built from ledger
rows, so nothing in them changes. Moving `subscriptions` into `usage` and adding `hardest_work` to `dispatch`'s rows
adds a field to saved advice that `record` does not read. No rename here needs a `docs/telemetry.md` change.

## Field maps

Destinations: **kept** (as is), **renamed** (to the name given), **moved** (to the place given), **removed**, **added**.
Shared fields that are new to a command are listed as added.

### subagent and dispatch

| previous field | destination | reason |
|---|---|---|
| `ok` (refusals only) | kept; **added** on every answer | one meaning of "did it work" in every command |
| `error` (refusals) | kept | marks a refusal |
| `headline` | kept; **added** on refusals | every answer has one line |
| `id`, `ts`, `mode`, `question_set`, `brief_sha`, `brief_chars` | kept | the advice's identity; ledger inputs |
| `unavailable` and its entries (`part`, `provider`, `model`, `code`, `why`, `status`; `subscription`, `source`, `reading`, `reading_source`, `age_sec`) | kept | already the shared shape |
| `provider`, `decision_model`, `ms` | kept | who answered; ledger inputs (`provider` on fallback names the last failed entry's provider) |
| `unmeasured` | kept | qualifies `decision_model` in saved advice, for comparing models later |
| `answers.level.score`, `.confidence`, `.probabilities`; `answers.work_type.choice`, `.confidence`; `answers.high_blast_radius` | kept | raw judgments kept with the advice so preferences can be re-applied without asking again |
| `fallback` | removed | decision failures without an answering model indicate fallback; `record` and `launch` share that check (above) |
| `level`, `sure`, `between`, `work_type`, `high_risk` | kept | the advice; ledger inputs |
| `worker.suggestion`, `worker.why` | kept | the advice |
| `facts.<name>.reading`, `.p`, `.means` | kept | the advice; `p` is a ledger input |
| `notes` | kept, without the "Router unavailable" note, and each note's instruction moved to `next` | the advice's reasoning; the fallback note repeats `unavailable`; instructions are `next` steps ("Explanation or instruction") |
| `meaning` | kept | says what the advised level means; changes with the level |
| `subscriptions.most_room`, `.candidates.normal`, `.candidates.fallback` | kept | the ranking |
| `subscriptions.note` | kept, its instructions moved to `next` (hold the work, ask or tell the user, normal before fallback) | the ranking's policy explanation; instructions are `next` steps in their situation |
| `subscriptions.ranked[]`: `subscription`, `class`, `use`, `reserve`, `your_default`, `usable`, `headroom`, `usage`, `age_sec`, `note` | kept | the ranking; `subscription`, `usable`, `usage` are ledger inputs |
| `subscriptions.ranked[].windows[]`: `window`, `used_pct`, `resets_in_h`, `left`, `reserve_now`, `usable` | kept | per-window numbers to check against the harness |
| `subscriptions.ranked[].hardest_work` | added | one row shape with `usage` |
| `subscriptions.excluded[].subscription` | kept | |
| `subscriptions.excluded[].reason` | renamed `why` | the reason for the entry is `why` everywhere |
| `next` | kept, with `rule`'s steps added | the one field of instructions |
| `rule` | removed (its sentences become `next` steps) | settled above |
| `config_notes` | moved to `warnings` | about the call, not the work |
| `input_notes` | moved to `warnings` | about the call, not the work |
| `warnings` | added | shared field |
| (empty brief: a stderr line, exit 2) | becomes a JSON refusal, exit 0 | a missing required input is refused like the others; advice commands exit 0 |

### check

| previous field | destination | reason |
|---|---|---|
| `ok` | added | shared field |
| `headline` | kept | |
| `mode`, `question_set` | kept | which question set answered |
| `unavailable` (`brief`/`report` entries: `part`, `code`, `why`; the `decision model` entry) | kept | shared shape |
| `fallback` | removed | here it meant "no reading", while in the advice commands it means "the decision model failed": one name, two meanings; `ok: false` and `unavailable` say it |
| `warning` | moved to `warnings` | one shared field, a list |
| `claimed`, `flags`, `unclear` | kept | the reading |
| `checks.<name>.reading`, `.p` | kept | the reading |
| `next` | kept; added when a file was unreadable (today absent); its step no longer repeats the decision model's `why` | every answer says what comes next; the recovery is in `unavailable` |
| `provider`, `decision_model`, `ms` | kept | who answered |
| `unmeasured` | added | the same "who answered" block as the advice commands |
| `error` | added (missing `--brief` or `--report`) | required inputs are refused |
| `warnings` | added | shared field |

### launch (dry run and real)

| previous field | destination | reason |
|---|---|---|
| `ok` | kept; follows the launch `ok` rule above, including dry-run refusals | `ok: true` must not tell a lead a refused launch is good to go |
| `state` | kept | |
| `kind`, `name`, `pane`, `cwd`, `model`, `effort` | kept | what was launched, and where |
| `command` | renamed `ran` | `command` means a runnable line in `next`; this is display history |
| `planned_command` (dry run) | renamed `would_run` | as above; says it is a plan |
| `argv`, `env` | moved to `start.argv`, `start.env` | `argv` means a runnable command's words in `next`; this is the harness start |
| (the harness's executable) | added as `start.executable` | the start line reads whole |
| `steps[]`: `step`, `ok` | kept | what it did, in order |
| `steps[].detail` | kept, built from classified codes, never herdr's message or answer | outside text reaches output only as `screen` |
| `warnings` | kept, without "Fallback advice: …" and the unread model list, each as a fact, its step moved to `next` | the first repeats `unavailable`; the second is a read routr could not make; instructions are `next` steps |
| `next` | kept | |
| `needs_input` (null when not needed) | kept, present only in `needs_input` | optional fields are present only when they apply |
| `needs_input.why` | kept | |
| `needs_input.screen` | moved to top-level `screen` | one name for what the pane showed |
| `needs_input.pane` | removed | the same value as the top-level `pane` |
| `needs_input.herdr.state`, `.rule`, `.explained`, `.rules` | kept, each checked against its shape at the herdr boundary; a value outside it becomes `unknown` or is left out | herdr's own reading, permitted as validated structured values ("Text from outside routr") |
| `needs_input.note` | kept | what routr knows of the harness's startup question; an explanation, so a `note` |
| `prompt_chars` | kept | the prompt's length, never its text |
| `unavailable` | kept; gains `model list` entries | |
| `advice.file`, `advice.matches` | kept | the advice check |
| `worktree.branch`, `.base`, `.path`, `.workspace` | kept | the worktree it made |
| `pane_text` | renamed `screen` | one name for what the pane showed |
| `headline` | added | shared field |
| `error` | added (refusals and `failed`; dry run that a real launch would refuse) | today the reason is only a step's `detail` |

### record

| previous field | destination | reason |
|---|---|---|
| `ok` | kept | |
| `recorded` | renamed `id` | it is the advice's id, which the advice and the ledger row call `id` |
| `recorded: null` (on failure) | removed | `ok: false` and `error` already say nothing was recorded |
| `run_id`, `ledger` | kept | the row written, and where |
| `warnings` | kept, as a fact; its instruction moved to `next` | instructions are `next` steps |
| `next` | kept, with outcome-specific integration or rework, a filled revision template, and recovery for an unknown `run_id` | the lead can follow this answer for both new rows and revisions |
| `error` | kept; also on unusable advice (a saved refusal, no `id` or `brief_sha`) and a missing required flag | a row is appended only from usable advice and complete inputs |
| `headline`, `unavailable` | added | shared fields (`unavailable` always `[]`) |

### cleanup (each mode)

| previous field | destination | reason |
|---|---|---|
| `ok`, `state` | kept | |
| `cwd` | kept in worktree modes; omitted in pane mode (today `null`) | present only when it applies |
| `command` | renamed `ran` | display history, not a runnable line |
| `next`, `steps`, `warnings` | kept; `steps[].detail` and `warnings` built from classified codes | git's stderr and herdr's messages are outside text |
| `refused.why` | moved to `headline`, as routr's own sentence; `refused` removed | `state` says it was refused; the object held one string; the reason may not carry git's or herdr's text |
| `pane` (pane mode) | kept | |
| `worktrees[]`: `branch`, `path`, `workspace`, `detached`, `removable` | kept | the list |
| `worktrees[].why` | kept | the reason for that entry |
| `worktree`: `branch`, `path`, `workspace`, `detached` | kept | the worktree named |
| `branch.name`, `branch.deleted` | kept | |
| `headline`, `unavailable` | added | shared fields; `unavailable` names a pane or worktree cleanup could not read |
| `error` | added (`failed`) | today the reason is only a step's `detail` |

### usage: no name, `--level`, and named `claude`, `codex`, `agy`

| previous field | destination | reason |
|---|---|---|
| `ok`, `error` | kept | |
| `level` (only with `--level`) | kept, always present | the level the view was filtered for; plain usage is `basic` |
| `most_room` | moved to `subscriptions.most_room` | one object, read the same way in `dispatch` |
| `candidates.normal`, `candidates.fallback` | moved to `subscriptions.candidates` | as above |
| `note` | moved to `subscriptions.note` | as above; an explanation, not a warning |
| `excluded[].subscription` | moved to `subscriptions.excluded` | as above |
| `excluded[].reason` | moved and renamed `subscriptions.excluded[].why` | as above, and the reason for an entry is `why` |
| `ranked[]` (every row field, `windows[]` included) | moved to `subscriptions.ranked` | as above |
| `ranked[].hardest_work` | moved with its row | now in `dispatch`'s rows too |
| `how` | removed | a fixed sentence, the same on every call; the ranking page says it |
| `input_notes` | moved to `warnings` | about the call |
| (ranking failure: `error` with the exception's text) | becomes an `internal_error` entry in `unavailable`, `ok: false` | fixed wording, as `dispatch` gives it |
| `headline`, `unavailable`, `warnings`, `next` | added | shared fields; usage failures were only in row notes |
| `subscription` (named) | added | names the subscription asked for |

### usage: named `cursor` and `kiro`

| previous field | destination | reason |
|---|---|---|
| `ok` | kept | follows the fresh reading |
| `subscription` | kept | |
| `plan`, `headroom` | moved to `reading` | the harness's own numbers, kept apart from routr's ranked row |
| Cursor: `included_used_pct`, `auto_used_pct`, `api_used_pct` | moved to `reading` | as above |
| Kiro: `credits_used`, `credits_limit`, `used_pct`, `resets_at`, `unrecognized_lines` | moved to `reading` | as above |
| `code`, `why` (failed reading) | moved to an `unavailable` entry (`part: "usage"`, `subscription`, `source`, `code`, `why`, `reading`) | what routr could not read, in the shared shape |
| `read_yourself` | moved to a `next` `do` step (template `--headroom <name>=<share left>`) | an instruction; today it is dropped before output |
| Kiro: `note` (empty session kept) | moved to `warnings` | something left behind, not an explanation of a number |
| `excluded: true`, `why` (not signed in) | moved to `subscriptions.excluded[]` `{ subscription, why }` | the same exclusion shape as every ranking |
| `level`, `subscriptions` | added | the same view as unnamed usage, for that subscription, after the fresh reading |
| `headline`, `unavailable`, `warnings`, `next` | added | shared fields |

## What reads a renamed or removed field

Each guide, skill, help text and test that reads a field this map renames, moves or removes, by file and line, as of
the commit this page was written on. Lines that only build input (an advice file written for a test) are marked
"input". Source lines that read a moved field are listed last, for the change that implements this map.

Guides and skills:

- `skills/routr/SKILL.md:36-37` "marked as a fallback": wording for the no-reading headline and `unavailable`, not
  the `fallback` field; reword.
- `skills/routr/SKILL.md:89-93` `input_notes` → `warnings`.
- `skills/routr/SKILL.md:96` "`subscriptions` (dispatch only)" → `dispatch` and `usage`.
- `skills/routr/SKILL.md:105` excluded `reason` → `why`.
- `skills/routr/SKILL.md:106` "when everything is at its reserve, hold the work or ask the user": now also a `next`
  step in that situation; the guide can say so.
- `skills/routr/references/orchestrator.md:139-141` "Dry runs make the same checks as warnings and still plan" →
  dry runs plan and return `ok: false` with `error`.
- `skills/routr/references/orchestrator.md:146-147` "`--trust` is still accepted and does nothing" → removed.
- `skills/routr/references/orchestrator.md:149-152` launch's `warnings` and `next`: add `headline`; dry run `ok`.
- `skills/routr/references/orchestrator.md:154-158` `needs_input` holds `screen` and `pane` → top-level `screen`; no
  `pane` in `needs_input`.
- `skills/routr/references/orchestrator.md:58-61` usage `ok`, `level`, `candidates` → `subscriptions.candidates`;
  `level` always present.
- `skills/routr/references/orchestrator.md:301` cleanup's `refused` → `headline` and `next`.
- `skills/routr/references/orchestrator.md:337` "History (`command`, `planned_command`)" → `ran`, `would_run`.
- `docs/ranking.md:113-122` `candidates.normal`, `candidates.fallback`, `ranked`, `most_room`: unprefixed paths that
  read as plain `usage`'s top level; say they sit under `subscriptions` in both `dispatch` and `usage`.
- `docs/troubleshooting.md:43` heading "Every answer says `fallback`" → the no-reading headline.
- `docs/troubleshooting.md:87` `read_yourself` → the `next` step.
- `docs/guarantees.md:27` "Dry runs warn and plan instead" → dry runs plan, and return `ok: false` when a real launch
  would refuse.
- `README.md:96-97` "marked as a fallback": wording, as in the skill.

Help text: no entry in the help table names a field this map renames or removes. The entries that describe output
(`subagent`, `dispatch`, `launch`, `check`: `unavailable`, the no-reading headline, `next`) stay true. `launch`'s
`--advice` and `--dry-run` descriptions (`src/lib/help.mjs:50`, `src/lib/help.mjs:60`, "dry runs warn and plan",
"advice checks warn") change with the dry-run `ok`, and its `--trust` entry (`src/lib/help.mjs:58`) goes with the flag.

Tests:

- `rule`: `test/advise.test.mjs:123`, `test/advise.test.mjs:124`, `test/advise.test.mjs:127`.
- `config_notes`: `test/advise.test.mjs:129`.
- `input_notes`: `test/cli.test.mjs:539`, `test/cli.test.mjs:565`, `test/cli.test.mjs:568`.
- The fallback note in `notes`: `test/advise.test.mjs:132`, `test/provider-boundary.test.mjs:258`.
- `fallback` (output): `test/advise.test.mjs:129`, `test/cli.test.mjs:493`, `test/unavailable.test.mjs:123`,
  `test/provider-boundary.test.mjs:104`, `test/provider-boundary.test.mjs:114`, `test/provider-boundary.test.mjs:136`,
  `test/provider-boundary.test.mjs:258`, `test/provider-boundary.test.mjs:263`, `test/provider-boundary.test.mjs:331`.
- `fallback` (input: advice files a test writes for `launch` or `record`; `fallback: true` is still read from older
  advice, and new fixtures should carry the `decision model` entry): `test/telemetry.test.mjs:69` (passed to the
  ledger row builder directly, not through the advice check), `test/handoff.test.mjs:19`, `test/launch.test.mjs:20`
  keep passing.
- Advice fixtures with no `id`, which the usable-advice check refuses: each gains a valid `id` so it still tests what
  it tests (an older fallback, a match, a mismatch): `test/unavailable.test.mjs:88`, `test/unavailable.test.mjs:267`
  (older fallback advice), `test/launch.test.mjs:75`, `test/launch.test.mjs:126`, `test/launch.test.mjs:130`,
  `test/handoff.test.mjs:32`. Separate cases test the refusal itself: `test/handoff.test.mjs:31` (no `brief_sha`)
  stays, and new cases cover no `id`, an empty `id`, and a saved refusal, for `launch` and `record`.
- `check`'s next repeating the decision model's `why`: `test/provider-boundary.test.mjs:263`.
- `check`'s `warning`: `test/cli.test.mjs:499`.
- Launch `command` → `ran`: `test/launch.test.mjs:242`, `test/launch.test.mjs:254`, `test/launch.test.mjs:290`,
  `test/launch.test.mjs:300`, `test/launch.test.mjs:623`, `test/handoff.test.mjs:180`.
- Launch `planned_command` → `would_run`: `test/handoff.test.mjs:48`, `test/launch.test.mjs:243`,
  `test/launch.test.mjs:788`, `test/launch.test.mjs:789`, `test/launch.test.mjs:791`, `test/launch.test.mjs:838`,
  `test/launch.test.mjs:869`.
- Launch `env` → `start.env`: `test/launch.test.mjs:244`, `test/launch.test.mjs:757`.
- Launch `needs_input: null` → absent: `test/launch.test.mjs:190`, `test/launch.test.mjs:467`,
  `test/launch.test.mjs:559`.
- Launch `needs_input.pane` removed: `test/launch.test.mjs:199`, `test/launch.test.mjs:366`, `test/launch.test.mjs:455`.
- Launch `needs_input.screen` → `screen`: `test/launch.test.mjs:199`, `test/launch.test.mjs:217`,
  `test/launch.test.mjs:366`, `test/launch.test.mjs:516`, `test/launch.test.mjs:959`.
- Launch's "Fallback advice" warning: `test/unavailable.test.mjs:262`.
- `recorded` → `id`: `test/routing-quality.test.mjs:168`, `test/routing-quality.test.mjs:188`,
  `test/routing-quality.test.mjs:269`, `test/routing-quality.test.mjs:274`, `test/cli.test.mjs:494`,
  `test/handoff.test.mjs:169`, `test/provider-boundary.test.mjs:101`, `test/ledger.test.mjs:252`.
- Cleanup `refused`: `test/cleanup.test.mjs:89`, `test/cleanup.test.mjs:154`, `test/cleanup.test.mjs:169`,
  `test/cleanup.test.mjs:182`, `test/cleanup.test.mjs:184`, `test/cleanup.test.mjs:185`, `test/cleanup.test.mjs:230`,
  `test/cleanup.test.mjs:234`, `test/cleanup.test.mjs:253`, `test/cleanup.test.mjs:262`, `test/cleanup.test.mjs:274`.
- Excluded `reason` → `why` (the ranking produces it for both commands): `test/advise.test.mjs:169`,
  `test/routing-quality.test.mjs:76`, `test/usage.test.mjs:748`, `test/usage.test.mjs:760`, `test/usage.test.mjs:778`,
  `test/unavailable.test.mjs:145`, `test/unavailable.test.mjs:178`, `test/unavailable.test.mjs:181`.
- Usage's top-level ranking fields → `subscriptions`: `test/routing-quality.test.mjs:40`,
  `test/routing-quality.test.mjs:71`, `test/routing-quality.test.mjs:76`, `test/routing-quality.test.mjs:77`,
  `test/routing-quality.test.mjs:79`, `test/routing-quality.test.mjs:91`, `test/routing-quality.test.mjs:130`,
  `test/routing-quality.test.mjs:132`, `test/usage.test.mjs:262`, `test/usage.test.mjs:575`, `test/usage.test.mjs:576`,
  `test/usage.test.mjs:577`, `test/usage.test.mjs:578`, `test/usage.test.mjs:582`, `test/usage.test.mjs:777`,
  `test/usage.test.mjs:778`.
- Usage `level` always present: `test/routing-quality.test.mjs:70`, `test/routing-quality.test.mjs:73`,
  `test/routing-quality.test.mjs:127`.
- Usage's ranking failure as `error` text: `test/routing-quality.test.mjs:95`, `test/usage.test.mjs:586`.
- Named `cursor`/`kiro` output shape: `test/usage.test.mjs:445` (`excluded: true`, `why`), `test/usage.test.mjs:584`
  (a check result returned as is).
- A launch dry run without matching advice succeeding with a warning (now `ok: false` with `error`):
  `test/handoff.test.mjs:46`, `test/handoff.test.mjs:47`, `test/handoff.test.mjs:177`.
- `--trust` accepted (now an unknown option): `test/launch.test.mjs:195`, `test/launch.test.mjs:196`.
- Instructions moving from `notes` and `warnings` to `next`: `test/advise.test.mjs:40` ("Fix the brief first"),
  `test/advise.test.mjs:106`, `test/advise.test.mjs:108`, `test/advise.test.mjs:111` ("Start at …"),
  `test/launch.test.mjs:495` ("address it by its pane"), `test/launch.test.mjs:712` ("Prompt may have been
  submitted"), `test/launch.test.mjs:738` ("left alive": the fact stays, the step moves).
- herdr text in output, now classified: `test/launch.test.mjs:1018` expects the failed launch's last step `detail` to
  contain `agent_not_running`, herdr's own error passed on. Replace it with the classified expectation: the step says
  the agent is no longer running in routr's words, with its routr code, and herdr's text is absent. The marker test
  (implementation checks) is new.

Source lines (not prose; for the implementing change):

- Read a moved or removed field: `src/lib/launch.mjs:137` (`advice.fallback`), `src/lib/ledger.mjs:111`
  (`advice.fallback` into `advised.fallback`), `src/lib/snapshot.mjs:42` (rebuilds a failed reading from its code,
  dropping Kiro's note; the command layer adds the by-hand `next` step and the warning).
- The record-template builder, `src/lib/next.mjs:25`: adds `--effort` only when an effort was given or the model is a
  placeholder; it must always add it (above).
- The headline's "FIX THE BRIEF FIRST", `src/lib/advise.mjs:73`: found by the note's wording; it must read the brief
  facts instead once the note moves to `next`.
- Usable advice: `src/lib/advice-file.mjs:15` (read) and `src/lib/advice-file.mjs:20` (matched), and record's path
  without `--task-file`, `src/lib/commands.mjs:119`.
- Outside text reaching output: `src/lib/cleanup.mjs:26` (git's stderr line), `src/lib/cleanup.mjs:108` (herdr's
  message), `src/lib/cleanup.mjs:131` (process names), `src/lib/cleanup.mjs:262`, `src/lib/cleanup.mjs:266`,
  `src/lib/cleanup.mjs:276`; `src/lib/launch.mjs:193` (herdr's message, or its whole answer),
  `src/lib/launch.mjs:289`, `src/lib/launch.mjs:365`, `src/lib/launch.mjs:368`, `src/lib/launch.mjs:372`,
  `src/lib/launch.mjs:426`, `src/lib/launch.mjs:456` (a failed start's whole answer in a step's detail),
  `src/lib/launch.mjs:460`, `src/lib/launch.mjs:480` (the failure's message in a step's detail).

Internal reader results are not command output. The Cursor and Kiro readers may keep `read_yourself`, their numbers
and `subscription` in their own results, and their tests (`test/usage.test.mjs:379`, `:399`, `:408`, `:432`, `:463`,
`:468`, `:469`, `:477`, `:485`, `:514`, `:527`) do not change: the command layer builds `reading`, the `unavailable`
entry and the by-hand step. Only the tests of `routr usage cursor|kiro`'s own output (`test/usage.test.mjs:445`,
`test/usage.test.mjs:584`) change.

## Implementation checks

The change that implements this page does all of this in one pull request:

- Tests, per the quality gate for a rule that holds everywhere:
  - Every command above, on every outcome its tests already drive, prints `ok`, `headline`, `unavailable`,
    `warnings` and `next`, and `error` only when `ok` is false. No top-level `command`, `planned_command` or `argv`
    remains; `argv` appears only in `next` entries and in `start.argv`, and display history only in `ran` and
    `would_run`.
  - A whole-output marker test for herdr and git text: a fake herdr that puts a marker in its error message, its
    error code and its JSON answer, and in a pane's process names, and a fake git that puts it in stderr and stdout,
    driven through every failure path of `launch` and `cleanup` (and named `usage cursor`, which drives herdr). The
    marker appears nowhere in the printed JSON except `screen` before a task was sent, and never after.
  - Structured herdr values: a fake herdr that answers with the marker as an agent state, a rule id, a rules version,
    an agent kind and a working folder, and with values just outside each shape (an uppercase rule, a relative
    folder, a control character): none is printed, `why` says `unknown`, "another agent" or "a folder herdr does not
    report", and in-shape values (`blocked`, `trust_directory`, `2026.10.01.1`) are reported as today.
  - The record template carries `--effort` for every kind, with and without `--effort` at launch, and for an adopted
    pane; following each template (placeholders filled) records a row.
  - A startup question's `next` uses the guide's exact trust rule from one source, leaves an unauthorized folder
    question waiting for the user, and warns that the default can exit the worker.
  - Record's next step integrates only `done` with `check pass`, for new rows and revisions; every success supplies a
    revision template whose filled placeholders revise that same run. Unknown or malformed run IDs explain `run_id`
    versus advice `id`, point to the earlier output and ledger, and append nothing.
  - Usable advice: each row of the table under record, for both `record` (with and without `--task-file`) and
    `launch` (real and dry run).
  - No `notes`, `note`, `why` or `warnings` string is an instruction this page moves to `next` (the table above), and
    each moved step appears in `next` in its situation, in `dispatch` and in `usage` (plain, `--level`, and named):
    every account at its reserve, nothing taking the level, nothing configured, a failed live or cached reading, a
    ranking failure. Plain usage with none of these returns `next: []`.
- `docs/guarantees.md` in the same change: dry runs return `ok: false` when a real launch would refuse; outside text
  from herdr and git is classified; usable advice; record's required flags.
- `CHANGELOG.md`, under Unreleased, one line with the PR number, written for a user, e.g. "Every command a lead reads
  now says the same five things the same way (ok, headline, unavailable, warnings, next); several output fields are
  renamed, and launch's --trust is gone".
- Release notes (`docs/releases/<tag>.md`) for the release that ships it, for a user and an agent:
  - Renamed output paths, as a short table: `ran` and `would_run` (was `command`, `planned_command`), `start.*` (was
    `argv`, `env`), `screen` (was `needs_input.screen`, `pane_text`), `id` (was `recorded`), `subscriptions.*` in
    `usage` (was top-level), `excluded[].why` (was `reason`), `warnings` (was `config_notes`, `input_notes`, `warning`),
    removed `fallback`, `rule`, `refused`, `how`, `read_yourself`.
  - `--trust` is no longer accepted: a launch line that passes it is refused as an unknown option.
  - Tighter required inputs: `record` needs `--subscription`, `--model`, `--effort`, `--verdict` and `--check`;
    `check` needs `--brief` and `--report`; an empty brief is a JSON refusal (exit 0, was exit 2); a launch dry run
    without matching advice returns `ok: false` and exits 1.
  - Advice saved by an older routr is still read by `launch` and `record`; a saved refusal is refused.
  - A lead whose guides and binary update together needs nothing else; the skill and guides ship in the same
    release.

Implementation clarifications: git's status and file-flag output is used for safety checks, but refusal prose counts
changed, untracked and unchecked files rather than copying their names. Those names are outside text; `next` offers
the git inspection command. Missing or malformed git commit, status, file-flag and ref readings are unreadable
worktree state, never proof that a worktree is safe. A model list read that throws is unavailable like an empty list.

An unreadable ref check is an unreadable check, not an unheld commit. Cleanup states which read failed and offers
the corresponding git inspection command. An explain answer without a state adds no disagreement to a blocked reading.
