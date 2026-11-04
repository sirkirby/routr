// herdr-core (`hc`), the terminal runtime under the Herdr app, and the app's own `herdr-app`: every call routr makes to
// them, what comes back as JSON, and the fixed codes a failure is said in. Its terminals set HC_TERMINAL_ID and not
// HERDR_ENV; the app shows a terminal only with the labels herdr.space and herdr.tab (routr-lab p50, hc 0.1.17, 2026-11-03).
import { start, stop } from "./runtime.mjs";

// routr's own calls keep the environment, as a herdr client's do: hc finds its core and its caller there. Resolves
// `{ out, code }`, or null when it could not start or did not answer in time; never throws.
export const client = (cmd, args, ms) => new Promise((done) => {
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
export const callHc = async (args, run) => {
  const r = await run("hc", args, 10000);
  if (r == null) return { ok: false, code: "not_available" };
  if (r.code !== 0) return { ok: false, code: "refused" };
  try { return { ok: true, data: JSON.parse(r.out) }; } catch { return { ok: false, code: "unreadable" }; }
};

// The app numbers a tab it did not make; this gives it a name. True once the app has taken it.
export const renameTab = async (tab, name, run) => (await run("herdr-app", ["do", "tab.rename", "--id", tab, "--name", name], 3000))?.code === 0;
