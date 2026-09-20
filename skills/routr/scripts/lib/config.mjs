// User config: plain preferences only. Nothing here describes a model, so nothing goes stale when models change.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LEVELS } from "./questions.mjs";

export const CONFIG_PATH = join(homedir(), ".config/routr/config.json");
export const DEFAULTS = {
  fallback_level: "standard",  // advised when Jev cannot be reached
  sure_at: 0.8,                // Jev confidence from which its level is presented as settled. P23: 89% correct at or above 0.8, 56% below 0.5
  risk_above: 0.75,            // high_blast_radius probability that gets called out as high risk
  prefer: { research: "strong", review: "strong" }, // your preference per kind of work; shown to the agent as advice, never forced
  subscriptions: {},
};
const SUB_DEFAULTS = { hardest_work: "strong", reserve: 0, assumed_headroom: 0.5, default_model: null, default_effort: null };
const isLevel = (v) => LEVELS.includes(v);

// Never throws: a missing or broken config means defaults plus a note, so the router still answers.
export function loadConfig(path = CONFIG_PATH) {
  const notes = [];
  let raw = {};
  try {
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8"));
    else notes.push(`no config at ${path}: using defaults (run the routr-setup skill, or \`routr doctor\`)`);
  } catch (e) {
    notes.push(`config unreadable (${String(e?.message ?? e).slice(0, 80)}): using defaults`);
  }
  const num = (k) => (typeof raw[k] === "number" ? raw[k] : DEFAULTS[k]);
  const config = { fallback_level: isLevel(raw.fallback_level) ? raw.fallback_level : DEFAULTS.fallback_level, sure_at: num("sure_at"), risk_above: num("risk_above"), prefer: {}, subscriptions: {} };
  for (const [k, v] of Object.entries(raw.prefer ?? DEFAULTS.prefer)) isLevel(v) ? (config.prefer[k] = v) : notes.push(`prefer.${k}: "${v}" is not a level, ignored`);
  for (const [name, s] of Object.entries(raw.subscriptions ?? {})) {
    if (s?.hardest_work !== undefined && !isLevel(s.hardest_work)) notes.push(`subscriptions.${name}.hardest_work: "${s.hardest_work}" is not a level, using strong`);
    config.subscriptions[name] = {
      hardest_work: isLevel(s?.hardest_work) ? s.hardest_work : SUB_DEFAULTS.hardest_work,
      reserve: typeof s?.reserve === "number" ? s.reserve : SUB_DEFAULTS.reserve,
      assumed_headroom: typeof s?.assumed_headroom === "number" ? s.assumed_headroom : SUB_DEFAULTS.assumed_headroom,
      // The user's everyday model for this harness: where the orchestrator starts before moving up or down. Passed through, never interpreted.
      default_model: typeof s?.default_model === "string" ? s.default_model : null,
      default_effort: typeof s?.default_effort === "string" ? s.default_effort : null,
    };
  }
  return { config, notes };
}
