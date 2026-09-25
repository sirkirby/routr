# Telemetry

routr can share anonymous outcomes with its maintainers to help tune its questions. **It is off unless you turn it
on.** routr is open source and defaults to sharing nothing; nothing changes until you say yes.

## Why it helps

routr's questions are kept, re-worded, or dropped on evidence (see [evidence.md](evidence.md)). So far that evidence
comes from the maintainers' own work. What routr read from a brief, next to what the agent then chose and whether the
work came back right, is the only way to tell whether a question gives good advice on other people's work. Findings
are published in aggregate in [evidence.md](evidence.md).

## Turning it on and off

    routr telemetry on        # share, once a day from now on
    routr telemetry off       # stop
    routr telemetry status    # the setting, and when rows were last sent
    routr share               # write exactly what would be sent to a file you can read; sends nothing

`routr setup` asks a person once (default no). An agent running setup for you never turns it on; it is told to ask
you. Nothing is sent, not even by `routr telemetry send`, while it is off, while `ROUTR_TELEMETRY=0` or
`DO_NOT_TRACK=1` is set, or in CI. A setting left by routr 0.1.21 (which shared by default) does not count: it stays off
until you run `routr telemetry on`.

Each time you turn it on, only rows recorded from that moment are shared. Rows recorded before, or while it was off,
stay on your machine unless you choose to send them with `routr telemetry send --all`.

## What is sent

Once a day, the detached background job that also checks for updates sends the ledger rows recorded since the last
send. Never during a command, and a failed send is retried the next day. Each row holds:

| Field | Example | What it is |
|---|---|---|
| `v` | `2` | the row format |
| `day` | `2026-09-24` | the date the row was recorded; no time of day (the server notes when it received a send) |
| `mode` | `dispatch` | `dispatch` or `subagent` |
| `question_set`, `jev_model` | `r4`, `jev-1.13.0` | which routr questions and which Jev version read the brief |
| `brief_chars` | `1975` | the brief's length, never its text |
| `advised` | level, sure, between, work type, high risk, fallback, facts | what routr read: its level (and the two it was torn between), whether Jev answered, and yes/no probabilities for its fixed questions |
| `chose` | `codex`, `gpt-5.6-terra`, `high`, `strong` | the subscription, model, effort, and level the agent chose |
| `outcome` | `done`, `pass`, attempts `1`, seconds `420` | how the work turned out |
| `subagents` | `[{ advised: "basic", model: "…" }]` | the level advised and the model used for each subagent |
| `row_key` | 32 hex characters | a hash of your install id and the row, so a resend is harmless |

Each send also carries routr's version, your OS and CPU type (`darwin-arm64`), and a random install id created on
your machine the first time you share or send feedback. The install id is not derived from anything about you or your
machine.

Every field is built from an exact list of known values (harnesses, levels, verdicts, efforts, work types, fact
names) or a narrow pattern (the question-set and Jev versions). Anything else is sent as `"other"`. The one field no
list can check is a **model name**: routr holds no list of models, so anything shaped like a model name (letters,
digits, `.`, `-`, `:`, brackets; no paths, URLs, emails, or tokens) is sent as written. The endpoint also refuses any
row carrying a string longer than 80 characters.

## What is never sent

Your briefs or any other text, notes, worker reports, project or repository names, file paths, the ledger's own ids,
hashes of briefs, usage numbers, your TypeSafe key, or anything from your code.

## Where it goes

- **Endpoint:** `https://telemetry.routr.build`, a Cloudflare Worker run by routr's maintainer.
- **Storage:** a Cloudflare D1 database in the same account. Only the maintainers can read it.
- **Your IP address** is seen by Cloudflare, as with any request, and used by the Worker only as a rate-limit key. It
  is not stored with your rows, and the Worker keeps no request logs.
- **Not shared or sold.** The rows are used to tune routr's questions; what is learned is published in aggregate.

## Feedback

    routr feedback "what worked, what did not"

This is separate from telemetry and works whether telemetry is on or off. It is the only text routr ever sends, and
only what you typed, with routr's version, your OS, and your install id.

## Deleting what you shared

Your install id is how the maintainers find your rows: `routr telemetry status` shows it. Run
`routr feedback "please delete my telemetry"` from the same machine (the note carries the id) and they delete the rows
by hand. If you uninstall routr or remove `~/.local/share/routr`, the id goes with it, so note it first if you may want
your rows deleted later.

## For contributors

The client is [`src/lib/telemetry.mjs`](../src/lib/telemetry.mjs). A new field in a sent row changes this page in the
same pull request.
