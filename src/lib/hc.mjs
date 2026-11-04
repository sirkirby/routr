// herdr-core (`hc`), the terminal runtime under the Herdr app, and the app's own `herdr-app`: every call routr makes to
// them, what comes back as JSON, and the fixed codes a failure is said in. Its terminals set HC_TERMINAL_ID and not
// HERDR_ENV; the app shows a terminal only with the labels herdr.space and herdr.tab (routr-lab p50, hc 0.1.17, 2026-11-03).
// Shapes are core's own schema (`hc schema`, hc 0.1.17): a terminal's `state` is live or finished, `status` the program's
// own report or null, `turn` goes up each time that status leaves working. What hc says is never passed on as text.
import { start, stop } from "./runtime.mjs";

// routr's own calls keep the environment, as a herdr client's do: hc finds its core and its caller there. Resolves
// `{ out, err, code }`, or null when it could not start or did not answer in time; never throws.
export const client = (cmd, args, ms) => new Promise((done) => {
  let child, out = "", err = "", finished = false, exited = false;
  const finish = (v) => { if (finished) return; finished = true; clearTimeout(timer); if (!exited && child) stop(child); done(v); };
  const timer = setTimeout(() => finish(null), ms);
  try { child = start(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch { return finish(null); }
  child.on("error", () => finish(null));
  child.on("exit", () => { exited = true; });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("close", (code) => finish({ out, err, code }));
});
// Core's error kind, or its "no terminal t9" (schema README): read only to tell a terminal that is gone from a refusal.
const NOT_FOUND = /\bnot_found\b|\bno terminal\b/i;
const failure = (r) => (NOT_FOUND.test(`${r.out ?? ""}\n${r.err ?? ""}`) ? "not_found" : "refused");
// hc answers JSON when piped; `run` prints text unless asked (its help).
export const callHc = async (args, run, ms = 10000) => {
  const r = await run("hc", args, ms);
  if (r == null) return { ok: false, code: "not_available" };
  if (r.code !== 0) return { ok: false, code: failure(r) };
  try { return { ok: true, data: JSON.parse(r.out) }; } catch { return { ok: false, code: "unreadable" }; }
};
// A call whose exit is its answer: `kill`, `rm`.
export const actHc = async (args, run, ms = 10000) => {
  const r = await run("hc", args, ms);
  return r == null ? { ok: false, code: "not_available" } : r.code === 0 ? { ok: true } : { ok: false, code: failure(r) };
};

// `t7`, or `machine/t7` (its schema): printed and passed on as an identifier, so only that shape counts as one.
export const isAddress = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/.test(v);
// The status words a program reports, as schema lists them: an object in `get`, a word in `ls`. Anything else is none.
const WORDS = new Set(["idle", "working", "done", "blocked", "error"]);
export const statusWord = (t) => { const s = typeof t?.status === "string" ? t.status : t?.status?.state; return WORDS.has(s) ? s : null; };
const KINDS = new Set(["permission", "question", "auth"]);
export const statusKind = (t) => (KINDS.has(t?.status?.kind) ? t.status.kind : null);
export const turnOf = (t) => (Number.isSafeInteger(t?.turn) && t.turn >= 0 ? t.turn : 0);
export const isFinished = (t) => t?.state === "finished";
export const getTerminal = (address, run, ms) => callHc(["get", address, "--json"], run, ms);

// The app numbers a tab it did not make; this gives it a name. True once the app has taken it.
export const renameTab = async (tab, name, run) => (await run("herdr-app", ["do", "tab.rename", "--id", tab, "--name", name], 3000))?.code === 0;
