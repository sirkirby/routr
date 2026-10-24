// Live check that the trace-context carriers routr passes to a pane it splits arrive exactly, inside a live herdr
// session on THIS machine. Run after updating herdr, and before a release that changes worker environment handling
// (AGENTS.md, CONTRIBUTING.md), from a pane of a herdr session:
//   bun run smoke:carriers
// 1. Splits a pane with routr's own split code, its carriers hostile but valid (`%` `"` `&` `!` `;` `,` `=` TAB and
//    spaces, each value exactly at routr's limit), starts a small fixture in that pane's shell that writes its
//    environment to a file, checks each value arrived byte for byte, and closes the pane.
// 2. macOS and Linux: splits another such pane and `herdr agent start`s the installed Claude Code there with no task,
//    reads that agent's own environment (`ps eww <pid>` on macOS, /proc/<pid>/environ on Linux), checks the values, and
//    closes the pane. There is no ordinary way to read another process's environment on Windows, so this half is
//    posix only. No task is sent, so no subscription is spent.
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
// The carriers `sent` that `got` (an environment object) does not hold exactly.
export const missingIn = (got, sent) => Object.keys(sent).filter((name) => got?.[name] !== sent[name]);
// A process's environment as text: /proc/<pid>/environ (NUL-separated entries), or `ps eww <pid>` (the command line,
// then each NAME=value after a space). From ps, a value holding a space cannot be told from the next entry, so each
// carrier is looked for whole, followed by a space or the end.
export function missingInText(text, sent, { proc = false } = {}) {
  if (proc) return missingIn(Object.fromEntries(text.split("\0").filter(Boolean).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)])), sent);
  return Object.keys(sent).filter((name) => { const at = text.indexOf(` ${name}=${sent[name]}`); return at < 0 || ![" ", "\n", undefined].includes(text[at + name.length + sent[name].length + 2]); });
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
  // A pane split with the carriers, its shell at a prompt; closed by the caller.
  const split = async () => {
    const pane = (await call(splitArgs("down", dir, sent))).data.result.pane.pane_id;
    let shell = "posix";
    const r = await waitForShell(paneView(call, pane), { sleep, now: () => performance.now(), remaining: deadline(30000, () => performance.now(), "the pane's shell did not come to a prompt in 30 s"), cwd: dir,
      onShell: (name) => { shell = /^(pwsh|powershell)/i.test(name) ? "powershell" : /^cmd/i.test(name) ? "cmd" : "posix"; } });
    if (!r.ok) throw new Error(`the pane's shell: ${r.why}`);
    return { pane, shell };
  };
  try {
    {
      const { pane, shell } = await split();
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
      const { pane } = await split();
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
        const text = process.platform === "linux" ? readFileSync(`/proc/${pid}/environ`, "utf8") : (await probe("/bin/ps", ["eww", String(pid)], { separate: true }))?.out ?? "";
        say(`agent (claude, pid ${pid})`, missingInText(text, sent, { proc: process.platform === "linux" }));
      } finally { await runHerdr(["pane", "close", pane], 5000); }
    }
  } catch (e) { failed++; log(`FAILED: ${e?.message ?? e}`); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  return failed;
}
if (import.meta.main) process.exitCode = (await main()) ? 1 : 0;
