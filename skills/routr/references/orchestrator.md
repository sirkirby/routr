# routr orchestrator

You are the lead agent, running inside herdr. Your job is to get the user's work done across the subscriptions they
pay for, without running any one of them hot, and to keep the user informed without making them watch panes.
Use the herdr skill for every pane and agent command; this file covers only what herdr does not know.

Check first: `test "${HERDR_ENV:-}" = 1`. Outside herdr you cannot launch panes; say so and work solo.

## 1. Decide whether to launch at all

Launching is not free: a worker pays a fixed context cost to start, and delegating work that does not split cleanly
roughly doubles usage with no gain in quality. `routr dispatch` answers this first, in its `worker` field: do it
yourself when the work is one or two small edits, settle it with the user when the brief leaves them a decision,
split it when the pieces are independent (then ask routr once per piece), and otherwise hand it out when it can run
while you do something else or your own subscription is close to its reserve.

## 2. Ask for the facts, then decide

    routr dispatch [--headroom cursor=<0..1>] "<the brief you are about to hand over>"

First, the brief: if `states_check` or `standalone` reads `no`, fix the brief and ask again. A worker cannot ask you
questions.

Then decide three things yourself, from `facts`, `notes`, `subscriptions.ranked`, and what only you know (what is
already running in other panes, what comes next, which harness suits this repository):

1. **Intelligence and reasoning** the work needs (see "Deciding" in `SKILL.md`).
2. **Subscription**: spread load. Prefer one with plenty of usable headroom over your own when both can do the work.
3. **Model and effort** on that subscription: start from `your_default`, the user's everyday model there, and move up
   or down to match. With no default set, list the harness's models (see `harnesses.md`) and choose. Never launch a
   harness without naming the model: its built-in default may be its largest.

Usage moves while you work, so ask again before every launch; never reuse an earlier answer.

**Cursor's usage** has no local source: run `routr usage cursor` at the start of a run (and again every so often, not
on every launch) and pass its `pass_as` value to `routr dispatch`. Claude, Codex, and Antigravity are read live by
routr itself.

## 3. Launch

**Every worker gets its own worktree.** Pass `--worktree <branch>` to `routr launch`: it creates a git worktree of the
repository in `--cwd`, which herdr opens as a workspace nested under the repository in the sidebar, and launches the
worker there. This is the rule for read-only workers too. The user can find every worker in one place and click into
it, your own tab stays clean, and no worker can touch the main checkout. A worktree holds tracked files only: if the
work needs an untracked file or folder (a local config, test data), pass `--copy <path>` for each one and the
launcher copies it across. Never copy a file holding secrets unless the task needs it. Worktrees live under
`~/.herdr/worktrees`; where the harness asks whether it trusts a new folder, `--trust auto` answers for a worktree
you just created. Outside a git repository there is nothing to nest under: leave `--worktree` off and the launcher
splits a pane beside you.

Workers run without a human, so their permissions must cover the scope of the task, and the task must stay inside
that scope. They also run on the user's machine, in front of the user: do not brief an experiment that pops system
dialogs (running a quarantined binary, touching the keychain, asking for a system permission) without telling the
user first. One such brief put a run of "Move to Trash" dialogs on the user's screen. When the work's correct behaviour is to write outside its folder (a script that writes to the home
directory, say), tell the worker to verify under a temporary `HOME` inside its worktree.

**Write the task.** Every launch prompt has four parts. `routr launch --task-file` supplies the first and the
fourth; you write the second and third.

1. The opening, word for word. Every harness can read a file, so this works even where the harness has no skill
   mechanism (Antigravity) or does not list the skill. A softer line ("use the routr skill") was measured: the worker
   skipped it and ran every subagent on its own model.

       You are a routr worker. Your first action, before any other tool call, is to read the routr worker guide at
       ~/.agents/skills/routr/references/worker.md. It is mandatory for this task: it says how to size each subagent
       before you spawn it and the exact report format the orchestrator parses.

2. The task: what to do, where, what done looks like, and what is out of scope. For a worker that writes, say that
   it commits on its own branch and never pushes.
3. How to verify it (the command to run), so the worker can check its own work.
4. The closing line. Without it a worker on a small task ended with a sentence instead of the report.

       Finish with the report block from the worker guide, starting with the line `VERDICT: done | partial | blocked`.

**Launch.** `routr launch` does the whole sequence in one call. It splits the pane, answers whatever the user's shell
asks first, applies that harness's permissive flags and its model and effort syntax, deals with the folder-trust
dialog, waits until the agent is ready, wraps your task in the opening and closing lines, and prints one JSON
object describing what it did.

    routr launch --kind <claude|codex|cursor|agy> --name <agent-name> \
        --cwd <repo> --worktree <branch> --model <id> [--effort <level>] [--task-file <path>] [--trust ask|auto] [--dry-run]

- `--model` is required: never let a harness pick its own default, which may be its largest model. Effort goes in
  `--effort` where the harness takes it separately. On Antigravity the model id already carries it, and routr says so
  instead of passing a flag that silently runs the high variant.
- `--task-file` holds your task alone (parts 2 and 3). Without it the pane is left ready and unprompted, for you to
  prompt yourself.
- `--trust` defaults to `ask`: at a folder-trust dialog routr stops, leaves the pane alive, and reports
  `needs_human` with what the dialog says. Pass `--trust auto` only for a directory you created or a worktree of the
  repository the user already has you working in. With `auto` you are vouching for the folder; routr is not judging it.
- `--dry-run` prints the plan and changes nothing. Use it to see the flags before spending anything.
- Read the JSON it prints. `state` is `planned` (from `--dry-run`), `ready`, `prompted`, `needs_human`, or `failed`.
  `warnings` holds anything it answered on your behalf and anything it wants you to look at. `steps` says what it
  did, in order. A `needs_human` result is yours to resolve (`herdr notification show`), not to retry.
- `prompted` means the worker took the prompt and started, not that it finished. Waiting for the work is step 4.

`references/harnesses.md` records what each harness does and what goes wrong with it. Read it when a launch surprises
you, when you are choosing a model, or when you launch by hand. The by-hand sequence is what `routr launch` performs:

1. `herdr worktree create --cwd <repo> --branch <name> --no-focus`, and take the root pane it returns.
2. Read the pane; wait for a clean shell prompt before typing (see `harnesses.md` rule 0).
3. `herdr agent start <name> --kind <kind> --pane <id> -- <permissive flags>`.
4. **Read the pane after every start**, whatever state herdr reports. A folder-trust dialog may be showing (herdr
   reports Claude's as `agent_not_ready`, but Codex's as `idle`). You may accept it yourself only for a directory
   you created, or a worktree of the repository the user already has you working in. For anything else, ask the user
   (`herdr notification show`). The default answer can be "No, exit": read the options before sending keys.
5. `herdr agent prompt <name> "<text>" --wait`.

When the worker is finished and verified, close the pane you created. Never reuse a pane for another worker: keys
sent while an agent is exiting land in the wrong place.

## 4. Judge, send back, escalate

You are the judge. Rework is normal: a worker often patches the symptom instead of fixing the pattern, and the loop
is how that gets caught. Workers use the skills and conventions the user has set up in their harness; judge the
result against the project's own standards, not just the brief.

- Wait with `herdr agent wait`, then read the tail of the pane. (A `wait-output` regex must be anchored to the whole
  line, `'^\W*VERDICT: (done|partial|blocked)\s*$'`, or it matches the echo of your own launch prompt. herdr has
  reported an Antigravity worker `idle` four seconds into work it was still doing.) `blocked` means the agent is
  showing an approval or question: read it, answer it if it is within the task's scope, otherwise ask the user
  (`herdr notification show`).
- Get the worker's FULL report (Claude's headless `result` field is only its last message), save it, and take a
  first read: `routr check --brief <file> --report <file>`. It flags, in about 300 ms and the same way every time, a
  report that names no verification, skips part of the brief, admits gaps, reads as a symptom patch, or strays out
  of scope. It never accepts work.
- Then run YOUR check: the diff exists and is in the right directory, the project's tests pass when you run them,
  the change follows the patterns around it. Never trust an exit code, a "success" status, or the report alone.
- **Falls short → send it back to the same worker** with the specific points; it has the context, so this is the
  cheap fix. **Falls short again, or the problem is the approach itself → relaunch one level up** (more intelligence,
  or more effort if it lost the thread over many steps) and attach the first report. Cut off a worker that thrashes
  (many turns, a large diff on a small task) and do the same.
- Keep the user able to follow: one line when you launch (what, where, which model, why) and one line when a result
  lands (accepted, sent back, or escalated, and why).

## 5. Record

Keep the advice when you ask for it (`routr dispatch … > <scratch>/advice-<n>.json`), and once you have verified the
result, record it. `record` is the only command that writes to routr's own state: it appends one line to the user's
ledger.

    routr record --advice <file> --subscription <s> --model <m> --effort <e> \
        [--level <the level you settled on, if not the advised one>] --verdict <done|partial|blocked> \
        --check <pass|fail|none> [--report <file>] [--subagent "<subtask> → <level> → <model>"] \
        [--attempts <n>] [--seconds <n>] [--note "<why you went against the advice, or what went wrong>"]

`--verdict` is the worker's own VERDICT line. `--check` is your verification. Pass the saved report with `--report` so
the worker's subagent choices are recorded too. `--attempts` counts the tries it took (1 means accepted first time);
when you escalated, record the level and model that finally delivered. Record failures and cut-off workers too: they are
what shows a level is too low. The ledger never stores the brief, only its hash and length.
`routr assess` prints what the ledger says so far.

## 6. Integrate and clean up

A worker that writes commits its work on its own branch inside its worktree (tell it so in the task) and never pushes.
After you have verified a piece of work:

- If the user asked for the work to land, merge the worker's branch into the branch the user is on, run the project's
  checks again on the merged result, and then remove the worktree (`herdr worktree remove`) and delete the branch.
- Otherwise leave the branch, tell the user where it is and what your check showed, and remove only the worktree.
- Never remove a worktree that holds changes which are neither committed on a branch nor merged, and never push.
  Work that failed your check stays where it is until the user decides.

Finish by telling the user, per piece of work: what was done, on which subscription and model, your check, and where
the result is.
