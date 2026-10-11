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

// Ollama's own variable for where its server listens (`ollama serve` reads it): a host, host:port, or a URL.
export function ollamaHost(env = process.env) {
  const h = (env.OLLAMA_HOST ?? "").trim();
  if (!h) return "http://127.0.0.1:11434";
  const url = /^https?:\/\//.test(h) ? h : `http://${h}`;
  return /:\d+$/.test(url.replace(/^https?:\/\//, "")) ? url.replace(/\/+$/, "") : `${url.replace(/\/+$/, "")}:11434`;
}

export const PROVIDERS = {
  typesafe: {
    label: "TypeSafe",
    secrets: [{ name: "TYPESAFE_API_KEY", label: "TypeSafe API key", hidden: true, aliases: ["TYPESAFE_AI_KEY", "TYPESAFE-API-KEY", "TYPESAFE-AI-KEY"] }],
    keysUrl: "https://console.typesafe.ai/keys",
    get: "Create an API key at https://console.typesafe.ai/keys, then run: routr key set typesafe",
    request: (model, s) => ({ url: "https://api.typesafe.ai/v1/systemone", headers: { Authorization: `Bearer ${s.TYPESAFE_API_KEY}` } }),
    unwrap: (j) => j,
    nativeConfidence: true, // TypeSafe's own definition: kept as sent (its probabilities arrive rounded to 0.01)
    deadlineMs: 10000,
    models: {
      // P23, P32 and docs/evidence.md were all measured on this version.
      "jev-1.13.0": { sure_at: 0.8, torn: { right: 29, of: 36, low: 7, high: 0 },
        hint: "needs a TypeSafe API key · the most accurate on routr's tests: 83 of 104 levels right" },
    },
  },
  cloudflare: {
    label: "Cloudflare Workers AI",
    // wrangler's own names, so a person or a CI that already has them set needs nothing more.
    secrets: [
      { name: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API token (Account › Workers AI › Read)", hidden: true },
      { name: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare account ID", hidden: false, shape: /^[0-9a-f]{32}$/ },
    ],
    keysUrl: "https://dash.cloudflare.com/profile/api-tokens",
    get: "Create an API token with Account › Workers AI › Read at https://dash.cloudflare.com/profile/api-tokens, then run: routr key set cloudflare (it also asks for your account ID)",
    request: (model, s) => ({ url: `https://api.cloudflare.com/client/v4/accounts/${s.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`, headers: { Authorization: `Bearer ${s.CLOUDFLARE_API_TOKEN}` } }),
    // The REST API wraps the System One answer: { success, errors: [{ code, message }], messages, result }.
    unwrap: (j) => {
      if (j?.success === false || !j?.result?.answers) throw new Error(`Cloudflare: ${j?.errors?.map((e) => `${e.code} ${e.message}`).join("; ").slice(0, 200) || "no answers in the response"}`);
      return j.result;
    },
    deadlineMs: 10000,
    // Workers AI names are not versioned: Cloudflare can change the weights behind one, so these cannot be pinned the
    // way Jev is. docs/evidence.md says so, and the gate is re-run on them.
    unversioned: true,
    models: {
      // Reads levels high more often than Jev (26 of 104 over, 6 under), the cheaper direction to be wrong in.
      clef: { sure_at: 0.7, torn: { right: 26, of: 36, low: 5, high: 5 },
        hint: "your Cloudflare account (the free daily allowance covers about 450,000 input tokens) · 72 of 104 levels right, more often too high" },
      // Reads levels low (18 of 104 under): offered for its price and speed, not as the default.
      "clef-flash": { sure_at: 0.5, torn: { right: 23, of: 36, low: 13, high: 0 },
        hint: "your Cloudflare account, about a sixth of Clef's price · 74 of 104 levels right, more often too low" },
    },
  },
  ollama: {
    label: "Ollama (local)",
    secrets: [],
    get: (model) => `Install Ollama 0.35 or later (https://ollama.com), then run: ollama pull ${model}`,
    // keep_alive is Ollama's own field: the model stays loaded between briefs, so only the first call of a session waits
    // for it to load (Clef Flash: 5 to 17 s on an M4 Max, measured).
    request: (model, s, env) => ({ url: `${ollamaHost(env)}/v1/systemone`, headers: {}, body: { keep_alive: "15m" } }),
    unwrap: (j) => j,
    deadlineMs: 30000,
    local: true,
    // An explicit tag per model, never `latest`: Ollama's latest resolves to a different build on a Mac (MLX) than
    // elsewhere (GGUF), and the two answer differently. `digest` is the build that was measured; doctor says when the
    // one pulled here is another. `runs: "apple-silicon"`: an MLX build, which Ollama runs only there.
    // Speed on an M4 Max (2026-10-11, the shipped questions, a new brief each time, model loaded): Clef Flash as MLX
    // 5-7 s, as GGUF about 5 s; Clef 27B as MLX 13-26 s, as GGUF about 20 s. Every request carries routr's ~1,950
    // tokens of questions, so even a short brief costs that. Clef 27B is not offered here: too slow to advise in.
    check: async (model, profile, env = process.env) => {
      if (!profile?.digest) return null;
      const res = await fetch(`${ollamaHost(env)}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const m = (await res.json()).models?.find((x) => x.name === model || x.model === model);
      return m && !m.digest.startsWith(profile.digest) ? `${model} here is build ${m.digest.slice(0, 12)}, not ${profile.digest.slice(0, 12)}, the one routr measured: ollama pull ${model} gets that one` : null;
    },
    models: {
      // Measured as clef-flash:latest on a Mac, which is this build (same answers, 2026-10-11). Reads levels low (22 of
      // 104 under; on the 36 real runs, 17 one level low).
      "clef-flash:9b-mxfp8": { runs: "apple-silicon", digest: "bc72638064ee", sure_at: 0.6, torn: { right: 19, of: 36, low: 17, high: 0 },
        hint: "free, on this Mac (12 GB, 5-7 s a brief) · 70 of 104 levels right, more often too low" },
    },
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
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
  let provider = PROVIDERS[d.provider] ? d.provider : DEFAULT_PROVIDER;
  let model = d.model && PROVIDERS[provider].models[d.model] ? d.model : defaultModel(provider);
  const override = env.ROUTR_DECISION_MODEL?.trim();
  if (override) {
    const at = override.indexOf(":"), named = at > 0 && PROVIDERS[override.slice(0, at)];
    if (named) { provider = override.slice(0, at); model = override.slice(at + 1) || defaultModel(provider); }
    else model = override;
  }
  const measured = PROVIDERS[provider].models[model];
  return { provider, model, profile: measured ?? PROVIDERS[provider].models[defaultModel(provider)] ?? null, measured: Boolean(measured), overridden: Boolean(override) };
}
