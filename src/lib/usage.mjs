// Live usage per subscription, read passively from what each harness already writes locally. Read-only.
// headroom = remaining share of the TIGHTEST window (0..1). No pace or burn modelling: the router decides on what is left.
// Every pool is a list of windows plus a CLASS: `included` (windows that expire: a subscription), `capped` (a spend cap
// the vendor enforces, read as one more window), `metered` (billed usage with no quota, and a working source says so),
// or `unknown` (nothing readable). Measured 2026-09-22 on a ChatGPT Enterprise seat: no windows at all, only
// `credits.unlimited: true`, and a plan name of `business`. So the shape is the key, never the plan name.
import { CURSOR_BY_HAND, cursorUsage } from "./cursor-usage.mjs";
import { CLAUDE_SNAPSHOT, CURSOR_SNAPSHOT, KIRO_SNAPSHOT, standalone } from "./runtime.mjs";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export { CLAUDE_SNAPSHOT };
export const CODEX_SESSIONS = join(homedir(), ".codex/sessions");
const now = () => Date.now() / 1000;

// `nowSec` is injectable so the recorded shapes are tests that do not age.
function summarize(pool, source, ts, windows, note, cls, nowSec = now(), reason) {
  windows = windows.filter((w) => Number.isFinite(w.usedPct)); // a window without a number must not turn headroom into NaN
  cls ??= windows.length ? "included" : "unknown";
  const ageSec = ts ? Math.round(nowSec - ts) : null;
  if (!windows.length) return { pool, source, ageSec, windows, headroom: null, class: cls, note: note ?? "no usage data", ...(reason ? { reason } : {}) };
  // A window whose reset time has passed since the snapshot has rolled over: treat as empty.
  const live = windows.map((w) => (w.resetsAt && w.resetsAt < nowSec ? { ...w, usedPct: 0 } : w));
  const headroom = Math.min(...live.map((w) => Math.max(0, 1 - w.usedPct / 100)));
  return { pool, source, ageSec, windows: live, headroom, class: cls, note };
}

// A cap's period is not assumed. When its reset falls on a UTC month boundary the window is that month (the vendors
// document monthly caps resetting on the 1st at 00:00 UTC); otherwise the length is unknown and the ranker holds the
// full reserve instead of tapering it.
export function monthMinutes(resetsAt) {
  if (!resetsAt) return null;
  const d = new Date(resetsAt * 1000);
  if (d.getUTCDate() !== 1 || d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds()) return null;
  return Math.round((d.getTime() - Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)) / 60000);
}

// One reader for both Codex shapes: the app-server's camelCase and the session log's snake_case. Pure, so the recorded
// shapes (an Enterprise seat, a Pro login) are tests. Observed 2026-09-22: the Enterprise seat has `primary` and
// `secondary` null and `credits.unlimited` true; the Pro login one weekly `primary` and credits off.
export function codexSnapshot(rl, source, ts, nowSec = now()) {
  const g = (o, camel, snake) => o?.[camel] ?? o?.[snake];
  const win = (name, w) => ({ name, usedPct: g(w, "usedPercent", "used_percent"), windowMin: g(w, "windowDurationMins", "window_minutes"), resetsAt: g(w, "resetsAt", "resets_at") });
  const ws = ["primary", "secondary"].filter((k) => rl[k]).map((k) => win(k, rl[k]));
  const cap = g(rl, "individualLimit", "individual_limit"), credits = rl.credits;
  const notes = [];
  // A member credit limit (the owner's monthly cap) is one more window: the tightest wins, as with any other.
  if (cap) { const resetsAt = g(cap, "resetsAt", "resets_at"); ws.push({ name: "monthly_cap", usedPct: 100 - g(cap, "remainingPercent", "remaining_percent"), windowMin: monthMinutes(resetsAt), resetsAt }); }
  const reached = g(rl, "rateLimitReachedType", "rate_limit_reached_type");
  if (reached) notes.push(`limit reached: ${reached}`);
  if (g(rl, "spendControlReached", "spend_control_reached") === true) notes.push("spend control reached: the cap is used up");
  const hasCredits = Boolean(g(credits, "hasCredits", "has_credits"));
  // Metered only with NO windows: the one observed shape. Credits beside windows (a Business seat past its included
  // usage; claimed, not observed) leave the windows in charge and are only noted. A finite balance without windows is
  // also claimed: it is a quota of sorts, but not a share, so it is metered with the balance named.
  const metered = !cap && !ws.length && (credits?.unlimited || hasCredits);
  if (metered) notes.push(credits.unlimited ? "metered: unlimited credits, usage is billed, no quota reported" : `metered: workspace credits${credits.balance ? ` (balance ${credits.balance})` : ""}, usage is billed, no window reported`);
  else if (ws.length && (credits?.unlimited || hasCredits)) notes.push("workspace credits are on: the harness keeps working past 100% on billed usage");
  return summarize("codex", source, ts, ws, notes.join("; ") || undefined, cap ? "capped" : metered ? "metered" : undefined, nowSec);
}

// The Claude snapshot `routr statusline` writes. Windows come from `rate_limits`; `spend_limit` (behind a Claude apps
// gateway) is a cap whose used share can pass 100, clamped here. A render with no windows (a session's first renders,
// or a plan that sends none) is served the last windows seen, however old: `ageSec` says how old, and a lapsed window
// rolls over to empty, as before. Absence is NOT read as "no quota": the statusline docs list only Pro and Max as
// sending `rate_limits`, a Team seat is unobserved, and a plan with no quota is the user's `billing: "metered"` to say.
// The one `reason` a Claude reading carries, so doctor keys on it and not on the wording of the note.
export const NO_WINDOWS_AFTER_ANSWER = "no_windows_after_answer";
export function claudeSnapshot(s, nowSec = now()) {
  const mins = { five_hour: 300, seven_day: 10080, spend_limit: null };
  const toWs = (rl) => Object.entries(rl ?? {}).filter(([k, v]) => k in mins && v?.used_percentage != null).map(([k, v]) => ({ name: k, usedPct: Math.min(100, v.used_percentage), windowMin: mins[k], resetsAt: v.resets_at }));
  let ws = toWs(s.rate_limits), ts = s.ts;
  if (!ws.length && s.seen) { ws = toWs(s.seen.rate_limits); ts = s.seen.ts; }
  if (ws.length) return summarize("claude", "statusline", ts, ws, undefined, ws.some((w) => w.name === "spend_limit") ? "capped" : "included", nowSec);
  return summarize("claude", "statusline", s.ts, [], s.answered
    ? "Claude reports no usage windows for this seat. A plan with no quota (usage-based Enterprise, an API key) sends none: if that is this seat, set `billing: \"metered\"` for claude in the config"
    : "no windows yet: Claude reports usage after its first response of a session", undefined, nowSec, s.answered ? NO_WINDOWS_AFTER_ANSWER : undefined);
}

function newestFile(dir) {
  // sessions/YYYY/MM/DD/*.jsonl: descend into the lexically last directory at each level.
  let cur = dir;
  for (let i = 0; i < 3; i++) {
    const subs = existsSync(cur) ? readdirSync(cur).filter((n) => /^\d+$/.test(n)).sort() : [];
    if (!subs.length) return null;
    cur = join(cur, subs[subs.length - 1]);
  }
  const files = readdirSync(cur).filter((f) => f.endsWith(".jsonl")).map((f) => join(cur, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

export function readCodex() {
  const f = newestFile(CODEX_SESSIONS);
  if (!f) return summarize("codex", "session log", null, []);
  const lines = readFileSync(f, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const o = JSON.parse(lines[i]);
      const rl = o.payload?.rate_limits ?? o.payload?.info?.rate_limits ?? o.rate_limits;
      if (!rl?.primary && !rl?.credits) continue;
      return codexSnapshot(rl, "session log", Date.parse(o.timestamp) / 1000);
    } catch {}
  }
  return summarize("codex", "session log", null, []);
}

export function readClaude() {
  if (!existsSync(CLAUDE_SNAPSHOT)) return summarize("claude", "statusline", null, [], "no snapshot: the usage statusline is not installed, or no Claude Code session has run since");
  return claudeSnapshot(JSON.parse(readFileSync(CLAUDE_SNAPSHOT, "utf8")));
}

// Run a harness command read-only and collect stdout; resolve null on any failure or timeout, never throw.
// `status: true` resolves the exit code instead, for a command whose only answer is on stderr.
export function run(cmd, args, { input, timeoutMs = 8000, until, cwd, status = false } = {}) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(v); };
    let child;
    try { child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"], ...(cwd ? { cwd } : {}) }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.stdout.on("data", (d) => { out += d; if (until?.(out)) finish(out); });
    child.on("close", (code) => finish(status ? code : out || null));
    if (input) child.stdin.write(input); else child.stdin.end();
  });
}

// Codex: the CLI's own app server answers account/rateLimits/read live (~0.4 s, no tokens). It is marked experimental,
// so the session-log reader stays as the fallback.
export async function readCodexLive() {
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "routr", version: "0" } } },
    { jsonrpc: "2.0", method: "initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} },
  ];
  const out = await run("codex", ["app-server"], { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", timeoutMs: 6000, until: (o) => /"id":2[,}][^\n]*\n/.test(o) }); // wait for the whole line, not the first bytes of it
  for (const line of (out ?? "").split("\n")) {
    try {
      const o = JSON.parse(line);
      const rl = o.id === 2 && o.result?.rateLimits;
      if (!rl) continue;
      return codexSnapshot(rl, "app-server", now());
    } catch {}
  }
  return readCodex();
}

// Antigravity: `/usage` in print mode is answered without an agent turn (0 tokens, ~2 s). It reports two pools;
// routr routes to the harness's OWN models, so only the pool named for Gemini counts.
export async function readAgy() {
  // Measured: the command answers in ~2 s, but about one call in six hangs. A short timeout and one retry turn that
  // into a rare failure instead of a common one; two hangs in a row are reported, never papered over.
  for (const timeoutMs of [4000, 5000]) {
    const out = await run("agy", ["-p", "/usage", "--output-format", "json"], { timeoutMs });
    try {
      const groups = JSON.parse(out).command.data.groups;
      // Only the Gemini pool is the subscription's own. With none named, the usage is unknown: another pool's numbers
      // presented as live headroom would steer work on a guess.
      const own = groups.find((g) => /gemini/i.test(g.name));
      if (!own) return summarize("agy", "agy /usage", null, [], "`agy /usage` lists no Gemini pool; using the assumed headroom");
      const mins = { weekly: 10080, "5h": 300 };
      const ws = own.buckets.map((b) => ({ name: b.id, usedPct: (1 - b.remaining_fraction) * 100, windowMin: mins[b.window] ?? 0, resetsAt: Date.parse(b.reset_time) / 1000 }));
      return summarize("agy", "agy /usage", now(), ws, `pool: ${own.name}`);
    } catch {}
  }
  return summarize("agy", "agy /usage", null, [], "`agy -p /usage` did not answer in two tries; using the assumed headroom");
}

// Cursor shows usage only in its own /usage screen, which takes seconds to read (a private herdr session, Cursor, the
// panel: 4 to 5 s measured), too slow for a call that answers in 300 ms. Kiro's /usage answers in ~10 s and leaves a
// session behind that takes ~8 s more to delete (measured 2026-09-26). So both are read like Claude's: a snapshot every
// call reads in milliseconds, with its age shown, and a fresh reading taken in the BACKGROUND about once per working
// session: when the last try is over 4 hours old, the call starts a detached `routr usage <name>` and does not wait.
// Both are monthly pools and burn slowly, so a reading hours old routes the same (the maintainer's call, 2026-09-25).
// `setup` and `doctor` read usage too, so a new install has its first reading before its first dispatch.
const REFRESH_SEC = 4 * 3600;
// A reading that has not been refreshed for a day is not used: refreshes are failing, and the plan may have reset
// since (Cursor's screen shows no reset time). Past it, the subscription is assumed and the note says so.
const TRUST_SEC = 24 * 3600;
const LOCK_SEC = 120; // one background reading at a time; a lock older than any reading (90 s at most) is abandoned
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
// Written whole or not at all (a temp file, then a rename), as the Claude snapshot is: a reader never sees half a file.
const writeJson = (file, o) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(o) + "\n");
  try { renameSync(tmp, file); } catch { try { unlinkSync(file); } catch {} renameSync(tmp, file); }
};
// Take the refresh lock, or say someone else holds it. Exclusive create, as the updater's lock: two calls in a burst
// cannot both win. An unwritable cache means no lock and so no refresh, never a refresh on every call.
export function takeLock(file, nowMs = Date.now()) {
  try { closeSync(openSync(file, "wx")); return true; } catch (e) { if (e?.code !== "EEXIST") return false; }
  try { if (nowMs - statSync(file).mtimeMs < LOCK_SEC * 1000) return false; rmSync(file, { force: true }); closeSync(openSync(file, "wx")); return true; } catch { return false; }
}
const noRefresh = () => process.env.ROUTR_NO_REFRESH === "1"; // tests: nothing detached, nothing written
const startRefresh = (name) => {
  try {
    const args = [...(standalone() ? [] : [process.argv[1]]), "usage", name, "--background"];
    const c = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
    c.on("error", () => {}); c.unref(); return true;
  } catch { return false; }
};

// `routr usage <name>`: read now and keep the reading. A failed read keeps the last good one, whose age then says how
// old it is. Only the background reading (`--background`) holds the refresh lock, so only it releases it: a reading
// asked for by hand must not free a lock a background reading still holds.
async function refreshSnapshot({ read, keep, file, lock = `${file}.lock`, nowSec = now(), background = false }) {
  try {
    const r = await read();
    const last = readJson(file);
    try {
      writeJson(file, r.ok ? { ts: nowSec, tried: nowSec, reading: keep(r) }
        : { ts: last?.ts ?? null, tried: nowSec, reading: last?.reading ?? null, error: r.error });
    } catch {}
    return r;
  } finally { if (background) try { rmSync(lock, { force: true }); } catch {} }
}

// `background: false` reads without starting a refresh: doctor, for a harness installed but not in the config.
// `windows(reading)` and `describe(reading)` turn the kept reading into the usage row; `byHand` is said when reading fails.
function readSnapshot({ name, source, windows, describe, byHand, file, lock = `${file}.lock`, nowSec = now(), refresh = () => startRefresh(name), background = true, off = noRefresh() }) {
  let snap = readJson(file);
  let started = false;
  if (background && !off && !(nowSec - (snap?.tried ?? 0) < REFRESH_SEC) && takeLock(lock, nowSec * 1000)) {
    // Marked before it starts, so the next call waits its turn; if the mark cannot be written, nothing is started.
    try { writeJson(file, { ...snap, tried: nowSec }); started = refresh(); } catch {}
    if (!started) try { rmSync(lock, { force: true }); } catch {}
  }
  const r = snap?.reading, age = snap?.ts == null ? null : nowSec - snap.ts;
  const after = [started && "a fresh reading is being taken in the background", snap?.error && `the last try failed: ${snap.error}`].filter(Boolean).join("; ");
  if (r && age < TRUST_SEC) return summarize(name, source, snap.ts, windows(r), `${describe(r)}${after ? `; ${after}` : ""}`, undefined, nowSec);
  const why = r ? `the last reading is ${Math.round(age / 3600)} h old, too old to use` : "no reading yet";
  return summarize(name, source, null, [], `${why}${after ? `; ${after}` : ""}; using the assumed headroom.${snap?.error ? ` By hand: ${byHand}` : ""}`, undefined, nowSec);
}

// Cursor: only Included counts: it is the whole plan, and Cursor's own models (Composer, Grok) draw on it through Auto.
// API is other vendors' models inside Cursor, which routr does not route to, so it is shown in the note and never ranked.
const pct = (x) => (x == null ? "?" : `${x}%`);
export const refreshCursor = ({ read = cursorUsage, file = CURSOR_SNAPSHOT, ...o } = {}) => refreshSnapshot({ read, file, ...o,
  keep: (r) => ({ plan: r.plan, included_used_pct: r.included_used_pct, auto_used_pct: r.auto_used_pct, api_used_pct: r.api_used_pct }) });
export const readCursor = ({ file = CURSOR_SNAPSHOT, ...o } = {}) => readSnapshot({ name: "cursor", source: "cursor /usage", byHand: CURSOR_BY_HAND, file, ...o,
  windows: (r) => [{ name: "included", usedPct: r.included_used_pct, windowMin: null, resetsAt: null }],
  describe: (r) => `Included ${pct(r.included_used_pct)} used (Auto ${pct(r.auto_used_pct)}, API ${pct(r.api_used_pct)})` });

// Kiro: `kiro-cli chat --no-interactive /usage` answers without an agent turn (0 credits) with the plan's monthly
// credits: "Estimated Usage | resets on 2026-10-01 | KIRO FREE" / "Credits (0.00 of 50 covered in plan), 0.0%"
// (measured on a Free plan, 2026-09-26). Every model draws on those credits, so there is one pool. Any other line
// (a paid plan's overage or bonus credits, not yet observed) is kept in the note, never guessed at.
export const KIRO_BY_HAND = "run `kiro-cli chat --no-interactive /usage`, read \"Credits (X of Y covered in plan)\", and pass --headroom kiro=<1 - X/Y>";
export function parseKiroUsage(text) {
  const t = String(text ?? "");
  const m = t.match(/Credits\s*\(\s*([\d.,]+)\s+of\s+([\d.,]+)\s+covered in plan\s*\)/i);
  if (!m) return null;
  const n = (s) => Number(s.replaceAll(",", "")), used = n(m[1]), limit = n(m[2]);
  if (!Number.isFinite(used) || !(limit > 0)) return null;
  const head = t.match(/^[^\n]*Estimated Usage[^\n]*$/im)?.[0] ?? "";
  const reset = head.match(/resets on (\d{4}-\d{2}-\d{2})/i)?.[1];
  const other = t.split("\n").map((l) => l.trim()).filter((l) => l && l !== head.trim() && !l.includes(m[0]) && !/^Manage your plan\b/i.test(l));
  return { plan: head.split("|").at(-1)?.trim() || null, credits_used: used, credits_limit: limit, used_pct: Math.round(used / limit * 1000) / 10,
    resets_at: reset ? Date.parse(`${reset}T00:00:00Z`) / 1000 : null, ...(other.length ? { other: other.join(" · ").slice(0, 160) } : {}) };
}
// Kiro keeps each /usage as an empty saved session, listed under the folder it ran in. So it runs in the system temp
// folder, never the user's project, and the session is removed with Kiro's own `--delete-session` (measured: ~8 s).
export async function kiroUsage({ exec = run, cwd = tmpdir() } = {}) {
  const out = await exec("kiro-cli", ["chat", "--output-format", "stream-json", "/usage"], { cwd, timeoutMs: 45000 });
  if (out == null) return { ok: false, error: "kiro-cli did not answer /usage in 45 s (not installed, not logged in, or hung)", read_yourself: KIRO_BY_HAND };
  let session = null, text = null;
  for (const line of out.split("\n")) {
    try { const o = JSON.parse(line); session ??= o.data?.sessionId ?? null; if (o.type === "runFinished") text = o.data?.finalText ?? null; } catch {}
  }
  // Kiro prints "Deleted" and exits 0 even for an id it never had (measured), so exit 0 is the best sign there is.
  const deleted = !session || (await exec("kiro-cli", ["chat", "--delete-session", session], { cwd, timeoutMs: 30000, status: true })) === 0;
  const cleanup = deleted ? {} : { note: `Kiro kept an empty session from this reading; remove it with: kiro-cli chat --delete-session ${session}` };
  const p = parseKiroUsage(text);
  if (!p) return { ok: false, error: "Kiro's /usage did not show \"Credits (X of Y covered in plan)\"", read_yourself: KIRO_BY_HAND, ...cleanup };
  return { ok: true, subscription: "kiro", ...p, headroom: Math.round((1 - p.used_pct / 100) * 1000) / 1000, ...cleanup };
}
export const refreshKiro = ({ read = kiroUsage, file = KIRO_SNAPSHOT, ...o } = {}) => refreshSnapshot({ read, file, ...o,
  keep: (r) => ({ plan: r.plan, credits_used: r.credits_used, credits_limit: r.credits_limit, used_pct: r.used_pct, resets_at: r.resets_at, ...(r.other ? { other: r.other } : {}) }) });
// A reset on a UTC month boundary makes the window that month, so the reserve tapers toward it as for Codex's cap.
export const readKiro = ({ file = KIRO_SNAPSHOT, ...o } = {}) => readSnapshot({ name: "kiro", source: "kiro /usage", byHand: KIRO_BY_HAND, file, ...o,
  windows: (r) => [{ name: "monthly_credits", usedPct: r.used_pct, windowMin: monthMinutes(r.resets_at), resetsAt: r.resets_at }],
  describe: (r) => `${r.plan ? `${r.plan}: ` : ""}${r.credits_used} of ${r.credits_limit} credits used${r.other ? ` (${r.other})` : ""}` });

// How each subscription's usage is read, in one place, so doctor, dispatch, and `routr usage` say the same. `read` runs
// on every call and must be fast. `check` takes a fresh reading now and prints it raw (`routr usage cursor`).
// A harness added later picks its row; nothing else changes.
export const SOURCES = {
  claude: { read: readClaude },
  codex: { read: readCodexLive },
  agy: { read: readAgy },
  cursor: { read: readCursor, check: refreshCursor },
  kiro: { read: readKiro, check: refreshKiro },
};

// One unreadable source must not take the others (or the routing advice) down with it. Readers run in parallel.
// `given` holds headroom the caller read itself (0..1); it wins over any reading.
// `background` names the subscriptions whose reader may start a background refresh (default: all asked for).
export async function readUsage(names, given = {}, { sources = SOURCES, background = names } = {}) {
  return Promise.all(names.map(async (name) => {
    if (typeof given[name] === "number") return { pool: name, source: "given by caller", ageSec: 0, windows: [], headroom: Math.min(1, Math.max(0, given[name])) };
    const src = sources[name];
    if (!src?.read) return summarize(name, "none", null, [], "no usage source: read it yourself and pass --headroom " + name + "=<0..1>");
    try { return await src.read({ background: background.includes(name) }); } catch (e) { return summarize(name, "unreadable", null, [], `usage unreadable: ${String(e?.message ?? e).slice(0, 80)}`); }
  }));
}
