// Live usage per subscription, read passively from what each harness already writes locally. Read-only.
// headroom = remaining share of the TIGHTEST window (0..1). No pace or burn modelling: the router decides on what is left.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_SNAPSHOT = join(homedir(), ".cache/routr/claude-usage.json"); // written by the usage statusline
export const CODEX_SESSIONS = join(homedir(), ".codex/sessions");
const now = () => Date.now() / 1000;

function summarize(pool, source, ts, windows, note) {
  windows = windows.filter((w) => Number.isFinite(w.usedPct)); // a window without a number must not turn headroom into NaN
  if (!windows.length) return { pool, source, ageSec: null, windows, headroom: null, note: note ?? "no usage data" };
  // A window whose reset time has passed since the snapshot has rolled over: treat as empty.
  const live = windows.map((w) => (w.resetsAt && w.resetsAt < now() ? { ...w, usedPct: 0 } : w));
  const headroom = Math.min(...live.map((w) => Math.max(0, 1 - w.usedPct / 100)));
  return { pool, source, ageSec: ts ? Math.round(now() - ts) : null, windows: live, headroom, note };
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
      if (!rl?.primary) continue;
      const ws = ["primary", "secondary"].filter((k) => rl[k]).map((k) => ({ name: k, usedPct: rl[k].used_percent, windowMin: rl[k].window_minutes, resetsAt: rl[k].resets_at }));
      return summarize("codex", "session log", Date.parse(o.timestamp) / 1000, ws, rl.rate_limit_reached_type ? `limit reached: ${rl.rate_limit_reached_type}` : undefined);
    } catch {}
  }
  return summarize("codex", "session log", null, []);
}

export function readClaude() {
  if (!existsSync(CLAUDE_SNAPSHOT)) return summarize("claude", "statusline", null, [], "no snapshot: the usage statusline is not installed, or no Claude Code session has run since");
  const s = JSON.parse(readFileSync(CLAUDE_SNAPSHOT, "utf8"));
  const mins = { five_hour: 300, seven_day: 10080 };
  const ws = Object.entries(s.rate_limits).filter(([k, v]) => mins[k] && v?.used_percentage != null)
    .map(([k, v]) => ({ name: k, usedPct: v.used_percentage, windowMin: mins[k], resetsAt: v.resets_at }));
  return summarize("claude", "statusline", s.ts, ws);
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
      const ws = ["primary", "secondary"].filter((k) => rl[k]).map((k) => ({ name: k, usedPct: rl[k].usedPercent, windowMin: rl[k].windowDurationMins, resetsAt: rl[k].resetsAt }));
      return summarize("codex", "app-server", now(), ws, rl.rateLimitReachedType ? `limit reached: ${rl.rateLimitReachedType}` : undefined);
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

const READERS = { claude: readClaude, codex: readCodexLive, agy: readAgy };

// One unreadable source must not take the others (or the routing advice) down with it. Readers run in parallel.
// `given` holds headroom the caller read itself (0..1), e.g. Cursor's, which only its interactive /usage panel shows.
export async function readUsage(names, given = {}) {
  return Promise.all(names.map(async (name) => {
    if (typeof given[name] === "number") return { pool: name, source: "given by caller", ageSec: 0, windows: [], headroom: Math.min(1, Math.max(0, given[name])) };
    if (!READERS[name]) return summarize(name, "none", null, [], "no local usage source: read it yourself and pass --headroom " + name + "=<0..1>");
    try { return await READERS[name](); } catch (e) { return summarize(name, "unreadable", null, [], `usage unreadable: ${String(e?.message ?? e).slice(0, 80)}`); }
  }));
}
