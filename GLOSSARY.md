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
backend: look at it, send to it, stop it, end it, or say it is followed elsewhere. Picked once per worker, from its
record (or, while that cannot be read, its run folder), and used for everything done to it; a record of another backend
or id under its name is another worker. Nothing else after launch asks which backend a worker has.
_Avoid_: headless adapter for the headless backend's (a headless adapter is a harness's protocol work under the holder)
