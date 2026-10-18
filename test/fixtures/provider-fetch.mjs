// Used both as ask's fetchFn and as a CLI preload. No request leaves the process.
export const BRIEF_MARKER = "PRIVATE_BRIEF_MARKER_73d0";
export const KEY_MARKER = "PRIVATE_KEY_MARKER_8be4";
const text = `${BRIEF_MARKER} ${KEY_MARKER}`;

export const replyFetch = (provider, scenario) => async (url, init) => {
  if (url.endsWith("/api/version")) return Response.json({ version: scenario === "old_version" ? "0.40.0" : `0.40.0 ${text}` });
  if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "clef-flash:9b-q8_0", digest: scenario === "digest" ? text : "a".repeat(64) }] });
  if (scenario === "network" || scenario === "timeout") {
    const e = new Error(text);
    e.name = scenario === "timeout" ? "TimeoutError" : "TypeError";
    throw e;
  }
  if (scenario.startsWith("http")) return new Response(text, { status: Number(scenario.slice(4)) });
  if (scenario === "unsupported") return new Response(`does not support decision ${text}`, { status: 400 });
  if (scenario === "logit") return new Response(`non-finite logit ${text}`, { status: 500 });
  if (scenario === "json") return new Response(`{ ${text}`);
  if (scenario === "envelope") return Response.json({ success: false, errors: [{ code: text, message: text }], messages: [text], result: { answers: text } });
  if (["allowance", "allowance200", "string_code", "unknown_code"].includes(scenario)) return Response.json({ success: false, errors: [{ code: scenario === "string_code" ? "3036" : scenario === "unknown_code" ? 987654 : 3036, message: text }], messages: [text], result: { answers: text } }, { status: scenario === "allowance200" ? 200 : 429 });
  const { questions } = JSON.parse(init.body);
  const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.type === "choice"
    ? { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 1, probabilities: { [Object.keys(q.criteria)[0]]: 1 }, extra: text }
    : q.type === "score" ? { type: "score", score: 1, confidence: 1, probabilities: { 0: 0, 1: 1, 2: 0 }, extra: text }
      : { type: "noul", noul: 0.9, extra: text }]));
  if (scenario === "work_type" && answers.work_type) answers.work_type.choice = text;
  if (scenario === "verdict" && answers.verdict) answers.verdict.choice = text;
  if (scenario === "confidence") for (const a of Object.values(answers)) a.confidence = text;
  if (scenario === "probability") for (const a of Object.values(answers)) a.probabilities = { [text]: 0.9 };
  if (scenario === "missing_question") delete answers[Object.keys(questions)[0]];
  const result = { model: scenario === "identity" ? "jev-1.14.0" : text, answers: scenario === "answers" ? text : answers, usage: { input_tokens: 10, output_tokens: text, extra: text }, extra: text };
  if (scenario === "missing_answers") delete result.answers;
  return Response.json(provider === "cloudflare" ? { success: true, result, errors: [{ message: text }], messages: [text] } : result);
};

if (process.env.ROUTR_TEST_PROVIDER) {
  globalThis.fetch = replyFetch(process.env.ROUTR_TEST_PROVIDER, process.env.ROUTR_TEST_REPLY);
  if (["http429", "http529", "string_code", "unknown_code"].includes(process.env.ROUTR_TEST_REPLY)) {
    const { PROVIDERS } = await import("../../src/lib/providers.mjs");
    PROVIDERS[process.env.ROUTR_TEST_PROVIDER].deadlineMs = 1;
  }
  if (process.env.ROUTR_TEST_REPLY === "internal") {
    const { PROVIDERS } = await import("../../src/lib/providers.mjs");
    PROVIDERS[process.env.ROUTR_TEST_PROVIDER].request = () => { throw new Error(text); };
  }
}
