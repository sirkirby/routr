// Minimal Jev client: raw HTTP, no dependencies. Bun is the supported runtime; only node: built-ins are used. Exposes exact payloads, latency, and tokens.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The key lives outside any project, so workers in worktrees and other folders find it too.
export const KEY_FILES = [join(homedir(), ".config/routr/env")];

export function loadKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY; // the name TypeSafe's own SDKs read
  for (const path of KEY_FILES) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*TYPESAFE[-_](?:AI|API)[-_]KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  throw new Error(`no TypeSafe key: create one at https://console.typesafe.ai/keys, then run \`routr key set\` (or set TYPESAFE_API_KEY)`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let KEY; // loaded lazily so a missing key is a catchable error, not an import-time crash

// model is pinned: question wordings are evaluated per Jev version. deadlineMs is the total budget across retries;
// the router passes a short one so it can never stall an agent.
export async function ask(state, questions, model = "jev-1.13.0", deadlineMs = 60000) {
  KEY ??= loadKey();
  const stopAt = performance.now() + deadlineMs;
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model, questions }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(8000, stopAt - t0))),
    });
    const latencyMs = performance.now() - t0;
    const wait = 500 * 2 ** attempt;
    if ((res.status === 429 || res.status === 529) && attempt < 5 && performance.now() + wait < stopAt) { await sleep(wait); continue; }
    if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { ...(await res.json()), latencyMs };
  }
}
