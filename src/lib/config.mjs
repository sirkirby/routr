// User config: plain preferences only. Nothing here describes a model, so nothing goes stale when models change.
import { warning } from "./warnings.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEVELS } from "./questions.mjs";
import { HARDEST, NO_CONFIG, RESERVE } from "./wording.mjs";
import { CONFIG_DIR, configDirOf, realOr } from "./state-files.mjs";
import { HARNESSES } from "./harnesses.mjs";
import { SUBSCRIPTION } from "./launch-history.mjs";
import { DEFAULT_PROVIDER, decisionSettings } from "./providers.mjs";
import { otelSwitch } from "./otel-settings.mjs";

export const CONFIG_PATH = (h) => join(CONFIG_DIR(h), "config.json");
export const DEFAULTS = {
  fallback_level: "standard",  // advised when the decision model cannot be reached
  sure_at: null,               // confidence from which a level is presented as settled; null: the decision model's own (providers.mjs; Jev 1.14's is 0.7)
  decision: [{ provider: DEFAULT_PROVIDER, model: null }], // which System One model reads the brief (providers.mjs); model null: the provider's default
  risk_above: 0.75,            // high_blast_radius probability that gets called out as high risk
  prefer: { research: "strong", review: "strong" }, // your preference per kind of work; shown to the agent as advice, never forced
  auto_update: true,           // check for a new release at most once a day, in the background; applied on the next run
  update_channel: "stable",    // which releases updates follow: "stable", or "beta" (also -beta.N and -rc.N; never alpha)
  telemetry: false,            // opt-in: share anonymous outcomes (never text) once a day to help tune routr; docs/telemetry.md
  subscriptions: {},
};
// `billing` fills a gap when the harness reports no capacity; a measured cap always counts.
// `use` is the user's choice, independent of any reading; unset means normal.
// `enabled: false` turns a subscription off without forgetting its settings: routr gives it no work until it is on again.
// `accounts` lists extra accounts under a harness's own entry (accounts, below), each with the harness's settings but
// for the ones it states itself. The harness's own entry is the account the environment names, as before there were any.
export const UPDATE_CHANNELS = ["stable", "beta"];
export const SUB_DEFAULTS = { enabled: true, hardest_work: "strong", reserve: 0, default_model: null, default_effort: null, billing: null, use: null, share: null };
const BILLING = ["included", "metered"];
export const ACCOUNT_USE = ["normal", "fallback"];
const isLevel = (v) => LEVELS.includes(v);
// `share`: this account's weight in the user's ratio of launches between normal metered accounts with room. A whole number,
// so 3 and 1 read as "three for every one"; anything else is reported and left out, which means no ratio of its own.
export const SHARE_MAX = 99;
export const isShare = (v) => Number.isInteger(v) && v >= 1 && v <= SHARE_MAX;
function launchShare(v, name, notes) {
  if (v === undefined || v === null) return SUB_DEFAULTS.share;
  if (isShare(v)) return v;
  notes.push(warning("config_choice", `subscriptions.${name}.share: ${JSON.stringify(v)} is not a whole number from 1 to ${SHARE_MAX}, so it is left out`));
  return SUB_DEFAULTS.share;
}

// The extra accounts under a harness's own entry (subscriptions.<harness>.accounts), by subscription name. Each is
// written as its folder, or as `{ folder, ...settings }` where it differs from its harness: `{ harness, config_dir, own }`,
// `own` the settings it states. One routr cannot use is left out, with a note saying why.
function accounts(subs, notes) {
  const out = {};
  const leave = (target, why) => notes.push(warning("config_choice", `${target}: ${why}, so it is left out`));
  for (const [h, s] of Object.entries(subs)) {
    if (s?.accounts == null) continue;
    if (typeof s.accounts !== "object" || Array.isArray(s.accounts)) { leave(`subscriptions.${h}.accounts`, "accounts must be an object of <name>: <folder>"); continue; }
    for (const [short, v] of Object.entries(s.accounts)) {
      const name = `${h}-${short}`, target = `subscriptions.${h}.accounts.${short}`;
      const own = v && typeof v === "object" && !Array.isArray(v) ? v : null, folder = own ? own.folder : v, dir = configDirOf(folder);
      if (!Object.hasOwn(HARNESSES, h)) leave(target, `harness ${JSON.stringify(h)} is not one of ${Object.keys(HARNESSES).join(", ")}`);
      else if (!HARNESSES[h].folder) leave(target, `${HARNESSES[h].label} has no folder setting routr knows`);
      else if (!SUBSCRIPTION.test(name)) leave(target, `${name} is not a name routr takes: a-z, 0-9, - and _, 32 characters at most`);
      else if (Object.hasOwn(subs, name) || Object.hasOwn(HARNESSES, name)) leave(target, `${name} is already used by another subscription`);
      else if (!dir) leave(target, `folder ${JSON.stringify(folder)} is not a full path or one under ~/`);
      else if (Object.values(out).some((o) => o.harness === h && realOr(o.config_dir) === realOr(dir))) leave(target, `its folder is ${Object.keys(out).find((n) => out[n].harness === h && realOr(out[n].config_dir) === realOr(dir))}'s too, and one folder is one account`);
      else out[name] = { harness: h, config_dir: dir, own: own ?? {}, target };
    }
  }
  return out;
}

// One subscription's settings as written (`s`), checked: `where` is how a note names it. `base`: an extra account's
// harness's settings, as loaded: a setting the account leaves out is its harness's, and is not noted as unset. Whether
// it is on is each one's own: a harness turned off leaves its extra accounts as they are.
function settingsOf(s, name, where, notes, base = null) {
  const from = base ?? SUB_DEFAULTS;
  // An account that writes `null` for its model, effort or launch share has none, where its harness has one: leaving
  // the setting out is how it takes its harness's.
  const none = (k) => Boolean(base) && s?.[k] === null;
  // The two settings that decide where work may go are the user's: a missing or invalid one is a problem to fix, and
  // the note says how. Until then the router still answers, on the stand-in named.
  const validReserve = typeof s?.reserve === "number" && s.reserve >= 0 && s.reserve <= 1;
  if (s?.hardest_work === undefined) { if (!base) notes.push(warning("config_hardest", `${HARDEST.unset(name)}. ${HARDEST.choose(name)}`)); }
  else if (!isLevel(s.hardest_work)) notes.push(warning("config_hardest", base ? `${where}.hardest_work: ${JSON.stringify(s.hardest_work)} is not a level, so its harness's is used` : `${HARDEST.invalid(name, s.hardest_work)}. ${HARDEST.choose(name)}`));
  if (s?.reserve === undefined) { if (!base) notes.push(warning("config_reserve", `${RESERVE.unset(name)}. ${RESERVE.choose(name)}`)); }
  else if (!validReserve) notes.push(warning("config_reserve", base ? `${where}.reserve: ${JSON.stringify(s.reserve)} is not a share from 0 to 1, so its harness's is used` : `${RESERVE.invalid(name, s.reserve)}. ${RESERVE.choose(name)}`));
  const oneOf = (k, allowed) => { const v = s?.[k]; if (v === undefined || v === null) return from[k]; if (allowed.includes(v)) return v; notes.push(warning("config_choice", `${where}.${k}: ${JSON.stringify(v)} is not one of ${allowed.join(", ")}, using ${from[k] ?? (k === "use" ? "normal use" : "the harness's own reading")}`)); return from[k]; };
  if (s?.enabled !== undefined && typeof s.enabled !== "boolean") notes.push(warning("config_enabled", `${where}.enabled: ${JSON.stringify(s.enabled)} is not true or false, so it stays on`));
  if (s?.metered_rank !== undefined || s?.assumed_headroom !== undefined) notes.push(warning("config_choice", `${where}: metered_rank and assumed_headroom no longer do anything; the next routr setup change removes them, or delete them by hand. routr setup --use ${name}=fallback keeps this seat out of everyday work`));
  return {
    enabled: s?.enabled !== false,
    hardest_work: isLevel(s?.hardest_work) ? s.hardest_work : from.hardest_work,
    reserve: validReserve ? s.reserve : from.reserve, // noted above when missing or invalid
    // The user's everyday model for this harness: where the orchestrator starts before moving up or down. Passed through, never interpreted.
    default_model: typeof s?.default_model === "string" ? s.default_model : none("default_model") ? SUB_DEFAULTS.default_model : from.default_model,
    default_effort: typeof s?.default_effort === "string" ? s.default_effort : none("default_effort") ? SUB_DEFAULTS.default_effort : from.default_effort,
    billing: oneOf("billing", BILLING),
    use: oneOf("use", ACCOUNT_USE),
    share: none("share") ? SUB_DEFAULTS.share : s?.share === undefined || s?.share === null ? from.share : launchShare(s.share, where.replace(/^subscriptions\./, ""), notes),
  };
}

// Never throws: a missing or broken config means defaults plus a note, so the router still answers.
export function loadConfig(path = CONFIG_PATH()) {
  const notes = [];
  let raw = {};
  try {
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8"));
    else notes.push(warning("config_missing", NO_CONFIG(path)));
  } catch (e) {
    notes.push(warning("config_unreadable", `config unreadable (${String(e?.message ?? e).slice(0, 80)}): using defaults`));
  }
  // Valid JSON that is not an object (`null`, a list, a number) holds no settings: the same as an unreadable file.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    notes.push(warning("config_unreadable", `config unreadable (${Array.isArray(raw) ? "a list" : JSON.stringify(raw)}, not an object): using defaults`));
    raw = {};
  }
  // Every number here is a share between 0 and 1. Anything else (a reserve of -1 would turn an empty subscription into
  // a full one) is reported and replaced by the default.
  const share = (v, fallback, where) => { if (v === undefined) return fallback; if (typeof v === "number" && v >= 0 && v <= 1) return v; notes.push(warning("config_share", `${where}: ${JSON.stringify(v)} is not a number from 0 to 1, using ${fallback ?? "the decision model's own"}`)); return fallback; };
  const num = (k) => share(raw[k], DEFAULTS[k], k);
  const config = { fallback_level: isLevel(raw.fallback_level) ? raw.fallback_level : DEFAULTS.fallback_level, sure_at: raw.sure_at === null ? null : num("sure_at"), risk_above: num("risk_above"),
    decision: decisionSetting(raw.decision, notes), auto_update: raw.auto_update !== false, update_channel: DEFAULTS.update_channel, telemetry: raw.telemetry === true, prefer: {}, subscriptions: {} };
  if (UPDATE_CHANNELS.includes(raw.update_channel)) config.update_channel = raw.update_channel;
  else if (raw.update_channel !== undefined) notes.push(warning("config_channel", `update_channel: ${JSON.stringify(raw.update_channel)} is not one of ${UPDATE_CHANNELS.join(", ")}, using stable: routr setup --channel stable|beta`));
  if (raw.otel !== undefined) {
    const setting = otelSwitch({ otel: raw.otel }, {});
    if (setting.on) config.otel = { endpoint: setting.endpoint, consent: setting.consent };
    else notes.push(warning("config_otel", `OpenTelemetry export is off: ${setting.why_off}; set an endpoint with routr setup --otel-endpoint <url>`));
  }
  for (const [k, v] of Object.entries(raw.prefer ?? DEFAULTS.prefer)) isLevel(v) ? (config.prefer[k] = v) : notes.push(warning("config_prefer", `prefer.${k}: "${v}" is not a level, ignored`));
  for (const [name, s] of Object.entries(raw.subscriptions ?? {})) config.subscriptions[name] = settingsOf(s, name, `subscriptions.${name}`, notes);
  for (const [name, { own, target, ...rec }] of Object.entries(accounts(raw.subscriptions ?? {}, notes))) config.subscriptions[name] = { ...settingsOf(own, name, target, notes, config.subscriptions[rec.harness]), ...rec };
  return { config, notes };
}

// One command's reading of the config: its trace and its body see the same one, read once (a file edited meanwhile
// can otherwise give the two different settings). `settings` is a command's own loader, or the user's file.
export const oneReading = (settings = () => loadConfig()) => { let r; return () => (r ??= settings()); };
// A loader may give `{ config, notes }` (loadConfig) or, in tests, the config itself.
export const configOf = (loaded) => loaded.config ?? loaded;

// The same provider/model checks and duplicate warnings as setup, without changing the user's file.
function decisionSetting(setting, notes) {
  const { decision, warnings } = decisionSettings(setting);
  notes.push(...warnings);
  return decision;
}

// The subscriptions routr may hand work to: every configured one the user has not turned off.
export const enabledSubscriptions = (config) => Object.keys(config.subscriptions).filter((n) => config.subscriptions[n].enabled !== false);
