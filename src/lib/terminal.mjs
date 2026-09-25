// A throwaway terminal routr drives and always removes: for what a harness shows only in its own interactive screen
// (Cursor's usage today). Node has no terminal of its own to give a program, and routr takes no dependency, so the
// terminal is a private headless herdr session made for this one read, then stopped and deleted. It is the same inside
// herdr and outside it: nothing opens on the user's screen, and stopping the session removes everything in it however
// the read ended. (A split beside the caller was tried first: it squeezed the user's panes, and a read that died half
// way left its pane open, seen 2026-09-25.) Only herdr has to be installed; no herdr window needs to be open.
// Measured 2026-09-25 on herdr 0.9.1: `herdr --session <name> server` answers within a second, its pane is 119x40 and
// runs the login shell, `--session` wins over the calling pane's own herdr, and `session stop` + `session delete`
// leave no process and no session folder behind.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { paneText, promptSettled, shellPrompt } from "./launch.mjs";

// A session routr made carries the pid of the routr that made it, so a run that was killed half way is cleaned up by
// the next one without touching a session another routr is still using. A pid can be reused, so a session older than
// any read can last is stale whatever its pid says: a read is bounded by its timeout (90 s), so ten minutes is safe.
const PRIVATE = /^routr-scratch-(\d+)-[0-9a-f]+$/;
const STALE_MS = 10 * 60 * 1000;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
const ageMs = (dir) => { try { return Date.now() - statSync(dir).mtimeMs; } catch { return 0; } };
// A spawn can fail after it returns (EACCES, EMFILE, herdr gone since the last call): report it, never let it throw.
const startServer = (name, failed) => { const c = spawn("herdr", ["--session", name, "server"], { detached: true, stdio: "ignore", windowsHide: true }); c.on("error", failed); c.unref(); };

// `call(args)` runs one herdr command in the private session and throws on failure; `pane` is where to type.
// `close()` removes the session and never throws; if herdr is too slow to stop it, the next run removes it (its pid is
// gone by then). open() cleans up after itself when it fails half way.
export async function openTerminal({ run, cwd, remaining, sleep, alive = pidAlive, age = ageMs, start = startServer, pid = process.pid } = {}) {
  const name = `routr-scratch-${pid}-${randomBytes(3).toString("hex")}`;
  const bare = async (args) => {
    let r;
    try { r = await run(args, remaining()); }
    catch (e) { throw new Error(e?.code === "ENOENT" ? "herdr is not installed (or not on PATH), and routr needs it to open a terminal" : String(e?.message ?? e)); }
    if (!r.ok) throw new Error(r.data?.error?.message ?? JSON.stringify(r.data));
    return r;
  };
  const on = (args) => ["--session", name, ...args];
  const call = (args) => bare(on(args));
  let started = false;
  const close = async () => {
    if (!started) return;
    try { await run(["session", "stop", name, "--json"], 5000); } catch {}
    try { await run(["session", "delete", name, "--json"], 3000); } catch {}
  };
  const remove = async (s) => { // stop, then delete: herdr deletes only a stopped session
    const ms = () => Math.min(3000, remaining());
    try { await run(["session", "stop", s, "--json"], ms()); await run(["session", "delete", s, "--json"], ms()); } catch {}
  };
  try {
    const listed = await bare(["session", "list", "--json"]);
    const stale = (listed.data?.sessions ?? []).filter((s) => {
      const m = PRIVATE.exec(s.name ?? "");
      return m && (!alive(Number(m[1])) || age(s.session_dir) > STALE_MS);
    });
    await Promise.all(stale.map((s) => remove(s.name)));
    let spawnError = null;
    start(name, (e) => { spawnError = e; }); started = true;
    for (;;) { // the server answers within a second; `remaining()` ends the wait
      if (spawnError) throw new Error(`herdr could not start a private session: ${spawnError.code ?? spawnError.message}`);
      const r = await run(on(["workspace", "list"]), remaining());
      if (r.ok) break;
      if (r.data?.error?.code !== "server_not_running") throw new Error(r.data?.error?.message ?? "herdr did not start a private session");
      await sleep(Math.min(200, remaining()));
    }
    const pane = (await call(["workspace", "create", "--cwd", cwd, "--no-focus"])).data?.result?.root_pane?.pane_id;
    if (typeof pane !== "string" || !pane) throw new Error("herdr returned no pane id");
    return { pane, call, close };
  } catch (e) { await close(); throw e; }
}

export const readScreen = async (t) => paneText((await t.call(["pane", "read", t.pane, "--source", "visible"])).data);

// True when the shell is the only thing running in the pane: a command typed into it has exited, or never started.
export async function shellAlone(t) {
  const info = (await t.call(["pane", "process-info", "--pane", t.pane])).data.result.process_info;
  return (info.foreground_processes ?? []).every((p) => p.pid === info.shell_pid);
}

// Wait until the terminal's shell sits at a settled prompt, and return the shell's process name, answering a dotenv plugin's question with "n" (a login shell
// in a folder holding a .env asks before sourcing it). Anything else that asks is an error: routr never guesses an answer.
export async function waitForShell(t, { sleep, now, remaining }) {
  let answers = 0, answered = false, answeredAt = null, previous = null;
  const pause = () => sleep(Math.min(250, remaining()));
  for (;;) {
    const text = await readScreen(t);
    const info = (await t.call(["pane", "process-info", "--pane", t.pane])).data.result.process_info;
    const processes = info.foreground_processes ?? [];
    const shell = processes.find((p) => p.pid === info.shell_pid);
    if (processes.some((p) => p.pid !== info.shell_pid) || !shell) { previous = null; await pause(); continue; }
    const name = shell.name;
    const state = shellPrompt(text);
    if (state === "dotenv") {
      if (!answered) {
        if (++answers > 3) throw new Error("Shell repeated the dotenv question");
        await t.call(["pane", "send-keys", t.pane, "n", "enter"]);
        answered = true; answeredAt = now();
      }
      if (now() - answeredAt >= 5000) throw new Error("Shell did not clear the dotenv question after answering");
    } else {
      answered = false;
      if (state === "question") throw new Error("Unrecognized shell question");
      if (state === "ready" && promptSettled(text, previous)) return name;
    }
    previous = text;
    await pause();
  }
}
