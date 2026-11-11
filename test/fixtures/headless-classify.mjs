// The headless adapter's stop and send against a stubbed channel: each case sets what probe and the holder's reply (or
// the channel's failure) are, and the adapter's classified answer is printed. A process of its own: the stub is global.
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const channel = await import("../../src/lib/channel.mjs");
let now = null;
const failing = (code) => Object.assign(new Error("PRIVATE-CHANNEL-TEXT"), code ? { code } : {});
mock.module("../../src/lib/channel.mjs", () => ({ ...channel,
  probe: async () => now.probe,
  connect: async () => {
    if (now.connectError !== undefined) throw failing(now.connectError);
    return { request: async () => { if (now.requestError !== undefined) throw failing(now.requestError); return now.reply; }, close() {} };
  },
}));
const { headless } = await import("../../src/lib/backend-headless.mjs");
const { newRecord, recordStore } = await import("../../src/lib/worker-record.mjs");
const root = mkdtempSync(join(tmpdir(), "classify-")), store = recordStore(root), dir = store.runDir("w1");
mkdirSync(dir, { recursive: true });
const record = newRecord({ name: "w1", kind: "claude", model: "m", cwd: dir }, { backend: "headless" });
store.write(dir, record);
const me = (over = {}) => ({ name: "w1", dir, record, unreadable: null, still: () => "same", damaged: () => [{ why: "damaged" }], ...over });
const ctx = { env: {}, ready: async () => null, spawn: () => false, store };
const cases = JSON.parse(process.argv[2]), out = [];
for (const c of cases) {
  now = c;
  writeFileSync(join(dir, "state.json"), JSON.stringify(c.state ?? {}));
  try { out.push(c.op === "stop" ? await headless.stop(me(c.unreadable ? { record: null, unreadable: c.unreadable } : {}), ctx) : await headless.send(me(), "hello", ctx)); }
  catch (e) { out.push({ threw: e.message, next: e.next }); }
}
console.log(JSON.stringify(out));
