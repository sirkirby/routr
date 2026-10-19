// Shared envelope: the five fields always lead, while an error exists only for a stopped command.
export function answer(out) {
  const { ok = false, headline = "routr: no answer", unavailable = [], warnings = [], next = [], ...own } = out;
  return { ok, headline, unavailable, warnings, next, ...own };
}
export const refusal = (job, error, warnings = [], next = []) => answer({ ok: false, headline: `routr: ${job}: ${error}`, error, warnings, next });

// Earlier decision failures beside a reading do not make that reading fallback advice. Shared by saved advice and the ledger.
export const fallbackAdvice = (advice) => advice.fallback === true || !advice.decision_model && !advice.jev_model && Array.isArray(advice.unavailable) && advice.unavailable.some((u) => u?.part === "decision model");
