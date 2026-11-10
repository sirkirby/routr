// A worker's record: who it is (its name, its run folder, its worker.json), how a name is reserved, and the checked
// loading of that record. Nothing here knows how the worker runs; a backend's own state stays with that backend.
import { linkWorker } from "./traces.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { privateDir } from "./channel.mjs";
import { lockIsStale, readJsonFile, STATE_DIR, UNINSTALL_LOCK, WORKER_NAME } from "./state-files.mjs";

export const FORMAT = 1;
export const WORKERS_DIR = () => join(STATE_DIR(), "workers");
export const runDir = (name) => join(WORKERS_DIR(), name);
// Set at hc run with the record's id, and read back before routr ends a terminal: an address lasts on one core only, and
// another core can have the same address under the same name. An id made for this worker cannot be another's.
export const WORKER_LABEL = "routr.worker";
// Every name a worker can be given, the folders that exist: the holder writes state, launch the worker file.
export const workerNames = () => { try { return readdirSync(WORKERS_DIR()).filter((n) => WORKER_NAME.test(n)).sort(); } catch { return []; } };
// What launch wrote: { format, id, name, kind, model, effort, cwd, created_at, carriers }. Never the brief, and of the
// environment only the trace-context carriers within routr's limits, which every load checks again (savedCarriers).
// `backend` is where it runs: a record that names none is headless, as every record written before terminal workers is.
// A terminal worker's also has `terminal` (its address), `terminal_name` and `config` (where-is-my-config paths, checked
// again by savedConfigLocations); its prompt is a file beside the record, never in it.
// As readJsonFile reads it: { worker } for one routr's launch wrote, { absent: true }, { foreign: true } (another
// shape: not routr's), or { unreadable } (there, and not read: what it is is not known, so nothing acts on it).
export const workerOf = (name) => {
  const r = readJsonFile(join(runDir(name), "worker.json"));
  if (r.absent || r.unreadable) return r;
  const w = r.value;
  if (w?.format !== FORMAT || w.name !== name) return { foreign: true };
  linkWorker(w); return { worker: { ...w, backend: w.backend ?? "headless" } };
};
export const readWorker = (name) => workerOf(name).worker ?? null;
// The same, from a run folder named by its path, for a process whose HOME may not be the one launch ran under.
export const readWorkerAt = (dir) => { const w = readJsonFile(join(dir, "worker.json")).value; return w?.format === FORMAT && w.name === basename(dir) ? { ...w, backend: w.backend ?? "headless" } : null; };
// A worker file that is there and cannot be read, said to a person: the file, the code, and that it may pass.
export const unreadableWhy = (name, file, code) => `${name}'s ${file} could not be read just now (${code}), so what it is doing is not known: try again in a moment`;

// The run folder of a new worker, reserved by its name: made whole, owner-only, or refused when one exists.
// Made first, then the uninstall lock looked at: uninstall takes its lock first, then looks for run folders, so
// one of the two always sees the other. Each reservation writes its own random token into its folder,
// exclusively, before anything else, and only the launch whose token is there removes that folder (its rollback
// in backend-headless.mjs). An uninstall releases its lock only once everything else in its state folder is gone, so
// when this call finds no lock, any earlier uninstall has finished removing: the token still being there then
// means the folder is this call's for good (a later uninstall takes its lock first and sees it). Found held, it
// backs out by removing nothing: the uninstall running removes the folder, or, if it came after that
// uninstall's sweep, keeps its own state folder and says so. (an identity by device, inode and birth time, and
// a token checked and then acted on by path, each left a moment where another launch's folder could be taken
// for this one's.)
export const OWNER = ".reserved-by";
export const ownedBy = (dir, token) => { try { return readFileSync(join(dir, OWNER), "utf8") === token; } catch { return false; } };
export function reserve(name, { beforeOwn = () => {}, afterOwn = () => {}, beforeBackout = () => {} } = {}) {
  privateDir(WORKERS_DIR());
  const dir = runDir(name), token = randomUUID().replace(/-/g, "");
  mkdirSync(dir, { mode: 0o700 }); // not recursive: EEXIST when that name is taken
  beforeOwn(); // a test acts here: as if this call paused while uninstall and another launch ran
  try { writeFileSync(join(dir, OWNER), token, { flag: "wx", mode: 0o600 }); } // EEXIST: another reservation's folder
  catch (e) { if (e?.code === "ENOENT") throw new Error(`${name}'s run folder was removed while launch was making it; run launch again`); throw e; }
  afterOwn(); // and here
  let held = false;
  try { held = existsSync(UNINSTALL_LOCK()) && !lockIsStale(UNINSTALL_LOCK()); } catch { held = existsSync(UNINSTALL_LOCK()); }
  if (held) {
    beforeBackout(); // and here
    throw new Error("routr is being uninstalled on this machine: no worker can start now");
  }
  if (!ownedBy(dir, token)) throw Object.assign(new Error(`a worker named ${name} exists`), { code: "EEXIST" });
  return { dir, token };
}
