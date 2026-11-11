// The commands for workers: `wait`, `send`, `workers` and `stop`, their parsing and what they answer. What each does to a
// worker is the worker module's, through the adapter for where it runs; the terminal adapter follows its worker through
// hc, except where a harness reports no status. Answers carry report paths, never worker text.
import { warning } from "./warnings.mjs";
import { commandTrace } from "./traces.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { lookAt, RUNNING } from "./backend-headless.mjs";
import { workers as workersOf } from "./worker.mjs";
import { sandboxOf } from "./worker-start.mjs";
import { HARNESSES, notReady } from "./harnesses.mjs";
import { configOf, loadConfig, oneReading } from "./config.mjs";
import { readTask } from "./advice-file.mjs";
import { doNext, runNext, templateCommand } from "./next.mjs";
import { answer } from "./output.mjs";
import { readJsonFile, writeJsonAtomic } from "./state-files.mjs";
import { NAME_RULE, WORKER_NAME } from "./worker-record.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// wait, workers and stop read the channel, which a sandbox may block: they say what it may have made them see.
const sandboxNote = (env) => { const s = sandboxOf(env); return s ? [warning("sandbox", `this command runs inside ${s}, which may keep it from reaching a worker's channel: a worker it reads as unreachable may be running`)] : []; };

// ---- wait ------------------------------------------------------------------------------------------------------------
// Returns once a worker it waits on has a turn it has not reported yet, has newly failed, stopped, been lost or become
// unreachable, once nothing it waits on is running, or at the timeout (still running). The default is under Claude
// Code's own 2-minute command limit.
export function parseNamed(args, cmd, values, flags = []) {
  const o = { names: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, "");
    if (args[i].startsWith("--") && flags.includes(key)) { o[key] = true; continue; }
    if (!args[i].startsWith("--") || !values.includes(key)) throw new Error(`Unknown ${cmd} option: ${args[i]}`);
    if (!args[i + 1]?.trim() || /^-\S/.test(args[i + 1])) throw new Error(`--${key} requires a value`);
    if (key === "name") { if (!WORKER_NAME.test(args[i + 1])) throw new Error(`--name must match ${NAME_RULE}`); o.names.push(args[++i]); continue; }
    if (Object.hasOwn(o, key)) throw new Error(`Repeated ${cmd} option: --${key}`);
    o[key] = args[++i];
  }
  return o;
}
// What wait has reported of each worker: the highest turn, and the last notice (generation and state) it gave. Kept in
// the worker's run folder, written only while that folder exists (a wait never makes one).
const SEEN = (w) => join(w.dir, "seen.json");
// Written whole (writeJsonAtomic), so a wait never reads one half written; one it cannot read at all reports again.
const seenOf = (w) => { const s = readJsonFile(SEEN(w)).value; return { turn: Number.isInteger(s?.turn) ? s.turn : 0, notice: typeof s?.notice === "string" ? s.notice : null }; };
const NOTICE = new Set(["failed", "stopped", "lost", "no_task", "unreachable"]);
const noticeOf = (v) => (NOTICE.has(v.state) ? `${v.gen}:${v.state}` : null);
const fresh = (v, seen) => v.turns.filter((t) => t.turn > seen.turn && t.outcome !== "running");
const isNews = (v, seen) => fresh(v, seen).length > 0 || (noticeOf(v) != null && noticeOf(v) !== seen.notice);
// Still to wait for: running, or its state could not be read just now (it may be running).
const pending = (v) => RUNNING.has(v.state) || v.state === "unreadable";

// A command's workers: the ones a test gives, or this home's.
const workersFor = (opts) => opts.workers ?? workersOf({ env: opts.env ?? process.env, ...(opts.ready ? { ready: opts.ready } : {}), ...(opts.spawn ? { spawn: opts.spawn } : {}), ...(opts.hc ? { hc: opts.hc } : {}) });
// A refusal carries what was said before it.
const failed = (out, e, cmd) => { out.warnings.push(...(e?.warnings ?? [])); out.next.push(...(e?.next ?? [])); out.error = String(e?.message ?? e); out.headline = `routr: ${cmd} failed: ${out.error}`; };

async function waitCommandBody(args, { now = () => Date.now(), pause = sleep, env = process.env, ...opts } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: sandboxNote(env), next: [], state: "failed", workers: [] };
  try {
    const o = parseNamed(args, "wait", ["name", "timeout"]);
    const timeout = o.timeout == null ? 90000 : Number(o.timeout);
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error("--timeout must be a whole number of milliseconds");
    // Unnamed: every worker still running, or with a turn this wait has not reported yet.
    // One whose state cannot be read just now is watched: it may be running.
    // A folder that is not a worker of routr's and reads as running is not passed over: the wait says so, as for a name.
    const ws = workersFor({ env, ...opts });
    const asked = o.names.length ? o.names.map((n) => ws.one(n)) : ws.all({ strangers: true }).filter((w) => w.pending(seenOf(w).turn));
    for (const w of asked) if (!w.record && !w.unreadable) throw new Error(`no worker named ${w.name}; routr workers lists them`);
    // A worker whose backend follows wait elsewhere is said; the rest are waited on as usual.
    const elsewhere = asked.map((w) => w.follows("wait")).filter(Boolean), watched = asked.filter((w) => !w.follows("wait"));
    for (const f of elsewhere) { out.warnings.push(warning("terminal_followed", f.why)); out.next.push(...f.next); }
    if (!watched.length) { out.ok = true; out.state = "none"; out.headline = elsewhere.length ? `routr: ${elsewhere[0].why}${elsewhere.length > 1 ? `, and ${elsewhere.length - 1} more` : ""}` : "routr: no worker to wait on"; return answer(out); }
    const deadline = now() + timeout;
    let views = [], lastCheck = -Infinity;
    for (;;) {
      const check = now() - lastCheck >= 5000;
      if (check) lastCheck = now();
      // Each with the worker it is of: one cleaned up meanwhile has no look, and is left out.
      views = (await Promise.all(watched.map(async (w) => { const l = await w.look({ check, kept: true, wait: true }); return { w, v: l?.view, next: l?.next ?? [] }; }))).filter((x) => x.v);
      if (views.some(({ w, v }) => isNews(v, seenOf(w))) || !views.some(({ v }) => pending(v)) || now() >= deadline) break;
      await pause(Math.min(500, Math.max(0, deadline - now())));
    }
    const done = [];
    for (const { w, v, next } of views) {
      const seen = seenOf(w), turns = fresh(v, seen), notice = noticeOf(v);
      out.workers.push({ ...v, turns });
      if (!isNews(v, seen)) continue;
      done.push({ v, turns, noticed: notice != null && notice !== seen.notice, next });
      if (existsSync(w.dir)) try { writeJsonAtomic(SEEN(w), { turn: Math.max(seen.turn, ...turns.map((t) => t.turn)), notice: notice ?? seen.notice }, { mkdir: false }); } catch {}
    }
    views = views.map(({ v }) => v);
    out.ok = true;
    const running = views.filter(pending);
    out.state = done.length ? "finished" : running.length ? "running" : "idle";
    out.headline = done.length ? `routr: ${done.map(({ v, turns, noticed }) => `${v.name} ${noticed ? v.state : turns.length > 1 ? `finished ${turns.length} turns` : "finished a turn"}`).join("; ")}`
      : running.length ? `routr: still running: ${running.map((v) => `${v.name}${v.state === "unreadable" ? " (its state could not be read)" : ""}`).join(", ")}` : `routr: nothing running: ${views.map((v) => `${v.name} ${v.state}`).join(", ")}`;
    for (const { v, turns, next } of done) {
      let terminalNext = false;
      for (const t of turns) {
        if (t.report) out.next.push(doNext(`Read ${v.name}'s report for turn ${t.turn} (its final message; it may be cut at 1 MB), then take a first read of it against the task you gave.`, templateCommand(["routr", "check", "--brief", "<task-file>", "--report", t.report])));
        // A turn with no report file: where its backend says to look, or the worker's own folder.
        else if (next.length && v.backend === "terminal") { if (!terminalNext) { out.next.push(...next); terminalNext = true; } }
        else if (next.length) out.next.push(...next);
        else out.next.push(doNext(`${v.name}'s turn ${t.turn} ended (${t.outcome}) without a report: look at the worker's folder and its changes yourself.`));
      }
      if (v.backend === "terminal" && !terminalNext && next.length) out.next.push(...next);
      if (v.state === "lost" && v.backend !== "terminal") out.next.push(doNext(`${v.name}'s process ended without settling${v.harness_group ? `, and its harness may still be running (process group ${v.harness_group})` : ""}: stop what runs of it, then clean it up.`));
      else if (v.harness_group && !RUNNING.has(v.state)) out.next.push(doNext(`Something ${v.name}'s ${HARNESSES[v.kind]?.label ?? "harness"} started is still running in process group ${v.harness_group}: look at it (${lookAt(v.harness_group)}), stop it if it is the worker's, then clean up.`));
      if (v.tasks) out.next.push(doNext(`${v.name} still has ${v.tasks} background command${v.tasks > 1 ? "s" : ""} running; it may start another turn by itself when ${v.tasks > 1 ? "they end" : "it ends"}.`));
    }
    if (running.length) out.next.push(runNext("Wait for the workers still running.", ["routr", "wait", ...running.flatMap((v) => ["--name", v.name])]));
  } catch (e) { failed(out, e, "wait"); }
  return answer(out);
}

// ---- send ------------------------------------------------------------------------------------------------------------
// A correction or follow-up for a worker launched with advice: into the running turn where the harness takes it, or as
// the next turn of the same session (a new holder resumes it). New work is a new launch with its own advice.
async function sendCommandBody(args, { env = process.env, settings = () => loadConfig(), ready = notReady, ...opts } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: [], next: [], state: "failed", name: null };
  try {
    const o = parseNamed(args, "send", ["name", "task", "task-file"]);
    if (o.names.length !== 1) throw new Error("send takes one --name");
    if ((o.task == null) === (o["task-file"] == null)) throw new Error("Use one of --task and --task-file");
    const name = out.name = o.names[0], w = workersFor({ env, ready, ...opts }).one(name), off = w.follows("send");
    if (off) { out.state = "refused"; out.headline = `routr: ${off.why}; nothing was sent`; out.next.push(...off.next); return answer(out); }
    const r = await w.send(() => (o["task-file"] != null ? readTask(resolve(o["task-file"])) : o.task), { settings });
    out.warnings.push(...r.warnings);
    out.message = r.message;
    out.ok = r.ok; out.state = r.state; out.headline = `routr: ${r.said}`;
    out.next.push(...r.next);
  } catch (e) { failed(out, e, "send"); }
  return answer(out);
}

// ---- workers ---------------------------------------------------------------------------------------------------------
async function workersCommandBody(args, { env = process.env, ...opts } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: sandboxNote(env), next: [], workers: [] };
  try {
    const o = parseNamed(args, "workers", ["name"]), ws = workersFor({ env, ...opts });
    const list = o.names.length ? o.names.map((n) => ws.find(n) ?? (() => { throw new Error(`no worker named ${n}`); })()) : ws.all();
    // Every worker at once, in order: a terminal worker's hc question (each bounded) never holds up the others.
    const looks = await Promise.all(list.map((w) => w.look({ ms: 3000 })));
    // A worker named here that was cleaned up, or replaced, before it was looked at is not there; unnamed, it is left out.
    if (o.names.length) looks.forEach((l, i) => { if (!l) throw new Error(`no worker named ${o.names[i]}`); });
    for (const l of looks.filter(Boolean)) {
      // What a wait follows turns by is not shown here.
      const row = { ...l.view }; delete row.turns; delete row.gen;
      out.workers.push(row); out.next.push(...l.next);
    }
    out.ok = true;
    out.headline = out.workers.length ? `routr: ${out.workers.map((v) => `${v.name} ${v.state}`).join(", ")}` : "routr: no workers";
  } catch (e) { failed(out, e, "workers"); }
  return answer(out);
}

// ---- stop ------------------------------------------------------------------------------------------------------------
async function stopCommandBody(args, { env = process.env, ...opts } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: sandboxNote(env), next: [], state: "failed", name: null };
  try {
    const o = parseNamed(args, "stop", ["name"]);
    if (o.names.length !== 1) throw new Error("stop takes one --name");
    const name = out.name = o.names[0], w = workersFor({ env, ...opts }).one(name), off = w.follows("stop");
    if (off) { out.state = "refused"; out.headline = `routr: ${off.why}; nothing was stopped`; out.next.push(...off.next); return answer(out); }
    const r = await w.stop();
    out.ok = r.ok; out.state = r.state; out.headline = `routr: ${r.said}`;
    out.warnings.push(...r.warnings); out.next.push(...r.next);
    out.next.push(runNext("Remove its run folder and reports once you have what you need from them.", ["routr", "cleanup", "--worker", name]));
  } catch (e) { failed(out, e, "stop"); }
  return answer(out);
}

// The trace and the body read the config once between them (oneReading).
const traced = (name, body) => (args, opts = {}) => {
  const settings = oneReading(opts.settings);
  return commandTrace(name, () => ({ config: configOf(settings()), ...opts }), () => body(args, { ...opts, settings }));
};
export const sendCommand = traced("send", sendCommandBody);
export const waitCommand = traced("wait", waitCommandBody);
export const workersCommand = traced("workers", workersCommandBody);
export const stopCommand = traced("stop", stopCommandBody);
