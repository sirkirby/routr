// Cursor has no local usage file: it shows usage only in its own /usage screen. This opens that screen in a throwaway
// terminal (terminal.mjs), reads Included N% used, and prints headroom for `routr dispatch --headroom cursor=…`.
// The footer context meter (e.g. "Grok 4.6 High · 8.7%") is not usage and must never be parsed as it.
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { runHerdr } from "./launch.mjs";
import { openTerminal, readScreen, waitForShell } from "./terminal.mjs";

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

// What to do when routr cannot open the screen itself. Said on every failure, and by doctor and dispatch.
export const CURSOR_BY_HAND = "run `cursor-agent`, type /usage, read \"Included N% used\", and pass --headroom cursor=<1 - N/100>";

export async function cursorUsage({ run = runHerdr, sleep = (ms) => Bun.sleep(ms), now = () => performance.now(),
  tmp = tmpdir(), timeout = 90000, terminal = {} } = {}) {
  let t = null;
  try {
    const began = now();
    const remaining = () => {
      const ms = Math.floor(timeout - (now() - began));
      if (!Number.isFinite(ms) || ms <= 0) throw new Error("Cursor usage timed out");
      return ms;
    };
    const pause = async () => sleep(Math.min(250, remaining()));
    t = await openTerminal({ run, cwd: tmp, remaining, sleep, ...terminal });
    await waitForShell(t, { sleep, now, remaining });
    await t.call(["pane", "run", t.pane, "cursor-agent --trust"]);
    for (;;) {
      if (cursorUiReady(await readScreen(t))) break;
      await pause();
    }
    await t.call(["pane", "send-text", t.pane, "/usage"]);
    await t.call(["pane", "send-keys", t.pane, "enter"]);
    const panelAt = now();
    let extraEnter = false, parsed = null;
    for (;;) {
      parsed = parseCursorUsage(await readScreen(t));
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
      auto_used_pct: parsed.auto_used_pct, api_used_pct: parsed.api_used_pct, headroom,
      pass_as: `--headroom cursor=${headroom}` };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200), read_yourself: CURSOR_BY_HAND };
  } finally {
    await t?.close(); // stopping the session ends Cursor with it
  }
}
