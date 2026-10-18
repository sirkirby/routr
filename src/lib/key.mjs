// `routr key set [typesafe|cloudflare]`: store what a decision provider needs without it passing through an agent's
// transcript. The USER runs this in their own terminal; a secret is typed with no echo (or piped in) and merged into
// ~/.config/routr/env, owner-only, beside any other provider's. Ollama needs nothing: it runs on this machine.
import { isProvider, PROVIDER_NAMES, PROVIDERS, SECRETS_FILE } from "./providers.mjs";
import { failureMessage, ping, writeSecrets } from "./systemone.mjs";

export const KEYS_URL = PROVIDERS.typesafe.keysUrl;

function readTyped(prompt, hidden) {
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
        if (ch === "\u007f" || ch === "\b") { if (buf && !hidden) process.stderr.write("\b \b"); buf = buf.slice(0, -1); }
        else { buf += ch; if (!hidden) process.stderr.write(ch); }                 // paste arrives as one chunk
      }
    };
    input.on("data", onData);
  });
}

const readStdin = () => new Promise((resolve) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => resolve(s)); });

// Piped in: one value per line, each as NAME=value or bare. Bare lines fill, in order, the values not given by name.
export function parsePiped(text, secrets) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), out = {};
  const bare = lines.filter((l) => !/^[A-Za-z_][A-Za-z0-9_-]*=/.test(l));
  for (const s of secrets) {
    const named = lines.find((l) => l.startsWith(`${s.name}=`));
    out[s.name] = (named ? named.slice(s.name.length + 1) : bare.shift() ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}

export function checkValue(s, v) {
  if (s.shape) return s.shape.test(v) ? null : `that does not look like a ${s.label}`;
  return v.length < 12 || /\s/.test(v) ? `that does not look like a ${s.label}` : null;
}

export async function setKey({ provider = "typesafe", file = SECRETS_FILE, verify = true } = {}) {
  const P = isProvider(provider) ? PROVIDERS[provider] : null;
  if (!P) return { ok: false, error: `no provider "${provider}": routr key set ${PROVIDER_NAMES.filter((n) => PROVIDERS[n].secrets.length).join("|")}` };
  if (!P.secrets.length) return { ok: true, provider, note: `${P.label} needs no key: it runs on this machine. To use it: routr setup --decision ${provider}` };
  const values = {};
  if (process.stdin.isTTY) {
    console.error(`${P.label}: ${P.get}. A secret is not shown as you type it${P.secrets.some((s) => !s.hidden) ? ` (the ${P.secrets.filter((s) => !s.hidden).map((s) => s.label).join(", ")} is)` : ""}.`);
    for (const s of P.secrets) values[s.name] = (await readTyped(`${s.label}: `, s.hidden)).trim().replace(new RegExp(`^${s.name}=`), "").replace(/^["']|["']$/g, "");
  } else Object.assign(values, parsePiped(await readStdin(), P.secrets));
  for (const s of P.secrets) { const bad = checkValue(s, values[s.name] ?? ""); if (bad) return { ok: false, provider, error: `${bad}; nothing was written` }; if (s.lower) values[s.name] = values[s.name].toLowerCase(); }
  writeSecrets(values, file);
  const out = { ok: true, provider, file, works: null };
  if (verify) {
    // Tested as the provider just set up, whatever the config asks, with the values just typed.
    const env = { ...process.env, ...values };
    try { const r = await ping({ config: { decision: { provider } }, env, file }); out.works = true; out.model = r.model; out.ms = Math.round(r.latencyMs); }
    catch (e) { out.works = false; out.error = `saved, but the test call failed: ${failureMessage(e, { decision: { provider } })}`; }
  }
  return out; // never includes a secret
}
