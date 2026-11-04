// The commands for workers: `wait`, `send`, `workers` and `stop`, their parsing and what they answer. What each does to a
// worker is its backend's (backend-headless.mjs). Answers carry report paths, never worker text.
import { warning, carrierWithheld } from "./warnings.mjs";
import { commandTrace } from "./traces.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { deliver, damagedNext, markerWhy, RUNNING, sandboxOf, size, stopWorker, TOO_BIG, view, worthWatching } from "./backend-headless.mjs";
import { runDir, unreadableWhy, workerNames, workerOf } from "./worker-record.mjs";
import { MESSAGE_MAX } from "./channel.mjs";
import { HARNESSES, notReady } from "./harnesses.mjs";
import { configOf, loadConfig, oneReading } from "./config.mjs";
import { readTask } from "./advice-file.mjs";
import { doNext, runNext, templateCommand } from "./next.mjs";
import { answer } from "./output.mjs";
import { CLOSING, count, OFF } from "./wording.mjs";
import { NAME_RULE, WORKER_NAME, readJsonFile, savedCarriers, writeJsonAtomic } from "./runtime.mjs";

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
const SEEN = (name) => join(runDir(name), "seen.json");
// Written whole (writeJsonAtomic), so a wait never reads one half written; one it cannot read at all reports again.
const seenOf = (name) => { const s = readJsonFile(SEEN(name)).value; return { turn: Number.isInteger(s?.turn) ? s.turn : 0, notice: typeof s?.notice === "string" ? s.notice : null }; };
const NOTICE = new Set(["failed", "stopped", "lost", "no_task", "unreachable"]);
const noticeOf = (v) => (NOTICE.has(v.state) ? `${v.gen}:${v.state}` : null);
const fresh = (v, seen) => v.turns.filter((t) => t.turn > seen.turn && t.outcome !== "running");
const isNews = (v, seen) => fresh(v, seen).length > 0 || (noticeOf(v) != null && noticeOf(v) !== seen.notice);
// Still to wait for: running, or its state could not be read just now (it may be running).
const pending = (v) => RUNNING.has(v.state) || v.state === "unreadable";

async function waitCommandBody(args, { now = () => Date.now(), pause = sleep, env = process.env } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: sandboxNote(env), next: [], state: "failed", workers: [] };
  try {
    const o = parseNamed(args, "wait", ["name", "timeout"]);
    const timeout = o.timeout == null ? 90000 : Number(o.timeout);
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error("--timeout must be a whole number of milliseconds");
    // Unnamed: every worker still running, or with a turn this wait has not reported yet.
    // One whose state cannot be read just now is watched: it may be running.
    const watched = o.names.length ? o.names : workerNames().filter((n) => worthWatching(n, seenOf(n).turn));
    for (const n of watched) { const r = workerOf(n); if (!r.worker && !r.unreadable) throw new Error(`no headless worker named ${n}; routr workers lists them`); }
    if (!watched.length) { out.ok = true; out.state = "none"; out.headline = "routr: no headless worker to wait on"; return answer(out); }
    const deadline = now() + timeout;
    let views = [], lastCheck = -Infinity;
    for (;;) {
      const check = now() - lastCheck >= 5000;
      if (check) lastCheck = now();
      views = (await Promise.all(watched.map((n) => view(n, { check })))).filter(Boolean);
      if (views.some((v) => isNews(v, seenOf(v.name))) || !views.some(pending) || now() >= deadline) break;
      await pause(Math.min(500, Math.max(0, deadline - now())));
    }
    const done = [];
    for (const v of views) {
      const seen = seenOf(v.name), turns = fresh(v, seen), notice = noticeOf(v);
      out.workers.push({ ...v, turns });
      if (!isNews(v, seen)) continue;
      done.push({ v, turns, noticed: notice != null && notice !== seen.notice });
      if (existsSync(runDir(v.name))) try { writeJsonAtomic(SEEN(v.name), { turn: Math.max(seen.turn, ...turns.map((t) => t.turn)), notice: notice ?? seen.notice }, { mkdir: false }); } catch {}
    }
    out.ok = true;
    const running = views.filter(pending);
    out.state = done.length ? "finished" : running.length ? "running" : "idle";
    out.headline = done.length ? `routr: ${done.map(({ v, turns, noticed }) => `${v.name} ${noticed ? v.state : turns.length > 1 ? `finished ${turns.length} turns` : "finished a turn"}`).join("; ")}`
      : running.length ? `routr: still running: ${running.map((v) => `${v.name}${v.state === "unreadable" ? " (its state could not be read)" : ""}`).join(", ")}` : `routr: nothing running: ${views.map((v) => `${v.name} ${v.state}`).join(", ")}`;
    for (const { v, turns } of done) {
      for (const t of turns) {
        if (t.report) out.next.push(doNext(`Read ${v.name}'s report for turn ${t.turn} (its final message; it may be cut at 1 MB), then take a first read of it against the task you gave.`, templateCommand(["routr", "check", "--brief", "<task-file>", "--report", t.report])));
        else out.next.push(doNext(`${v.name}'s turn ${t.turn} ended (${t.outcome}) without a report: look at the worker's folder and its changes yourself.`));
      }
      if (v.state === "lost") out.next.push(doNext(`${v.name}'s process ended without settling${v.harness_group ? `, and its harness may still be running (process group ${v.harness_group})` : ""}: stop what runs of it, then clean it up.`));
      else if (v.harness_group && !RUNNING.has(v.state)) out.next.push(doNext(`Something ${v.name}'s ${HARNESSES[v.kind]?.label ?? "harness"} started is still running in process group ${v.harness_group}: look at it (${lookAt(v.harness_group)}), stop it if it is the worker's, then clean up.`));
      if (v.tasks) out.next.push(doNext(`${v.name} still has ${v.tasks} background command${v.tasks > 1 ? "s" : ""} running; it may start another turn by itself when ${v.tasks > 1 ? "they end" : "it ends"}.`));
    }
    if (running.length) out.next.push(runNext("Wait for the workers still running.", ["routr", "wait", ...running.flatMap((v) => ["--name", v.name])]));
  } catch (e) { out.error = String(e?.message ?? e); out.headline = `routr: wait failed: ${out.error}`; }
  return answer(out);
}

// ---- send ------------------------------------------------------------------------------------------------------------
// A correction or follow-up for a worker launched with advice: into the running turn where the harness takes it, or as
// the next turn of the same session (a new holder resumes it). New work is a new launch with its own advice.
const SENT = { handed_to_harness: () => "written to the running worker's input (not yet proven read)",
  accepted: () => "taken by the running worker (into its running turn, or as its next)",
  queued: (label, why) => (why === "next_turn" ? "queued: it runs as the worker's next turn, once the running one ends" : `queued: it runs as the worker's next turn, in a new ${label} process on the same session`),
  prompted: () => "the worker resumed its session with it as the next turn" };
async function sendCommandBody(args, { env = process.env, settings = () => loadConfig(), ready = notReady, spawn } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: [], next: [], state: "failed", name: null };
  try {
    const o = parseNamed(args, "send", ["name", "task", "task-file"]);
    if (o.names.length !== 1) throw new Error("send takes one --name");
    if ((o.task == null) === (o["task-file"] == null)) throw new Error("Use one of --task and --task-file");
    const name = out.name = o.names[0], rec = workerOf(name), w = rec.worker;
    if (rec.unreadable) { out.next.push(...damagedNext(name)); throw new Error(unreadableWhy(name, "worker.json", rec.unreadable)); }
    if (!w) throw new Error(`no headless worker named ${name}; routr workers lists them`);
    // A holder this send starts gives its harness the carriers saved with the worker, checked again: any withheld is said.
    out.warnings.push(...savedCarriers(w.carriers).withheld.map(carrierWithheld));
    const text = o["task-file"] != null ? readTask(resolve(o["task-file"])) : o.task;
    if (!text?.trim()) throw new Error("The message must not be empty");
    const message = `${text.trim()}\n\n${CLOSING}`;
    if (size(message) > MESSAGE_MAX) throw new Error(TOO_BIG);
    const loaded = settings(), config = configOf(loaded);
    out.warnings.push(...(loaded.notes ?? []));
    if (config.subscriptions[w.kind]?.enabled === false) throw new Error(OFF.launch(HARNESSES[w.kind].label, w.kind));
    const r = await deliver(name, w, message, { out, env, ready, spawn });
    out.message = { code: r.code, ...(r.why ? { why: r.why } : {}) };
    if (!SENT[r.code]) {
      out.state = r.code === "unknown" ? "unknown" : "refused";
      out.headline = r.code === "unknown" ? `routr: whether ${name} took the message is not known (${r.why ?? "no_answer"})` : `routr: ${name} did not take the message (${r.why ?? r.code})`;
      if (r.code === "unknown") out.next.push(runNext(`Whether ${name} got the message is not known: look at it before sending it again.`, ["routr", "workers", "--name", name]));
      return answer(out);
    }
    out.ok = true; out.state = r.code === "prompted" ? "resumed" : r.code === "queued" ? "queued" : "delivered";
    out.headline = `routr: ${name}: ${SENT[r.code](HARNESSES[w.kind].label, r.why)}`;
    out.next.push(runNext("Wait for this worker's turn to end.", ["routr", "wait", "--name", name]));
  } catch (e) { out.error = String(e?.message ?? e); out.headline = `routr: send failed: ${out.error}`; }
  return answer(out);
}

// ---- workers ---------------------------------------------------------------------------------------------------------
async function workersCommandBody(args, { env = process.env } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: sandboxNote(env), next: [], workers: [] };
  try {
    const o = parseNamed(args, "workers", ["name"]);
    for (const n of o.names.length ? o.names : workerNames()) {
      const v = await view(n);
      if (v) { const row = { ...v }; delete row.turns; delete row.gen; out.workers.push(row); } else if (o.names.length) throw new Error(`no headless worker named ${n}`);
    }
    out.ok = true;
    out.headline = out.workers.length ? `routr: ${out.workers.map((v) => `${v.name} ${v.state}`).join(", ")}` : "routr: no headless workers";
  } catch (e) { out.error = String(e?.message ?? e); out.headline = `routr: workers failed: ${out.error}`; }
  return answer(out);
}

// ---- stop ------------------------------------------------------------------------------------------------------------
async function stopCommandBody(args, { env = process.env } = {}) {
  const out = { ok: false, headline: "", unavailable: [], warnings: sandboxNote(env), next: [], state: "failed", name: null };
  try {
    const o = parseNamed(args, "stop", ["name"]);
    if (o.names.length !== 1) throw new Error("stop takes one --name");
    const name = out.name = o.names[0];
    const rec = workerOf(name), w = rec.worker;
    if (!w && !rec.unreadable) throw new Error(`no headless worker named ${name}; routr workers lists them`);
    const { channel: p, read, pgid, left, reply: r } = await stopWorker(name, rec);
    const pg = () => pgid;
    if (read.unreadable) {
      out.state = "unknown"; out.headline = `routr: ${unreadableWhy(name, rec.unreadable ? "worker.json" : "state.json", read.unreadable)}`;
      out.next.push(...damagedNext(name, w));
    } else if (p.state === "alive") {
      out.ok = r.code === "stopped"; out.state = ["stopped", "still_exiting"].includes(r.code) ? r.code : "unknown";
      out.headline = out.ok ? `routr: stopped ${name}` : `routr: ${name} was told to stop and has not finished exiting`;
      if (!out.ok) out.next.push(runNext("Look again in a moment.", ["routr", "workers", "--name", name]));
      // Messages it had queued and never sent: dropped by the stop. The lead sends them again if they still apply.
      if (Number.isInteger(r.dropped) && r.dropped > 0) out.warnings.push(warning("messages_dropped", `${count(r.dropped, "queued message")} ${r.dropped === 1 ? "was" : "were"} dropped by the stop and never reached ${name}: send ${r.dropped === 1 ? "it" : "them"} again with routr send if ${r.dropped === 1 ? "it still applies" : "they still apply"}`));
    } else if (["released", "none", "abandoned"].includes(p.state) && !left) {
      out.ok = true; out.state = "absent"; out.headline = `routr: ${name} is not running`;
    } else {
      out.state = p.state === "unreachable" ? "unreachable" : "lost";
      if (p.unreadable) out.next.push(...damagedNext(name, w));
      out.headline = p.unreadable ? `routr: ${markerWhy(name, p)}` : p.state === "unreachable" ? `routr: ${name}'s process does not answer`
        : `routr: ${name}'s process is gone${left ? `, and its harness may still be running (process group ${pg()})` : ""}`;
      out.warnings.push(warning("process_unseen", "routr stops a worker only through its own process, never by a saved process id: it cannot see whether the harness is still running"));
      out.next.push(doNext(left ? `Look at process group ${pg()} (${lookAt(pg())}) and stop it yourself if it is this worker's, then clean the worker up.` : "Clean the worker up once you are sure nothing of it runs."));
    }
    out.next.push(runNext("Remove its run folder and reports once you have what you need from them.", ["routr", "cleanup", "--worker", name]));
  } catch (e) { out.error = String(e?.message ?? e); out.headline = `routr: stop failed: ${out.error}`; }
  return answer(out);
}

// A process group's members with their command lines, on this system (pgrep's -a lists ancestors on macOS).
const lookAt = (pg) => (process.platform === "darwin" ? `pgrep -lf -g ${pg}` : `pgrep -a -g ${pg}`);

// The trace and the body read the config once between them (oneReading).
const traced = (name, body) => (args, opts = {}) => {
  const settings = oneReading(opts.settings);
  return commandTrace(name, () => ({ config: configOf(settings()), ...opts }), () => body(args, { ...opts, settings }));
};
export const sendCommand = traced("send", sendCommandBody);
export const waitCommand = traced("wait", waitCommandBody);
export const workersCommand = traced("workers", workersCommandBody);
export const stopCommand = traced("stop", stopCommandBody);
