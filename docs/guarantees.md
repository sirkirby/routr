# What routr does on your machine

What routr reads, writes, starts and removes, and when. Each of these is true of routr today and checked by its
tests; where a limit remains, it is stated. A change to one updates this page and its tests in the same pull request.

## Commands that advise, and commands that act

The advice commands (`subagent`, `dispatch`, `check`, `doctor`, `assess`, `usage` with no name) change nothing of
yours (`doctor --fix` is `setup` under another name). What they do besides answering:

- read your harnesses in the foreground, through each harness's own CLI (its status command, Claude's `/usage`);
- keep routr's own bookkeeping under `~/.cache/routr` (which harnesses are signed in, when a usage source was last
  refreshed);
- start one of routr's detached jobs and carry on: the updater, or Cursor's or Kiro's usage refresh.

They fail open: any error still prints usable output and exits 0. `dispatch`, `subagent` and `check` return
`unavailable`, a list of the readings they could not make (`[]` when nothing was missing). Decision-model failures
name each failed provider and attempted model with a fixed code and recovery action. A later answer is an ordinary
reading and its headline names the model that answered; only no answer starts with `no reading`.
`check` also names an unreadable brief or report. `decision_model` continues to mean the model that answered
(null in a fallback ledger row); `unavailable` is output only, never stored in the ledger or sent in telemetry.

`record`, `setup`, `uninstall`, `key set`, `skill install`, `share`, `update`, `telemetry on|off|send`, `feedback`,
`launch`, `cleanup`, `send`, `stop`, `usage cursor`, and `usage kiro` act, and each says what it did. Their read-only forms
(`telemetry status`, `setup --show`) only read, and so does `workers`; `wait` changes nothing of yours, and writes which
turns it has reported into the worker's own run folder.

Local file writes create parent folders from the file's absolute location, including when only a relative filename
was given. An existing directory is accepted; a file in its place or a permission error remains a failure.

- `launch` drives panes in your herdr session; outside herdr it starts a headless Claude Code, Codex or Antigravity worker (below). A task requires readable JSON advice from `routr dispatch` on that exact task
  (including `brief_sha`); missing, nonmatching or `routr subagent` advice is refused before any harness, pane or worktree call. Dry runs return
  `ok: false` with `error` on the same refusal and still plan. Matching fallback advice is accepted, including advice
  saved as UTF-8 or UTF-16LE, with or without a BOM. Launch copies all its decision-model `unavailable` entries,
  including those before a backup reading. Older fallback advice that lacks the entry says the saved advice does not name the attempted model; launch never fills it from current settings. Recovery actions
  are rebuilt from the saved provider, model and code, including HTTP status for a provider error. The lead still
  chooses the account, model and effort. Real launches return a record template only after a
  start or task-submission attempt; dry runs with matching advice return the planned template.
  A startup question's next step uses the guide's trust rule: accept only a directory the lead created or a worktree
  of the repository the user already has it working in; otherwise ask the user and leave the pane waiting. The lead
  reads the options before sending keys because the default can exit the worker.
- `record --task-file` checks that the advice belongs to that task before reading reports or appending anything.
  Without a task file it warns that the advice was not checked. Revisions require the original advice identity;
  if the original task file is gone, revise without `--task-file` and say so in `--note`.
  Its next step integrates and cleans up only for `done` with `check pass`; every other outcome calls for rework or
  escalation before cleanup. Every successful record returns a filled revision template for its own `run_id`.
  Advice, task and ledger paths in that template are absolute, so changing folders still revises the same run.
  An unknown run ID points to the earlier record output and the selected ledger; advice `id` is not a run ID.
- `cleanup` removes a worker's worktree (through herdr, or git when no workspace is open) or closes its pane. It
  refuses while anything it can see runs there or when it cannot tell, never uses `--force`, and refuses a worktree
  holding uncommitted changes, files git is told not to check, a commit no branch or tag holds, or untracked files
  the main checkout does not hold as they are. An untracked file identical to the main checkout's is taken for one
  `launch --copy` brought in and goes with the worktree, as ignored files do (as with `git worktree remove`). It
  deletes a branch only when asked and `git branch -d` agrees it is merged. Limit: neither herdr nor git can remove
  only if unchanged, so a commit made, or a worker started, after cleanup's last check is not seen.
- `cleanup --worker` removes a headless worker's worktree, when launch made one, with the same checks as `cleanup
  --worktree` (and keeps everything when one fails), then its run folder, its reports included, once its own process
  has ended and no process group it recorded still has members, under the lock a new holder is started under. A
  worker launched without a worktree worked in your folder: cleanup does not inspect or touch it. What it cannot see
  is under "Headless workers" below.
- Outside herdr, `cleanup --cwd`, `--worktree` and `--path` list and remove worktrees through git (`git worktree
  list`, `git worktree remove`, never `--force`), and cannot see whether anything runs in a worktree's folder: they say
  so in `warnings`.
- `usage cursor` drives only a private headless herdr session it makes and removes, never your own, and keeps the
  reading in `~/.cache/routr`.
- `usage kiro` runs Kiro's own `/usage` in the system temp folder, deletes the empty session that leaves with Kiro's
  own `--delete-session`, and keeps the reading in `~/.cache/routr`.

## Updates

Updates are automatic but never in the way: at most once a day a command may start a detached updater and carry on.
The command does not wait for it or make a network call for it; it may report what the updater last did (`doctor`
says when an update is waiting). The updater verifies the release checksum, swaps the binary in place, and reinstalls
the skill; a run in progress keeps its binary. It follows your `update_channel` (stable, or beta: also `-beta.N` and
`-rc.N`, never alpha) and never downgrades by itself. `"auto_update": false` turns it off. It never runs from a source
checkout or from `statusline`.

## Usage readings

`dispatch` and `usage` with no name read each enabled usage source's newest reading and show its age; `usage <name>`
reads that one; `subagent` reads none.
routr never has to own a harness feature (a statusline slot, a hook) to get its usage: it asks the harness's own CLI.

- Claude's is read in the call from its own `/usage`, hooks and MCP servers off; a statusline snapshot under 5 minutes
  old is used instead when one exists.
- Claude, Codex and Antigravity are read in the call (1 to 9 s, beside the decision model).
- Cursor's own screen takes seconds more and starts Cursor, and Kiro's `/usage` takes about 10 s plus its cleanup, so
  their readings are snapshots: when the last try is over 4 hours old, a call starts a detached `routr usage cursor`
  (or `kiro`) to refresh it, says a fresh reading is being taken, and carries on without waiting (unlike the updater,
  also from a source checkout: it swaps nothing).

Failed usage reads have fixed codes and sentences at the reader boundary and in the snapshot cache; harness
output and exception text are never copied into their diagnostics. A failed refresh keeps the last good reading
and notes the failed attempt. A fresh usable reading stays available. When a failed source leaves assumed
headroom or a kept older reading, `unavailable` says which; a kept reading names its source and age. Snapshot
readings are fresh for the four-hour refresh interval, local statusline/session-log readings for five minutes.
A snapshot at least a day old is too old to use: its age is shown with assumed
headroom, and age alone is not a failure. Metered accounts without known capacity are valid readings. Accounts
left out by settings or sign-in status stay in `excluded`, outside the failed readings.

How usage is ranked: [ranking.md](ranking.md). A reserve is never offered.

## Signed in, not just installed

A harness is used only once its own status command says it is signed in. One that is not gets no model list, no usage
read, no refresh, and no launch, because asking it anything else can open its sign-in in your browser. routr never
starts a harness's sign-in; it says what to run.

## Skills: what install and uninstall touch

`skills/` holds exactly what is installed for agents (the `routr` skill with its guides, and the user-invoked
`routr-orchestrate`) and no code. Every skill is installed the same way: written to `~/.agents/skills`, and linked
into each harness's own skills folder, or copied there on Windows, where a link is refused, or where linking fails
(a copy routr made stays a copy).

Install and uninstall touch only what is provably routr's, by structure: a folder holding routr's manifest
`.routr-install.json` (written in the same staged write as the skill, naming it and every file routr wrote), or a
link to such a folder in `~/.agents/skills`. Nothing is written or removed through a link inside a skill folder. One
exception, for folders an older routr wrote before manifests existed: a `routr` folder with no manifest is taken for
routr's when it holds the files that routr wrote then and its `SKILL.md` frontmatter names the skill; never below a linked
folder (a folder above one may be a link, as with dotfiles, but such a folder below a link is never adopted), and
never where any manifest exists. Install leaves routr's folder as it is while it holds a file routr did not write,
and says so; uninstall removes only the listed files and reports the rest. Known limit: routr trusts its manifest,
so one you copy into another folder makes routr treat that folder as its own.

## What routr writes

The binary is self-contained: the files under `skills/` are embedded at build time, and it does not depend on a
repository checkout at run time. It reads your harness state read-only (usage sources, settings, model lists) and
writes only:

- under `~/.config/routr`, `~/.cache/routr`, `~/.local/share/routr` (headless workers' worktrees in its `worktrees`)
  and `~/.local/state/routr` (headless workers);
- in your repository's git metadata, the worktree and branch a headless `launch --worktree` adds;
- its own binary, when it updates itself;
- the skill folders, on `skill install` (and the updater's reinstall);
- a file at a path you name for that command (`share --out`, a `--ledger` or `--config` you give);
- the files `launch --copy` copies into a worker's worktree (which `cleanup` removes again only while they are
  unchanged);
- temporary files it removes: the private herdr session `usage cursor` makes, the empty Kiro session `usage kiro`
  deletes again, and the private folder each Claude `/usage` read runs in, with the empty `~/.claude/projects` folder
  Claude makes for it, removed after a normal exit (a timed-out read can leave that one empty folder).

One exception: `uninstall` removes the `statusLine` entry an earlier routr's `setup` set in `~/.claude/settings.json`,
after a backup, and only when it runs `routr statusline`.

## Processes and platforms

routr runs on macOS, Linux and Windows. It starts every process directly, never through `sh`, and with no Unix-only
paths. The binary does not load a `.env` or `bunfig.toml` from the folder you run it in, so routr does not use a
project's `.env` itself or pass it to the harness commands it runs (sign-in status and usage reads). Variables already
in its environment, exported in your shell, still reach them. A worker that `routr launch` starts runs in its pane's
own shell, which loads what that shell is set up to load. Every process it starts goes through one place, which hides
its console on Windows, gives harness reads an environment without herdr's pane variables, and on Windows resolves a
command as the shell would, starting an npm `.cmd` shim's script directly. In a pane, routr types commands for that
pane's own shell (POSIX `sh`, PowerShell or cmd), as you would. Follow-up commands have exact `argv` and a
common-shell `command` only for the documented safe alphabet and an unquoted, non-assignment executable; otherwise
`command` is null. Instructions and templates are marked `kind: "do"`, never runnable.
Unsafe template values become placeholders for the lead to fill, never expanding shell text. Execution history stays
display only, with prompt lengths instead of prompt text.

## Headless workers

Outside herdr, `routr launch --kind claude`, `codex` or `agy` starts the worker headless: Claude Code's own `-p`
stream-json mode, Codex's app-server, or Antigravity's `--print` stream-json mode, on your sign-in, held by one routr process of its own (its holder). Other
harnesses, `--pane` and `--direction` are refused outside herdr. What that means on your machine:

- **Its worktree.** With `--worktree <branch>`, launch makes the worktree with git (`git worktree add -b`), under
  `~/.local/share/routr/worktrees/<repository>-<hash>/<branch>` (`/` and `\` in the branch become `-`), on a branch
  that must not exist yet, from `--base` or the checkout's HEAD, and copies the `--copy` files and folders in from
  `--cwd`, never through a link and never over a file the worktree has. When no holder could have started, launch
  removes the copies, the worktree (through cleanup's checks) and its branch while that still points at the commit it
  started on, as it does the run folder; what it cannot remove is a warning. When git did not make the worktree, a
  branch of that name is left alone and said: it may be another command's. When it keeps the run folder (the holder
  is starting or does not answer), it keeps the worktree too. `cleanup --worker` removes the worktree with the checks
  of `cleanup --worktree`, through git, and only while it is still the folder launch made, on the branch launch
  made: a worktree removed and made again at that path, or a folder there that git does not list as a worktree, is
  kept, with the worker's record. A copy taken from a subfolder `--cwd` is compared with the main checkout's file at
  the same path, so cleanup may keep it as the worker's. It cannot see a command the worker started that left
  the harness's process group or detached itself (on Windows, anything once the harness has ended), and removes the
  worktree anyway: it says so in `warnings`.
- **Where it lives.** Each worker has a run folder, `~/.local/state/routr/workers/<name>`: the worker's settings
  (kind, model, effort, folder; never the brief or the environment), the holder's state (turns, their outcomes, the
  last tool's fixed name, the session id), a random secret, one file per holder generation, which turns `wait` has
  reported, and each turn's report. On macOS and Linux the folder is made 0700, and the secret, the settings and the
  reports 0600 (checked by the tests). On Windows it takes the access your home folder gives; routr sets and checks no
  access rules there, and access from another account is not measured. The channel's socket is in
  `~/.local/state/routr/s`. A name is taken by making its folder; launch refuses a name whose folder exists until
  `cleanup --worker` removes it.
- **The brief and your messages** go from launch or send to the holder over the channel, and from the holder to the
  harness on its standard input (Claude and Antigravity: a stream-json message; Codex: the app-server's `turn/start`
  and `turn/steer` requests): never in a process's arguments. routr keeps no copy of them. What it keeps of the worker's text is each
  turn's report: the harness's final message of that turn (Codex: its final answer; Antigravity: its turn's
  response), as it wrote it (cut at 1 MB),
  which can quote the brief or anything else the worker saw. Reports stay, owner-only on macOS and Linux, until `cleanup
  --worker` removes the run folder; commands print their paths, never their text, and they never reach the ledger or
  telemetry. The harness keeps its own session history as it always does. Its error output is not read. A tool is shown
  by its name only when it is one of the harness's own (Claude's tools, Codex's item types, Antigravity's tools); an MCP server's tool is
  `mcp` and any other `other`.
- **Codex's permissions.** Codex runs with `approvalPolicy: "never"` and `sandbox: "danger-full-access"`, what
  `--yolo` is in a pane. Unlike a pane, a hook you have not trusted in Codex does not run: its app-server skips it,
  silently (measured). A request Codex makes of routr (an approval, a question, a tool call) is answered with a
  JSON-RPC error, which declines it; none came in the measured runs, so what Codex does after a decline is shown only
  with a stand-in app-server in the tests. A message Codex was handed and did not answer before it ended is reported
  as not known, and never sent again on its own.
- **The channel.** Both sides prove the run's secret before any text crosses. On macOS and Linux it is a Unix socket
  in an owner-only folder; a home whose socket path would exceed the system's limit (103 bytes on macOS, 107 on
  Linux) is refused before launch writes anything. On Windows it is a named pipe, and Windows' default security lets
  other local users and anonymous logons open it for reading: the handshake is what keeps them out (measured: a reader
  got only a fixed error), not the pipe's permissions. Not tested: another local account, a remote client.
- **What it starts.** The holder starts the harness (`claude`, `codex app-server`, or `agy --print`) in its own process group
  (POSIX), in the worker's folder (its worktree, or `--cwd`), with herdr's and the lead's session variables removed,
  and records that group before the task goes in. It exits once the harness has. On macOS and Linux, `stop` sends
  SIGTERM to that group, then SIGKILL to the group two seconds later if the harness itself has not exited, and waits
  up to six seconds for it. Claude ends its tool commands, which run in groups of their own, on SIGTERM; they can
  survive a SIGKILL of Claude, and routr cannot see those (measured). How Codex's and Antigravity's commands take SIGTERM and SIGKILL
  is not measured. Once the harness has gone, anything still in its group is not signalled again (its id may be
  another group's by then): stop says `still_exiting`, and the group stays recorded, so resuming and cleanup refuse
  until it is empty. On Windows it runs `taskkill /T /F` on the harness, or ends the harness alone if that fails. A
  command that detaches itself is not seen. Limit: once a recorded group has emptied, an unrelated process group
  given the same id later blocks that worker's resume and cleanup until it ends.
- **What it cannot see.** If the holder itself is killed, its Claude keeps working until its next output fails
  (measured on macOS); on Windows the measured stand-in harness ended with its holder, and a real Claude has not been
  measured there. What a Codex app-server or Antigravity does when its holder dies, mid-turn or not, is not measured. On macOS and
  Linux, routr then reports the worker `lost`, and names the process group it recorded while that group still has
  members, as it does when a tool command outlives the harness. Either way it refuses to resume or remove the worker
  until that group is empty, and it never stops a process by a saved id. A lead started inside an SSH session on
  Windows loses its workers when that session ends (sshd's job object closes every process in the session;
  measured). On Linux, a worker outlived an SSH logout with Ubuntu's defaults; with logind's `KillUserProcesses=yes`
  it would not (not measured).
- **Sandboxes.** A lead's sandbox carries over to what it starts. launch refuses when it can see one (Claude Code's
  Bash sandbox, Codex's), and so does a send that must start a new holder; a send to a running worker goes over its
  channel as usual. `wait`, `workers` and `stop` say when they run inside one, since it may hide a worker's channel.
- **Sign-in.** launch and a send that starts a new holder check the harness's sign-in first, as every launch does.

## Secrets, briefs and telemetry

A brief goes only to the decision models in your chosen list (or the one-call override) until one answers, and to
the worker it is for. A key goes only to its own provider. routr never prints or logs either, and never puts them in
the ledger or in telemetry: the ledger stores a brief's hash and length. Keys are kept only in routr's secrets file,
`~/.config/routr/env`, written by `routr key set`. The one worker text routr stores is a headless worker's reports,
which can quote its brief ("Headless workers", above).

The list keeps hosted choices in order and tries local Ollama choices last, because they may need to load. Hosted
attempts have an 8-second cut inside one overall deadline: 10 seconds for hosted-only lists, 30 seconds with local.
A timeout, unreachable provider, provider error, daily allowance, absent key, missing local model or unsupported
local runtime moves on. A refused key, unreadable reply, unreadable secrets file or internal error stops. Only when
none answers does advice use the user's fallback level. Each answering model keeps its own measured profile.
Doctor tests every entry independently and says which are ready; storing a provider key changes no decision list.

Decision-provider failures are classified into fixed sentences with an action to take; response bodies and envelope
messages never supply their wording. Answers are checked against the questions' choices and numeric ranges before
use; an unreadable or out-of-range reply makes advice fall back. Only checked answer fields and a model identity
accepted by its provider (otherwise the requested identity) reach advice or the ledger, so a reply repeating a brief
or key cannot pass through as text. Ollama's version and build digest must match their declared formats before display.

Telemetry is off unless you turn it on (`routr telemetry on`, or yes to setup's question, default no). An agent never
turns it on for you. It sends ledger rows with no text of any kind, only from the detached daily job or
`routr telemetry send`, and stays off under `ROUTR_TELEMETRY=0`, `DO_NOT_TRACK=1`, or CI. What is sent:
[telemetry.md](telemetry.md). `routr feedback` is the only text sent, and only what you typed.

## Output a lead reads

`subagent`, `dispatch`, `check`, `launch`, `record`, `cleanup`, `wait`, `send`, `workers`, `stop` and `usage` always start with `ok`, `headline`,
`unavailable`, `warnings` and `next`. Follow `next` for instructions. An `error` marks refused inputs or a stopped
command; an expected outcome such as a worker needing input has `ok: false` without `error`. Missing required
inputs are refused even by commands that exit 0: check needs `--brief` and `--report`; record needs `--subscription`,
`--model`, `--effort`, `--verdict` and `--check`.

Launch and record share one usable-advice check before comparing the task, reading a report or writing a row:
a JSON object with nonempty `id` and `brief_sha`, without `ok: false` or any `error` field. Older advice without
`ok` remains usable. A saved refusal is refused. Every launch record template carries an explicit effort. Launch dry runs
also refuse a missing model while printing their plan. Failed launches that sent no task offer a blocked record, not a worker-result verification step.

Herdr and git failures are classified into fixed codes and routr's own sentences. Structured herdr state, rule,
rules version, kind, folder and readiness are checked before use. An absent explain state adds no disagreement.
A missing herdr executable says so and supplies an installation/PATH step; a failed git ref read is reported as
unreadable, not as a commit no ref holds. Arbitrary process text appears only in `screen`
before the task was sent; after submission `screen` is a fixed withheld sentence. Process names are counted, never
printed. These diagnostics never enter the ledger or telemetry.
