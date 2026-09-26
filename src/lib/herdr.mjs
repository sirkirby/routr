// herdr, as routr uses it: the transport, reading a pane, the shell at a pane's prompt, and what gets typed into that
// shell. `launch` (the user's panes) and `terminal` (a private session) both build on it, so neither imports the other
// and an advice command that reads Cursor's usage never loads the launcher.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

// A POSIX shell word: plain when it is safe, single-quoted otherwise.
export const quote = (s) => /^[a-zA-Z0-9_./:=@+-]+$/.test(s) ? s : `'${String(s).replaceAll("'", "'\\''")}'`;

export const clean = (text) => stripVTControlCharacters(text).replaceAll("\r\n", "\n").split("\n")
  .map((line) => {
    const chars = []; let cursor = 0;
    for (const char of line) {
      if (char === "\r") cursor = 0;
      else if (char === "\b") cursor = Math.max(0, cursor - 1);
      else chars[cursor++] = char;
    }
    return chars.join("");
  }).join("\n").trimEnd();

// Reads are JSON in the API; some CLI releases print the text directly.
export function paneText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") throw new Error("Herdr returned no pane text");
  if (value.error || value.ok === false) throw new Error("Herdr pane read failed");
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join("\n");
  if (Object.hasOwn(value, "result")) return paneText(value.result);
  for (const key of ["text", "content", "output", "lines", "screen", "snapshot", "read", "pane"]) {
    if (value[key] == null) continue;
    if (Array.isArray(value[key]) && value[key].every((v) => typeof v === "string")) return value[key].join("\n");
    try { return paneText(value[key]); } catch {}
  }
  throw new Error("Unrecognized Herdr pane-read response");
}

// The shell at the pane's prompt, from the process name herdr reports: what gets typed into it depends on this.
export function shellFamily(name) {
  const n = String(name ?? "").toLowerCase();
  if (/^(pwsh|powershell)(\.exe)?$/.test(n)) return "powershell";
  if (/^cmd(\.exe)?$/.test(n)) return "cmd";
  return "posix";
}

// What gets typed into a pane's shell, in that shell's own syntax (launch, and Cursor's usage read). Cursor gets a private config folder for the life of the
// process. On a POSIX shell one command starts Cursor and removes the folder when it exits, however it exits (`cursor`).
// On Windows, herdr sees only the shell in a pane's foreground, so a Cursor started that way is never tracked and its
// readiness cannot be waited on (seen on Windows 11: `agent get` said not found while Cursor sat at its prompt). There
// the shell is given the variable first (`cursorEnv`) and herdr starts and tracks Cursor itself, as for every other
// kind; on PowerShell a watcher removes the folder when that shell is gone, cmd leaves it (one small file in %TEMP%).
const psq = (s) => `'${String(s).replaceAll("'", "''")}'`;
const cmdq = (s) => `"${String(s).replaceAll('"', '""')}"`;
export const SHELLS = {
  posix: {
    cd: (dir) => `cd -- ${quote(dir)}`,
    cursor: (dir, exe, argv) => ["env", `CURSOR_CONFIG_DIR=${dir}`, "sh", "-c",
      `trap 'rm -rf -- "$CURSOR_CONFIG_DIR"' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; ${[exe, ...argv].map(quote).join(" ")}`].map(quote).join(" "),
  },
  powershell: {
    cd: (dir) => `Set-Location -LiteralPath ${psq(dir)}`,
    // A watcher removes the folder once the pane's shell is gone, however it went: an exit hook in the shell itself did
    // not fire when herdr closed the pane, and a watcher started as the shell's child made herdr call the pane busy
    // (both seen on Windows 11). Created through WMI, the watcher is nobody's child. The command line is built by
    // concatenation: a hashtable literal holding it failed to parse at the prompt (also seen).
    cursorEnv: (dir) => `$env:CURSOR_CONFIG_DIR=${psq(dir)}; $w = 'powershell -NoProfile -WindowStyle Hidden -Command "Wait-Process -Id ' + $PID + '; Remove-Item -LiteralPath ${psq(dir).replaceAll("'", "''")} -Recurse -Force -ErrorAction SilentlyContinue"'; ([wmiclass]'Win32_Process').Create($w) | Out-Null`,
  },
  cmd: {
    cd: (dir) => `cd /d ${cmdq(dir)}`,
    cursorEnv: (dir) => `set ${cmdq(`CURSOR_CONFIG_DIR=${dir}`)}`,
  },
};

export function shellPrompt(text) {
  const lines = clean(text).split("\n");
  const last = lines.at(-1)?.trim() ?? "";
  // Only the current line counts: answered questions remain in scrollback.
  if (/source it\?/i.test(lines.slice(-3).join("\n")) && /\[y\].*\[n\]/i.test(last)) return "dotenv";
  if (/[?？]\s*(?:\([^\n]*\)|\[[^\n]*\])?\s*$/.test(last)
    || /(?:\[[yn](?:es)?\/[yn](?:o)?\]|\([yn](?:es)?\/[yn](?:o)?\)|:)\s*$/i.test(last)
    || /^(?:>|quote>|dquote>|heredoc>)$/.test(last)) return "question";
  // Windows: PowerShell shows `PS C:\path>` and cmd shows `C:\path>`. Both end in ">", which on Unix means a
  // continuation line, so they are matched by their whole shape (a drive path), never by the ">" alone.
  if (/^(?:PS )?[A-Za-z]:\\[^<>|?*\n]*>$/.test(last)) return "ready";
  if (/\d(?:\.\d+)?%$/.test(last)) return "unrecognized"; // A stalled progress meter is not a zsh prompt.
  if (/^(?:.*\s)?[❯❱➜λ\uE0B0\uE0B1]$/.test(last) || /(?:^|\S.*)[\s]*[$%#]$/.test(last)) return "ready";
  return last ? "unrecognized" : "waiting";
}

// Settling is additional evidence, not permission to type into arbitrary stable output.
export const promptSettled = (text, previous) => {
  const screen = clean(text).trim();
  return !!screen && typeof previous === "string" && screen === clean(previous).trim();
};

export function runHerdr(args, timeout) {
  return new Promise((done, reject) => {
    const child = spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (s) => { stdout += s; });
    child.stderr.on("data", (s) => { stderr += s; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Math.max(1, Math.min(timeout, 2147483647)));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let data;
      if (timedOut) return done({ ok: false, data: { error: { code: "timeout", message: "Herdr command timed out" } } });
      try { data = JSON.parse(code === 0 ? stdout : stderr || stdout); }
      catch { data = code === 0 ? stdout : { error: { code: "herdr_failed", message: (stderr || stdout || "Herdr timed out").trim() } }; }
      done({ ok: code === 0 && !data?.error, data });
    });
  });
}

// A pane as routr reads and types into it, through `call` (one herdr command, which throws on failure): its screen,
// its processes, and keys. launch drives the user's panes with it, terminal.mjs its private session's.
export const paneView = (call, pane) => ({
  read: async () => paneText((await call(["pane", "read", pane, "--source", "visible"])).data),
  info: async () => (await call(["pane", "process-info", "--pane", pane])).data.result.process_info,
  keys: (...keys) => call(["pane", "send-keys", pane, ...keys]),
});

// True when the shell is the only thing running in the pane: a command typed into it has exited, or never started.
export async function shellAlone(pane) {
  const info = await pane.info();
  return (info.foreground_processes ?? []).every((p) => p.pid === info.shell_pid);
}

// A time budget for a sequence of herdr calls: `remaining()` is what is left, and throws `message` once it is spent.
export function deadline(timeout, now, message) {
  const began = now();
  return () => {
    const ms = Math.floor(timeout - (now() - began));
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(message);
    return ms;
  };
}

// Wait until a pane's shell sits at a settled prompt, answering a dotenv plugin's question with "n" (a login shell in a
// folder holding a .env asks before sourcing it). Anything else that asks stops the wait: routr never guesses an answer.
// `pane` is { read(): screen text, info(): herdr's process_info, keys(...keys) }. Something else running in the pane is
// waited out (new shells and directory hooks run short commands), unless `refuseBusy` (a pane adopted from the caller).
// `cwd`, when given, must be where the shell is. Returns { ok: true, name, cwd } or { ok: false, why, text }.
export async function waitForShell(pane, { sleep, now, remaining, cwd, refuseBusy = false, onShell, onAnswer } = {}) {
  let answers = 0, answered = false, answeredAt = null, previous = null;
  const pause = () => sleep(Math.min(250, remaining()));
  for (;;) {
    const text = await pane.read();
    const info = await pane.info();
    const fail = (why) => ({ ok: false, why, text });
    const processes = info.foreground_processes ?? [];
    const shell = processes.find((p) => p.pid === info.shell_pid);
    if (shell) onShell?.(shell.name);
    if (processes.some((p) => p.pid !== info.shell_pid)) {
      if (refuseBusy) return fail("Pane has a foreground process; refusing to type shell input");
      previous = null; await pause(); continue;
    }
    if (!shell) { previous = null; await pause(); continue; }
    const state = shellPrompt(text);
    if (state === "dotenv") {
      if (!answered) {
        if (++answers > 3) return fail("Shell repeated the dotenv question");
        await pane.keys("n", "enter");
        onAnswer?.();
        answered = true; answeredAt = now();
      }
      if (now() - answeredAt >= 5000) return fail("Shell did not clear the dotenv question after answering");
    } else {
      answered = false;
      if (state === "question") return fail("Unrecognized shell question");
      // Even a recognized prompt must settle while the shell remains in the foreground.
      if (state === "ready" && promptSettled(text, previous)) {
        if (cwd && realpathSync(shell.cwd) !== realpathSync(cwd)) return fail("Shell is at a prompt in the wrong directory");
        return { ok: true, name: shell.name, cwd: shell.cwd };
      }
    }
    previous = text;
    await pause();
  }
}
