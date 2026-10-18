// The System One providers routr can ask, and the decision models it has measured on each. One registry, the way
// harnesses.mjs holds the harnesses: everything that differs between providers is here (where to send, how to sign the
// request, how the answer comes back, what "ready" means), and systemone.mjs is the one client that uses it. All three
// speak TypeSafe's System One contract (state + typed questions → typed answers); what differs is the envelope around it
// and how each computes `confidence`, which systemone.mjs normalizes, so advise.mjs reads every provider the same way.
//
// A model is offered only with a PROFILE measured on routr's saved items (routr-lab's gate, CONTRIBUTING.md): its own
// sure_at, and the numbers the "torn" note quotes. Profiles describe routr's instrument, never a worker model: nothing
// here ranks or prices the models that do the work. Results per model: docs/evidence.md, "Decision models".
//
// Profiles, from the gate of 2026-10-11 (104 labelled briefs; 36 real runs from the maintainer's worker runs):
// - sure_at: the lowest bar on 0.5..0.8 at which the model's level, when "sure", is right at least as often as Jev's at
//   0.8 (39 of 44, 89%), with confidence normalized as systemone.mjs does.
// - torn: the level as routr presents it, on the 36 real runs: right, one level low, one level high.
import { home } from "./runtime.mjs";
import { join } from "node:path";

export const SECRETS_FILE = join(home(), ".config/routr/env");

// Ollama's own variable for where its server listens (`ollama serve` reads it), read the way Ollama's own client reads
// it (envconfig.Host): a bare host or host:port is http on 11434; a URL with a scheme and no port takes the scheme's own
// (80, 443); a path is kept. From the core review: http://127.0.0.1:11500/ was turned into an invalid URL.
export function ollamaHost(env = process.env) {
  const raw = (env.OLLAMA_HOST ?? "").trim();
  const [scheme, rest] = raw.includes("://") ? raw.split(/:\/\/(.*)/s) : ["http", raw];
  const port = !raw.includes("://") ? "11434" : scheme === "https" ? "443" : "80";
  const slash = rest.indexOf("/"), hostport = slash < 0 ? rest : rest.slice(0, slash), path = slash < 0 ? "" : rest.slice(slash).replace(/\/+$/, "");
  const m = hostport.match(/^(\[[^\]]+\]|[^:]*)(?::(\d+))?$/);
  return `${scheme}://${m?.[1] || "127.0.0.1"}:${m?.[2] ?? port}${path}`;
}

// The oldest Ollama that runs Clef Flash: 0.40.0 answered every request on Windows with "Clef: non-finite logit", on
// the GPU and on the CPU, and 0.40.3 answered (2026-10-11, RTX 5090 laptop); 0.40.1's notes name the fix (ollama#18777).
export const OLLAMA_MIN = "0.40.1";
// A pre-release comes before its release: 0.40.1-rc1 is older than 0.40.1 (from the review), 0.41.0-rc1 is not.
export const olderThan = (v, min) => {
  const [core, pre] = String(v).split(/-(.*)/s), a = core.split(".").map((x) => parseInt(x, 10)), b = min.split(".").map(Number);
  for (let i = 0; i < b.length; i++) { const x = Number.isNaN(a[i]) ? 0 : a[i] ?? 0; if (x !== b[i]) return x < b[i]; }
  return Boolean(pre);
};
// What to do when the running Ollama is older than OLLAMA_MIN; null when it is new enough or does not say (a build from
// source reports 0.0.0).
export async function ollamaTooOld(env = process.env, fetchFn = fetch) {
  const v = await fetchFn(`${ollamaHost(env)}/api/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).then((j) => j?.version).catch(() => null);
  return typeof v === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v) && !v.startsWith("0.0.0") && olderThan(v, OLLAMA_MIN) ? `Ollama ${v} is running; Clef needs ${OLLAMA_MIN} or later: update Ollama (https://ollama.com) and restart it` : null;
}

export const PROVIDERS = {
  typesafe: {
    label: "TypeSafe",
    secrets: [{ name: "TYPESAFE_API_KEY", label: "TypeSafe API key", hidden: true, aliases: ["TYPESAFE_AI_KEY", "TYPESAFE-API-KEY", "TYPESAFE-AI-KEY"] }],
    keysUrl: "https://console.typesafe.ai/keys",
    get: "Create an API key at https://console.typesafe.ai/keys, then run: routr key set typesafe",
    request: (model, s) => ({ url: "https://api.typesafe.ai/v1/systemone", headers: { Authorization: `Bearer ${s.TYPESAFE_API_KEY}` } }),
    unwrap: (j) => j,
    identity: (model) => typeof model === "string" && /^jev-\d+\.\d+\.\d+$/.test(model),
    nativeConfidence: true, // TypeSafe's own definition: kept as sent (its probabilities arrive rounded to 0.01)
    deadlineMs: 10000,
    models: {
      // P23, P32 and docs/evidence.md were all measured on this version.
      "jev-1.13.0": { sure_at: 0.8, torn: { right: 29, of: 36, low: 7, high: 0 },
        hint: "needs a TypeSafe API key · reads the level most accurately on routr's tests: 83 of 104 right" },
    },
  },
  cloudflare: {
    label: "Cloudflare Workers AI",
    // wrangler's own names, so a person or a CI that already has them set needs nothing more.
    secrets: [
      { name: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API token (Workers AI Read)", hidden: true },
      { name: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare account ID", hidden: false, shape: /^[0-9a-f]{32}$/i, lower: true },
    ],
    keysUrl: "https://dash.cloudflare.com/profile/api-tokens",
    // Read is enough: a token with only Account > Workers AI > Read ran key set, setup, doctor and both models
    // (2026-10-11). Cloudflare's "Workers AI" token template also adds Edit, which routr never needs.
    get: "Create an API token with Workers AI Read (Account > Workers AI > Read) at https://dash.cloudflare.com/profile/api-tokens, then run: routr key set cloudflare (it also asks for your account ID)",
    request: (model, s) => ({ url: `https://api.cloudflare.com/client/v4/accounts/${s.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`, headers: { Authorization: `Bearer ${s.CLOUDFLARE_API_TOKEN}` } }),
    // The REST API wraps the System One answer: { success, errors: [{ code, message }], messages, result }.
    unwrap: (j) => {
      if (j?.success === false || !j?.result?.answers) return null;
      return j.result;
    },
    identity: (model) => isModel("cloudflare", model),
    // Workers AI's numeric codes, checked 2026-10-18: https://developers.cloudflare.com/workers-ai/platform/errors/
    // Only codes select a sentence. A string code (even "3036") and all message text remain untrusted.
    errorCode: (j) => Array.isArray(j?.errors) && j.errors.some((e) => e?.code === 3036) ? "daily_allowance" : null,
    failures: { daily_allowance: "the daily free allowance is used up. Wait for the daily reset or enable the Workers Paid plan in Cloudflare." },
    deadlineMs: 10000,
    // Workers AI names are not versioned: Cloudflare can change the weights behind one, so these cannot be pinned the
    // way Jev is. docs/evidence.md says so, and the gate is re-run on them.
    unversioned: true,
    models: {
      // Reads levels high more often than Jev (26 of 104 over, 6 under), the cheaper direction to be wrong in.
      clef: { sure_at: 0.7, torn: { right: 26, of: 36, low: 5, high: 5 },
        hint: "your Cloudflare account; Workers AI has a free daily allowance · 72 of 104 levels right, more often too high" },
      // Reads levels low (18 of 104 under): offered for its price and speed, not as the default.
      "clef-flash": { sure_at: 0.5, torn: { right: 23, of: 36, low: 13, high: 0 },
        hint: "your Cloudflare account, a smaller and faster Clef · 74 of 104 levels right, more often too low" },
    },
  },
  ollama: {
    label: "Ollama (local)",
    secrets: [],
    get: (model) => `Install Ollama ${OLLAMA_MIN} or later (https://ollama.com), then run: ollama pull ${model}`,
    // keep_alive is Ollama's own field: the model stays loaded between briefs, so only the first call of a session waits
    // for it to load (Clef Flash: 5 to 17 s on an M4 Max, measured).
    request: (model, s, env) => ({ url: `${ollamaHost(env)}/v1/systemone`, headers: {}, body: { keep_alive: "15m" } }),
    unwrap: (j) => j,
    identity: (model) => isModel("ollama", model),
    host: ollamaHost,
    deadlineMs: 30000,
    local: true,
    // Bodies select a fixed failure, never supply its wording. Ollama 0.40.0's non-finite logit is the same
    // unsupported-runtime failure as a server too old to expose the decision endpoint (observed 2026-10-11).
    failure: (status, text) => status === 404 ? "model_missing"
      : /does not support decision|non-finite logit/.test(text) ? "model_unsupported" : null,
    // An explicit tag per model, never `latest`: Ollama's latest resolves to a different build on a Mac (MLX) than
    // elsewhere (GGUF), and the two answer differently. `digest` is the build that was measured; doctor says when the
    // one pulled here is another. `runs: "apple-silicon"`: an MLX build, which Ollama runs only there.
    // Speed on an M4 Max (2026-10-11, the shipped questions, a new brief each time, model loaded): Clef Flash as MLX
    // 5-7 s, as GGUF about 5 s; Clef 27B as MLX 13-26 s, as GGUF about 20 s. Every request carries routr's ~1,950
    // tokens of questions, so even a short brief costs that. Clef 27B is not offered here: too slow to advise in.
    // Clef Flash as GGUF on Windows (2026-10-11, Ollama 0.40.3, RTX 5090 laptop GPU): about 0.8 s a brief, loading
    // 4.8 s; on that laptop's CPU alone (Core Ultra 9 275HX) 36-41 s, past deadlineMs: it needs a GPU or Apple Silicon.
    // Whether it can answer, without asking it anything: the server is up and the model is pulled. Null when ready,
    // otherwise what to do. Setup says it instead of a generic "install, then pull" (seen in a real terminal).
    ready: async (model, env = process.env, fetchFn = fetch) => {
      // Both asked at once, so a slow version answer adds no wait of its own (from the review). A version Ollama does not
      // give is not held against it: the request itself then says what is wrong.
      const [tags, old] = await Promise.all([
        fetchFn(`${ollamaHost(env)}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null),
        ollamaTooOld(env, fetchFn),
      ]);
      if (!tags) return `Ollama is not running at ${ollamaHost(env)}: install Ollama ${OLLAMA_MIN} or later (https://ollama.com) and start it, then run: ollama pull ${model}`;
      if (old) return old;
      return tags.models?.some((x) => x.name === model || x.model === model) ? null : `${model} is not pulled yet: run ollama pull ${model}`;
    },
    check: async (model, profile, env = process.env, fetchFn = fetch) => {
      if (!profile?.digest) return null;
      const res = await fetchFn(`${ollamaHost(env)}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const m = (await res.json()).models?.find((x) => x.name === model || x.model === model);
      return typeof m?.digest === "string" && /^[0-9a-f]{12,}$/.test(m.digest) && !m.digest.startsWith(profile.digest) ? `${model} here is build ${m.digest.slice(0, 12)}, not ${profile.digest.slice(0, 12)}, the one routr measured: ollama pull ${model} gets that one` : null;
    },
    models: {
      // Measured as clef-flash:latest on a Mac, which is this build (same answers, 2026-10-11). Reads levels low (22 of
      // 104 under; on the 36 real runs, 17 one level low).
      "clef-flash:9b-mxfp8": { runs: "apple-silicon", digest: "bc72638064ee", sure_at: 0.6, torn: { right: 19, of: 36, low: 17, high: 0 },
        hint: "free, on this Mac (12 GB, several seconds a brief) · 70 of 104 levels right, more often too low" },
      // The GGUF build, which Ollama runs on every platform (llama.cpp). Measured on a Mac: 72 of 104, 20 under; on the
      // 36 real runs, 15 one level low. On Windows with an NVIDIA GPU its answers were the Mac's to within 0.018 on every
      // probability of 5 briefs, with no answer or level changed (2026-10-11).
      "clef-flash:9b-q8_0": { digest: "2aa4d39fd93b", sure_at: 0.6, torn: { right: 21, of: 36, low: 15, high: 0 },
        hint: "free, on this machine with a GPU (11 GB, under a second to about 5 s a brief) · 72 of 104 levels right, more often too low" },
    },
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
// Names come from a config file, a flag, or the environment: only the registry's own entries count ("constructor" and
// "__proto__" are properties of every object, from the core review).
export const isProvider = (p) => typeof p === "string" && Object.hasOwn(PROVIDERS, p);
export const isModel = (p, m) => isProvider(p) && typeof m === "string" && Object.hasOwn(PROVIDERS[p].models, m);
export const DEFAULT_PROVIDER = "typesafe";
const appleSilicon = (platform = process.platform, arch = process.arch) => platform === "darwin" && arch === "arm64";
// The models a provider offers on this machine, its default first: an MLX build only on Apple Silicon.
export const modelsHere = (provider, { platform, arch } = {}) => Object.keys(PROVIDERS[provider].models)
  .filter((m) => PROVIDERS[provider].models[m].runs !== "apple-silicon" || appleSilicon(platform, arch));
export const defaultModel = (provider, here) => modelsHere(provider, here)[0] ?? Object.keys(PROVIDERS[provider].models)[0];
// Every model id routr offers, across providers: the only values telemetry sends as a decision model.
export const KNOWN_MODELS = PROVIDER_NAMES.flatMap((p) => Object.keys(PROVIDERS[p].models));

// What routr will ask: the provider and model from the config (`decision`), or ROUTR_DECISION_MODEL
// ("<provider>:<model>", or a model id alone for the configured provider), which the maintainers' gate uses to try a
// model that has no profile yet. An unmeasured model reads with its provider's default profile, and says so.
export function decisionTarget(config, env = process.env) {
  const d = config?.decision ?? {};
  let provider = isProvider(d.provider) ? d.provider : DEFAULT_PROVIDER;
  let model = isModel(provider, d.model) ? d.model : defaultModel(provider);
  const override = env.ROUTR_DECISION_MODEL?.trim();
  if (override) {
    const at = override.indexOf(":"), named = at > 0 && isProvider(override.slice(0, at));
    if (named) { provider = override.slice(0, at); model = override.slice(at + 1) || defaultModel(provider); }
    else model = override;
  }
  const measured = isModel(provider, model) ? PROVIDERS[provider].models[model] : null;
  return { provider, model, profile: measured ?? PROVIDERS[provider].models[defaultModel(provider)] ?? null, measured: Boolean(measured), overridden: Boolean(override) };
}

// Only these sentences cross the provider boundary. No response body, envelope message, URL or thrown exception
// supplies text; the target is the one routr requested. Callers use the code/provider rather than reading prose.
export const DECISION_FAILURES = Object.freeze({
  no_key: "No credential is available for the decision provider.",
  secrets_unreadable: "routr could not read its secrets file.",
  key_refused: "The decision provider refused the credential.",
  model_missing: "The local decision model has not been pulled.",
  model_unsupported: "The local model or server does not support decision requests.",
  timeout: "The decision request timed out.",
  unreachable: "The decision provider could not be reached.",
  daily_allowance: "The decision provider's daily free allowance is used up.",
  provider_error: "The decision provider returned an error.",
  invalid_response: "The decision provider returned a reply routr cannot read.",
  internal_error: "An internal error stopped the decision check.",
});

export class DecisionError extends Error {
  constructor(target, code, status, { secret, file = SECRETS_FILE, host } = {}) {
    const { provider, model } = target, P = PROVIDERS[provider];
    const get = typeof P.get === "function" ? P.get(model) : P.get;
    const missing = P.secrets.find((s) => s.name === secret) ?? P.secrets[0];
    const http = Number.isInteger(status) ? status : 0;
    const action = http >= 500 ? "Try again later." : http === 429 ? "Check the provider's limits and try again after they reset."
      : http >= 400 ? "Check the decision model and provider settings before trying again." : "Check the decision provider.";
    const sentences = {
      no_key: `no ${missing?.label} saved. ${get}, or set ${missing?.name} in the environment.`,
      // Not the get-a-key text: `key set` writes this same file, so it would fail too.
      secrets_unreadable: `routr cannot read its secrets file ${file}. Check the file's permissions or set ${missing?.name} in the environment.`,
      key_refused: `the key was refused. ${get}`,
      model_missing: `the local model is not pulled. ${get}`,
      model_unsupported: `the local model is not a decision model, or Ollama is too old: update Ollama to ${OLLAMA_MIN} or later and restart it. ${get}`,
      timeout: "the request timed out. Try again; if it keeps timing out, check the decision provider.",
      unreachable: P.local ? `the local server is not running or cannot be reached at ${host ?? P.host()}: start it (the Ollama app, or ollama serve). ${get}`
        : "the provider could not be reached. Check your connection and try again.",
      provider_error: `the provider returned HTTP ${http}. ${action}`,
      invalid_response: "the provider returned a reply routr cannot read. Try again; if it persists, check the decision provider.",
      ...P.failures,
    };
    super(code === "internal_error" ? "routr: an internal error stopped the decision check. Run routr doctor; if it persists, report it to routr." : `${P.label}: ${sentences[code]}`);
    this.name = "DecisionError";
    this.code = code;
    this.provider = provider;
    this.model = model ?? null;
    this.why = DECISION_FAILURES[code];
    if (code === "provider_error") this.status = Number.isInteger(status) ? status : 0;
  }
}

// Output-only diagnostic. The detailed message above still supplies the action; this sentence is stable across
// hosts, secret paths and HTTP statuses, so saved advice can be classified without trusting its prose.
export function decisionUnavailable(e, target) {
  const error = e instanceof DecisionError ? e : new DecisionError(target, "internal_error");
  return { part: "decision model", provider: error.provider, model: error.model ?? target.model, code: error.code, why: error.why };
}
export const noReading = (u) => `routr: no reading (${u.model} on ${PROVIDERS[u.provider].label} unavailable: ${u.code})`;
