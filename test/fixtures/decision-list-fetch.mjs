// Source-CLI smoke and disclosure tests: every fetch is mocked, including setup/doctor checks.
import { replyFetch } from "./provider-fetch.mjs";
const replies = JSON.parse(process.env.ROUTR_TEST_REPLIES ?? "{}"), delays = JSON.parse(process.env.ROUTR_TEST_DELAYS ?? "{}");
globalThis.fetch = (url, init) => {
  const provider = url.includes("api.cloudflare.com") ? "cloudflare" : url.includes("api.typesafe.ai") ? "typesafe" : "ollama";
  const reply = () => replyFetch(provider, replies[provider] ?? "valid")(url, init);
  if (!delays[provider]) return reply();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(init.signal.reason); };
    const timer = setTimeout(() => { init.signal.removeEventListener("abort", abort); reply().then(resolve, reject); }, delays[provider]);
    init.signal.addEventListener("abort", abort, { once: true });
  });
};

if (process.env.ROUTR_TEST_TTY === "1") Object.defineProperty(process.stderr, "isTTY", { value: true });
