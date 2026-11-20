// A worker's record: its name rule, the one constructor both launches build it with, the one check every reader reads
// it through, and where records are kept under a state root (recordStore). Nothing here knows how a worker runs; a
// backend's own state stays with that backend. Imports only node: and the state files: help reads NAME_RULE while it
// loads, and nothing else may come with it.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { lockIsStale, lockOwned, lockToken, readJsonFile, releaseFileLock, STATE_DIR, takeLock, writeJsonAtomic } from "./state-files.mjs";

// A worker's name (launch --name), which cleanup --worker, the worker commands and a span's agent name take.
export const NAME_RULE = "[a-z][a-z0-9_-]{0,31}", WORKER_NAME = new RegExp(`^${NAME_RULE}$`);
export const FORMAT = 1;
// Set at hc run with the record's id, and read back before routr ends a terminal: an address lasts on one core only, and
// another core can have the same address under the same name. An id made for this worker cannot be another's.
export const WORKER_LABEL = "routr.worker";
// The backends a record is built for: the ones routr keeps a run folder for. A pane worker has none.
export const RECORD_BACKENDS = ["headless", "terminal"];

// ---- building one -------------------------------------------------------------------------------------------------
// The record's shape, as code: each field and what it must be. Never the brief, and of the environment only the
// trace-context carriers within routr's limits, which every load checks again (savedCarriers). A terminal worker's also
// has `terminal` (its address, once hc gave one), `terminal_name` and `config` (where-is-my-config paths, checked again
// by savedConfigLocations); its prompt is a file beside the record, never in it.
// One launched on an extra account also has `subscription`, its name, `config_dir`, its folder, and `default_folder`,
// whether its variable was removed: the account is made again from them at every start (harnesses' workerAccount).
const str = (v) => typeof v === "string" && v !== "";
const plain = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const SHAPE = {
  format: (v) => v === FORMAT, id: (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v), name: (v) => typeof v === "string" && WORKER_NAME.test(v),
  backend: (v) => RECORD_BACKENDS.includes(v), kind: str, model: str, effort: (v) => v === null || str(v), cwd: str,
  created_at: (v) => typeof v === "string" && Number.isFinite(Date.parse(v)),
  carriers: (v) => plain(v) && Object.values(v).every((x) => typeof x === "string"),
  subagent_model: str, subagent_effort: str, launch: plain, subscription: str, config_dir: str, default_folder: (v) => typeof v === "boolean",
  worktree: (v) => plain(v) && ["branch", "path", "source"].every((k) => str(v[k])),
  terminal: str, terminal_name: str, config: (v) => plain(v) && Object.values(v).every((x) => typeof x === "string"),
};
const REQUIRED = { headless: ["format", "id", "name", "backend", "kind", "model", "effort", "cwd", "created_at", "carriers"] };
REQUIRED.terminal = [...REQUIRED.headless, "terminal_name", "config"];
const ONLY = { headless: new Set([...REQUIRED.headless, "subagent_model", "subagent_effort", "launch", "worktree", "subscription", "config_dir", "default_folder"]) };
ONLY.terminal = new Set([...ONLY.headless, "terminal_name", "config", "terminal"]);
// Strict: a field missing, of the wrong kind, or not of this backend is a mistake in routr, never the user's input.
const built = (r) => {
  const backend = RECORD_BACKENDS.includes(r.backend) ? r.backend : null;
  const bad = !backend ? ["backend"] : [...REQUIRED[backend].filter((k) => !Object.hasOwn(r, k)), ...Object.keys(r).filter((k) => !ONLY[backend].has(k) || !SHAPE[k](r[k]))];
  if (bad.length) throw new Error(`routr built a worker record it would not read back (${[...new Set(bad)].join(", ")})`);
  return r;
};
// Optional fields are left out when not given, so a record says only what launch decided.
const given = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
// `common`: what every launch decides. `where`: { backend: "headless" } or { backend: "terminal", terminal_name, config }.
// `id` is made here unless launch needed it first (a terminal's program carries it).
export function newRecord({ id, name, kind, model, effort = null, cwd, carriers = {}, subscription, config_dir, default_folder, subagent_model, subagent_effort, launch, worktree }, { backend, ...where }) {
  return built({ format: FORMAT, id: id ?? randomUUID().replace(/-/g, ""), name, backend, kind, model, effort: effort ?? null, cwd, created_at: new Date().toISOString(), carriers,
    ...given({ subscription, config_dir, default_folder, subagent_model, subagent_effort }), ...given(where), ...given({ launch, worktree }) });
}
// A record launch built, with what it learned since (a terminal's address and name), checked again as a whole.
export const amend = (record, patch) => built({ ...record, ...patch });

// ---- reading one --------------------------------------------------------------------------------------------------
// What every reader takes for a record of routr's: this format, and the name of its own folder. Lenient on the rest, as
// it has always been: a record that names no backend is headless, as every record written before terminal workers is.
// Anything else is null: another shape, not routr's.
export const checkRecord = (value, name) => (value?.format === FORMAT && typeof value.name === "string" && value.name === name && WORKER_NAME.test(name)
  ? { ...value, backend: value.backend ?? "headless" } : null);
// The same, from a run folder named by its path, for a process whose HOME may not be the one launch ran under.
export const readRecordAt = (dir) => checkRecord(readJsonFile(join(dir, "worker.json")).value, basename(dir));
// A worker file that is there and cannot be read, said to a person: the file, the code, and that it may pass.
export const unreadableWhy = (name, file, code) => `${name}'s ${file} could not be read just now (${code}), so what it is doing is not known: try again in a moment`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Where records are kept: `<root>/workers/<name>/worker.json`, root defaulting to this home's state folder.
export function recordStore(root = STATE_DIR()) {
  const dir = join(root, "workers"), runDir = (name) => join(dir, name);
  return {
    root, dir, runDir,
    // Every name a worker can be given, the folders that exist: the holder writes state, launch the worker file.
    names: () => { try { return readdirSync(dir).filter((n) => WORKER_NAME.test(n)).sort(); } catch { return []; } },
    // As readJsonFile reads it: { worker } for one routr's launch wrote, { absent: true }, { foreign: true } (another
    // shape: not routr's), or { unreadable } (there, and not read: what it is is not known, so nothing acts on it).
    // Never throws, and changes nothing.
    read: (name) => {
      const r = readJsonFile(join(runDir(name), "worker.json"));
      if (r.absent || r.unreadable) return r;
      const worker = checkRecord(r.value, name);
      return worker ? { worker } : { foreign: true };
    },
    readAt: readRecordAt,
    // Whole, owner-only, into a folder that exists: a reader never sees it half written. Only what newRecord or amend built.
    write: (folder, record) => writeJsonAtomic(join(folder, "worker.json"), built(record), { mkdir: false, mode: 0o600 }),
    // Starting a holder and removing a run folder go through one lock per worker, so cleanup can never delete a folder
    // a send is starting a new holder in. Taken over only when its taker has gone (the state files' lock). `fn` gets
    // `assertOwned`, which throws once the lock is no longer this call's: checks await channels and git, so a lock at
    // entry is not enough, and every action is fenced with its token.
    lock: async (name, fn) => {
      const file = join(dir, `${name}.lock`);
      let took = false;
      for (let i = 0; i < 50 && !(took = takeLock(file, lockIsStale)); i++) await sleep(100);
      const token = lockToken(file);
      const assertOwned = () => { if (!took || !lockOwned(file, token)) throw new Error(`the worker lock for ${name} is held by another routr command; run it again in a moment`); };
      try { assertOwned(); return await fn(assertOwned); } finally { if (took) releaseFileLock(file, token); }
    },
  };
}
// This home's, for the holder and launch, which find a worker by its name under HOME.
export const runDir = (name) => recordStore().runDir(name);
export const readWorker = (name) => recordStore().read(name).worker ?? null;
