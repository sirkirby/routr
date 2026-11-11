// The worker module: what the worker commands do to one worker, whatever runs it. `workers()` finds workers by name in a
// record store; each Worker looks, sends, stops and checks it is still itself through the adapter for its backend,
// chosen from its record in one table (ADAPTERS), and nowhere else after launch. Looking follows the name: the record
// there now. Acting follows the identity: the record an action starts with, its id checked where it acts. What a backend's own files and
// processes say (a holder's probe states and replies, hc's answers) is classified inside its adapter: a command gets
// fixed codes, routr's own words, paths and checked numbers, never text from outside. A refusal is a `Refused`, carrying
// the warnings and next steps gathered before it. Finishing a worker (cleanup --worker) is here too: under its lock, only
// while it is still the worker that was looked at, its backend's part, then its worktree and run folder.
import { warning } from "./warnings.mjs";
import { linkWorker } from "./traces.mjs";
import { existsSync, rmSync } from "node:fs";
import { recordStore, unreadableWhy } from "./worker-record.mjs";
import { headless } from "./backend-headless.mjs";
import { terminal } from "./backend-terminal.mjs";
import { git } from "./worktree.mjs";
import { HARNESSES, notReady } from "./harnesses.mjs";
import { configOf } from "./config.mjs";
import { displayCommand, doNext, runNext } from "./next.mjs";
import { CLOSING, OFF } from "./wording.mjs";
import { inCore } from "./backends.mjs";
import { folderId, realOr, STATE_DIR } from "./state-files.mjs";

// Where a worker runs, read from its record, picks the adapter that does what the commands ask of it. The one table.
// A record that names a backend this routr has no adapter for is read as headless, as every record was before
// terminal workers; so is a folder that is not routr's when a wait asks whether it runs. The table's own entries only:
// a record's `backend` is text from a file, and "constructor" or "__proto__" must not reach what an object inherits.
export const ADAPTERS = { headless, terminal };
const adapterFor = (adapters, record) => (typeof record.backend === "string" && Object.hasOwn(adapters, record.backend) ? adapters[record.backend] : adapters.headless);

export class Refused extends Error {
  constructor(message, { state = "failed", warnings = [], next = [] } = {}) { super(message); this.name = "Refused"; this.state = state; this.warnings = warnings; this.next = next; }
}
// Any failure as a Refused, with what was gathered before it first: its words, and the steps it carried.
const refusedWith = (e, warnings = [], next = []) => {
  if (e instanceof Refused) { e.warnings = [...warnings, ...e.warnings]; e.next = [...next, ...e.next]; return e; }
  return new Refused(String(e?.message ?? e), { warnings, next: [...next, ...(Array.isArray(e?.next) ? e.next : [])] });
};

// A worker file that stays unreadable (its permissions, or damage), and routr acts on none of the worker: what a person
// does then. `w` is its record when that was read, for its worktree.
const damagedNext = (dir, name, w = null) => [runNext("Look again in a moment.", ["routr", "workers", "--name", name]),
  doNext(`If it stays unreadable, routr will not act on ${name}: check the file's permissions, or whether it is damaged; then make sure nothing of it still runs${w?.worktree ? `, finish its worktree with ${displayCommand(["routr", "cleanup", "--cwd", w.worktree.source, "--path", w.worktree.path])}` : ""}, keep what you need from ${dir}, then remove that folder yourself.`)];
// A worker whose record cannot be read, as every command shows it: there, with nothing it would have said.
const unreadableView = (name) => ({ name, kind: null, model: null, effort: null, cwd: null, state: "unreadable", gen: 0, turn: 0, seconds_since_event: null,
  last_tool: null, tasks: 0, queued: 0, session: null, report: null, turns: [] });

// `root`: the state folder the records are under. `env`, `ready`, `spawn` and `hc` are what an adapter starts or asks
// with; a test passes fakes, and `adapters` to replace the table.
export function workers({ root = STATE_DIR(), adapters = ADAPTERS, env = process.env, ready = notReady, spawn, hc } = {}) {
  const store = recordStore(root), ctx = { env, ready, spawn, hc, store };
  // Every record a command reads is linked to its launch's span, where that command is traced.
  const read = (name) => { const r = store.read(name); if (r.worker) linkWorker(r.worker); return r; };

  // Identity: the record under the name now against the id an action started with, compared as they are written, as
  // send and watch always have. A name is not an identity.
  const identity = (name, id) => { const r = store.read(name); return r.unreadable ? { unreadable: r.unreadable } : !r.worker ? "gone" : r.worker.id === id ? "same" : "replaced"; };
  // The worker as one read found it, for an action: its record (or why there is none), the adapter that record picks
  // from the table, and `me`, what that adapter is given. With no record to say, the run folder's own markers say whose
  // it is, or nothing does. `me.still()` checks the record's id as read here.
  const actor = (name, found) => {
    const dir = store.runDir(name), record = found.worker ?? null, unreadable = found.unreadable ?? null;
    const backend = record ? record.backend : Object.keys(adapters).find((k) => adapters[k].owns?.(dir)) ?? null;
    const adapter = record ? adapterFor(adapters, record) : backend ? adapters[backend] : null, id = record?.id;
    return { record, unreadable, backend, adapter, me: { name, dir, record, unreadable, damaged: () => damagedNext(dir, name, record), still: () => identity(name, id) } };
  };
  const refuseIfFollowed = (act, op) => { const off = act.record ? act.adapter.follows(act.me, op) : null; if (off) throw new Refused(off.why, { state: "refused", next: off.next }); };
  // An action reads the worker again where it starts, as the commands always have: never from what an earlier read found.
  const actorNow = (name) => {
    const act = actor(name, read(name));
    if (!act.record && !act.unreadable) throw new Refused(`no headless worker named ${name}; routr workers lists them`);
    return act;
  };

  // A worker by its name, as `found` (the store's read) found it: a record, one that cannot be read, or a folder with no
  // record of routr's (`all({ strangers })` only). Observations (look, pending) follow the name: each reads the record
  // there now and answers for it, through the adapter it picks. Actions (send, stop) follow the identity: each reads the
  // record where it starts, and its adapter checks that record's id (`still()`) where it acts. What was found here
  // decides only `follows` (whether a command acts on it at all), the adapter a wait keeps looking through, and the id
  // `still()` compares with (watch's).
  const handle = (name, found) => {
    const start = actor(name, found), dir = start.me.dir;
    // A wait looks at what it watches through the adapter it chose when it began; one whose record could not be read
    // then is looked at as headless, as every worker was before terminal workers.
    const kept = start.record ? start.adapter : adapters.headless;
    const meFor = (r) => ({ ...start.me, record: r, unreadable: null, damaged: () => damagedNext(dir, name, r), still: () => identity(name, r.id) });
    return {
      name, dir, record: start.record, unreadable: start.unreadable, backend: start.backend, still: start.me.still,
      follows: (op) => (start.record ? start.adapter.follows(start.me, op) : null),
      // What it looks like now: { view, next }, or null when no record of routr's is there (cleaned up). One whose record
      // cannot be read is shown, as `unreadable`, never left out as no worker. `kept`: through the adapter chosen when
      // this handle was made, as a wait does for what it watches; otherwise through the one the record now picks.
      async look({ check = true, ms, kept: keep = false } = {}) {
        const now = read(name);
        if (now.unreadable) return { view: unreadableView(name), next: [] };
        if (!now.worker) return null;
        return (keep ? kept : adapterFor(adapters, now.worker)).look(meFor(now.worker), { check, ms }, ctx);
      },
      // Whether a wait with no names watches it, from what is there now. One whose record cannot be read is: it may be
      // running. A folder with no record of routr's is asked as a headless worker's would be, and the wait refuses it
      // when it runs.
      pending(reported) {
        const now = read(name);
        if (now.unreadable) return true;
        return Boolean((now.worker ? adapterFor(adapters, now.worker) : adapters.headless).pending(now.worker ? meFor(now.worker) : { ...start.me, record: null }, reported, ctx));
      },
      // A message for it, from `message()` (read only after the warnings that come before it). Answers
      // { state, ok, message, said, warnings, next } or throws Refused.
      async send(message, { settings }) {
        const warnings = [];
        try {
          const act = actorNow(name), { record, adapter, me } = act;
          if (act.unreadable) throw new Refused(unreadableWhy(name, "worker.json", act.unreadable), { next: me.damaged() });
          refuseIfFollowed(act, "send");
          warnings.push(...(adapter.beforeSend?.(me) ?? []));
          const text = message();
          if (!text?.trim()) throw new Error("The message must not be empty");
          const full = `${text.trim()}\n\n${CLOSING}`, big = adapter.limit?.(full);
          if (big) throw new Error(big);
          const loaded = settings(), config = configOf(loaded);
          warnings.push(...(loaded.notes ?? []));
          if (config.subscriptions[record.kind]?.enabled === false) throw new Error(OFF.launch(HARNESSES[record.kind].label, record.kind));
          const r = await adapter.send(me, full, ctx);
          return { ...r, warnings: [...warnings, ...(r.warnings ?? [])] };
        } catch (e) { throw refusedWith(e, warnings); }
      },
      // Stop it: { state, ok, said, warnings, next }. A record that cannot be read is still stopped where the run folder
      // says what runs it; where nothing does, what runs of it is not known.
      async stop() {
        try {
          const act = actorNow(name);
          refuseIfFollowed(act, "stop");
          if (act.adapter?.stop) return await act.adapter.stop(act.me, ctx);
          return { state: "unknown", ok: false, said: unreadableWhy(name, "worker.json", act.unreadable), warnings: [], next: act.me.damaged() };
        } catch (e) { throw refusedWith(e); }
      },
    };
  };
  const found = (name) => { const r = read(name); return r.worker || r.unreadable ? handle(name, r) : null; };

  return {
    // The worker of this name, or Refused when there is none of routr's (one whose record cannot be read is one).
    one: (name) => found(name) ?? (() => { throw new Refused(`no headless worker named ${name}; routr workers lists them`); })(),
    find: found,
    // Every worker in the store, in name order: an unreadable one kept, and a folder that is not one of routr's left out,
    // or, with `strangers`, kept with no record (for an unnamed wait, which says it is not a worker when it runs).
    all: ({ strangers = false } = {}) => store.names().map((n) => { const r = read(n); return r.worker || r.unreadable || strangers ? handle(n, r) : null; }).filter(Boolean),
    // `cleanup --worker`: removes a worker's run folder (its reports with it) once nothing of it runs, under the lock a
    // new holder is started under. A worktree launch made for it goes first, through cleanup's own checks (nothing
    // uncommitted, no file the worker made, no commit no branch holds), and the run folder stays when cleanup keeps the
    // worktree. Without one, its work, in its folder, is the lead's to integrate: cleanup touches no repository. Its
    // backend's part comes first: a headless worker's holder must be gone, a terminal worker's terminal is ended.
    // `expect: { id, states }` is for an action that finishes one worker it was shown: refused unless, under the lock,
    // the record is still that id and its look is in one of `states`. `out` is cleanup's answer, filled in place.
    async finish(name, { dryRun = false, deleteBranch = false, expect } = {}, out) {
      const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail });
      const refuse = (why, next) => { out.ok = false; out.state = "refused"; out.headline = `routr: kept ${name}: ${why}`; out.next.push(...[].concat(next)); step("refused", false, why); return out; };
      const dir = store.runDir(name);
      out.name = name;
      const first = read(name);
      if (first.unreadable) return refuse(unreadableWhy(name, "worker.json", first.unreadable), damagedNext(dir, name));
      if (!first.worker) {
        if (existsSync(dir)) return refuse("its folder is not one routr's launch wrote", doNext(`Look at ${dir} yourself.`));
        out.ok = true; out.state = "absent"; out.headline = `routr: nothing to remove: no worker ${name}`; return out;
      }
      const it = actor(name, first);
      return store.lock(name, async (assertOwned) => {
        // Read again under the lock: it may have changed while cleanup waited for it. Still this worker, by its id: one
        // cleaned up and launched again under that name meanwhile is another, and is not finished on this one's checks.
        const again = read(name), w = again.worker, same = it.me.still();
        if (!w || same !== "same") return refuse(again.unreadable ? unreadableWhy(name, "worker.json", again.unreadable) : "its record changed while cleanup waited", damagedNext(dir, name));
        // A finish for a worker someone was shown binds its id: a record with none, or an action that names none, is
        // never finished by its name and state alone.
        if (expect) {
          if (typeof expect.id !== "string" || !expect.id || expect.id !== w.id) return refuse("its record changed while cleanup waited", damagedNext(dir, name));
          const seen = (await handle(name, again).look())?.view.state ?? "gone";
          if (!expect.states?.includes(seen)) return refuse(`${name} is ${seen} now, not ${expect.states?.join(" or ")}`, runNext("Look at it.", ["routr", "workers", "--name", name]));
        }
        const adapter = it.adapter, me = it.me;
        const held = await adapter.end(me, { dryRun, out, assertOwned }, ctx);
        if (held) return refuse(held.why, held.next);
        if (w.worktree) {
          const { cleanup, worktreesFromGit } = await import("./cleanup.mjs");
          // The worktree at that path must still be this worker's: on its branch. One put there since is someone else's.
          const listed = await git(w.worktree.source, ["worktree", "list", "--porcelain"]);
          const there = listed.ok ? worktreesFromGit(listed.out).worktrees.find((x) => x.is_linked_worktree && realOr(x.path) === realOr(w.worktree.path)) : null;
          if (!listed.ok) return refuse(`git could not list the worktrees of ${w.worktree.source} (${listed.code})`, runNext("Look at them.", ["git", "-C", w.worktree.source, "worktree", "list"]));
          const finish = doNext(`Look at ${w.worktree.path}; finish it with routr cleanup --cwd ${w.worktree.source} --path ${w.worktree.path} if it should go.`);
          // A detached one may still be the worker's own (it checked out a commit): never removed on that guess either.
          if (there?.is_detached && folderId(w.worktree.path) === w.worktree.folder) return refuse(`the worktree at ${w.worktree.path} is detached, no longer on ${w.worktree.branch}: what it holds is not checked`, finish);
          if (there && there.branch !== w.worktree.branch) return refuse(`the worktree at ${w.worktree.path} is ${there.branch ? `on branch ${there.branch}` : "detached"}, not on ${w.worktree.branch}: it is not the one launch made`, finish);
          if (there && folderId(w.worktree.path) !== w.worktree.folder) return refuse(`the worktree at ${w.worktree.path} was made again since launch: it is not the one launch made`, finish);
          // Through git, as launch made it; in herdr-core with core's terminals checked too, but for this worker's own.
          const core = inCore(env) ? { HC_TERMINAL_ID: env.HC_TERMINAL_ID } : {};
          const r = await cleanup(["--cwd", w.worktree.source, "--path", w.worktree.path, ...(deleteBranch ? ["--delete-branch"] : []), ...(dryRun ? ["--dry-run"] : [])], { env: core, assertOwned, ...(hc ? { hc } : {}), ownWorker: w.id });
          out.ran.push(...r.ran); out.unavailable.push(...r.unavailable);
          // The worker's own process and its harness's process group were checked above; what that cannot see is said here.
          const label = HARNESSES[w.kind]?.label ?? "the harness";
          out.warnings.push(...r.warnings.filter((x) => !/cannot see whether anything runs/.test(x)),
            warning("detached_unseen", `cleanup cannot see a command ${name} started that left ${label}'s process group or detached itself${process.platform === "win32" ? ` (on Windows, anything once ${label} has ended)` : ""}: stop any such command before cleanup`));
          const why = r.steps.find((x) => x.step === "refused")?.detail;
          if (!["removed", "absent", "planned"].includes(r.state)) return refuse(r.state === "failed" ? `its worktree could not be checked (${r.error})` : why ?? r.headline, r.next);
          // git lists no worktree there, yet a folder is: whose it is cannot be told, so it and the worker's record stay.
          if (r.state === "absent" && existsSync(w.worktree.path)) return refuse(`git lists no worktree at ${w.worktree.path}, yet a folder is there: routr cannot tell it is the one launch made`, doNext(`Look at ${w.worktree.path}; remove it yourself if nothing in it is needed, then run cleanup again.`));
          out.worktree = r.worktree ?? { path: w.worktree.path, branch: w.worktree.branch };
          if (r.branch) out.branch = r.branch;
          for (const s of r.steps) out.steps.push(s);
        }
        const helper = HARNESSES[w.kind]?.helper;
        if (helper) out.warnings.push(helper.left(w.cwd));
        if (dryRun) { out.ok = true; out.state = "planned"; out.headline = `routr: would remove ${dir}${w.worktree ? ` and ${w.worktree.path}` : ""}`; step("plan", true, `Would remove ${dir} and its reports`); return out; }
        assertOwned();
        adapter.release(me, assertOwned);
        assertOwned();
        rmSync(dir, { recursive: true, force: true });
        step("remove", true, `Removed ${dir} and its reports`);
        out.ok = true; out.state = "removed"; out.headline = `routr: removed worker ${name}`;
        if (!w.worktree) out.warnings.push(warning("work_kept", `${name} worked in ${w.cwd}: its changes there are yours to check and keep`));
        return out;
      });
    },
  };
}
