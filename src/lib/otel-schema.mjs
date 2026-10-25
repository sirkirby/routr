// All signals share this typed allow-list. Values are classified at their origin before projection; no text catch-all.
import { FACTS, CHECKS } from "./questions.mjs";
export const TRACE_ATTRIBUTES = Object.freeze({ "routr.lead.session_id": "string", "routr.question_set.version": "string", "routr.candidates": "string[]", "routr.unavailable": "string[]",
  "vcs.repository.url.full": "string", "vcs.ref.head.name": "string", "routr.cwd": "string", "routr.worktree": "string",
  "routr.kind": "string", "routr.backend": "string", "routr.launch.id": "string", "gen_ai.agent.name": "string", "gen_ai.conversation.id": "string", "routr.model": "string", "routr.advice.matched": "boolean", "routr.carriers.forwarded": "string[]",
  ...Object.fromEntries([...Object.keys(FACTS), "level", "high_blast_radius"].map((k) => [`routr.assessment.${k}`, "double"])), "routr.assessment.work_type": "string",
  ...Object.fromEntries(Object.keys(CHECKS).map((k) => [`routr.check.${k}`, "double"])), "routr.check.flags": "string[]",
  "gen_ai.operation.name": "string", "gen_ai.provider.name": "string", "gen_ai.request.model": "string", "gen_ai.response.model": "string",
  ...Object.fromEntries(["input_tokens", "output_tokens", "cache_read.input_tokens", "cache_write.input_tokens", "reasoning.output_tokens"].map((k) => [`gen_ai.usage.${k}`, "int"])),
  "routr.turn": "int", "routr.turn.outcome": "string", "routr.turn.messages": "int",
  "routr.usage.state": "string", "routr.usage.source": "string",
  ...Object.fromEntries(["launch", "send", "wait", "workers", "stop", "cleanup", "record"].map((k) => [`routr.${k}.state`, "string"])),
  "routr.verdict": "string", "routr.check": "string", "routr.level": "string", "routr.attempts": "int", "routr.seconds": "double", "routr.causes": "string[]", "routr.subscription": "string", "routr.effort": "string", "routr.effort_from": "string", "routr.advice.id": "string", "error.type": "string" });
export const typed = (value, type) => type === "string" ? typeof value === "string" : type === "boolean" ? typeof value === "boolean" : type === "string[]" ? Array.isArray(value) && value.every((v) => typeof v === "string") : type === "int" ? Number.isSafeInteger(value) && value >= 0 : typeof value === "number" && Number.isFinite(value);
// Stage 3 / semconv pin section 6: structured events use eventName, with no body or event.name attribute.
export const LOG_EVENTS = Object.freeze({
  "routr.needs_input": { severityNumber: 13, severityText: "WARN", attributes: { "routr.needs_input.why": "string" } },
  "routr.warning": { severityNumber: 13, severityText: "WARN", attributes: { "routr.warning.code": "string" } },
  "routr.usage.failed": { severityNumber: 13, severityText: "WARN", attributes: { "error.type": "string", "routr.subscription": "string" } },
  "routr.worker.state": { severityNumber: 9, severityText: "INFO", attributes: { "routr.worker.state.from": "string", "routr.worker.state.to": "string" } },
});
export const NEEDS_INPUT_CODES = Object.freeze(["shell_not_ready", "startup_question", "worker_busy", "wrong_harness", "wrong_folder", "identity_unknown", "worker_question", "start_unconfirmed"]);

export const OTEL_ATTRIBUTES = Object.freeze({ ...TRACE_ATTRIBUTES, ...Object.assign({}, ...Object.values(LOG_EVENTS).map((v) => v.attributes)), "routr.usage.window": "string" });
export const IDENTITY_ATTRIBUTES = Object.freeze(["vcs.repository.url.full", "vcs.ref.head.name", "routr.cwd", "routr.worktree", "routr.lead.session_id", "routr.kind", "routr.backend", "routr.launch.id", "gen_ai.agent.name", "gen_ai.conversation.id", "routr.turn"]);
export const USAGE_WINDOWS = Object.freeze(["five_hour", "seven_day", "spend_limit", "primary", "secondary", "monthly_cap", "included", "monthly_credits", "5h", "weekly", "unknown"]);
export const SUBSCRIPTIONS = Object.freeze(["claude", "codex", "cursor", "agy", "kiro"]);
export function signalAttributes(values, allowed = Object.keys(OTEL_ATTRIBUTES)) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => allowed.includes(key) && OTEL_ATTRIBUTES[key] && value != null && typed(value, OTEL_ATTRIBUTES[key])));
}
