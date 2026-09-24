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
import { LEDGER_PATH, read } from "./ledger.mjs";
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
export function installId(ledger, { create = true } = {}) { const s = state(ledger); if (s.install_id || !create) return s.install_id ?? null; s.install_id = randomUUID(); saveState(s, ledger); return s.install_id; }

// Every string a lead can type into the ledger (`record --model/--verdict/...`, a report's SUBAGENTS line) is cut down
// to a known value or a short identifier here, before it can leave the machine: anything else becomes "other".
// Free text never survives this, and nothing reaches the endpoint's 80-character refusal.
const ID_LIKE = /^[A-Za-z0-9._:[\]/@+-]{1,64}$/;
const pick = (v, allowed) => (v == null ? null : allowed.includes(v) ? v : "other");
const ident = (v) => (v == null || v === "" ? null : ID_LIKE.test(String(v).trim()) ? String(v).trim() : "other");
const LEVELS3 = ["basic", "standard", "strong"];
const num = (v) => (Number.isFinite(v) ? v : null);

// Pure: ledger entries → the rows sent, field by field. A line that is not a ledger row is skipped, never sent.
const isRow = (e) => e && typeof e === "object" && e.advised && e.chose && e.outcome;
export function telemetryRows(entries, install) {
  return entries.filter(isRow).map((e) => {
    const a = e.advised;
    return {
      row_key: createHash("sha256").update(`${install}|${e.ts}|${e.id}`).digest("hex").slice(0, 32),
      v: 2, day: /^\d{4}-\d{2}-\d{2}/.test(String(e.ts)) ? String(e.ts).slice(0, 10) : null,
      mode: pick(e.mode, ["subagent", "dispatch"]), question_set: ident(e.question_set), jev_model: ident(e.jev_model), brief_chars: num(e.brief_chars),
      advised: { level: pick(a.level, LEVELS3), sure: !!a.sure, between: Array.isArray(a.between) ? a.between.map((l) => pick(l, LEVELS3)) : null,
        work_type: ident(a.work_type), high_risk: !!a.high_risk, fallback: !!a.fallback,
        facts: Object.fromEntries(Object.entries(a.facts ?? {}).filter(([k, p]) => /^[a-z_]{1,40}$/.test(k) && Number.isFinite(p))) },
      chose: { subscription: ident(e.chose.subscription), model: ident(e.chose.model), effort: ident(e.chose.effort), level: pick(e.chose.level, LEVELS3) },
      outcome: { verdict: pick(e.outcome.verdict, ["done", "partial", "blocked", "unknown"]), check: pick(e.outcome.check, ["pass", "fail", "none"]),
        attempts: num(e.outcome.attempts) ?? 1, seconds: num(e.outcome.seconds) },
      subagents: (e.subagents ?? []).slice(0, 20).map((x) => ({ advised: pick(x?.advised, LEVELS3), model: ident(x?.model) })),
    };
  });
}

// Sends the rows written since the last successful send. The first send on an install starts from NOW: rows recorded
// before telemetry reached this machine (an auto-update brings it, unseen) stay local unless the person sends them with
// `routr telemetry send --all`. Batches are cut by size, far below the endpoint's limit, and the mark moves only on success.
const BATCH_BYTES = 200 * 1024;
export async function sendRows({ ledger = LEDGER_PATH, fetchFn = fetch, timeoutMs = 15000, all = false, now = new Date().toISOString() } = {}) {
  let s = state(ledger);
  const install = installId(ledger);
  if (!s.started && !all) { s = { ...state(ledger), started: now, sent_through: s.sent_through ?? now }; saveState(s, ledger); }
  const from = all ? "" : s.sent_through ?? "";
  const fresh = read(ledger).filter((e) => isRow(e) && String(e.ts ?? "") > from);
  const rows = telemetryRows(fresh, install).map((r, i) => ({ r, ts: String(fresh[i].ts) }));
  if (!rows.length) return { ok: true, sent: 0 };
  let sent = 0, refused = 0;
  for (let i = 0; i < rows.length; ) {
    const batch = [];
    for (let size = 0; i < rows.length && batch.length < 500 && size + JSON.stringify(rows[i].r).length < BATCH_BYTES; i++) { batch.push(rows[i]); size += JSON.stringify(rows[i].r).length + 1; }
    if (!batch.length) { i++; refused++; continue; } // one row larger than a whole batch: cannot happen after telemetryRows, never blocks the rest
    const res = await fetchFn(`${ENDPOINT}/v1/rows`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ install_id: install, version: ROUTR_VERSION, os: OS, rows: batch.map((b) => b.r) }), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, sent, refused, error: `endpoint answered ${res.status}` };
    try { refused += (await res.json()).refused ?? 0; } catch {}
    sent += batch.length;
    const through = batch.map((b) => b.ts).sort().at(-1); // the latest time sent, not the last line: lines can arrive out of order
    const cur = state(ledger);
    if (!all || through > (cur.sent_through ?? "")) saveState({ ...cur, install_id: install, sent_through: through > (cur.sent_through ?? "") ? through : cur.sent_through }, ledger);
  }
  return { ok: true, sent, ...(refused ? { refused } : {}) };
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
  if (sub === "on" || sub === "off") {
    const r = setTelemetry(sub === "on", configPath);
    const st = telemetryStatus({ telemetry: sub === "on" });
    return r.ok && sub === "on" && !st.on ? { ...r, telemetry: "off", why_off: st.why_off, note: `set to on in the config, but it stays off while ${st.why_off}` } : r;
  }
  const st = telemetryStatus(config), s = state();
  return { ok: true, telemetry: st.on ? "on" : "off", ...(st.why_off ? { why_off: st.why_off } : {}), endpoint: ENDPOINT, last_sent_through: s.sent_through ?? null, what: NOTICE };
}
