# What routr does on your machine

What routr reads, writes, starts and removes, and when. Each of these is a promise, held by tests: a change to one
updates this page and its tests in the same pull request.

## Commands that advise, and commands that act

The advice commands (`subagent`, `dispatch`, `check`, `doctor`, `assess`, `usage` with no name) write nothing of
yours (`doctor --fix` is `setup` under another name); the only thing they may start is one of routr's detached
background jobs below (the updater, Cursor's and Kiro's usage refresh), which write only under `~/.cache/routr`. They
fail open: any error still prints usable output and exits 0.

Only `record`, `setup`, `uninstall`, `key set`, `skill install`, `share`, `update`, `telemetry on|off|send`,
`feedback`, `launch`, `cleanup`, `usage cursor`, and `usage kiro` act, and each says so.

- `launch` drives panes in your herdr session.
- `cleanup` removes a worker's worktree (through herdr, or git when no workspace is open) or closes its pane, never
  while anything runs there or it cannot tell, never with `--force`, and never one holding uncommitted changes, files
  the worker made, files git is told not to check, or a commit no branch or tag holds (ignored files go with it, as
  with `git worktree remove`). It deletes a branch only when asked and `git branch -d` agrees it is merged.
- `usage cursor` drives only a private headless herdr session it makes and removes, never your own, and keeps the
  reading in `~/.cache/routr`.
- `usage kiro` runs Kiro's own `/usage` in the system temp folder, deletes the empty session that leaves with Kiro's
  own `--delete-session`, and keeps the reading in `~/.cache/routr`.

## Updates

Updates are automatic but never in the way: at most once a day a command may start a detached updater and carry on.
The command itself does not wait for it, make a network call for it, or change its own output because of it. The
updater verifies the release checksum, swaps the binary in place, and reinstalls the skill; a run in progress keeps
its binary. It follows your `update_channel` (stable, or beta: also `-beta.N` and `-rc.N`, never alpha) and never
downgrades by itself. `"auto_update": false` turns it off. It never runs from a source checkout or from `statusline`.

## Usage readings

Every call reads each usage source's newest reading and shows its age. routr never has to own a harness feature (a
statusline slot, a hook) to get its usage: it asks the harness's own CLI.

- Claude's is read in the call from its own `/usage`, hooks and MCP servers off; a statusline snapshot under 5 minutes
  old is used instead when one exists.
- Claude, Codex and Antigravity are read in the call (1 to 9 s, beside the decision model).
- Cursor's own screen takes seconds more and starts Cursor, and Kiro's `/usage` takes about 10 s plus its cleanup, so
  their readings are snapshots: when the last try is over 4 hours old, a call starts a detached `routr usage cursor`
  (or `kiro`) to refresh it and carries on, as it does for the updater (unlike the updater, also from a source
  checkout: it swaps nothing).

How usage is ranked: [ranking.md](ranking.md). A reserve is never offered.

## Signed in, not just installed

A harness is used only once its own status command says it is signed in. One that is not gets no model list, no usage
read, no refresh, and no launch, because asking it anything else can open its sign-in in your browser. routr never
starts a harness's sign-in; it says what to run.

## Skills: what install and uninstall touch

`skills/` holds exactly what is installed for agents (the `routr` skill with its guides, and the user-invoked
`routr-orchestrate`) and no code. Every skill is installed the same way: written to `~/.agents/skills` and linked into
each harness's own skills folder.

Install and uninstall touch only what is provably routr's, by structure, never by reading a skill's text: a folder
holding routr's manifest `.routr-install.json` (written in the same staged write as the skill, naming it and every file
routr wrote), or a link to such a folder in `~/.agents/skills`. Nothing is written or removed through a link inside a
skill folder. A folder above one may be a link (dotfiles), but a pre-manifest `routr` folder below a link is never
adopted. Install leaves routr's folder as it is while it holds a file routr did not write, and says so; uninstall
removes only the listed files and reports the rest. Known limit: routr trusts its manifest, so one you copy into
another folder makes routr treat that folder as its own.

## What routr writes

The binary is self-contained: the files under `skills/` are embedded at build time, and it does not depend on a
repository checkout at run time. It reads your harness state read-only (usage sources, settings, model lists) and
writes only:

- under `~/.config/routr`, `~/.cache/routr` and `~/.local/share/routr`;
- the skill folders, on `skill install`;
- the files `launch --copy` copies into a worker's worktree (which `cleanup` removes again only while they are
  unchanged);
- temporary files it removes: the private herdr session `usage cursor` makes, the empty Kiro session `usage kiro`
  deletes again, and the private folder each Claude `/usage` read runs in, with the empty `~/.claude/projects` folder
  Claude makes for it, removed after a normal exit (a timed-out read can leave that one empty folder).

One exception: `uninstall` removes the `statusLine` entry an earlier routr's `setup` set in `~/.claude/settings.json`,
after a backup, and only when it runs `routr statusline`.

## Processes and platforms

routr runs on macOS, Linux and Windows with no shelling out to `sh` and no Unix-only paths. Every process it starts
directly goes through one place, which hides its console on Windows, gives harness reads an environment without
herdr's pane variables, and on Windows resolves a command as the shell would, starting an npm `.cmd` shim's script
directly.

## Secrets, briefs and telemetry

routr never prints, logs, or stores a secret or the text of a brief. The ledger stores a hash and a length.

Telemetry is off unless you turn it on (`routr telemetry on`, or yes to setup's question, default no). An agent never
turns it on for you. It sends ledger rows with no text of any kind, only from the detached daily job or
`routr telemetry send`, and stays off under `ROUTR_TELEMETRY=0`, `DO_NOT_TRACK=1`, or CI. What is sent:
[telemetry.md](telemetry.md). `routr feedback` is the only text sent, and only what you typed.
