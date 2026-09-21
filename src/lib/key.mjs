// `routr key set`: store the TypeSafe API key without it passing through an agent's transcript. The USER runs this in
// their own terminal; the key is typed with no echo (or piped in) and written to ~/.config/routr/env, owner-only.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ask, KEY_FILES } from "./jev.mjs";

export const KEYS_URL = "https://console.typesafe.ai/keys";

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(prompt);
    let buf = "";
    input.setRawMode(true); input.resume(); input.setEncoding("utf8");
    const done = (fn, v) => { input.setRawMode(false); input.pause(); input.removeListener("data", onData); process.stderr.write("\n"); fn(v); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(resolve, buf);
        if (ch === "\u0003") return done(reject, new Error("cancelled"));           // Ctrl+C
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1); else buf += ch;   // backspace, else keep (paste arrives as one chunk)
      }
    };
    input.on("data", onData);
  });
}

export async function setKey({ file = KEY_FILES[0], verify = true } = {}) {
  let key;
  if (process.stdin.isTTY) {
    console.error(`Sign in at ${KEYS_URL}, create an API key, and paste it here. It will not be shown.`);
    key = await readHidden("TypeSafe API key: ");
  } else {
    key = await new Promise((resolve) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => resolve(s)); });
  }
  key = key.trim().replace(/^TYPESAFE_API_KEY=/, "").replace(/^["']|["']$/g, "");
  if (key.length < 12 || /\s/.test(key)) return { ok: false, error: "that does not look like an API key; nothing was written" };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `TYPESAFE_API_KEY=${key}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {} // an existing file keeps its old mode unless we set it; no-op on Windows
  const out = { ok: true, file, works: null };
  if (verify) {
    process.env.TYPESAFE_API_KEY = key;
    try { const r = await ask({ task: { brief: "Fix a typo in README.md" } }, { ping: { type: "noul", instructions: "Does `task.brief` describe a software task?" } }, undefined, 10000); out.works = true; out.ms = Math.round(r.latencyMs); }
    catch (e) { out.works = false; out.error = `saved, but the test call failed: ${String(e?.message ?? e).slice(0, 140)}`; }
  }
  return out; // never includes the key
}
