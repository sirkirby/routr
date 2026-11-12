// Installed is not enough: a harness that is not signed in cannot do routr's work, and asking it for its models or
// its usage opens a sign-in in the user's browser (seen 2026-09-26: `agy -p /usage` started Google's sign-in and waited
// for a code; `kiro-cli chat --list-models` opened Kiro's). So each harness first answers its own status check, which
// never starts a sign-in (measured logged in and logged out, 2026-09-26), and one that is not signed in is left out:
// no model list, no usage read, no launch. The check is the registry's `auth` (harnesses.mjs).
// The answer is kept in the cache, so a dispatch rarely pays for it: a sign-out is rare, so "signed in" is kept 6 hours;
// a sign-in the user has just done should count soon, so "not signed in" is kept 10 minutes. doctor and setup always
// check afresh.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, writeJsonAtomic } from "./state-files.mjs";
import { probe } from "./processes.mjs";

export const SIGNED_IN_FILE = () => join(CACHE_DIR(), "signed-in.json");
const KEEP_SEC = { true: 6 * 3600, false: 10 * 60 };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
// Is what is kept for `f`: an extra account's `{ dir, default_folder }` (harnesses' folderOf), or a harness's own (none).
export const sameFolder = (kept, f) => kept?.dir === f?.dir && kept?.default_folder === f?.default_folder;

// What the same answer said about billing (the registry's `auth.billing`), kept beside the state with the same
// lifetime and returned with it: one answer, so no reader of billing depends on which check ran first in a process.
// Where it decides a class (a reading without windows), the usage-readings module asks again first (fresh): a login
// switched within the 6 hours must not keep the old class. Only the class, the reader's fixed reason and its fixed
// condition are kept, never anything else the status printed (Claude's carries the email, organisation and ids). A
// reader that throws, or answers anything else, is no reading.
const billingOf = (b) => (b?.billing === "metered" && typeof b.why === "string" ? { billing: "metered", why: b.why.slice(0, 200), ...(b.when === "no_windows" ? { when: "no_windows" } : {}) } : null);

// `harness` is the registry entry. `{ state, billing }`: the state is "yes", "no", or "no answer" (not installed, or it
// hung): only "yes" gets work, and each other state says what to do about it. `billing` is what the same answer said
// about billing, or null (always null beside a state that is not "yes"). `folder`: an extra account's, kept beside its
// answer: one kept for another is none, so a name pointed elsewhere, or with its variable now removed or set, is asked
// again.
export async function signInState(name, harness, { fresh = false, nowSec = Date.now() / 1000, file = SIGNED_IN_FILE(), ask = probe, folder } = {}) {
  const kept = readJson(file)[name];
  if (!fresh && kept?.state && sameFolder(kept, folder) && nowSec - kept.ts < KEEP_SEC[kept.state === "yes"]) return { state: kept.state, billing: kept.state === "yes" ? billingOf(kept.billing) : null };
  const r = await ask(harness.executable, harness.auth.check);
  const state = !r ? "no answer" : harness.auth.signedIn(r.out, r.code) ? "yes" : "no";
  let billing = null;
  if (state === "yes") try { billing = billingOf(harness.auth.billing?.(r.out, r.code)); } catch {}
  try { writeJsonAtomic(file, { ...readJson(file), [name]: { ts: nowSec, state, ...folder, ...(billing ? { billing } : {}) } }); } catch {}
  return { state, billing };
}
export const signedIn = async (name, harness, o) => (await signInState(name, harness, o)).state === "yes";
// The kept answer alone, however old, or null: for a read that must not run a harness (the usage-readings module's
// kept readings). `{ state, billing }`, as signInState returns it.
export const keptSignIn = (name, { file = SIGNED_IN_FILE(), folder } = {}) => {
  const kept = readJson(file)[name], state = sameFolder(kept, folder) ? kept?.state : null;
  return ["yes", "no", "no answer"].includes(state) ? { state, billing: state === "yes" ? billingOf(kept.billing) : null } : null;
};
// What to tell the user about a harness that is not ready.
export const signInHint = (harness, state) => (state === "no answer"
  ? `\`${harness.executable}\` did not answer its sign-in check (not installed, or it hung)`
  : `not signed in: ${harness.auth.signIn}`);
