// A pane or terminal worker's own conversation: the session id its harness keeps for it, which its `invoke_agent` spans
// name as gen_ai.conversation.id. Only an id routr can prove is this worker's, never one matched by time, folder or
// branch: the id routr gave the harness when it started (`assign`), or the one the harness's own record files under the
// worker's first message, which names that worker's run folder and no other (`find`). A harness with neither has none,
// and says why (`missing`). Each harness's source is its `session` entry in the registry; what each was measured to do
// is in references/harnesses.md (2026-11-20). A headless worker's comes from its harness's own stream instead.
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES } from "./harnesses.mjs";
import { run } from "./processes.mjs";
import { home } from "./state-files.mjs";
import { sessionId } from "./trace-context.mjs";
import { savedConfigLocations } from "./worker-env.mjs";

// Why a worker's id is not known, as a fixed code: what `routr workers` and an `invoke_agent` span say.
//   no_source: its harness keeps no id routr can prove is this worker's (Kiro; an agent a `--pane` rerun adopted).
//   not_assigned: routr asked the harness for one before it started, and got none (Cursor's `create-chat`).
//   not_found: the harness's record (or herdr's report, in a pane) did not name it yet when routr looked.
export const MISSING = Object.freeze(["no_source", "not_assigned", "not_found"]);
export const sessionSource = (kind) => (Object.hasOwn(HARNESSES, kind) ? HARNESSES[kind].session ?? null : null);

// For an `assign` harness, the id it is to start under, asked for in the environment and folder it will run in (Cursor
// keeps a chat with its config): `{ session }`, or `{ missing: "not_assigned" }`. Null for any other harness.
export async function assignSession(kind, { cwd, env, ask = run } = {}) {
  const how = sessionSource(kind)?.assign;
  if (how === "uuid") return { session: randomUUID() };
  if (how !== "create-chat") return null;
  // Measured 2026-11-20, cursor-agent 2026.11.19: prints one UUIDv4 line within a second, and starts no model turn. In a
  // config folder it has not run in (a worker's private one, every launch) it then stays running for over a minute, so
  // its first line is its answer and it is stopped then. The chat is kept in that folder (`chats/`).
  const out = await ask(HARNESSES[kind].executable, ["create-chat"], { cwd, env, timeoutMs: 15000, maxBytes: 4096, until: (text) => text.includes("\n") });
  const id = typeof out === "string" ? sessionId(out.trim()) : null;
  return id ? { session: id } : { missing: "not_assigned" };
}

// At most this much of a record is read: what a session holds before its first message (Codex's instructions) is tens of
// kilobytes.
const HEAD_BYTES = 2 * 1024 * 1024;
// A part cut mid-line leaves that line unparsed: records drops it.
const readPart = (file, { bytes }) => {
  let fd;
  try {
    fd = openSync(file, "r");
    const n = Math.min(fstatSync(fd).size, bytes), buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    return buf.toString("utf8");
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
};
const records = (text) => (text ?? "").split("\n").flatMap((l) => { try { const v = JSON.parse(l); return v && typeof v === "object" ? [v] : []; } catch { return []; } });
// Two seconds either side of the launch: a clock read in another process, never a match by itself.
const SLACK_MS = 2000;
// The one session that matched. Two holding the same first message are not told apart by a guess: neither is named.
const only = (found) => (new Set(found.map((f) => f.id)).size === 1 ? found[0].id : null);

// Codex: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`, by the local date it started. Its first line is
// `session_meta` (payload.id, a UUIDv7, its session id, the one it names as CODEX_THREAD_ID); the worker's first message
// is a `response_item` user message. The folder is the worker's account's, or the one launch saved for it.
const codexHome = (w) => (typeof w.subscription === "string" && typeof w.config_dir === "string" ? w.config_dir : savedConfigLocations(w.config ?? {}).CODEX_HOME ?? join(home(), ".codex"));
const dayDir = (root, t) => { const d = new Date(t); return join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")); };
function findCodex(w, message, since, now) {
  const root = join(codexHome(w), "sessions"), found = [];
  for (const dir of new Set([dayDir(root, since), dayDir(root, now)])) {
    let names; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const file = join(dir, name);
      try { if (statSync(file).mtimeMs < since - SLACK_MS) continue; } catch { continue; }
      const lines = records(readPart(file, { bytes: HEAD_BYTES })), meta = lines[0];
      if (meta?.type !== "session_meta") continue;
      const id = sessionId(meta.payload?.id), at = Date.parse(meta.payload?.timestamp);
      if (!id || !(at >= since - SLACK_MS)) continue;
      const asked = lines.some((e) => e.type === "response_item" && e.payload?.type === "message" && e.payload.role === "user"
        && Array.isArray(e.payload.content) && e.payload.content.some((c) => c?.text === message));
      if (asked) found.push({ id, at });
    }
  }
  return only(found);
}

// Antigravity: each conversation's transcript is `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`,
// its folder named by its conversation id (a UUIDv4, the one it names as ANTIGRAVITY_CONVERSATION_ID). Its first line is
// the first prompt, the person's own (`USER_EXPLICIT`), wrapped as `<USER_REQUEST>\n<text>\n</USER_REQUEST>`. Measured
// 2026-11-20, agy 1.5.13: a first message given with `-i` is there, and not in its prompt history (history.jsonl), which
// keeps only prompts typed in.
function findAgy(w, message, since) {
  const brain = join(home(), ".gemini", "antigravity-cli", "brain"), found = [];
  let names; try { names = readdirSync(brain); } catch { return null; }
  for (const name of names) {
    if (!sessionId(name)) continue;
    const file = join(brain, name, ".system_generated", "logs", "transcript.jsonl");
    try { if (statSync(file).mtimeMs < since - SLACK_MS) continue; } catch { continue; }
    const first = records(readPart(file, { bytes: 64 * 1024 }))[0], at = Date.parse(first?.created_at);
    if (first?.step_index === 0 && first.type === "USER_INPUT" && first.source === "USER_EXPLICIT" && at >= since - SLACK_MS
      && typeof first.content === "string" && first.content.startsWith(`<USER_REQUEST>\n${message}\n</USER_REQUEST>`)) found.push({ id: name, at });
  }
  return only(found);
}
const FINDERS = { codex: findCodex, agy: findAgy };

// For a `find` harness, the id its record holds for the worker whose first message is `message`, in a session that
// started at or after `since` (ms): null until the harness has written it. Never throws.
export function findSession(w, { message, since, now = Date.now() }) {
  const how = sessionSource(w?.kind)?.find;
  if (!FINDERS[how] || typeof message !== "string" || !Number.isFinite(since)) return null;
  try { return FINDERS[how](w, message, since, now); } catch { return null; }
}

// A worker's id as it stands: `{ session }` or `{ missing }`. `assigned`: what the runner recorded for an `assign`
// harness. `wait` (ms): how long to look again for a `find` harness's id the harness has not written yet. Launch waits
// only when a span is to carry the id; everything else looks once.
export async function workerSession(w, { assigned = null, message, since, wait = 0, sleep, now = () => Date.now() } = {}) {
  const src = sessionSource(w?.kind);
  if (src?.assign) return sessionId(assigned?.session) ? { session: assigned.session } : { missing: MISSING.includes(assigned?.missing) ? assigned.missing : "not_assigned" };
  if (!src?.find) return { missing: "no_source" };
  const until = now() + wait;
  for (;;) {
    const id = findSession(w, { message, since, now: now() });
    if (id) return { session: id };
    if (now() >= until || !sleep) return { missing: "not_found" };
    await sleep(250);
  }
}
