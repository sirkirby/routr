# Launching each harness unattended

Workers run with permissive settings because nobody watches them (a pane, or no screen at all when headless); you,
the orchestrator, are the check.
Flags change between releases: before relying on one, run the harness's `--help`. The launch column was *measured*
through `herdr agent start <name> --kind <kind> --pane <id> -- <flags>` (interactive sessions, 2026-09-20: each
worker edited two files, ran a command, and reported). The last column was *measured* in earlier headless evals.

| Harness (`--kind`) | Permissive launch | What goes wrong (*measured*) |
|---|---|---|
| Claude Code (`claude`) | `--dangerously-skip-permissions` (measured). Model and effort: `--model <alias or id> --effort <level>`; `claude --help` names the current aliases (fable, opus, sonnet on 2.1.283) and routr reads them from there, and the same help says `--model` also takes a model's full name (e.g. `claude-fable-5`; not measured by routr), so routr accepts an id Claude does not list | **Folder-trust dialog** in any directory that is not under a trusted one; default answer is "No, exit"; herdr reports `agent_not_ready`, then `blocked`. Its wording changes between releases (2.1.284, 2026-09-28: unnumbered options, "No, exit" first). A git worktree counts as its main repository (measured 2.1.284, 2026-09-28: a worktree in `~/.herdr/worktrees` of a repository under a trusted folder was not asked), so once the user has trusted the repository in Claude, no worker in its worktrees is asked. Headless without a permission mode **silently refuses edits** and exits 0. `--allowedTools` does not restrict anything when the user's default mode is bypass. Quits on Ctrl+C twice. Twice (2026-09-26, v2.1.283): herdr answered a prompt with `agent_prompt_stalled` while Claude sat idle with an empty input line and the prompt nowhere on screen; `routr launch` no longer resends (see the rule on prompts below): it reports `needs_input`. |
| Codex (`codex`) | `--yolo --dangerously-bypass-hook-trust -c check_for_update_on_startup=false` (`--yolo` measured: full permissions, the user's choice for worker panes; the update check off because on 2026-09-28 Codex showed "Update available" just after herdr reported it ready, and the Enter that submitted a worker's task chose "Update now": Codex upgraded itself through Homebrew and exited; hook trust bypassed because of the hooks review below. Cost: a worker runs every enabled hook, a repository's own `.codex/hooks.json` included, without review, so rule 6 below matters more). Scoped alternative, also measured: `-s workspace-write -a never -c sandbox_workspace_write.network_access=true`. Model and effort: `-m <model> -c model_reasoning_effort=<effort>`; list with `codex debug models` | **Folder-trust dialog** ("Folder access … Trust this folder?") even with `--yolo` in a folder that is not under a trusted one (measured 0.160.0, 2026-10-08; 0.157.1 did not ask, 2026-09-28); herdr reads it as `blocked` (`trust_directory`) and `routr launch` hands it back. Trust given in a worktree applies to its repository's root, so later worktrees of that repository are not asked (measured 0.160.0, 2026-10-08). **Hooks need review**: when any enabled hook is new or changed since the user trusted it (measured: a repository's `.codex/hooks.json` never reviewed in Codex; not measured: a tool such as myco rewriting `~/.codex/hooks.json`. A worktree's project hooks are read from its repository's root, measured 0.161.0: its own copy was ignored), Codex opens this at startup with "Review hooks" selected, and herdr reads it as `idle` (rules 2026.10.01.1). Without `--dangerously-bypass-hook-trust` the Enter that submitted a worker's task opened Codex's hooks panel, herdr then said `working`, and launch reported a worker that never got its task (0.160.0 and 0.161.0, 2026-10-08). With the flag Codex starts at its input box and warns that enabled hooks may run without review. The flag is in `codex --help` of every npm release checked, 0.135.0 to 0.161.0; older releases not checked. Without network access routr answers with its fallback. `codex exec` hangs unless stdin is `< /dev/null`. While its MCP servers start, herdr already reports it `idle`; a task sent then is held (`› [Pasted Content 3102 chars]` above `Waiting for startup`) and Codex starts it by itself once ready (2026-09-28, twice). herdr calls that prompt stalled; `routr launch` waits on the agent's state and sends nothing again. |
| Cursor (`cursor`) | `--yolo --trust` (measured: no dialog; `--yolo` is `--force`). Model: `--model <id>`; list with `cursor-agent models` | `--model` **persists as the account default**. Measured way around it: launch with `CURSOR_CONFIG_DIR=<a folder holding a copy of ~/.cursor/cli-config.json>` (via `herdr pane run`; herdr still recognises the agent, address it by pane id); the account default stayed unchanged. On Windows herdr does not see an agent a shell started, so `routr launch` sets the variable in the pane's PowerShell (or cmd) and lets `herdr agent start` run Cursor (measured on Windows 11: tracked, prompted, and the private folder removed when the pane closed). cmd expands `%` and `!` even inside quotes, so with a temporary folder whose path holds either, routr refuses cmd: set TEMP elsewhere, or use PowerShell. Its reported usage omits subagent tokens. Whatever `CURSOR_CONFIG_DIR` says, it writes its runtime files (`worker.log`, `worker.sock`) under `~/.cursor/projects/<the working folder>` (measured 2026-09-25); routr's usage read always works in the system temp folder, so that is one folder, reused. Subagents: Cursor's own models only. Twice (2026-09-26, with a 2.4k-character task): herdr answered the prompt with `agent_prompt_stalled` while the task sat pasted and unsent in the input box (`→ [Pasted text #1 +21 lines]`); Enter sent it. `routr launch` no longer presses keys on what the screen shows (see the rule on prompts below): it reports `needs_input`, and Enter in the pane is the fix. Does not quit on Ctrl+C: close the pane. |
| Antigravity (`agy`) | `--dangerously-skip-permissions --add-dir <dir>` (measured: worked in the given directory, no dialog). Model: `--model <id>` ALONE: its model ids already carry the effort (`…-low|-medium|-high`). Adding an `--effort` that disagrees with the id is refused (agy 1.2.11, 2026-09-26: `invalid model selection … conflicts with --effort=high`, exit 1; earlier versions warned and ran the HIGH variant); a family id with `--effort` resolves to that variant (`gemini-3.8-flash --effort low` ran `gemini-3.8-flash-low`), so routr passes the full id and no `--effort`. `--add-dir` takes an absolute path only. List with `agy models` | **Does not see `~/.agents/skills`**: it needs the worker guide's file path in the prompt. It loads skills from `~/.gemini/config/skills` (measured 2026-10-05, agy 1.2.17; not the `~/.gemini/antigravity-cli/skills` its web docs name), and routr links its skills there: see "Where routr's skills go" below. Giving the guide's path in the prompt still works, so keep doing it. herdr can report it `idle` while it is still working: wait for the VERDICT line. agy 1.3.3 opened a "Terms of Service & Data Use" screen on both launches of 2026-10-11 (its data-sharing box comes ticked), which herdr reads as `idle`, so the task lands on that screen and launch reports `needs_input`. It is the user's to answer, never yours: ask them to run `agy` once in their own terminal, then send the task again with `launch --pane`. Headless runs without `--dangerously-skip-permissions` auto-deny shell commands and still report SUCCESS (routr's headless launch passes it: see "Antigravity headless" below). With no `--add-dir`/`--project` it ignores the current directory. |
| Kiro (`kiro`) | `chat --trust-tools=*` (measured, Kiro CLI 2.24.1, 2026-09-28: no confirmation and no folder-trust dialog). Model: `--model <id>`; list with `kiro-cli chat --list-models`. `auto` is Kiro's own router (its docs recommend it; the footer shows `auto`, measured). Effort: `--effort <level>` on the models whose `/effort` panel offers levels (Kiro's docs: the newer Claude and GPT models); `auto` and the other models show "n/a" and ignore the flag silently (measured). `routr launch --effort auto` passes no flag | `--trust-all-tools` **asks "Kiro is running in trust all tools mode" at every start**, with "No, exit" selected, while herdr reports it idle (its rules do not recognise that screen, 2026-09-28). `--trust-tools=*` allows every built-in tool (its `/tools` list: all 14 "allowed") and asks nothing (measured 2026-09-28; MCP tools not measured), so `routr launch` passes that. **An unknown `--model` id runs the default silently**: the footer (`kiro_default · <model> · ◔ 5%`) then shows no model (2026-09-26). `routr launch` checks the id against `kiro-cli chat --list-models` before it opens a pane or starts a headless worker. `chat --no-interactive` ignores `--model` altogether ("failed to set model … Method not found"); routr's headless worker runs `kiro-cli acp` instead, which takes it (see "Kiro headless" below). **An explicit `--effort` is remembered as the user's default for that model** in `~/.kiro/settings/cli.json` (Kiro's docs; not measured: no model on the measured account took effort). The confirmation can be turned off only globally, with the setting `chat.disableTrustAllConfirmation` (listed by `kiro-cli settings list --all`; not on Kiro's public settings page); there is no per-launch flag. Reads skills only from `~/.kiro/skills`, not `~/.agents/skills` (routr links its skills there). Quits with `/quit`. |

`routr launch` encodes this table: it applies the permissive flags, the model and effort syntax, and the
work-arounds below for the harness you name, so an ordinary launch needs none of this detail. Read here when you are
choosing a model, when a launch does something you did not expect, or when you are launching by hand. In herdr,
`routr launch --kind <k> --model <m> --dry-run` prints the exact flags a pane gets, and costs nothing. Outside herdr a
dry run still plans the pane launch: the headless command is in that harness's "headless" section below, and a real
launch shows it in `ran`.

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

**What the same answer says about billing (Claude Code, measured 2026-10-07, macOS).** `claude auth status` prints
JSON, and how the login is billed is in it:

| Login | `claude auth status` | routr reads it as |
|---|---|---|
| A subscription (Max) | `"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"`, plus the email and organisation | nothing: the usage windows decide, as before |
| An API key (`ANTHROPIC_API_KEY`, empty `CLAUDE_CONFIG_DIR`) | `"loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty", "apiKeySource": "ANTHROPIC_API_KEY"`, no `subscriptionType` | `metered`: billed per token |
| An API key from `apiKeyHelper` (read from Claude Code 2.1.293's code, not measured) | `"authMethod": "api_key_helper"` | `metered` |
| Through a cloud provider (read from its code; billed per token by the provider per its docs, not measured) | `"apiProvider"`: `bedrock`, `vertex`, `foundry`, `anthropicAws`, `anthropicGoogleCloud`, `mantle` | `metered` |
| Through a Claude apps gateway (read from its code) | `"apiProvider": "gateway"` | nothing: its spend limit arrives as a window (`capped`) |
| Usage-based Enterprise (not observed) | unknown | nothing: the user's `billing` |
| Any other provider or auth method, a cloud provider beside any authMethod but `third_party` (its code always sets that one with a provider), an explicit `null`, or a value that is not a string | | nothing: only the values above count |

This matters because `/usage` alone cannot tell. With the API key, `claude -p /usage --output-format json` answered
locally ($0, 0 turns) with only a session cost summary ("Total cost: $0.0000 … Usage: 0 input, 0 output …"): no
quota windows and no "using your subscription" line. A subscription login printed the same when its credentials were
not available (`--bare`, 2026-10-05). routr keeps only the class and a fixed reason of its own with the sign-in
answer, never the email, organisation or ids. A metered reading settles a Claude reading that brought no windows (no
doctor step asking for `billing`); in exactly that case routr runs `claude auth status` again first, so a login
switched since the kept answer counts now, and one that no longer answers signed in is left out of that call. Windows that do arrive are ranked without that second check, and a kept
metered reading beside them is only noted. The user's own `billing`
wins over it. The other harnesses' status answers say nothing about billing; Codex's metered seat shows in its usage
shape instead (below).

**Windows, npm installs (measured on GitHub's windows-latest, 2026-10-05, Bun 1.4.2).** A harness CLI installed with
npm is a `.cmd` shim (`%APPDATA%\npm\codex.cmd`). Started without a shell, as routr starts everything, it failed by
bare name and by full path alike, so its sign-in check never answered and the harness was never used. routr now
resolves each command through PATH and PATHEXT as cmd would, starts npm's own shim as `node <its script>` directly,
and runs any other `.cmd` through `cmd.exe /d /s /c` with each argument escaped for cmd; arguments with spaces, quotes,
`% & ^ | < > ( ) !` and Claude's `{"disableAllHooks":true}` arrive intact (CI test, from `bun test` and from a compiled
binary), and a timeout stops the CLI under cmd.exe too (`taskkill /T`). Not yet run against a real npm install of any
harness. A native `.exe` install starts as before.

## Rules that hold for every harness

routr removes the lead session and herdr pane names below by exact, case-insensitive match, not by prefix. This
covers harness reads, headless turns and the private herdr server whose shells start
harnesses; herdr clients keep their environment to find their session. The private server still answers
`herdr --session <name> pane list` with the pane names removed (herdr 0.9.5, checked live 2026-10-24); the private
pane's shell environment has not been checked live. Sign-in, provider and configuration settings stay, including
`SUDO_ASKPASS`, `CODEX_HOME`, `CURSOR_CONFIG_DIR`, `HERDR_CONFIG_PATH`, `HERDR_LOG` and `HERDR_HOME`.

| Harness | Lead session variables removed | Source and version checked |
|---|---|---|
| Claude Code | `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SSE_PORT` | Measured child session inheritance, 2026-10-21 to 2026-10-22; Claude Code 2.1.306 to 2.1.308 |
| Codex | `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_TOOL_CALL_ID`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED` | codex-rs source; installed 0.164.0 binary disassembly sets sandbox child environment (`seatbelt`, network-disabled `1`); 2026-10-24 |
| Cursor | `CURSOR_CONVERSATION_ID`, `CURSOR_REQUEST_ID`, `CURSOR_AGENT`, `CURSOR_ASKPASS_SOCKET`, `CURSOR_ASKPASS_SECRET`, `CURSOR_AGENT_STORE_FILES_DIR`, `CURSOR_AGENT_STORE_SHARED_PATHS`, `CURSOR_SANDBOX`, `AGENT_TRANSCRIPTS` | Installed bundle's command environment and shell snapshot filter, cursor-agent 2026.10.22; 2026-10-24 |
| Antigravity | `ANTIGRAVITY_CONVERSATION_ID` | Installed binary, agy 1.4.7; 2026-10-24 |
| Kiro | `KIRO_SESSION_ID` | Installed binary, kiro-cli 2.34.0; 2026-10-24 |
| herdr panes | `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_CLIENT_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_BIN_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` | Installed binary's pane environment name block, herdr 0.9.5; 2026-10-24 |

**Not checked:** whether agy 1.4.7 assigns `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` to tool commands.
Both names occur in the installed binary, and its embedded plugin shell instructions expect them in the shell
environment; static inspection did not establish the command assignment. They are not removed by this rule.

Rules 0, 1 and 7 are about panes, in herdr; a headless worker has no pane, screen or input box.

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
   A task that provably never arrived (the input box empty, the agent never started, its session holding no message:
   Claude in a new worktree, 2026-10-11, under load) is sent again with `routr launch --pane`, never a bare prompt.
   `routr launch` waits for two ready readings 1.5 s apart before it sends, and waits through a moment in which herdr
   sees no agent (`agent_not_running`, seen once with Cursor under load) before it calls a start failed.
2. Verify outcomes yourself; status fields and exit codes lie (see the table).
3. Read usage and the models actually used from transcripts or session files, not from the agent's own account.
4. Before a batch, launch one unit and watch its first minutes. A batch nobody watched once burned its budget on
   invalid runs.
5. Where the harness offers a budget cap per run, set one.
6. One worktree per worker, read-only ones included (the orchestrator guide's rule). Keep a worker's directory away
   from repositories whose hooks should not fire.
7. **A worker's own question box can read as working.** Codex's ask-the-user box (a text box or options above
   `enter submit   ^] skip   ⇧→ main prompt`, or folded to `? 1 question · 15s … ⇧← to answer`) sets its terminal
   title to "Action Required", which herdr reads as `blocked` (measured 2026-10-11, gpt-6.1-sol). With background
   terminals running the screen still shows "Working (29m 33s …)", and herdr's rules 2026.10.01.1 read the screen as
   `working`: a question can wait unseen. The worker guide forbids these tools; the orchestrator guide says to look at
   a long-working worker. herdr's rules are herdr's to fix (`herdr agent explain --file <screen> --agent codex` shows
   its reading); a local override in `~/.config/herdr/agent-detection/codex.toml` replaces the whole manifest and
   shadows every later update from herdr, so it is a stopgap, removed once herdr's own rules read the box.

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
| Claude Code on a seat with quota windows: Pro, Max, Team (measured: the plan does not change what `/usage` prints) | `/usage`: "Current session" and "Current week (all models)" (read as `five_hour` and `seven_day`); statusline `rate_limits.five_hour` and `seven_day` | `included` |
| Claude Code on an API key (measured 2026-10-07) | `/usage`: a session cost summary, no windows; `claude auth status`: `"authMethod": "api_key"` | `metered`, from the auth status (above) |
| Claude Code on usage-based Enterprise (claimed: the docs say `rate_limits` is sent only for plans with a quota; what `/usage` and `claude auth status` print there is not observed) | no `rate_limits` at all, even after a response; `/usage` lines unknown | `unknown` with a note; the user sets `billing: "metered"`. Absence is not read as "no quota": a seat-based Enterprise plan is not observed and may also send none |
| Claude Code behind a Claude apps gateway with spend limits (claimed: docs) | `rate_limits.spend_limit`, `used_percentage` may pass 100 | `capped` |
| Kiro on a Free plan (measured 2026-09-26, Kiro CLI 2.24.1) | `/usage`: "Estimated Usage \| resets on 2026-10-01 \| KIRO FREE", "Credits (0.00 of 50 covered in plan), 0.0%": one monthly pool that every model draws on at its own rate. Takes ~10 s and 0 credits, and leaves an empty saved session. The figure is an estimate that lagged a 0.10-credit turn | `included` |
| Kiro on a paid plan with overage on (not observed) | unknown: any line beyond the credits line is counted in the reading's note ("N additional lines not read"), never copied or parsed | `included` until measured |

## How routr reads each harness's usage

Each reader goes through the harness's own command or screen, and only once its sign-in check passes; the two
fallbacks below read what the harness or routr itself wrote (Codex's session log, `routr statusline`'s snapshot). An
update of the harness, or of herdr for Cursor, can change what a reader sees without a word: when a reader that worked
before has no reading a day old or newer, its last try failed, and routing is left with the assumed headroom (no
kept reading to use; a metered seat never), `dispatch`, `usage` and `doctor` warn and give the command to read it
again.

- **Claude Code:** a `routr statusline` snapshot under 5 minutes old when there is one, otherwise its own `/usage`,
  through `claude -p` (next section), in each call; an older snapshot is kept when that read fails.
- **Codex:** its app-server's `account/rateLimits/read` (about 0.4 s, no tokens), in each call. The method is marked
  experimental, so the newest session log under `~/.codex/sessions` is the fallback.
- **Antigravity:** `agy -p /usage --output-format json`, answered without an agent turn (0 tokens, about 2 s), in
  each call. About one call in six hung (measured), so routr waits 4 s, then 5 s once more, and reports two hangs as
  a failure. It reports two pools; only the one named for Gemini, the subscription's own, counts.
- **Cursor:** no command or file holds it, only its interactive `/usage` screen. routr opens that screen in a private
  headless herdr session it makes for the read and then deletes (herdr installed; no herdr window needed, nothing on
  the user's screen), on a private copy of Cursor's config, and reads only `Included N% used`; Auto and API go in the
  note. The footer's context meter (`… · 8.7%`) is not usage. A second Enter goes in if the panel has not shown after
  6 s. Measured on herdr 0.9.1 (2026-09-25); herdr 0.9.5 prints nothing when it types into a pane, which routr before
  0.8.0 read as a failure. It takes seconds, so it runs in the background (below).
- **Kiro:** `kiro-cli chat --output-format stream-json /usage` in the system temp folder (0 credits, about 10 s),
  then Kiro's own `--delete-session` removes the empty session it leaves (about 8 s; it prints "Deleted" and exits 0
  even for an id it never had). In the background (below).

Cursor's and Kiro's readings are kept in `~/.cache/routr` and refreshed in the background when the last try is over
4 hours old, or at once when an older routr made a try that got no reading; a call never waits for one.

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


## Claude Code headless, outside herdr (measured 2026-10-21 and 2026-10-22, Claude Code 2.1.306 to 2.1.308)

What `routr launch` outside herdr relies on: `claude -p --input-format stream-json --output-format stream-json
--verbose` with the permissive flags, model and effort as in a pane.

- The task goes in on stdin as a stream-json user message; a message written while a turn runs joins that turn.
  `--resume <session>` continues a session as a new process, its earlier context kept.
- There is no question box: AskUserQuestion is absent under `-p`. Told to ask, Claude asks in text and ends the
  turn with a successful `result`.
- `result` holds the turn's final message. A command started with `run_in_background` keeps Claude running after it,
  even once stdin is closed; when that command ends, Claude starts a turn by itself (a second `init` and `result`).
  `background_tasks_changed` lists what is pending.
- With `BASH_DEFAULT_TIMEOUT_MS=15000`, a Bash tool command that ran past it was moved to the background, not killed,
  and the `-p` session waited for it before it ended (macOS and Windows). Not measured at the 2-minute default.
- Each tool command runs in a process group of its own. SIGTERM to Claude ends them; SIGKILL leaves them running.
- With its reader gone (the process that held its output killed), Claude kept working until its next write failed
  (macOS).
- Started from a lead's sandbox it fails: Claude Code's Bash sandbox blocks api.anthropic.com and writes outside the
  allowed folders (it sets `SANDBOX_RUNTIME`); inside Codex's workspace-write sandbox `claude` says "Not logged in"
  (Keychain hidden; it sets `CODEX_SANDBOX`).
- Started from a Bun process in a folder with a `.env`, Claude used that file's `ANTHROPIC_API_KEY` (`apiKeySource`
  in its `init`): Bun had loaded it. routr's release builds do not load a `.env`.

## Codex headless, outside herdr (measured 2026-10-22, codex-cli 0.163.0)

What `routr launch --kind codex` outside herdr relies on: `codex app-server -c check_for_update_on_startup=false`,
its JSON-RPC protocol on stdin and stdout (`codex app-server generate-json-schema` prints it).

- `initialize`, then `thread/start` with the folder, the model, `approvalPolicy: "never"` and `sandbox:
  "danger-full-access"` (what `--yolo` is in a pane), then `turn/start` with the task as its input and the effort.
  Nothing of the task is in the command line.
- `turn/steer` with the running turn's id joins that turn: the message arrives as a user message in it. Once the
  turn has ended it is refused (-32600 "no active turn to steer"); a `turn/start` then runs the message as the next
  turn in the same process.
- `agentMessage` items carry a `phase`; the turn's report is its `final_answer` text, or else its last message
  that marks no phase (a model that marks none); commentary and partial answers are never the report.
- Closing its stdin after `turn/completed` ends it at once (exit 0). A new app-server continues the thread with
  `thread/resume`, its context kept.
- With `approvalPolicy: "never"` it asked the client nothing, a question included (asked in text, the turn completed).
  A request routr does not handle is answered with a JSON-RPC error, which declines it.
- In a repository with a `.codex/hooks.json` the user has not trusted, the hooks did not run and nothing asked:
  unlike a pane (where routr passes `--dangerously-bypass-hook-trust`), a headless Codex skips hooks the user has not
  trusted (that a trusted hook runs: not measured).
- No folder-trust question in a folder Codex has not trusted (a throwaway repository; a pane in the same folder asked).

## Antigravity headless, outside herdr (measured 2026-10-22, agy 1.4.5)

What `routr launch --kind agy` outside herdr relies on: `agy --print= --input-format stream-json --output-format
stream-json` with the pane's `--dangerously-skip-permissions`, `--add-dir <folder>` and `--model <id>`.

- `--print=` with the empty value: a bare `-p` takes the next word as its prompt.
- Each `{"event":"user","message":{"content":"…"}}` line on stdin runs a turn. `init` names the conversation
  (`conversation_id`); `step_update` steps carry `step_type` (`user_input`, `agent_response`, `tool`) and a tool's
  `tool_name`; `result` holds the turn's `response` and `status` (`SUCCESS`).
- A line written while a turn runs does not join it: it waits, and runs as the next turn in the same process (no new
  `init`). A correction therefore lands after the work it corrects. routr does not write it mid-turn: the holder keeps
  it and writes it after that turn's `result`, one line per turn (measured 2026-10-22 with Antigravity itself: two
  corrections sent during one turn ran as turns 2 and 3, one commit each).
- Closing its stdin after the last `result` ends it at once (exit 0). `--conversation <id>` continues the
  conversation in a new process, its context kept.
- With `--dangerously-skip-permissions` its `run_command` ran without asking. Told to ask, it skipped its question
  tool and asked in text (p37).
- Not measured: a first run before Antigravity's Terms of Service screen has been answered, a background command, a
  lead's sandbox, stop mid-turn. (p39 for the stream, p37 for `--print=` and the question.)

## Kiro headless, outside herdr (its protocol measured directly 2026-10-22, kiro-cli 2.33.1; the loop through routr not yet run with a real Kiro)

What `routr launch --kind kiro` outside herdr relies on: `kiro-cli acp` with the pane's `--trust-tools=*`, `--model`
and `--effort`, speaking the Agent Client Protocol (JSON-RPC on stdin and stdout). Measured with `--model auto` only (no
effort flag passed); an explicit model id and `--effort` on `acp` are not measured.

- `initialize`, then `session/new` with the folder: a session id (a UUID). `session/prompt` with the task as its
  prompt is answered when the turn ends, with a `stopReason` (`end_turn`); its text streams as `agent_message_chunk`
  updates in pieces, and tools as `tool_call` updates with a `kind` (`execute` seen; the others are the protocol's: `read`, `edit`, `delete`, `move`, `search`, `think`, `fetch`). routr's report is the text
  after the last tool call.
- A second `session/prompt` while one runs is refused at once (-32603, "Prompt already in progress") and the running
  turn goes on. A prompt after the turn ends runs as the next turn in the same process.
- Closing its stdin after the last turn ends it at once (exit 0). `session/load` continues the session in a new
  process: it first replays the session's history as updates, then answers from its context.
- An id Kiro does not list is taken at `session/new` (reported as its current model), so routr checks the id against
  `kiro-cli chat --list-models` first, as for a pane.
- Kiro sends notifications of its own (`_kiro.dev/metadata` with context and credits, `_kiro.dev/commands/available`,
  `_kiro.dev/session/update`, `_kiro.dev/subagent/list_update`);
  routr ignores them. No request reached the client with `--trust-tools=*`.

## Cursor headless, outside herdr (measured 2026-10-22, cursor-agent 2026.10.22-27dcf5f)

What `routr launch --kind cursor` outside herdr relies on: `cursor-agent -p --output-format stream-json` with the pane's
`--yolo`, `--trust` and `--model <id>`, on a private copy of `~/.cursor/cli-config.json` (`CURSOR_CONFIG_DIR`), as a
pane gets.

- It reads its prompt from stdin to the end before it starts: a turn is one process. Events: `system/init` (the
  session id, a UUID), `user`, `assistant` (its text), `tool_call` started and completed (one key per tool, such as
  `shellToolCall`), and `result` (`is_error`; `result` joins every assistant message of the turn, so routr's report
  is the last assistant message). It exits about 0.4 s after `result`.
- `--resume <session>` in a new process continues the session, its context kept. A correction sent mid-turn therefore
  waits in routr's holder and runs as the next turn, in a new process (measured through routr: two corrections sent
  during one turn ran as turns 2 and 3, one commit each; a follow-up once idle resumed the session; Cursor's own
  transcript held each message once).
- Its own helper: Cursor installs as `<versions>/<v>/cursor-agent`, which the `cursor-agent` on PATH links to
  (`~/.local/share/cursor-agent/versions` here). The first turn in a project folder starts `<versions>/<v>/node
  <versions>/<v>/index.js worker-server` (socket in `~/.cursor/projects/<folder-slug>/worker.sock`), not detached, so
  it stays in that turn's process group with its parent gone. It starts `npm exec typescript-language-server --stdio`,
  which starts `node <npx cache>/node_modules/.bin/typescript-language-server --stdio`. Later turns in that folder
  reuse it. It ended about five minutes after its last turn once (p43), and between 3 min 41 s and 2 hours after it
  another time (p41); Cursor documents no idle exit. It outlived its folder's removal. routr recognises exactly
  those command lines, in that install, each started by the one before, and does not count them as the worker
  running; anything else under the worker-server counts (another language server included: not measured).
- Just after cursor-agent closes, its group still held one process in its exit (`(node)`), gone within 100 ms: on
  stop, and before it resumes with a queued message, routr looks at a group again for up to two seconds.
- Not measured: Windows and Linux (only a fake in CI), `--worktree`, a killed holder, a background command, what the
  worker-server does on the SIGTERM of a stop during the turn that started it, whether a first run in a folder Cursor
  has never trusted needs anything beyond `--trust`.
