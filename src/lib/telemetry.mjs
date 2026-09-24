// Telemetry: once a day routr sends its maintainers the ledger rows written since the last send, so its questions are
// tuned on real work instead of the maintainers' own. What a row holds is what `routr share` writes to a file you can
// read: what routr read from each brief (probabilities, level), the Jev version, what was chosen (subscription, model,
// effort, level), and how it turned out. Never the brief or any other text, notes, project names, ids, hashes of briefs,
// usage numbers, or anything about your machine beyond the OS and routr's version. The endpoint refuses rows carrying
// long strings as a backstop (routr-lab/service).
// ON by default, as most developer tools do it, and said so at install, in setup, and in doctor. Off with
// `routr telemetry off` ("telemetry": false in the config), ROUTR_TELEMETRY=0, or DO_NOT_TRACK=1; always off in CI.
// Sending happens only in the detached daily job (update.mjs) or on an explicit command: never inside advice.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_PATH } from "./config.mjs";
import { LEDGER_PATH, read, shareRows } from "./ledger.mjs";
import { ROUTR_VERSION } from "./version.mjs";

export const ENDPOINT = process.env.ROUTR_TELEMETRY_URL || "https://routr-telemetry.goondocks.workers.dev";
const STATE = (ledger = LEDGER_PATH) => join(dirname(ledger), "telemetry.json"); // beside the ledger: { install_id, sent_through }
const OS = `${process.platform}-${process.arch}`;
const off = (v) => /^(0|false|off|no)$/i.test(String(v ?? "").trim());

export function telemetryStatus(config, env = process.env) {
  const why = env.CI ? "running in CI" : env.DO_NOT_TRACK && !off(env.DO_NOT_TRACK) ? "DO_NOT_TRACK is set"
    : off(env.ROUTR_TELEMETRY ?? "1") ? "ROUTR_TELEMETRY is off" : config?.telemetry === false ? "turned off (routr telemetry off)" : null;
  return { on: !why, why_off: why };
}

function state(ledger) { try { return JSON.parse(readFileSync(STATE(ledger), "utf8")); } catch { return {}; } }
function saveState(s, ledger) { mkdirSync(dirname(STATE(ledger)), { recursive: true }); writeFileSync(STATE(ledger), JSON.stringify(s) + "\n"); }
// A random id made on this machine, so rows from one install can be grouped. It is not derived from anything about you.
export function installId(ledger) { const s = state(ledger); if (s.install_id) return s.install_id; s.install_id = randomUUID(); saveState(s, ledger); return s.install_id; }

// Pure: ledger entries → the rows sent. The same rows `routr share` writes, plus the model names and the seconds taken,
// and a key that makes resending harmless without pointing back at the local ledger.
export function telemetryRows(entries, install) {
  return entries.map((e) => ({
    row_key: createHash("sha256").update(`${install}|${e.ts}|${e.id}`).digest("hex").slice(0, 32),
    ...shareRows([e], { withModels: true })[0],
    seconds: Number.isFinite(e.outcome?.seconds) ? e.outcome.seconds : null,
  }));
}

// Sends the rows written since the last successful send. Advances only on success, so a failure is retried next day.
export async function sendRows({ ledger = LEDGER_PATH, fetchFn = fetch, timeoutMs = 15000 } = {}) {
  const s = state(ledger), install = installId(ledger);
  const fresh = read(ledger).filter((e) => !s.sent_through || String(e.ts) > s.sent_through);
  if (!fresh.length) return { ok: true, sent: 0 };
  let sent = 0;
  for (let i = 0; i < fresh.length; i += 500) {
    const batch = fresh.slice(i, i + 500);
    const res = await fetchFn(`${ENDPOINT}/v1/rows`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ install_id: install, version: ROUTR_VERSION, os: OS, rows: telemetryRows(batch, install) }), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, sent, error: `endpoint answered ${res.status}` };
    sent += batch.length;
    saveState({ ...state(ledger), install_id: install, sent_through: String(batch.at(-1).ts) }, ledger);
  }
  return { ok: true, sent };
}

// `routr feedback "<text>"`: the one thing sent that is free text, because the person wrote it to send it.
export async function sendFeedback(text, { fetchFn = fetch, ledger } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, error: 'nothing to send: routr feedback "what worked, what did not"' };
  if (t.length > 4000) return { ok: false, error: `too long (${t.length} characters; 4000 at most)` };
  try {
    const res = await fetchFn(`${ENDPOINT}/v1/feedback`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ install_id: installId(ledger), version: ROUTR_VERSION, os: OS, text: t }), signal: AbortSignal.timeout(15000) });
    return res.ok ? { ok: true, note: "sent. Thank you." } : { ok: false, error: `endpoint answered ${res.status}` };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

// `routr telemetry on|off`: the one config key this writes; everything else in the file is kept as it is.
export function setTelemetry(on, path = CONFIG_PATH) {
  let config = {};
  if (existsSync(path)) { try { config = JSON.parse(readFileSync(path, "utf8")); } catch { return { ok: false, error: `${path} is not valid JSON; fix it first` }; } }
  config.telemetry = on;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return { ok: true, telemetry: on ? "on" : "off", config: path };
}

export const NOTICE = "routr sends its maintainers anonymous outcomes once a day (what it read from each brief, what was chosen, how it went; never your briefs or any text) to tune its questions. See it: routr share · stop it: routr telemetry off";

export function telemetryCommand(args, config, configPath) {
  const sub = args[0] ?? "status";
  if (sub === "on" || sub === "off") return setTelemetry(sub === "on", configPath);
  const st = telemetryStatus(config), s = state();
  return { ok: true, telemetry: st.on ? "on" : "off", ...(st.why_off ? { why_off: st.why_off } : {}), endpoint: ENDPOINT, last_sent_through: s.sent_through ?? null, what: NOTICE };
}
