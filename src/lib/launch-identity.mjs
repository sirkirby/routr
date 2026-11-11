// A launch's identity: the one id each launch is made with, what a valid one is, the two rules that decide what a launch
// is from how it ended, and what the two stores that keep launches under their ids share. The stores are the launch
// history (launch-history.mjs, 7 days, always) and the OpenTelemetry launch index (launch-index.mjs, 30 days, written
// only when export is on); they stay separate stores, since telemetry and OpenTelemetry keep separate settings, state
// and delivery. A headless or terminal worker's record keeps its launch too (its `launch` field, as `currentLaunch` gives
// it), read back through the launch index's `launchContext`.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, UNINSTALL_LOCK } from "./state-files.mjs";

// A launch id is a random (version 4) UUID, lowercase as node makes it: its answer's `launch_id`, its record template's
// `--launch`, its trace's `routr.launch.id`, and the file name it is kept under in each store.
const UUID_V4 = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const LAUNCH_ID = new RegExp(`^${UUID_V4}$`), LAUNCH_FILE = new RegExp(`^(${UUID_V4})\\.json$`);
export const newLaunchId = () => randomUUID();
export const isLaunchId = (v) => typeof v === "string" && LAUNCH_ID.test(v);
// The launch a store's file is kept for, from its name alone; null for any other name (a stray or foreign file).
export const launchIdOfFile = (name) => (typeof name === "string" ? LAUNCH_FILE.exec(name)?.[1] ?? null : null);

// ---- what a launch is -----------------------------------------------------------------------------------------------
// Two rules, and they differ on purpose. A pane launch stopped at needs_input is findable but does not count: its answer
// has `launch_id: null` and no history record, while the rerun that finishes it finds it and is what counts.
// `state`: how launch ended (planned, ready, prompted, needs_input, failed). `backend`: pane, terminal or headless.
// `started`: a worker is there to find (a herdr pane id, or a headless or terminal worker's record). `finishes`: a
// `--pane` recovery rerun that found, in the launch index, the launch it finishes.
const delivered = (state) => state === "prompted" || state === "ready";

// Counts toward the user's launch share (shares.mjs), and so gets `launch_id` in its answer and a launch-history record:
// a worker that took its task, or was left ready for one. A dry run, a refusal and a failed start count nothing. A
// terminal worker stopped at a question has its task and goes on once answered: no rerun will count it later. A pane
// worker stopped at a question is counted by the `--pane` rerun that finishes it, so it counts once.
export const countsTowardShare = ({ state, backend }) => delivered(state) || (state === "needs_input" && backend === "terminal");

// A `--pane` rerun that delivered its task takes the pane over from the launch it finishes: that launch's index entry
// ends. One turned away (the worker busy) leaves the original as it was.
export const takesOver = ({ state, finishes }) => Boolean(finishes) && delivered(state);

// Findable by a later `--pane` recovery rerun, and by cleanup and record: the launch gets a launch-index entry. Only a
// started worker is indexed, never a dry run, a refusal or a failed start (project memory gotcha-0aed964f: indexing those
// gave cleanup and record two matches, and a doubtful match links nothing). Any started worker stopped at needs_input is
// indexed, so the rerun finds the launch it finishes. A rerun is indexed only when it takes over; one turned away has
// delivered nothing, and the original's entry stays the one to find.
export const findableByRerun = ({ state, started, finishes }) => Boolean(started) && (delivered(state) || state === "needs_input") && (!finishes || takesOver({ state, finishes }));

// ---- what the two stores share --------------------------------------------------------------------------------------
// routr is being uninstalled: from the moment its lock is there, no store writes in its state folder.
export const uninstalling = (home) => existsSync(UNINSTALL_LOCK(home));
// A store may write: routr is not being uninstalled and its state folder is a real folder, never a link (writes and the
// sweep would act outside routr's folders).
export function storeWritable(home) { try { return !uninstalling(home) && lstatSync(STATE_DIR(home)).isDirectory(); } catch { return false; } }

// Removes a store's expired launches from its folder `dir` (a real folder, never a link): each file named for a launch
// id, a real file, that the store's own reading says is past its window (`expired(name)`). A file of any other name,
// and one its store cannot read, is never removed. The uninstall lock is looked at again before each removal, so a
// sweep that an uninstall overtakes stops removing. Never throws.
export function sweepLaunches(dir, home, expired) {
  if (!storeWritable(home)) return;
  let names;
  try { if (!lstatSync(dir).isDirectory()) return; names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!launchIdOfFile(n)) continue;
    try { if (expired(n) && storeWritable(home) && lstatSync(join(dir, n)).isFile()) unlinkSync(join(dir, n)); } catch {}
  }
}
