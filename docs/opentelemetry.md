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

Export is intended for the default config, `~/.config/routr/config.json`. There is one queue per install, while
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
state folder. Its creation never makes folders or writes while uninstall is running. No gauge is emitted yet.

No hostname or username is added. The Signals section below pins the resource schema URL and the mixed
`routr.otel.schema` identity. Encoding uses the OTLP JSON mapping: hexadecimal trace/span ids, decimal-string
nanoseconds, lowerCamelCase fields, integer enums, and resource, scope and AnyValue nesting. Delivery sends the
queued JSON bytes unchanged.

## Delivery

Commands atomically write one file per signal under `~/.cache/routr/otel/<signal>`, then may start the detached
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
| `queued_files` | Waiting files, excluding temporary files and in-flight claims |
| `oldest_age_sec` | Oldest waiting file's age, clamped at zero, or null |
| `dropped_total` | Lifetime lost batches and explicitly rejected records |
| `dropped_by_code` | Lifetime counts by code; `partial_warning` and `response_unreadable` are additional diagnostics and do not increase `dropped_total` |

Drop codes are `ceiling`, `write_failed`, `consent`, `cap`, `rejected` and `http_<status>`. The last export's error
can be `http_<status>`, `network`, `timeout` or `headers_invalid`. `sent` and `refused` count batches only: partial
success counts as one sent batch and zero refused batches; rejected record counts go in `dropped_by_code.rejected`.
Headers are reported as set only when the saved list can be read and validated. A fresh install has no last export,
no oldest age and zero totals.

## Signals

routr emits traces from `dispatch`, `subagent`, `check`, `usage`, `launch`, `send`, `wait`, `workers`, `stop`,
`cleanup` and `record`. `statusline` and housekeeping commands (setup, doctor, key, update, uninstall, telemetry,
share, assess, feedback and skill installation) emit nothing. No logs, metrics or headless turn spans are emitted yet.

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
`TRACESTATE` is then dropped. A valid unsampled parent produces no records or launch index and retains its carriers
unchanged. Transport limits still apply ([guarantees](guarantees.md#trace-context)).

With export on and a sampled launch, workers get `TRACEPARENT` naming `routr launch`. Valid-parent `TRACESTATE` and
`BAGGAGE` pass unchanged; routr adds no baggage member. Export off, including either process off switch, keeps
pass-through behavior. Headless workers' first process and pane workers get this launch context. Existing panes
and adopted agents keep their own environment; launch says it passed none. Every pane routr opens sets **all three
carrier names**, empty where none is passed. A herdr worktree's first pane comes from the server environment,
which can hold stale context; routr replaces it with a pane carrying these explicit entries before starting the
worker. Shell startup files may still change the environment.

Lineage is **lead → routr launch → worker** by parentage, with later routr commands linked to the launch. Each
harness reads inherited context differently, by mode: [measured harness reference](../skills/routr/references/harnesses.md#trace-context-each-harness-reads).
Routr does not enable or configure a harness's telemetry. Pane workers have no turn span in routr: their launch
places them by repository, branch and worktree, which a receiver can join to that harness's session. At launch end
and cleanup, routr reads herdr's `agent_session` once; a validated non-null `id` becomes `gen_ai.conversation.id` on
that command. The hook can lag or report null; routr never waits for an id.

`routr.lead.session_id` is the lead's id, separate from the worker's conversation. Routr checks the measured
Claude Code, Codex, Cursor and Antigravity environment sources first. If none is valid, `--lead-session` on
`dispatch`, `subagent` or `launch` can supply a known UUIDv4, UUIDv7 or lowercase hexadecimal id of 16–64 characters.
An invalid explicit id is refused; an absent one is omitted. No session id is invented. Kiro has no measured
ambient source. Formats and measurement dates are in the harness reference.

### Spans

All command spans are INTERNAL (kind 1); decision calls are CLIENT (kind 3). A successful operation leaves status
unset. A final failure sets ERROR (code 2) and a classified `error.type`; retries or an earlier failed provider
recovered by a backup do not mark the recovered operation as failed. No exception or provider wording is exported.
Decision providers are `typesafe`, `cloudflare` and `ollama`, describing the platform routr contacted, not the
model's author. Future worker invocation spans will use Claude Code `anthropic`, Codex `openai`, Cursor `cursor`,
Antigravity `gcp.gen_ai` and Kiro `kiro` as routr's best knowledge of the platform; those turn spans are not emitted
in this schema version.

| Span | Kind | Parent / links | Attributes beyond identity |
|---|---|---|---|
| `routr dispatch`, `routr subagent` | INTERNAL | inherited or new root | question-set version; assessment probabilities, level score and work type; candidate subscription names; unavailable codes; lead session id |
| `classify {gen_ai.request.model}` | CLIENT | decision command | operation `classify` (a custom operation: System One is not a chat-completion API), provider, requested model, reply-named model, observed token usage, final error type |
| `routr check` | INTERNAL | inherited or new root; classify child | question-set version; check probabilities; flag codes; unavailable codes |
| `routr usage` | INTERNAL | inherited or new root | level only when explicitly given; per-subscription reading children |
| `routr usage {subscription}` | INTERNAL | reading command | subscription, usage state and source; final error type |
| `routr launch` | INTERNAL | inherited or new root; recovery rerun links to original launch | kind, backend, launch state and id, worker name, model as given, effort, advice match, lead session, forwarded carrier names, available pane conversation id |
| `routr send` | INTERNAL | inherited or new root; matched launch link | send state |
| `routr wait` | INTERNAL | inherited or new root; link per matched launch | wait state |
| `routr workers` | INTERNAL | inherited or new root; link per matched launch | workers state |
| `routr stop` | INTERNAL | inherited or new root; matched launch link | stop state |
| `routr cleanup` | INTERNAL | inherited or new root; matched launch link | cleanup state; available pane conversation id |
| `routr record` | INTERNAL | inherited or new root; unique advice launch link | record state; exact outcome projection below |

`gen_ai.request.model` belongs only to the classify span. The launch model is `routr.model`, shape-checked as a
worker model is in anonymous telemetry, rather than validated against a model registry. The requested decision
model and a provider-recognized model **named in its reply** are distinct; routr never echoes the request as
`gen_ai.response.model`. Unknown token counts are omitted, never fabricated as zero. Observed input and output
counts may be zero; cache and reasoning detail counts are emitted only when positive. Cache counts are part of
input and reasoning counts part of output; no total token attribute is emitted.

`record` projects exactly verdict, check, level, attempts, seconds, causes, subscription, resolved effort,
`effort_from` and advice id, alongside identity and command state. It shares anonymous telemetry's pick/shape
helpers: unknown enum values become `other`. No record model, note, report, subagent text, run id or ledger path
is sent. A worker verdict of partial or blocked is data about the run, not failure of a successful record command.

### Launch index

Only an exporting, sampled launch with a queued span writes `~/.local/state/routr/launches/<UUIDv4>.json` (0600,
folder 0700 on macOS/Linux; existing Windows home permissions apply). It holds the launch/advice ids, backend,
canonical repository URL, hash of git's common directory, branch, hash of the native real worktree path, pane and
terminal ids or worker id, trace/span ids, creation time and eventually a cleanup time. Native paths are not stored
there. Headless `worker.json` also stores that launch context, revalidated before linking.

Later commands link only on exactly one match: record by its eight-character advice id; cleanup by project hash
plus branch, native real path hash, or pane id **and current terminal id**. A pane's terminal id proves terminal
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
| `service.name` | `string` | As defined above |
| `service.version` | `string` | As defined above |
| `os.type` | `string` | As defined above |
| `service.instance.id` | `string` | As defined above |
| `routr.otel.schema` | `string` | As defined above |
| `routr.lead.session_id` | `string` | As defined above |
| `routr.question_set.version` | `string` | As defined above |
| `routr.candidates` | `string[]` | As defined above |
| `routr.unavailable` | `string[]` | As defined above |
| `vcs.repository.url.full` | `string` | As defined above |
| `vcs.ref.head.name` | `string` | As defined above |
| `routr.cwd` | `string` | As defined above |
| `routr.worktree` | `string` | As defined above |
| `routr.kind` | `string` | As defined above |
| `routr.backend` | `string` | As defined above |
| `routr.launch.id` | `string` | As defined above |
| `gen_ai.agent.name` | `string` | As defined above |
| `gen_ai.conversation.id` | `string` | As defined above |
| `routr.model` | `string` | As defined above |
| `routr.advice.matched` | `boolean` | As defined above |
| `routr.carriers.forwarded` | `string[]` | As defined above |
| `routr.assessment.names_location` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.approach_open` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.cause_unknown` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.cross_cutting` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.concurrency_or_data` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.hard_to_reverse` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.tiny` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.separable` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.needs_user` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.states_check` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.standalone` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.level` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.high_blast_radius` | `double` | Assessment score, probability or registered work type |
| `routr.assessment.work_type` | `string` | Assessment score, probability or registered work type |
| `routr.check.states_verification` | `double` | Check probability or classified flag codes |
| `routr.check.covers_brief` | `double` | Check probability or classified flag codes |
| `routr.check.admits_gaps` | `double` | Check probability or classified flag codes |
| `routr.check.symptom_patch` | `double` | Check probability or classified flag codes |
| `routr.check.out_of_scope` | `double` | Check probability or classified flag codes |
| `routr.check.flags` | `string[]` | Check probability or classified flag codes |
| `gen_ai.operation.name` | `string` | As defined above |
| `gen_ai.provider.name` | `string` | As defined above |
| `gen_ai.request.model` | `string` | As defined above |
| `gen_ai.response.model` | `string` | As defined above |
| `gen_ai.usage.input_tokens` | `int` | Observed token count |
| `gen_ai.usage.output_tokens` | `int` | Observed token count |
| `gen_ai.usage.cache_read.input_tokens` | `int` | Observed token count |
| `gen_ai.usage.cache_write.input_tokens` | `int` | Observed token count |
| `gen_ai.usage.reasoning.output_tokens` | `int` | Observed token count |
| `routr.usage.state` | `string` | Classified command or reading outcome |
| `routr.usage.source` | `string` | As defined above |
| `routr.launch.state` | `string` | Classified command or reading outcome |
| `routr.send.state` | `string` | Classified command or reading outcome |
| `routr.wait.state` | `string` | Classified command or reading outcome |
| `routr.workers.state` | `string` | Classified command or reading outcome |
| `routr.stop.state` | `string` | Classified command or reading outcome |
| `routr.cleanup.state` | `string` | Classified command or reading outcome |
| `routr.record.state` | `string` | Classified command or reading outcome |
| `routr.verdict` | `string` | As defined above |
| `routr.check` | `string` | As defined above |
| `routr.level` | `string` | As defined above |
| `routr.attempts` | `int` | As defined above |
| `routr.seconds` | `double` | As defined above |
| `routr.causes` | `string[]` | As defined above |
| `routr.subscription` | `string` | As defined above |
| `routr.effort` | `string` | As defined above |
| `routr.effort_from` | `string` | As defined above |
| `routr.advice.id` | `string` | As defined above |
| `error.type` | `string` | As defined above |
<!-- /span-attributes -->

### Span error codes

<!-- span-errors -->
`no_key`, `secrets_unreadable`, `key_refused`, `model_missing`, `model_unsupported`, `timeout`, `unreachable`, `provider_error`, `invalid_response`, `daily_allowance`, `internal_error`, `attempt_unknown`, `read_failed`, `no_response`, `private_folder`, `source_missing`, `cmd_path`, `unreadable`, `refused`, `failed`, `_OTHER`
<!-- /span-errors -->

Decision codes describe missing/refused keys, unreadable secrets, missing/unsupported models, allowance, timeout,
reachability, provider status, invalid response and internal errors. Usage codes describe missing/unreadable
sources, no response, private-folder and cmd-path failures. `unreadable` covers required files, `refused` a refused
operation, `failed` a classified command failure, and `_OTHER` any unclassified error. Codes contain no error text.

Assessment fact and check probabilities range from 0 to 1; the assessment level score ranges from 0 to 2. Work
types and flags come from routr's fixed question set. Check flag codes are the check question names in the table,
plus `verdict_partial`, `verdict_blocked` and `verdict_unstated` for a report that does not claim done. Candidates and subscription are harness registry names.
Usage state is `excluded`, `kept`, `given`, `live` or `assumed`; source is a registered usage source, `sign-in check`,
`given by caller`, `statusline`, `session log`, `none` or `other`. Backend is `pane` or `headless`. Command states come from their documented
outcomes, with `done`/`failed` when the command has no separate state. Effort and outcome enum values match
[anonymous telemetry's projection](telemetry.md), with causes from record's contract and effort origin `given`,
`model id` or `config default`. IDs are format-checked. Missing optional attributes are omitted.

### Content and delivery limits

Never sent: a brief, report, note, prompt, model reply, pane screen, header value, key, baggage value or other free
text. `TRACEPARENT` ids enter only span parentage, and saved launch context supplies later links. No carrier value
is an attribute or span name. There is no content-capture option. Resource text cannot be supplied through
`OTEL_RESOURCE_ATTRIBUTES`. Queue files contain complete OTLP requests; resending can duplicate records with the
same span ids. Receivers that count spans or aggregate durations must account for that delivery behavior.

This export has its own setting, consent, state, queue, sender and destination, separate from
[anonymous telemetry](telemetry.md). `bun run smoke:otel` checks decoded fixture traces against a loopback receiver,
without a subscription; it can target `ROUTR_SMOKE_OTLP_ENDPOINT`. In live herdr it additionally exercises a fixture
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
