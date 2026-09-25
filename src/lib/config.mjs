// User config: plain preferences only. Nothing here describes a model, so nothing goes stale when models change.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LEVELS } from "./questions.mjs";
import { HARDEST, RESERVE } from "./wording.mjs";

export const CONFIG_PATH = join(homedir(), ".config/routr/config.json");
export const DEFAULTS = {
  fallback_level: "standard",  // advised when Jev cannot be reached
  sure_at: 0.8,                // Jev confidence from which its level is presented as settled. P23: 89% correct at or above 0.8, 56% below 0.5
  risk_above: 0.75,            // high_blast_radius probability that gets called out as high risk
  prefer: { research: "strong", review: "strong" }, // your preference per kind of work; shown to the agent as advice, never forced
  auto_update: true,           // check for a new release at most once a day, in the background; applied on the next run
  telemetry: false,            // opt-in: share anonymous outcomes (never text) once a day to help tune routr; docs/telemetry.md
  subscriptions: {},
};
// `billing` overrides what the usage reader can tell (`included` or `metered`); it is for seats whose harness reports
// nothing, such as Claude usage-based Enterprise. `metered_rank` places a metered pool: `after` every pool with a quota
// that still has room (the default: included usage expires, billed usage does not), or `with` the rest by assumed_headroom.
export const SUB_DEFAULTS = { hardest_work: "strong", reserve: 0, assumed_headroom: 0.5, default_model: null, default_effort: null, billing: null, metered_rank: "after" };
const BILLING = ["included", "metered"], METERED_RANK = ["after", "with"];
const isLevel = (v) => LEVELS.includes(v);

// Never throws: a missing or broken config means defaults plus a note, so the router still answers.
export function loadConfig(path = CONFIG_PATH) {
  const notes = [];
  let raw = {};
  try {
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8"));
    else notes.push(`no config at ${path}: using defaults (run \`routr setup\`)`);
  } catch (e) {
    notes.push(`config unreadable (${String(e?.message ?? e).slice(0, 80)}): using defaults`);
  }
  // Every number here is a share between 0 and 1. Anything else (a reserve of -1 would turn an empty subscription into
  // a full one) is reported and replaced by the default.
  const share = (v, fallback, where) => { if (v === undefined) return fallback; if (typeof v === "number" && v >= 0 && v <= 1) return v; notes.push(`${where}: ${JSON.stringify(v)} is not a number from 0 to 1, using ${fallback}`); return fallback; };
  const num = (k) => share(raw[k], DEFAULTS[k], k);
  const config = { fallback_level: isLevel(raw.fallback_level) ? raw.fallback_level : DEFAULTS.fallback_level, sure_at: num("sure_at"), risk_above: num("risk_above"), auto_update: raw.auto_update !== false, telemetry: raw.telemetry === true, prefer: {}, subscriptions: {} };
  for (const [k, v] of Object.entries(raw.prefer ?? DEFAULTS.prefer)) isLevel(v) ? (config.prefer[k] = v) : notes.push(`prefer.${k}: "${v}" is not a level, ignored`);
  for (const [name, s] of Object.entries(raw.subscriptions ?? {})) {
    // The two settings that decide where work may go are the user's: a missing or invalid one is a problem to fix, and
    // the note says how. Until then the router still answers, on the stand-in named.
    if (s?.hardest_work === undefined) notes.push(`${HARDEST.unset(name)}. ${HARDEST.choose(name)}`);
    else if (!isLevel(s.hardest_work)) notes.push(`${HARDEST.invalid(name, s.hardest_work)}. ${HARDEST.choose(name)}`);
    const validReserve = typeof s?.reserve === "number" && s.reserve >= 0 && s.reserve <= 1;
    if (s?.reserve === undefined) notes.push(`${RESERVE.unset(name)}. ${RESERVE.choose(name)}`);
    else if (!validReserve) notes.push(`${RESERVE.invalid(name, s.reserve)}. ${RESERVE.choose(name)}`);
    const oneOf = (k, allowed, fallback) => { const v = s?.[k]; if (v === undefined || v === null) return fallback; if (allowed.includes(v)) return v; notes.push(`subscriptions.${name}.${k}: ${JSON.stringify(v)} is not one of ${allowed.join(", ")}, using ${fallback ?? "the harness's own reading"}`); return fallback; };
    config.subscriptions[name] = {
      hardest_work: isLevel(s?.hardest_work) ? s.hardest_work : SUB_DEFAULTS.hardest_work,
      reserve: validReserve ? s.reserve : SUB_DEFAULTS.reserve, // noted above when missing or invalid
      assumed_headroom: share(s?.assumed_headroom, SUB_DEFAULTS.assumed_headroom, `subscriptions.${name}.assumed_headroom`),
      // The user's everyday model for this harness: where the orchestrator starts before moving up or down. Passed through, never interpreted.
      default_model: typeof s?.default_model === "string" ? s.default_model : null,
      default_effort: typeof s?.default_effort === "string" ? s.default_effort : null,
      billing: oneOf("billing", BILLING, SUB_DEFAULTS.billing),
      metered_rank: oneOf("metered_rank", METERED_RANK, SUB_DEFAULTS.metered_rank),
    };
  }
  return { config, notes };
}
