// Cursor has no local usage file: it shows usage only in its own /usage screen. This opens that screen in a throwaway
// terminal (terminal.mjs) and reads Included N% used. routr keeps the reading (usage.mjs: refreshCursor).
// The footer context meter (e.g. "Grok 4.6 High · 8.7%") is not usage and must never be parsed as it.
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { deadline, runHerdr, SHELLS, shellFamily, waitForShell } from "./herdr.mjs";
import { CURSOR_SNAPSHOT } from "./runtime.mjs";
import { readSnapshot, refreshSnapshot } from "./snapshot.mjs";
import { openTerminal, shellAlone } from "./terminal.mjs";

const PCT = String.raw`(\d+(?:\.\d+)?)%\s+used\b`;

export function parseCursorUsage(text) {
  if (text == null) return null;
  const t = stripVTControlCharacters(String(text)).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!t.trim()) return null;
  // Category rows say "N% used". The footer meter is "High · 8.7%" with no "used".
  const included = t.match(new RegExp(String.raw`^\s*Included\s+${PCT}`, "m"));
  if (!included) return null;
  const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
  const auto = t.match(new RegExp(String.raw`^\s*Auto\s+${PCT}`, "m"));
  const api = t.match(new RegExp(String.raw`^\s*API\s+${PCT}`, "m"));
  const plan = t.match(/Usage\s*[•·]\s*(\S+)/)?.[1] ?? null;
  return {
    plan,
    included_used_pct: num(included[1]),
    auto_used_pct: auto ? num(auto[1]) : null,
    api_used_pct: api ? num(api[1]) : null,
  };
}

const cursorUiReady = (text) => {
  const t = stripVTControlCharacters(String(text ?? ""));
  // Welcome screen says "Cursor Agent"; a later footer meter is "Grok 4.6 High · 8.7%".
  return /\bCursor Agent\b/.test(t) || /·\s*\d+(?:\.\d+)?%\s*$/m.test(t);
};

// What to do when routr cannot open the screen itself: said with every failed read.
export const CURSOR_BY_HAND = "run `cursor-agent`, type /usage, read \"Included N% used\", and pass --headroom cursor=<1 - N/100>";

// Cursor writes to its config folder as it runs (seen 2026-09-25: it rewrote cli-config.json and added a project
// folder for the working directory), so it runs on a private copy, as `launch` does, removed when the read ends.
export async function cursorUsage({ run = runHerdr, sleep = (ms) => Bun.sleep(ms), now = () => performance.now(),
  tmp = tmpdir(), timeout = 90000, terminal = {}, cursorConfig = join(homedir(), ".cursor", "cli-config.json") } = {}) {
  let t = null, dir = null;
  try {
    const remaining = deadline(timeout, now, "Cursor usage timed out");
    const pause = async () => sleep(Math.min(250, remaining()));
    t = await openTerminal({ run, cwd: tmp, remaining, sleep, ...terminal });
    const ready = await waitForShell(t, { sleep, now, remaining });
    if (!ready.ok) throw new Error(ready.why);
    const shell = shellFamily(ready.name);
    dir = join(tmp, `routr-cursor-${randomBytes(4).toString("hex")}`);
    mkdirSync(dir, { mode: 0o700 });
    try { copyFileSync(cursorConfig, join(dir, "cli-config.json")); chmodSync(join(dir, "cli-config.json"), 0o600); }
    catch { throw new Error(`Cursor has no config at ${cursorConfig}: sign in with \`cursor-agent\` first`); }
    if (SHELLS[shell].cursor) await t.call(["pane", "run", t.pane, SHELLS[shell].cursor(dir, "cursor-agent", ["--trust"])]);
    else { await t.call(["pane", "run", t.pane, SHELLS[shell].cursorEnv(dir)]); await t.call(["pane", "run", t.pane, "cursor-agent --trust"]); }
    const ranAt = now();
    for (;;) {
      if (cursorUiReady(await t.read())) break;
      // A cursor-agent that is missing or exits at once leaves the shell alone: say so now, not at the timeout.
      if (now() - ranAt >= 3000 && await shellAlone(t)) throw new Error("cursor-agent did not start in the login shell (not installed, not on that shell's PATH, or it exited at once)");
      await pause();
    }
    await t.call(["pane", "send-text", t.pane, "/usage"]);
    await t.call(["pane", "send-keys", t.pane, "enter"]);
    const panelAt = now();
    let extraEnter = false, parsed = null;
    for (;;) {
      parsed = parseCursorUsage(await t.read());
      if (parsed?.included_used_pct != null) break;
      if (!extraEnter && now() - panelAt >= 6000) {
        await t.call(["pane", "send-keys", t.pane, "enter"]);
        extraEnter = true;
      } else if (extraEnter && now() - panelAt >= 12000) {
        throw new Error("Cursor /usage panel did not appear");
      }
      await pause();
    }
    const included = parsed.included_used_pct;
    const headroom = Math.round((1 - included / 100) * 100) / 100;
    return { ok: true, subscription: "cursor", plan: parsed.plan, included_used_pct: included,
      auto_used_pct: parsed.auto_used_pct, api_used_pct: parsed.api_used_pct, headroom };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200), read_yourself: CURSOR_BY_HAND };
  } finally {
    await t?.close(); // stopping the session ends Cursor with it
    if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Cursor: only Included counts: it is the whole plan, and Cursor's own models (Composer, Grok) draw on it through Auto.
// API is other vendors' models inside Cursor, which routr does not route to, so it is shown in the note and never ranked.
const pct = (x) => (x == null ? "?" : `${x}%`);
export const refreshCursor = ({ read = cursorUsage, file = CURSOR_SNAPSHOT, ...o } = {}) => refreshSnapshot({ read, file, ...o,
  keep: (r) => ({ plan: r.plan, included_used_pct: r.included_used_pct, auto_used_pct: r.auto_used_pct, api_used_pct: r.api_used_pct }) });
export const readCursor = ({ file = CURSOR_SNAPSHOT, ...o } = {}) => readSnapshot({ name: "cursor", source: "cursor /usage", byHand: CURSOR_BY_HAND, file, ...o,
  windows: (r) => [{ name: "included", usedPct: r.included_used_pct, windowMin: null, resetsAt: null }],
  describe: (r) => `Included ${pct(r.included_used_pct)} used (Auto ${pct(r.auto_used_pct)}, API ${pct(r.api_used_pct)})` });
