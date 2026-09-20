# Launching each harness unattended

Workers run with permissive settings because nobody watches their panes; you, the orchestrator, are the check.
Flags change between releases: before relying on one, run the harness's `--help`. The launch column was *measured*
through `herdr agent start <name> --kind <kind> --pane <id> -- <flags>` (interactive sessions, 2026-09-20: each
worker edited two files, ran a command, and reported). The last column was *measured* in earlier headless evals.

| Harness (`--kind`) | Permissive launch | What goes wrong (*measured*) |
|---|---|---|
| Claude Code (`claude`) | `--dangerously-skip-permissions` (measured). Model and effort: `--model <alias or id> --effort <level>` | **Folder-trust dialog** in any directory that is not under a trusted one; default answer is "No, exit"; herdr reports `agent_not_ready`. Headless without a permission mode **silently refuses edits** and exits 0. `--allowedTools` does not restrict anything when the user's default mode is bypass. Quits on Ctrl+C twice. |
| Codex (`codex`) | `--yolo` (measured; full permissions, the user's choice for worker panes). Scoped alternative, also measured: `-s workspace-write -a never -c sandbox_workspace_write.network_access=true`. Model and effort: `-m <model> -c model_reasoning_effort=<effort>`; list with `codex debug models` | **Its own folder-trust dialog, even with `--yolo`**, which herdr reports as `idle`: read the pane. Without network access routr answers with its fallback. `codex exec` hangs unless stdin is `< /dev/null`. |
| Cursor (`cursor`) | `--yolo --trust` (measured: no dialog; `--yolo` is `--force`). Model: `--model <id>`; list with `cursor-agent models` | `--model` **persists as the account default**. Measured way around it: launch with `CURSOR_CONFIG_DIR=<a folder holding a copy of ~/.cursor/cli-config.json>` (via `herdr pane run`; herdr still recognises the agent, address it by pane id); the account default stayed unchanged. Its reported usage omits subagent tokens. Subagents: Cursor's own models only. Does not quit on Ctrl+C: close the pane. |
| Antigravity (`agy`) | `--dangerously-skip-permissions --add-dir <dir>` (measured: worked in the given directory, no dialog). Model: `--model <id>` ALONE: its model ids already carry the effort (`…-low|-medium|-high`). Adding `--effort` prints a conflict warning and silently runs the HIGH variant (measured). List with `agy models` | **No skill mechanism and does not see `~/.agents/skills`**: it needs the worker guide's file path in the prompt. herdr can report it `idle` while it is still working: wait for the VERDICT line. Headless runs auto-deny shell commands and still report SUCCESS. With no `--add-dir`/`--project` it ignores the current directory. |

`routr launch` encodes this table: it applies the permissive flags, the model and effort syntax, and the
work-arounds below for the harness you name, so an ordinary launch needs none of this detail. Read here when you are
choosing a model, when a launch does something you did not expect, or when you are launching by hand. `routr launch
--kind <k> --model <m> --dry-run` prints the exact flags it would use, and costs nothing.

## Rules that hold for every harness

0. **Read a new pane before typing into it.** The user's shell may ask its own question first (measured: a dotenv
   plugin asking "found '.env' file. Source it?" swallowed the launch command). Answer no to such prompts, wait for a
   clean shell prompt, then start the agent. A launch that came up wrong (wrong model, wrong folder) cannot be
   repaired: close that pane and start a fresh one.

1. Prompts sent while an agent is starting are lost. `herdr agent start` returns when the agent is ready; if it
   returns `agent_not_ready`, read the pane and wait for idle before prompting.
2. Verify outcomes yourself; status fields and exit codes lie (see the table).
3. Read usage and the models actually used from transcripts or session files, not from the agent's own account.
4. Before a batch, launch one unit and watch its first minutes. A batch nobody watched once burned its budget on
   invalid runs.
5. Where the harness offers a budget cap per run, set one.
6. One worktree per worker that writes. Keep a worker's directory away from repositories whose hooks should not fire.
