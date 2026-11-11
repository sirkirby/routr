// Doubtful lineage is absent lineage. Local hashes distinguish repositories/paths without exporting native
// paths. Written only when OpenTelemetry export is on; its launch ids, uninstall check and sweep are a launch's
// identity's (launch-identity.mjs), shared with the launch history.
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home as userHome, STATE_DIR, writeJsonAtomic } from "./state-files.mjs";
import { isLaunchId, launchIdOfFile, storeWritable, sweepLaunches } from "./launch-identity.mjs";

// Kept 30 days, for a cleanup or a record long after its launch; a finished entry stays for `record` until then.
const INDEX_MS = 30 * 86400000;
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v, len) => typeof v === "string" && new RegExp(`^[a-f0-9]{${len}}$`).test(v) && !/^0+$/.test(v);
// A launch's span context, as an index entry and a worker record's `launch` field keep it; null when any part is doubtful.
export const launchContext = (v) => v && isLaunchId(v.launch_id) && id(v.traceId, 32) && id(v.spanId, 16) ? { launch_id: v.launch_id, traceId: v.traceId, spanId: v.spanId } : null;
export class LaunchIndex {
  constructor({ home = userHome(), now = Date.now } = {}) { this.home = home; this.now = now; this.dir = join(STATE_DIR(home), "launches"); }
  permitted() { return storeWritable(this.home); }
  // One entry by its file name: null unless the file is a real file named for the launch it holds, a whole entry, from
  // no later than now, and (unless `expired`) within the 30 days.
  read(n, { expired = false } = {}) {
    try {
      const file = join(this.dir, n); if (!launchIdOfFile(n) || !lstatSync(file).isFile()) return null;
      const v = JSON.parse(readFileSync(file, "utf8")), age = this.now() - Date.parse(v.created_at);
      if (launchIdOfFile(n) !== v.launch_id || !launchContext(v) || !["pane", "headless", "terminal"].includes(v.backend) || !Number.isFinite(age) || age < 0 || (!expired && age >= INDEX_MS)) return null;
      return v;
    } catch { return null; }
  }
  entries({ expired = false } = {}) {
    try {
      if (!lstatSync(this.dir).isDirectory()) return [];
      return readdirSync(this.dir).flatMap((n) => { const v = this.read(n, { expired }); return v ? [v] : []; });
    } catch { return []; }
  }
  add(entry) {
    try {
      if (!this.permitted() || !launchContext(entry)) return false;
      try { mkdirSync(this.dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST" || !lstatSync(this.dir).isDirectory()) return false; }
      if (!this.permitted()) return false;
      // Exclusive publication: a recovery rerun never replaces an entry or its original span context.
      writeFileSync(join(this.dir, `${entry.launch_id}.json`), JSON.stringify(entry) + "\n", { flag: "wx", mode: 0o600 });
      return true;
    } catch { return false; }
  }
  match(query, { activeOnly = false } = {}) {
    const allowed = ["launch_id", "advice_id", "project_hash", "branch", "path_hash", "pane_id", "terminal_id", "repository"];
    if (!query || !Object.keys(query).length || Object.keys(query).some((k) => !allowed.includes(k) || !(k === "repository" && query[k] === null) && (typeof query[k] !== "string" || !query[k]))) return null;
    if (query.pane_id && !query.terminal_id || query.branch && !hash(query.project_hash) || query.path_hash && !hash(query.path_hash)) return null;
    const matches = this.entries().filter((v) => (!activeOnly || !v.finished_at) && Object.entries(query).every(([k, value]) => v[k] === value));
    return matches.length === 1 ? matches[0] : null;
  }
  recovery(query) {
    if (!query?.advice_id || !query.pane_id || !query.terminal_id) return null;
    return this.match(query, { activeOnly: true });
  }
  finish(launchId) {
    try {
      const v = this.entries().find((e) => e.launch_id === launchId);
      if (!v || v.finished_at || !this.permitted()) return;
      writeJsonAtomic(join(this.dir, `${launchId}.json`), { ...v, finished_at: new Date(this.now()).toISOString() }, { mkdir: false, mode: 0o600, preserveOnError: true });
    } catch {} // Tombstone failure cannot turn a completed cleanup into a failure.
  }
  sweep() { sweepLaunches(this.dir, this.home, (n) => { const v = this.read(n, { expired: true }); return Boolean(v) && this.now() - Date.parse(v.created_at) >= INDEX_MS; }); }
}
