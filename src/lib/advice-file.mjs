// One comparison for launch and record: advice on a summary or another worker is not advice on this task.
import { fallbackAdvice } from "./output.mjs";
import { readFileSync } from "node:fs";
import { briefSha } from "./ledger.mjs";
import { DECISION_CODES, DecisionError, decisionUnavailable, isProvider } from "./providers.mjs";

// Every file a lead hands routr (advice, task) is read the same way. PowerShell 5.1's > writes UTF-16LE;
// Set-Content -Encoding utf8 writes a UTF-8 BOM. A BOM-less UTF-16 file of text starts with an ASCII character
// followed by NUL, which cannot occur in UTF-8 text. null: an odd length cannot be UTF-16.
function decode(bytes) {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length > 1 && bytes[1] === 0);
  if (utf16 && bytes.length % 2) return null;
  return bytes.toString(utf16 ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
}

export function readAdvice(file) {
  let bytes;
  try { bytes = readFileSync(file); } catch { throw new Error("--advice: could not read it; supply a readable advice file"); }
  let advice;
  try { advice = JSON.parse(decode(bytes)); } catch { throw new Error("--advice: not JSON; save the dispatch result as JSON"); }
  return usableAdvice(advice);
}
export function usableAdvice(advice) {
  if (advice && (advice.ok === false || Object.hasOwn(advice, "error"))) throw new Error("--advice: this is a refused dispatch, not advice; dispatch the exact task again");
  for (const field of ["id", "brief_sha"]) if (typeof advice?.[field] !== "string" || !advice[field].trim()) throw new Error(`--advice: missing ${field}; dispatch the exact task again`);
  return advice;
}
export function matchAdvice(advice, task) {
  usableAdvice(advice);
  if (typeof advice?.brief_sha !== "string" || !advice.brief_sha) throw new Error("--advice: missing brief_sha; dispatch the exact task again");
  if (advice.brief_sha !== briefSha(task)) throw new Error("--advice was given on a different text than this task; dispatch the exact task again");
}
// Saved advice is an outside boundary too: project known fields and regenerate the sentence from its code. A
// missing/invalid identity stays unknown; today's config must never fill in yesterday's attempted model.
export function savedDecisionUnavailable(advice) {
  const entry = Array.isArray(advice.unavailable) ? advice.unavailable.find((u) => u?.part === "decision model") : null;
  if (!entry || !isProvider(entry.provider) || typeof entry.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(entry.model)
    || typeof entry.code !== "string" || !DECISION_CODES.includes(entry.code) || entry.code === "attempt_unknown")
    return { part: "decision model", provider: null, model: null, code: "attempt_unknown", why: new DecisionError({ provider: null, model: null }, "attempt_unknown").message };
  // Rebuilt Ollama hints use today's host, never today's model: that comes from saved advice.
  return decisionUnavailable(new DecisionError(entry, entry.code, entry.status), entry);
}
export function readTask(file) {
  if (typeof file !== "string" || !file.trim() || /^-\S/.test(file)) throw new Error("--task-file requires a usable path");
  let text;
  try { text = decode(readFileSync(file)); } catch { throw new Error("--task-file: could not read the task file"); }
  if (text == null) throw new Error("--task-file: not readable text; save it as UTF-8 or UTF-16");
  return text;
}

export function savedDecisionFailures(advice) {
  const entries = Array.isArray(advice.unavailable) ? advice.unavailable.filter((u) => u?.part === "decision model") : [];
  return entries.length ? entries.map((entry) => savedDecisionUnavailable({ unavailable: [entry] })) : fallbackAdvice(advice) ? [savedDecisionUnavailable(advice)] : [];
}
