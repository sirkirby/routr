// herdr-core (`hc`), the terminal runtime under the Herdr app: everything routr asks of it. Its terminals set
// HC_TERMINAL_ID and not HERDR_ENV; the app shows a terminal only with the labels herdr.space and herdr.tab (routr-lab
// p50, hc 0.1.17, 2026-11-03). A worker there is a headless worker with a terminal beside it that runs `routr watch`:
// the holder owns the worker, the terminal only shows it, so losing the terminal loses nothing.
import { selfCommand, start, stop } from "./runtime.mjs";

// A pane wins: herdr's own session is what the lead is in when both are set (the TUI started from a core terminal).
export const inCore = (env) => env.HERDR_ENV !== "1" && Boolean(env.HC_TERMINAL_ID);

// routr's own calls keep the environment, as a herdr client's do: hc finds its core and its caller there. Resolves
// `{ out, code }`, or null when it could not start or did not answer in time; never throws.
const client = (cmd, args, ms) => new Promise((done) => {
  let child, out = "", finished = false, exited = false;
  const finish = (v) => { if (finished) return; finished = true; clearTimeout(timer); if (!exited && child) stop(child); done(v); };
  const timer = setTimeout(() => finish(null), ms);
  try { child = start(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }); } catch { return finish(null); }
  child.on("error", () => finish(null));
  child.on("exit", () => { exited = true; });
  child.stdout.on("data", (d) => { out += d; });
  child.on("close", (code) => finish({ out, code }));
});
// hc answers JSON when piped.
const callHc = async (args, run) => {
  const r = await run("hc", args, 10000);
  if (r == null) return { ok: false, code: "not_available" };
  if (r.code !== 0) return { ok: false, code: "refused" };
  try { return { ok: true, data: JSON.parse(r.out) }; } catch { return { ok: false, code: "unreadable" }; }
};

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
  if (tab) for (let i = 0; i < 6; i++) { if ((await run("herdr-app", ["do", "tab.rename", "--id", tab, "--name", name], 3000))?.code === 0) break; await pause(300); }
  return { terminal: r.data.address, tab };
}
