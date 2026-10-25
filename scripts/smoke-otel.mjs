// Explicit fixture-only smoke: never loaded for side effects by bun test. No subscription, no real harness.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, win32 } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { TRACE_ATTRIBUTES, ERROR_CODES } from "../src/lib/traces.mjs";
import { OTEL_RESOURCE_ATTRIBUTES, otelEndpoint, prepareOtel, newOtelConsent } from "../src/lib/otel.mjs";
import { generations, genFile } from "../src/lib/channel.mjs";
import { DEFAULTS } from "../src/lib/config.mjs";
import { start, stop, harnessEnv, probe } from "../src/lib/runtime.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { launch } from "../src/lib/launch.mjs";
import { cleanup } from "../src/lib/cleanup.mjs";
import { runHerdr } from "../src/lib/herdr.mjs";
import { fixtureCommand } from "./smoke-carriers.mjs";

export const smokeParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
export const SMOKE_ACTIVE = "ROUTR_SMOKE_OTEL_ACTIVE";
export async function guardSmoke(run, { args = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  // The 2026-10-25 runaway inherited a smoke entry point. Refuse before creating a home, receiver or child.
  const marked = (e) => Object.keys(e).some((k) => k.toUpperCase() === SMOKE_ACTIVE);
  if (args.length || marked(env) || marked(process.env)) { log("smoke:otel refused: run without arguments and outside an existing smoke"); return 1; }
  process.env[SMOKE_ACTIVE] = "1";
  try { return await run({ env: { ...env, [SMOKE_ACTIVE]: "1" }, log }); }
  catch (e) { log(`smoke:otel failed: ${e.message}`); return 1; }
  finally { delete process.env[SMOKE_ACTIVE]; }
}
const check = (condition, why) => { if (!condition) throw new Error(`smoke:otel: ${why}`); };
const valueType = (v, type) => type === "string" ? typeof v?.stringValue === "string" : type === "boolean" ? typeof v?.boolValue === "boolean"
  : type === "string[]" ? Array.isArray(v?.arrayValue?.values) && v.arrayValue.values.every((x) => typeof x.stringValue === "string")
    : type === "int" ? typeof v?.intValue === "string" && /^\d+$/.test(v.intValue) : typeof v?.doubleValue === "number" && Number.isFinite(v.doubleValue);
const attributes = (values, allowed) => {
  const out = {};
  for (const { key, value } of values ?? []) { check(allowed[key] && valueType(value, allowed[key]), `unlisted attribute or wrong wire type: ${key}`); out[key] = value.stringValue ?? value.boolValue ?? value.intValue ?? value.doubleValue ?? value.arrayValue; }
  return out;
};
export function checkSmokeTraces(batches, { counts = {}, parent = smokeParent, markers = [] } = {}) {
  const parts = parent.split("-"), unique = new Map(); let total = 0;
  const spans = batches.flatMap((b) => (b.resourceSpans ?? []).flatMap((r) => {
    check(r.schemaUrl === "https://opentelemetry.io/schemas/1.44.0", "resource schema");
    const resource = attributes(r.resource?.attributes, OTEL_RESOURCE_ATTRIBUTES);
    check(resource["service.name"] === "routr" && resource["routr.otel.schema"] === "genai@9ffc7e00;semconv@1.44.0;routr@1", "resource identity");
    return (r.scopeSpans ?? []).flatMap((s) => { check(!s.schemaUrl && s.scope?.name === "routr", "scope schema or identity"); return s.spans ?? []; });
  }));
  for (const marker of markers) check(!JSON.stringify(batches).includes(marker), "content or secret marker escaped");
  for (const s of spans) {
    total++;
    check(/^[a-f0-9]{32}$/.test(s.traceId) && /^[a-f0-9]{16}$/.test(s.spanId), "ids");
    const a = attributes(s.attributes, TRACE_ATTRIBUTES);
    check(!s.events?.length && !s.traceState && !s.status?.message, "free text field");
    check(/^routr (dispatch|subagent|check|usage(?: (claude|codex|cursor|agy|kiro))?|launch|send|wait|workers|stop|cleanup|record)$/.test(s.name) || s.name.startsWith("classify "), "span name");
    check(!s.status || s.status.code === 2 && ERROR_CODES.includes(a["error.type"]), "span error status");
    for (const key of ["routr.cwd", "routr.worktree"]) if (a[key]) check(!/^(?:[\\/]|[A-Za-z]:)/.test(a[key]), "absolute path");
    check(!a["gen_ai.request.model"] || s.name.startsWith("classify "), "model on agent span");
    const key = `${s.traceId}/${s.spanId}`;
    if (unique.has(key)) check(JSON.stringify(unique.get(key)) === JSON.stringify(s), "a duplicate changed its record");
    unique.set(key, s);
  }
  for (const s of unique.values()) {
    const child = spans.find((p) => p.spanId === s.parentSpanId && p.traceId === s.traceId);
    check(child || s.traceId === parts[1] && s.parentSpanId === parts[2], "parentage");
    for (const l of s.links ?? []) check(unique.has(`${l.traceId}/${l.spanId}`), "link target");
  }
  for (const [name, expected] of Object.entries(counts)) check([...unique.values()].filter((s) => s.name === name).length === expected, `unexpected ${name} count`);
  return { unique: unique.size, duplicates: total - unique.size, spans: [...unique.values()] };
}

// Claude's documented stream protocol only. In a pane it prints and exits; it never runs a model or a tool.
export const fixtureHarness = `
const fs = require("node:fs");
const a = process.argv.slice(2), sid = "12345678-1234-4123-8123-123456789abc";
if (a[0] === "auth") { console.log('{"loggedIn":true,"authMethod":"claude.ai"}'); process.exit(0); }
if (!a.includes("--input-format")) { console.log("PRIVATE_SCREEN_MARKER"); process.exit(0); }
if (process.env.ROUTR_SMOKE_ENV_FILE) fs.writeFileSync(process.env.ROUTR_SMOKE_ENV_FILE, JSON.stringify({ TRACEPARENT: process.env.TRACEPARENT, TRACESTATE: process.env.TRACESTATE, BAGGAGE: process.env.BAGGAGE }));
const out = (v) => console.log(JSON.stringify(v)); let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0,i); buf = buf.slice(i+1); JSON.parse(line);
  out({type:"system",subtype:"init",session_id:sid});
  out({type:"assistant",message:{content:[{type:"text",text:"VERDICT: done\\nSUMMARY: PRIVATE_REPORT_MARKER"}]}});
  out({type:"result",subtype:"success",is_error:false,result:"PRIVATE_REPLY_MARKER"});
} });
process.stdin.on("end", () => process.exit(0));
`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function smokeProcessRows(text, platform = process.platform) {
  try {
    if (typeof text !== "string") return null;
    const rows = platform === "win32" ? (() => {
      const json = JSON.parse(text), entries = json == null ? [] : Array.isArray(json) ? json : [json];
      return entries.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, command: r.CommandLine ?? "" }));
    })() : text.split(/\r?\n/).filter((s) => s.trim()).map((s) => {
      const m = s.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/); if (!m) throw 0;
      return { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] };
    });
    const seen = new Set();
    for (const r of rows) {
      if (!Number.isSafeInteger(r.pid) || r.pid < 0 || !Number.isSafeInteger(r.ppid) || r.ppid < 0 || typeof r.command !== "string" || seen.has(r.pid)) return null;
      seen.add(r.pid);
    }
    return rows;
  } catch { return null; }
}
export function smokeProcessesIn(rows, home, { platform = process.platform } = {}) {
  const normalize = (s) => platform === "win32" ? s.replaceAll("\\", "/").toLowerCase() : s;
  const path = normalize(home).replace(/\/+$/, ""); check(path.length > 1, "invalid smoke home");
  return rows.filter((r) => {
    const command = normalize(r.command);
    for (let i = command.indexOf(path); i >= 0; i = command.indexOf(path, i + 1)) {
      if ((i === 0 || /[\s"'=]/.test(command[i - 1])) && (i + path.length === command.length || /[\s"'\\/]/.test(command[i + path.length]))) return true;
    }
    return false;
  });
}
async function listSmokeProcesses() {
  const windows = process.platform === "win32", executable = windows ? win32.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe") : "/bin/ps";
  const args = windows ? ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"] : ["-Aww", "-o", "pid=,ppid=,command="];
  const r = await probe(executable, args, { timeoutMs: 3000, separate: true });
  const rows = r?.code === 0 ? smokeProcessRows(r.out) : null;
  return rows?.length ? rows : null; // Even an empty listing cannot prove the smoke's own processes are gone.
}
export async function teardownSmoke({ home, children = new Set(), pane, closePane, stopWorker, holderPids = new Set() }, {
  list = listSmokeProcesses, kill = (pid) => process.kill(pid, "SIGKILL"), stopChild = stop, pause = sleep, attempts = 40,
} = {}) {
  const errors = [];
  for (const child of children) try { stopChild(child, { group: true }); } catch { errors.push("could not stop a smoke child"); }
  if (pane) try { if (!(await closePane(pane))?.ok) errors.push("could not close the owned smoke pane"); } catch { errors.push("could not close the owned smoke pane"); }
  try { await stopWorker?.(); } catch { errors.push("could not stop the fixture worker through its channel"); }
  const holder = (r) => holderPids.has(r.pid) && /(?:^|\s)workers\s+--hold(?:\s|$)/.test(r.command);
  const owned = (r) => {
    if (/(?:^|\s)(?:--otel-sender|workers\s+--hold)(?:\s|$)/.test(r.command)) return true;
    const norm = (s) => process.platform === "win32" ? s.replaceAll("\\", "/").toLowerCase() : s;
    const command = norm(r.command), runtime = [process.execPath, basename(process.execPath), join(home, "bin/node.exe")].map(norm);
    return runtime.some((exe) => command.startsWith(exe + " ") || command.startsWith(`"${exe}" `))
      && ["fixture.mjs", "claude"].some((f) => smokeProcessesIn([r], join(home, "bin", f)).length);
  };
  for (let attempt = 0; attempt <= attempts; attempt++) {
    let rows; try { rows = await list(); } catch {}
    if (!rows) { errors.push("cannot verify smoke process teardown: process inventory unreadable"); return errors; }
    const inHome = smokeProcessesIn(rows, home).filter((r) => r.pid > 1 && r.pid !== process.pid && owned(r));
    const holders = rows.filter((r) => r.pid !== process.pid && (holder(r) || holderPids.has(r.pid) && !r.command));
    const activeChildren = [...children].filter((c) => c.exitCode == null && c.signalCode == null);
    if (!inHome.length && !holders.length && !activeChildren.length) return errors;
    if (attempt === attempts) { errors.push("smoke processes remain after teardown; home retained for inspection"); return errors; }
    // A home in the command line proves this run's fixture or detached sender. Claim pids without it are checked,
    // but stopped through the worker's authenticated channel rather than signalled by a possibly reused saved pid.
    for (const r of inHome) try { kill(r.pid); } catch (e) { if (e.code !== "ESRCH") errors.push("could not kill an owned smoke process"); }
    await pause(50);
  }
  return errors;
}
async function until(read, what, ms = 10000) {
  const end = Date.now() + ms;
  do { const result = await read(); if (result) return result; await sleep(25); } while (Date.now() < end);
  throw new Error(`smoke:otel: timed out waiting for ${what}`);
}
function makeFixture(bin) {
  const script = join(bin, "fixture.mjs"); writeFileSync(script, fixtureHarness);
  if (process.platform !== "win32") { const exe = join(bin, "claude"); writeFileSync(exe, `#!${process.execPath}\n${fixtureHarness}`); chmodSync(exe, 0o755); }
  else {
    copyFileSync(process.execPath, join(bin, "node.exe"));
    // npm bin-links' recognized shim shape; runtime starts its interpreter directly, never cmd with the prompt.
    writeFileSync(join(bin, "claude.cmd"), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\fixture.mjs" %*\r\n');
  }
  return script;
}
export function fixturePaneRun(fixture, { run = runHerdr, cwd, onPane = () => {}, runtime = process.execPath, shell = process.platform === "win32" ? "powershell" : "posix" } = {}) {
  let splitAttempted = false;
  return async (a, ms) => {
    const ok = (result) => ({ ok: true, data: { result } });
    if (["worktree", "workspace", "tab"].includes(a[0]) && a[1] === "create") throw new Error("smoke:otel permits only its one pane split");
    if (a[0] === "pane" && a[1] === "split") {
      check(!splitAttempted, "only one pane split is permitted"); splitAttempted = true;
      const r = await run(a, ms), id = r?.data?.result?.pane?.pane_id;
      if (r?.ok && typeof id === "string") onPane(id); // Own it before launch can fail during readiness or queueing.
      return r;
    }
    if (a[0] !== "agent") return run(a, ms);
    if (a[1] === "start") {
      const r = await run(["pane", "run", a[a.indexOf("--pane") + 1], fixtureCommand(shell, runtime, fixture)], ms);
      return r.ok ? ok({}) : r; // Herdr 0.9.5 pane run succeeds with no JSON; agent start's boundary needs an envelope.
    }
    if (a[1] === "get") return ok({ agent: { agent: "claude", agent_status: "idle", interactive_ready: true, cwd } });
    return ok({});
  };
}
async function runSmoke({ env: original, log }) {
  // Short homes on Darwin are necessary for its 103-byte Unix-socket address bound (headless p36 measurement).
  const home = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ro-")), bin = join(home, "bin"), batches = [], children = new Set();
  const never = ["PRIVATE_BRIEF_MARKER", "PRIVATE_REPORT_MARKER", "PRIVATE_REPLY_MARKER", "PRIVATE_NOTE_MARKER", "PRIVATE_HEADER_MARKER", "PRIVATE_KEY_MARKER", "PRIVATE_BAGGAGE_MARKER", "PRIVATE_SCREEN_MARKER"];
  let hold = false, held = false, pane = null, server, env, cli, summary;
  const workerDir = join(home, ".local/state/routr/workers/fixture"), holderPids = new Set();
  const rememberHolders = () => {
    for (const n of generations(workerDir)) try {
      const { pid } = JSON.parse(readFileSync(genFile(workerDir, n, "claim"), "utf8"));
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) holderPids.add(pid);
    } catch {}
  };
  try {
    mkdirSync(bin); const fixture = makeFixture(bin), configPath = join(home, ".config/routr/config.json");
    server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const c of req) chunks.push(c);
        const bytes = Buffer.concat(chunks); batches.push(JSON.parse(bytes.toString()));
        if (hold) { held = true; return; } // killed sender's response is deliberately lost after full receipt
        if (original.ROUTR_SMOKE_OTLP_ENDPOINT) {
          const endpoint = otelEndpoint(original.ROUTR_SMOKE_OTLP_ENDPOINT);
          const reply = await fetch(`${endpoint}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: bytes, signal: AbortSignal.timeout(10000), redirect: "error" });
          check(reply.ok, "external receiver refused the fixture batch");
        }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
      } catch { if (!res.destroyed) { if (!res.headersSent) res.writeHead(500); res.end(); } }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const system = process.platform === "win32" ? [join(original.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];
    const cleanSystem = system.filter((dir) => !["claude", "codex", "cursor-agent", "agy", "kiro-cli"].some((name) => ["", ".exe", ".cmd", ".bat"].some((ext) => existsSync(join(dir, name + ext)))));
    env = { ...harnessEnv(original), HOME: home, USERPROFILE: home, PATH: [bin, ...cleanSystem].join(delimiter), ROUTR_DECISION_MODEL: "", OLLAMA_HOST: "", ROUTR_NO_UPDATE: "1", ROUTR_NO_REFRESH: "1",
      ROUTR_SMOKE_ENV_FILE: join(home, "fixture-env.json"), TYPESAFE_API_KEY: never[5], CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", ROUTR_OTEL: "1", OTEL_SDK_DISABLED: "false",
      TRACEPARENT: smokeParent, TRACESTATE: "vendor=fixture", BAGGAGE: never[6] };
    delete env.CODEX_SANDBOX; delete env.SANDBOX_RUNTIME;
    const script = fileURLToPath(new URL("../src/routr.mjs", import.meta.url));
    cli = async (args) => {
      const child = start(process.execPath, [script, ...args], { env, cwd: home, detached: true, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
      let out = "", err = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(child, { group: true }); reject(new Error(`smoke:otel: ${args[0]} command timed out`)); }, 15000);
        child.once("error", (e) => { clearTimeout(timer); reject(e); });
        child.once("close", (code) => { clearTimeout(timer); children.delete(child); resolve(code); });
      });
      rememberHolders();
      check(code === 0, `command ${args[0]} failed (${code}): ${err.slice(0, 160)}`); return JSON.parse(out);
    };
    const senderPid = () => { try { const v = JSON.parse(readFileSync(join(home, ".cache/routr/otel/sender.lock"), "utf8")); return Number.isSafeInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null; } catch { return null; } };
    const queueIdle = () => !senderPid() && !readdirSync(join(home, ".cache/routr/otel/traces")).some((n) => /\.(json|sending)$/.test(n));
    const holderReleased = () => { const gen = generations(workerDir).at(-1); return gen && existsSync(genFile(workerDir, gen, "released")); };
    const config = { ...DEFAULTS, subscriptions: { claude: { enabled: true, hardest_work: "strong", assumed_headroom: 0.5, reserve: 0 } }, telemetry: false,
      otel: { endpoint: `http://127.0.0.1:${server.address().port}`, consent: newOtelConsent() } };
    mkdirSync(join(home, ".config/routr"), { recursive: true }); writeFileSync(configPath, JSON.stringify(config));
    check(prepareOtel({ home }), "prepare isolated exporter");
    writeFileSync(join(home, ".config/routr/env"), `ROUTR_OTEL_HEADERS=Authorization=${never[4]}\n`);
    const advice = join(home, "advice.json"), task = join(home, "task.md");
    writeFileSync(task, never[0]); writeFileSync(advice, JSON.stringify({ mode: "dispatch", id: "abc12345", level: "standard", brief_sha: briefSha(never[0]), fallback: true }));
    const base = ["--kind", "claude", "--model", "fixture", "--cwd", home];
    await cli(["launch", ...base, "--name", "planned", "--dry-run"]);
    const launched = await cli(["launch", ...base, "--name", "fixture", "--task-file", task, "--advice", advice]); check(launched.ok, "fixture launch");
    await cli(["wait", "--name", "fixture"]); await until(holderReleased, "first fixture holder release");
    const saved = JSON.parse(readFileSync(join(home, ".local/state/routr/workers/fixture/worker.json"), "utf8")), got = JSON.parse(readFileSync(env.ROUTR_SMOKE_ENV_FILE, "utf8"));
    check(got.TRACEPARENT === `00-${saved.launch.traceId}-${saved.launch.spanId}-01` && got.BAGGAGE === never[6] && got.TRACESTATE === "vendor=fixture", "first process carriers");
    await cli(["send", "--name", "fixture", "--task", never[0]]); await cli(["wait", "--name", "fixture"]); await until(holderReleased, "resumed fixture holder release");
    await cli(["cleanup", "--worker", "fixture"]);
    await cli(["record", "--advice", advice, "--subscription", "claude", "--model", "fixture", "--effort", "low", "--verdict", "done", "--check", "pass", "--note", never[3]]);
    if (original.HERDR_ENV === "1") {
      // Herdr's agent registry recognizes real harnesses, not a fixture. Only its pane operations are live; agent
      // protocol replies are fixture-owned and agent start runs the absolute fixture, so the server's PATH is irrelevant.
      const run = fixturePaneRun(fixture, { cwd: home, onPane: (id) => { pane = id; } });
      const temporary = { HOME: home, USERPROFILE: home, ROUTR_OTEL: "1", OTEL_SDK_DISABLED: "false", ROUTR_NO_UPDATE: "1", ROUTR_NO_REFRESH: "1" };
      const previous = Object.fromEntries(Object.keys(temporary).map((k) => [k, process.env[k]]));
      try {
        Object.assign(process.env, temporary);
        const deps = { run, env: { ...env, HERDR_ENV: "1" }, settings: () => ({ config }), ready: async () => null };
        const result = await launch([...base, "--name", "pane-fixture", "--direction", "right"], deps);
        check(result.ok, "pane fixture launch");
        const removed = await cleanup(["--pane", pane], deps); check(removed.ok, "pane fixture cleanup"); pane = null;
      } finally { for (const [k, v] of Object.entries(previous)) if (v == null) delete process.env[k]; else process.env[k] = v; }
    }
    await until(queueIdle, "initial delivery");
    hold = true; held = false;
    await cli(["usage", "--config", configPath]); await until(() => held, "sender mid-batch");
    const killed = senderPid(), inventory = await listSmokeProcesses();
    check(killed && inventory && smokeProcessesIn(inventory, home).some((r) => r.pid === killed && /(?:^|\s)--otel-sender(?:\s|$)/.test(r.command)), "owned sender pid");
    process.kill(killed, "SIGKILL");
    await until(() => { try { process.kill(killed, 0); return false; } catch { return true; } }, "killed sender exit");
    hold = false; server.closeAllConnections();
    await cli(["usage", "--config", configPath]); await until(queueIdle, "recovery delivery");
    const checked = checkSmokeTraces(batches, { markers: never, counts: { "routr launch": original.HERDR_ENV === "1" ? 3 : 2, "routr send": 1, "routr wait": 2, "routr cleanup": original.HERDR_ENV === "1" ? 2 : 1, "routr record": 1, "routr usage": 2 } });
    check(checked.duplicates >= 1, "mid-batch recovery kept the same span ids");
    const launchSpan = checked.spans.find((s) => s.traceId === saved.launch.traceId && s.spanId === saved.launch.spanId);
    check(launchSpan, "headless launch arrived");
    for (const name of ["send", "wait", "cleanup", "record"]) check(checked.spans.some((s) => s.name === `routr ${name}` && s.links?.some((l) => l.spanId === saved.launch.spanId && l.traceId === saved.launch.traceId)), `missing ${name} launch link`);
    summary = `smoke:otel ok: ${checked.unique} spans, ${checked.duplicates} duplicate records recovered; ${original.HERDR_ENV === "1" ? "pane fixture checked" : "pane fixture skipped (outside herdr)"}`;
    return 0;
  } catch (e) { log(e.message); return 1; }
  finally {
    if (env) env.ROUTR_OTEL = "0"; // Teardown cannot start a new sender after its verification.
    rememberHolders();
    let errors;
    try { errors = await teardownSmoke({ home, children, pane, holderPids,
      closePane: async (id) => {
        const r = await runHerdr(["pane", "close", id], 1000);
        return r?.ok || r?.data?.error?.code === "pane_not_found" ? { ok: true } : r;
      },
      stopWorker: async () => {
        if (cli && existsSync(join(workerDir, "worker.json"))) { await cli(["stop", "--name", "fixture"]); await cli(["cleanup", "--worker", "fixture"]); }
      },
    }); } catch { errors = ["cannot verify smoke teardown"]; }
    if (server) { server.closeAllConnections(); if (server.listening) await new Promise((r) => server.close(r)); }
    if (errors.length) { for (const error of errors) log(`smoke:otel: ${error}`); throw new Error(`smoke teardown failed; retained ${home}`); }
    rmSync(home, { recursive: true, force: true });
    if (summary) log(summary); // Success includes teardown, not just delivery.
  }
}
export const smokeOtel = (opts, { run = runSmoke } = {}) => guardSmoke(run, opts);
if (import.meta.main) process.exitCode = await smokeOtel();
