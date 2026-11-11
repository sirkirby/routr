// The worker commands through the worker module, against fake adapters: a record the real constructor built under a
// temporary root, and no holder, no hc and no HOME of its own. What a backend's own files and processes say is its
// adapter's (the headless adapter's classification is tested at the end, against a stubbed channel); what the commands
// answer from what an adapter says is tested here.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sendCommand, stopCommand, waitCommand, workersCommand } from "../src/lib/workers.mjs";
import { watchCommand } from "../src/lib/watch.mjs";
import { workers } from "../src/lib/worker.mjs";
import { amend, newRecord, recordStore } from "../src/lib/worker-record.mjs";
import { CLOSING } from "../src/lib/wording.mjs";
import { takeLock, releaseFileLock, lockIsStale } from "../src/lib/state-files.mjs";
import { cfg, scratch } from "./helpers.mjs";

const MARK = "PRIVATE-FAKE-TEXT-5e1d";
// A run folder with a record built as launch builds it.
const worker = (root, name = "w1", where = { backend: "headless" }) => {
  const store = recordStore(root), dir = store.runDir(name), record = newRecord({ name, kind: "claude", model: "m", cwd: "/work" }, where);
  mkdirSync(dir, { recursive: true }); store.write(dir, record); return { dir, record, store };
};
const viewOf = (me, over = {}) => ({ name: me.name, kind: me.record.kind, model: me.record.model, effort: null, cwd: me.record.cwd, state: "working", gen: 1, turn: 1,
  seconds_since_event: 0, last_tool: null, tasks: 0, queued: 0, session: null, report: null, turns: [{ turn: 1, outcome: "running", report: null, delivered: 0 }], ...over });
// A fake adapter: `script` says what each look sees, in order (the last repeating), and what send and stop answer.
const fake = (script = {}) => {
  const calls = [], looks = [...(script.looks ?? [{}])];
  return { calls, adapter: {
    owns: () => false, follows: () => null,
    look: async (me) => { calls.push(["look", me.name]); return { view: viewOf(me, looks.length > 1 ? looks.shift() : looks[0]), next: [] }; },
    pending: (me, reported) => { calls.push(["pending", me.name, reported]); return script.pending ?? true; },
    beforeSend: () => { calls.push(["beforeSend"]); return script.beforeSend ?? []; },
    limit: (m) => (m.length > (script.limit ?? Infinity) ? "too long" : null),
    send: async (me, message) => { calls.push(["send", message]); if (script.sendThrows) throw Object.assign(new Error(script.sendThrows), { next: [{ why: "refusal step" }] }); return script.sent; },
    stop: async () => { calls.push(["stop"]); return script.stopped; },
    end: async (me, opts) => { calls.push(["end", opts.dryRun]); return script.held ?? null; },
    release: (me) => { calls.push(["release", me.record.id]); },
  } };
};
// Another backend: every command but cleanup is followed elsewhere.
const elsewhere = { owns: () => false, follows: (me, op) => ({ why: `${me.record.name} runs elsewhere`, next: [{ why: `follow ${op} there` }] }), pending: () => false, end: async () => null, release: () => {} };
const opts = (ws, more = {}) => ({ workers: ws, env: {}, settings: () => cfg(), pause: async () => {}, ...more });

test("wait answers from what an adapter sees: a turn ended once, said once, and what a wait has reported is kept in the run folder", async () => {
  const root = scratch("worker-wait"), { dir } = worker(root), f = fake({ looks: [{}, { state: "idle", turns: [{ turn: 1, outcome: "finished", report: "/r/turn-1.md", delivered: 0 }] }] });
  const ws = workers({ root, adapters: { headless: f.adapter } });
  const r = await waitCommand(["--name", "w1", "--timeout", "1000"], opts(ws));
  expect([r.ok, r.state, r.headline]).toEqual([true, "finished", "routr: w1 finished a turn"]);
  expect(r.workers.map((w) => [w.name, w.state, w.gen, w.turns.map((t) => t.turn)])).toEqual([["w1", "idle", 1, [1]]]);
  expect(r.next[0].template).toContain("routr check --brief <task-file> --report /r/turn-1.md");
  expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual({ turn: 1, notice: null });
  // Reported once: the same turn is not news again.
  const again = await waitCommand(["--name", "w1", "--timeout", "0"], opts(workers({ root, adapters: { headless: f.adapter } })));
  expect([again.state, again.headline]).toEqual(["idle", "routr: nothing running: w1 idle"]);
  // Unnamed, the adapter says which it watches, from what was reported.
  const unnamed = await waitCommand(["--timeout", "0"], opts(workers({ root, adapters: { headless: { ...f.adapter, pending: (me, reported) => (f.calls.push(["pending", me.name, reported]), false) } } })));
  expect([unnamed.state, unnamed.headline]).toEqual(["none", "routr: no worker to wait on"]);
  expect(f.calls.filter((c) => c[0] === "pending")).toEqual([["pending", "w1", 1]]);
  const missing = await waitCommand(["--name", "nobody", "--timeout", "0"], opts(ws));
  expect([missing.ok, missing.error]).toEqual([false, "no worker named nobody; routr workers lists them"]);
});

test("wait says a turn that did not finish by how it ended, never as finished, while its worker has not settled", async () => {
  // Measured live 2026-11-11: Claude turns that failed to sign in were headlined "finished a turn" before the holder
  // settled as failed. The state here is the holder's between turns, so no notice says it.
  const turn = (n, outcome) => ({ turn: n, outcome, report: `/r/turn-${n}.md`, delivered: 0 });
  for (const [turns, said] of [[[turn(1, "failed")], "routr: w1's turn 1 failed"], [[turn(1, "no_finish")], "routr: w1's turn 1 ended without finishing"],
    [[turn(1, "finished"), turn(2, "failed")], "routr: w1 finished a turn, turn 2 failed"], [[turn(1, "finished"), turn(2, "finished")], "routr: w1 finished 2 turns"],
    [[turn(1, "stopped"), turn(2, "not_started")], "routr: w1's turn 1 was stopped, turn 2 did not start"]]) {
    const root = scratch("worker-wait-outcome"); worker(root);
    const f = fake({ looks: [{ state: "waiting", turns }] });
    const r = await waitCommand(["--name", "w1", "--timeout", "0"], opts(workers({ root, adapters: { headless: f.adapter } })));
    expect([r.state, r.headline]).toEqual(["finished", said]);
  }
});

test("a worker another backend follows is said, with that backend's steps, by wait, send, stop and watch, and none acts on it", async () => {
  const root = scratch("worker-elsewhere"), f = fake();
  worker(root, "w1", { backend: "terminal", terminal_name: "w1", config: {} });
  const ws = workers({ root, adapters: { headless: f.adapter, terminal: elsewhere } });
  const waited = await waitCommand(["--name", "w1", "--timeout", "0"], opts(ws));
  expect([waited.ok, waited.state, waited.headline, waited.warnings, waited.next]).toEqual([true, "none", "routr: w1 runs elsewhere", ["w1 runs elsewhere"], [{ why: "follow wait there" }]]);
  const sent = await sendCommand(["--name", "w1", "--task", MARK], opts(ws));
  expect([sent.ok, sent.state, sent.headline, sent.next]).toEqual([false, "refused", "routr: w1 runs elsewhere; nothing was sent", [{ why: "follow send there" }]]);
  const stopped = await stopCommand(["--name", "w1"], opts(ws));
  expect([stopped.ok, stopped.state, stopped.headline, stopped.next]).toEqual([false, "refused", "routr: w1 runs elsewhere; nothing was stopped", [{ why: "follow stop there" }]]);
  await expect(watchCommand(["--name", "w1"], { workers: ws, write: () => {} })).rejects.toThrow("w1 runs elsewhere; its terminal shows it");
  expect(f.calls).toEqual([]);
  expect(JSON.stringify([waited, sent, stopped])).not.toContain(MARK);
});

test("send reads the message only after the warnings that come before it, and every refusal keeps them", async () => {
  const root = scratch("worker-send"), withheld = ["TRACEPARENT withheld"];
  worker(root);
  const delivered = { state: "delivered", ok: true, message: { code: "accepted" }, said: "w1: taken", next: [{ why: "wait" }] };
  let f = fake({ beforeSend: withheld, sent: delivered });
  const ok = await sendCommand(["--name", "w1", "--task", `  ${MARK}  `], opts(workers({ root, adapters: { headless: f.adapter } })));
  expect([ok.ok, ok.state, ok.headline, ok.message, ok.warnings, ok.next]).toEqual([true, "delivered", "routr: w1: taken", { code: "accepted" }, withheld, [{ why: "wait" }]]);
  expect(f.calls).toEqual([["beforeSend"], ["send", `${MARK}\n\n${CLOSING}`]]);
  // A task file that cannot be read, an empty message, one over the adapter's limit, and the adapter's own refusal.
  f = fake({ beforeSend: withheld, limit: CLOSING.length + 10, sendThrows: "w1's process does not answer", sent: delivered });
  const ws = workers({ root, adapters: { headless: f.adapter } });
  for (const [args, error, next] of [
    [["--task-file", join(root, "missing.md")], "could not read", []],
    [["--task-file", (writeFileSync(join(root, "blank.md"), "  \n"), join(root, "blank.md"))], "The message must not be empty", []],
    [["--task", "x".repeat(20)], "too long", []],
    [["--task", "fine"], "w1's process does not answer", [{ why: "refusal step" }]],
  ]) {
    const r = await sendCommand(["--name", "w1", ...args], opts(ws, { settings: () => ({ config: cfg(), notes: ["a settings note"] }) }));
    expect([r.ok, r.state, r.warnings, r.next]).toEqual([false, "failed", [...withheld, ...(args[1] === "fine" ? ["a settings note"] : [])], next]);
    expect(r.error).toContain(error);
  }
  // A harness turned off is refused after the settings notes are said.
  const off = await sendCommand(["--name", "w1", "--task", "fine"], opts(ws, { settings: () => cfg({ subscriptions: { claude: { enabled: false } } }) }));
  expect([off.ok, off.error.includes("off")]).toEqual([false, true]);
});

test("stop answers what the adapter found, and always says how to remove the run folder after", async () => {
  const root = scratch("worker-stop");
  worker(root);
  const f = fake({ stopped: { state: "lost", ok: false, said: "w1's process is gone", warnings: ["unseen"], next: [{ why: "clean up" }] } });
  const r = await stopCommand(["--name", "w1"], opts(workers({ root, adapters: { headless: f.adapter } })));
  expect([r.ok, r.state, r.headline, r.warnings]).toEqual([false, "lost", "routr: w1's process is gone", ["unseen"]]);
  expect(r.next.map((n) => n.why)).toEqual(["clean up", "Remove its run folder and reports once you have what you need from them."]);
  expect(r.next.at(-1).argv).toEqual(["routr", "cleanup", "--worker", "w1"]);
});

test("workers lists every worker of routr's, without what only a wait follows, and a named one that is not there fails", async () => {
  const root = scratch("worker-list");
  worker(root, "a1"); worker(root, "b2");
  const store = recordStore(root);
  mkdirSync(store.runDir("c3")); writeFileSync(join(store.runDir("c3"), "worker.json"), JSON.stringify({ format: 2, name: "c3" })); // not routr's
  const f = fake(), ws = workers({ root, adapters: { headless: f.adapter } });
  const r = await workersCommand([], opts(ws));
  expect([r.ok, r.headline, r.workers.map((w) => w.name)]).toEqual([true, "routr: a1 working, b2 working", ["a1", "b2"]]);
  for (const w of r.workers) { expect(w).not.toHaveProperty("gen"); expect(w).not.toHaveProperty("turns"); }
  const missing = await workersCommand(["--name", "c3"], opts(ws));
  expect([missing.ok, missing.error]).toEqual([false, "no worker named c3"]);
});

test("a record that cannot be read is shown by every command, never acted on, and stopped only where its run folder says what runs it", async () => {
  const root = scratch("worker-unreadable"), { dir } = worker(root);
  writeFileSync(join(dir, "worker.json"), "{");
  const f = fake(), ws = workers({ root, adapters: { headless: f.adapter } });
  const listed = await workersCommand([], opts(ws));
  expect(listed.workers).toEqual([{ name: "w1", kind: null, model: null, effort: null, cwd: null, state: "unreadable", turn: 0, seconds_since_event: null, last_tool: null, tasks: 0, queued: 0, session: null, report: null }]);
  const waited = await waitCommand(["--timeout", "0"], opts(ws));
  expect([waited.state, waited.headline]).toEqual(["running", "routr: still running: w1 (its state could not be read)"]);
  const why = "w1's worker.json could not be read just now (not_json), so what it is doing is not known: try again in a moment";
  const sent = await sendCommand(["--name", "w1", "--task", MARK], opts(ws));
  expect([sent.state, sent.error, sent.next.length]).toEqual(["failed", why, 2]);
  expect(sent.next[1].why).toContain(`keep what you need from ${dir}`);
  const stopped = await stopCommand(["--name", "w1"], opts(ws));
  expect([stopped.state, stopped.headline, stopped.next.length]).toEqual(["unknown", `routr: ${why}`, 3]);
  // Its run folder says a backend runs it: that backend is asked to stop it, with no record.
  const owner = fake({ stopped: { state: "stopped", ok: true, said: "stopped w1", warnings: [], next: [] } });
  const owned = await stopCommand(["--name", "w1"], opts(workers({ root, adapters: { headless: { ...owner.adapter, owns: () => true } } })));
  expect([owned.ok, owned.state]).toEqual([true, "stopped"]);
  await expect(watchCommand(["--name", "w1"], { workers: ws, write: () => {} })).rejects.toThrow("no worker named w1");
  expect(f.calls).toEqual([]);
});

test("watch follows one worker until its record is gone or another worker has its name", async () => {
  const root = scratch("worker-watch"), { dir, store } = worker(root), lines = [];
  let n = 0;
  const f = fake({ looks: [{}, { state: "idle", turns: [{ turn: 1, outcome: "finished", report: "/r/turn-1.md", delivered: 0 }] }] });
  const ws = workers({ root, adapters: { headless: f.adapter } });
  const code = await watchCommand(["--name", "w1"], { workers: ws, env: {}, write: (s) => lines.push(s), now: () => 0,
    // After two looks, the same name launched again: not this worker.
    pause: async () => { if (++n === 2) store.write(dir, newRecord({ name: "w1", kind: "claude", model: "m", cwd: "/work" }, { backend: "headless" })); } });
  expect(code).toBe(0);
  const text = lines.join("");
  expect(text).toContain("turn 1 ended (finished): report at /r/turn-1.md");
  expect(text.trim().split("\n").at(-1)).toEndWith("cleaned up");
  expect(f.calls.filter((c) => c[0] === "look")).toHaveLength(2);
});

const cleanupOut = () => ({ ok: false, headline: "", unavailable: [], warnings: [], next: [], steps: [], ran: [] });
test("finish removes a worker's run folder only after its backend says nothing of it runs, and a dry run removes nothing", async () => {
  const root = scratch("worker-finish"), { dir, record } = worker(root);
  const held = fake({ held: { why: "w1 is still running", next: [{ why: "wait" }] } });
  const kept = await workers({ root, adapters: { headless: held.adapter } }).finish("w1", {}, cleanupOut());
  expect([kept.state, kept.headline, kept.next]).toEqual(["refused", "routr: kept w1: w1 is still running", [{ why: "wait" }]]);
  const f = fake(), ws = workers({ root, adapters: { headless: f.adapter } });
  const planned = await ws.finish("w1", { dryRun: true }, cleanupOut());
  expect([planned.state, existsSync(dir)]).toEqual(["planned", true]);
  const removed = await ws.finish("w1", {}, cleanupOut());
  expect([removed.ok, removed.state, existsSync(dir)]).toEqual([true, "removed", false]);
  expect(f.calls).toEqual([["end", true], ["end", false], ["release", record.id]]);
  expect(removed.warnings).toEqual(["w1 worked in /work: its changes there are yours to check and keep"]);
  const absent = await ws.finish("w1", {}, cleanupOut());
  expect([absent.ok, absent.state]).toEqual([true, "absent"]);
});

test("finish binds the worker it looked at: one launched again under its name while cleanup waited for the lock is kept", async () => {
  const root = scratch("worker-relaunched"), { dir, store } = worker(root), lock = join(store.dir, "w1.lock");
  expect(takeLock(lock, lockIsStale)).toBe(true);
  const f = fake(), finishing = workers({ root, adapters: { headless: f.adapter } }).finish("w1", {}, cleanupOut());
  // While cleanup waits for the lock: w1 finished by hand, and another w1 launched.
  await Bun.sleep(150);
  const next = newRecord({ name: "w1", kind: "claude", model: "m", cwd: "/work" }, { backend: "headless" });
  store.write(dir, next);
  releaseFileLock(lock);
  const r = await finishing;
  expect([r.ok, r.state, r.headline]).toEqual([false, "refused", "routr: kept w1: its record changed while cleanup waited"]);
  expect(f.calls).toEqual([]);
  expect(store.read("w1").worker.id).toBe(next.id);
});

test("a finish for a worker shown to someone binds its id and what it was seen doing, checked under the lock", async () => {
  const root = scratch("worker-expect"), { dir, record } = worker(root), f = fake({ looks: [{ state: "idle" }] });
  const ws = workers({ root, adapters: { headless: f.adapter } });
  const other = await ws.finish("w1", { expect: { id: "f".repeat(32), states: ["idle"] } }, cleanupOut());
  expect([other.state, other.headline]).toEqual(["refused", "routr: kept w1: its record changed while cleanup waited"]);
  const busy = await ws.finish("w1", { expect: { id: record.id, states: ["finished", "gone"] } }, cleanupOut());
  expect([busy.state, busy.headline]).toEqual(["refused", "routr: kept w1: w1 is idle now, not finished or gone"]);
  expect(existsSync(dir)).toBe(true);
  const done = await ws.finish("w1", { expect: { id: record.id, states: ["idle"] } }, cleanupOut());
  expect([done.state, existsSync(dir)]).toEqual(["removed", false]);
  expect(f.calls.filter((c) => c[0] === "end")).toEqual([["end", false]]);
});

test("a record changed after launch is checked again as a whole, and the module's identity check follows the record there", () => {
  const root = scratch("worker-still"), { dir, record, store } = worker(root, "w1", { backend: "terminal", terminal_name: "w1", config: {} });
  const w = workers({ root, adapters: { headless: fake().adapter, terminal: elsewhere } }).one("w1");
  expect([w.backend, w.still()]).toEqual(["terminal", "same"]);
  store.write(dir, amend(record, { terminal: "t9" }));
  expect(w.still()).toBe("same");
  writeFileSync(join(dir, "worker.json"), "{");
  expect(w.still()).toEqual({ unreadable: "not_json" });
  store.write(dir, newRecord({ name: "w1", kind: "claude", model: "m", cwd: "/work" }, { backend: "headless" }));
  expect(w.still()).toBe("replaced");
});

test("a finish for a worker someone was shown needs an id to bind: none named, or a record with none, finishes nothing", async () => {
  const root = scratch("worker-expect-id"), { dir } = worker(root), f = fake({ looks: [{ state: "idle" }] });
  const ws = workers({ root, adapters: { headless: f.adapter } });
  for (const shown of [{ states: ["idle"] }, { id: undefined, states: ["idle"] }, { id: "", states: ["idle"] }]) {
    const r = await ws.finish("w1", { expect: shown }, cleanupOut());
    expect([r.state, r.headline]).toEqual(["refused", "routr: kept w1: its record changed while cleanup waited"]);
  }
  // A record written before records had ids: the commands take two with none as one worker, as they always have, but
  // nothing it was shown finishes it.
  const legacy = { format: 1, name: "w1", kind: "claude", model: "m", cwd: "/work" };
  writeFileSync(join(dir, "worker.json"), JSON.stringify(legacy));
  const w = ws.one("w1");
  expect(w.still()).toBe("same");
  const shown = await ws.finish("w1", { expect: { id: undefined, states: ["idle"] } }, cleanupOut());
  expect([shown.state, existsSync(dir)]).toEqual(["refused", true]);
  expect(f.calls.filter((c) => c[0] === "end")).toEqual([]);
  // cleanup --worker itself finishes it, as it always has.
  const cli = await ws.finish("w1", {}, cleanupOut());
  expect([cli.state, existsSync(dir)]).toEqual(["removed", false]);
});

test("a record's backend picks only the table's own adapters: any other name, an inherited one included, reads as headless", async () => {
  const root = scratch("worker-dispatch"), store = recordStore(root), f = fake();
  for (const [name, backend] of [["a1", "constructor"], ["b2", "toString"], ["c3", "__proto__"], ["d4", "pane"]]) {
    mkdirSync(store.runDir(name), { recursive: true });
    writeFileSync(join(store.runDir(name), "worker.json"), JSON.stringify({ format: 1, id: name.repeat(16), name, kind: "claude", model: "m", cwd: "/work", backend }));
  }
  const r = await workersCommand([], opts(workers({ root, adapters: { headless: f.adapter, terminal: elsewhere } })));
  expect([r.ok, r.workers.map((w) => [w.name, w.state])]).toEqual([true, [["a1", "working"], ["b2", "working"], ["c3", "working"], ["d4", "working"]]]);
  expect(f.calls.filter((c) => c[0] === "look").map((c) => c[1])).toEqual(["a1", "b2", "c3", "d4"]);
});

test("wait points at what a backend's look says for a turn that ended without a report, and at the worker's folder otherwise", async () => {
  const root = scratch("worker-wait-next");
  worker(root, "a1"); worker(root, "b2");
  const ended = { state: "idle", turns: [{ turn: 1, outcome: "finished", report: null, delivered: 0 }] }, f = fake({ looks: [ended] });
  const adapter = { ...f.adapter, look: async (me, o) => { const l = await f.adapter.look(me, o); return me.name === "a1" ? { ...l, next: [{ why: "read its terminal" }] } : l; } };
  const r = await waitCommand(["--name", "a1", "--name", "b2", "--timeout", "0"], opts(workers({ root, adapters: { headless: adapter } })));
  expect(r.state).toBe("finished");
  expect(r.next.map((n) => n.why)).toEqual(["read its terminal", "b2's turn 1 ended (finished) without a report: look at the worker's folder and its changes yourself."]);
});

test("workers --name refuses a worker cleaned up or replaced by another's folder before it was looked at; unnamed, it is left out", async () => {
  const root = scratch("worker-vanished"), f = fake();
  for (const replace of [(dir) => rmSync(dir, { recursive: true }), (dir) => writeFileSync(join(dir, "worker.json"), JSON.stringify({ format: 2, name: "w1" }))]) {
    const { dir } = worker(root), real = workers({ root, adapters: { headless: f.adapter } });
    const ws = { ...real, find: (n) => { const h = real.find(n); replace(dir); return h; }, all: () => { const hs = real.all(); replace(dir); return hs; } };
    const named = await workersCommand(["--name", "w1"], opts(ws));
    expect([named.ok, named.error]).toEqual([false, "no worker named w1"]);
    rmSync(dir, { recursive: true, force: true }); worker(root);
    const unnamed = await workersCommand([], opts(ws));
    expect([unnamed.ok, unnamed.workers]).toEqual([true, []]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unnamed wait that finds a running folder whose record is not routr's fails as for a name, and passes over one at rest", async () => {
  const root = scratch("worker-wait-foreign"), store = recordStore(root), dir = store.runDir("w1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worker.json"), JSON.stringify({ format: 2, name: "w1" }));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "working", turn: 1, turns: [{ turn: 1 }] }));
  // The real adapters: whether a folder runs is read from its holder's state, as a headless worker's is.
  const r = await waitCommand(["--timeout", "0"], opts(workers({ root })));
  expect([r.ok, r.state, r.error]).toEqual([false, "failed", "no worker named w1; routr workers lists them"]);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "idle", turn: 1, turns: [{ turn: 1, outcome: "finished" }] }));
  writeFileSync(join(dir, "seen.json"), JSON.stringify({ turn: 1, notice: null }));
  const atRest = await waitCommand(["--timeout", "0"], opts(workers({ root })));
  expect([atRest.ok, atRest.state, atRest.headline]).toEqual([true, "none", "routr: no worker to wait on"]);
});

test("an action's identity is the record's id as written: different ids are different workers, whatever their kind", async () => {
  const root = scratch("worker-raw-ids"), store = recordStore(root), dir = store.runDir("w1"), f = fake();
  mkdirSync(dir, { recursive: true });
  const as = (id) => writeFileSync(join(dir, "worker.json"), JSON.stringify({ format: 1, name: "w1", kind: "claude", model: "m", cwd: "/work", ...(id === undefined ? {} : { id }) }));
  const ws = workers({ root, adapters: { headless: f.adapter } });
  for (const [first, then, want] of [[0, 1, "replaced"], [undefined, null, "replaced"], [null, undefined, "replaced"], [0, "0", "replaced"], [undefined, undefined, "same"], [0, 0, "same"]]) {
    as(first); const w = ws.one("w1"); as(then);
    expect([first, then, w.still()]).toEqual([first, then, want]);
  }
  // A finish for a worker someone was shown never binds an id that is not a string, even one that matches.
  as(0);
  const shown = await ws.finish("w1", { expect: { id: 0, states: ["working"] } }, cleanupOut());
  expect([shown.state, existsSync(dir)]).toEqual(["refused", true]);
});

test("what a command sees follows the name: a worker launched again under it while wait sleeps is shown as it is now", async () => {
  const root = scratch("worker-relaunched-seen"), { dir, store } = worker(root), f = fake({ looks: [{ state: "working" }] });
  const ws = workers({ root, adapters: { headless: f.adapter } });
  let t = 0;
  const r = await waitCommand(["--name", "w1", "--timeout", "1000"], opts(ws, { now: () => t,
    pause: async () => { store.write(dir, newRecord({ name: "w1", kind: "claude", model: "m2", cwd: "/work" }, { backend: "headless" })); t += 2000; } }));
  expect([r.state, r.workers.map((w) => [w.name, w.model])]).toEqual(["running", [["w1", "m2"]]]);
  // A handle looks at what is under its name now; only an action asks whether it is still the worker it began with.
  const w = ws.one("w1");
  store.write(dir, newRecord({ name: "w1", kind: "claude", model: "m3", cwd: "/work" }, { backend: "headless" }));
  expect([(await w.look()).view.model, w.still()]).toEqual(["m3", "replaced"]);
  const listed = await workersCommand(["--name", "w1"], opts({ ...ws, find: () => w }));
  expect(listed.workers.map((x) => x.model)).toEqual(["m3"]);
});

test("a wait keeps looking through the adapter it began with: a record unreadable at first and a terminal worker's later reads as main read it", async () => {
  const root = scratch("worker-recovered"), store = recordStore(root), dir = store.runDir("w1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worker.json"), "{");
  const record = newRecord({ id: "c".repeat(32), name: "w1", kind: "claude", model: "m", cwd: "/work" }, { backend: "terminal", terminal_name: "w1", config: {} });
  let t = 0;
  // The real adapters, and no hc: a terminal adapter asked here would fail.
  const r = await waitCommand(["--name", "w1", "--timeout", "1000"], opts(workers({ root, hc: async () => { throw new Error("hc asked"); } }), { now: () => t,
    pause: async () => { store.write(dir, amend(record, { terminal: "t9" })); t += 2000; } }));
  // What main answers for the same files (checked against main with this home's layout).
  expect(r).toEqual({ ok: true, headline: "routr: still running: w1", unavailable: [], warnings: [], state: "running",
    next: [{ kind: "run", why: "Wait for the workers still running.", argv: ["routr", "wait", "--name", "w1"], command: "routr wait --name w1" }],
    workers: [{ name: "w1", kind: "claude", model: "m", effort: null, cwd: "/work", state: "starting", gen: 0, turn: 0, seconds_since_event: null, last_tool: null, tasks: 0, queued: 0, session: null, report: null, turns: [] }] });
});

test("an action reads its worker again where it starts: one whose record could not be read when its handle was made is acted on once it can", async () => {
  const root = scratch("worker-action-fresh"), { dir, record, store } = worker(root);
  const sent = { state: "delivered", ok: true, message: { code: "accepted" }, said: "w1: taken", next: [] };
  const f = fake({ sent, pending: false, stopped: { state: "stopped", ok: true, said: "stopped w1", warnings: [], next: [] } });
  const ws = workers({ root, adapters: { headless: f.adapter } });
  writeFileSync(join(dir, "worker.json"), "{");
  const w = ws.one("w1");
  expect([w.record, w.unreadable, w.pending(0)]).toEqual([null, "not_json", true]);
  store.write(dir, record);
  expect(w.pending(0)).toBe(false);
  expect((await w.send(() => "fix it", { settings: () => cfg() })).state).toBe("delivered");
  expect((await w.stop()).state).toBe("stopped");
  // And the other way: readable when the handle was made, unreadable when it acts, is refused as unreadable.
  const v = ws.one("w1");
  writeFileSync(join(dir, "worker.json"), "{");
  await expect(v.send(() => "fix it", { settings: () => cfg() })).rejects.toThrow("w1's worker.json could not be read just now (not_json)");
  expect((await v.stop()).state).toBe("unknown");
  expect(f.calls.filter((c) => ["send", "stop", "pending"].includes(c[0])).map((c) => c[0])).toEqual(["pending", "send", "stop"]);
});

// ---- the headless adapter's classification, against a stubbed channel ------------------------------------------------
const classify = (cases) => {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/headless-classify.mjs"), JSON.stringify(cases)], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString());
};
const ALIVE = { state: "alive", gen: 1, ready: { endpoint: "x" } };

test("the headless adapter says what a send's reply was in routr's words, and any code it does not know as one fixed code", () => {
  const replies = [
    [{ reply: { code: "handed_to_harness" } }, "delivered", true, { code: "handed_to_harness" }, "w1: written to the running worker's input (not yet proven read)"],
    [{ reply: { code: "accepted" } }, "delivered", true, { code: "accepted" }, "w1: taken by the running worker (into its running turn, or as its next)"],
    [{ reply: { code: "queued", why: "next_turn" } }, "queued", true, { code: "queued", why: "next_turn" }, "w1: queued: it runs as the worker's next turn, once the running one ends"],
    [{ reply: { code: "queued" } }, "queued", true, { code: "queued" }, "w1: queued: it runs as the worker's next turn, in a new Claude Code process on the same session"],
    [{ reply: { code: "prompted", session: MARK } }, "resumed", true, { code: "prompted" }, "w1: the worker resumed its session with it as the next turn"],
    [{ reply: { code: "refused", why: "queue_full" } }, "refused", false, { code: "refused", why: "queue_full" }, "w1 did not take the message (queue_full)"],
    [{ reply: { code: "failed" } }, "refused", false, { code: "failed" }, "w1 did not take the message (failed)"],
    [{ reply: { code: "unknown", why: "no_reply" } }, "unknown", false, { code: "unknown", why: "no_reply" }, "whether w1 took the message is not known (no_reply)"],
    [{ requestError: "ETIMEDOUT" }, "unknown", false, { code: "unknown", why: "ETIMEDOUT" }, "whether w1 took the message is not known (ETIMEDOUT)"],
    [{ requestError: null }, "unknown", false, { code: "unknown", why: "no_answer" }, "whether w1 took the message is not known (no_answer)"],
    // From outside routr's lists: a code or reason it does not know is said as one fixed code, never as it came.
    [{ reply: { code: MARK, why: MARK } }, "refused", false, { code: "unrecognised", why: "unrecognised" }, "w1 did not take the message (unrecognised)"],
    [{ reply: { code: "refused", why: MARK } }, "refused", false, { code: "refused", why: "unrecognised" }, "w1 did not take the message (unrecognised)"],
    [{ connectError: MARK.toLowerCase() }, "unknown", false, { code: "unknown", why: "unrecognised" }, "whether w1 took the message is not known (unrecognised)"],
  ];
  const got = classify(replies.map(([c]) => ({ op: "send", probe: ALIVE, ...c })));
  expect(got.map((r) => [r.state, r.ok, r.message, r.said])).toEqual(replies.map(([, ...want]) => want));
  expect(JSON.stringify(got)).not.toContain(MARK);
  expect(JSON.stringify(got)).not.toContain(MARK.toLowerCase());
});

test("the headless adapter says what a stop found from the probe and the holder's reply", () => {
  const cases = [
    [{ probe: ALIVE, reply: { code: "stopped" } }, "stopped", true, "stopped w1", [], 0],
    [{ probe: ALIVE, reply: { code: "stopped", dropped: 2 } }, "stopped", true, "stopped w1", ["messages_dropped"], 0],
    [{ probe: ALIVE, reply: { code: "still_exiting" } }, "still_exiting", false, "w1 was told to stop and has not finished exiting", [], 1],
    [{ probe: ALIVE, reply: { code: MARK } }, "unknown", false, "w1 was told to stop and has not finished exiting", [], 1],
    [{ probe: ALIVE, requestError: "ECLOSED" }, "unknown", false, "w1 was told to stop and has not finished exiting", [], 1],
    ...["released", "none", "abandoned"].map((state) => [{ probe: { state, gen: 1 } }, "absent", true, "w1 is not running", [], 0]),
    [{ probe: { state: "dead", gen: 1 } }, "lost", false, "w1's process is gone", ["process_unseen"], 1],
    [{ probe: { state: "unreachable", gen: 1 } }, "unreachable", false, "w1's process does not answer", ["process_unseen"], 1],
    [{ probe: { state: "unreachable", gen: 1, unreadable: { file: "gen-1.ready", code: "EACCES" } } }, "unreachable", false, "w1's gen-1.ready could not be read just now (EACCES), so what it is doing is not known: try again in a moment", ["process_unseen"], 2],
    [{ probe: { state: "none", gen: 0 }, unreadable: "not_json" }, "unknown", false, "w1's worker.json could not be read just now (not_json), so what it is doing is not known: try again in a moment", [], 1],
  ];
  const got = classify(cases.map(([c]) => ({ op: "stop", ...c })));
  const kind = (w) => (/dropped by the stop/.test(w) ? "messages_dropped" : /never by a saved process id/.test(w) ? "process_unseen" : w);
  expect(got.map((r) => [r.state, r.ok, r.said, r.warnings.map(kind), r.next.length])).toEqual(cases.map(([, ...want]) => want));
  expect(JSON.stringify(got)).not.toContain(MARK);
});
