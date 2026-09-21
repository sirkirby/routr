// Cursor has no local usage file. This opens /usage in a throwaway pane, reads Included N% used, and
// prints headroom for `routr dispatch --headroom cursor=…`. The footer context meter (e.g. "Grok 4.6 High · 8.7%")
// is not usage and must never be parsed as it.
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { paneText, promptSettled, runHerdr, shellPrompt } from "./launch.mjs";

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

export async function cursorUsage(args, { run = runHerdr, sleep = (ms) => Bun.sleep(ms), now = () => performance.now(),
  env = process.env, tmp = tmpdir(), timeout = 90000 } = {}) {
  if (env.HERDR_ENV !== "1") return { ok: false, error: "Cursor usage requires HERDR_ENV=1 inside a Herdr pane" };
  if (args.length !== 1 || args[0] !== "cursor") return { ok: false, error: "usage: routr usage cursor" };
  let pane = null;
  try {
    const began = now();
    const remaining = () => {
      const ms = Math.floor(timeout - (now() - began));
      if (!Number.isFinite(ms) || ms <= 0) throw new Error("Cursor usage timed out");
      return ms;
    };
    const call = async (a) => {
      const r = await run(a, remaining());
      if (!r.ok) throw new Error(r.data?.error?.message ?? JSON.stringify(r.data));
      return r;
    };
    const readPane = async () => paneText((await call(["pane", "read", pane, "--source", "visible"])).data);
    const pause = async () => sleep(Math.min(250, remaining()));
    const split = await call(["pane", "split", "--current", "--direction", "down", "--cwd", tmp, "--no-focus"]);
    pane = split.data?.result?.pane?.pane_id;
    if (typeof pane !== "string" || !pane) { pane = null; throw new Error("Herdr split returned no pane id"); }
    let answers = 0, answered = false, answeredAt = null, previous = null;
    for (;;) {
      const text = await readPane();
      const info = (await call(["pane", "process-info", "--pane", pane])).data.result.process_info;
      const processes = info.foreground_processes ?? [];
      const shell = processes.find((p) => p.pid === info.shell_pid);
      if (processes.some((p) => p.pid !== info.shell_pid) || !shell) { previous = null; await pause(); continue; }
      const state = shellPrompt(text);
      if (state === "dotenv") {
        if (!answered) {
          if (++answers > 3) throw new Error("Shell repeated the dotenv question");
          await call(["pane", "send-keys", pane, "n", "enter"]);
          answered = true; answeredAt = now();
        }
        if (now() - answeredAt >= 5000) throw new Error("Shell did not clear the dotenv question after answering");
      } else {
        answered = false;
        if (state === "question") throw new Error("Unrecognized shell question");
        if (state === "ready" && promptSettled(text, previous)) break;
      }
      previous = text;
      await pause();
    }
    await call(["pane", "run", pane, "cursor-agent --trust"]);
    for (;;) {
      if (cursorUiReady(await readPane())) break;
      await pause();
    }
    await call(["pane", "send-text", pane, "/usage"]);
    await call(["pane", "send-keys", pane, "enter"]);
    const panelAt = now();
    let extraEnter = false, parsed = null;
    for (;;) {
      parsed = parseCursorUsage(await readPane());
      if (parsed?.included_used_pct != null) break;
      if (!extraEnter && now() - panelAt >= 6000) {
        await call(["pane", "send-keys", pane, "enter"]);
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
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  } finally {
    if (pane) {
      try { await run(["pane", "send-keys", pane, "esc"], 2000); } catch {}
      try { await run(["pane", "close", pane], 2000); } catch {}
    }
  }
}
