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
import { CACHE_DIR, probe, writeJsonAtomic } from "./runtime.mjs";

export const SIGNED_IN_FILE = () => join(CACHE_DIR(), "signed-in.json");
const KEEP_SEC = { true: 6 * 3600, false: 10 * 60 };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };

// What the same answer said about billing (the registry's `auth.billing`), kept beside the state with the same
// lifetime. Where it decides a class (a reading without windows), readUsage asks again first (`billingFor`, fresh):
// a login switched within the 6 hours must not keep the old class. Only the class and the
// reader's fixed reason are kept, never anything else the status printed (Claude's carries the email, organisation and
// ids). A reader that throws, or answers anything else, is no reading.
const billingOf = (b) => (b?.billing === "metered" && typeof b.why === "string" ? { billing: "metered", why: b.why.slice(0, 200) } : null);
// The billing reading of each harness this process last asked (or found kept), for readUsage beside the sign-in gate:
// in memory too, so a cache that cannot be written still carries it through this call.
const billingSeen = new Map();
export const billingFromSignIn = (name) => billingSeen.get(name) ?? null;

// `harness` is the registry entry. The state is "yes", "no", or "no answer" (not installed, or it hung): only "yes" gets
// work, and each other state says what to do about it.
export async function signInState(name, harness, { fresh = false, nowSec = Date.now() / 1000, file = SIGNED_IN_FILE(), ask = probe } = {}) {
  const kept = readJson(file)[name];
  if (!fresh && kept?.state && nowSec - kept.ts < KEEP_SEC[kept.state === "yes"]) {
    billingSeen.set(name, kept.state === "yes" ? billingOf(kept.billing) : null);
    return kept.state;
  }
  const r = await ask(harness.executable, harness.auth.check);
  const state = !r ? "no answer" : harness.auth.signedIn(r.out, r.code) ? "yes" : "no";
  let billing = null;
  if (state === "yes") try { billing = billingOf(harness.auth.billing?.(r.out, r.code)); } catch {}
  billingSeen.set(name, billing);
  try { writeJsonAtomic(file, { ...readJson(file), [name]: { ts: nowSec, state, ...(billing ? { billing } : {}) } }); } catch {}
  return state;
}
export const signedIn = async (name, harness, o) => (await signInState(name, harness, o)) === "yes";
// What to tell the user about a harness that is not ready.
export const signInHint = (harness, state) => (state === "no answer"
  ? `\`${harness.executable}\` did not answer its sign-in check (not installed, or it hung)`
  : `not signed in: ${harness.auth.signIn}`);
