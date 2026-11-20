import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./helpers.mjs";
import { assignSession, findSession, workerSession } from "../src/lib/worker-session.mjs";
import { plan, terminalPlan } from "../src/lib/harnesses.mjs";
import { firstMessage } from "../src/lib/backend-terminal.mjs";

const withHome = async (fn) => {
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }, home = scratch("session-home");
  process.env.HOME = process.env.USERPROFILE = home;
  try { return await fn(home); } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const day = (t) => { const d = new Date(t); return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")]; };
const V7 = "01a1f952-b5ab-7fe0-89e1-f7887d45923e", OTHER = "01a1f952-0000-7fe0-89e1-f7887d45923e", V4 = "8d997247-4335-4a7b-8a2e-d883ab27799f";
const rollout = (id, at, texts) => [{ type: "session_meta", payload: { id, timestamp: new Date(at).toISOString(), cwd: "/w" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } },
  ...texts.map((text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }))].map((l) => JSON.stringify(l)).join("\n") + "\n";
const writeRollout = (root, name, body, at) => { const dir = join(root, "sessions", ...day(at)); mkdirSync(dir, { recursive: true }); const f = join(dir, name); writeFileSync(f, body); utimesSync(f, at / 1000, at / 1000); return f; };

test("Codex: the session whose own record holds this worker's first message, started after its runner; never another worker's, an older one, or an earlier one of the same name", async () => {
  await withHome(async (home) => {
    const root = join(home, ".codex"), since = Date.now() - 5000, message = firstMessage("/runs/b-one/prompt.md");
    const w = { kind: "codex", name: "b-one" };
    expect(findSession(w, { message, since })).toBeNull();
    // Another worker's pointer, a session from before this runner, and this text only as part of a longer message.
    writeRollout(root, "rollout-a.jsonl", rollout(OTHER, since + 100, [firstMessage("/runs/b-two/prompt.md")]), since + 100);
    writeRollout(root, "rollout-old.jsonl", rollout(OTHER, since - 60000, [message]), since + 200);
    writeRollout(root, "rollout-part.jsonl", rollout(OTHER, since + 300, [`${message} and more`]), since + 300);
    expect(findSession(w, { message, since })).toBeNull();
    writeRollout(root, "rollout-b.jsonl", rollout(V7, since + 1000, [message]), since + 1000);
    expect(findSession(w, { message, since })).toBe(V7);
    // An id that is not a session id is never named.
    writeRollout(root, "rollout-c.jsonl", rollout("not-an-id", since + 2000, [message]), since + 2000);
    expect(findSession(w, { message, since })).toBe(V7);
    // An extra account's folder is the one read.
    const extra = join(home, "codex-work");
    expect(findSession({ ...w, subscription: "codex-work", config_dir: extra }, { message, since })).toBeNull();
    writeRollout(extra, "rollout-d.jsonl", rollout(V7, since + 1000, [message]), since + 1000);
    expect(findSession({ ...w, subscription: "codex-work", config_dir: extra }, { message, since })).toBe(V7);
  });
});

test("Antigravity: the conversation whose own transcript starts with this worker's first message, at or after its runner started", async () => {
  await withHome(async (home) => {
    const brain = join(home, ".gemini", "antigravity-cli", "brain"), since = Date.now(), message = firstMessage("/runs/b-agy/prompt.md"), w = { kind: "agy", name: "b-agy" };
    const transcript = (id, first, at = since + 500) => {
      const dir = join(brain, id, ".system_generated", "logs"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "transcript.jsonl"), [JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: new Date(at).toISOString(), content: `<USER_REQUEST>\n${first}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n</ADDITIONAL_METADATA>` }), "{cut"].join("\n"));
    };
    expect(findSession(w, { message, since })).toBeNull();
    // Another worker's pointer, a conversation from before this runner, a longer first message, a folder that is no id.
    transcript(OTHER.replace(/^01a1/, "aaaa").replace("-7fe0-", "-4fe0-"), firstMessage("/runs/b-x/prompt.md"));
    transcript("8d997247-4335-4a7b-8a2e-000000000001", message, since - 60000);
    transcript("8d997247-4335-4a7b-8a2e-000000000002", `${message} and more`);
    transcript("not-an-id", message);
    expect(findSession(w, { message, since })).toBeNull();
    transcript(V4, message);
    expect(findSession(w, { message, since })).toBe(V4);
  });
});

test("a worker's id: what its runner assigned, else found, else why not; a found one is waited for only when asked", async () => {
  expect(await workerSession({ kind: "claude" }, { assigned: { session: V4 } })).toEqual({ session: V4 });
  expect(await workerSession({ kind: "cursor" }, { assigned: { missing: "not_assigned" } })).toEqual({ missing: "not_assigned" });
  expect(await workerSession({ kind: "claude" }, { assigned: null })).toEqual({ missing: "not_assigned" });
  expect(await workerSession({ kind: "kiro" }, {})).toEqual({ missing: "no_source" });
  await withHome(async () => {
    let t = 0, slept = 0;
    const got = await workerSession({ kind: "codex", name: "b-w" }, { message: "x", since: Date.now(), wait: 1000, sleep: async (ms) => { slept += ms; t += ms; }, now: () => t });
    expect(got).toEqual({ missing: "not_found" });
    expect(slept).toBe(1000);
    expect(await workerSession({ kind: "codex", name: "b-w" }, { message: "x", since: Date.now() })).toEqual({ missing: "not_found" });
  });
});

test("assigning: a fresh UUIDv4 for Claude Code, Cursor's own create-chat answer in the worker's folder and environment, nothing for the others", async () => {
  const a = await assignSession("claude");
  expect(a.session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect((await assignSession("claude")).session).not.toBe(a.session);
  const calls = [];
  // Its first line is its answer: it can stay running after it (a fresh config folder).
  const ask = async (cmd, args, o) => { calls.push({ cmd, args, cwd: o.cwd, env: o.env }); expect(o.until(V4)).toBe(false); expect(o.until(`${V4}\n`)).toBe(true); return `${V4}\n`; };
  expect(await assignSession("cursor", { cwd: "/w", env: { CURSOR_CONFIG_DIR: "/c" }, ask })).toEqual({ session: V4 });
  expect(calls).toEqual([{ cmd: "cursor-agent", args: ["create-chat"], cwd: "/w", env: { CURSOR_CONFIG_DIR: "/c" } }]);
  expect(await assignSession("cursor", { ask: async () => null })).toEqual({ missing: "not_assigned" });
  expect(await assignSession("cursor", { ask: async () => "Please log in" })).toEqual({ missing: "not_assigned" });
  for (const kind of ["codex", "agy", "kiro"]) expect(await assignSession(kind, { ask: () => { throw new Error("asked"); } })).toBeNull();
});

test("the assigned id is the harness's own flag, before the first message; no other harness takes one", () => {
  const p = terminalPlan({ kind: "claude", model: "m", cwd: "/w", session: V4 }, "go");
  expect(p.argv.slice(-3)).toEqual(["--session-id", V4, "go"]);
  expect(terminalPlan({ kind: "cursor", model: "m", cwd: "/w", session: V4 }, "go").argv.slice(-3)).toEqual(["--resume", V4, "go"]);
  for (const kind of ["codex", "kiro"]) expect(plan({ kind, model: "m", cwd: "/w", session: V4 }).argv).not.toContain(V4);
  expect(plan({ kind: "claude", model: "m", cwd: "/w" }).argv).not.toContain("--session-id");
});
