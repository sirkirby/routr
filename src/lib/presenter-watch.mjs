// A headless worker's progress shown in herdr-core: a terminal beside it that runs `routr watch`. This only presents: the
// holder owns the worker, the terminal only shows it, so losing the terminal loses nothing, and failing to start one
// never fails the worker.
import { warning } from "./warnings.mjs";
import { runNext } from "./next.mjs";
import { callHc, client, renameTab } from "./hc.mjs";
import { selfCommand } from "./runtime.mjs";

// A pane wins: herdr's own session is what the lead is in when both are set (the TUI started from a core terminal).
export const inCore = (env) => env.HERDR_ENV !== "1" && Boolean(env.HC_TERMINAL_ID);

// hc's names are unique among live terminals, at most 32 of the characters a worker's name uses, and the app's pop-ups
// say them, so a worker's own name comes first. One hc refuses gets one more try with the worker's id: a name used again
// before the last worker's terminal has gone needs that, and a refusal for any other reason refuses again.
const withId = (name, id) => `${name.slice(0, 23)}-${id.slice(0, 8)}`;

// A terminal for this worker, in its own tab of the lead's space when the lead is in the app. Off the app (no space
// label) it is still a terminal, listed by `hc ls`. It outlives the lead, as the holder does, types nothing into the
// lead, and goes when it exits: `routr watch` exits once the worker is cleaned up.
// Answers `{ terminal, tab }`, or `{ code }` with one of callHc's codes and nothing started.
export async function showWorker({ name, id, cwd, env, run = client, self = selfCommand, pause = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const me = await callHc(["get", env.HC_TERMINAL_ID, "--json"], run);
  if (!me.ok) return { code: me.code };
  const space = me.data?.labels?.["herdr.space"];
  const argv = self(["watch", "--name", name]);
  if (!argv) return { code: "not_available" };
  const tab = typeof space === "string" && space ? `routr-${id}` : null;
  const open = (terminal) => callHc(["run", "--bg", "--json", "--name", terminal, "--cwd", cwd, "--outlive-parent", "--no-notify", "--rm",
    ...(tab ? ["--label", `herdr.space=${space}`, "--label", `herdr.tab=${tab}`] : []), "--", ...argv], run);
  let r = await open(name);
  if (r.code === "refused") r = await open(withId(name, id));
  if (!r.ok) return { code: r.code };
  if (typeof r.data?.address !== "string") return { code: "unreadable" };
  // The app numbers a tab it did not make. It takes a moment to adopt the terminal; a name that never lands costs only
  // the name, and with no app running there is nothing to name.
  if (tab) for (let i = 0; i < 6; i++) { if (await renameTab(tab, name, run)) break; await pause(300); }
  return { terminal: r.data.address, tab };
}

// Shown beside the worker, never instead of it: the worker has started either way. Says what it did in `out`, launch's answer.
export async function presentWorker({ name, id, cwd, env, out }) {
  const step = (s, ok, detail) => out.steps.push({ step: s, ok, detail });
  const shown = await showWorker({ name, id, cwd, env }).catch(() => ({ code: "not_available" }));
  if (shown.terminal) { out.worker.terminal = shown.terminal; step("terminal", true, shown.tab ? `${name}'s progress is in a tab of its own (${shown.terminal})` : `${name}'s progress is in terminal ${shown.terminal}`); }
  else {
    out.warnings.push(warning("worker_not_shown", `The worker is running, but herdr-core did not start a terminal to show it (${shown.code})`));
    out.next.push(runNext("To see its progress, run this in a terminal of your own.", ["routr", "watch", "--name", name]));
  }
}
