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

They fail open: any error still prints usable output and exits 0.

`record`, `setup`, `uninstall`, `key set`, `skill install`, `share`, `update`, `telemetry on|off|send`, `feedback`,
`launch`, `cleanup`, `usage cursor`, and `usage kiro` act, and each says what it did. Their read-only forms
(`telemetry status`, `setup --show`) only read.

- `launch` drives panes in your herdr session.
- `cleanup` removes a worker's worktree (through herdr, or git when no workspace is open) or closes its pane. It
  refuses while anything it can see runs there or when it cannot tell, never uses `--force`, and refuses a worktree
  holding uncommitted changes, files git is told not to check, a commit no branch or tag holds, or untracked files
  the main checkout does not hold as they are. An untracked file identical to the main checkout's is taken for one
  `launch --copy` brought in and goes with the worktree, as ignored files do (as with `git worktree remove`). It
  deletes a branch only when asked and `git branch -d` agrees it is merged. Limit: neither herdr nor git can remove
  only if unchanged, so a commit made, or a worker started, after cleanup's last check is not seen.
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

- under `~/.config/routr`, `~/.cache/routr` and `~/.local/share/routr`;
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
paths. Every process it starts goes through one place, which hides its console on Windows, gives harness reads an
environment without herdr's pane variables, and on Windows resolves a command as the shell would, starting an npm
`.cmd` shim's script directly. In a pane, routr types commands for that pane's own shell (POSIX `sh`, PowerShell or
cmd), as you would.

## Secrets, briefs and telemetry

A brief goes only to the decision model you chose and to the worker it is for, and a key only to its own provider. routr never prints or logs
either, and never puts them in the ledger or in telemetry: the ledger stores a brief's hash and length. Keys are kept
only in routr's secrets file, `~/.config/routr/env`, written by `routr key set`.

Known gap, being fixed: text in a decision model's reply is not yet checked before routr uses it. When a request
fails, part of the provider's reply can appear in routr's output; a successful reply's values can appear in the advice,
and in the ledger once that advice is recorded (telemetry strips them). A reply may repeat what it was sent.

Telemetry is off unless you turn it on (`routr telemetry on`, or yes to setup's question, default no). An agent never
turns it on for you. It sends ledger rows with no text of any kind, only from the detached daily job or
`routr telemetry send`, and stays off under `ROUTR_TELEMETRY=0`, `DO_NOT_TRACK=1`, or CI. What is sent:
[telemetry.md](telemetry.md). `routr feedback` is the only text sent, and only what you typed.
