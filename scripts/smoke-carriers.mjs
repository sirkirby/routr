// Live check that the trace-context carriers routr passes to a pane it splits arrive exactly, inside a live herdr
// session on THIS machine. Run after updating herdr, and before a release that changes worker environment handling
// (AGENTS.md, CONTRIBUTING.md), from a pane of a herdr session:
//   bun run smoke:carriers
// 1. Splits a pane with routr's own split code, its carriers hostile but valid (`%` `"` `&` `!` `;` `,` `=` TAB and
//    spaces, each value exactly at routr's limit), starts a small fixture in that pane's shell that writes its
//    environment to a file, checks each value arrived byte for byte, and closes the pane.
// 2. macOS and Linux: splits another pane, its carriers short markers, and `herdr agent start`s the installed Claude
//    Code there with no task, reads that agent's own environment (`ps eww -o command= -p <pid>` on macOS,
//    /proc/<pid>/environ on Linux), looks for each NAME=value whole, and closes the pane. There is no ordinary way to
//    read another process's environment on Windows, so this half is posix only. No task is sent, so no subscription is
//    spent (Claude may stop at its folder-trust screen; its process is there all the same). The environment read is
//    the harness's own: the process started as `claude`, or running the file `claude` on PATH resolves to; a wrapper
//    in front of it, or no such process, fails the check.
// Every pane it made is closed at the end, however the run went; a pane it could not close is named, and fails it.
// Why the halves differ: ps prints a process's environment as one line, entries separated by spaces, so it cannot show
// a value holding a TAB or a space exactly, and the live run (herdr 0.9.5, macOS zsh, 2026-10-24) found the hostile
// values at their limits missing from ps's text while short ones were there exactly. So the shell half proves the
// bytes (its fixture writes its own environment as JSON), and the agent half proves only that the agent inherits what
// its pane's shell has, with markers of letters, digits, `-` and `_` that ps shows unambiguously.
// Writes only in a temporary folder it removes. Prints carrier names, never values. Exits 1 when a check fails.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { deadline, paneView, quote, runHerdr, splitArgs, waitForShell } from "../src/lib/herdr.mjs";
import { processError } from "../src/lib/process-boundary.mjs";
import { CARRIERS, carriersFrom, installedAt, probe, realOr } from "../src/lib/runtime.mjs";

const LIMITS = { TRACEPARENT: 512, TRACESTATE: 512, BAGGAGE: 8192 };
// What a shell or herdr could take for something else: quotes, expansions, separators, TAB and spaces.
export const HOSTILE = "%PATH% \"q\" 'q' & ! ; , = \t $HOME `x` a=b,c=d";
// Each carrier: its marker, the hostile characters, padded to exactly routr's limit for it.
export function hostileCarriers(tag = randomUUID().slice(0, 8)) {
  return Object.fromEntries(CARRIERS.map((name) => {
    const head = `routr-smoke-${tag}-${name}:${HOSTILE}:`;
    return [name, head + "x".repeat(LIMITS[name] - head.length)];
  }));
}
// One short marker per carrier, of characters ps shows unambiguously (letters, digits, - and _): the agent half's.
// TRACEPARENT is shaped as a valid one (version, trace id, span id, flags) in case the harness reads it.
export function agentCarriers(tag = randomUUID().replace(/-/g, "").slice(0, 8)) {
  const hex = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  return { TRACEPARENT: `00-${hex.slice(0, 32)}-${hex.slice(32, 48)}-01`, TRACESTATE: `routr_smoke-${tag}-ts`, BAGGAGE: `routr_smoke-${tag}-bg` };
}
// The carriers `sent` that `got` (an environment object) does not hold exactly.
export const missingIn = (got, sent) => Object.keys(sent).filter((name) => got?.[name] !== sent[name]);
// The carriers `sent` (short markers: no space or TAB) not found whole as NAME=value in a process's environment as
// text: /proc/<pid>/environ (NUL-separated entries), or ps's line (the command, then each entry after a space).
export function missingInText(text, sent) {
  const entries = new Set(String(text).split(/[\0\s]+/));
  return Object.keys(sent).filter((name) => !entries.has(`${name}=${sent[name]}`));
}
// What is typed into the pane's shell to start the fixture: the runtime and the script, quoted for that shell.
export const fixtureCommand = (shell, exe, script) => (shell === "posix" ? `${quote(exe)} ${quote(script)}`
  : shell === "powershell" ? `& '${exe.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'` : `"${exe}" "${script}"`);
const FIXTURE = (out) => `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n`;
// The program a process was started as: the first word of `ps -o command=` (a path with a space is not told apart), or
// the first entry of /proc/<pid>/cmdline.
export const argv0Of = (text, { proc = false } = {}) => (proc ? String(text).split("\0")[0] : String(text).trim().split(/\s+/)[0]) || null;
// Whether a process is the harness itself, not a wrapper, shell or helper in front of it: started as `claude` (by name
// or path), or as the file the `claude` on PATH resolves to (`installed`), or running that file (`exe`, Linux). Read
// from ps or /proc: routr's herdr boundary keeps only shell names from `pane process-info`.
export const isHarness = ({ argv0, exe = null }, { name = "claude", installed = null } = {}) => {
  if (argv0 && basename(argv0) === name) return true;
  if (installed == null) return false;
  return exe === installed || (Boolean(argv0) && (argv0 === installed || (isAbsolute(argv0) && realOr(argv0) === installed)));
};

// The check itself; `herdr` (the transport), `env` and `log` are seams the tests give.
export async function smokeCarriers({ herdr = runHerdr, env = process.env, log = console.log } = {}) {
  if (env.HERDR_ENV !== "1") { log("smoke:carriers runs inside a herdr pane (HERDR_ENV=1); nothing done"); return 1; }
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "routr-smoke-carriers-")));
  const sent = hostileCarriers();
  const call = async (a, ms = 15000) => { const r = await herdr(a, ms); if (!r.ok) throw processError(r); return r; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Every pane this run made, from the moment herdr names it: all are closed at the end, however the run ended.
  const panes = [];
  let failed = 0;
  const say = (what, missing) => { if (missing.length) failed++; log(`${what}: ${missing.length ? `FAILED (${missing.join(", ")} did not arrive exactly)` : `ok (${CARRIERS.join(", ")} arrived exactly)`}`); };
  // A pane split with `carriers`, its shell at a prompt.
  const split = async (carriers) => {
    const pane = (await call(splitArgs("down", dir, carriers))).data.result.pane.pane_id;
    panes.push(pane);
    let shell = "posix";
    const r = await waitForShell(paneView(call, pane), { sleep, now: () => performance.now(), remaining: deadline(30000, () => performance.now(), "the pane's shell did not come to a prompt in 30 s"), cwd: dir,
      onShell: (name) => { shell = /^(pwsh|powershell)/i.test(name) ? "powershell" : /^cmd/i.test(name) ? "cmd" : "posix"; } });
    if (!r.ok) throw new Error(`the pane's shell: ${r.why}`);
    return { pane, shell };
  };
  // The harness's own process among the pane's foreground ones, once it is there; null if none is within 10 s.
  const harnessIn = async (pane) => {
    const installed = installedAt("claude");
    for (let i = 0; i < 40; i++) {
      const info = (await call(["pane", "process-info", "--pane", pane])).data.result.process_info;
      for (const { pid } of info.foreground_processes.filter((p) => p.pid !== info.shell_pid)) {
        const who = process.platform === "linux"
          ? { argv0: argv0Of((() => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return ""; } })(), { proc: true }), exe: (() => { try { return realpathSync.native(`/proc/${pid}/exe`); } catch { return null; } })() }
          : { argv0: argv0Of((await probe("/bin/ps", ["-o", "command=", "-p", String(pid)], { separate: true }))?.out ?? "") };
        if (isHarness(who, { installed })) return pid;
      }
      await sleep(250);
    }
    return null;
  };
  try {
    if (carriersFrom(sent).withheld.length) throw new Error("the smoke's own carriers are outside routr's limits");
    {
      const { pane, shell } = await split(sent);
      const script = join(dir, "fixture.cjs"), out = join(dir, "env.json");
      writeFileSync(script, FIXTURE(out));
      await call(["pane", "run", pane, fixtureCommand(shell, process.execPath, script)]);
      let got = null;
      for (let i = 0; i < 60 && !got; i++) { await sleep(250); try { got = JSON.parse(readFileSync(out, "utf8")); } catch {} }
      say(`split pane, ${shell} shell`, got ? missingIn(got, sent) : CARRIERS);
    }
    if (process.platform === "win32") log("agent: not checked on Windows (another process's environment cannot be read there)");
    else {
      const markers = agentCarriers();
      const { pane } = await split(markers);
      const started = await herdr(["agent", "start", "routr-smoke-carriers", "--kind", "claude", "--pane", pane, "--timeout", "20000"], 25000);
      if (!started.ok && !["agent_not_ready", "timeout"].includes(started.data?.error?.code)) throw processError(started);
      const pid = await harnessIn(pane);
      if (!pid) throw new Error("no process in the pane is Claude Code itself (by its argv0, or the file `claude` on PATH resolves to): its environment was not read");
      const text = process.platform === "linux" ? readFileSync(`/proc/${pid}/environ`, "utf8") : (await probe("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { separate: true }))?.out ?? "";
      say(`agent (claude, pid ${pid})`, missingInText(text, markers));
    }
  } catch (e) { failed++; log(`FAILED: ${e?.message ?? e}`); }
  finally {
    for (const pane of panes) {
      let r; try { r = await herdr(["pane", "close", pane], 5000); } catch { r = { ok: false, code: "herdr_unreachable" }; }
      if (!r?.ok) { failed++; log(`FAILED: could not close pane ${pane} (${r?.code ?? "no answer"}); close it yourself`); }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}
if (import.meta.main) process.exitCode = (await smokeCarriers()) ? 1 : 0;
