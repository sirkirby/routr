# Launching each harness unattended

Workers run with permissive settings because nobody watches their panes; you, the orchestrator, are the check.
Flags change between releases: before relying on one, run the harness's `--help`. The launch column was *measured*
through `herdr agent start <name> --kind <kind> --pane <id> -- <flags>` (interactive sessions, 2026-09-20: each
worker edited two files, ran a command, and reported). The last column was *measured* in earlier headless evals.

| Harness (`--kind`) | Permissive launch | What goes wrong (*measured*) |
|---|---|---|
| Claude Code (`claude`) | `--dangerously-skip-permissions` (measured). Model and effort: `--model <alias or id> --effort <level>`; `claude --help` names the current aliases (fable, opus, sonnet on 2.1.283) and routr reads them from there, and the same help says `--model` also takes a model's full name (e.g. `claude-fable-5`; not measured by routr), so routr accepts an id Claude does not list | **Folder-trust dialog** in any directory that is not under a trusted one; default answer is "No, exit"; herdr reports `agent_not_ready`, then `blocked`. Its wording changes between releases (2.1.284, 2026-09-28: unnumbered options, "No, exit" first). A git worktree counts as its main repository (measured 2.1.284, 2026-09-28: a worktree in `~/.herdr/worktrees` of a repository under a trusted folder was not asked), so once the user has trusted the repository in Claude, no worker in its worktrees is asked. Headless without a permission mode **silently refuses edits** and exits 0. `--allowedTools` does not restrict anything when the user's default mode is bypass. Quits on Ctrl+C twice. Twice (2026-09-26, v2.1.283): herdr answered a prompt with `agent_prompt_stalled` while Claude sat idle with an empty input line and the prompt nowhere on screen; `routr launch` no longer resends (see the rule on prompts below): it reports `needs_input`. |
| Codex (`codex`) | `--yolo -c check_for_update_on_startup=false` (`--yolo` measured: full permissions, the user's choice for worker panes; the update check off because on 2026-09-28 Codex showed "Update available" just after herdr reported it ready, and the Enter that submitted a worker's task chose "Update now": Codex upgraded itself through Homebrew and exited). Scoped alternative, also measured: `-s workspace-write -a never -c sandbox_workspace_write.network_access=true`. Model and effort: `-m <model> -c model_reasoning_effort=<effort>`; list with `codex debug models` | No folder-trust dialog with `--yolo` (measured 0.157.1 in a new git folder, 2026-09-28; earlier versions asked, and herdr reported that as `idle`). Without network access routr answers with its fallback. `codex exec` hangs unless stdin is `< /dev/null`. While its MCP servers start, herdr already reports it `idle`; a task sent then is held (`› [Pasted Content 3102 chars]` above `Waiting for startup`) and Codex starts it by itself once ready (2026-09-28, twice). herdr calls that prompt stalled; `routr launch` waits on the agent's state and sends nothing again. |
| Cursor (`cursor`) | `--yolo --trust` (measured: no dialog; `--yolo` is `--force`). Model: `--model <id>`; list with `cursor-agent models` | `--model` **persists as the account default**. Measured way around it: launch with `CURSOR_CONFIG_DIR=<a folder holding a copy of ~/.cursor/cli-config.json>` (via `herdr pane run`; herdr still recognises the agent, address it by pane id); the account default stayed unchanged. On Windows herdr does not see an agent a shell started, so `routr launch` sets the variable in the pane's PowerShell (or cmd) and lets `herdr agent start` run Cursor (measured on Windows 11: tracked, prompted, and the private folder removed when the pane closed). Its reported usage omits subagent tokens. Whatever `CURSOR_CONFIG_DIR` says, it writes its runtime files (`worker.log`, `worker.sock`) under `~/.cursor/projects/<the working folder>` (measured 2026-09-25); routr's usage read always works in the system temp folder, so that is one folder, reused. Subagents: Cursor's own models only. Twice (2026-09-26, with a 2.4k-character task): herdr answered the prompt with `agent_prompt_stalled` while the task sat pasted and unsent in the input box (`→ [Pasted text #1 +21 lines]`); Enter sent it. `routr launch` no longer presses keys on what the screen shows (see the rule on prompts below): it reports `needs_input`, and Enter in the pane is the fix. Does not quit on Ctrl+C: close the pane. |
| Antigravity (`agy`) | `--dangerously-skip-permissions --add-dir <dir>` (measured: worked in the given directory, no dialog). Model: `--model <id>` ALONE: its model ids already carry the effort (`…-low|-medium|-high`). Adding an `--effort` that disagrees with the id is refused (agy 1.2.11, 2026-09-26: `invalid model selection … conflicts with --effort=high`, exit 1; earlier versions warned and ran the HIGH variant); a family id with `--effort` resolves to that variant (`gemini-3.8-flash --effort low` ran `gemini-3.8-flash-low`), so routr passes the full id and no `--effort`. `--add-dir` takes an absolute path only. List with `agy models` | **Does not see `~/.agents/skills`**: it needs the worker guide's file path in the prompt. It loads skills from `~/.gemini/config/skills` (measured 2026-10-05, agy 1.2.17; not the `~/.gemini/antigravity-cli/skills` its web docs name), and routr links its skills there: see "Where routr's skills go" below. Giving the guide's path in the prompt still works, so keep doing it. herdr can report it `idle` while it is still working: wait for the VERDICT line. Headless runs auto-deny shell commands and still report SUCCESS. With no `--add-dir`/`--project` it ignores the current directory. |
| Kiro (`kiro`) | `chat --trust-tools=*` (measured, Kiro CLI 2.24.1, 2026-09-28: no confirmation and no folder-trust dialog). Model: `--model <id>`; list with `kiro-cli chat --list-models`. `auto` is Kiro's own router (its docs recommend it; the footer shows `auto`, measured). Effort: `--effort <level>` on the models whose `/effort` panel offers levels (Kiro's docs: the newer Claude and GPT models); `auto` and the other models show "n/a" and ignore the flag silently (measured). `routr launch --effort auto` passes no flag | `--trust-all-tools` **asks "Kiro is running in trust all tools mode" at every start**, with "No, exit" selected, while herdr reports it idle (its rules do not recognise that screen, 2026-09-28). `--trust-tools=*` allows every built-in tool (its `/tools` list: all 14 "allowed") and asks nothing (measured 2026-09-28; MCP tools not measured), so `routr launch` passes that. **An unknown `--model` id runs the default silently**: the footer (`kiro_default · <model> · ◔ 5%`) then shows no model (2026-09-26). `routr launch` checks the id against `kiro-cli chat --list-models` before it opens a pane. Headless (`--no-interactive`) ignores `--model` altogether ("failed to set model … Method not found"). **An explicit `--effort` is remembered as the user's default for that model** in `~/.kiro/settings/cli.json` (Kiro's docs; not measured: no model on the measured account took effort). The confirmation can be turned off only globally, with the setting `chat.disableTrustAllConfirmation` (listed by `kiro-cli settings list --all`; not on Kiro's public settings page); there is no per-launch flag. Reads skills only from `~/.kiro/skills`, not `~/.agents/skills` (routr links its skills there). Quits with `/quit`. |

`routr launch` encodes this table: it applies the permissive flags, the model and effort syntax, and the
work-arounds below for the harness you name, so an ordinary launch needs none of this detail. Read here when you are
choosing a model, when a launch does something you did not expect, or when you are launching by hand. `routr launch
--kind <k> --model <m> --dry-run` prints the exact flags it would use, and costs nothing.

## Is it signed in? (measured 2026-09-26, signed in and signed out)

routr asks each harness before anything else, and one that is not signed in gets no work (dispatch, launch) and cannot
be added or turned on in setup, which lists it with the command to sign in.
These commands never start a sign-in. The ones they replace can: Antigravity's `-p /usage` starts Google's sign-in and
waits for a code, and any Kiro `chat` command opens Kiro's.

| Harness | Check | Signed out | To sign in |
|---|---|---|---|
| Claude Code | `claude auth status` | `"loggedIn": false`, exit 1 | `claude auth login` |
| Codex | `codex login status` | `Not logged in` on stderr, exit 1 | `codex login` |
| Cursor | `cursor-agent status` | `Not logged in`, **exit 0**: read the text | `cursor-agent login` |
| Antigravity | `agy models` (it has no status command) | `Please sign in to view available models`, exit 1 | run `agy` and sign in |
| Kiro | `kiro-cli whoami --format json` | `{"account":null}`, exit 1 | `kiro-cli login` |

Each takes 0.3 to 3.4 s. The answer is kept in `~/.cache/routr/signed-in.json` (signed in: 6 hours; not: 10 minutes),
so a dispatch rarely pays for it; doctor and setup always ask again.

**Windows, npm installs (measured on GitHub's windows-latest, 2026-10-05, Bun 1.4.2).** A harness CLI installed with
npm is a `.cmd` shim (`%APPDATA%\npm\codex.cmd`). Started without a shell, as routr starts everything, it failed by
bare name and by full path alike, so its sign-in check never answered and the harness was never used. routr now
resolves each command through PATH and PATHEXT as cmd would, starts npm's own shim as `node <its script>` directly,
and runs any other `.cmd` through `cmd.exe /d /s /c` with each argument escaped for cmd; arguments with spaces, quotes,
`% & ^ | < > ( ) !` and Claude's `{"disableAllHooks":true}` arrive intact (CI test, from `bun test` and from a compiled
binary), and a timeout stops the CLI under cmd.exe too (`taskkill /T`). Not yet run against a real npm install of any
harness. A native `.exe` install starts as before.

## Rules that hold for every harness

0. **Read a new pane before typing into it.** The user's shell may ask its own question first (measured: a dotenv
   plugin asking "found '.env' file. Source it?" swallowed the launch command). routr knows no plugin by name: it
   waits for a settled shell prompt and returns any question with the screen (`needs_input`). The lasting fix is the
   user's: herdr sets `HERDR_ENV=1` in every pane, so a shell can skip its startup questions there (for the dotenv
   plugin, its own `ZSH_DOTENV_PROMPT=false`, set in `~/.zshrc` when `HERDR_ENV` is set). The standard signal for
   "the shell is at its prompt" is the shell's own prompt marks (OSC 133); herdr parses them but does not expose them
   yet. A launch that came up wrong (wrong model, wrong folder) cannot be
   repaired: close that pane and start a fresh one.

1. **Send a prompt once.** `herdr agent start` returns when the agent is ready; if it returns `agent_not_ready`, read
   the pane and wait for idle before prompting. A prompt herdr calls stalled or timed out may still have arrived
   (herdr's own rule; Codex holds one until it has finished starting, measured 2026-09-28): wait with `herdr agent wait
   <agent> --until working --until blocked`, then read the pane, and never send it a second time. Screen patterns for
   the state of an input box break with each harness release; herdr's lifecycle state is what `routr launch` relies on.
2. Verify outcomes yourself; status fields and exit codes lie (see the table).
3. Read usage and the models actually used from transcripts or session files, not from the agent's own account.
4. Before a batch, launch one unit and watch its first minutes. A batch nobody watched once burned its budget on
   invalid runs.
5. Where the harness offers a budget cap per run, set one.
6. One worktree per worker that writes. Keep a worker's directory away from repositories whose hooks should not fire.

## Where routr's skills go, and `/routr-orchestrate` (vendors' docs, and measured 2026-10-05 where marked)

`routr skill install` installs both of routr's skills the same way: `routr`, and `routr-orchestrate` (the user types
`/routr-orchestrate <plan>` to make a session the orchestrator). Each is written once to `~/.agents/skills/<name>` and
linked (copied on Windows) into each harness's own skills folder, the registry's `skills`, when the folder above it
exists. It writes, replaces and removes only routr's own, known by structure, never by a skill's text: a folder holding
routr's manifest `.routr-install.json` (the skill's name, routr's version, and every file routr wrote there, written
with the skill in one staged step), or a link to such a folder in `~/.agents/skills`. A `routr` folder from before
manifests (with its guides, and no manifest of any kind) counts once and gets one at the next install, unless a folder
above it is a link (`~/.agents/skills` linked into a checkout, say): there it is never adopted. A linked folder above
is otherwise fine (`~/.claude` in a dotfiles repo): routr's folder is known by its manifest wherever it lives. A skill of the
same name the user put there, or a link of theirs (into a checkout, say), is kept, never followed, and named in the
output; nothing is written or removed through a link inside a skill folder. While routr's folder holds a file routr did
not write, `routr skill install` leaves it as it is and says what to remove (doctor too); uninstall removes only the
files the manifest lists and reports the rest. Known limit: routr trusts its manifest, so one the user copies into
another folder makes routr treat that folder as its own. One canonical copy, linked into each agent's folder with its frontmatter unchanged, is the layout the `skills`
npm CLI uses. `routr-orchestrate` should run only when the user types it. Where a harness documents a field for that,
the skill carries it; elsewhere its description ("Use ONLY when the user explicitly invokes /routr-orchestrate …") is
the only guard. routr adds none in the text. The pair of `disable-model-invocation: true` in `SKILL.md` and Codex's
`agents/openai.yaml` policy is the widely used community layout (for example the skills installed at
`~/.agents/skills/*/agents/openai.yaml`).

| Harness | Skills folder | Typed as | Kept from the model by |
|---|---|---|---|
| Claude Code | `~/.claude/skills` (linked) | `/routr-orchestrate <plan>`, `$ARGUMENTS` filled in | documented field: `disable-model-invocation: true` ("prevent Claude from automatically loading this skill", https://code.claude.com/docs/en/skills) |
| Codex | `~/.agents/skills` (it reads the shared folder) | `$routr-orchestrate <plan>` | documented field: `agents/openai.yaml`, `policy: allow_implicit_invocation: false` (explicit `$name` still works, https://learn.chatgpt.com/docs/build-skills) |
| Cursor | `~/.agents/skills` (it also reads `~/.cursor/skills`) | `/routr-orchestrate <plan>` | documented field: `disable-model-invocation: true` (https://cursor.com/docs/context/skills; the page describes the editor, not `cursor-agent`) |
| Kiro | `~/.kiro/skills` (linked; it reads no other, measured) | `/routr-orchestrate <plan>`; `$ARGUMENTS` "currently CLI-only" (https://kiro.dev/docs/skills/) | description only: its docs name no field that keeps the model from choosing a skill |
| Antigravity | `~/.gemini/config/skills` (linked when `~/.gemini/config` exists). Measured, see below | `/routr-orchestrate` (its docs: a skill becomes a slash command in the TUI) | its docs list only `name` and `description` (https://antigravity.google/docs/skills), but measured: agy 1.2.17 left `routr-orchestrate` out of its model's skill list (undocumented, so it may change) |

Antigravity's folder, measured 2026-10-05 on agy 1.2.17: asked (in `agy -p`) to list the skills available to it, it
named a probe skill placed in `~/.gemini/config/skills` and none of those linked into `~/.gemini/antigravity-cli/skills`,
the folder its web docs name (https://antigravity.google/docs/skills), or `~/.agents/skills` (its docs: only a
workspace's `.agents/skills`). The customizations guide bundled with agy and its binary also name
`~/.gemini/config/skills`. routr links its skills there.

Model visibility, measured the same day by asking each harness (print mode, no tools) to list the skills available to
it, with both skills installed: `routr-orchestrate` was absent from Claude Code's, Codex's and Cursor's (`cursor-agent`)
lists and present in Kiro's, as the guards above say; Antigravity (once linked into `~/.gemini/config/skills`) listed
`routr` and not `routr-orchestrate`, so it honours `disable-model-invocation` without documenting it. `routr` was present
in every list. Matt Pocock's user-only
skills behaved the same way (absent from Codex's list, present in Kiro's).

Where `/routr-orchestrate` is missing, the user can say the same in a prompt: "You're an orchestrator; use routr to
manage the following work: …".

## Usage shapes (measured unless marked claimed)

routr classes each pool from the shape of what the harness reports, never from a plan name.

| Seat | What the harness reports | Class |
|---|---|---|
| Codex on a subscription (Pro login, 2026-09-22, CLI 0.155.1) | `primary` weekly window with `usedPercent`, `secondary` null, `credits.hasCredits: false` | `included` |
| Codex on a ChatGPT Enterprise seat with flexible pricing (2026-09-22, CLI 0.155.1) | `primary` and `secondary` **null**, `credits: { hasCredits: true, unlimited: true }`, `individualLimit: null`, `planType: "business"` on an Enterprise contract | `metered` |
| Codex with a member credit limit set by the workspace owner (claimed: the protocol's `individualLimit { limit, used, remainingPercent, resetsAt }`, not yet read from a seat) | the cap as one more window, its period from `resetsAt` | `capped` |
| Claude Code on Pro, Max or Team (measured: Max 2026-10-05, Team 2026-10-07) | `/usage`: "Current session" and "Current week (all models)" (read as `five_hour` and `seven_day`); statusline `rate_limits.five_hour` and `seven_day` | `included` |
| Claude Code on seat-based Enterprise (not observed) | unknown until measured; a Team seat's `/usage` matched Max's line for line, so the same lines are expected | `included` if windows arrive; otherwise `unknown`, and the user sets `billing` |
| Claude Code on usage-based Enterprise, or on an API key (claimed: the docs say `rate_limits` is sent only for plans with a quota; what `/usage` prints there is not observed) | no `rate_limits` at all, even after a response; `/usage` lines unknown | `unknown` with a note; the user sets `billing: "metered"`. Absence is not read as "no quota" because a seat-based plan routr has not seen may also send none |
| Claude Code behind a Claude apps gateway with spend limits (claimed: docs) | `rate_limits.spend_limit`, `used_percentage` may pass 100 | `capped` |
| Kiro on a Free plan (measured 2026-09-26, Kiro CLI 2.24.1) | `/usage`: "Estimated Usage \| resets on 2026-10-01 \| KIRO FREE", "Credits (0.00 of 50 covered in plan), 0.0%": one monthly pool that every model draws on at its own rate. Takes ~10 s and 0 credits, and leaves an empty saved session. The figure is an estimate that lagged a 0.10-credit turn | `included` |
| Kiro on a paid plan with overage on (not observed) | unknown: any line beyond the credits line is kept in the reading's note, never parsed | `included` until measured |

## Claude Code's usage, read through its CLI (measured 2026-10-05, Claude Code 2.1.289, macOS, Max plan)

routr reads Claude's usage the way it reads Antigravity's and Kiro's: through Claude's own command, so it never needs
to own Claude's single statusline slot. The read, run in the system temp folder:

    claude -p /usage --output-format json --no-session-persistence --settings '{"disableAllHooks":true}' --strict-mcp-config

- It answers locally: `"local_command":"usage"`, `num_turns: 0`, `total_cost_usd: 0`. The `result` text:

      You are currently using your subscription to power your Claude Code usage

      Current session: 1% used · resets Oct 5 at 3:59pm (America/Detroit)
      Current week (all models): 90% used · resets Oct 5 at 9:59pm (America/Detroit)
      Current week (Fable): 0% used · resets Oct 5 at 10pm (America/Detroit)

      What's contributing to your limits usage?
      … (a breakdown of local sessions follows)

  routr reads "Current session" as `five_hour` (300 min) and "Current week (all models)" as `seven_day` (10080 min),
  the statusline's names. A week scoped to one model is counted in the note ("plus 1 model-specific weekly limit"),
  never named and never ranked on: routr's advice carries no model names. The first line and the breakdown are not
  read. Reset times seen: "Oct 5 at 4pm", "Oct 5 at 3:59pm", "Oct 5 at 10pm", always with an IANA zone in
  parentheses. No year is shown: routr takes the nearest occurrence (a reset just past stays past, and the window
  rolls over), converts it with the zone's own offset at that time, and leaves a reset unset when it cannot read it,
  when the clock skips that time, or when it is further away than the window plus a day. A time the clock shows twice
  takes the later instant, so a window never rolls over early.
- Hooks: without `--settings '{"disableAllHooks":true}'` the user's SessionStart and SessionEnd hooks ran (seen in
  `--debug-file`); with it none ran, and the user's other settings still applied. `--setting-sources=project` also
  stops them but drops the user's settings (a gateway or env set there), so routr does not use it.
- MCP servers: without `--strict-mcp-config` Claude connected to every MCP server the user has (about ten here, some
  over the network) before answering; with it, none (`--debug-file`).
- Time, wall clock, on a machine with a load average of 9 to 14 from other agents: 6.8 and 7.1 s with hooks and MCP
  servers on (2 reads), 7.1 to 8.8 s with hooks off alone (5), 4.4 to 5.2 s with both off (5, three of them through
  routr's own reader). Claude reports 1.8 to 2.4 s of that (`duration_ms`). Not measured on an idle machine, on Linux,
  or on Windows. None of 18 reads hung; routr gives it 12 s, once.
- The numbers agree with the statusline's: at the same minute, 4% session and 91% week from `/usage`, 4% and 90% in the
  last statusline snapshot (a few minutes older), with identical reset times.
- `--bare` shows no subscription numbers (it skips the keychain): unusable.
- `--no-session-persistence` leaves no session file. Claude still makes an empty `memory` folder in
  `~/.claude/projects/<folder>`, where `<folder>` is the path it ran in with every character but a letter or digit
  turned into `-` (observed: the temp folder `/var/folders/…/T` became `-private-var-folders-…-T`, its real path).
  That naming is Claude's own and may change. So routr runs each read in a fresh private folder it makes under the
  temp folder (`routr-claude-XXXXXX`), and the project folder Claude names after it belongs to that read alone. After
  Claude exits normally routr removes the empty `memory` and project folder (never through a symlink or junction,
  only if empty), then its private folder, as it deletes Kiro's empty session. After a timeout routr has killed Claude
  without waiting, so it leaves the project folder: a timed-out read can leave one empty
  `~/.claude/projects/<slug>/memory` folder. A folder named some other way is not found and left alone. Verified on
  macOS: a plain read leaves the folder, routr's read leaves nothing. Not checked on Linux or Windows.
- A statusline snapshot under 5 minutes old (`routr statusline`, for a user who runs it) is used instead of the read.
  Five minutes is a judgment, not a measurement.
- Windows: routr starts `claude` as it starts every harness CLI, with no shell, hidden, and without herdr's pane
  variables. Claude Code's native installer puts `claude.exe` on PATH, which starts that way; an npm install's
  `claude.cmd` is started as the Windows note under "Is it signed in?" says. The read itself is not run on Windows yet.

Statusline fields routr relies on (when a user runs `routr statusline`), all in the statusline docs (code.claude.com/docs/en/statusline): `rate_limits.*.used_percentage`
and `resets_at` (a window is dropped once `resets_at` passes); `prompt_cache` appears after the session's first API
response (v2.1.251+); `context_window.current_usage` is null before the first API call and after `/compact`. The last
two only tell the reader whether "no windows" came before or after a response, which changes its note, not its class.

