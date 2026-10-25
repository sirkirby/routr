// The OTLP boundary: consent, encoding, queue and detached delivery. Separate from anonymous outcome telemetry (V10).
import { isIP } from "node:net";
import { validateHeaderName } from "node:http";
import { readSecretsFile } from "./systemone.mjs";
import { SECRETS_FILE } from "./providers.mjs";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { home as userHome } from "./runtime.mjs";
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
