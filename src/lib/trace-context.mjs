// W3C Trace Context 1.1: future versions retain the first four fields; v00 has exactly 55 bytes.
export function parseTraceparent(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/);
  if (!m || m[1] === "ff" || /^0+$/.test(m[2]) || /^0+$/.test(m[3]) || (m[1] === "00" ? m[5] !== "" : m[5] !== "" && !m[5].startsWith("-"))) return null;
  return { traceId: m[2], spanId: m[3], sampled: Boolean(parseInt(m[4], 16) & 1) };
}

// Stage 2 probes, 2026-10-25: Codex's thread is UUIDv7; Claude's own record and Cursor/Antigravity use UUIDv4.
const uuid = (version) => new RegExp(`^[a-f0-9]{8}-[a-f0-9]{4}-${version}[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`);
const SOURCES = [["CLAUDE_CODE_SESSION_ID", uuid(4)], ["CODEX_THREAD_ID", uuid(7)], ["CURSOR_CONVERSATION_ID", uuid(4)], ["ANTIGRAVITY_CONVERSATION_ID", uuid(4)]];
export const sessionId = (id) => typeof id === "string" && (uuid("[47]").test(id) || /^[a-f0-9]{16,64}$/.test(id)) ? id : null;
export function leadSession(env, explicit) {
  for (const [key, format] of SOURCES) if (typeof env[key] === "string" && format.test(env[key])) return env[key];
  return sessionId(explicit);
}
