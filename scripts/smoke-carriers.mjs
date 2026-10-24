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
//    spent (Claude may stop at its folder-trust screen; its process is there all the same).
// Why the halves differ: ps prints a process's environment as one line, entries separated by spaces, so it cannot show
// a value holding a TAB or a space exactly, and the live run (herdr 0.9.5, macOS zsh, 2026-10-24) found the hostile
// values at their limits missing from ps's text while short ones were there exactly. So the shell half proves the
// bytes (its fixture writes its own environment as JSON), and the agent half proves only that the agent inherits what
// its pane's shell has, with markers of letters, digits, `-` and `_` that ps shows unambiguously.
// Writes only in a temporary folder it removes. Prints carrier names, never values. Exits 1 when a check fails.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadline, paneView, quote, runHerdr, splitArgs, waitForShell } from "../src/lib/herdr.mjs";
import { processError } from "../src/lib/process-boundary.mjs";
import { CARRIERS, carriersFrom, probe } from "../src/lib/runtime.mjs";

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

async function main({ log = console.log } = {}) {
  if (process.env.HERDR_ENV !== "1") { log("smoke:carriers runs inside a herdr pane (HERDR_ENV=1); nothing done"); return 1; }
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "routr-smoke-carriers-")));
  const sent = hostileCarriers();
  if (carriersFrom(sent).withheld.length) throw new Error("the smoke's own carriers are outside routr's limits");
  const call = async (a, ms = 15000) => { const r = await runHerdr(a, ms); if (!r.ok) throw processError(r); return r; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let failed = 0;
  const say = (what, missing) => { if (missing.length) failed++; log(`${what}: ${missing.length ? `FAILED (${missing.join(", ")} did not arrive exactly)` : `ok (${CARRIERS.join(", ")} arrived exactly)`}`); };
  // A pane split with `carriers`, its shell at a prompt; closed by the caller.
  const split = async (carriers) => {
    const pane = (await call(splitArgs("down", dir, carriers))).data.result.pane.pane_id;
    let shell = "posix";
    const r = await waitForShell(paneView(call, pane), { sleep, now: () => performance.now(), remaining: deadline(30000, () => performance.now(), "the pane's shell did not come to a prompt in 30 s"), cwd: dir,
      onShell: (name) => { shell = /^(pwsh|powershell)/i.test(name) ? "powershell" : /^cmd/i.test(name) ? "cmd" : "posix"; } });
    if (!r.ok) throw new Error(`the pane's shell: ${r.why}`);
    return { pane, shell };
  };
  try {
    {
      const { pane, shell } = await split(sent);
      try {
        const script = join(dir, "fixture.cjs"), out = join(dir, "env.json");
        writeFileSync(script, FIXTURE(out));
        await call(["pane", "run", pane, fixtureCommand(shell, process.execPath, script)]);
        let got = null;
        for (let i = 0; i < 60 && !got; i++) { await sleep(250); try { got = JSON.parse(readFileSync(out, "utf8")); } catch {} }
        say(`split pane, ${shell} shell`, got ? missingIn(got, sent) : CARRIERS);
      } finally { await runHerdr(["pane", "close", pane], 5000); }
    }
    if (process.platform === "win32") log("agent: not checked on Windows (another process's environment cannot be read there)");
    else {
      const markers = agentCarriers();
      const { pane } = await split(markers);
      try {
        const started = await runHerdr(["agent", "start", "routr-smoke-carriers", "--kind", "claude", "--pane", pane, "--timeout", "20000"], 25000);
        if (!started.ok && !["agent_not_ready", "timeout"].includes(started.data?.error?.code)) throw processError(started);
        let pid = null;
        for (let i = 0; i < 40 && !pid; i++) {
          const info = (await call(["pane", "process-info", "--pane", pane])).data.result.process_info;
          pid = info.foreground_processes.find((p) => p.pid !== info.shell_pid)?.pid ?? null;
          if (!pid) await sleep(250);
        }
        if (!pid) throw new Error("no agent process appeared in the pane");
        const text = process.platform === "linux" ? readFileSync(`/proc/${pid}/environ`, "utf8") : (await probe("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], { separate: true }))?.out ?? "";
        say(`agent (claude, pid ${pid})`, missingInText(text, markers));
      } finally { await runHerdr(["pane", "close", pane], 5000); }
    }
  } catch (e) { failed++; log(`FAILED: ${e?.message ?? e}`); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  return failed;
}
if (import.meta.main) process.exitCode = (await main()) ? 1 : 0;
