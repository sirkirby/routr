// One comparison for launch and record: advice on a summary or another worker is not advice on this task.
import { readFileSync } from "node:fs";
import { briefSha } from "./ledger.mjs";

export function readAdvice(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { throw new Error("--advice: could not read it; supply a readable advice file"); }
  try { return JSON.parse(text); } catch { throw new Error("--advice: not JSON; save the dispatch result as JSON"); }
}
export function matchAdvice(advice, task) {
  if (typeof advice?.brief_sha !== "string" || !advice.brief_sha) throw new Error("--advice: missing brief_sha; dispatch the exact task again");
  if (advice.brief_sha !== briefSha(task)) throw new Error("--advice was given on a different text than this task; dispatch the exact task again");
}
export function readTask(file) {
  if (typeof file !== "string" || !file.trim() || /^-\S/.test(file)) throw new Error("--task-file requires a usable path");
  try { return readFileSync(file, "utf8"); } catch { throw new Error("--task-file: could not read the task file"); }
}
