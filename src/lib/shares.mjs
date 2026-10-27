// `share`: the user's ratio of launches between metered accounts. A metered account has no headroom number, so two
// normal metered accounts tie and habit picks; the user's weights say how they want the work split instead
// (3 and 1: about three workers on one for every one on the other). Advice only: the lead still chooses model and
// effort fit first, and nothing here enforces the ratio.
// routr counts its own launches: one file per worker that took its task (or was left ready with no task), under its
// own folder, holding only the subscription and the time. Counting is best effort: a write that fails never fails the
// launch, and history that cannot be read leaves the advice as it is without a share.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { home as userHome, STATE_DIR, UNINSTALL_LOCK, writeJsonAtomic } from "./runtime.mjs";

export const SHARE_WINDOW_DAYS = 7;
const WINDOW_MS = SHARE_WINDOW_DAYS * 86400000;
// A clock a little ahead on another process is not a launch from the future; anything further ahead is not ours.
const SKEW_MS = 60000;
export const LAUNCH_COUNTS_DIR = (h = userHome()) => join(STATE_DIR(h), "launch-counts");
const OWN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
const SUBSCRIPTION = /^[a-z][a-z0-9_-]{0,31}$/;

// One record; null when the file is not one of ours (a stray file, damaged JSON, a future time) or is gone (swept
// by a launch meanwhile); UNREADABLE when it is there and cannot be read, since skipping it would skew the counts.
const UNREADABLE = Symbol("unreadable");
function readRecord(dir, name, now) {
  if (!OWN.test(name)) return null;
  let text;
  try {
    const file = join(dir, name);
    if (!lstatSync(file).isFile()) return null;
    text = readFileSync(file, "utf8");
  } catch (e) { return e?.code === "ENOENT" ? null : UNREADABLE; }
  try {
    const v = JSON.parse(text), at = Date.parse(v?.at);
    if (!v || typeof v.subscription !== "string" || !SUBSCRIPTION.test(v.subscription) || !Number.isFinite(at) || at > now + SKEW_MS) return null;
    return { name, subscription: v.subscription, at };
  } catch { return null; }
}

// A folder of routr's own: there and a real folder ("yes"), not there yet ("absent"), or a link or something else
// ("no"). Neither the state folder nor the history folder is ever used through a link: writes and the sweep would act
// outside routr's folders.
const folder = (path) => { try { return lstatSync(path).isDirectory() ? "yes" : "no"; } catch (e) { return e?.code === "ENOENT" ? "absent" : "no"; } };

// Launches per subscription over the window. `unreadable` when the folder or one of its records is there but cannot
// be read (or the folder is a link, which countLaunch would not write through): the caller
// shows no share then, since a count it cannot see is not a count of zero. Reads never write or sweep.
export function recentLaunches({ home = userHome(), now = Date.now() } = {}) {
  const dir = LAUNCH_COUNTS_DIR(home), state = folder(STATE_DIR(home)), own = state === "yes" ? folder(dir) : state;
  if (own === "absent") return { counts: {} };
  let names;
  try { names = own === "yes" ? readdirSync(dir) : null; } catch { names = null; }
  if (!names) return { counts: {}, unreadable: true };
  const counts = {};
  for (const n of names) {
    const r = readRecord(dir, n, now);
    if (r === UNREADABLE) return { counts: {}, unreadable: true };
    if (r && r.at >= now - WINDOW_MS) counts[r.subscription] = (counts[r.subscription] ?? 0) + 1;
  }
  return { counts };
}

// Count one launch. Never throws, and writes nothing while routr is being uninstalled. Each launch gets its own id, so
// the same task launched again later counts again; records older than the window are removed here, never on a read.
export function countLaunch(subscription, { home = userHome(), now = Date.now() } = {}) {
  try {
    if (!SUBSCRIPTION.test(subscription ?? "") || existsSync(UNINSTALL_LOCK(home))) return false;
    const dir = LAUNCH_COUNTS_DIR(home);
    // Each folder is checked before anything is made in it, and again once made.
    for (const f of [STATE_DIR(home), dir]) {
      if (folder(f) === "absent") mkdirSync(f, { recursive: true, mode: 0o700 });
      if (folder(f) !== "yes" || existsSync(UNINSTALL_LOCK(home))) return false;
    }
    writeJsonAtomic(join(dir, `${randomUUID()}.json`), { subscription, at: new Date(now).toISOString() }, { mkdir: false, mode: 0o600 });
    for (const n of readdirSync(dir)) {
      const r = readRecord(dir, n, now);
      if (r && r !== UNREADABLE && r.at < now - WINDOW_MS) try { unlinkSync(join(dir, n)); } catch {}
    }
    return true;
  } catch { return false; }
}

// The share view, pure. `ranked` is rankSubscriptions' list; `launches` is recentLaunches' answer. Active only among
// normal metered accounts, when at least two are ranked and at least one has a `share`; one without counts as 1.
// Each sharer gets the same shape as a usage window: what share of these launches it took (used_pct) and how far it
// is below its target (left). The account furthest below its target is `due` (ties: the larger weight, then the
// name); none is due when every one is at or above its target. `{ unreadable: true }` when a share would apply but
// the history cannot be read.
export function shareView(ranked, launches, subscriptions) {
  const sharers = ranked.filter((r) => r.class === "metered" && r.use === "normal");
  if (sharers.length < 2 || !sharers.some((r) => subscriptions[r.subscription]?.share != null) || !launches) return null;
  // A share would apply, but the history cannot be read: a count routr cannot see is not zero, so it shows none.
  if (launches.unreadable) return { unreadable: true };
  const weight = (r) => subscriptions[r.subscription]?.share ?? 1;
  const total = sharers.reduce((n, r) => n + weight(r), 0);
  const of = sharers.reduce((n, r) => n + (launches.counts[r.subscription] ?? 0), 0);
  const r2 = (x) => Math.round(x * 100) / 100;
  // How far below its target (0 at or above it, as `left`), compared in whole numbers: weight/total − n/of over the common denominator total·of
  // (with no launches, every account's used is 0, so the weight alone). Floating point would break exact ties.
  const below = (r) => { const n = launches.counts[r.subscription] ?? 0; return Math.max(0, of ? weight(r) * of - n * total : weight(r)); };
  const view = Object.fromEntries(sharers.map((r) => {
    const target = weight(r) / total, n = launches.counts[r.subscription] ?? 0, used = of ? n / of : 0;
    return [r.subscription, { weight: weight(r), target: r2(target), used_pct: Math.round(used * 100), left: r2(Math.max(0, target - used)), launches: n, of }];
  }));
  const by = Object.fromEntries(sharers.map((r) => [r.subscription, below(r)]));
  const order = sharers.map((r) => r.subscription).sort((a, b) => by[b] - by[a] || view[b].weight - view[a].weight || a.localeCompare(b));
  return { due: by[order[0]] > 0 ? order[0] : null, order, view };
}
