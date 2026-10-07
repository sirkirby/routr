// Live usage per subscription, read from what each harness writes locally or answers through its own CLI. Read-only.
// headroom = remaining share of the TIGHTEST window (0..1). No pace or burn modelling: the router decides on what is left.
// Every pool is a list of windows plus a CLASS: `included` (windows that expire: a subscription), `capped` (a spend cap
// the vendor enforces, read as one more window), `metered` (billed usage with no quota, and a working source says so),
// or `unknown` (nothing readable). Measured 2026-09-22 on a ChatGPT Enterprise seat: no windows at all, only
// `credits.unlimited: true`, and a plan name of `business`. So the shape is the key, never the plan name.
import { CLAUDE_SNAPSHOT, home, run } from "./runtime.mjs";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export { CLAUDE_SNAPSHOT };
export const CODEX_SESSIONS = join(home(), ".codex/sessions");
const now = () => Date.now() / 1000;

// One subscription's usage as every reader returns it. `ts` is when the harness reported it (null: nothing read);
// `cls` the class, from the windows when not given; `reason` a stable key for a note doctor acts on. `nowSec` is
// injectable so the recorded shapes are tests that do not age.
export function summarize({ pool, source, ts = null, windows = [], note, cls, nowSec = now(), reason }) {
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
  return summarize({ pool: "codex", source, ts, windows: ws, note: notes.join("; ") || undefined, cls: cap ? "capped" : metered ? "metered" : undefined, nowSec });
}

// The Claude snapshot `routr statusline` writes. Windows come from `rate_limits`; `spend_limit` (behind a Claude apps
// gateway) is a cap whose used share can pass 100, clamped here. A render with no windows (a session's first renders,
// or a plan that sends none) is served the last windows seen, however old: `ageSec` says how old, and a lapsed window
// rolls over to empty, as before. Absence is NOT read as "no quota": the statusline docs list only Pro and Max as
// sending `rate_limits` (yet a Team seat's `/usage` shows the same windows: the plan does not change it), and a plan
// with no quota is the user's `billing: "metered"` to say, unless Claude's sign-in status says so (an API key: readUsage).
// The one `reason` a Claude reading carries, so doctor keys on it and not on the wording of the note.
export const NO_WINDOWS_AFTER_ANSWER = "no_windows_after_answer";
export function claudeSnapshot(s, nowSec = now()) {
  const mins = { five_hour: 300, seven_day: 10080, spend_limit: null };
  const toWs = (rl) => Object.entries(rl ?? {}).filter(([k, v]) => k in mins && v?.used_percentage != null).map(([k, v]) => ({ name: k, usedPct: Math.min(100, v.used_percentage), windowMin: mins[k], resetsAt: v.resets_at }));
  let ws = toWs(s.rate_limits), ts = s.ts;
  if (!ws.length && s.seen) { ws = toWs(s.seen.rate_limits); ts = s.seen.ts; }
  if (ws.length) return summarize({ pool: "claude", source: "statusline", ts, windows: ws, cls: ws.some((w) => w.name === "spend_limit") ? "capped" : "included", nowSec });
  return summarize({ pool: "claude", source: "statusline", ts: s.ts, note: s.answered
    ? "Claude reports no usage windows for this seat. A plan with no quota (usage-based Enterprise) sends none: if that is this seat, set `billing: \"metered\"` for claude in the config"
    : "no windows yet: Claude reports usage after its first response of a session", nowSec, reason: s.answered ? NO_WINDOWS_AFTER_ANSWER : undefined });
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
  if (!f) return summarize({ pool: "codex", source: "session log" });
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
  return summarize({ pool: "codex", source: "session log" });
}

// Claude's own `/usage`, in print mode: a local command (`"local_command":"usage"`, 0 turns, 0 cost; Claude Code
// 2.1.289, 2026-10-05, Max plan). Its text, as measured:
//   Current session: 1% used · resets Oct 5 at 3:59pm (America/Detroit)
//   Current week (all models): 90% used · resets Oct 5 at 9:59pm (America/Detroit)
//   Current week (Fable): 0% used · resets Oct 5 at 10pm (America/Detroit)
// The session and all-models lines take the statusline's window names, so ranking, reserves and doctor treat both
// sources alike. A weekly line scoped to one model is counted in the note and never named: routr's advice carries no
// model names (AGENTS.md), and the router does not choose models. Anything else (the line about the subscription,
// the local breakdown that follows) is left out. The same lines on Max and Team (measured). An API key login shows only a
// session cost summary and no windows (measured 2026-10-07), as a subscription without its credentials does: its class
// comes from `claude auth status` instead (harnesses.mjs, `claudeBilling`).
const CLAUDE_LINES = { "session": { name: "five_hour", windowMin: 300 }, "week (all models)": { name: "seven_day", windowMin: 10080 } };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// The wall time in a zone at the instant `ms`, read back as if it were UTC (ms), from Intl alone (no time zone data of
// routr's own).
function wallAt(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}
// Every instant (epoch ms) at which the zone's clock shows this wall time: one as a rule, two in the hour a clock goes
// back (ambiguous), none in the hour it skips forward (nonexistent). Each offset in force within a day either side is
// tried, and an instant counts only if it reads back as the same wall time in that zone.
function wallTimes(y, mo, d, h, mi, zone) {
  const asUtc = Date.UTC(y, mo, d, h, mi), day = 86400000;
  const offsets = new Set([asUtc - day, asUtc, asUtc + day].map((ms) => wallAt(ms, zone) - ms));
  return [...new Set([...offsets].map((o) => asUtc - o))].filter((t) => wallAt(t, zone) === asUtc).sort((a, b) => a - b);
}
// "Oct 5 at 3:59pm (America/Detroit)" → epoch seconds, or null when it does not read exactly so. It names no year: of
// last year's, this year's and next year's, the occurrence nearest now; a reset just past stays past, and summarize
// rolls its window over, as for the statusline. One further from now than `maxSec` (the window's length and a day) is
// not a reading of this window: null. A wall time the clock skips is null; one it shows twice takes the LATER instant,
// so a window is never rolled over before its reset (no headroom invented), and the instant is the end of the minute
// shown (below). Never guessed: null, and the note says so.
export function parseClaudeReset(text, nowSec = now(), maxSec = Infinity) {
  const m = String(text ?? "").trim().match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z0-9_+\-/]+)\)$/i);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].toLowerCase()), d = +m[2], h12 = +m[3], mi = +(m[4] ?? 0);
  if (mo < 0 || d < 1 || h12 < 1 || h12 > 12 || mi > 59) return null;
  const h = (h12 % 12) + (m[5].toLowerCase() === "pm" ? 12 : 0); // 12am is 0, 12pm is 12
  const year = new Date(nowSec * 1000).getUTCFullYear();
  try {
    // The year first, by the wall time read as UTC (within hours of the truth), then the instant in that year alone:
    // a wall time skipped this year must not borrow another year's.
    const y = [year - 1, year, year + 1].filter((x) => d <= new Date(Date.UTC(x, mo + 1, 0)).getUTCDate())
      .sort((a, b) => Math.abs(Date.UTC(a, mo, d, h, mi) / 1000 - nowSec) - Math.abs(Date.UTC(b, mo, d, h, mi) / 1000 - nowSec))[0];
    const at = y == null ? null : wallTimes(y, mo, d, h, mi, m[6]).at(-1);
    // The text shows minutes only, and "3:59pm" may mean any second of that minute: the reset is taken as the minute's
    // END (+59 s), so a full window is never rolled over up to a minute early, headroom invented (from the final review).
    const end = at == null ? null : at / 1000 + 59;
    return end != null && Math.abs(end - nowSec) <= maxSec ? end : null;
  } catch { return null; } // a zone Intl does not know
}

// The text of Claude's `/usage` → the windows routr ranks on, and a note. Pure, so the measured text is a test.
export function parseClaudeUsage(text, nowSec = now()) {
  const windows = [], scoped = [], unread = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = line.trim().match(/^Current (session|week \(([^)]*)\))\s*:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+))?$/i);
    if (!m) continue;
    const used = Number(m[3]), key = m[1].toLowerCase(), known = CLAUDE_LINES[key];
    if (!known) { scoped.push(used); continue; } // a weekly limit for one model: counted, never named
    const resetsAt = m[4] ? parseClaudeReset(m[4], nowSec, known.windowMin * 60 + 86400) : null;
    if (m[4] && resetsAt == null) unread.push(known.name);
    windows.push({ name: known.name, usedPct: Math.min(100, used), windowMin: known.windowMin, resetsAt });
  }
  const note = [
    scoped.length && `plus ${scoped.length} model-specific weekly limit${scoped.length === 1 ? "" : "s"} (highest ${Math.max(...scoped)}% used), not ranked on`,
    unread.length && `reset time not read for ${unread.join(", ")}: that window is not rolled over at its reset`,
  ].filter(Boolean).join("; ");
  return { windows, note: note || undefined };
}

// How routr reads Claude's usage. The statusline snapshot costs nothing and is written on every Claude turn, so a
// recent one is used as it is. Five minutes is a judgment, not a measurement: a working session renders far more
// often than that, and a weekly window does not move much in five minutes. Otherwise Claude's own `/usage` is read in
// the call, through its CLI, as Codex and Antigravity are: routr never needs to own Claude's single statusline slot.
export const CLAUDE_FRESH_SEC = 5 * 60;
// Measured 2026-10-05 (2.1.289, macOS, load average 9 to 14 from other agents): 4.4 to 5.2 s wall with the user's
// hooks and MCP servers off (5 reads), 6.8 to 8.8 s with them on (Claude reports ~2 s of that as its own). No hang in
// 18 reads, unlike agy's one in six, so one try, with room for a slower machine; a hang costs this once, and the call
// carries on with the fallback.
const CLAUDE_TIMEOUT_MS = 12000;
// `quiet`: the registry's arguments that keep the user's hooks and MCP servers out of routr's read (harnesses.mjs).
// `--no-session-persistence` leaves no session file. It runs in a private folder of its own under the system temp
// folder, never the user's project (as Kiro's /usage runs in the temp folder).
export const claudeUsageArgs = (quiet = []) => ["-p", "/usage", "--output-format", "json", "--no-session-persistence", ...quiet];
const readJson = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; } catch { return null; } };

// Claude still makes `~/.claude/projects/<folder>/memory`, empty, for the folder it ran in (measured 2.1.289: the
// folder is the path with every character but a letter or digit turned into `-`, macOS's /var resolved to
// /private/var). So each read runs in a folder routr has just made (`routr-claude-XXXXXX` under the temp folder):
// the project folder Claude names after it belongs to this read alone, not inferred from "absent before". It is
// removed only after Claude exited normally (after a timeout routr's kill may land before Claude's last write), only
// as real folders (a symlink or, on Windows, a junction, which lstat reports as a symlink, is never followed), and
// only with rmdir, so a folder that is not empty stays, and only while the private folder is still the one routr made.
// The naming is Claude's own: a folder named otherwise is simply not found, and any surprise leaves things as they are.
const claudeProjectsDir = () => join(home(), ".claude/projects");
export const claudeProjectFolders = (cwd, projects = claudeProjectsDir()) => {
  let real = cwd; try { real = realpathSync(cwd); } catch {}
  return [...new Set([cwd, real].map((x) => join(projects, x.replace(/[^A-Za-z0-9]/g, "-"))))];
};
// rmdir a real, empty folder; anything else (missing, a link, a file, not empty) is left, and says false.
const removeEmpty = (dir) => { try { const st = lstatSync(dir); if (st.isSymbolicLink() || !st.isDirectory() || readdirSync(dir).length) return false; rmdirSync(dir); return true; } catch { return false; } };
function removeProjectFolder(folder) {
  try { if (lstatSync(folder).isSymbolicLink()) return; } catch { return; }
  removeEmpty(join(folder, "memory"));
  removeEmpty(folder);
}

// Seams: `file` the statusline snapshot, `nowSec` the clock, `exec` runtime's run, `tmp` the folder that holds
// each read's private folder, `projects` Claude's projects folder. It is only called once readUsage's sign-in gate says Claude is signed in. That
// answer is kept up to 6 hours (signin.mjs, as for every harness), so one read may follow a sign-out; Claude's `-p`
// does not open a browser sign-in.
export async function readClaude({ quiet = [], file = CLAUDE_SNAPSHOT, nowSec = now(), exec = run, tmp = tmpdir(), projects = claudeProjectsDir() } = {}) {
  const snap = readJson(file);
  const fromSnap = snap ? claudeSnapshot(snap, nowSec) : null;
  // A snapshot from the future (a clock set back) is not fresh: its age says nothing.
  const age = fromSnap?.ageSec;
  if (fromSnap?.headroom != null && Number.isFinite(age) && age >= 0 && age < CLAUDE_FRESH_SEC) return fromSnap;
  // The private folder, its identity, and the folders to clean, all fixed BEFORE Claude runs: nothing done after the
  // read is worked out from a path someone could have swapped for a link meanwhile. No private folder, no read:
  // Claude in the shared temp folder would leave a project folder routr could not call its own.
  let priv = null;
  try {
    const cwd = mkdtempSync(join(tmp, "routr-claude-")), st = lstatSync(cwd);
    priv = { cwd, dev: st.dev, ino: st.ino, targets: claudeProjectFolders(cwd, projects) };
  } catch {}
  // Still the folder routr made: a real folder, the same device and inode as when it was made.
  const same = () => { try { const st = lstatSync(priv.cwd); return !st.isSymbolicLink() && st.isDirectory() && st.dev === priv.dev && st.ino === priv.ino; } catch { return false; } };
  let why, answered = false, out = null;
  if (!priv) why = "routr could not make a private folder in the temp folder to run `claude -p /usage` in, so Claude was not asked";
  else {
    try { out = await exec("claude", claudeUsageArgs(quiet), { cwd: priv.cwd, timeoutMs: CLAUDE_TIMEOUT_MS }); }
    finally {
      // run() answers null on a timeout (it kills Claude and does not wait), an error, or no output: the project
      // folder is then left, as Claude may still be writing it; a timed-out read can leave one empty folder.
      if (same()) { if (out != null) priv.targets.forEach(removeProjectFolder); removeEmpty(priv.cwd); }
    }
  }
  if (priv && out == null) why = `\`claude -p /usage\` did not answer in ${CLAUDE_TIMEOUT_MS / 1000} s`;
  else if (priv) {
    let o = null; try { o = JSON.parse(out); } catch {}
    if (typeof o?.result !== "string" || o.is_error) why = "`claude -p /usage` did not answer as expected";
    else {
      const p = parseClaudeUsage(o.result, nowSec);
      if (p.windows.length) return summarize({ pool: "claude", source: "claude /usage", ts: nowSec, windows: p.windows, note: p.note, nowSec });
      answered = true; why = "Claude's /usage shows no usage windows for this seat";
    }
  }
  // Claude answered and shows no windows: that is this seat's reading now, ahead of any snapshot. An old snapshot from
  // before a switch to an API key or a metered seat would rank the previous subscription's windows, exhausted ones
  // included (from the final review); the snapshot is only for a live read that failed.
  if (answered) return summarize({ pool: "claude", source: "claude /usage", nowSec, reason: NO_WINDOWS_AFTER_ANSWER,
    note: `${why}. A plan with no quota (usage-based Enterprise) shows none: if that is this seat, set \`billing: "metered"\` for claude in the config` });
  // The statusline's reading however old (its age is shown), as before this reader existed; else nothing, and why.
  if (fromSnap?.headroom != null) return { ...fromSnap, note: [fromSnap.note, `${why}: this is the statusline's last reading`].filter(Boolean).join("; ") };
  // A snapshot that says Claude sent no windows after a response keeps saying so: doctor's step keys on it.
  return summarize({ pool: "claude", source: "claude /usage", nowSec, reason: fromSnap?.reason, note: `${why}; using the assumed headroom` });
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
      if (!own) return summarize({ pool: "agy", source: "agy /usage", note: "`agy /usage` lists no Gemini pool; using the assumed headroom" });
      const mins = { weekly: 10080, "5h": 300 };
      const ws = own.buckets.map((b) => ({ name: b.id, usedPct: (1 - b.remaining_fraction) * 100, windowMin: mins[b.window] ?? 0, resetsAt: Date.parse(b.reset_time) / 1000 }));
      return summarize({ pool: "agy", source: "agy /usage", ts: now(), windows: ws, note: `pool: ${own.name}` });
    } catch {}
  }
  return summarize({ pool: "agy", source: "agy /usage", note: "`agy -p /usage` did not answer in two tries; using the assumed headroom" });
}
