// Live usage per subscription, read passively from what each harness already writes locally. Read-only.
// headroom = remaining share of the TIGHTEST window (0..1). No pace or burn modelling: the router decides on what is left.
// Every pool is a list of windows plus a CLASS: `included` (windows that expire: a subscription), `capped` (a spend cap
// the vendor enforces, read as one more window), `metered` (billed usage with no quota, and a working source says so),
// or `unknown` (nothing readable). Measured 2026-09-22 on a ChatGPT Enterprise seat: no windows at all, only
// `credits.unlimited: true`, and a plan name of `business`. So the shape is the key, never the plan name.
import { CURSOR_BY_HAND, cursorUsage } from "./cursor-usage.mjs";
import { CLAUDE_SNAPSHOT } from "./runtime.mjs";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
export function run(cmd, args, { input, timeoutMs = 8000, until } = {}) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(v); };
    let child;
    try { child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] }); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.stdout.on("data", (d) => { out += d; if (until?.(out)) finish(out); });
    child.on("close", () => finish(out || null));
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

// How each subscription's usage is read, in one place, so doctor, dispatch, `routr usage`, and every error say the same.
//   read         passive: a file or a command the harness answers without a turn. Read on every call.
//   interactive  the harness shows usage only in its own screen: `routr usage <name>` opens it in a throwaway terminal
//                (terminal.mjs) and prints the --headroom value. Advice never does this: it drives no terminal.
//   by_hand      what a person or agent does when routr cannot open that screen.
// A harness added later picks its row; nothing else changes.
export const SOURCES = {
  claude: { read: readClaude },
  codex: { read: readCodexLive },
  agy: { read: readAgy },
  cursor: { interactive: cursorUsage, command: "routr usage cursor", by_hand: CURSOR_BY_HAND },
};

// One unreadable source must not take the others (or the routing advice) down with it. Readers run in parallel.
// `given` holds headroom the caller read itself (0..1), e.g. Cursor's, from `routr usage cursor`.
export async function readUsage(names, given = {}) {
  return Promise.all(names.map(async (name) => {
    if (typeof given[name] === "number") return { pool: name, source: "given by caller", ageSec: 0, windows: [], headroom: Math.min(1, Math.max(0, given[name])) };
    const src = SOURCES[name];
    if (src?.interactive) return { ...summarize(name, "its own screen", null, [], `${name} shows usage only in its own screen, so it is not read here: \`${src.command}\` reads it and prints the --headroom value to pass`), read_with: src.command };
    if (!src?.read) return summarize(name, "none", null, [], "no usage source: read it yourself and pass --headroom " + name + "=<0..1>");
    try { return await src.read(); } catch (e) { return summarize(name, "unreadable", null, [], `usage unreadable: ${String(e?.message ?? e).slice(0, 80)}`); }
  }));
}
