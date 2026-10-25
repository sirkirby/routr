// Explicit fixture-only smoke: never loaded for side effects by bun test. No subscription, no real harness.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { TRACE_ATTRIBUTES, ERROR_CODES } from "../src/lib/traces.mjs";
import { OTEL_RESOURCE_ATTRIBUTES, otelEndpoint, prepareOtel, newOtelConsent } from "../src/lib/otel.mjs";
import { generations, genFile } from "../src/lib/channel.mjs";
import { DEFAULTS } from "../src/lib/config.mjs";
import { start, stop, harnessEnv } from "../src/lib/runtime.mjs";
import { briefSha } from "../src/lib/ledger.mjs";
import { launch } from "../src/lib/launch.mjs";
import { cleanup } from "../src/lib/cleanup.mjs";
import { runHerdr } from "../src/lib/herdr.mjs";
import { fixtureCommand } from "./smoke-carriers.mjs";

export const smokeParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
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
export function fixturePaneRun(fixture, { run = runHerdr, cwd, runtime = process.execPath, shell = process.platform === "win32" ? "powershell" : "posix" } = {}) {
  return async (a, ms) => {
    const ok = (result) => ({ ok: true, data: { result } });
    if (a[0] !== "agent") return run(a, ms);
    if (a[1] === "start") {
      const r = await run(["pane", "run", a[a.indexOf("--pane") + 1], fixtureCommand(shell, runtime, fixture)], ms);
      return r.ok ? ok({}) : r; // Herdr 0.9.5 pane run succeeds with no JSON; agent start's boundary needs an envelope.
    }
    if (a[1] === "get") return ok({ agent: { agent: "claude", agent_status: "idle", interactive_ready: true, cwd } });
    return ok({});
  };
}
export async function smokeOtel({ env: original = process.env, log = console.log } = {}) {
  // Short homes on Darwin are necessary for its 103-byte Unix-socket address bound (headless p36 measurement).
  const home = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ro-")), bin = join(home, "bin"), batches = [], children = new Set();
  mkdirSync(bin); const fixture = makeFixture(bin), configPath = join(home, ".config/routr/config.json");
  const never = ["PRIVATE_BRIEF_MARKER", "PRIVATE_REPORT_MARKER", "PRIVATE_REPLY_MARKER", "PRIVATE_NOTE_MARKER", "PRIVATE_HEADER_MARKER", "PRIVATE_KEY_MARKER", "PRIVATE_BAGGAGE_MARKER", "PRIVATE_SCREEN_MARKER"];
  let hold = false, held = false, pane = null;
  const server = createServer(async (req, res) => {
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
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const system = process.platform === "win32" ? [join(original.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];
  const cleanSystem = system.filter((dir) => !["claude", "codex", "cursor-agent", "agy", "kiro-cli"].some((name) => ["", ".exe", ".cmd", ".bat"].some((ext) => existsSync(join(dir, name + ext)))));
  const env = { ...harnessEnv(original), HOME: home, USERPROFILE: home, PATH: [bin, ...cleanSystem].join(delimiter), ROUTR_DECISION_MODEL: "", OLLAMA_HOST: "", ROUTR_NO_UPDATE: "1", ROUTR_NO_REFRESH: "1",
    ROUTR_SMOKE_ENV_FILE: join(home, "fixture-env.json"), TYPESAFE_API_KEY: never[5], CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", ROUTR_OTEL: "1", OTEL_SDK_DISABLED: "false",
    TRACEPARENT: smokeParent, TRACESTATE: "vendor=fixture", BAGGAGE: never[6] };
  delete env.CODEX_SANDBOX; delete env.SANDBOX_RUNTIME;
  const script = fileURLToPath(new URL("../src/routr.mjs", import.meta.url));
  const cli = async (args) => {
    const child = start(process.execPath, [script, ...args], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
    let out = "", err = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    const code = await new Promise((r, reject) => { child.once("error", reject); child.once("close", r); }); children.delete(child);
    check(code === 0, `command ${args[0]} failed (${code}): ${err.slice(0, 160)}`); return JSON.parse(out);
  };
  const senderPid = () => { try { const v = JSON.parse(readFileSync(join(home, ".cache/routr/otel/sender.lock"), "utf8")); return Number.isSafeInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null; } catch { return null; } };
  const queueIdle = () => !senderPid() && !readdirSync(join(home, ".cache/routr/otel/traces")).some((n) => /\.(json|sending)$/.test(n));
  const workerDir = join(home, ".local/state/routr/workers/fixture");
  const holderReleased = () => { const gen = generations(workerDir).at(-1); return gen && existsSync(genFile(workerDir, gen, "released")); };
  try {
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
      const run = fixturePaneRun(fixture, { cwd: home });
      const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      try {
        process.env.HOME = process.env.USERPROFILE = home;
        const deps = { run, env: { ...env, HERDR_ENV: "1" }, settings: () => ({ config }), ready: async () => null };
        const result = await launch([...base, "--name", "pane-fixture", "--direction", "right"], deps); pane = result.pane;
        check(result.ok, "pane fixture launch");
        const removed = await cleanup(["--pane", pane], deps); check(removed.ok, "pane fixture cleanup"); pane = null;
      } finally { for (const [k, v] of Object.entries(previous)) if (v == null) delete process.env[k]; else process.env[k] = v; }
    }
    await until(queueIdle, "initial delivery");
    hold = true; held = false;
    await cli(["usage", "--config", configPath]); await until(() => held, "sender mid-batch");
    const killed = senderPid(); check(killed, "owned sender pid"); process.kill(killed, "SIGKILL");
    await until(() => { try { process.kill(killed, 0); return false; } catch { return true; } }, "killed sender exit");
    hold = false; server.closeAllConnections();
    await cli(["usage", "--config", configPath]); await until(queueIdle, "recovery delivery");
    const checked = checkSmokeTraces(batches, { markers: never, counts: { "routr launch": original.HERDR_ENV === "1" ? 3 : 2, "routr send": 1, "routr wait": 2, "routr cleanup": original.HERDR_ENV === "1" ? 2 : 1, "routr record": 1, "routr usage": 2 } });
    check(checked.duplicates >= 1, "mid-batch recovery kept the same span ids");
    const launchSpan = checked.spans.find((s) => s.traceId === saved.launch.traceId && s.spanId === saved.launch.spanId);
    check(launchSpan, "headless launch arrived");
    for (const name of ["send", "wait", "cleanup", "record"]) check(checked.spans.some((s) => s.name === `routr ${name}` && s.links?.some((l) => l.spanId === saved.launch.spanId && l.traceId === saved.launch.traceId)), `missing ${name} launch link`);
    log(`smoke:otel ok: ${checked.unique} spans, ${checked.duplicates} duplicate records recovered; ${original.HERDR_ENV === "1" ? "pane fixture checked" : "pane fixture skipped (outside herdr)"}`);
    return 0;
  } catch (e) { log(e.message); return 1; }
  finally {
    env.ROUTR_OTEL = "0"; // Failure cleanup must not start another sender after the receiver closes.
    for (const c of children) stop(c);
    if (pane) try { await runHerdr(["pane", "close", pane], 1000); } catch {}
    const pid = senderPid(); if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    // Any fixture holder still live is stopped through routr's own command before its home goes.
    if (existsSync(join(home, ".local/state/routr/workers/fixture/worker.json"))) try { await cli(["stop", "--name", "fixture"]); await cli(["cleanup", "--worker", "fixture"]); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
}
if (import.meta.main) process.exitCode = await smokeOtel();
