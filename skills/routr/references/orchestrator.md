# routr orchestrator

You are the lead agent. In herdr, workers run in panes; outside herdr, Claude Code, Codex, Cursor, Antigravity and Kiro workers run headless. Your job is
to get the user's work done across the subscriptions they pay for, without running any one of them hot, and to keep
the user informed without making them watch panes. In herdr, use the herdr skill for every pane and agent command;
this file covers only what herdr does not know.

Check first: `test "${HERDR_ENV:-}" = 1`. Outside herdr there are no panes: `routr launch` starts Claude Code,
Codex, Cursor, Antigravity and Kiro workers headless instead, and you follow them with `routr wait`. Read "Outside herdr: headless workers" (after
step 6) for what changes; everything else here applies as written.

## 1. Decide whether to launch at all

Launching is not free: a worker pays a fixed context cost to start, and delegating work that does not split cleanly
roughly doubled usage with no gain in quality on the one audit measured (`docs/evidence.md`). `routr dispatch` answers this first, in its `worker` field: do it
yourself when the work is one or two small edits, settle it with the user when the brief leaves them a decision,
split it when the pieces are independent (then ask routr once per piece), and otherwise hand it out when it can run
while you do something else or your own subscription is close to its reserve.

Planning is work too. Research, exploration and reviews are handed out like any other piece, read-only ones included,
even when you will wait for the result: ask `routr dispatch` about each, and do one yourself only when its `worker`
field says `do it yourself`. What stays with you is what cannot be handed out: turning findings into the plan, the
decisions that are the user's, checking each result, and integrating it.
Whatever you hand out goes to a routr worker through `routr dispatch` and `routr launch`, never to your harness's own
subagents (Claude Code's Agent tool, Codex's or Cursor's subagents). Those all run on your subscription, out of the
user's sight, with no ledger row, and spreading the work across the user's subscriptions is what routr is for.
`routr subagent` is the workers' command.

## 2. Ask for the facts, then decide

    routr dispatch --task-file <the task file you will launch with>

Save its stdout to `<scratch>/advice-<n>.json`.

Ask about the task itself, word for word: the file you will pass to `launch --task-file`. A summary gets advice about
the summary (in the maintainer's ledger, at least 12 of 42 dispatch calls were given one, and routr's facts then
described text the worker never saw). `launch --advice` requires matching `dispatch` advice on that exact task, including
reviews (`subagent` advice ranks no accounts and is refused). A standing choice of your own (reviewers on a fixed model and effort, for example) is no reason to skip dispatch: you can still choose it after
reading the advice. Dispatch answers even when its decision model is unavailable; matching fallback advice is valid.
Read `unavailable` before deciding: it names the missing part, the attempted decision model or usage source, and
its fixed failure code and reason. Tell the user in the launch line when advice was a fallback and what was
unavailable, and judge that part yourself. A later decision model's answer is ordinary advice: `decision_model` names
who answered and earlier failures in `unavailable` do not mean fallback. Tell the user the backup answered and why
the first choice could not answer; judge the missing level yourself only on true fallback, and missing usage separately. The list tries local Ollama after hosted entries because it may need to load,
with an 8 s cut per hosted attempt and one overall deadline (10 s hosted-only, 30 s with local).
Launch carries all saved decision-model entries; older fallback advice
says the attempted model is unknown. A stale usage snapshot shows its age; unknown metered capacity is a valid
reading, and excluded accounts remain in `excluded`. These are separate from a failed read. Keep your
process rules for the worker (what it may and may not do, how to report, git steps) out of that file: they go in `--rules-file`, which launch passes
to the worker and routr does not judge. In 18 of 36 real tasks such rules were 5 to 38% of the text, and they moved routr's
readings.

First, the brief: if `states_check` or `standalone` reads `no`, fix the brief and ask again. A worker cannot ask you
questions.

Follow "Deciding" in `SKILL.md`: settle the work level, identify suitable model/effort options, then compare accounts.
Use `facts`, `notes`, `subscriptions.candidates`, `subscriptions.ranked` and relevant repository or verified outcome
evidence. Consult the harness's models when needed (see `harnesses.md`); an everyday default does not establish fit.

Dispatch's candidates were filtered for the advised level. If you choose a different level, refresh eligibility:

    routr usage --level <basic|standard|strong>

Use the level you chose. This reads usage and applies the user's account settings without asking the decision model again. Check
`ok` and `level`, then choose from its `subscriptions.candidates`; if it fails, eligibility was not refreshed. Resolve the error or
hold the launch until you can establish eligibility. Keep the original dispatch file for `launch --advice` and
`record --advice`; the usage response is a capacity view, not a replacement assessment.

Ask about each worker's exact brief before launch. If selection is delayed or intervening work changes capacity,
refresh with `routr usage --level <chosen>` again. A changed brief needs new dispatch advice.

Before launch, state the advised and chosen level, model, effort and account with a short reason for each choice.
If the level changed, include the `ROUTR:` line from the skill. Name model and effort explicitly in the launch.

Usage is read by routr itself for every subscription; you pass nothing. Cursor's and Kiro's come from a reading routr
refreshes in the background about once per working session, and at once after an update when the last try got no
reading (its `age_sec` says how old); `routr usage cursor` or
`routr usage kiro` takes a fresh one now if you have reason to think it moved. `routr usage` (no name) shows what routr sees of every subscription, ranked,
without a brief.

## 3. Launch

**Every worker gets its own worktree.** Pass `--worktree <branch>` to `routr launch`: it creates a git worktree of the
repository in `--cwd`, which herdr opens as a workspace nested under the repository in the sidebar, and launches the
worker there. This is the rule for read-only workers too. The user can find every worker in one place and click into
it, your own tab stays clean, and no worker can touch the main checkout. A worktree holds tracked files only: if the
work needs an untracked file or folder (a local config, test data), pass `--copy <path>` for each one and the
launcher copies it across. Never copy a file holding secrets unless the task needs it. Worktrees live under
`~/.herdr/worktrees`; Claude Code counts a worktree as its repository, so a worker is asked whether to trust the
folder only when the user has never trusted the repository in Claude (run `claude` in it once and choose Yes). Outside a git repository there is nothing to nest under: leave `--worktree` off and the launcher
splits a pane beside you.

A worktree's branch starts at the checkout's current commit. Work that builds on another worker's branch (stacked
work), or a reviewer of one branch or commit, gets `--base <ref>` as well: the branch, tag or commit id to start
from. Use it rather than making the worktree yourself with herdr or git: a worktree made outside routr comes with no
cleanup command in a launch result to finish it with.

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

2. The task: what to do, where, what done looks like, and what is out of scope. For a fix, state the rule it must
   keep everywhere and where else that rule applies, not only the symptom you saw.
3. How to verify it (the command to run), so the worker can check its own work.

Parts 2 and 3 are the work, and they go in `--task-file`: it is what you ask routr about. Your rules for how the
worker operates go in `--rules-file`, and launch adds them after the task: for a worker that writes, that it commits
on its own branch and never pushes; for a reviewer, that it changes nothing, which commands it may run, and how to
set out its findings.
4. The closing line. Without it a worker on a small task ended with a sentence instead of the report.

       Finish with the report block from the worker guide, starting with the line `VERDICT: done | partial | blocked`.

**Launch.** `routr launch` does the whole sequence in one call. It splits the pane, checks that the user's shell
is ready, applies that harness's permissive flags and its model and effort syntax (chosen so it asks nothing at
startup), waits until the agent is ready, wraps your task in the opening and closing lines, and prints one JSON
object describing what it did.

    routr launch --kind <claude|codex|cursor|agy|kiro> --name <agent-name> \
        --cwd <repo> --worktree <branch> [--base <ref>] --model <id> [--effort <level>] --task-file <path> \
        [--rules-file <path>] --advice <file> [--dry-run]

- `--model` is required: never let a harness pick its own default, which may be its largest model. Effort goes in
  `--effort` where the harness takes it separately. On Antigravity the model id already carries it, and routr says so
  instead of passing a flag Antigravity refuses when it disagrees with the id. On Kiro, `--effort auto` (its suggested default,
  with `--model auto`) passes no flag and leaves effort to the model; a level is passed, but Kiro remembers it as
  the user's default for that model, and a model without effort ignores it. Kiro also runs its default on a model id
  it does not know, without a word: launch checks the id against Kiro's own list (`kiro-cli chat --list-models`)
  before it opens a pane or starts a headless worker, and names it in `unavailable` when it could not read the list.
- `--task-file` holds your task alone (parts 2 and 3). With neither task form the pane is left ready and unprompted;
  sending work later still requires matching advice.
- `--rules-file` holds your process rules, added after the task. routr passes them on without judging them, and
  `--advice` compares the task alone.
- `--advice` takes the advice file you saved from `routr dispatch`. launch compares the text that advice was about
  with the task it sends. A task requires usable JSON advice (nonempty `id` and `brief_sha`, no `ok: false` or `error`)
  with a matching `brief_sha`: otherwise launch refuses before any harness, pane or worktree call. Dry runs make the same checks, return `ok: false` with `error` on a refusal, and still plan.
  With no task (no `--task-file` or `--task`) there is nothing to compare, and no `advice` field.
- routr answers no question: not the user's shell (its plugins and startup files ask their own), not a harness at
  startup. It passes each harness's own flags so none is asked (Cursor `--trust`, Kiro `--trust-tools=*`, Codex
  `--dangerously-bypass-hook-trust` for its hooks review; Codex and Claude Code still ask to trust a folder outside a
  trusted one), and anything asked anyway comes back to you as `needs_input` (below). `--trust` is no longer accepted.
- `--dry-run` requires `--model`, prints `would_run` and changes nothing. It returns `ok: false` and `error` when a real launch would refuse its arguments, folder, task or advice; otherwise `ok: true`. It does not check the environment, subscription settings or sign-in.
- Read the JSON it prints. `state` is `planned` (from `--dry-run`), `ready`, `prompted`, `needs_input`, or `failed`.
  `headline` says what happened. `warnings` states facts about the call. `steps` says what it did, in order. Follow `next`: it includes
  the cleanup command (step 6) and, after a start or task-submission attempt, this worker’s record template.
  Preflight refusals have no record template; dry runs with matching advice include the planned template. A failed
  launch that never submitted a task says so in the record step and records `blocked` with `--check none`.
- **`needs_input` is yours to decide.** Something in the pane waits for an answer routr does not give: a shell's own
  question, a harness's startup question, a worker that has not started. `screen` is top-level (what the pane shows; withheld once the task was sent, since it then shows the brief).
  `needs_input` holds `why`, `herdr` (its reading: the state and the rule `herdr agent explain` matched; when a worker launch started
  still read `blocked` but explain read its screen as another state until the timeout, `explained` holds that state
  and `rule` is left out, since that rule is not the question's), a `note` from what routr knows
  about that harness. `next` says how to carry on. Answer what is within the task's scope yourself, with
  `herdr pane send-keys <pane> <keys>`: a question your own launch raised, a folder you created, the user's shell
  asking whether to load a file. Ask the user for anything that is not yours to answer: a password or other secret, a
  sign-in, a folder you did not create, anything that cannot be undone. Then follow `next`: before the task was sent it
  is the same `routr launch` with `--pane <pane>`, which carries on from the shell, or adopts the agent already
  running there and sends it the task. It adopts only an idle agent of the kind you asked for, in `--cwd`, and keeps
  the model and effort it is running; it never waits on an agent it did not start, since one it waited for could have
  work of its own. Following `next` right after you answer works when herdr already reads the agent idle (launch checks
  herdr's live reading, so a `blocked` state herdr has not yet updated does not stop it). Otherwise it comes back as
  `needs_input` (the agent is starting or working): wait until it is idle (`herdr agent wait <pane> --until idle`)
  and run it again. A task you gave inline with `--task` is never printed: give it again.
- `prompted` means the worker took the prompt and started, not that it finished. Waiting for the work is step 4.
- launch sends the task once, and herdr's own state says whether the worker took it. When herdr sees no activity at
  first ("the prompt stalled": a harness still starting, a slow connection), launch waits for the agent to start
  (`steps` then holds `prompt_wait`) and never sends the task again or presses a key for it: herdr's rule is that a
  stalled prompt may still have arrived. If the agent has not started by the end of the timeout, the result is
  `needs_input`, and its `next` says: do not launch it again; read the pane; press Enter if the task sits unsent in
  the input box (`herdr agent send-keys <pane> enter`); and if the box is empty and the agent never started, the task
  never arrived: run the `routr launch … --pane <pane>` command `next` describes, which wraps and sends it again. Never
  send it with a bare `herdr agent prompt`: launch wrapped it (the opening, your rules, the closing line), and a bare
  prompt would arrive without them.

`references/harnesses.md` records what each harness does and what goes wrong with it. Read it when a launch surprises
you or when you are choosing a model. Every task handoff uses `routr launch` with its own advice.
The sequence below explains what launch performs; it is not a route around the advice check:

1. `herdr worktree create --cwd <repo> --branch <name> [--base <ref>] --no-focus`, and take the root pane it returns.
2. Read the pane; wait for a clean shell prompt before typing (see `harnesses.md` rule 0).
3. `herdr agent start <name> --kind <kind> --pane <id> -- <permissive flags>`.
4. **Read the pane after every start**, whatever state herdr reports. A startup question may be showing: herdr
   reports Claude's folder trust as `agent_not_ready`, then `blocked`, and `herdr agent explain <pane>` says what it
   matched; a screen herdr's rules do not know reads as `idle`.

   <!-- startup-input -->
   Read the pane and its options before sending keys: the default answer can be "No, exit". Accept folder trust only
   for a directory you created or a worktree of the repository the user already has you working in; otherwise ask the
   user and leave the pane waiting. For other startup questions, answer only within scope; ask the user for a secret
   or sign-in and leave the pane waiting.
   <!-- /startup-input -->

5. `herdr agent prompt <name> "<text>" --wait`.

Every worker is finished with `routr cleanup` (step 6). Never reuse a pane
for another worker: keys sent while an agent is exiting land in the wrong place.

## 4. Judge, send back, escalate

You are the judge. Rework is normal: a worker often patches the symptom instead of fixing the pattern, and the loop
is how that gets caught. Workers use the skills and conventions the user has set up in their harness; judge the
result against the project's own standards, not just the brief.

- Wait with `herdr agent wait <pane> --until done --until idle --until blocked --timeout <ms>`, then read the tail of
  the pane. (A `wait-output` regex must be anchored to the whole line, `'^\W*VERDICT: (done|partial|blocked)\s*$'`,
  or it matches the echo of your own launch prompt. herdr has reported an Antigravity worker `idle` four seconds into
  work it was still doing.) `blocked` means the agent is showing an approval or question: read it, answer it if it is
  within the task's scope, otherwise ask the user (`herdr notification show`).
- **Never wait without a timeout, and look at a worker that has been working a long time.** Workers are told not to
  ask, but one sometimes does, in its harness's own question box, and herdr does not always read that as `blocked`:
  on 2026-10-11 a Codex worker's question sat under its still-running "Working (29m …)" timer (background terminals
  kept it going), herdr read the pane as `working`, and the question waited for an answer no one gave. When a wait
  times out, or a worker has been working far longer than its task should take, read the last lines of its pane
  (`herdr agent read <pane> --lines 30`). A question there is yours to answer as you would a `blocked` one; the answer
  goes in with `herdr agent send-keys`, not a new prompt.
- Get the worker's FULL report and save it (in a pane, all of it, not just the tail on screen; outside herdr, the
  turn's `report` file, below), and take a first read: `routr check --brief <file> --report <file>`. It flags, in a second or less (several on a local model) and the same way every time, a
  report that names no verification, skips part of the brief, admits gaps, reads as a symptom patch, or strays out
  of scope. It never accepts work.
- Then run YOUR check: the diff exists and is in the right directory, the project's tests pass when you run them,
  the change follows the patterns around it. Never trust an exit code, a "success" status, or the report alone.
- **Falls short → send it back to the same worker** with the specific points; it has the context, so this is the
  context-preserving fix when the approach is sound. If the approach is wrong, corrections repeat, or the worker
  thrashes, use the evidence to change model, effort or harness and attach the relevant report. Correct missing
  context or changed requirements before blaming execution. You may change the execution within the user's account
  boundaries without asking for each adjustment; reassess the work level only when the work warrants it.
- **Size each review round to what it found.** A decision that is the user's goes to the user; a change in behaviour
  goes back to the builder; a trivial fix (one literal, a typo) you check yourself rather than launching another
  round. On 2026-10-24 one orchestration (observed, not measured) spent up to three cross-vendor review rounds per
  fix briefed as its symptom, each finding the next instance of the same gap; one round surfaced a decision that was
  the user's, and one was spent on a single test literal.
- Keep the user able to follow: one line when you launch (what, where, which model, why) and one line when a result
  lands (accepted, sent back, or escalated, and why).

## 5. Record

Keep each worker’s advice when you ask for it. Follow the record entry in launch’s `next`, fill its placeholders,
and add `--note` and `--report` after verifying the result. Never borrow another worker’s advice; with no advice for
a worker, record nothing. `record` is the only command that writes to the ledger: it appends one line to the user's
ledger.

    routr record --advice <file> --task-file <this worker’s task file> --subscription <s> --model <m> --effort <e> \
        --level <the level you settled on> --verdict <done|partial|blocked> \
        --check <pass|fail|none> [--report <file>] [--subagent "<subtask> → <level> → <model>"] \
        [--attempts <n>] [--seconds <n>] [--cause <cause>] [--run-id <id>] \
        [--note "<reasons for the model, effort and account; what happened>"]

Pass `--level` explicitly, even when unchanged, and use `--note` for separate model, effort and account reasons,
any level override, and the observed result. Keep the original advice intact: selecting a larger model alone does
not change the work's difficulty.

`--effort` is what you launched with. Write `default` if you passed none: routr records the effort the run had, and
says where it came from in `chose.effort_from`: `model id` on Cursor and Antigravity, whose ids carry it
(`grok-4.7-high`); `config default`, your configured `default_effort`, on a harness that takes effort separately; or
`given`, what you wrote, kept as it is when neither says (no default set, or no effort in the id).
`--verdict` is the worker's own VERDICT line. `--check` is your verification. Pass the saved report with `--report` so
the worker's subagent choices are recorded too. `--attempts` counts observed tries by this worker; a partial report
does not establish a count. Omit it when unknown.
`--seconds` is elapsed time from handoff through your verification, including waiting and corrections, or until the
run stops. Omit it when unknown. A pass means you verified and accepted the result.

Classify extra work with repeatable `--cause`: `execution` for correcting work against the agreed brief (including
fixes you made yourself); `brief` for missing or ambiguous context; `scope` for requirements added later; `review`
for a successful review finding issues and checking their fixes; `launch` for trouble starting or delivering the
prompt; `unknown` when the cause is not established. Several may apply. Use `--cause none` alone when no extra work
occurred. Attempts alone never establish model failure.

Record each worker separately, including failed start attempts and workers replaced during escalation. A preflight
refusal starts no worker and has no record template. Each new record returns a new `run_id`; a revision keeps it. Advice must belong to
that worker’s exact task. To revise the outcome for that same worker, pass its returned
`--run-id` and the same advice, project, subscription, model, effort and level, with the complete updated outcome.
Follow record's `next`: only `done` with `check pass` proceeds to integration and cleanup; otherwise send the work
back or escalate, then verify and revise the row before cleanup. Every success includes a `kind: "do"` revision
template with that run's identity already filled, including its resolved effort and chosen level; fill verdict,
check and note. Advice, task and ledger paths in the template are absolute, so you can follow it from another folder.
For advice piped on stdin, save that same advice to fill the template's advice-file placeholder.
`--run-id` takes `run_id` from record's earlier output, not `id` (the advice id). If it is unknown, follow `next`
to read the worker's `run_id` from that earlier output or its row for this advice id in the selected ledger.
A fresh dispatch has a new advice `id` and is refused for a revision, even on the same task.
If the original task file is gone, revise without `--task-file` and say so in `--note`.
Omitted `--note`, `--report` and `--subagent` preserve the existing note and subagent choices. To replace them, supply
the new note or report/subagent list; an empty note clears the note, and `--subagent none` clears the list.
`assess` counts the latest revision once. It keeps old rows without run IDs separate. Only `done`, `check pass`,
`attempts 1` and `cause none` count as accepted first pass. The ledger stores a brief hash and length, never its text.

`routr assess` reports verified acceptance, causes and capacity without automatically recommending a different model
from attempt counts. A failure can justify immediate recovery; repeated comparable verified outcomes can inform
future choices. Review the actual work and correction causes before generalizing. Session evidence and the local
ledger support judgment, not a model ranking or automatic learning across sessions. Persistent changes to the user's
configured preferences remain explicit. Run IDs, notes and causes stay local. If the user turned telemetry on, recorded
rows also reach routr's maintainers (anonymous, never text; `routr share` shows exactly what).
When you finish a long run, mention `routr assess`, and that `routr feedback "<text>"` sends the maintainers a note.

## 6. Integrate and clean up

A worker that writes commits its work on its own branch inside its worktree (tell it so in the task) and never pushes.
Every worker is finished with `routr cleanup`, the command in its launch result’s `next`, once you have verified its work
and it has nothing left to do. Do not close a worker's pane instead: a worktree's workspace normally has that one
pane, closing it closes the workspace, and the worktree is then left on disk where herdr no longer removes it.

    routr cleanup --cwd <repo> --worktree <branch> [--delete-branch] [--dry-run]
    routr cleanup --pane <pane>          # a worker launched without --worktree

- If the user asked for the work to land, merge the worker's branch into the branch the user is on, run the project's
  checks again on the merged result, and then run cleanup with `--delete-branch`.
- Otherwise run cleanup without it: the branch stays. Tell the user where it is and what your check showed.
- cleanup refuses while the worker's agent is working or waiting at a question, or a command runs in its pane. It
  also refuses while the worktree holds uncommitted changes, untracked files the main checkout does not hold as they
  are, files git is told not to check, or a commit that no branch or tag holds. An untracked file identical to the
  main checkout's (what `--copy` brings in) goes with the worktree, and so does everything git ignores (build output,
  `node_modules`, a copied `.env`), as with `git worktree remove`: tell a worker to commit anything it must keep.
  cleanup cannot see a commit made, or a worker started, after its last check: run it only once the worker is done.
  Its `headline` says why; `next` says what to do; never discard a worker's changes to get past it, and never push. Work that
  failed your check stays where it is until the user decides.
- `--delete-branch` deletes a branch only when git agrees it is merged; otherwise it is kept and `warnings` says so.
- `routr cleanup --cwd <repo>` with no worker named lists every worktree of the repository and whether cleanup can
  remove it. Run it before you finish, and remove what your session left behind.

Finish by telling the user, per piece of work: what was done, on which subscription and model, your check, and where
the result is.

## Outside herdr: headless workers

Outside herdr, `routr launch --kind claude`, `codex`, `cursor`, `agy` or `kiro` starts the worker without a pane: routr runs the
harness's own headless mode (Claude Code's `-p`, Codex's app-server, Cursor's `-p`, one process a turn, Antigravity's `--print`, Kiro's ACP mode) on the user's sign-in, in its worktree (or
`--cwd` without one), held by a routr process of its own. Dispatch, the task file, `--advice`, the
model and effort choice, `check` and `record` are as in herdr. What differs:

- **Every harness, worktrees as in herdr.** A headless Kiro worker has run only against a
  fake and a direct probe of its protocol, not yet end to end through routr: watch its first turn closely. A headless Cursor worker has run end to end through
  routr once, on macOS only. `--pane` and `--direction` are refused outside
  herdr. A headless Cursor runs on a private copy of its config, as in a pane, and needs `~/.cursor/cli-config.json`
  (it is there once the user has signed in to `cursor-agent`). A headless Codex runs without `--dangerously-bypass-hook-trust`: hooks the user has not trusted in Codex do
  not run, unlike in a pane.
  `--worktree <branch>` (with `--base` and `--copy`) works as in step 3: routr makes the git worktree itself, under
  `~/.local/share/routr/worktrees`, and the worker runs there. The branch must be new: an existing branch, or a
  worktree folder already there, is refused. The rule is the same too: every worker gets its own worktree, read-only
  ones included. Outside a git repository, leave `--worktree` off: the worker then works in `--cwd`, so give one
  writing worker that folder at a time. A `--dry-run` outside herdr still plans herdr's worktree create and does not
  check the branch.
- **Not from inside a sandbox.** A worker started from your sandboxed shell cannot reach its provider or routr's
  state, so launch refuses there, and so does a send that has to start the worker again; run those as commands outside
  the sandbox. A send to a worker that is running goes over its channel as usual. `wait`, `workers` and `stop` still
  run there and warn that the sandbox may hide a worker's channel: `unreachable` then means the channel did not answer,
  and the worker may still be running.
- **Wait with routr.** `routr wait --name <name>` returns when the worker finishes a turn, fails, stops, is lost or
  does not answer (`unreachable`), or at
  its timeout with `state: "running"`: then wait again, as its `next` says. The default is 90 seconds; keep
  `--timeout` under your own shell tool's command limit (2 minutes by default in Claude Code). Name several workers to
  get whichever finishes first.
- **Read each turn's outcome and report.** A turn's `report` is a path to the worker's final message of that turn
  (Codex: its final answer; Cursor: its last assistant message, not the joined `result`; Kiro: the text it wrote after its last tool call, so a Kiro worker that runs a command
  after writing its report leaves only what follows: ask for the report with `routr send`), cut at 1 MB, or null when it wrote none. Read the file and run `routr check --brief <task file> --report <path>`. The final
  message is the report the worker guide asks for; when it is missing or cut short, ask the worker for it with
  `routr send` before you accept the work.
- **A headless worker cannot ask.** A question it writes ends its turn, and the report holds it: answer within scope
  with `routr send`, ask the user what is theirs to answer, then send that. A question the harness itself raises
  (Codex asking its client) is declined, and the turn goes on.
- **Send back with `routr send`.** `routr send --name <name> --task-file <file>` sends a correction into the turn
  that is running (Codex: it joins that turn, and one that arrives just as the turn ends starts the next turn instead;
  Claude: written to its input, where Claude decides whether it joins the running turn or starts the next, not yet
  measured through routr; Cursor, Antigravity and Kiro: routr holds it, `state: "queued"`, and it runs as a turn of its own once the
  running one ends, in the order sent; Cursor's in a new process on the same session) or, when the worker is
  idle, resumes its session with it as the next turn. It keeps the worker's context, so this is the send-back of step
  4. With Cursor, Antigravity and Kiro, a correction does not stop work already under way: `wait` first returns the report of the turn
  that was running, which the correction may change; the turn whose `delivered` counts your message carries the
  correction, so judge that report. When the running work is wrong enough to waste, `routr stop` the worker first,
  then `routr send` the correction: it continues the conversation in a new process (stop then send: not measured; a Cursor stop mid-turn was run once). A stop
  drops any message routr still holds (`state: "queued"`), and its `warnings` say how many: send them again after it.
  `state: "delivered"` means it reached the running worker (Claude: written to its input, not proven read; Antigravity
  and Kiro, between turns: written in, starting a turn; Cursor: never, a correction is queued or resumes it; Codex: accepted by its app-server), not that the worker acted
  on it; wait for the turn's report.
  `state: "unknown"` means it was handed over and no answer came: look with `routr workers` before you send it again.
  New work is a new launch with its own advice.
- **Background commands.** A Claude worker that left a command running in the background may start another turn by
  itself when that command ends. `wait` reports that turn like any other. Codex's, Cursor's, Antigravity's and Kiro's background
  commands are not tracked: routr closes their input once a turn ends (Cursor's as soon as its task is in; its process
  ends with its turn), which ended each at once in the measured runs (none had a background command left). Whether any
  of them starts a turn by itself, or what happens to a command still running, is not measured; `wait` reports such a
  turn like any other, and a command left in its process group blocks `send` and cleanup (see "Lost"). With Cursor it
  also ends every correction queued behind that turn `not_started`: send them again once it has ended.
- **Look at it.** `routr workers` shows each worker's state, turn, seconds since it last did something, its last
  tool, and its latest report path, never its text. Taking a worker over interactively is not built yet: do not open
  its session with `claude --resume`, `codex resume`, `agy --conversation`, `cursor-agent --resume <session>` or Kiro's own resume (`kiro-cli chat --resume`; whether it opens an ACP session is not measured) while routr may resume it (a `send` would start a second
  process on the same session, and routr cannot see the first). Read its reports instead.
- **Stop and clean up.** `routr stop --name <name>` ends a worker through its own process. Every worker ends with
  `routr cleanup --worker <name> [--delete-branch]`, the step in its launch result's `next`: it removes the worker's
  worktree with the checks of step 6 (and keeps everything when one fails), then its run folder and reports, so read
  what you need first. It refuses while the worker runs. It cannot see a background command the worker started that
  outlived it: stop those yourself first. Finish a headless worker's worktree with `cleanup --worker`, which checks its
  process first, not with `--path`. Outside herdr, `routr cleanup --cwd <repo>` lists and removes other worktrees
  through git, and cannot see whether something runs in a worktree's folder: run it only for work that has ended. A
  worker launched without `--worktree` worked in `--cwd`: its changes are yours to integrate. A Cursor worker's
  `cleanup --worker` leaves Cursor's own worker-server for its folder running and says so: it is Cursor's, as after a
  `cursor-agent` run there, so leave it. In `pgrep -lf -g <group>` (macOS; `pgrep -a -g <group>` on Linux),
  `…/cursor-agent/versions/<v>/index.js worker-server` and the language server under it are that helper, not the
  worker. When routr still counts the group and it shows only that worker-server and that language server under it,
  they are Cursor's:
  wait for the worker-server to end on its own (about five minutes after its last turn, in the one run timed), then
  send or clean up again.
- **Lost, or something left running.** If a worker's own process dies, `wait` and `workers` say `lost`. On macOS
  and Linux they name the process group its harness ran in while that group still has members (a lost harness, or a
  command that outlived it), and send and cleanup refuse until it is empty. routr never stops a process by a saved
  id: look at the group (`pgrep -lf -g <group>` on macOS, `pgrep -a -g <group>` on Linux), stop it if it is this worker's, then clean up.

## Handoff contracts

`dispatch` and `subagent` require a nonempty brief: inline, stdin, or `--task-file <path>`. File input replaces the
other forms; an unreadable file or a flag without a usable value is refused. Unknown flag-led input without a stdin
brief returns `ok: false`, without a reading, and points to a quoted brief or the file form in `next`. Neither
command prints the brief.
`launch` requires `--kind` and `--name`, a model for a real start, and matching `--advice` whenever it sends a task.
Advice files accept UTF-8 (with or without BOM) and UTF-16LE (with or without BOM), including PowerShell 5.1 output.
No task needs no advice. `record --task-file` compares the task before reports are read or any row is appended:
unreadable, mismatched or unhashed advice records nothing (`ok: false`). An omitted task file is accepted for an
inline task and returns a warning that the advice was not checked against a task. Outcome revisions keep the original
advice file. If the original task file is gone, revise without `--task-file` and say so in `--note`.

The commands a lead reads (`subagent`, `dispatch`, `check`, `launch`, `record`, `cleanup`, `wait`, `send`, `workers`,
`stop`, `usage`) return
`ok`, `headline`, `unavailable`, `warnings` and `next` first. Launch puts its harness command
in `start` (`executable`, `argv`, `env`), and history in `ran` or dry-run `would_run`. Record returns the advice `id`
and the row’s `run_id`.

Follow every result’s `next` array. Each entry is one of:

- `kind: "run"`: `why`, exact `argv`, and `command`, a line for bash, PowerShell 5.1/7 and cmd. If any word falls
  outside the safe set, `command` is null: execute `argv` directly. `stdout_to`, when present, names the file to save
  stdout to; it is never a redirection token in `argv`.
- `kind: "do"`: `why`, and optionally a `template` with placeholders for the lead to fill. It is an instruction,
  never a runnable command. Unsafe values become named placeholders instead of expanding shell text. Launch’s record
  template requires matching task advice, also in dry runs. A real launch includes it only after an attempt to start
  the worker or submit its task. An adopted pane, a dry run naming `--pane`, or no model leaves model and effort as
  placeholders. Inline tasks omit `--task-file` and never appear in output.

The safe set is nonempty words containing only letters, digits, `_ . / : = @ + - , ~`, backslash and space, without
a leading tilde, adjacent backslashes or a trailing backslash. Spaces, backslashes, `@`, commas, internal tildes,
`--` and dash arguments containing a dot or colon are double-quoted. If the first word would need quotes or contains
`=`, `command` is null. History (`ran`, `would_run`) is display only, with prompt lengths in place of prompt
text; only follow-up steps go in `next`.
