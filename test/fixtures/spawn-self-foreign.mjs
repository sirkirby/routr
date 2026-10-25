// Capture the real spawnSelf call from a foreign entry point. The argument guard bounds this probe even if its spy fails.
if (process.argv.length !== 2) process.exit(93);
if (process.env.ROUTR_SELF_FOREIGN_ARGV) process.argv[1] = process.env.ROUTR_SELF_FOREIGN_ARGV;
const { spyOn } = await import("bun:test");
if (process.env.ROUTR_SELF_FAIL_URL) {
  const url = await import("node:url"), original = url.fileURLToPath; let calls = 0;
  spyOn(url, "fileURLToPath").mockImplementation((...args) => { if (++calls === 1 || process.env.ROUTR_SELF_FAIL_URL === "always") throw new Error("unavailable URL"); return original(...args); });
}
const runtime = await import("../../src/lib/runtime.mjs");
const calls = [], child = { on() {}, unref() {} };
const spawn = spyOn(runtime, "start").mockImplementation((cmd, args, opts) => {
  const env = opts.env && Object.fromEntries(Object.entries(opts.env).filter(([k]) => ["TRACEPARENT", "TRACESTATE", "BAGGAGE", "CLAUDE_CODE_SESSION_ID", "CODEX_HOME"].includes(k)));
  calls.push({ cmd, args, opts: { ...opts, env } }); return child;
});
try {
  for (const args of [["--otel-sender", "--config", "fixture-home/config.json"], ["usage", "cursor", "--background"], ["update", "--background"], ["workers", "--hold", "fixture"]]) runtime.spawnSelf(args);
  console.log(JSON.stringify({ calls, standalone: runtime.standalone(), executable: process.execPath }));
} finally { spawn.mockRestore(); }
