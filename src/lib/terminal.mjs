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
import { paneText, promptSettled, shellPrompt } from "./launch.mjs";

// A session routr made carries the pid of the routr that made it, so a run that was killed half way is cleaned up by
// the next one without touching a session another routr is still using.
const PRIVATE = /^routr-scratch-(\d+)-[0-9a-f]+$/;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
const startServer = (name) => spawn("herdr", ["--session", name, "server"], { detached: true, stdio: "ignore", windowsHide: true }).unref();

// `call(args)` runs one herdr command in the private session and throws on failure; `pane` is where to type.
// `close()` removes the session and never throws. open() cleans up after itself when it fails half way.
export async function openTerminal({ run, cwd, remaining, sleep, alive = pidAlive, start = startServer, pid = process.pid } = {}) {
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
    try { await run(["session", "stop", name, "--json"], 3000); } catch {}
    try { await run(["session", "delete", name, "--json"], 3000); } catch {}
  };
  try {
    const listed = await bare(["session", "list", "--json"]);
    for (const s of listed.data?.sessions ?? []) {
      const m = PRIVATE.exec(s.name ?? "");
      if (!m || alive(Number(m[1]))) continue;
      try { await run(["session", "stop", s.name, "--json"], 3000); await run(["session", "delete", s.name, "--json"], 3000); } catch {}
    }
    start(name); started = true;
    for (;;) { // the server answers within a second; `remaining()` ends the wait
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

// Wait until the terminal's shell sits at a settled prompt, answering a dotenv plugin's question with "n" (a login shell
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
      if (state === "ready" && promptSettled(text, previous)) return;
    }
    previous = text;
    await pause();
  }
}
