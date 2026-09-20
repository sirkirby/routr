# Setting up routr

Walk the user through this. Ask before you write or install anything, and show what you are about to write.
Requirements: Bun (https://bun.sh) on PATH; herdr for orchestration (the worker and subagent parts work without it).

## 1. Check

    bun <routr skill folder>/scripts/routr.mjs doctor

It changes nothing. It reports which harnesses are installed, which have a live usage source, whether the TypeSafe
key works, and whether a config exists; with no config it prints a starter one for the harnesses it found.

## 2. TypeSafe key

routr needs one secret: a TypeSafe API key (https://typesafe.ai). Either the user exports `TYPESAFE_API_KEY` in
their shell profile, or you write it, with their agreement, to `~/.config/routr/env` as `TYPESAFE_API_KEY=...`
(create the file with owner-only permissions). Prefer this file over a project `.env`: workers run in worktrees and
other folders, where a project `.env` does not exist. Never print the key or put it in a repository. Without a key routr
still answers, but only with the fallback level.

## 3. Config

Save to `~/.config/routr/config.json`, starting from doctor's starter config. Settle each value with the user; every
one is their preference, and none describes a model.

- `subscriptions`: one entry per subscription the orchestrator may launch on, named `claude`, `codex`, `cursor`, `agy`.
  - `reserve`: the share of that subscription routr must never offer (0.25 keeps a quarter for the user's own work).
  - `hardest_work`: the hardest work the user would hand it: `basic`, `standard`, or `strong`. For Cursor this means
    Cursor's own models; other vendors' models inside Cursor draw on a different pool and are not routed to.
  - `default_model` and `default_effort`: the user's everyday model on that harness, chosen from the live list doctor
    prints (routr keeps no model list of its own). The orchestrator starts from it and moves up or down with the
    work. Doctor warns when the harness no longer offers it; that is the only time it needs attention.
  - `assumed_headroom`: used only when nothing better is known. Claude, Codex, and Antigravity are read live; Cursor's
    is read by the orchestrator from its `/usage` panel and passed in. The advice marks the rest `assumed`.
- `prefer`: the user's standing preference per kind of work (`implement`, `debug`, `refactor`, `review`, `research`,
  `test_writing`, `docs`), for example `"research": "strong"`. Shown to agents as advice, never forced.
- `sure_at` (0.8), `risk_above` (0.75), `fallback_level` (`standard`): leave at the defaults unless asked.

## 4. Claude usage (only if Claude Code is a subscription)

Claude Code reports usage only to its statusline. `scripts/claude-statusline-usage.mjs` in this skill shows the model
and usage in the statusline and saves each snapshot to `~/.cache/routr/claude-usage.json`, which routr reads. It is a
Bun script with no other dependency. If the user agrees:

1. Copy it to `~/.config/routr/claude-statusline-usage.mjs`. Do not point Claude at the copy inside the skill folder:
   that path changes when the skill is updated or was installed as a plugin.
2. Set `"statusLine": { "type": "command", "command": "bun ~/.config/routr/claude-statusline-usage.mjs" }` in
   `~/.claude/settings.json`, using the full path to `bun` if it is not on Claude's PATH. If the user already has a
   statusline, keep theirs and add the snapshot step to it instead of replacing it.

The snapshot appears after the next Claude Code turn. Codex and Antigravity are read from the harness directly and
need nothing; Cursor's usage is read by the orchestrator from its `/usage` panel.

## 5. A `routr` command (optional)

Agents run routr from the skill folder and do not need this. It lets the user run `routr doctor` and `routr assess`
themselves. If they want it, write a two-line launcher to a folder on their PATH (for example `~/.local/bin/routr`,
made executable):

    #!/bin/sh
    exec bun "<routr skill folder>/scripts/routr.mjs" "$@"

On Windows write `routr.cmd` containing `@bun "<routr skill folder>\scripts\routr.mjs" %*`. Do not name it `route`:
that is a system command.

## 6. Confirm

Run doctor again, then one real call, and show the user the result:

    bun <routr skill folder>/scripts/routr.mjs dispatch "Rename getUsr to getUser in src/api/users.ts and update its call sites"
