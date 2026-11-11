// routr's launch history: one record per launch that took its task (or was left ready for one), on every backend, under
// routr's own folder. It is the launch-share count's input (shares.mjs), the project a later `record` gives a row, and
// what `board` shows of a decision while its work runs. Each record holds checked fields only, never text: the account,
// model and effort chosen, the advice's id and reading (as the ledger keeps it), the repository's folder name, where the
// worker runs and its name. Field names are the ledger's: `id` is the advice's, as in advice and ledger rows.
// No brief, no task, no path, no note. Kept 7 days (the share window). Best effort: a write that fails never fails the
// launch, and history that cannot be read is said, never read as empty.
import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { home as userHome, STATE_DIR, writeJsonAtomic } from "./state-files.mjs";
import { isLaunchId, launchIdOfFile, sweepLaunches, uninstalling } from "./launch-identity.mjs";
import { WORKER_NAME } from "./worker-record.mjs";
import { LEVELS } from "./questions.mjs";

export const HISTORY_DAYS = 7;
const WINDOW_MS = HISTORY_DAYS * 86400000;
// A clock a little ahead on another process is not a launch from the future; anything further ahead is not ours.
const SKEW_MS = 60000;
// The folder keeps its first name (it held only counts): records written before the decision fields still count.
export const LAUNCH_HISTORY_DIR = (h = userHome()) => join(STATE_DIR(h), "launch-counts");
export const SUBSCRIPTION = /^[a-z][a-z0-9_-]{0,31}$/;
const ADVICE_ID = /^[a-f0-9]{8}$/;
const BACKENDS = ["pane", "terminal", "headless"];
// A model id or effort word as a harness takes it: letters, digits and the punctuation real ids use, nothing else.
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:@\/+-]{0,127}$/;
// A repository's folder name, as `projectName` gives it: one path segment, printable.
const PROJECT = /^[^\\/\x00-\x1f\x7f]{1,128}$/;

const text = (v, re) => (typeof v === "string" && re.test(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const level = (v) => (LEVELS.includes(v) ? v : null);
// The advice's reading as the ledger keeps it (`advised`): its level, how sure, its work type and risk, and each fact's
// probability; never anything the lead wrote. `between` is two levels or null; a fact is a short name and a number
// from 0 to 1, at most 32 of them.
const FACT = /^[a-z][a-z_]{0,31}$/;
function factsOf(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return {};
  return Object.fromEntries(Object.entries(f).filter(([k, p]) => FACT.test(k) && typeof p === "number" && p >= 0 && p <= 1).slice(0, 32));
}
function advisedOf(a) {
  if (!a || typeof a !== "object") return null;
  const between = Array.isArray(a.between) && a.between.length === 2 && a.between.every(level) ? [...a.between] : null;
  return { level: level(a.level), sure: bool(a.sure), between, work_type: text(a.work_type, /^[a-z][a-z_]{0,31}$/), high_risk: bool(a.high_risk), fallback: bool(a.fallback), facts: factsOf(a.facts) };
}

// What a record holds, checked field by field: a field that is not what it should be is null, never passed on.
// `model` and `effort` are null when not known (an adopted pane's agent kept its own).
export function launchRecord(fields) {
  const f = fields ?? {};
  return {
    subscription: text(f.subscription, SUBSCRIPTION), model: text(f.model, WORD), effort: text(f.effort, WORD),
    id: text(f.id, ADVICE_ID), advised: advisedOf(f.advised), project: text(f.project, PROJECT),
    backend: BACKENDS.includes(f.backend) ? f.backend : null, name: text(f.name, WORKER_NAME),
  };
}

// One record; null when the file is not one of ours (a stray file, damaged JSON, a future time) or is gone (swept by a
// launch meanwhile); UNREADABLE when it is there and cannot be read, since skipping it would skew the counts.
const UNREADABLE = Symbol("unreadable");
function readRecord(dir, name, now) {
  const launchId = launchIdOfFile(name);
  if (!launchId) return null;
  let raw;
  try {
    const file = join(dir, name);
    if (!lstatSync(file).isFile()) return null;
    raw = readFileSync(file, "utf8");
  } catch (e) { return e?.code === "ENOENT" ? null : UNREADABLE; }
  try {
    const v = JSON.parse(raw), at = Date.parse(v?.at);
    if (!v || typeof v.subscription !== "string" || !SUBSCRIPTION.test(v.subscription) || !Number.isFinite(at) || at > now + SKEW_MS) return null;
    // A record from before the decision fields holds only the account and the time: it still counts.
    return { launch_id: launchId, at, ...launchRecord(v), subscription: v.subscription };
  } catch { return null; }
}

// A folder of routr's own: there and a real folder ("yes"), not there yet ("absent"), or a link or something else
// ("no"). Neither the state folder nor the history folder is ever used through a link: writes and the sweep would act
// outside routr's folders.
const folder = (path) => { try { return lstatSync(path).isDirectory() ? "yes" : "no"; } catch (e) { return e?.code === "ENOENT" ? "absent" : "no"; } };

// Every record within the window, oldest first. `unreadable` when the folder or one of its records is there but cannot
// be read (or the folder is a link): a reader then says so, since history it cannot see is not history that is empty.
// Reads never write or sweep.
export function readHistory({ home = userHome(), now = Date.now() } = {}) {
  const dir = LAUNCH_HISTORY_DIR(home), state = folder(STATE_DIR(home)), own = state === "yes" ? folder(dir) : state;
  if (own === "absent") return { records: [] };
  let names;
  try { names = own === "yes" ? readdirSync(dir) : null; } catch { names = null; }
  if (!names) return { records: [], unreadable: true };
  const records = [];
  for (const n of names) {
    const r = readRecord(dir, n, now);
    if (r === UNREADABLE) return { records: [], unreadable: true };
    if (r && r.at >= now - WINDOW_MS) records.push(r);
  }
  return { records: records.sort((a, b) => a.at - b.at || a.launch_id.localeCompare(b.launch_id)) };
}

// One launch, under its id (the launch's own, which its answer and its record template carry). Never throws, and
// writes nothing while routr is being uninstalled. Answers whether it was written. Records older than the window are
// removed here, never on a read.
export function recordLaunch(launchId, fields, { home = userHome(), now = Date.now() } = {}) {
  try {
    const record = launchRecord(fields);
    if (!isLaunchId(launchId) || !record.subscription || uninstalling(home)) return false;
    const dir = LAUNCH_HISTORY_DIR(home);
    // Each folder is checked before anything is made in it, and again once made.
    for (const f of [STATE_DIR(home), dir]) {
      if (folder(f) === "absent") mkdirSync(f, { recursive: true, mode: 0o700 });
      if (folder(f) !== "yes" || uninstalling(home)) return false;
    }
    writeJsonAtomic(join(dir, `${launchId}.json`), { at: new Date(now).toISOString(), ...record }, { mkdir: false, mode: 0o600 });
    sweepLaunches(dir, home, (n) => { const r = readRecord(dir, n, now); return Boolean(r) && r !== UNREADABLE && r.at < now - WINDOW_MS; });
    return true;
  } catch { return false; }
}

// The record of one launch within the window, or null; `unreadable` as readHistory's.
export function findLaunch(launchId, opts) {
  const h = readHistory(opts);
  if (h.unreadable) return { unreadable: true };
  return { record: h.records.find((r) => r.launch_id === launchId) ?? null };
}
