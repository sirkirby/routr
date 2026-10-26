// herdr, as routr uses it: the transport, reading a pane, the shell at a pane's prompt, and what gets typed into that
// shell. `launch` (the user's panes) and `terminal` (a private session) both build on it, so neither imports the other
// and an advice command that reads Cursor's usage never loads the launcher.
import { stripVTControlCharacters } from "node:util";
import { callHerdr } from "./process-boundary.mjs";
import { CARRIERS, FORWARDED, realPath, start } from "./runtime.mjs";

// A branch name launch gives `herdr worktree create`, and cleanup finds a worktree by.
export const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,80}$/;

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
// Every folder path typed into a shell goes through these, so it reaches the shell exactly or is refused.
// PowerShell ends a single-quoted string at ' and also at the smart quotes U+2018 to U+201B, and reads any two in a row
// as one: each is doubled (its tokenizer; a folder named "Chris’s" broke the line before). Checked by PowerShell's own
// parser in the tests where pwsh is installed.
const psEscape = (s) => String(s).replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&");
const psq = (s) => `'${psEscape(s)}'`;
// cmd expands %NAME% inside quotes, and !NAME! too when delayed expansion is on, and its prompt has no way to quote
// either literally: a path holding one is refused before anything is typed, never typed changed.
export const CMD_PATH = "A cmd shell expands % and ! in a folder path even inside quotes, so routr will not type this one into it. Use a folder whose path has neither, or a pane running PowerShell.";
export const cmdTypable = (...paths) => !paths.some((p) => /[%!]/.test(String(p)));
const cmdq = (s) => { if (!cmdTypable(s)) throw new Error(CMD_PATH); return `"${String(s).replaceAll('"', '""')}"`; };
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
    // concatenation: a hashtable literal holding it failed to parse at the prompt (also seen), so it stays one line of
    // `;`-separated statements. A process WMI creates gets its own console, which showed before `-WindowStyle Hidden`
    // took effect; a Win32_ProcessStartup with ShowWindow = 0 (SW_HIDE) is the documented way to start it hidden. Not
    // yet confirmed on Windows 11. The watcher's path is a string inside $w's string, so it is quoted twice.
    cursorEnv: (dir) => `$env:CURSOR_CONFIG_DIR=${psq(dir)}; $w = 'powershell -NoProfile -WindowStyle Hidden -Command "Wait-Process -Id ' + $PID + '; Remove-Item -LiteralPath ${psEscape(psq(dir))} -Recurse -Force -ErrorAction SilentlyContinue"'; $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); $si.ShowWindow = 0; ([wmiclass]'Win32_Process').Create($w, $null, $si) | Out-Null`,
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

// One herdr command. The timeout answers by itself, then kills: waiting for `close` after the kill (as before)
// kept the call pending past its timeout whenever something else still held the pipes, e.g. on Windows a herdr
// started through cmd.exe, where the kill reaches cmd.exe and not the hung client below it. Only the child is
// killed, never its tree: a herdr client may have started the herdr server, the user's whole session. Our ends
// of the pipes are closed and the child unref'd, so a client that lingers holds neither this call nor routr's
// exit. `via` is a test seam (runtime's start).
function transport(args, timeout, { via = start } = {}) {
  return new Promise((done, reject) => {
    const child = via("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const settle = (f, v) => { if (settled) return; settled = true; clearTimeout(timer); f(v); };
    child.stdout.on("data", (s) => { stdout += s; });
    child.stderr.on("data", (s) => { stderr += s; });
    const timer = setTimeout(() => {
      settle(done, { ok: false, data: { error: { code: "timeout", message: "Herdr command timed out" } } });
      try { child.kill("SIGKILL"); } catch {}
      try { child.stdout.destroy(); child.stderr.destroy(); child.unref?.(); } catch {}
    }, Math.max(1, Math.min(timeout, 2147483647)));
    child.on("error", (e) => settle(reject, e));
    child.on("close", (code) => {
      if (settled) return;
      let data;
      try { data = JSON.parse(code === 0 ? stdout : stderr || stdout); }
      catch { data = code === 0 ? stdout : { error: { code: "herdr_failed", message: (stderr || stdout || "Herdr timed out").trim() } }; }
      settle(done, { ok: code === 0 && !data?.error, data });
    });
  });
}

// A pane's recent lines with the terminal's wrapping undone (herdr's recent-unwrapped): a line wider than the pane is
// one line again. The shell wait reads them only to finish a prompt the visible screen shows wrapped (shellLine).
export const promptReadArgs = (pane) => ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "40"];

// A pane as routr reads and types into it, through `call` (one herdr command, which throws on failure): its screen,
// its recent lines unwrapped (promptReadArgs), its processes, and keys. launch drives the user's panes with it,
// terminal.mjs its private session's.
export const paneView = (call, pane) => ({
  read: async () => paneText((await call(["pane", "read", pane, "--source", "visible"])).data),
  unwrapped: async () => paneText((await call(promptReadArgs(pane))).data),
  info: async () => (await call(["pane", "process-info", "--pane", pane])).data.result.process_info,
  keys: (...keys) => call(["pane", "send-keys", pane, ...keys]),
});

// A new pane, in `cwd`: beside the caller's (`--current`), or beside `pane` (a worktree's root pane, which launch then
// closes). Its shell gets each trace-context carrier as `--env NAME=VALUE`, from `carriers` (runtime's, checked): the
// only herdr start with an environment option (0.9.5: `worktree create` and `agent start` have none). Measured
// 2026-10-24, herdr 0.9.5 on macOS zsh: values holding `,` `=` TAB `"` `'` `&` `!` `%` and spaces reached the pane's
// shell byte for byte. A pane starts from the herdr server's environment, and herdr's pane filter keeps the three names
// (herdr 0.9.5's source, read 2026-10-25): so each of the three routr does not forward, absent or withheld, is passed
// empty, and the worker never gets a context the server inherited when it started, from another trace. OpenTelemetry's
// environment-carrier rules read an empty value as absent. herdr is started directly, never through a shell, so nothing
// here is quoted. `shown: true` is the same command as output may carry it: each forwarded value replaced by FORWARDED
// (an empty one has nothing to hide). smoke:carriers splits with this too.
export const splitArgs = (direction, cwd, carriers = {}, { shown = false, pane = null } = {}) => ["pane", "split", ...(pane ? [pane] : ["--current"]),
  "--direction", direction, "--cwd", cwd, "--no-focus",
  ...CARRIERS.flatMap((name) => ["--env", `${name}=${!Object.hasOwn(carriers, name) ? "" : shown ? FORWARDED : carriers[name]}`])];

// One split through `call(args, shown, tolerate)` (one herdr command, which throws on failure unless `tolerate`; `shown`
// is the command as output may carry it): the new pane's id.
export async function splitPane(call, direction, cwd, carriers, { pane = null } = {}) {
  const r = await call(splitArgs(direction, cwd, carriers, { pane }), splitArgs(direction, cwd, carriers, { pane, shown: true }));
  const id = r.data?.result?.pane?.pane_id;
  if (typeof id !== "string" || !id) throw new Error("Herdr split returned no pane id");
  return id;
}

// `herdr worktree create`, as launch gives it: a new worktree on `branch` (from `base`, as herdr takes it), opened as a
// workspace with one shell pane, its root pane.
export const worktreeArgs = (cwd, branch, base = null) => ["worktree", "create", "--cwd", cwd, "--branch", branch, ...(base ? ["--base", base] : []), "--no-focus"];
// The worker's pane in a worktree herdr just opened. herdr opens the root pane from its server's environment (worktree
// create takes none), which can hold a trace context the server inherited from another trace; so the worker's pane is
// a split of the root pane, in the worktree, with routr's carriers (splitArgs), and the root pane is closed after it:
// closing a workspace's only pane closes the workspace. Measured 2026-10-25, herdr 0.9.5 on macOS: the split's shell
// had the values byte for byte, and the close left the workspace open with only the new pane. Throws when the split
// fails; a close that fails leaves an extra shell pane and is returned, not thrown, for the caller to decide (launch
// ends there; smoke:carriers fails its check): { pane, closed }.
// `call` as splitPane's. smoke:carriers runs this too.
export async function worktreePane(call, root, cwd, carriers) {
  const pane = await splitPane(call, "right", cwd, carriers, { pane: root });
  const close = ["pane", "close", root];
  let closed = null; try { closed = await call(close, close, true); } catch {}
  return { pane, closed: closed?.ok === true };
}

// Measured 2026-10-24, herdr 0.9.5 on macOS: 3 of 4 worktree launches got an unreadable process-info answer
// during zsh startup; the same pane answered later. An unreadable look proves neither readiness
// nor exit. Only waits use this; cleanup must still refuse when it cannot tell what runs in a pane.
async function processesWhileWaiting(pane) {
  try { return await pane.info(); }
  catch (e) { if (e?.code !== "herdr_invalid_response") throw e; return null; }
}

// The state of the shell's current line (shellPrompt), from the visible screen; when its last row is not a state routr
// can act on (unrecognized), or reads as a question, from the pane's last line unwrapped, but only when that line is
// the screen's own wrapped: two or more of the visible screen's last rows, joined, are exactly it. Measured 2026-10-26,
// herdr 0.9.5 on Windows 11 (PowerShell 5.1): a worktree pane split to 57 columns showed `PS C:\Users\…\routr-smoke-…>`
// over two rows, its last row no drive path, and the wait ran out at 30 s; recent-unwrapped gave it on one line. A
// prompt wrapped just before its `>` leaves a row that reads as a continuation question. The visible screen stays the
// authority: herdr's recent range reaches into scrollback under a blank screen and can miss the top of an alternate
// screen taller than the rows read (its 0.9.5 source), and a line that only ends like the last row may be another one.
// A row can end where the line had a space, so spaces are not compared. `unwrapped()` is read only when needed.
export async function shellLine(text, unwrapped) {
  const state = shellPrompt(text);
  if (state !== "unrecognized" && state !== "question") return state;
  const rows = clean(text).split("\n"), line = clean(await unwrapped()).split("\n").at(-1).trim();
  return wrappedOnScreen(rows, line) ? shellPrompt(line) : state;
}
const wrappedOnScreen = (rows, line) => {
  const want = line.replace(/\s+/g, "");
  let got = "";
  for (let k = 1; want && k <= rows.length; k++) {
    got = rows[rows.length - k].replace(/\s+/g, "") + got;
    if (got.length >= want.length) return k > 1 && got === want;
  }
  return false;
};

// True when the shell is the only thing running in the pane: a command typed into it has exited, or never started.
export async function shellAlone(pane) {
  const info = await processesWhileWaiting(pane);
  return info != null && (info.foreground_processes ?? []).every((p) => p.pid === info.shell_pid);
}

// A time budget for a sequence of herdr calls: `remaining(minimum)` is what is left, and throws `message` when less
// than minimum (default 1 ms) remains. A wait can stop before giving herdr a timeout too short to answer.
export function deadline(timeout, now, message) {
  const began = now();
  return (minimum = 1) => {
    const ms = Math.floor(timeout - (now() - began));
    if (!Number.isFinite(ms) || ms < minimum) throw new Error(message);
    return ms;
  };
}

// Wait until a pane's shell sits at a settled prompt. Anything the shell asks first (its plugins, its startup files)
// stops the wait and is returned with the screen: routr answers no question, the orchestrator reads it and decides.
// (A dotenv plugin's "Source it?" was once answered here; the next plugin would have needed its own rule. The standard
// signal would be the shell's own prompt marks, OSC 133, which herdr parses but does not expose yet.)
// `pane` is { read(): screen text, unwrapped(): its lines unwrapped, info(): herdr's process_info, keys(...keys) }.
// Something else running in the pane is
// waited out (new shells and directory hooks run short commands), unless `refuseBusy` (a pane adopted from the caller).
// `cwd`, when given, must be where the shell is. Returns { ok: true, name, cwd } or { ok: false, why, text }.
export async function waitForShell(pane, { sleep, now, remaining, cwd, refuseBusy = false, onShell } = {}) {
  let previous = null, unreadable = false;
  const left = (minimum = 1) => {
    try { return remaining(minimum); }
    catch (e) { if (unreadable) throw new Error("The pane's processes could not be read before the shell readiness deadline"); throw e; }
  };
  // Near the deadline, a poll's pause can leave herdr only a few ms to answer. Do not start a
  // read with less than 50 ms; if a read spends the deadline, report that deadline, not an unreachable herdr.
  const look = async (read) => {
    left(50);
    try { return await read(); }
    catch (e) { if (e?.timedOut) left(); throw e; }
  };
  const pause = () => sleep(Math.min(250, left()));
  for (;;) {
    const text = await look(() => pane.read());
    const read = await look(() => processesWhileWaiting(pane));
    unreadable = read == null;
    const info = read ?? {}; // no process information: the shell is waited for, like a busy one
    const fail = (why) => ({ ok: false, why, text });
    const processes = info.foreground_processes ?? [];
    const shell = processes.find((p) => p.pid === info.shell_pid);
    if (shell) onShell?.(shell.name);
    if (processes.some((p) => p.pid !== info.shell_pid)) {
      if (refuseBusy) return fail("Pane has a foreground process; refusing to type shell input");
      previous = null; await pause(); continue;
    }
    if (!shell) { previous = null; await pause(); continue; }
    const state = await shellLine(text, () => look(() => pane.unwrapped()));
    if (state === "question") return fail("The shell asked a question before its prompt");
    // Even a recognized prompt must settle while the shell remains in the foreground.
    if (state === "ready" && promptSettled(text, previous)) {
      // A folder that is gone (removed while the launch waited) is a person's call, not a crash.
      let here, there;
      if (cwd && typeof shell.cwd !== "string") return fail("The pane's shell did not say which folder it is in");
      try { here = cwd && realPath(shell.cwd); there = cwd && realPath(cwd); }
      catch (e) { return fail(e?.code === "ENOENT" ? `The pane's folder is gone (${shell.cwd}), or the one asked for (${cwd})` : `The pane's folder cannot be read (${e?.code ?? e})`); }
      if (cwd && here !== there) return fail("Shell is at a prompt in the wrong directory");
      return { ok: true, name: shell.name, cwd: shell.cwd };
    }
    previous = text;
    await pause();
  }
}

export const runHerdr = (args, timeout, options) => callHerdr((a, ms) => transport(a, ms, options), args, timeout);
