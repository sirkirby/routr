// Accessible setup with scripted menu answers; key entry still uses the real piped stdin and test fetch preload.
import { join } from "node:path";
import { setup } from "../../src/lib/setup.mjs";
import { modelsHere, PROVIDER_NAMES } from "../../src/lib/providers.mjs";
const provider = process.env.ROUTR_TEST_PROVIDER;
const order = PROVIDER_NAMES.flatMap((p) => modelsHere(p).map((m) => `${p}:${m}`));
const answers = [String(order.findIndex((x) => x.startsWith(`${provider}:`)) + 1), "1", "b"];
const printed = [];
const result = await setup(["--config", join(process.env.HOME, ".config/routr/config.json")], {
  interactive: true, question: async () => { if (!answers.length) throw new Error("unexpected setup question"); return answers.shift(); }, print: (s) => printed.push(s),
});
console.log(JSON.stringify({ result, printed }));
