// A headless worker's progress shown in herdr-core: a terminal beside it that runs `routr watch`. This only presents: the
// holder owns the worker, the terminal only shows it, so losing the terminal loses nothing, and failing to start one
// never fails the worker. A terminal worker has no use for it: its own screen is the tab (backend-terminal.mjs).
import { warning } from "./warnings.mjs";
import { runNext } from "./next.mjs";
import { client } from "./hc.mjs";
import { leadTerminal, openTerminal } from "./core-tab.mjs";
import { selfCommand } from "./runtime.mjs";

// A pane wins: herdr's own session is what the lead is in when both are set (the TUI started from a core terminal).
export const inCore = (env) => env.HERDR_ENV !== "1" && Boolean(env.HC_TERMINAL_ID);

// A terminal for this worker: it goes when it exits, and `routr watch` exits once the worker is cleaned up.
// Answers `{ terminal, tab }`, or `{ code }` with one of callHc's codes and nothing started.
export async function showWorker({ name, id, cwd, env, run = client, self = selfCommand, pause = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const lead = await leadTerminal(env, run);
  if (lead.code) return { code: lead.code };
  const argv = self(["watch", "--name", name]);
  if (!argv) return { code: "not_available" };
  const r = await openTerminal({ name, id, cwd, lead, argv, rm: true, run, pause });
  return r.code ? { code: r.code } : { terminal: r.terminal, tab: r.tab };
}

// Shown beside the worker, never instead of it: the worker has started either way. Says what it did in `out`, launch's answer.
export async function presentWorker({ name, id, cwd, env, out, ...seams }) {
  const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail });
  const shown = await showWorker({ name, id, cwd, env, ...seams }).catch(() => ({ code: "not_available" }));
  if (shown.terminal) { out.worker.terminal = shown.terminal; step("terminal", true, shown.tab ? `${name}'s progress is in a tab of its own (${shown.terminal})` : `${name}'s progress is in terminal ${shown.terminal}`); }
  else {
    out.warnings.push(warning("worker_not_shown", `The worker is running, but herdr-core did not start a terminal to show it (${shown.code})`));
    out.next.push(runNext("To see its progress, run this in a terminal of your own.", ["routr", "watch", "--name", name]));
  }
}
