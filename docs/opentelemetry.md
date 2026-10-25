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

No hostname or username is added. The schema URL and the `routr.otel.schema` attribute arrive with the signals in
a later change. Encoding uses the OTLP JSON mapping: hexadecimal trace/span ids, decimal-string nanoseconds,
lowerCamelCase fields, integer enums, and the resource, instrumentation scope and AnyValue nesting. Delivery sends
the queued JSON bytes unchanged.

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
exists. Takeovers are serialized by a short-lived exclusive guard, which expires after five seconds if abandoned.
Only its holder judges and moves a stale lock; a moved file is deleted only after its contents match the stale
generation observed. This needs no hard links. A random token proves ownership before claims, state writes,
deletes and release; an owner that lost its token stops before its next action. This cannot cancel an HTTP request
already in flight.
An unreadable or unparseable config is never interpreted as consent being removed: the sender keeps the batches
and stops. A missing config means export is off, so queued batches are swept. Setup publishes its config atomically
as indented JSON for hand editing. An accepted batch is recorded and removed before the next config read; a failed
read then stops the sender without resending that batch.

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

Spans arrive in a later change. No spans, logs or metrics are emitted yet. Configuration, encoding, queueing and
delivery are available for those signals.

This export is separate from [anonymous telemetry](telemetry.md): its own setting, consent, state, queue, sender
and destination. Later signals will carry repository names, relative paths and ids to your endpoint. There is no
brief, prompt, report, worker text or secret capture option. routr never configures a harness's own telemetry.
