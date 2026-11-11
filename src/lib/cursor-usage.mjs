// Cursor has no local usage file: it shows usage only in its own /usage screen. This opens that screen in a throwaway
// terminal (terminal.mjs: routr's own on macOS and Linux, a private herdr session on Windows) and reads Included N% used.
// routr keeps the reading and refreshes it in the background (usage-readings.mjs); cursorReading, below, is what it keeps.
// The footer context meter (e.g. "Grok 4.6 High · 8.7%") is not usage and must never be parsed as it.
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { cmdTypable, deadline, runHerdr, SHELLS, shellAlone, shellFamily, waitForShell } from "./herdr.mjs";
import { openTerminal, ownTerminal } from "./terminal.mjs";
import { usageFailure } from "./usage-failure.mjs";
import { configEnv, HARNESSES, privateConfigCopy } from "./harnesses.mjs";

const cursorPlan = (p) => ["Free", "Pro", "Pro+", "Ultra", "Team", "Business", "Enterprise"].includes(p) ? p : null;

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
    plan: cursorPlan(plan),
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
export const CURSOR_BY_HAND = HARNESSES.cursor.usage.byHand;

// Cursor writes to its config folder as it runs (its `privateConfig`), so the read runs on a private copy, as `launch`
// does, removed when the read ends. `cursorConfig`: the file copied, when not Cursor's own.
const privateConfig = (tmp, cursorConfig) => privateConfigCopy("cursor", join(tmp, `routr-cursor-${randomBytes(4).toString("hex")}`), { from: cursorConfig });
const { variable } = HARNESSES.cursor.privateConfig;
// Windows: the private herdr session, with Cursor started by typing into its shell. Ends as a terminal the read can
// drive either way; `made` hears of what it made, so the caller removes it whatever fails.
async function cursorInHerdr({ run, tmp, remaining, sleep, now, terminal, cursorConfig, made, failed }) {
  const t = await openTerminal({ run, cwd: tmp, remaining, sleep, ...terminal });
  made.t = t;
  const ready = await waitForShell(t, { sleep, now, remaining });
  if (!ready.ok) throw new Error(ready.why);
  const shell = shellFamily(ready.name);
  if (shell === "cmd" && !cmdTypable(join(tmp, "routr-cursor-00000000"))) { failed("cmd_path"); throw new Error(); } // before anything is typed
  const dir = made.dir = privateConfig(tmp, cursorConfig);
  if (SHELLS[shell].privateStart) await t.call(["pane", "run", t.pane, SHELLS[shell].privateStart(variable, dir, "cursor-agent", ["--trust"])]);
  else { await t.call(["pane", "run", t.pane, SHELLS[shell].privateEnv(variable, dir)]); await t.call(["pane", "run", t.pane, "cursor-agent --trust"]); }
  return { ...t, type: (s) => t.call(["pane", "send-text", t.pane, s]), enter: () => t.call(["pane", "send-keys", t.pane, "enter"]), gone: () => shellAlone(t) };
}

export async function cursorUsage({ run = runHerdr, sleep = (ms) => Bun.sleep(ms), now = () => performance.now(),
  tmp = tmpdir(), timeout = 90000, terminal = {}, cursorConfig,
  platform = process.platform, open = ownTerminal } = {}) {
  const made = { t: null, dir: null };
  let code = "read_failed";
  try {
    const remaining = deadline(timeout, now, "Cursor usage timed out");
    const pause = async () => sleep(Math.min(250, remaining()));
    let t;
    if (platform === "win32") t = await cursorInHerdr({ run, tmp, remaining, sleep, now, terminal, cursorConfig, made, failed: (c) => { code = c; } });
    else {
      made.dir = privateConfig(tmp, cursorConfig);
      // A cursor-agent that cannot start says so now.
      code = "no_response";
      t = made.t = open("cursor-agent", ["--trust"], { cwd: tmp, extraEnv: configEnv("cursor", made.dir) });
      code = "read_failed";
    }
    const ranAt = now();
    for (;;) {
      if (cursorUiReady(await t.read())) break;
      // A cursor-agent that is missing or exits at once leaves the shell alone: say so now, not at the timeout.
      if (now() - ranAt >= 3000 && await t.gone()) { code = "no_response"; throw new Error(); }
      await pause();
    }
    if (t.settleMs) await sleep(Math.min(t.settleMs, remaining()));
    await t.type("/usage");
    if (t.settleMs) await sleep(Math.min(200, remaining()));
    await t.enter();
    const panelAt = now();
    let extraEnter = false, parsed = null;
    for (;;) {
      parsed = parseCursorUsage(await t.read());
      if (parsed?.included_used_pct != null) break;
      if (!extraEnter && now() - panelAt >= 6000) {
        await t.enter();
        extraEnter = true;
      } else if (extraEnter && now() - panelAt >= 12000) {
        code = "invalid_response"; throw new Error();
      }
      await pause();
    }
    const included = parsed.included_used_pct;
    const headroom = Math.round((1 - included / 100) * 100) / 100;
    return { ok: true, subscription: "cursor", plan: parsed.plan, included_used_pct: included,
      auto_used_pct: parsed.auto_used_pct, api_used_pct: parsed.api_used_pct, headroom };
  } catch {
    return { ok: false, ...usageFailure(code), read_yourself: CURSOR_BY_HAND };
  } finally {
    await made.t?.close(); // stopping the session ends Cursor with it
    if (made.dir) try { rmSync(made.dir, { recursive: true, force: true }); } catch {}
  }
}

// Cursor: only Included counts: it is the whole plan, and Cursor's own models (Composer, Grok) draw on it through Auto.
// API is other vendors' models inside Cursor, which routr does not route to, so it is shown in the note and never ranked.
// `at` is when it was read (seconds); the plan has no reset time on Cursor's screen, so the window has none.
const pct = (x) => (x == null ? "?" : `${x}%`);
const number = (x) => Number.isFinite(x) ? x : null;
export const cursorReading = (raw, at) => {
  const r = { included_used_pct: number(raw.included_used_pct), auto_used_pct: number(raw.auto_used_pct), api_used_pct: number(raw.api_used_pct) };
  return { source: "cursor /usage", takenAt: at, windows: [{ name: "included", usedPct: r.included_used_pct, windowMin: null, resetsAt: null }],
    note: `Included ${pct(r.included_used_pct)} used (Auto ${pct(r.auto_used_pct)}, API ${pct(r.api_used_pct)})` };
};
