import { expect } from "bun:test";
import { HARNESSES } from "../../src/lib/harnesses.mjs";
import { herdrOK, scratch, shellInfo } from "../helpers.mjs";
const trust = "Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder";
const T = Date.UTC(2026, 10, 3, 15) / 1000;
const ready = "❯ \n? for shortcuts";
const hit = "Settings Status Config Usage Stats\nUsage credits\n██ 100% used\n$15.05 / $15.00 spent · Resets Dec 1 (America/Detroit)\nEsc to cancel";
export function fakePanel(first = trust, panel = hit, { menu = "❯ /usage Show session cost, plan usage, and activity stats", running = true } = {}) {
  let ticks = 0, stage = "shell";
  const calls = [], cwd = scratch("claude-panel-empty");
  return { calls, elapsed: () => ticks, options: { cwd, quiet: HARNESSES.claude.quiet, nowSec: T, now: () => ticks, sleep: async (ms) => { ticks += ms; }, terminal: { start: () => {} },
    run: async (all) => {
      calls.push(all); const a = all[0] === "--session" ? all.slice(2) : all;
      if (a[0] === "session") return { ok: true, data: { sessions: [] } };
      if (a[1] === "list") return herdrOK({ workspaces: [] });
      if (a[1] === "create") return herdrOK({ root_pane: { pane_id: "w:p" } });
      if (a[1] === "process-info") return shellInfo(stage === "shell" || !running ? [{ pid: 1, cwd }] : [{ pid: 1, cwd }, { pid: 2 }]);
      if (a[1] === "read") return herdrOK({ text: stage === "shell" ? "chris % " : stage === "first" ? first : stage === "ready" ? ready : stage === "menu" ? menu : typeof panel === "function" ? panel(ticks) : panel });
      if (a[1] === "run") { expect(a[3]).not.toContain("disableAllHooks"); expect(a[3]).toMatch(/[a-f0-9]{64}\.json/); expect(a[3]).toContain("--strict-mcp-config"); stage = "first"; }
      if (a[1] === "send-keys" && a[3] === "down" && stage === "first") first = first.replace("❯ No, exit", "  No, exit").replace("  Yes, I trust", "❯ Yes, I trust");
      if (a[1] === "send-keys" && a.slice(3).includes("enter")) { if (stage === "first") stage = "ready"; else if (stage === "menu") stage = "panel"; }
      if (a[1] === "send-text") { expect(a[3]).toBe("/usage"); stage = "menu"; }
      return herdrOK({});
    } } };
}
