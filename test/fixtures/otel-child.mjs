// Real process boundaries for queue bursts, exclusive identity creation and sender crash recovery. No harness.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { otelResource, otelSession, sendOtel } from "../../src/lib/otel.mjs";
import { writeJsonAtomic } from "../../src/lib/runtime.mjs";

const home = process.env.HOME, configPath = join(home, "config.json"), mode = process.argv[2];
if (mode === "queue") {
  const session = otelSession(JSON.parse(readFileSync(configPath)), {}, { home, configPath, spawn: () => true });
  const resource = otelResource({ home });
  for (let i = 0; i < 10; i++) session.queue("traces", { resourceSpans: [{ resource, i }] });
  console.log(resource["service.instance.id"]);
} else {
  await sendOtel({ home, configPath, env: {}, write: (file, value, opts) => {
    writeJsonAtomic(file, value, opts);
    if ((mode === "die-before" && !value.last_export) || (mode === "die-after" && value.last_export?.ok)) process.kill(process.pid, "SIGKILL");
  } });
}
