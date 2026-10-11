// The one System One client. Asks the configured provider (providers.mjs), unwraps its envelope, and normalizes the
// answers, so advise.mjs and check.mjs read every provider the same way. Raw HTTP, node: built-ins only; exposes the
// exact answers, latency and tokens.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decisionTarget, PROVIDERS, SECRETS_FILE } from "./providers.mjs";

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
export function secretsFor(provider, { env = process.env, file = SECRETS_FILE } = {}) {
  const P = PROVIDERS[provider], out = {};
  let saved = null;
  for (const s of P.secrets) {
    const v = env[s.name] || [s.name, ...(s.aliases ?? [])].map((n) => (saved ??= readSecretsFile(file))[n]).find(Boolean);
    if (!v) throw new Error(`no ${s.label}: run routr key set ${provider} (or set ${s.name})`);
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
  mkdirSync(dirname(file), { recursive: true });
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

// Turns a failure into what the person can do about it; the message stays short (it ends up in a fallback note).
function why(P, t, status, text) {
  if (P.local && status === 404) return `${P.label}: ${t.model} is not pulled. ${P.get(t.model)}`;
  if (P.local && /does not support decision/.test(text)) return `${P.label}: ${t.model} is not a decision model, or this Ollama is older than 0.35. ${P.get(t.model)}`;
  if (status === 401 || status === 403) return `${P.label} ${status}: the key was refused. ${typeof P.get === "function" ? P.get(t.model) : P.get}`;
  return `${P.label} ${status}: ${text.slice(0, 200)}`;
}

// deadlineMs is the total budget across retries; the provider's own when not given (a local model may need to load).
// The response names the model that answered (`model`), which is what the ledger records, with the provider.
// `target` and `fetchFn` are seams for the maintainers' gate and for tests.
export async function ask(state, questions, { config, deadlineMs, env = process.env, target, fetchFn = fetch, file } = {}) {
  const t = target ?? decisionTarget(config, env), P = PROVIDERS[t.provider];
  const secrets = secretsFor(t.provider, { env, file });
  const { url, headers, body } = P.request(t.model, secrets, env);
  const budget = deadlineMs ?? P.deadlineMs, stopAt = performance.now() + budget;
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let res;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, state, model: t.model, questions }),
        // A hosted call answers in well under a second, so a hung attempt is cut at 8 s and retried; a local one may
        // be loading the model and gets the whole budget.
        signal: AbortSignal.timeout(Math.max(1, P.local ? stopAt - t0 : Math.min(8000, stopAt - t0))),
      });
    } catch (e) {
      if (P.local && e?.name !== "TimeoutError") throw new Error(`${P.label} is not running at ${new URL(url).origin}: start it (the Ollama app, or ollama serve). ${P.get(t.model)}`);
      throw e;
    }
    const latencyMs = performance.now() - t0, wait = 500 * 2 ** attempt;
    if ((res.status === 429 || res.status === 529) && attempt < 5 && performance.now() + wait < stopAt) { await sleep(wait); continue; }
    if (!res.ok) throw new Error(why(P, t, res.status, await res.text()));
    const j = P.unwrap(await res.json());
    return { model: j.model ?? t.model, provider: t.provider, answers: normalize(j.answers, { native: P.nativeConfidence }), usage: j.usage, latencyMs, profile: t.profile, measured: t.measured };
  }
}

// One tiny real call: "does the decision model answer". `routr key set` and `routr doctor` must mean the same thing by it.
export const ping = (opts = {}) => ask({ task: { brief: "Fix a typo in README.md" } }, { ping: { type: "noul", instructions: "Does `task.brief` describe a software task?" } }, opts);
