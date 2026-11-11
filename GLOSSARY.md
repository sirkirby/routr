# routr

routr helps a lead coding agent hand work to workers on the user's own AI subscriptions. These are the names routr's
code, guides and contributors use for its concepts. When a name here and a name in the code differ, the code is the
one to change.

## Who does the work

**Lead**:
The agent that plans the work, hands it out with `routr launch`, judges what comes back, and decides. routr advises it.
The skill's guide for this role is the orchestrator guide, and it calls the lead the orchestrator.
_Avoid_: main agent

**Worker**:
One harness session doing one piece of the lead's work under the name launch gave it, until `routr cleanup` finishes
it. Launch usually starts it; in a pane it can instead take over an idle agent already there.
_Avoid_: agent, subagent (a subagent is what a worker spawns inside its own harness)

**Harness**:
A coding agent CLI the user already has installed and signed in: Claude Code, Codex, Cursor, Antigravity or Kiro.
_Avoid_: tool, provider (a provider is where a decision model runs)

**Harness registry**:
The one place routr knows a harness: one entry each, with how to start it, read its sign-in and usage, name it in
help and doctor, and what sets it apart, as properties named for the reason. Three measured tables beside it name
the environment variables harnesses set or read, by variable rather than by harness: the lead's session variables a
worker must not inherit and the config locations it keeps (worker environment), the lead's session ids routr reads
(trace context), and the sandboxes a worker cannot start from (worker start). A harness's own protocol work (its
headless adapter, the parsing inside its usage reader) sits beside the registry too.

## routr's commands

**Command table**:
The one place routr knows a command: one entry each, with its help (flags, arguments, description) and output
contract, and the rules every entry writes out: how a command line reaches it, its exit rule, whether it is traced
and with what, whether it starts the daily updater, whether it calls a decision model, and whether it is an advice
command. Help, dispatch, tracing and the tests that walk every command all read it. A flag a global flag could take as
its value is marked guarded beside its help line.
_Avoid_: help table (help is one of its readers)

## What routr knows of usage

**Usage reading**:
One subscription's usage as its harness reported it: its windows, class and note, when it was taken, and how long its
source lets it be used. routr keeps the last good one of each subscription, so a command that must not wait (board)
serves it aged to now. Every command is served it as a row, the shape it ranks. A kept Cursor or Kiro reading is
named `<name> snapshot` where output says where a reading came from.
_Avoid_: cache entry

**Source key**:
What a usage reading is kept, claimed and billed under: today a harness's name, so a later change can key one
harness's logins apart.

**Refresh claim**:
The mark a call writes on a subscription whose kept reading is due, under that subscription's lock, before it starts
one detached refresh for everything it claimed: callers at the same moment claim each subscription once between them.

## Where a worker runs

**Backend**:
Where a worker runs, decided once at launch from where the lead is: a pane, a terminal or headless.
_Avoid_: mode

**Pane worker**:
A worker whose harness runs in a herdr pane, because the lead is in a herdr session. A herdr session wins when the
lead is also in a herdr-core terminal.

**Terminal worker**:
A worker whose harness runs on its own screen in a herdr-core terminal of its own (a tab of its own in the Herdr app),
because the lead is in a herdr-core terminal and not in a herdr session.
_Avoid_: core worker, app worker

**Headless worker**:
A worker whose harness runs with no screen, held by a holder, because the lead is in neither herdr nor herdr-core.

**Holder**:
The routr process that owns a headless worker's harness and answers the worker commands about it.

**Run folder**:
The folder routr keeps for one headless or terminal worker: its record, a terminal worker's prompt, and a headless
worker's reports.

**Worker record**:
What routr saved about a headless or terminal worker when it launched: its name, harness, model, backend and folder.

**Backend adapter**:
What the worker commands (`workers`, `wait`, `send`, `stop`, `watch`, `cleanup --worker`) do to a worker for one
backend: look at it, send to it, stop it, end it, or say it is followed elsewhere. Picked from the worker's record
through one table: what a command looks at follows the name (the record there now), and what it does follows the
identity (the record it started with, whose id is checked where it acts). Nothing else after launch asks which backend a
worker has.
_Avoid_: headless adapter for the headless backend's (a headless adapter is a harness's protocol work under the holder)

## What a launch leaves

**Launch identity**:
The one id each launch is made with, and the two rules that decide what a launch is from how it ended. It counts
toward the user's launch share (a worker that took its task or was left ready, or a terminal worker stopped at a
question): only then does its answer carry `launch_id` and the launch history keep it. A later `--pane` rerun can find
it (any started worker that took its task, was left ready or stopped at a question): only then does the launch index
keep it. A pane worker stopped at a question is findable and not counted; the rerun that finishes it is what counts.

**Launch history**:
routr's record of each counted launch, under its launch id, kept 7 days: the launch share's input, and the project a
later `record --launch` gives a row. Checked fields only, never the task.

**Launch index**:
The OpenTelemetry export's record of each findable launch, under its launch id with its trace's span, kept 30 days and
written only when export is on: how a `--pane` rerun, cleanup and record link to the launch's span.
