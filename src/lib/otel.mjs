// The OTLP boundary: consent, encoding, queue and detached delivery. Separate from anonymous outcome telemetry (V10).
import { isIP } from "node:net";
import { request as httpRequest, validateHeaderName } from "node:http";
import { request as httpsRequest } from "node:https";
import { readSecretsFile } from "./systemone.mjs";
import { SECRETS_FILE } from "./providers.mjs";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { folderId, home as userHome, lockIsStale, olderThan, spawnSelf, takeLock, UNINSTALL_LOCK, writeJsonAtomic } from "./runtime.mjs";
import { ROUTR_VERSION } from "./version.mjs";

const RESERVED_HEADERS = new Set(["content-type", "content-length", "host", "transfer-encoding", "connection", "accept-encoding"]);
// W3-5: only RFC3986's unreserved bytes survive storage, including in names. Quote stripping cannot alter a secret.
const escaped = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function parseOtelHeaders(text) {
  try {
    if (typeof text !== "string" || !text.trim() || /[\r\n]/.test(text)) throw 0;
    const headers = Object.create(null), seen = new Set();
    for (const pair of text.split(",")) {
      const at = pair.indexOf("=");
      if (at < 1) throw 0;
      const name = decodeURIComponent(pair.slice(0, at).trim()), value = decodeURIComponent(pair.slice(at + 1).trim()), lower = name.toLowerCase();
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

export function otelEndpoint(value) {
  try {
    if (typeof value !== "string" || /[\s?#\\]/.test(value)) throw 0;
    const u = new URL(value), host = u.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
    if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) || u.username || u.password || /\/\/[^/]*@/.test(value)) throw 0;
    return u.href.replace(/\/+$/, "");
  } catch { throw new Error("invalid OpenTelemetry endpoint: use https, or http on loopback, without userinfo, query or fragment"); }
}

export function otelSwitch(config, env = process.env) {
  let why = null, endpoint = null;
  if (String(env.OTEL_SDK_DISABLED).toLowerCase() === "true") why = "OTEL_SDK_DISABLED=true";
  else if (env.ROUTR_OTEL === "0") why = "ROUTR_OTEL=0";
  else if (!config?.otel?.endpoint) why = "no endpoint configured";
  else if (!/^[0-9a-f]{32}$/.test(config.otel.consent ?? "")) why = "missing or malformed consent";
  else try { endpoint = otelEndpoint(config.otel.endpoint); } catch { why = "invalid endpoint"; }
  return { on: !why, why_off: why, endpoint, consent: why ? null : config.otel.consent };
}

export function otelResource({ home = userHome(), platform = process.platform } = {}) {
  const dir = join(home, ".local/state/routr"), file = join(dir, "service-instance-id");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { return resource(readFileSync(file, "utf8").trim(), platform); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  // Exclusive publication of a complete id: opening the final file with wx exposes an empty file to the other first
  // run (W3-8). A hard link creates exclusively too, but no reader can see the id before its bytes are written.
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, randomUUID(), { flag: "wx", mode: 0o600 });
  try { try { linkSync(tmp, file); } catch (e) { if (e?.code !== "EEXIST") throw e; } }
  finally { unlinkSync(tmp); }
  return resource(readFileSync(file, "utf8").trim(), platform);
}
const resource = (id, platform) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid service instance id");
  return { "service.name": "routr", "service.version": ROUTR_VERSION,
    "os.type": ({ win32: "windows", sunos: "solaris", aix: "aix", darwin: "darwin", linux: "linux", freebsd: "freebsd", openbsd: "openbsd" })[platform] ?? "unknown",
    "service.instance.id": id }; // The next change adds routr.otel.schema here, and schemaUrl at the batch below.
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

const SIGNALS = ["traces", "logs", "metrics"], CAP = 10 * 1024 * 1024, WEEK = 7 * 86400_000;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const BATCH = new RegExp(`^(\\d+)-([a-f0-9]{8})-(${UUID})\\.json$`), DROP = new RegExp(`^${UUID}\\.json$`);
const paths = (home = userHome()) => {
  const root = join(home, ".cache/routr/otel");
  return { root, lock: join(root, "sender.lock"), state: join(root, "sender.json"), secrets: join(home, ".config/routr/env"), config: join(home, ".config/routr/config.json"), uninstall: UNINSTALL_LOCK(home) };
};
const names = (dir) => { try { return readdirSync(dir); } catch (e) { if (e?.code === "ENOENT") return []; throw e; } };
const readConfig = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
function queued(p, signal) {
  const dir = join(p.root, signal);
  return names(dir).filter((n) => BATCH.test(n)).flatMap((name) => {
    const file = join(dir, name), st = lstatSync(file);
    return st.isFile() ? [{ file, name, signal, size: st.size, mtime: st.mtimeMs, nonce: name.match(BATCH)[2] }] : [];
  }).sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
}
export function prepareOtel({ home = userHome() } = {}) {
  const p = paths(home);
  if (existsSync(p.uninstall)) return false;
  for (const name of [...SIGNALS, "drops"]) mkdirSync(join(p.root, name), { recursive: true, mode: 0o700 });
  return !existsSync(p.uninstall);
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
  if (!initial.on) return { queue() {} };
  return { queue(signal, requestBody) {
    try {
      const { home = userHome(), configPath, write = writeJsonAtomic, capBytes = CAP, now = Date.now } = opts, p = paths(home);
      const current = otelSwitch(readConfig(configPath ?? p.config), env);
      if (!SIGNALS.includes(signal) || !current.on || current.consent !== initial.consent || current.endpoint !== initial.endpoint || existsSync(p.uninstall)) return;
      const marker = (code) => { try { write(join(p.root, "drops", `${randomUUID()}.json`), { code }, { mkdir: false }); } catch {} };
      try {
        const size = Buffer.byteLength(JSON.stringify(requestBody) + "\n");
        if (queued(p, signal).reduce((n, f) => n + f.size, 0) + size > 2 * capBytes) marker("ceiling");
        else write(join(p.root, signal, `${now()}-${initial.consent.slice(0, 8)}-${randomUUID()}.json`), requestBody, { mkdir: false });
      } catch { marker("write_failed"); }
      startOtelSender(opts);
    } catch {} // V10: even a full disk must not change the command's result or duration by waiting on delivery
  } };
}

export function otelStatus(config, env = process.env, { home = userHome(), now = Date.now } = {}) {
  const p = paths(home), sw = otelSwitch(config, env), st = readConfig(p.state);
  let files = [], headers = "not set";
  try { files = SIGNALS.flatMap((s) => queued(p, s)); } catch {}
  try { if (Object.keys(otelHeaders(p.secrets)).length) headers = "set"; } catch {}
  return { on: sw.on, why_off: sw.why_off, endpoint_origin: sw.endpoint ? new URL(sw.endpoint).origin : null, headers,
    last_export: st.last_export ?? null, queued_files: files.length, oldest_age_sec: files.length ? Math.max(0, Math.floor((now() - Math.min(...files.map((f) => f.mtime))) / 1000)) : null,
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
    const body = reply.body ? JSON.parse(reply.body) : {};
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
  if (/^\d+$/.test(value)) return Number.isSafeInteger(Number(value) * 1000) ? Number(value) * 1000 : 0;
  const t = Date.parse(value); return Number.isFinite(t) ? Math.max(0, t - now) : 0;
};
export async function sendOtel({ home = userHome(), configPath, env = process.env, write = writeJsonAtomic, timeoutMs = 10_000, now = Date.now, random = Math.random, capBytes = CAP, release = unlinkSync, began = performance.now() } = {}) {
  const p = paths(home), configFile = configPath ?? p.config;
  if (existsSync(p.uninstall)) return;
  if (!existsSync(p.root) && (!otelSwitch(readConfig(configFile), env).on || !prepareOtel({ home }))) return;
  if (!takeLock(p.lock, (f) => olderThan(5 * 60_000)(f) || lockIsStale(f))) return;
  const lockId = folderId(p.lock, { link: true });
  let healthy = true;
  const held = () => lockId && folderId(p.lock, { link: true }) === lockId && !existsSync(p.uninstall);
  const st = { ...freshState(), ...readConfig(p.state) };
  const save = () => { if (!held()) throw new Error("sender stopped"); write(p.state, st, { mkdir: false }); };
  const remove = (file, code) => { if (!held()) throw 0; countDrop(st, code); save(); unlinkSync(file); };
  const sweep = () => {
    if (!held()) return;
    // Sweep against configured consent even with a process-local off switch: that switch revokes no other process's
    // batches. Removing/changing the setting does (V4). Backoff belongs to that generation too.
    const configured = otelSwitch(readConfig(configFile), {}), nonce = configured.consent?.slice(0, 8);
    if (st.consent !== configured.consent) { st.consent = configured.consent; st.attempt = 0; st.next_attempt_at = null; save(); }
    for (const name of names(join(p.root, "drops")).filter((n) => DROP.test(n))) {
      const file = join(p.root, "drops", name);
      if (!lstatSync(file).isFile()) continue;
      const code = readConfig(file).code;
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
        const file = join(dir, name), st = lstatSync(file);
        if (held() && st.isFile() && now() - st.mtimeMs > 3600_000) unlinkSync(file);
      }
    }
  };
  try {
    // W3-10: lock ownership, not a file's age, proves there is no other sender's in-flight claim to disturb.
    for (const signal of SIGNALS) for (const name of names(join(p.root, signal))) {
      if (!name.endsWith(".sending") || !BATCH.test(name.slice(0, -8))) continue;
      const file = join(p.root, signal, name);
      if (held() && lstatSync(file).isFile()) renameSync(file, file.slice(0, -8));
    }
    save(); // prove backoff can be recorded before making the first request
    sweep();
    while (held() && performance.now() - began < 60_000) {
      const sw = otelSwitch(readConfig(configFile), env);
      if (!sw.on || st.next_attempt_at > now()) break;
      const file = SIGNALS.flatMap((s) => queued(p, s))[0];
      if (!file) break;
      const sending = `${file.file}.sending`;
      renameSync(file.file, sending);
      const current = otelSwitch(readConfig(configFile), env);
      if (!held() || current.consent !== sw.consent || current.endpoint !== sw.endpoint || file.nonce !== current.consent?.slice(0, 8)) {
        if (held()) renameSync(sending, file.file);
        break;
      }
      const reply = await postOtel(new URL(`${sw.endpoint}/v1/${file.signal}`), readFileSync(sending), otelHeaders(p.secrets), timeoutMs);
      const ok = reply.status >= 200 && reply.status < 300, retry = Boolean(reply.error) || [429, 502, 503, 504].includes(reply.status);
      const code = reply.error ?? `http_${reply.status}`, partial = ok ? accepted(reply, file.signal) : {};
      st.last_export = { at: new Date(now()).toISOString(), ok, sent: ok ? 1 : 0, refused: partial.code === "rejected" ? partial.count : !ok && !retry ? 1 : 0, error: ok ? null : code };
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
      if (retry) { renameSync(sending, file.file); break; }
      unlinkSync(sending);
    }
    sweep(); // even an off exit removes every old-consent batch; only this process ever deletes queue files
  } catch { healthy = false; } // detached: no outside prose or response body is ever logged
  finally { if (folderId(p.lock, { link: true }) === lockId) try { release(p.lock); } catch { healthy = false; } }
  // W3-10: a command may have observed the held lock just after the empty read. Release, then rescan; preserve the
  // original monotonic lifetime and the persisted backoff, so neither a busy writer nor a clock jump extends it.
  try {
    if (healthy && !existsSync(p.uninstall) && performance.now() - began < 60_000 && !(st.next_attempt_at > now()) && otelSwitch(readConfig(configFile), env).on && SIGNALS.some((s) => queued(p, s).length))
      return sendOtel({ home, configPath, env, write, timeoutMs, now, random, capBytes, release, began });
  } catch {}
}
