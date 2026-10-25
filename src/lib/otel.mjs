// The OTLP boundary: consent, encoding, queue and detached delivery. Separate from anonymous outcome telemetry (V10).
import { LaunchIndex } from "./launch-index.mjs";
import { otelSwitch } from "./otel-settings.mjs";
export { otelEndpoint, otelSwitch } from "./otel-settings.mjs";
import { request as httpRequest, validateHeaderName } from "node:http";
import { request as httpsRequest } from "node:https";
import { readSecretsFile } from "./systemone.mjs";
import { SECRETS_FILE } from "./providers.mjs";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { home as userHome, lockIsStale, lockOwned, olderThan, releaseFileLock, spawnSelf, takeLock, UNINSTALL_LOCK, writeJsonAtomic } from "./runtime.mjs";
import { ROUTR_VERSION } from "./version.mjs";

const RESERVED_HEADERS = new Set(["content-type", "content-length", "host", "transfer-encoding", "connection", "accept-encoding", "content-encoding", "te", "upgrade", "expect", "trailer", "keep-alive"]);
// W3-5: only RFC3986's unreserved bytes survive storage, including in names. Quote stripping cannot alter a secret.
const escaped = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const trimHeader = (s) => s.replace(/^[ \t]+|[ \t]+$/g, ""); // W3-5: trim() would silently admit edge VT/FF or Unicode spaces
export function parseOtelHeaders(text) {
  try {
    if (typeof text !== "string" || !trimHeader(text) || /[\r\n]/.test(text)) throw 0;
    const headers = Object.create(null), seen = new Set();
    for (const pair of text.split(",")) {
      const at = pair.indexOf("=");
      if (at < 1) throw 0;
      const name = decodeURIComponent(trimHeader(pair.slice(0, at))), value = decodeURIComponent(trimHeader(pair.slice(at + 1))), lower = name.toLowerCase();
      validateHeaderName(name);
      if (seen.has(lower) || RESERVED_HEADERS.has(lower) || /[^\x09\x20-\x7e]/.test(value)) throw 0;
      seen.add(lower); headers[name] = value;
    }
    return { headers, stored: Object.entries(headers).map(([k, v]) => `${escaped(k)}=${escaped(v)}`).join(",") };
  } catch { throw new Error("invalid OpenTelemetry headers; nothing was written"); }
}
export function otelHeaders(file = SECRETS_FILE) {
  const text = readSecretsFile(file).ROUTR_OTEL_HEADERS;
  return text === undefined ? {} : parseOtelHeaders(text).headers; // V11: never read the environment for this secret
}

// Stage 2 prep amendment, core semconv 1.44.0: an application process is an instance. No identity file for traces/logs.
const PROCESS_INSTANCE_ID = randomUUID();
export const OTEL_RESOURCE_ATTRIBUTES = Object.freeze({ "service.name": "string", "service.version": "string", "os.type": "string", "service.instance.id": "string", "routr.otel.schema": "string" });
export const otelResource = ({ platform = process.platform } = {}) => resource(PROCESS_INSTANCE_ID, platform);

// Stage 3's gauge has one stream per install, independent of whichever sender process holds the lock. Its UUIDv5
// uses the convention's namespace and the persisted UUID's UTF-8 text as the name; no shipped caller uses it yet.
export function otelGaugeInstanceId({ home = userHome() } = {}) {
  const id = installInstanceId(home);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error("invalid installation id");
  const bytes = createHash("sha1").update(Buffer.from("4d63009a8d0f11eeaad74c796ed8e320", "hex")).update(id, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}
function installInstanceId(home) {
  const dir = join(home, ".local/state/routr"), file = join(dir, "service-instance-id");
  const permitted = () => { if (existsSync(UNINSTALL_LOCK(home)) || !lstatSync(dir).isDirectory()) throw new Error("gauge identity unavailable during uninstall or without its state folder"); };
  permitted();
  try { return readFileSync(file, "utf8").trim(); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  // Exclusive publication of a complete id: opening the final file with wx exposes an empty file to the other first
  // run (W3-8). A hard link creates exclusively too, but no reader can see the id before its bytes are written.
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  permitted();
  writeFileSync(tmp, randomUUID(), { flag: "wx", mode: 0o600 });
  try { permitted(); try { linkSync(tmp, file); } catch (e) { if (e?.code !== "EEXIST") throw e; } }
  finally { try { unlinkSync(tmp); } catch (e) { if (e?.code !== "ENOENT") throw e; } }
  return readFileSync(file, "utf8").trim();
}
const resource = (id, platform) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid service instance id");
  return { "service.name": "routr", "service.version": ROUTR_VERSION,
    "os.type": ({ win32: "windows", sunos: "solaris", aix: "aix", darwin: "darwin", linux: "linux", freebsd: "freebsd", openbsd: "openbsd" })[platform] ?? "unknown",
    "service.instance.id": id, "routr.otel.schema": "genai@9ffc7e00;semconv@1.44.0;routr@1" };
};

export function otlpValue(v) {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "bigint" || Number.isSafeInteger(v)) return { intValue: String(v) };
  if (typeof v === "number" && Number.isFinite(v)) return { doubleValue: v };
  if (v instanceof Uint8Array) return { bytesValue: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(otlpValue) } };
  if (v && typeof v === "object") return { kvlistValue: { values: otlpAttributes(v) } };
  throw new Error("invalid OTLP attribute");
}
export const otlpAttributes = (values = {}) => Object.entries(values).map(([key, value]) => ({ key, value: otlpValue(value) }));
export const otlpScope = ({ name = "routr", version = ROUTR_VERSION, attributes = {} } = {}) => ({ name, version, attributes: otlpAttributes(attributes) });
const hex = (v, n) => { if (typeof v !== "string" || !new RegExp(`^[a-f0-9]{${n}}$`, "i").test(v) || /^0+$/.test(v)) throw new Error("invalid OTLP id"); return v.toLowerCase(); };
const nanos = (v) => { if (!/^[0-9]+$/.test(String(v)) || (typeof v === "number" && !Number.isSafeInteger(v))) throw new Error("invalid OTLP time"); return String(v); };
const integer = (v) => { if (!Number.isInteger(v) || v < 0) throw new Error("invalid OTLP enum or count"); return v; };
const counts = (v, fields) => Object.fromEntries(fields.filter((k) => v[k] !== undefined).map((k) => [k, integer(v[k])]));
function spanJson(s) {
  const out = { traceId: hex(s.traceId, 32), spanId: hex(s.spanId, 16), name: s.name, kind: integer(s.kind ?? 1),
    startTimeUnixNano: nanos(s.startTimeUnixNano), endTimeUnixNano: nanos(s.endTimeUnixNano), attributes: otlpAttributes(s.attributes),
    ...counts(s, ["flags", "droppedAttributesCount", "droppedEventsCount", "droppedLinksCount"]) };
  if (s.parentSpanId) out.parentSpanId = hex(s.parentSpanId, 16);
  if (s.traceState) out.traceState = s.traceState;
  if (s.events) out.events = s.events.map((e) => ({ timeUnixNano: nanos(e.timeUnixNano), name: e.name, attributes: otlpAttributes(e.attributes), ...counts(e, ["droppedAttributesCount"]) }));
  if (s.links) out.links = s.links.map((l) => ({ traceId: hex(l.traceId, 32), spanId: hex(l.spanId, 16), ...(l.traceState ? { traceState: l.traceState } : {}), attributes: otlpAttributes(l.attributes), ...counts(l, ["flags", "droppedAttributesCount"]) }));
  if (s.status) out.status = { code: integer(s.status.code), ...(s.status.message ? { message: s.status.message } : {}) };
  return out;
}
// Resource, scope and AnyValue are signal-independent: logs and metrics reuse these parts in Stage 3.
export function encodeTraces(spans, { resource: r, scope, schemaUrl } = {}) {
  return { resourceSpans: [{ resource: { attributes: otlpAttributes(r ?? otelResource()) },
    ...(schemaUrl ? { schemaUrl } : {}), scopeSpans: [{ scope: otlpScope(scope), spans: spans.map(spanJson) }] }] };
}

export const newOtelConsent = () => randomBytes(16).toString("hex");

const SIGNALS = ["traces", "logs", "metrics"], CAP = 10 * 1024 * 1024, WEEK = 7 * 86400_000, RETRY_CAP = 3600_000;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const BATCH = new RegExp(`^(\\d+)-([a-f0-9]{8})-(${UUID})\\.json$`), DROP = new RegExp(`^${UUID}\\.json$`);
const paths = (home = userHome()) => {
  const root = join(home, ".cache/routr/otel");
  return { root, lock: join(root, "sender.lock"), state: join(root, "sender.json"), secrets: join(home, ".config/routr/env"), config: join(home, ".config/routr/config.json"), uninstall: UNINSTALL_LOCK(home) };
};
const names = (dir) => { try { return readdirSync(dir); } catch (e) { if (e?.code === "ENOENT") return []; throw e; } };
// Review D: an absent config revokes export; a failed read or parse gives no evidence about consent and stops a sweep.
const readConfig = (file, missing = {}) => { try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch (e) { return e?.code === "ENOENT" ? missing : null; } };
const statPresent = (file, stat = lstatSync) => { try { return stat(file); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };
function queued(p, signal) {
  const dir = join(p.root, signal);
  return names(dir).filter((n) => BATCH.test(n)).flatMap((name) => {
    const file = join(dir, name);
    try {
      const st = lstatSync(file);
      return st.isFile() ? [{ file, name, signal, size: st.size, mtime: st.mtimeMs, nonce: name.match(BATCH)[2] }] : [];
    } catch (e) { if (e?.code === "ENOENT") return []; throw e; } // W3-10: a sender can claim/remove between list and stat
  }).sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
}
export function prepareOtel({ home = userHome(), sender = false } = {}) {
  const p = paths(home);
  try {
    if (existsSync(p.uninstall)) return false;
    if (!sender) {
      mkdirSync(p.root, { recursive: true, mode: 0o700 });
      if (existsSync(p.uninstall)) return false;
      mkdirSync(join(home, ".local/state/routr"), { recursive: true, mode: 0o700 });
    }
    if (!lstatSync(p.root).isDirectory()) return false;
    for (const name of [...SIGNALS, "drops"]) {
      if (existsSync(p.uninstall)) return false;
      const dir = join(p.root, name);
      try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e?.code !== "EEXIST" || !lstatSync(dir).isDirectory()) throw e; }
    }
    return !existsSync(p.uninstall);
  } catch { return false; }
}
export const otelSenderRunning = (home = userHome()) => {
  try { const p = paths(home); return existsSync(p.lock) && !olderThan(5 * 60_000)(p.lock) && !lockIsStale(p.lock); } catch { return false; }
};
export function startOtelSender({ home = userHome(), configPath, spawn = spawnSelf } = {}) {
  try {
    const p = paths(home);
    if (existsSync(p.uninstall) || !existsSync(p.root) || otelSenderRunning(home)) return false;
    // Taking the lock belongs to the child. Bursting starts can race here; only the exclusive lock winner sends.
    return spawn(["--otel-sender", "--config", configPath ?? p.config]);
  } catch { return false; }
}
// The command seam: start captures consent without any I/O. End re-reads it, writes once, starts detached, returns.
export function otelSession(config, env = process.env, opts = {}) {
  const initial = otelSwitch(config, env);
  if (!initial.on) return { on: false, queue() {} };
  return { on: true, queue(signal, requestBody) {
    try {
      const { home = userHome(), configPath, write = writeJsonAtomic, capBytes = CAP, now = Date.now } = opts, p = paths(home);
      const current = otelSwitch(readConfig(configPath ?? p.config), env);
      if (!SIGNALS.includes(signal) || !current.on || current.consent !== initial.consent || current.endpoint !== initial.endpoint || existsSync(p.uninstall)) return;
      const marker = (code) => { try { write(join(p.root, "drops", `${randomUUID()}.json`), { code }, { mkdir: false, mode: 0o600 }); } catch {} };
      try {
        const size = Buffer.byteLength(JSON.stringify(requestBody) + "\n");
        if (queued(p, signal).reduce((n, f) => n + f.size, 0) + size > 2 * capBytes) marker("ceiling");
        else {
          write(join(p.root, signal, `${now()}-${initial.consent.slice(0, 8)}-${randomUUID()}.json`), requestBody, { mkdir: false, mode: 0o600 });
          startOtelSender(opts); return true;
        }
      } catch { marker("write_failed"); }
      startOtelSender(opts);
    } catch {} // V10: even a full disk must not change the command's result or duration by waiting on delivery
  } };
}

export function otelStatus(config, env = process.env, { home = userHome(), now = Date.now } = {}) {
  const p = paths(home), sw = otelSwitch(config, env), st = readConfig(p.state) ?? {};
  let files = [], headers = "not set";
  try { files = SIGNALS.flatMap((s) => queued(p, s)); } catch {}
  try { if (Object.keys(otelHeaders(p.secrets)).length) headers = "set"; } catch { headers = "invalid"; }
  let queueError = null;
  if (sw.on) {
    if (existsSync(p.uninstall)) queueError = "OpenTelemetry queue is unavailable during uninstall; run routr setup after it finishes";
    else try { if (![p.root, ...[...SIGNALS, "drops"].map((s) => join(p.root, s))].every((dir) => lstatSync(dir).isDirectory())) throw 0; }
    catch { queueError = "OpenTelemetry queue folders are missing or unreadable: run routr setup to repair them"; }
  }
  return { on: sw.on, why_off: sw.why_off, endpoint_origin: sw.endpoint ? new URL(sw.endpoint).origin : null, headers, can_queue: sw.on && !queueError, queue_error: queueError,
    last_export: st.last_export ?? null, queued_files: files.length, oldest_age_sec: files.length ? Math.max(0, Math.floor((now() - files.reduce((oldest, f) => Math.min(oldest, f.mtime), Infinity)) / 1000)) : null,
    dropped_total: st.dropped_total ?? 0, dropped_by_code: st.dropped_by_code ?? {} };
}

const freshState = () => ({ attempt: 0, next_attempt_at: null, last_export: null, dropped_total: 0, dropped_by_code: {} });
function postOtel(url, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    let done = false, req, timer;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    try {
      req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Accept-Encoding": "identity", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) { finish({ status: res.statusCode, retryAfter: res.headers["retry-after"] }); res.destroy(); return; }
        const chunks = []; let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > 65536) { finish({ status: res.statusCode, unreadable: true, retryAfter: res.headers["retry-after"] }); res.destroy(); }
          else chunks.push(c);
        });
        const received = () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString(), retryAfter: res.headers["retry-after"] });
        res.on("end", received);
        res.on("error", () => finish({ status: res.statusCode, unreadable: true, retryAfter: res.headers["retry-after"] }));
      });
      // A wall deadline, including DNS, connection and a trickling body; socket inactivity alone is not a deadline.
      timer = setTimeout(() => { finish({ error: "timeout" }); req.destroy(); }, timeoutMs);
      req.on("upgrade", (res, socket) => { finish({ status: res.statusCode }); socket.destroy(); });
      req.on("error", () => finish({ error: "network" }));
      req.end(body);
    } catch { finish({ error: "network" }); req?.destroy(); }
  });
}

function countDrop(st, code, n = 1) {
  st.dropped_by_code[code] = (st.dropped_by_code[code] ?? 0) + n;
  if (code !== "partial_warning" && code !== "response_unreadable") st.dropped_total += n;
}
function accepted(reply, signal) {
  if (reply.unreadable) return { code: "response_unreadable", count: 1 };
  try {
    const body = JSON.parse(reply.body);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw 0;
    const partial = body.partialSuccess;
    if (!partial) return {};
    const raw = partial[{ traces: "rejectedSpans", logs: "rejectedLogRecords", metrics: "rejectedDataPoints" }[signal]] ?? 0;
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) throw 0;
    const count = Number(raw);
    return count > 0 ? { code: "rejected", count } : partial.errorMessage ? { code: "partial_warning", count: 1 } : {};
  } catch { return { code: "response_unreadable", count: 1 }; }
}
const retryAfterMs = (value, now) => {
  if (typeof value !== "string") return 0;
  if (/^\d+$/.test(value)) return Math.min(RETRY_CAP, Number(value) * 1000);
  const t = Date.parse(value); return Number.isFinite(t) ? Math.min(RETRY_CAP, Math.max(0, t - now)) : 0;
};
export async function sendOtel({ home = userHome(), configPath, env = process.env, write = writeJsonAtomic, timeoutMs = 10_000, now = Date.now, random = Math.random, capBytes = CAP, release, stat = lstatSync, monotonic = () => performance.now(), began = monotonic(), beganWall = now(), sweepOnly = false } = {}) {
  const p = paths(home), configFile = configPath ?? p.config;
  if (!readConfig(configFile)) return; // Review 2: unknown config is not a revocation; leave every queued file alone
  if (existsSync(p.uninstall)) return;
  if (!existsSync(p.root)) return; // V4: a delayed detached start after uninstall must not recreate the cache
  if (otelSwitch(readConfig(configFile), env).on && !prepareOtel({ home, sender: true })) return;
  const token = randomUUID();
  if (!takeLock(p.lock, (f) => olderThan(5 * 60_000)(f) || lockIsStale(f), { token })) return;
  let healthy = true;
  const within = (limit) => monotonic() - began < limit && now() - beganWall < limit;
  const held = () => lockOwned(p.lock, token) && within(70_000) && !existsSync(p.uninstall);
  const st = { ...freshState(), ...readConfig(p.state) };
  if (st.next_attempt_at != null && (!Number.isFinite(st.next_attempt_at) || st.next_attempt_at - now() > RETRY_CAP)) st.next_attempt_at = null;
  const save = () => { if (!held()) throw new Error("sender stopped"); write(p.state, st, { mkdir: false, mode: 0o600, preserveOnError: true }); };
  const remove = (file, code) => { if (!held()) throw 0; countDrop(st, code); save(); if (!held()) throw 0; unlinkSync(file); };
  const sweep = async () => {
    if (held()) new LaunchIndex({ home, now }).sweep();
    if (!held()) return;
    // Sweep against configured consent even with a process-local off switch: that switch revokes no other process's
    // batches. Removing/changing the setting does (V4). Backoff belongs to that generation too.
    // Review 3: editors and the legacy Windows replacement can briefly hide the config. Confirm ENOENT before
    // revoking a generation; this delay belongs only to the detached sender, never to a command's queue write.
    const missing = Symbol(); let config = readConfig(configFile, missing);
    if (config === missing) { await new Promise((resolve) => setTimeout(resolve, 250)); config = readConfig(configFile); }
    if (!config) throw new Error("config unreadable");
    if (!held()) return;
    const configured = otelSwitch(config, {}), nonce = configured.consent?.slice(0, 8);
    if (st.consent !== configured.consent) { st.consent = configured.consent; st.attempt = 0; st.next_attempt_at = null; save(); }
    for (const name of names(join(p.root, "drops")).filter((n) => DROP.test(n))) {
      const file = join(p.root, "drops", name);
      if (!statPresent(file, stat)?.isFile()) continue;
      const code = readConfig(file)?.code;
      if (code === "ceiling" || code === "write_failed") remove(file, code);
    }
    for (const signal of SIGNALS) {
      let files = queued(p, signal);
      for (const f of files) if (f.nonce !== nonce) remove(f.file, "consent");
      files = files.filter((f) => f.nonce === nonce);
      let bytes = files.reduce((n, f) => n + f.size, 0);
      for (const f of files) if (now() - f.mtime > WEEK || bytes > capBytes) { remove(f.file, "cap"); bytes -= f.size; }
    }
    for (const dir of [p.root, ...[...SIGNALS, "drops"].map((s) => join(p.root, s))]) {
      for (const name of names(dir)) {
        const m = name.match(/^(.*)\.tmp\.\d+$/);
        if (!m || !(BATCH.test(m[1]) || DROP.test(m[1]) || (dir === p.root && m[1] === "sender.json"))) continue;
        const file = join(dir, name), st = statPresent(file, stat);
        if (st?.isFile() && now() - st.mtimeMs > 3600_000 && held()) unlinkSync(file);
      }
    }
  };
  try {
    // W3-10: lock ownership, not a file's age, proves there is no other sender's in-flight claim to disturb.
    for (const signal of SIGNALS) for (const name of names(join(p.root, signal))) {
      if (!name.endsWith(".sending") || !BATCH.test(name.slice(0, -8))) continue;
      const file = join(p.root, signal, name);
      if (statPresent(file, stat)?.isFile() && held()) renameSync(file, file.slice(0, -8));
    }
    save(); // prove backoff can be recorded before making the first request
    await sweep();
    while (!sweepOnly && held() && within(60_000)) {
      const config = readConfig(configFile); if (!config) throw new Error("config unreadable");
      const sw = otelSwitch(config, env);
      if (!sw.on || st.next_attempt_at > now()) break;
      const file = SIGNALS.flatMap((s) => queued(p, s))[0];
      if (!file) break;
      let headers;
      try { headers = otelHeaders(p.secrets); }
      catch {
        st.last_export = { at: new Date(now()).toISOString(), ok: false, sent: 0, refused: 0, error: "headers_invalid" };
        save(); healthy = false; break; // no claim, no retry loop, and never store the rejected value
      }
      const sending = `${file.file}.sending`;
      if (!held()) break;
      renameSync(file.file, sending);
      const latest = readConfig(configFile); if (!latest) throw new Error("config unreadable");
      const current = otelSwitch(latest, env);
      if (!held() || current.consent !== sw.consent || current.endpoint !== sw.endpoint || file.nonce !== current.consent?.slice(0, 8)) {
        if (held()) renameSync(sending, file.file);
        break;
      }
      const body = readFileSync(sending); if (!held()) break;
      const reply = await postOtel(new URL(`${sw.endpoint}/v1/${file.signal}`), body, headers, timeoutMs);
      // Review E: acknowledge the response under this lock before reading consent again. A broken config must stop
      // the next claim, not turn an accepted batch into an unnecessary resend.
      const ok = reply.status >= 200 && reply.status < 300, retry = Boolean(reply.error) || [429, 502, 503, 504].includes(reply.status);
      const code = reply.error ?? `http_${reply.status}`, partial = ok ? accepted(reply, file.signal) : {};
      st.last_export = { at: new Date(now()).toISOString(), ok, sent: ok ? 1 : 0, refused: !ok && !retry ? 1 : 0, error: ok ? null : code };
      if (partial.code) countDrop(st, partial.code, partial.count);
      if (retry) {
        st.attempt = Math.min(st.attempt + 1, 32);
        const delay = Math.min(60_000, 1000 * 2 ** (st.attempt - 1)) * (0.8 + random() * 0.4);
        st.next_attempt_at = now() + Math.max(Math.round(delay), retryAfterMs(reply.retryAfter, now()));
      } else {
        st.attempt = 0; st.next_attempt_at = null;
        if (!ok) countDrop(st, code);
      }
      save();
      if (!held()) break;
      if (retry) { renameSync(sending, file.file); break; }
      unlinkSync(sending);
    }
    await sweep(); // even an off exit removes every old-consent batch; only this process ever deletes queue files
  } catch { healthy = false; } // detached: no outside prose or response body is ever logged
  finally {
    if (!lockOwned(p.lock, token)) healthy = false;
    else try { if (release) release(p.lock); else releaseFileLock(p.lock, token); } catch { healthy = false; }
  }
  // W3-10: a command may have observed the held lock just after the empty read. Release, then rescan; preserve the
  // original monotonic lifetime and the persisted backoff, so neither a busy writer nor a clock jump extends it.
  try {
    if (!healthy || sweepOnly || existsSync(p.uninstall) || !within(60_000)) return;
    const config = readConfig(configFile); if (!config) return;
    const on = otelSwitch(config, env).on;
    if (!on || (!(st.next_attempt_at > now()) && SIGNALS.some((s) => queued(p, s).length)))
      return sendOtel({ home, configPath, env, write, timeoutMs, now, random, capBytes, release, stat, monotonic, began, beganWall, sweepOnly: !on });
  } catch {}
}
