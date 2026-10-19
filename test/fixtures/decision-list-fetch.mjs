// Source-CLI smoke and disclosure tests: every fetch is mocked, including setup/doctor checks.
import { replyFetch } from "./provider-fetch.mjs";
const replies = JSON.parse(process.env.ROUTR_TEST_REPLIES ?? "{}");
globalThis.fetch = (url, init) => {
  const provider = url.includes("api.cloudflare.com") ? "cloudflare" : url.includes("api.typesafe.ai") ? "typesafe" : "ollama";
  return replyFetch(provider, replies[provider] ?? "valid")(url, init);
};
