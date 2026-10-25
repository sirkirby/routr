// Doubtful lineage is absent lineage. Local hashes distinguish repositories/paths without exporting native
// paths.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home as userHome, UNINSTALL_LOCK, writeJsonAtomic } from "./runtime.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OWN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v, len) => typeof v === "string" && new RegExp(`^[a-f0-9]{${len}}$`).test(v) && !/^0+$/.test(v);
export const launchContext = (v) => v && UUID.test(v.launch_id) && id(v.traceId, 32) && id(v.spanId, 16) ? { launch_id: v.launch_id, traceId: v.traceId, spanId: v.spanId } : null;
export class LaunchIndex {
  constructor({ home = userHome(), now = Date.now } = {}) { this.home = home; this.now = now; this.dir = join(home, ".local/state/routr/launches"); }
  permitted() { try { return !existsSync(UNINSTALL_LOCK(this.home)) && lstatSync(join(this.home, ".local/state/routr")).isDirectory(); } catch { return false; } }
  entries({ expired = false } = {}) {
    try {
      if (!lstatSync(this.dir).isDirectory()) return [];
      return readdirSync(this.dir).filter((n) => OWN.test(n)).flatMap((n) => {
        try {
          const file = join(this.dir, n); if (!lstatSync(file).isFile()) return [];
          const v = JSON.parse(readFileSync(file, "utf8")), age = this.now() - Date.parse(v.created_at);
          if (n !== `${v.launch_id}.json` || !launchContext(v) || !["pane", "headless"].includes(v.backend) || !Number.isFinite(age) || age < 0 || (!expired && age >= 30 * 86400000)) return [];
          return [v];
        } catch { return []; }
      });
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
    const allowed = ["advice_id", "project_hash", "branch", "path_hash", "pane_id", "terminal_id", "repository"];
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
  sweep() {
    if (!this.permitted()) return;
    for (const v of this.entries({ expired: true })) if (this.now() - Date.parse(v.created_at) >= 30 * 86400000) {
      try { if (this.permitted() && lstatSync(join(this.dir, `${v.launch_id}.json`)).isFile()) unlinkSync(join(this.dir, `${v.launch_id}.json`)); } catch {}
    }
  }
}
