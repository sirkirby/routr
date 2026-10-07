// `routr update`: replace this binary with the newest release on the user's update channel (`update_channel`: stable,
// or beta), verified against the release's checksums, then reinstall the skill so the guides match the command. It runs
// when asked, and by itself at most once a day in a detached background job (`maybeAutoUpdate`), which
// `"auto_update": false` turns off. Every swap is checksum-verified, and a run in progress keeps its binary.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "./config.mjs";
import { CACHE_DIR, lockIsStale, spawnSelf, standalone, startSync, takeLock, TELEMETRY_LOG, UPDATE_LOCK, UPDATE_STAMP } from "./runtime.mjs";
import { forgetConsentUnlessOn, hoursAgo, sendRows, telemetryStatus } from "./telemetry.mjs";
import { ROUTR_VERSION } from "./version.mjs";

const REPO = "sirkirby/routr";
// A compiled release binary has no script path of its own; a source checkout runs under Bun.

export function assetName(platform = process.platform, arch = process.arch) {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[platform];
  if (!os) return null;
  if (os === "windows") return "routr-windows-x64.exe"; // Windows on ARM runs the x64 build under emulation
  return `routr-${os}-${arch === "arm64" ? "arm64" : "x64"}`;
}

// Semver 2.0 precedence, -1/0/1: the numeric core first; a release ranks above its own pre-releases; then the
// pre-release identifiers one by one, numbers numerically and below words, words by ASCII order (alpha < beta < rc),
// and a shorter set below a longer one that starts the same. Build metadata (+...) does not count. The first version
// compared any two pre-releases as equal, so 0.5.0-beta.2 never replaced 0.5.0-beta.1.
export function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v).trim().replace(/^v/, "").split("+")[0], i = s.indexOf("-"); // the first hyphen only: "rc-2" is one identifier
    return { n: (i < 0 ? s : s.slice(0, i)).split(".").map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0)), pre: i < 0 ? [] : s.slice(i + 1).split(".") };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0) ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  const num = (t) => /^\d+$/.test(t);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (num(p) && num(q)) return Number(p) > Number(q) ? 1 : -1;
    if (num(p) !== num(q)) return num(p) ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}
// True when a is newer than b.
export const newer = (a, b) => compareVersions(a, b) > 0;

// Which releases each update channel follows, by tag. Stable: releases only. Beta: also -beta.N and -rc.N, so a
// beta user moves to a stable release as soon as it is the newest. Alpha is on no channel: a maintainer installs one
// by naming it in ROUTR_VERSION for the install script.
// Strict semver numbers (no leading zeros), so a mistyped tag such as v1.01.0 is on no channel.
const N = String.raw`(?:0|[1-9]\d*)`;
export const CHANNEL_TAGS = { stable: new RegExp(`^v?${N}\\.${N}\\.${N}$`), beta: new RegExp(`^v?${N}\\.${N}\\.${N}(?:-(?:beta|rc)\\.${N})?$`) };
// The newest release on a channel from GitHub's release list, or null. Drafts never count, and the stable channel
// also skips anything GitHub marks as a pre-release whatever its tag says.
export function pickRelease(releases, channel = "stable") {
  const tags = CHANNEL_TAGS[channel] ?? CHANNEL_TAGS.stable;
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    const tag = String(r?.tag_name ?? "");
    if (r?.draft || !tags.test(tag) || (channel !== "beta" && r?.prerelease)) continue;
    const v = tag.replace(/^v/, "");
    if (!best || newer(v, best)) best = v;
  }
  return best;
}

// The newest version on the channel. Stable asks for GitHub's latest release, as it always has, and takes it only when
// its tag is a stable version (a release marked latest by mistake is not offered). Beta reads the newest 100 releases,
// GitHub's largest page, and picks from what is on it: a beta, rc or release older than the newest 100 releases is not
// seen. That is many release cycles here.
export async function latestVersion(timeoutMs = 4000, channel = "stable", fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`https://api.github.com/repos/${REPO}/${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "routr" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.json();
  };
  if (channel !== "beta") {
    const tag = String((await get("releases/latest")).tag_name ?? "");
    if (!CHANNEL_TAGS.stable.test(tag)) throw new Error(`GitHub's latest release ${tag || "(none)"} is not a stable version`);
    return tag.replace(/^v/, "");
  }
  const v = pickRelease(await get("releases?per_page=100"), "beta");
  if (!v) throw new Error("GitHub listed no release on the beta channel");
  return v;
}

// Every channel downloads by the exact tag it checked, never `latest/download`: the binary and SHA256SUMS fetched are
// those of the version compared, even when a release is published between the check and the download.
export const downloadBase = (version) => `https://github.com/${REPO}/releases/download/v${String(version).replace(/^v/, "")}`;
const isPre = (v) => String(v).includes("-");

// How long a release download may take. Both are judgments, from a measurement on 2026-10-07: release binaries are 59 to
// 82 MB (darwin-arm64 59, darwin-x64 66, linux 77, windows-x64 82), and the old limit of 120 s for the whole download
// failed `routr update` 3 times of 3 on a ~0.34 MB/s link where curl fetched the same asset in 181 s; the daily update
// failed there every day, said only in update.log. A slow link is no failure: a download stops only when no bytes
// arrive for DOWNLOAD_STALL_MS (a link that is gone, not one that is slow), or at DOWNLOAD_MAX_MS, a backstop so a
// trickle cannot hold the update lock forever (82 MB in 30 min is ~0.05 MB/s, far below the slowest link seen).
export const DOWNLOAD_STALL_MS = 30_000;
export const DOWNLOAD_MAX_MS = 30 * 60_000;
const span = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

// Fetch `url` and hand each chunk of its body to `onChunk` as it arrives: nothing holds the whole binary in memory (the
// old download buffered it with arrayBuffer()). The stall timer restarts with every chunk and also covers the wait for
// the server's answer; the backstop runs from the start. Either one aborts the request through its signal (fetch then
// rejects, or a body read fails) and cancels the body (a pending read then ends), and the error says which it was.
// No read is raced against a long-lived promise: from review, in Bun 1.3.13 every read raced against one shared abort
// promise stayed attached to it, so an 80 x 1 MiB transfer kept all 80 chunks (RSS +72 MB between chunk 10 and 80).
// `fetchFn` is the seam a test drives with a fake stream; like fetch, it must honour the signal.
export async function streamDownload(url, name, onChunk, { fetchFn = fetch, stallMs = DOWNLOAD_STALL_MS, maxMs = DOWNLOAD_MAX_MS } = {}) {
  const ac = new AbortController();
  let failure = null, stall = null, reader = null;
  const stop = (msg) => {
    if (failure) return;
    failure = new Error(msg); ac.abort(failure);
    try { reader?.cancel(failure).catch(() => {}); } catch {}
  };
  const arm = () => { clearTimeout(stall); stall = setTimeout(() => stop(`the download of ${name} stalled: no data for ${span(stallMs)}`), stallMs); };
  const backstop = setTimeout(() => stop(`the download of ${name} was still going after ${span(maxMs)}, so it was stopped`), maxMs);
  try {
    arm();
    const r = await fetchFn(url, { redirect: "follow", signal: ac.signal });
    if (failure) throw failure;
    if (!r.ok) throw new Error(`download of ${name} failed (${r.status})`);
    if (!r.body) return; // no body: the checksum decides
    reader = r.body.getReader();
    for (;;) {
      arm();
      const { done, value } = await reader.read();
      if (failure) throw failure; // a cancelled read ends as `done`: that is the stall or the backstop, not the end
      if (done) return;
      if (value?.length) onChunk(value);
    }
  } catch (e) {
    try { reader?.cancel(failure ?? e).catch(() => {}); } catch {}
    throw failure ?? e;
  } finally { clearTimeout(stall); clearTimeout(backstop); }
}

// Stream the release binary into `file`, hashing as it goes, and return its sha256 hex. `file` is created exclusively
// ("wx" fails on any existing path, a link included): from review, opening a fixed `${self}.download` with "w" followed
// a link to the binary itself and overwrote it on a checksum mismatch that then said "Nothing was changed". Every byte
// of a chunk is written before the next (writeSync may write fewer than asked; from review, a short write under a
// 4-byte file size limit installed a truncated binary that passed, because the whole chunk was hashed), and only the
// bytes written are hashed. `write` (writeSync) is the seam a test drives with partial writes.
export async function downloadTo(url, name, file, { write = writeSync, ...opts } = {}) {
  const hash = createHash("sha256"), fd = openSync(file, "wx"); // from here on `file` is this call's own
  const put = (chunk) => {
    for (let off = 0; off < chunk.length;) {
      const n = write(fd, chunk, off, chunk.length - off);
      if (!(n > 0)) throw new Error(`writing the download of ${name} made no progress (is the disk full?)`);
      hash.update(chunk.subarray(off, off + n)); off += n;
    }
  };
  try { await streamDownload(url, name, put, opts); }
  catch (e) { try { closeSync(fd); } catch {} try { rmSync(file, { force: true }); } catch {} throw e; }
  closeSync(fd);
  return hash.digest("hex");
}

// Each run stages its download under its own name beside `self`; a run killed mid-download leaves its file behind.
// `sweepStaging` removes those, and only those: exactly this pattern beside `self`, and only regular files (lstat: a
// link is never followed or removed). It runs under the update lock (lockedUpdate, backgroundUpdate), so no other
// update is writing one.
const stagingName = (self) => `${self}.download-${process.pid}-${randomBytes(4).toString("hex")}`;
export function sweepStaging(self) {
  const base = basename(self).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), mine = new RegExp(`^${base}\\.download-\\d+-[0-9a-f]{8}$`);
  let names = []; try { names = readdirSync(dirname(self)); } catch { return; }
  for (const n of names) {
    if (!mine.test(n)) continue;
    const p = join(dirname(self), n);
    try { if (lstatSync(p).isFile()) rmSync(p, { force: true }); } catch {}
  }
}

// The version of the binary now at `self`, asked of it (`--version`), or null when it gives none. From the final review:
// the update compared against the running process's version, so an older detached update overwrote a newer one a
// person had installed by hand meanwhile; the swap now compares against what is actually there.
export function installedVersion(self, spawn = startSync) {
  try { const v = String(spawn(self, ["--version"], { encoding: "utf8", timeout: 15000 })?.stdout ?? "").trim(); return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v) ? v.replace(/^v/, "") : null; }
  catch { return null; }
}

// What `routr skill install` (the new binary's, which prints its result as JSON) did, from that JSON rather than its
// exit status alone. From the final review: skills it kept (not routr's, or holding files routr did not write) were
// reported as reinstalled. Installed, kept and failed are each said, with what to do about a kept one.
export function skillOutcome(res) {
  let j = null; try { j = JSON.parse(String(res?.stdout ?? "")); } catch {}
  if (!j || typeof j !== "object") return { skill_reinstalled: res?.status === 0 };
  const kept = (j.kept ?? []).map((k) => ({ where: k.where, why: k.why })), failed = (j.failed ?? []).map((f) => ({ where: f.where, error: f.error }));
  return { skill_reinstalled: res.status === 0 && !kept.length && !failed.length,
    skill: { installed: (j.installed ?? []).map((x) => x.where), kept, failed },
    ...(kept.length ? { skill_repair: `routr's skills were not reinstalled at ${kept.map((k) => `${k.where} (${k.why})`).join("; ")}. Move or clear each, then run \`routr skill install\`` } : {}) };
}

// Manual `routr update` takes the same lock as the daily job (backgroundUpdate), so the two never swap at once. From
// the final review: the manual path bypassed the lock. A look (--check) swaps nothing and takes none. `lock` is a seam.
export async function lockedUpdate(opts = {}, { lock = LOCK(), run = update } = {}) {
  if (opts.checkOnly) return run(opts);
  try { mkdirSync(dirname(lock), { recursive: true }); } catch {}
  if (!takeLock(lock, (f) => lockIsStale(f))) return { ok: false, updated: false, error: `another routr update is running (${lock}): nothing was changed. Try again once it finishes` };
  try { return await run(opts); } finally { rmSync(lock, { force: true }); }
}

// `self`, `fetchFn`, `spawn`, `isStandalone` and `current` are seams: a test drives a real swap on a scratch file, with no
// network. The channel is the user's setting (`update_channel`), never a flag: a flag would be lost at the next
// automatic update, which reads the setting too. `stallMs`, `maxMs` and `write` are seams too, so a test runs a slow
// download fast and a short write without a full disk.
export async function update({ checkOnly = false, force = false, base = process.env.ROUTR_DOWNLOAD_BASE,
  self = process.execPath, fetchFn = fetch, spawn = startSync, isStandalone = standalone, current = ROUTR_VERSION,
  channel = loadConfig().config.update_channel, stallMs = DOWNLOAD_STALL_MS, maxMs = DOWNLOAD_MAX_MS, write = writeSync } = {}) {
  const out = { ok: false, current, latest: null, updated: false, ...(channel === "beta" ? { channel } : {}) };
  const on = channel === "beta" ? " on the beta channel" : "";
  // A look (--check) takes no lock, so it touches nothing; every other run holds the update lock (lockedUpdate,
  // backgroundUpdate) and first clears what a killed run left, whatever it then finds to do.
  if (!checkOnly) sweepStaging(self);
  try {
    out.latest = base ? "(from ROUTR_DOWNLOAD_BASE)" : await latestVersion(4000, channel, fetchFn);
    // A source checkout reads 0.0.0-dev, so every release looks newer; it is updated with git, never by this.
    if (!base && !isStandalone()) return { ...out, ok: true, note: `this routr runs from a source checkout: update it with \`git pull\` (latest release${on}: ${out.latest})` };
    const available = base ? true : newer(out.latest, current);
    // Never a downgrade by itself: someone on 0.5.0-beta.2 who goes back to stable keeps it until a stable release is
    // newer. --force installs the channel's newest now, older or not.
    if (!available && !force) return { ...out, ok: true, note: isPre(current) && channel !== "beta" && out.latest !== current
      ? `routr ${current} is a pre-release and the stable channel's newest is ${out.latest}: you stay on ${current} until a stable release is newer. \`routr update --force\` installs ${out.latest} now`
      : `routr is up to date${on}` };
    if (checkOnly) return { ...out, ok: true, available: true, note: `${out.latest} is available${on}: run \`routr update\`` };
    if (!isStandalone()) return { ...out, ok: true, available: true, note: "this routr runs from a source checkout: update it with `git pull`" };
    const asset = assetName();
    if (!asset) throw new Error(`no release build for ${process.platform}/${process.arch}`);
    const from = base ?? downloadBase(out.latest), dl = { fetchFn, stallMs, maxMs };
    // The binary streams to a file of this run's own beside `self` (the same folder, so the swap is a rename).
    // downloadTo removes it when the download fails; from then on it is removed on every way out that does not move it
    // into place. Only that exact path is ever removed: never one this run did not create.
    const tmp = stagingName(self);
    let staged = false;
    try {
      const got = await downloadTo(`${from}/${asset}`, asset, tmp, { ...dl, write });
      staged = true;
      const parts = []; await streamDownload(`${from}/SHA256SUMS`, "SHA256SUMS", (c) => parts.push(Buffer.from(c)), dl);
      const want = Buffer.concat(parts).toString("utf8").split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === asset)?.[0];
      if (!want || want !== got) throw new Error(`checksum mismatch for ${asset}; nothing was changed`);
      // Last thing before the swap: never replace a binary that is already this release or newer (installedVersion).
      // ROUTR_DOWNLOAD_BASE names no version to compare, so it is not asked there.
      if (!base && !force) {
        const there = installedVersion(self, spawn);
        if (there && !newer(out.latest, there)) return { ...out, ok: true, installed: there,
          note: `the routr at ${self} is already ${there}${there === out.latest ? "" : `, newer than ${out.latest}`} (installed since this run started): not replaced. \`routr update --force\` installs ${out.latest}` };
      }
      swapBinary(self, tmp);
    } finally { if (staged) try { rmSync(tmp, { force: true }); } catch {} }
    // From here on the new binary is in place: whatever happens next, the result must say so (0.1.14 to 0.1.16 threw
    // on an undeclared name here and reported "Nothing was changed" after every successful update).
    out.updated = true;
    const v = spawn(self, ["--version"], { encoding: "utf8" });
    out.now = (v.stdout ?? "").trim() || null;
    const skill = skillOutcome(spawn(self, ["skill", "install"], { encoding: "utf8" }));
    const s = skill.skill, said = s && (s.kept.length || s.failed.length) ? ` · skills: ${s.installed.length} installed, ${s.kept.length} kept, ${s.failed.length} failed${s.kept.length ? " (skill_repair says what to do)" : ""}` : "";
    return { ...out, ok: true, updated: true, ...skill, note: `updated ${current} → ${out.now ?? out.latest}${on}${said}` };
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
export { lockIsStale }; // lives in runtime.mjs now, beside takeLock, so telemetry status can read the lock too

// Put `bin` where `self` is: a Buffer, or the path of a downloaded file, which is moved (not copied) to `${self}.new`.
// A running binary can be renamed on every system, but on Windows it cannot be overwritten, so it is moved aside first.
// If the new file cannot be moved in, the old one goes back: never leave no binary. Known limit: a process killed
// between the two renames leaves the old binary at `${self}.old` and nothing at `self`; the install command puts one back.
export function swapBinary(self, bin, { rename = renameSync } = {}) {
  const fresh = `${self}.new`, old = `${self}.old`;
  if (typeof bin === "string") renameSync(bin, fresh); else writeFileSync(fresh, bin);
  chmodSync(fresh, 0o755);
  rmSync(old, { force: true });
  rename(self, old);
  try { rename(fresh, self); }
  catch (e) { try { renameSync(old, self); } catch {} try { rmSync(fresh, { force: true }); } catch {} throw e; }
  try { rmSync(old, { force: true }); } catch {} // Windows keeps it locked until this process exits; the next update removes it
}

const CACHE = CACHE_DIR;
const LOCK = UPDATE_LOCK;
export const UPDATE_LOG = () => join(CACHE(), "update.log");
export { TELEMETRY_LOG };
const DAY = 24 * 60 * 60 * 1000;

export const dueForCheck = (lastCheckMs, nowMs = Date.now()) => !Number.isFinite(lastCheckMs) || nowMs - lastCheckMs > DAY;

// Why automatic updates are off, or null when they are on: the one answer doctor, setup's channel note and the daily job
// all use. A source checkout is updated with git, never by the job (it starts only from a release binary).
export const updatesOff = (config, { isStandalone = standalone, env = process.env } = {}) =>
  !isStandalone() ? "running from source" : env.ROUTR_NO_UPDATE ? "ROUTR_NO_UPDATE is set" : config?.auto_update === false ? "auto_update is false in your config" : null;
// The job runs only from a release binary (maybeAutoUpdate checks that first), so it asks the rest.
const updatesOn = (config) => !updatesOff(config, { isStandalone: () => true });

// The daily job: the update check and the telemetry send share one detached process and one stamp.
// `isStandalone` and `spawn` are seams, so a test can check which runs start without a release binary.
export function maybeAutoUpdate(config, { isStandalone = standalone, spawn = spawnSelf } = {}) {
  try {
    if (!isStandalone()) return false;
    try { rmSync(`${process.execPath}.old`, { force: true }); } catch {} // Windows: the binary a previous update moved aside
    if (!updatesOn(config) && !telemetryStatus(config).on) return false; // ROUTR_NO_UPDATE stops updates, not a send the person turned on
    let last = NaN; try { last = statSync(UPDATE_STAMP()).mtimeMs; } catch {}
    if (!dueForCheck(last)) return false;
    return spawn(["update", "--background"]);
  } catch { return false; } // updating must never get in the way of the command that was asked for
}

// What the daily job writes to UPDATE_LOG after its check: the result, and the newest release it saw on which channel, so
// doctor can say an update is waiting without asking GitHub itself (a command never makes the updater's network call).
// `latest` is kept only when it is a release version (not ROUTR_DOWNLOAD_BASE's placeholder).
// After a swap it also keeps what the skill reinstall did (skillOutcome), the repair for a kept skill included.
export const updateRecord = (r, channel, at = new Date().toISOString()) =>
  ({ at, ok: r.ok, updated: r.updated, note: r.note, error: r.error ?? null, latest: CHANNEL_TAGS.beta.test(String(r.latest ?? "")) ? r.latest : null, channel: channel ?? "stable",
    ...(r.skill_reinstalled !== undefined ? { skill_reinstalled: r.skill_reinstalled } : {}), ...(r.skill ? { skill: r.skill } : {}), ...(r.skill_repair ? { skill_repair: r.skill_repair } : {}) });

// `run` is a seam: a test drives the job with a fake update, and no network.
export async function backgroundUpdate({ run = update } = {}) {
  mkdirSync(CACHE(), { recursive: true });
  if (!takeLock(LOCK(), (f) => lockIsStale(f))) return; // one updater at a time
  try {
    writeFileSync(UPDATE_STAMP(), new Date().toISOString() + "\n"); // first, so a failing check is not retried on every command
    const { config } = loadConfig();
    // Telemetry first: it is quick, and an update that swaps the binary should not take it with it.
    forgetConsentUnlessOn(config);
    if (telemetryStatus(config).on) { const t = await sendRows().catch((e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 160) })); writeFileSync(TELEMETRY_LOG(), JSON.stringify({ at: new Date().toISOString(), ...t }) + "\n"); }
    if (!updatesOn(config)) return;
    const r = await run({ channel: config.update_channel });
    writeFileSync(UPDATE_LOG(), JSON.stringify(updateRecord(r, config.update_channel)) + "\n");
  } finally { rmSync(LOCK(), { force: true }); }
}

// Whether automatic updates are on and why not, when the daily job last checked, its last result, and the update it saw
// waiting. Read from the job's own files only: doctor (and setup, which runs its inspection) never asks GitHub. A release
// is offered only when the job saw it on the channel the user is on now (after a switch the old record says nothing)
// and it is newer than this binary. With updates off the record is no longer refreshed, so nothing is offered and the
// person is told how to look by hand. `isStandalone`, `env`, `now`, `current`, `log` and `stamp` are test seams.
export function autoUpdateStatus(config, { isStandalone = standalone, env = process.env, now = Date.now(), current = ROUTR_VERSION, log = UPDATE_LOG(), stamp = UPDATE_STAMP() } = {}) {
  const why_off = updatesOff(config, { isStandalone, env }), on = !why_off, channel = config?.update_channel ?? "stable";
  let checked = null, last = null;
  try { checked = Math.round((now - statSync(stamp).mtimeMs) / 3600000); } catch {}
  try { last = JSON.parse(readFileSync(log, "utf8")); } catch {}
  const waiting = on && CHANNEL_TAGS.beta.test(String(last?.latest ?? "")) && last.channel === channel && newer(last.latest, current);
  return { on, channel, why_off, checked_hours_ago: checked, last,
    available: waiting ? { version: last.latest, seen_hours_ago: hoursAgo(last.at, now) } : null,
    ...(on ? {} : { check_by_hand: "routr update --check" }) };
}
