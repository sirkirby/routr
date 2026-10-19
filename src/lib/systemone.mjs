// The one System One client. Asks the configured provider (providers.mjs), unwraps its envelope, and normalizes the
// answers, so advise.mjs and check.mjs read every provider the same way. Raw HTTP, node: built-ins only; exposes the
// exact answers, latency and tokens.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureParent } from "./runtime.mjs";
import { DecisionError, decisionTarget, isModel, PROVIDERS, SECRETS_FILE } from "./providers.mjs";

// ---------------------------------------------------------------- secrets
// One owner-only file of NAME=value lines outside any project, so workers in worktrees and other folders find it too.
// An environment variable of the same name wins (the names the providers' own tools read).
export function readSecretsFile(file = SECRETS_FILE) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// The values a provider needs, read per call (never at import: a missing one is a catchable error, nothing stale is
// kept). Throws with what to do when one is missing.
// The file is read only when the environment does not supply everything: an unreadable file must not block a key
// given in the environment (from the core review; the old TypeSafe client read the environment first too).
export function secretsFor(provider, { env = process.env, file = SECRETS_FILE, target = { provider } } = {}) {
  const P = PROVIDERS[provider], out = {};
  let saved = null;
  for (const s of P.secrets) {
    let v;
    try { v = env[s.name] || [s.name, ...(s.aliases ?? [])].map((n) => (saved ??= readSecretsFile(file))[n]).find(Boolean); }
    catch { throw new DecisionError(target, "secrets_unreadable", undefined, { secret: s.name, file }); }
    if (!v) throw new DecisionError(target, "no_key", undefined, { secret: s.name });
    out[s.name] = v;
  }
  return out;
}

// Merges into the file: the other lines (another provider's key, a comment) stay as they were. A name set more than
// once keeps one line, the new value in the first one's place: readSecretsFile takes the last, so a stale duplicate left
// below would win (from the core review).
export function writeSecrets(values, file = SECRETS_FILE) {
  let lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l, i, a) => l !== "" || i < a.length - 1) : [];
  const nameOf = (l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/)?.[1];
  for (const [name, value] of Object.entries(values)) {
    const at = lines.findIndex((l) => nameOf(l) === name);
    if (at < 0) { lines.push(`${name}=${value}`); continue; }
    lines = lines.filter((l, i) => i <= at || nameOf(l) !== name);
    lines[at] = `${name}=${value}`;
  }
  ensureParent(file);
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {} // an existing file keeps its old mode unless we set it; no-op on Windows
}

// ---------------------------------------------------------------- normalizing answers
// Providers agree on the answer types but not on `confidence`: TypeSafe documents its own (docs.typesafe.ai/confidence),
// while Clef on Workers AI and on Ollama use normalized entropy, which reads a 0.92/0.08 split between two adjacent
// levels as 0.75 where TypeSafe's reads 0.88. Every threshold routr has (sure_at) was measured on TypeSafe's, so for any
// other provider routr computes it, by TypeSafe's formula, from the probabilities every provider returns. TypeSafe's own
// value is kept as sent: recomputed from its rounded probabilities it lands within 0.02 of it (1,448 saved Jev answers,
// 2026-10-11), close enough to check the formula, not close enough to leave a sure/torn call at 0.8 untouched.
//   choice: how far the top probability sits above an even split, (p_max - 1/n) / (1 - 1/n)
//   score:  1 - (probability-weighted distance in levels from the most likely level) / (the same for an even spread)
export function confidence(type, probabilities) {
  if (!probabilities || typeof probabilities !== "object") return undefined;
  if (type === "choice") {
    const p = Object.values(probabilities), n = p.length;
    return n < 2 ? 1 : Math.max(0, (Math.max(...p) - 1 / n) / (1 - 1 / n));
  }
  if (type === "score") {
    const p = Object.keys(probabilities).sort((a, b) => a - b).map((k) => probabilities[k]), n = p.length;
    if (n < 2) return 1;
    const m = p.reduce((best, x, i) => (x > p[best] ? i : best), 0);
    const mad = p.reduce((s, x, i) => s + x * Math.abs(i - m), 0), madEven = p.reduce((s, _, i) => s + Math.abs(i - (n - 1) / 2), 0) / n;
    return Math.max(0, 1 - mad / madEven);
  }
  return undefined;
}

export function normalize(answers, { native = false } = {}) {
  if (native) return answers;
  const out = {};
  for (const [k, a] of Object.entries(answers ?? {})) {
    const c = a && typeof a === "object" ? confidence(a.type, a.probabilities) : undefined;
    out[k] = c === undefined ? a : { ...a, confidence: c, ...(a.confidence !== undefined && a.confidence !== c ? { provider_confidence: a.confidence } : {}) };
  }
  return out;
}

// ---------------------------------------------------------------- asking
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Also keep unexpected client failures out of diagnostic prose. The classified error is the only printable one.
export const failureMessage = (e, config) => (e instanceof DecisionError ? e : new DecisionError(decisionTarget(config), "internal_error")).message;

const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const inRange = (x, max = 1) => Number.isFinite(x) && x >= 0 && x <= max;

// Project as well as validate: unused provider fields can carry the brief too. Question keys and choices come from
// the request, never the reply; optional confidence/spreads remain optional (some providers omit them).
function readAnswers(answers, questions, target) {
  const invalid = () => { throw new DecisionError(target, "invalid_response"); };
  if (!object(answers)) invalid();
  const out = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = answers[key];
    if (!object(a) || (a.type !== undefined && a.type !== q.type)) invalid();
    const options = q.type === "choice" ? Object.keys(q.criteria) : q.type === "score" ? q.criteria.map((_, i) => String(i)) : null;
    const field = q.type === "choice" ? "choice" : q.type === "score" ? "score" : "noul";
    if (q.type === "choice" ? !options.includes(a.choice) : !inRange(a[field], q.type === "score" ? options.length - 1 : 1)) invalid();
    const clean = { type: q.type, [field]: a[field] };
    if (a.confidence !== undefined) { if (!inRange(a.confidence)) invalid(); clean.confidence = a.confidence; }
    if (a.probabilities !== undefined) {
      if (!object(a.probabilities) || !Object.keys(a.probabilities).length) invalid();
      const allowed = options ?? ["true", "false"];
      if (Object.entries(a.probabilities).some(([k, p]) => !allowed.includes(k) || !inRange(p))) invalid();
      clean.probabilities = Object.fromEntries(Object.entries(a.probabilities));
    }
    out[key] = clean;
  }
  return out;
}

// deadlineMs is the total budget across retries; the provider's own when not given (a local model may need to load).
// The reply's model identity is kept only when its provider recognizes it; otherwise use the requested identity.
// This preserves preview-alias resolution and pin checks in the model gate without accepting arbitrary reply text.
// `target` and `fetchFn` are seams for the maintainers' gate and for tests.
export async function ask(state, questions, { config, deadlineMs, env = process.env, target, fetchFn = fetch, file } = {}) {
  const t = target ?? decisionTarget(config, env), P = PROVIDERS[t.provider];
  const secrets = secretsFor(t.provider, { env, file, target: t });
  let request, payload;
  try { request = P.request(t.model, secrets, env); payload = JSON.stringify({ ...request.body, state, model: t.model, questions }); }
  catch { throw new DecisionError(t, "internal_error"); }
  const { url, headers } = request;
  const budget = deadlineMs ?? P.deadlineMs, stopAt = performance.now() + budget;
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let res;
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(P.local ? stopAt - t0 : Math.min(8000, stopAt - t0))));
    const transportError = (e) => new DecisionError(t, signal.aborted || e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "unreachable", undefined, { host: P.host?.(env) });
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: payload,
        // Hosted calls are cut at 8 s; timeouts fail immediately. Only 429/529 replies may be retried below.
        // A local call may be loading the model and gets the whole budget.
        signal,
      });
    } catch (e) {
      throw transportError(e);
    }
    const latencyMs = performance.now() - t0, wait = 500 * 2 ** attempt;
    if (!res.ok) {
      // Local bodies may select a known pattern. Hosted envelopes supply only numeric error codes, never wording.
      let code;
      if (P.failure) { try { code = P.failure(res.status, await res.text()); } catch (e) { throw transportError(e); } }
      if (P.errorCode) {
        try { code = P.errorCode(await res.json()); }
        catch (e) { if (!(e instanceof SyntaxError)) throw transportError(e); } // a non-JSON HTTP error keeps its status
      }
      code = res.status === 401 || res.status === 403 ? "key_refused" : code ?? "provider_error";
      if (code === "provider_error" && (res.status === 429 || res.status === 529) && attempt < 5 && performance.now() + wait < stopAt) { await sleep(wait); continue; }
      throw new DecisionError(t, code, res.status);
    }
    let raw;
    try { raw = await res.json(); }
    catch (e) { throw e instanceof SyntaxError && !signal.aborted ? new DecisionError(t, "invalid_response") : transportError(e); }
    const j = P.unwrap(raw);
    if (!j) throw new DecisionError(t, P.errorCode?.(raw) ?? "invalid_response");
    const answers = readAnswers(j?.answers, questions, t);
    const usage = object(j.usage) ? Object.fromEntries(Object.entries(j.usage).filter(([k, v]) => ["input_tokens", "output_tokens", "total_tokens"].includes(k) && Number.isSafeInteger(v) && v >= 0)) : undefined;
    const model = P.identity(j.model) ? j.model : t.model;
    // A validated identity can still be an unmeasured version. Keep the fallback profile for reading its answers,
    // but only claim a measurement for the model that answered, not the pin or alias it was requested through.
    const profile = isModel(t.provider, model) ? P.models[model] : null;
    return { model, provider: t.provider, answers: normalize(answers, { native: P.nativeConfidence }), usage, latencyMs,
      profile: profile ?? t.profile, measured: Boolean(profile) || (model === t.model && Boolean(t.measured)) };
  }
}

// One tiny real call: "does the decision model answer". `routr key set` and `routr doctor` must mean the same thing by it.
export const ping = (opts = {}) => ask({ task: { brief: "Fix a typo in README.md" } }, { ping: { type: "noul", instructions: "Does `task.brief` describe a software task?" } }, opts);
