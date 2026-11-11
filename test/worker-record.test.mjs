// A worker's record: built strictly by the one constructor both launches use, read leniently by the one check every
// reader uses, kept under the state root it was given, and loadable with nothing else (help reads its name rule).
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { amend, checkRecord, FORMAT, newRecord, NAME_RULE, recordStore } from "../src/lib/worker-record.mjs";
import { leftovers } from "../src/lib/uninstall.mjs";
import { STATE_DIR } from "../src/lib/state-files.mjs";
import { scratch } from "./helpers.mjs";

const common = { name: "w1", kind: "claude", model: "m", cwd: "/work" };
const stored = (root, record) => { const store = recordStore(root), dir = store.runDir(record.name); mkdirSync(dir, { recursive: true }); store.write(dir, record); return store; };

test("a record built for either backend reads back as it was written, under the root it was given", () => {
  const root = scratch("record-root");
  const h = newRecord({ ...common, effort: "high", carriers: { TRACEPARENT: "00-x" }, subagent_model: "s", launch: { launch_id: "l" } }, { backend: "headless" });
  expect(h).toMatchObject({ format: FORMAT, name: "w1", backend: "headless", effort: "high", subagent_model: "s" });
  expect(h.id).toMatch(/^[0-9a-f]{32}$/);
  // What was not given is left out, never written as null.
  expect(Object.keys(h)).not.toContain("subagent_effort");
  expect(Object.keys(h)).not.toContain("worktree");
  const store = stored(root, h);
  expect(store.dir).toBe(join(root, "workers"));
  expect(store.read("w1")).toEqual({ worker: h });
  expect(store.readAt(store.runDir("w1"))).toEqual(h);
  const t = newRecord({ ...common, name: "w2", id: "b".repeat(32) }, { backend: "terminal", terminal_name: "w2", config: {} });
  stored(root, t);
  expect(store.read("w2").worker).toEqual(t);
  expect(amend(t, { terminal: "t9" })).toEqual({ ...t, terminal: "t9" });
  expect(store.names()).toEqual(["w1", "w2"]);
});

test("a record is checked strictly when it is built: a missing field, a wrong kind of value, or another backend's field is routr's mistake", () => {
  expect(() => newRecord({ ...common, name: "Bad" }, { backend: "headless" })).toThrow("(name)");
  expect(() => newRecord({ ...common, model: "" }, { backend: "headless" })).toThrow("(model)");
  expect(() => newRecord({ ...common, carriers: { A: 1 } }, { backend: "headless" })).toThrow("(carriers)");
  expect(() => newRecord(common, { backend: "pane" })).toThrow("(backend)");
  expect(() => newRecord(common, { backend: "headless", terminal_name: "w1" })).toThrow("(terminal_name)");
  expect(() => newRecord(common, { backend: "terminal" })).toThrow("terminal_name, config");
  expect(() => amend(newRecord(common, { backend: "terminal", terminal_name: "w1", config: {} }), { terminal: 7 })).toThrow("(terminal)");
  // Only what was built is written.
  const root = scratch("record-strict"), store = recordStore(root);
  mkdirSync(store.runDir("w1"), { recursive: true });
  expect(() => store.write(store.runDir("w1"), { format: FORMAT, name: "w1" })).toThrow("would not read back");
});

test("reading stays lenient: format and name decide, a record with no backend is headless, and reading writes nothing back", () => {
  const root = scratch("record-read"), store = recordStore(root), dir = store.runDir("w1"), file = join(dir, "worker.json");
  mkdirSync(dir, { recursive: true });
  // As a launch before terminal workers wrote it: no backend, no created_at checked.
  const old = { format: FORMAT, id: "short", name: "w1", kind: "claude", model: "m", cwd: dir };
  writeFileSync(file, JSON.stringify(old));
  expect(store.read("w1").worker).toEqual({ ...old, backend: "headless" });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(old);
  writeFileSync(file, JSON.stringify({ ...old, backend: "pane" }));
  expect(store.read("w1").worker.backend).toBe("pane");
  for (const other of [{ ...old, format: 2 }, { ...old, name: "w2" }, [old], "text"]) { writeFileSync(file, JSON.stringify(other)); expect(store.read("w1")).toEqual({ foreign: true }); }
  writeFileSync(file, "{");
  expect(store.read("w1")).toEqual({ unreadable: "not_json" });
  expect(store.read("w9")).toEqual({ absent: true });
  expect(checkRecord(old, "w1")?.backend).toBe("headless");
  expect(checkRecord(old, "W1")).toBeNull();
  // Only names a worker can have are listed.
  mkdirSync(join(store.dir, "Not-A-Name"));
  writeFileSync(join(store.dir, "w1.lock"), "");
  expect(store.names()).toEqual(["w1"]);
});

test("uninstall reads records through the store: a run folder of routr's is a worker, anything else is not routr's", () => {
  const home = scratch("record-uninstall"), root = STATE_DIR(home);
  stored(root, newRecord({ ...common, name: "a1" }, { backend: "headless" }));
  stored(root, newRecord({ ...common, name: "b2" }, { backend: "terminal", terminal_name: "b2", config: {} }));
  const store = recordStore(root);
  mkdirSync(store.runDir("c3")); writeFileSync(join(store.runDir("c3"), "worker.json"), JSON.stringify({ format: 2, name: "c3" }));
  mkdirSync(store.runDir("d4")); writeFileSync(join(store.runDir("d4"), "worker.json"), "{");
  mkdirSync(store.runDir("e5"));
  writeFileSync(join(store.dir, "a1.lock"), "");
  const found = leftovers(home);
  expect(found.workers).toEqual(["a1", "b2"]);
  expect(found.unknown).toEqual(["c3", "d4", "e5"].map((n) => store.runDir(n)));
});

test("the command table alone gives the name rule a value, and the record module imports only node: and the state files", async () => {
  // A process of its own: nothing else of routr loaded first.
  const p = Bun.spawnSync([process.execPath, "-e", `const { COMMANDS } = await import(${JSON.stringify(new URL("../src/lib/command-table.mjs", import.meta.url).href)});
    console.log(JSON.stringify(COMMANDS.launch.flags.find((f) => f.name === "--name").description));`]);
  expect(p.exitCode).toBe(0);
  expect(JSON.parse(p.stdout.toString())).toBe(`worker agent name (${NAME_RULE})`);
  const imports = (file) => [...readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8").matchAll(/^import [^;]*? from "([^"]+)";/gm)].map((m) => m[1]);
  expect(imports("worker-record.mjs").filter((m) => !m.startsWith("node:"))).toEqual(["./state-files.mjs"]);
  expect(imports("state-files.mjs").filter((m) => !m.startsWith("node:"))).toEqual([]);
});
