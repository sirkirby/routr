// `routr update`: replace this binary with the latest release, verified against the release's checksums, then
// reinstall the skill so the guides match the command. Explicit, never silent: question sets are versioned so ledger
// rows stay comparable, and a tool that swaps its own binary unasked is a supply-chain risk.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";

import { join } from "node:path";
import { CACHE_DIR, standalone } from "./runtime.mjs";
import { ROUTR_VERSION } from "./version.mjs";

const REPO = "sirkirby/routr";
// A compiled release binary has no script path of its own; a source checkout runs under Bun.

export function assetName(platform = process.platform, arch = process.arch) {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[platform];
  if (!os) return null;
  if (os === "windows") return "routr-windows-x64.exe"; // Windows on ARM runs the x64 build under emulation
  return `routr-${os}-${arch === "arm64" ? "arm64" : "x64"}`;
}

// 1 when a is newer than b. Pre-releases (-rc.1) sort below their release; only stable releases are offered.
export function newer(a, b) {
  const parse = (v) => { const [core, pre] = String(v).replace(/^v/, "").split("-"); return { n: core.split(".").map(Number), pre: pre ?? null }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  return x.pre === null && y.pre !== null;
}

export async function latestVersion(timeoutMs = 4000) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "routr" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return String((await r.json()).tag_name ?? "").replace(/^v/, "");
}

// `self`, `fetchFn`, `spawn`, and `isStandalone` are seams: a test drives a real swap on a scratch file, with no network.
export async function update({ checkOnly = false, force = false, base = process.env.ROUTR_DOWNLOAD_BASE,
  self = process.execPath, fetchFn = fetch, spawn = spawnSync, isStandalone = standalone } = {}) {
  const out = { ok: false, current: ROUTR_VERSION, latest: null, updated: false };
  try {
    out.latest = base ? "(from ROUTR_DOWNLOAD_BASE)" : await latestVersion();
    const available = base ? true : newer(out.latest, ROUTR_VERSION);
    if (!available && !force) return { ...out, ok: true, note: "routr is up to date" };
    if (checkOnly) return { ...out, ok: true, available: true, note: `${out.latest} is available: run \`routr update\`` };
    if (!isStandalone()) return { ...out, ok: true, available: true, note: "this routr runs from a source checkout: update it with `git pull`" };
    const asset = assetName();
    if (!asset) throw new Error(`no release build for ${process.platform}/${process.arch}`);
    const from = base ?? `https://github.com/${REPO}/releases/latest/download`;
    const get = async (name) => { const r = await fetchFn(`${from}/${name}`, { redirect: "follow", signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`download of ${name} failed (${r.status})`); return Buffer.from(await r.arrayBuffer()); };
    const [bin, sums] = [await get(asset), (await get("SHA256SUMS")).toString("utf8")];
    const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === asset)?.[0];
    const got = createHash("sha256").update(bin).digest("hex");
    if (!want || want !== got) throw new Error(`checksum mismatch for ${asset}; nothing was changed`);

    swapBinary(self, bin);
    // From here on the new binary is in place: whatever happens next, the result must say so (0.1.14 to 0.1.16 threw
    // on an undeclared name here and reported "Nothing was changed" after every successful update).
    out.updated = true;
    const v = spawn(self, ["--version"], { encoding: "utf8" });
    out.now = (v.stdout ?? "").trim() || null;
    const skill = spawn(self, ["skill", "install"], { encoding: "utf8" });
    return { ...out, ok: true, updated: true, skill_reinstalled: skill.status === 0, note: `updated ${ROUTR_VERSION} → ${out.now ?? out.latest}` };
  } catch (e) {
    // Say what is true: after a failed swap the old binary was put back, unless that failed too; after a successful
    // swap the update happened even if a later step failed.
    const error = String(e?.message ?? e).slice(0, 200);
    if (out.updated) return { ...out, ok: false, error, note: `updated to ${out.latest}, but a step after the swap failed (${error}). Run \`routr skill install\` yourself` };
    const intact = existsSync(self);
    return { ...out, ok: false, error, note: intact ? "Nothing was changed. You can also re-run the install command from the README." : `routr is no longer at ${self}: the previous binary is beside it as routr.old. Re-run the install command from the README.` };
  }
}

// ---- Automatic updates, the way long-lived CLIs do it: checked in the background, applied between runs. ----
// A normal command only looks at one file's age. When the last check is more than a day old it starts a DETACHED
// updater and carries on; it never waits for it and makes no network call itself. The updater swaps the binary in
// place, so a run already in progress keeps the binary it started with and the next run gets the new one.
// A lock is only taken over when its owner is gone: age alone would let a slow download be overlapped by a second swap.
// A lock with no readable pid (written by an older routr) falls back to age.
export function lockIsStale(file, { alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } } } = {}) {
  const pid = Number(readFileSync(file, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) return !alive(pid);
  return Date.now() - statSync(file).mtimeMs >= 10 * 60 * 1000;
}

// Put `bin` where `self` is. A running binary can be renamed on every system, but on Windows it cannot be overwritten,
// so it is moved aside first. If the new file cannot be moved in, the old one goes back: never leave no binary.
export function swapBinary(self, bin, { rename = renameSync } = {}) {
  const fresh = `${self}.new`, old = `${self}.old`;
  writeFileSync(fresh, bin); chmodSync(fresh, 0o755);
  rmSync(old, { force: true });
  rename(self, old);
  try { rename(fresh, self); }
  catch (e) { try { renameSync(old, self); } catch {} try { rmSync(fresh, { force: true }); } catch {} throw e; }
  try { rmSync(old, { force: true }); } catch {} // Windows keeps it locked until this process exits; the next update removes it
}

const CACHE = CACHE_DIR;
const STAMP = () => join(CACHE(), "update-check");     // its mtime is the time of the last check
const LOCK = () => join(CACHE(), "update.lock");
export const UPDATE_LOG = () => join(CACHE(), "update.log");
const DAY = 24 * 60 * 60 * 1000;

export const dueForCheck = (lastCheckMs, nowMs = Date.now()) => !Number.isFinite(lastCheckMs) || nowMs - lastCheckMs > DAY;

export function maybeAutoUpdate(config) {
  try {
    if (!standalone()) return false;
    try { rmSync(`${process.execPath}.old`, { force: true }); } catch {} // Windows: the binary a previous update moved aside
    if (config?.auto_update === false || process.env.ROUTR_NO_UPDATE) return false;
    let last = NaN; try { last = statSync(STAMP()).mtimeMs; } catch {}
    if (!dueForCheck(last)) return false;
    spawn(process.execPath, ["update", "--background"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch { return false; } // updating must never get in the way of the command that was asked for
}

export async function backgroundUpdate() {
  mkdirSync(CACHE(), { recursive: true });
  let fd;
  try { fd = openSync(LOCK(), "wx"); } // one updater at a time
  catch { try { if (!lockIsStale(LOCK())) return; rmSync(LOCK(), { force: true }); fd = openSync(LOCK(), "wx"); } catch { return; } }
  try { writeSync(fd, String(process.pid)); } catch {}
  try {
    writeFileSync(STAMP(), new Date().toISOString() + "\n"); // first, so a failing check is not retried on every command
    const r = await update({});
    writeFileSync(UPDATE_LOG(), JSON.stringify({ at: new Date().toISOString(), ok: r.ok, updated: r.updated, note: r.note, error: r.error ?? null }) + "\n");
  } finally { try { closeSync(fd); } catch {} rmSync(LOCK(), { force: true }); }
}

export function autoUpdateStatus(config) {
  const on = standalone() && config?.auto_update !== false && !process.env.ROUTR_NO_UPDATE;
  let checked = null, last = null;
  try { checked = Math.round((Date.now() - statSync(STAMP()).mtimeMs) / 3600000); } catch {}
  try { last = JSON.parse(readFileSync(UPDATE_LOG(), "utf8")); } catch {}
  return { on, why_off: on ? null : !standalone() ? "running from source" : "turned off (auto_update: false, or ROUTR_NO_UPDATE)", checked_hours_ago: checked, last };
}
