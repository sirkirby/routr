# OpenTelemetry export

routr can export OTLP/HTTP JSON to an endpoint you choose. It is off until you configure it. An agent never turns
it on unasked; that is an instruction to the agent, rather than a terminal restriction enforced by the binary.
The guided setup asks a person and defaults to skipping it. `routr setup --yes` alone never enables it.
A hand-edited config can also enable export; the binary cannot enforce who made that edit.

## Turn it on or off

```sh
routr setup --otel-endpoint https://example.test/observability
routr key set otel-headers
routr setup --show
routr setup --otel-off
```

The endpoint must use HTTPS, except that HTTP is accepted on loopback (`localhost`, IPv4 127/8 or IPv6 `::1`).
Userinfo, query strings and fragments are refused. Trailing slashes are removed and a path prefix is kept:
`https://example.test/observability` sends traces to `https://example.test/observability/v1/traces`.
Other signals use `/v1/logs` and `/v1/metrics`. Supply a base endpoint, without the signal suffix.

Every time you set the endpoint, even to the same URL, routr creates a fresh random consent nonce. Commands capture
it when they start and re-read it before queueing. A command from an earlier consent cannot queue under a later
one. Off removes the entire setting. Missing or malformed consent disables export. Off and endpoint changes start
the sender to remove old-consent batches; setup itself deletes no queue files. An already claimed batch is checked
again before its POST. A request already in flight can finish under the consent in force when it began.

`OTEL_SDK_DISABLED=true` (any case) and `ROUTR_OTEL=0` disable recording and export in that process. Trace context
propagation stays unchanged. `OTEL_EXPORTER_OTLP_*` variables do not configure routr, and
`OTEL_RESOURCE_ATTRIBUTES` does not add resource attributes. `DO_NOT_TRACK` and CI do **not** turn this export off.

Export is intended for the default config, `~/.config/routr/config.json`. Headless holders always read this default
config on each turn; they do not inherit a launch command's `--config` path. A launch using another config can
record its own span while its holder records no turns if the default config has export off.
There is one queue per install, while
consent belongs to a config file. A sender started with another `--config` removes batches made under a different
consent, including batches from the default config. Separate config files do not give you separate queues.

Uninstall keeps the config and its consent unless you purge them, but removes the queue and delivery state. After
a reinstall, export can therefore remain on while its queue folders are missing. Status reports `can_queue: false`
and a repair command; doctor flags it. Run `routr setup` (or `routr doctor --fix`) to recreate the folders without
changing consent. Any ordinary setup run repairs them when consent is valid and uninstall is not running.
`setup --show` stays read-only. Commands never recreate missing folders themselves.

## Authentication headers

The person runs `routr key set otel-headers` in their terminal. Input is hidden, or it can be piped in. It is an
OTLP headers list: comma-separated `name=value` pairs, split at the first equals sign. Spaces and tabs around
names, values and separators are trimmed. Percent escapes are decoded exactly once; encode a comma as `%2C`,
an equals sign as `%3D`, and a literal percent sign as `%25`.

Names must be HTTP header tokens; decoded values must be visible ASCII, spaces or tabs. Duplicate names, compared
without case, malformed percent escapes, control characters and non-ASCII values are refused. routr reserves
`content-type`, `content-length`, `host`, `transfer-encoding`, `connection`, `accept-encoding`, `content-encoding`,
`te`, `upgrade`, `expect`, `trailer` and `keep-alive`: the body is plain JSON and routr controls its framing.
A rejected value is never printed.

The headers are stored losslessly as `ROUTR_OTEL_HEADERS` in `~/.config/routr/env`, alongside provider secrets.
Only letters, digits and `-._~` are left unencoded within names and values. The file is owner-only on macOS and
Linux; Windows uses the access your home folder gives, without additional ACLs. No environment variable overrides
these headers. Saving them makes no test request. They are read again when sending and never appear in command
output, logs, queue files, sender state, the ledger or anonymous telemetry.
Headers are read and parsed before claiming a batch. An invalid saved value leaves the batch queued, records
`headers_invalid` and stops the sender; status reports `headers: "invalid"` until the person fixes the saved list.

## Resource and encoding

Trace and log batches from a process share this resource:

| Attribute | Value |
|---|---|
| `service.name` | `routr` |
| `service.version` | The running routr version |
| `os.type` | The OpenTelemetry operating system value, such as `darwin`, `linux` or `windows` |
| `service.instance.id` | One random UUIDv4 per routr process, kept only in memory; different processes have different ids |

This follows core semantic conventions v1.44.0: each application process is its own service instance. Creating a
trace or log resource writes no identity file. For a gauge stream, the instance id is a UUIDv5 derived from a random
per-install id, under the convention's namespace `4d63009a-8d0f-11ee-aad7-4c796ed8e320`, to keep one stream per
install across sender processes. That per-install file is created exclusively, only for the gauge, in an existing
state folder. Its creation never makes folders or writes while uninstall is running. Only the sender creates it when sending a gauge point.

No hostname or username is added. The Signals section below pins the resource schema URL and the mixed
`routr.otel.schema` identity. Encoding uses the OTLP JSON mapping: hexadecimal trace/span ids, decimal-string
nanoseconds, lowerCamelCase fields, integer enums, and resource, scope and AnyValue nesting. Delivery sends the
queued trace and log JSON bytes unchanged; the sender turns metric observations into OTLP gauge requests.

## Delivery

Commands atomically write a trace batch, an optional log batch and one file per usage-window observation under `~/.cache/routr/otel/<signal>`, then may start the detached
sender. A queue file's name is `<time>-<nonce8>-<uuid>.json`; consent never enters the request body. Commands take
no queue lock, never delete batches or update counters, never wait for the sender, and make no delivery network
call themselves. With export off, the command API creates no files and starts no process. Queue writes do not
create missing folders, so uninstall cannot be undone by a late command write. A write failure never changes the
command's result.

Each signal has a 10 MiB and seven-day cap. Commands queue normally, and the sender removes the oldest files first
when over either cap. At the 20 MiB hard ceiling a command drops its own batch and tries to leave a small drop
marker containing only a fixed code. A failed write also tries a marker; if the disk cannot hold that either,
nothing is written or counted. Queue ages use file times; clock jumps can change which files count as old.

One sender holds an exclusive lock. It claims a batch by renaming it to `.sending`, and POSTs to the signal's
endpoint with the saved headers, `Content-Type: application/json` and `Accept-Encoding: identity`. Each request
has a 10 s deadline including connection and response reading. Redirects are never followed.

- A 2xx accepts and removes the batch. A partial success with rejected records counts `rejected`; zero rejected
  records with an error message counts `partial_warning`, without retaining that message.
- A body larger than 64 KiB or an unreadable 2xx response counts `response_unreadable` and is still accepted.
- 429, 502, 503, 504, network errors and timeouts return the file to the queue. Exponential backoff starts at one
  second, doubles to a base of 60 seconds, and adds 20% jitter either way. `Retry-After` can extend it up to one hour.
  The attempt and next-attempt time persist across sender restarts. A saved deadline more than an hour ahead is
  stale and ignored, including after a backward clock jump. A later emitting command starts another attempt when due.
- Other statuses drop the batch and count its fixed HTTP code. Response bodies are never stored.

The sender proves it can save its state before sending and stops if a state write fails. It alone folds drop
markers into lifetime totals, removes old-consent batches, applies caps and removes its abandoned atomic temporary
files older than an hour. It sweeps on taking the lock and before exit. Only its own batch and temporary filename
patterns are removed. On taking the lock it returns every owned `.sending` file to the queue, without an age rule;
a held lock protects an active sender's claim. A lock older than five minutes is stale even if its recorded pid
exists. Takeovers are serialized by a short-lived exclusive guard. A holder paused past five seconds can lose its
takeover to another process, just as an abandoned guard can be taken over.
Only its holder judges and moves a stale lock; a moved file is deleted only after its contents match the stale
generation observed. This needs no hard links. A random token proves ownership before claims, state writes,
deletes and release; an owner that lost its token stops before its next action. This cannot cancel an HTTP request
already in flight.
An unreadable or unparseable config is never interpreted as consent being removed: the sender keeps the batches
and stops. Before treating a missing config as export being off and sweeping batches, the sender waits about
250 ms and reads again, allowing for an editor's brief rename while saving. Setup publishes its config atomically
as indented JSON for hand editing; a failed replacement keeps the previous file and reports the error. An accepted
batch is recorded and removed before the next config read; a failed read then stops the sender without resending
that batch.

The sender exits when empty, backing off, export is off, or its life reaches about a minute. An in-flight request
can add its 10 s deadline. After releasing its lock it scans again for a command that arrived during exit, keeping
the same lifetime limit. With export off it makes one more sweep-only pass, without sending, to remove a batch
that arrived during release. Both wall-clock and monotonic elapsed time bound its life, including laptop sleep.
There is no daemon waiting for future batches.

A crash after acceptance can resend a batch with the same ids. Delivery can therefore duplicate records, including
counts or duration aggregates a receiver derives from spans. No exactly-once claim is made.

Uninstall reports a running sender and sets a lock that the sender checks before each request and state write.
A request already in flight can finish within its deadline. Removed folders are never recreated by its writes.
A removal race can show FAILED with ENOTEMPTY; run uninstall again to finish it. On Windows the binary can be
removed once that sender exits, about a minute. Uninstall reports that path as `kept_binary` and says removal is
waiting; it does not claim routr is uninstalled while the binary remains. `kept_files` is only for user files in
routr's skill folders.

## Status

`routr doctor` and `routr setup --show` report the same `otel` object; reading it changes nothing:

| Field | Meaning |
|---|---|
| `on`, `why_off` | Whether this process may export; null off reason when on |
| `endpoint_origin` | Only the scheme, hostname and port; no path |
| `headers` | `set`, `not set` or `invalid`, never their values |
| `can_queue`, `queue_error` | Whether this process can queue; a fixed repair sentence when enabled queue folders are missing/unreadable or uninstall is running, otherwise null |
| `last_export` | null, or `{ at, ok, sent, refused, error }`: ISO time, accepted status, batches sent, batches refused, fixed failure code |
| `queued_files` | Waiting files across traces, logs and metrics, excluding temporary files and in-flight claims |
| `oldest_age_sec` | Oldest waiting file's age, clamped at zero, or null |
| `dropped_total` | Lifetime lost batches and explicitly rejected records |
| `dropped_by_code` | Lifetime counts by code; `partial_warning` and `response_unreadable` are additional diagnostics and do not increase `dropped_total` |

Drop codes are `ceiling`, `write_failed`, `consent`, `cap`, `invalid_observation`, `rejected` and `http_<status>`. The last export's error
can be `http_<status>`, `network`, `timeout`, `headers_invalid` or `gauge_identity_unavailable`. `sent` and `refused` count batches only: partial
success counts as one sent batch and zero refused batches; rejected record counts go in `dropped_by_code.rejected`.
Headers are reported as set only when the saved list can be read and validated. A fresh install has no last export,
no oldest age and zero totals.

## Signals

routr emits traces from `dispatch`, `subagent`, `check`, `usage`, `launch`, `send`, `wait`, `workers`, `stop`,
`cleanup` and `record`. `statusline` and housekeeping commands (setup, doctor, key, update, uninstall, telemetry,
share, assess, feedback and skill installation) and detached `usage --background` refreshes emit nothing.
Headless holders emit one `invoke_agent` span per completed turn, with structured lifecycle logs. Commands also queue structured logs and fresh usage-window observations.

The GenAI convention is pinned to `open-telemetry/semantic-conventions-genai`
`9ffc7e00c639be7712e544e3e54331e885dccf84` (2026-10-21), whose manifest depends on core semantic conventions
v1.44.0. The resource has `schemaUrl: https://opentelemetry.io/schemas/1.44.0`. The instrumentation scope has **no
schema URL**: no published schema describes that GenAI commit together with routr's attributes; GenAI's README
schema guidance at the pin is still TODO. The resource attribute `routr.otel.schema` identifies the mixed schema as
`genai@9ffc7e00;semconv@1.44.0;routr@1`. The resource above accompanies every span; the scope is `routr`, with its
running version. Each process has its own `service.instance.id`, without an identity file.

### Parentage and workers

Sampling is ParentBased(AlwaysOn). A valid inherited `TRACEPARENT` supplies a command's parent. The W3C parser
rejects version ff, uppercase hex, malformed fields and all-zero ids; v00 has exactly four fields, while a higher
version can append fields after the first four. An absent or invalid parent starts a sampled trace; its inherited
`TRACESTATE` is then dropped. A valid unsampled parent produces no traces, logs or launch index and retains its carriers
unchanged. Transport limits still apply ([guarantees](guarantees.md#trace-context)).

With export on and a sampled launch, workers get `TRACEPARENT` naming `routr launch`. Valid-parent `TRACESTATE` and
`BAGGAGE` pass unchanged; routr adds no baggage member. Export off, including either process off switch, keeps
pass-through behavior. Headless workers' first process (except Cursor) and pane workers get this launch context. Existing panes
and adopted agents keep their own environment; launch says it passed none. Every pane routr opens sets **all three
carrier names**, empty where none is passed. A herdr worktree's first pane comes from the server environment,
which can hold stale context; routr replaces it with a pane carrying these explicit entries before starting the
worker. Shell startup files may still change the environment.

Headless turn lineage is **lead → routr launch → invoke_agent turns**, with later routr commands linked to the
launch. A holder uses only the launch context saved in its worker settings, never the sender's or lead's current
carriers. The worker's `launch` metadata distinguishes three cases: a recorded launch saves
`{ launch_id, traceId, spanId }`; an enabled launch whose parent was unsampled saves `{ sampled: false }`;
a launch with export off saves no `launch` field. Recorded launches keep their child turns. An unsampled launch
keeps its sampling decision across export off/on: its turn traces and logs stay off, and its saved carriers pass unchanged.
When a worker was launched with export off, its saved valid `TRACEPARENT` still supplies ParentBased sampling:
an unsampled parent keeps every later turn's traces and logs silent, and a sampled parent parents later turns directly, without a
recorded launch between them. Only an absent or invalid saved parent starts a separate sampled root for each
turn after opt-in, ParentBased(AlwaysOn) with no parent. These turns have no `routr.launch.id`.
This also applies to older worker settings with no `launch` field. Each turn captures fresh export
state and consent; its queue call re-reads them before writing. A holder started while export is off can emit
turns begun after it is enabled. A turn whose consent changed writes nothing. Each finished turn writes its own
batch after its report and outcome are saved, in a deferred callback while the holder is alive; export failure
never changes its outcome or waits on network delivery. Git identity is read lazily for the first generated
turn and cached for that holder; an export-off holder runs no identity git reads. A message taken into a running
turn adds to that turn, without creating another span.
Spans remain in memory until queued: killing a holder loses its unqueued spans, including its in-flight turn's
span. The next holder marks that interrupted turn `no_finish` in local state and does not reconstruct its span.

The process environment carries the span that started that process: the launch for the first process, and the
turn for a later process resuming the session. When no launch context was recorded, a process started for a
recorded turn gets that turn's span. Cursor starts a process per turn and gets that turn's span even
for its first process. A running process keeps its original environment. Codex's requests carry the current
turn's `trace: {traceparent, tracestate}`, which takes precedence over the environment. Kiro's `session/prompt`
carries the turn through ACP's reserved `_meta.traceparent`, `_meta.tracestate` and `_meta.baggage`; `session/new`
and `session/load` carry the process's context there. These protocol fields are sent only for context routr
generated: a turn span, or the recorded launch span for the first process. With export off or an unsampled
parent, requests carry neither Codex `trace` nor Kiro `_meta`; their process environments retain the saved
carriers unchanged. Absent carriers are omitted. `TRACESTATE` is forwarded only with a
valid inherited parent when routr generates context, and `BAGGAGE` remains unchanged.

With its own tracing enabled, headless Claude nests under the span that started its process: the launch
initially, or the resuming turn after a restart; a process started for a recorded turn nests under that turn. Codex
nests under each turn through its request field. Cursor,
Antigravity and Kiro read no context in the researched versions, so their own telemetry, if any, is not joined.
ACP reserves the keys routr sends to Kiro; research finds that Kiro does not read them.
The lead measured request acceptance on 2026-10-25 without sending a prompt: Codex 0.164.0 `codex app-server`
answered `initialize` and `thread/start` normally with request-level `trace: {traceparent, tracestate}`;
Kiro 2.34.0 `kiro-cli acp` answered `session/new` normally with
`_meta: {traceparent, tracestate, baggage}`. This measures acceptance, not joined telemetry. Acceptance with
these fields on other methods, including `turn/start` and `session/prompt`, is unmeasured; no prompt was sent
because it would spend usage. Codex reading the request context is established by source research; Kiro does
not read context, per the binary research. Routr's fixture tests verify the channels it writes. Each
harness reads inherited context differently, by mode: [measured harness reference](../skills/routr/references/harnesses.md#trace-context-each-harness-reads).
Routr does not enable or configure a harness's telemetry. Pane workers have no turn span in routr: their launch
places them by repository, branch and worktree, which a receiver can join to that harness's session. At launch end
and cleanup, routr reads herdr's `agent_session` once; a validated non-null `id` becomes `gen_ai.conversation.id` on
that command. The hook can lag or report null; routr never waits for an id.

`routr.lead.session_id` is the lead's id, separate from the worker's conversation. Routr checks the measured
Claude Code, Codex, Cursor and Antigravity environment sources first. If none is valid, `--lead-session` on
`dispatch`, `subagent` or `launch` can supply a known UUIDv4, UUIDv7 or lowercase hexadecimal id of 16–64 characters.
In inline advice, only a valid id is consumed; otherwise the flag and following words stay in the brief with a
flag-like note. Launch and file-based advice ignore malformed values with a fixed warning. An absent id is omitted;
no session id is invented. Kiro has no measured ambient source. Formats and measurement dates are in the harness
reference.

### Spans

All command spans are INTERNAL (kind 1); decision calls and headless turns are CLIENT (kind 3). A successful operation leaves status
unset. Exported spans carry no `traceState`; inherited `TRACESTATE` is forwarded only to workers. A final failure
sets ERROR (code 2) and a classified `error.type`; retries or an earlier failed provider
recovered by a backup do not mark the recovered operation as failed. No exception or provider wording is exported.
Decision providers are `typesafe`, `cloudflare` and `ollama`, describing the platform routr contacted, not the
model's author. Worker invocation spans use Claude Code `anthropic`, Codex `openai`, Cursor `cursor`,
Antigravity `gcp.gen_ai` and Kiro `kiro` as routr's best knowledge of the platform, rather than the model's author.
CLIENT is routr's reading of “invocation over a remote service” for a separate local process speaking the harness's
protocol; it is not an upstream measurement of local IPC.

| Span | Kind | Parent / links | Attributes beyond identity |
|---|---|---|---|
| `routr dispatch`, `routr subagent` | INTERNAL | inherited or new root | question-set version; assessment probabilities, level score and work type; candidate subscription names; unavailable codes; lead session id |
| `classify {gen_ai.request.model}` | CLIENT | decision command | operation `classify` (a custom operation: System One is not a chat-completion API), provider, requested model, reply-named model, observed token usage, final error type |
| `routr check` | INTERNAL | inherited or new root; classify child | question-set version; check probabilities; flag codes; unavailable codes |
| `routr usage` | INTERNAL | inherited or new root | level only when explicitly given; per-subscription reading children |
| `routr usage {subscription}` | INTERNAL | reading command | subscription, usage state and source; final error type |
| `routr launch` | INTERNAL | inherited or new root; recovery rerun links to original launch | kind, backend, launch state and id, worker name, model as given, effort, advice match, lead session, forwarded carrier names, available pane conversation id |
| `invoke_agent {gen_ai.agent.name}` | CLIENT | saved `routr launch`; otherwise saved sampled parent, or a new root without a valid parent | `vcs.repository.url.full`, `vcs.ref.head.name`, `routr.cwd`, `routr.worktree`; `gen_ai.operation.name=invoke_agent`, `gen_ai.provider.name`, `gen_ai.agent.name`, available `gen_ai.conversation.id`; `routr.kind`, `routr.backend=headless`, available `routr.launch.id`, `routr.model`, `routr.effort`, `routr.turn`, `routr.turn.outcome`, `routr.turn.messages`; final `error.type`; classified observed `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.usage.reasoning.output_tokens` only (current adapters expose none). |
| `routr send` | INTERNAL | inherited or new root; matched launch link | send state |
| `routr wait` | INTERNAL | inherited or new root; link per matched launch | wait state |
| `routr workers` | INTERNAL | inherited or new root; link per matched launch | workers state |
| `routr stop` | INTERNAL | inherited or new root; matched launch link | stop state |
| `routr cleanup` | INTERNAL | inherited or new root; matched launch link | cleanup state; available pane conversation id |
| `routr record` | INTERNAL | inherited or new root; unique advice launch link | record state; exact outcome projection below |

`gen_ai.request.model` belongs only to the classify span. The launch and turn model selector is `routr.model`, shape-checked as a
worker model is in anonymous telemetry, rather than validated against a model registry. The requested decision
model and a provider-recognized model **named in its reply** are distinct; routr never echoes the request as
`gen_ai.response.model`. Unknown token counts are omitted, never fabricated as zero. Observed input and output
counts may be zero; cache and reasoning detail counts are emitted only when positive. Turn counts are accepted
only from already-classified adapter events; routr parses no additional harness text for token usage. Current
adapters expose no classified token counts, so their turn spans omit usage. Cache counts are part of
input and reasoning counts part of output; no total token attribute is emitted.

`record` projects exactly verdict, check, level, attempts, seconds, causes, subscription, resolved effort,
`effort_from` and advice id, alongside identity and command state. It shares anonymous telemetry's pick/shape
helpers: unknown enum values become `other`. No record model, note, report, subagent text, run id or ledger path
is sent. A worker verdict of partial or blocked is data about the run, not failure of a successful record command.

### Launch index

Only an exporting, sampled launch that started a pane or headless worker (`ready`, `prompted` or `needs_input`)
with a queued span writes `~/.local/state/routr/launches/<UUIDv4>.json` (0600,
folder 0700 on macOS/Linux; existing Windows home permissions apply). It holds the launch/advice ids, backend,
canonical repository URL, hash of git's common directory, branch, hash of the native real worktree path, pane and
terminal ids, trace/span ids, creation time and eventually a cleanup time. Native paths are not stored
there. Headless `worker.json` also stores that launch context, revalidated before linking.

Dry runs, failed and refused launches create no index entry. Cleanup queries exclude finished entries; record
queries retain them. Later commands link only on exactly one match: record by its eight-character advice id; cleanup
by project hash plus branch, native real path hash, or pane id **and current terminal id**. A pane's terminal id proves terminal
continuity only, never the same process, agent or conversation; restore assigns a new terminal id. Zero matches,
ambiguous advice, reused panes or a wrong repository give no link. Headless commands use their worker's saved
launch context. Links carry only trace/span ids. `record` can link after cleanup, including revisions.

A `--pane` recovery rerun reuses an unfinished entry only for the same advice, pane and terminal. It emits a new
command span linked to the original launch; it never replaces that entry's original context. A new terminal or
advice creates a new launch entry. Cleanup marks `finished_at` rather than deleting entries. Launch and the sender
sweep entries 30 days after creation and only remove routr's UUID filenames. Export off and unsampled commands
write no index. Missing folders, revoked consent, uninstall and write failures never change command results.

### Attribute allow-list

Each name below has one wire type. Every span also carries the available repository identity: a credential-free
canonical HTTPS repository URL without `.git` (known SSH remotes are converted; unsafe forms omitted), branch only
when on a branch, cwd relative to its checkout, and worktree relative to the project root when inside it or its
name otherwise. Outside a repository, path attributes are omitted. Absolute paths and detached-HEAD ref names are
never sent. Repository names, relative paths and ids **are sent** to your endpoint; anonymous telemetry does not
send them. Model/effort and outcome fields typed by a lead are projected through the shared pick/shape checks.

<!-- span-attributes -->
| Attribute | Type | Meaning |
|---|---|---|
| `service.name` | `string` | `routr`. |
| `service.version` | `string` | The running routr version; source checkouts use `0.0.0-dev`. |
| `os.type` | `string` | OpenTelemetry OS name: `darwin`, `linux`, `windows`, `freebsd`, `openbsd`, `solaris`, `aix` or `unknown`. |
| `service.instance.id` | `string` | Traces/logs: random UUIDv4 per process, only in memory. Gauge: UUIDv5 derived from the per-install id. |
| `routr.otel.schema` | `string` | `genai@9ffc7e00;semconv@1.44.0;routr@1`. |
| `routr.lead.session_id` | `string` | Validated lead UUIDv4, UUIDv7 or 16–64 lowercase hex characters; measured environment source before explicit flag. |
| `routr.question_set.version` | `string` | Question-set version: `r` or `c` followed by 1–3 digits; invalid values become `other`. |
| `routr.candidates` | `string[]` | Candidate subscription names: `claude`, `codex`, `cursor`, `agy`, `kiro`; unknown names become `other`. |
| `routr.unavailable` | `string[]` | Classified failure codes from the Span error codes list below; unknown values become `other`. |
| `vcs.repository.url.full` | `string` | Credential-free canonical HTTPS repository URL, without `.git`; unsafe remotes omitted. |
| `vcs.ref.head.name` | `string` | Git branch name; omitted at detached HEAD. |
| `routr.cwd` | `string` | Real cwd relative to git checkout root, using `/`; `.` for root; omitted outside a repository. |
| `routr.worktree` | `string` | Worktree relative to project root when inside it; otherwise its folder name; no absolute path. |
| `routr.kind` | `string` | Worker harness: `claude`, `codex`, `cursor`, `agy`, `kiro`; unknown becomes `other`. |
| `routr.backend` | `string` | `pane` or `headless`. |
| `routr.launch.id` | `string` | UUIDv4 identifying a sampled launch; recovery reruns reuse the original id. |
| `gen_ai.agent.name` | `string` | Worker name matching `[a-z][a-z0-9_-]{0,31}`; invalid names omitted. |
| `gen_ai.conversation.id` | `string` | On commands, herdr agent_session of kind `id`, validated as UUIDv4, UUIDv7 or 16–64 lowercase hex characters; on turns, the harness UUID the adapter already reads; omitted when unavailable. |
| `routr.model` | `string` | Worker model, 1–48 characters matching `[A-Za-z0-9][A-Za-z0-9.:[\]-]*`, without 17 consecutive alphanumerics; invalid becomes `other`. |
| `routr.turn` | `int` | Headless turn number, starting at 1. |
| `routr.turn.outcome` | `string` | `finished`, `failed`, `not_started`, `no_finish`, `stopped`; unknown becomes `other`. |
| `routr.turn.messages` | `int` | Messages taken into the turn: its task or resume prompt plus delivered follow-ups; automatic harness turns can have zero. |
| `routr.advice.matched` | `boolean` | Whether supplied advice matched the task (`true` or `false`); omitted if no match result. |
| `routr.carriers.forwarded` | `string[]` | Names passed to a new worker: `TRACEPARENT`, `TRACESTATE`, `BAGGAGE`; never their values. |
| `routr.assessment.names_location` | `double` | Probability, 0–1, for the fixed `names_location` question. |
| `routr.assessment.approach_open` | `double` | Probability, 0–1, for the fixed `approach_open` question. |
| `routr.assessment.cause_unknown` | `double` | Probability, 0–1, for the fixed `cause_unknown` question. |
| `routr.assessment.cross_cutting` | `double` | Probability, 0–1, for the fixed `cross_cutting` question. |
| `routr.assessment.concurrency_or_data` | `double` | Probability, 0–1, for the fixed `concurrency_or_data` question. |
| `routr.assessment.hard_to_reverse` | `double` | Probability, 0–1, for the fixed `hard_to_reverse` question. |
| `routr.assessment.tiny` | `double` | Probability, 0–1, for the fixed `tiny` question. |
| `routr.assessment.separable` | `double` | Probability, 0–1, for the fixed `separable` question. |
| `routr.assessment.needs_user` | `double` | Probability, 0–1, for the fixed `needs_user` question. |
| `routr.assessment.states_check` | `double` | Probability, 0–1, for the fixed `states_check` question. |
| `routr.assessment.standalone` | `double` | Probability, 0–1, for the fixed `standalone` question. |
| `routr.assessment.level` | `double` | Expected assessment level score, 0–2. |
| `routr.assessment.high_blast_radius` | `double` | Probability, 0–1, that a wrong change affects many users, machines or persisted data. |
| `routr.assessment.work_type` | `string` | `implement`, `debug`, `refactor`, `review`, `research`, `test_writing`, `docs`; unknown becomes `other`. |
| `routr.check.states_verification` | `double` | Probability, 0–1, for the fixed `states_verification` question. |
| `routr.check.covers_brief` | `double` | Probability, 0–1, for the fixed `covers_brief` question. |
| `routr.check.admits_gaps` | `double` | Probability, 0–1, for the fixed `admits_gaps` question. |
| `routr.check.symptom_patch` | `double` | Probability, 0–1, for the fixed `symptom_patch` question. |
| `routr.check.out_of_scope` | `double` | Probability, 0–1, for the fixed `out_of_scope` question. |
| `routr.check.flags` | `string[]` | Question names `states_verification`, `covers_brief`, `admits_gaps`, `symptom_patch`, `out_of_scope` when flagged; also `verdict_partial`, `verdict_blocked`, `verdict_unstated`. |
| `gen_ai.operation.name` | `string` | `classify`, routr’s custom System One operation, or `invoke_agent` for a headless turn. |
| `gen_ai.provider.name` | `string` | Decision platform: `typesafe`, `cloudflare`, `ollama`; worker platform: `anthropic`, `openai`, `cursor`, `gcp.gen_ai`, `kiro`; unknown becomes `other`. |
| `gen_ai.request.model` | `string` | Requested decision model from the provider registry, or the shared worker-model shape; invalid becomes `other`. |
| `gen_ai.response.model` | `string` | Model explicitly named by the provider reply, checked against the registry or shared model shape; absent unless observed, invalid becomes `other`. |
| `gen_ai.usage.input_tokens` | `int` | Observed nonnegative integer input token count. |
| `gen_ai.usage.output_tokens` | `int` | Observed nonnegative integer output token count. |
| `gen_ai.usage.cache_read.input_tokens` | `int` | Observed positive integer cache-read input tokens, part of input count. |
| `gen_ai.usage.cache_write.input_tokens` | `int` | Observed positive integer cache-write input tokens, part of input count. |
| `gen_ai.usage.reasoning.output_tokens` | `int` | Observed positive integer reasoning output tokens, part of output count. |
| `routr.usage.state` | `string` | `excluded`, `kept`, `given`, `live` or `assumed`. |
| `routr.usage.source` | `string` | `claude /usage`, `app-server`, `cursor /usage`, `agy /usage`, `kiro /usage`, `sign-in check`, `given by caller`, `none`, `statusline`, `session log`; unknown becomes `other`. |
| `routr.launch.state` | `string` | Classified launch outcome: `planned`, `ready`, `prompted`, `needs_input`, `failed`, `refused`, `none`, `finished`, `running`, `idle`, `resumed`, `queued`, `delivered`, `unknown`, `stopped`, `absent`, `listed`, `closed`, `removed`, `done`; unrecognized states become `other`. |
| `routr.send.state` | `string` | Classified send outcome: `planned`, `ready`, `prompted`, `needs_input`, `failed`, `refused`, `none`, `finished`, `running`, `idle`, `resumed`, `queued`, `delivered`, `unknown`, `stopped`, `absent`, `listed`, `closed`, `removed`, `done`; unrecognized states become `other`. |
| `routr.wait.state` | `string` | Classified wait outcome: `planned`, `ready`, `prompted`, `needs_input`, `failed`, `refused`, `none`, `finished`, `running`, `idle`, `resumed`, `queued`, `delivered`, `unknown`, `stopped`, `absent`, `listed`, `closed`, `removed`, `done`; unrecognized states become `other`. |
| `routr.workers.state` | `string` | Classified workers outcome: `planned`, `ready`, `prompted`, `needs_input`, `failed`, `refused`, `none`, `finished`, `running`, `idle`, `resumed`, `queued`, `delivered`, `unknown`, `stopped`, `absent`, `listed`, `closed`, `removed`, `done`; unrecognized states become `other`. |
| `routr.stop.state` | `string` | Classified stop outcome: `planned`, `ready`, `prompted`, `needs_input`, `failed`, `refused`, `none`, `finished`, `running`, `idle`, `resumed`, `queued`, `delivered`, `unknown`, `stopped`, `absent`, `listed`, `closed`, `removed`, `done`; unrecognized states become `other`. |
| `routr.cleanup.state` | `string` | Classified cleanup outcome: `planned`, `ready`, `prompted`, `needs_input`, `failed`, `refused`, `none`, `finished`, `running`, `idle`, `resumed`, `queued`, `delivered`, `unknown`, `stopped`, `absent`, `listed`, `closed`, `removed`, `done`; unrecognized states become `other`. |
| `routr.record.state` | `string` | Classified record outcome: `planned`, `ready`, `prompted`, `needs_input`, `failed`, `refused`, `none`, `finished`, `running`, `idle`, `resumed`, `queued`, `delivered`, `unknown`, `stopped`, `absent`, `listed`, `closed`, `removed`, `done`; unrecognized states become `other`. |
| `routr.verdict` | `string` | `done`, `partial`, `blocked`, `unknown`; unknown enum values become `other`. |
| `routr.check` | `string` | `pass`, `fail`, `none`; unknown becomes `other`. |
| `routr.level` | `string` | `basic`, `standard` or `strong`; unknown becomes `other`. |
| `routr.attempts` | `int` | Observed positive safe integer attempt count, omitted unless supplied. |
| `routr.seconds` | `double` | Observed finite nonnegative elapsed seconds from record, omitted unless supplied. |
| `routr.causes` | `string[]` | `execution`, `brief`, `scope`, `review`, `launch`, `unknown`; unknown values become `other`; `none` resolves to an empty array. |
| `routr.subscription` | `string` | `claude`, `codex`, `cursor`, `agy`, `kiro`; unknown becomes `other`. |
| `routr.effort` | `string` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `auto`, `default`; unknown becomes `other`. |
| `routr.effort_from` | `string` | Resolved record effort origin: `given`, `model id`, `config default`; unknown becomes `other`. |
| `routr.advice.id` | `string` | Eight lowercase hexadecimal characters; invalid ids omitted. |
| `error.type` | `string` | Classified code from Span error codes below; unclassified errors become `_OTHER`. |
<!-- /span-attributes -->

### Span error codes

<!-- span-errors -->
`no_key`, `secrets_unreadable`, `key_refused`, `model_missing`, `model_unsupported`, `timeout`, `unreachable`, `provider_error`, `invalid_response`, `daily_allowance`, `internal_error`, `attempt_unknown`, `read_failed`, `no_response`, `private_folder`, `source_missing`, `cmd_path`, `unreadable`, `refused`, `failed`, `not_started`, `no_finish`, `stopped`, `_OTHER`
<!-- /span-errors -->

Decision codes describe missing/refused keys, unreadable secrets, missing/unsupported models, allowance, timeout,
reachability, provider status, invalid response and internal errors. Usage codes describe missing/unreadable
sources, no response, private-folder and cmd-path failures. `unreadable` covers required files, `refused` a refused
operation, `failed` a classified command or turn failure, `not_started` a harness that did not start,
`no_finish` a harness that ended without a turn result, `stopped` a stopped turn, and `_OTHER` any unclassified error. Codes contain no error text.

Assessment fact and check probabilities range from 0 to 1; the assessment level score ranges from 0 to 2. Work
types and flags come from routr's fixed question set. Check flag codes are the check question names in the table,
plus `verdict_partial`, `verdict_blocked` and `verdict_unstated` for a report that does not claim done. Candidates and subscription are harness registry names.
Usage state is `excluded`, `kept`, `given`, `live` or `assumed`; source is a registered usage source, `sign-in check`,
`given by caller`, `statusline`, `session log`, `none` or `other`. Backend is `pane` or `headless`. Command states come from their documented
outcomes, with `done`/`failed` when the command has no separate state. Effort and outcome enum values match
[anonymous telemetry's projection](telemetry.md), with causes from record's contract and effort origin `given`,
`model id` or `config default`. IDs are format-checked. Missing optional attributes are omitted.

### Logs

Each custom event is one OTLP LogRecord sent to `/v1/logs` in an `ExportLogsServiceRequest`. Its name is in
`eventName`, never in the deprecated `event.name` attribute. Its body is absent (empty). `traceId` and `spanId`
identify the span where it happened; `timeUnixNano` and `observedTimeUnixNano` are equal decimal-string timestamps,
and `flags` comes from that span. Logs share the process resource,
scope and identity projection with spans. Identity attributes, when available, are repository, branch, relative cwd,
worktree, lead session, harness kind, backend, launch id, agent name, conversation id and turn number, with the same
shape checks as spans. There is no warning text, why text, harness output or exception message.

<!-- log-events -->
| Event | Severity | Fixed attributes |
|---|---|---|
| `routr.needs_input` | WARN (13) | `routr.needs_input.why` |
| `routr.warning` | WARN (13) | `routr.warning.code` |
| `routr.usage.failed` | WARN (13) | `error.type`, `routr.subscription` |
| `routr.worker.state` | INFO (9) | `routr.worker.state.from`, `routr.worker.state.to` |
<!-- /log-events -->

| Attribute | Type | Values |
|---|---|---|
| `routr.needs_input.why` | `string` | `shell_not_ready`, `startup_question`, `worker_busy`, `wrong_harness`, `wrong_folder`, `identity_unknown`, `worker_question`, `start_unconfirmed`. |
| `routr.warning.code` | `string` | One code from the warning table below, assigned where the warning is made. |
| `routr.worker.state.from` | `string` | Previous holder state: `starting`, `working`, `waiting`, `idle`, `failed`, `stopped`, `no_task`. |
| `routr.worker.state.to` | `string` | New holder state, from the same list. Equal states emit nothing. |

Input events describe launch refusals that need the shell, startup question or worker resolved, including a worker's
question after its prompt. Usage failures correlate with the subscription's usage child span, including a failed
refresh recovered with a kept reading. Their `error.type` is one of the classified usage failure codes, with
unrecognized failures becoming `read_failed`. A kept reading's span can succeed while its failure event records the
refresh. Warnings emit once per warning in command output. Unknown caller-supplied warning strings are omitted.

Holder transitions come from the holder's state changes, buffered with their times until the turn finishes and
written beside that turn's spans. A settlement after completion emits another log batch correlated with that same
turn. Turns and command batches re-check consent before each signal write. Events follow trace sampling: an
unsampled parent records no spans or logs. Metrics do not follow trace sampling. Housekeeping commands and
`statusline` emit no signals.

### Warning codes

Only these fixed codes are sent; the warning's displayed text stays local. Codes cover every shipped warning
producer, including config and input notes forwarded into `warnings`.

<!-- warning-codes -->
| Code | Meaning |
|---|---|
| `config_missing` | No config; defaults used. |
| `config_unreadable` | Config unreadable; defaults used. |
| `config_share` | Invalid share; default used. |
| `config_channel` | Invalid update channel. |
| `config_otel` | Invalid export setting. |
| `config_prefer` | Invalid preferred level. |
| `config_hardest` | Missing or invalid hardest work. |
| `config_reserve` | Missing or invalid reserve. |
| `config_choice` | Invalid subscription choice. |
| `config_enabled` | Invalid enabled setting. |
| `decision_dropped` | Invalid or duplicate decision entry dropped. |
| `headroom_ignored` | Invalid headroom input ignored. |
| `lead_session_ignored` | Invalid lead session ignored. |
| `brief_flag` | Flag-like brief input. |
| `report_short` | Report is very short. |
| `advice_unchecked` | Advice not checked against a task. |
| `usage_stale` | Usage reader has stopped working. |
| `kiro_session_left` | Kiro kept an empty usage session. |
| `subscription_unconfigured` | Subscription is not configured. |
| `model_required` | Plan needs a model. |
| `cursor_private_config` | Cursor uses a private config. |
| `kiro_effort_default` | Kiro remembers effort. |
| `carrier_withheld` | Carrier exceeds forwarding limits. |
| `launch_parent_replaced` | Inherited parent replaced by launch span. |
| `carriers_not_passed` | Launch passed no carriers to an existing or adopted pane. |
| `sandbox` | Sandbox may limit harness access. |
| `branch_unowned` | Branch ownership cannot be proved. |
| `worktree_left` | Launch worktree was left. |
| `branch_changed` | Launch branch has changed. |
| `copy_missing` | Requested copy source is missing. |
| `messages_dropped` | Stopped worker had queued messages. |
| `process_unseen` | Saved process id cannot prove the harness state. |
| `cleanup_unseen` | Cleanup sees git state only. |
| `other_worktrees` | Repository has other worktrees. |
| `branch_unmerged` | Unmerged branch was kept. |
| `detached_unseen` | Detached commands cannot be seen. |
| `cursor_helper_left` | Cursor owns its worker server. |
| `work_kept` | Worker changes remain in the working folder. |
| `rename_failed` | Adopted agent could not be renamed. |
| `cursor_config_left` | Unused Cursor config could not be removed. |
| `pane_left` | Launch pane was left alive. |
| `cursor_config_retained` | Possible worker still needs Cursor config. |
| `prompt_uncertain` | Prompt may have been submitted. |
<!-- /warning-codes -->

### Subscription headroom

The only metric is custom **`routr.subscription.headroom`**, a Gauge with unit **`1`**, reporting remaining
subscription allowance as a double ratio **0..1**. This name is routr's own, with no upstream stability guarantee.
Counts and durations can be derived by receivers from spans; routr sends no other metrics. With export on, fresh
usage observations are collected regardless of the parent trace's sampling flag; an unsampled parent suppresses
spans and logs, never this gauge. Holders use the same collector for readings they already have; they do not start
subscription reads to manufacture points.

| Attribute | Type | Values |
|---|---|---|
| `routr.subscription` | `string` | Harness registry name: `claude`, `codex`, `cursor`, `agy`, `kiro`. |
| `routr.usage.window` | `string` | `five_hour`, `seven_day`, `spend_limit`, `primary`, `secondary`, `monthly_cap`, `included`, `monthly_credits`, `5h`, `weekly`. No observation is queued for `unknown` or any unrecognized window; unrelated buckets must not share a stream. |

Commands queue each numeric window of a live reading as only `{ subscription, window, value, time }`, with `time`
the source reading's Unix milliseconds, except that a window inferred empty after its reset is stamped at the
reset time. Other windows in that snapshot keep their own source time. No usage note, harness text or resource path
is stored in an observation.
Kept, given, assumed or signed-out readings queue no point. A failed refresh can still leave a live numeric
snapshot; it retains its original reading time and also emits a failure event. Metered/unknown capacity with no
number queues no point. `statusline` queues nothing; a later usage-reading command may observe its fresh snapshot. Missing source
time also queues nothing, rather than inventing a new time for a cached reading.

The sender is the stream's single writer. Under its lock it keeps only the latest observation per subscription and
window, removes folded observations, and skips/removes any reading no newer than that stream's last accepted point.
Watermarks persist in sender state across restarts and consent changes. A reset is a new value on the same stream,
not a new dimension. Its reset timestamp lets it advance beyond the earlier snapshot without back-dating 1.0. Each
point uses `asDouble` and its reading time as `timeUnixNano`; the sender posts an
`ExportMetricsServiceRequest` to `/v1/metrics`. The resource uses the install's gauge UUIDv5, so sender restarts keep
one stream per install/window and two installs differ. No repository/branch dimensions are added to this metric.

The sender resolves the gauge resource before folding or claiming metric files. If the install identity is
unavailable or invalid, it sets `last_export.error: "gauge_identity_unavailable"`, leaves observations queued and
stops; repairing the state folder/id allows a later sender to retry.

The sender saves accepted watermarks before removing claims. A crash before that save can resend the point; a crash
after it skips the recovered observation. Logs and traces can also duplicate after acceptance. Folded and skipped
observations are removed without counting a delivery loss. Invalid observation files count `invalid_observation`.
The same per-signal caps, consent re-checks, lock ownership, partial-success handling and uninstall rules apply.

### Content and delivery limits

Never sent: a brief, report, note, prompt, model reply, pane screen, header value, key, baggage value or other free
text. `TRACEPARENT` ids enter only span parentage, and saved launch context supplies later links. No carrier value
is an attribute or span name. There is no content-capture option. Resource text cannot be supplied through
`OTEL_RESOURCE_ATTRIBUTES`. Trace and log queue files contain complete OTLP requests; metric files contain only
projected observations. Resending can duplicate records with the same trace/span ids. Receivers that count spans or aggregate durations must account for that delivery behavior.

This export has its own setting, consent, state, queue, sender and destination, separate from
[anonymous telemetry](telemetry.md). `bun run smoke:otel` checks decoded fixture traces, logs and the headroom gauge
against a loopback receiver, without a subscription; it can target `ROUTR_SMOKE_OTLP_ENDPOINT`. In live herdr it additionally exercises a fixture
pane. It is an explicit smoke command, never part of `bun test`.

The smoke accepts no arguments and refuses an inherited `ROUTR_SMOKE_OTEL_ACTIVE` marker. It sets that marker in
its own process and children before creating resources. Its pane adapter permits one split attempt and records
ownership immediately, before readiness can fail. The pane half stays in-process because herdr's agent registry
cannot recognize the fixture; it starts the absolute fixture through pane operations, never a real harness.
Teardown closes that pane, stops fixture holders through their channels and kills owned sender/fixture processes.
It then checks process command lines for its exact temp home (including `--otel-sender` and `workers --hold`) and
checks the holder pids recorded in its own claims. Unreadable inventory or a survivor fails the smoke and retains
the home for inspection. A reused pid belonging to another command is never signalled. Success is reported only
after teardown. In-process queueing and every other background caller start routr's own source
entry resolved from its runtime module, or its compiled binary, independently of the importing script.
