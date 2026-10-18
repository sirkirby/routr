// One comparison for launch and record: advice on a summary or another worker is not advice on this task.
import { readFileSync } from "node:fs";
import { briefSha } from "./ledger.mjs";

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
  try { return JSON.parse(decode(bytes)); } catch { throw new Error("--advice: not JSON; save the dispatch result as JSON"); }
}
export function matchAdvice(advice, task) {
  if (typeof advice?.brief_sha !== "string" || !advice.brief_sha) throw new Error("--advice: missing brief_sha; dispatch the exact task again");
  if (advice.brief_sha !== briefSha(task)) throw new Error("--advice was given on a different text than this task; dispatch the exact task again");
}
export function readTask(file) {
  if (typeof file !== "string" || !file.trim() || /^-\S/.test(file)) throw new Error("--task-file requires a usable path");
  let text;
  try { text = decode(readFileSync(file)); } catch { throw new Error("--task-file: could not read the task file"); }
  if (text == null) throw new Error("--task-file: not readable text; save it as UTF-8 or UTF-16");
  return text;
}
