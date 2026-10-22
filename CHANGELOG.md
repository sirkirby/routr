# Changelog

A short history of what changed in each routr release, one line per change. Each release links to its full notes in
[docs/releases](docs/releases): upgrade steps, compatibility, and how it was checked live there, not here.

## Unreleased

- With herdr 0.9.5, `routr usage cursor` reads Cursor's usage again (it reported `read_failed`, so routing assumed half
  its headroom), and `routr launch --kind cursor` in a pane starts Cursor again: herdr now answers nothing when it types
  into a pane, and routr took that for no answer. (#97)
- Outside herdr, `routr launch --kind agy` starts a headless Antigravity worker in its stream-json mode, on your
  sign-in: `routr send` queues a correction as its next turn, or continues its conversation with a follow-up. (#95)
- Outside herdr, `routr launch --kind codex` starts a headless Codex worker through its app-server, on your sign-in:
  `routr send` steers a correction into its running turn, or resumes its thread with a follow-up. (#94)
- Outside herdr, `routr launch --worktree` gives a headless worker its own git worktree, as in herdr, and `routr cleanup
  --worker` removes it with the same checks; `routr cleanup` run outside herdr lists and removes worktrees through git.
  (#93)
- Outside herdr, `routr launch --kind claude` starts a headless Claude Code worker on your sign-in, and `routr wait`,
  `routr send` (a correction mid-turn, or a follow-up that resumes its session), `routr workers` and `routr stop`
  follow it; `routr cleanup --worker` removes it. Other harnesses still need herdr. (#92)
- The routr binary no longer loads a `.env` or `bunfig.toml` from the folder you run it in. In a project whose `.env`
  set `ANTHROPIC_API_KEY`, routr's own Claude Code reads (sign-in status, usage) used that key instead of your
  subscription, so Claude Code could read as billed per token; a decision-model key or `ROUTR_*` variable in that
  `.env` was used too. Workers that `routr launch` starts were not affected. (#91)

## v0.7.0 — 2026-10-19

[Full notes](docs/releases/v0.7.0.md)

- `routr launch` takes advice from `routr dispatch` only: `routr subagent` advice ranks no accounts, so a launch on it
  would skip your reserves and level limits. (#88)
- Name backup decision models: routr asks them in order before using the fallback level, and a backup’s answer is
  ordinary advice that says which models could not answer and why. (#87)
- Every command a lead reads now shares ok, headline, unavailable, warnings and next; output paths are consistent,
  required inputs are checked, and launch’s --trust is removed. Startup steps follow the guide's trust rule; record
  steps match the outcome and include a template with absolute file paths to revise that run. Relative output files
  work on Windows. (#86)
- Each reading says in `unavailable` what routr could not read, and why: the decision model it tried and what to do
  about it, or a usage source it could not read now. When the decision model could not answer, the headline says so
  first; launch on fallback advice says so too. Usage failures no longer copy a harness's own text. (#85)
- `routr launch` refuses a task without advice on that exact task, reviews included; a dry run warns and still
  plans. Your reserves and level limits are applied in `dispatch`, so a launch can no longer skip them. (#84)
- `dispatch` and `subagent` read the exact brief with `--task-file`, also as PowerShell saves it (UTF-16 or with a
  byte-order mark); a brief made only of flags routr does not take gets no reading. (#84)
- Each result says what comes next in `next`: commands that run unchanged in bash, PowerShell and cmd, or
  instructions for the lead. Launch's `cleanup` and `needs_input.then`, and cleanup's `then` and `refused.then`,
  moved there; `check` and `skill install` return it as a list. (#84)
- Launch hands back this worker's `record` template, and `record --task-file` refuses advice given on another task.
  (#84)
- A decision model's reply can no longer put its text in routr's output or your ledger. Failures are now a fixed
  set of messages, each saying what to do, and answers are checked against what each question allows. (#82)
- `check` with a missing brief or report says which file, and Ollama's version and build are shown only in their
  expected form. (#82)
- [docs/guarantees.md](docs/guarantees.md) lists what routr reads, writes, starts and removes on your machine, and
  the limits that remain. (#81)

## v0.6.1 — 2026-10-15

[Full notes](docs/releases/v0.6.1.md)

- An orchestrator hands out research and reviews to pane workers, not to its own subagents.
- `routr subagent` says who it is for: a routr worker, or an agent outside herdr.

## v0.6.0 — 2026-10-11

[Full notes](docs/releases/v0.6.0.md)

- Choose your decision model: TypeSafe's Jev, Cloudflare's Clef, or Clef Flash running locally on Ollama.
- `routr key set cloudflare` saves a Cloudflare token and account ID beside your TypeSafe key.
- Workers that ask a question are noticed.
- `routr launch` delivers tasks more reliably, and when one never arrives it names the command that sends it again.
- Antigravity's consent screen is reported instead of being read as idle.

## v0.5.4 — 2026-10-08

[Full notes](docs/releases/v0.5.4.md)

- Codex workers get their task when one of your Codex hooks is new or changed: launch skips Codex's hook review, so
  a worker runs your enabled hooks, a repository's included.
- Codex's folder question comes with how to stop it.

## v0.5.3 — 2026-10-07

[Full notes](docs/releases/v0.5.3.md)

- routr knows when Claude is billed per token.
- Switching how Claude is signed in shows up right away.
- Claude Team seats are no longer treated as unknown.

## v0.5.2 — 2026-10-07

[Full notes](docs/releases/v0.5.2.md)

- Updates succeed on slow connections, and downloads go straight to disk.

## v0.5.1 — 2026-10-07

[Full notes](docs/releases/v0.5.1.md)

- Workers are finished with `routr cleanup`, which keeps committed and uncommitted work.
- `routr launch --base <ref>` starts a worker's branch at another branch, tag or commit.
- Both skills and the orchestrator guide say the same thing about starting and finishing workers.

## v0.5.0 — 2026-10-07

[Full notes](docs/releases/v0.5.0.md)

Includes v0.5.0-beta.1 to beta.3.

- Claude Code's usage is read from Claude itself (`claude -p /usage`); setup no longer installs a statusline.
- Start an orchestration with `/routr-orchestrate <your plan>` (Codex: `$routr-orchestrate`).
- npm-installed harnesses work on Windows.
- Antigravity gets routr's skills.
- After a worker's startup question, running launch's `then` hands it its task once herdr reads it ready, and a busy
  worker is never given a second one.
- `routr doctor` makes no network call; updates cannot step backwards; timed-out reads always end.
- Skill installs and uninstall touch only routr's own files.

## v0.4.2 — 2026-10-05

[Full notes](docs/releases/v0.4.2.md)

- No more flashing windows on Windows.
- A beta update channel.
- Updates download the exact version they checked and ignore malformed release tags.
- A usage, sign-in or model-list read from inside a herdr pane no longer passes on the pane's variables.

## v0.4.1 — 2026-10-01

[Full notes](docs/releases/v0.4.1.md)

- The lead chooses model and effort for a verified, high-quality result, then compares capacity among suitable options.
- `routr usage --level basic|standard|strong` refreshes eligible accounts when the lead changes the advised level.
- Recording separates the work's difficulty from the model chosen.
- An invalid `--level` is rejected before any named usage refresh.

## v0.4.0 — 2026-09-30

[Full notes](docs/releases/v0.4.0.md)

- Account use: funded enterprise or other usage-based accounts can be considered for everyday work. Run
  `routr setup` after upgrading to review it.
- `routr record` takes outcome causes, and `--run-id` revises one run.

Releases before v0.4.0 are on [GitHub](https://github.com/sirkirby/routr/releases).
