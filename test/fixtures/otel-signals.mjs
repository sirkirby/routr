import * as otel from "../../src/lib/otel.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { cfg, scratch } from "../helpers.mjs";
export const ids = { traceId: "5b8efff798038103d269b633813fc60c", spanId: "eee19b7ec3c1b174" };
export function install(endpoint) {
  const home = scratch("otel-signals"), configPath = join(home, "config.json"), config = cfg({ otel: { endpoint, consent: "1234567890abcdef1234567890abcdef" } });
  writeFileSync(configPath, JSON.stringify(config));
  let tick = Date.now();
  const opts = { home, configPath, env: {}, now: () => tick++, spawn: () => true }, root = join(home, ".cache/routr/otel");
  otel.prepareOtel(opts);
  return { config, opts, root, queue: otel.otelSession(config, {}, opts) };
}
export async function receiver(run) {
  const requests = [], server = createServer(async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)) }); res.end("{}"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await run(`http://127.0.0.1:${server.address().port}/prefix`, requests); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
export const points = (requests) => requests.flatMap((r) => r.body.resourceMetrics ?? []).flatMap((r) => r.scopeMetrics).flatMap((s) => s.metrics).flatMap((m) => m.gauge.dataPoints);
