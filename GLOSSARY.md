# routr

routr helps a lead coding agent hand work to workers on the user's own AI subscriptions. These are the names routr's
code, guides and contributors use for its concepts. When a name here and a name in the code differ, the code is the
one to change.

## Who does the work

**Lead**:
The agent that plans the work, hands it out with `routr launch`, judges what comes back, and decides. routr advises it.
_Avoid_: orchestrator (except as the guide's title), main agent

**Worker**:
One harness session that routr launched to do one piece of work, known by its name until `routr cleanup` finishes it.
_Avoid_: agent, subagent (a subagent is what a worker or lead spawns inside its own harness)

**Harness**:
A coding agent CLI the user already has installed and signed in: Claude Code, Codex, Cursor, Antigravity or Kiro.
_Avoid_: tool, provider (a provider is where a decision model runs)

## Where a worker runs

**Backend**:
Where a worker runs, decided once at launch from where the lead is: a pane, a terminal or headless.
_Avoid_: mode, execution

**Pane worker**:
A worker whose harness runs in a herdr pane, because the lead is in a herdr session.

**Terminal worker**:
A worker whose harness runs on its own screen in a Herdr app terminal, because the lead is in a herdr-core terminal.
_Avoid_: core worker, app worker

**Headless worker**:
A worker whose harness runs with no screen, held by a holder, because the lead is in neither herdr nor herdr-core.

**Holder**:
The routr process that owns a headless worker's harness and answers the worker commands about it.

**Run folder**:
The folder routr keeps for one headless or terminal worker: its record, its prompt, and a headless worker's reports.

**Worker record**:
What routr saved about a headless or terminal worker when it launched: its name, harness, model, backend and folder.
