// Where a worker runs, chosen in one place, and what a worker record that names no backend reads as.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "../src/lib/backends.mjs";
import { FORMAT, readWorker, runDir, workerOf } from "../src/lib/worker-record.mjs";
import { KINDS } from "../src/lib/harnesses.mjs";

test("a worker runs in a pane only inside herdr, whatever the harness; anywhere else, a core terminal included, it runs headless", () => {
  for (const kind of [...KINDS, null]) {
    expect(executionFor({ HERDR_ENV: "1" }, kind)).toBe("pane");
    expect(executionFor({ HERDR_ENV: "1", HC_TERMINAL_ID: "t7" }, kind)).toBe("pane");
    expect(executionFor({}, kind)).toBe("headless");
    expect(executionFor({ HC_TERMINAL_ID: "t7" }, kind)).toBe("headless");
    for (const other of ["", "0", "true"]) expect(executionFor({ HERDR_ENV: other }, kind)).toBe("headless");
  }
});

test("a worker record that names no backend reads as headless, and reading it writes nothing back", () => {
  const name = "backend-default", dir = runDir(name), file = join(dir, "worker.json");
  const record = { format: FORMAT, id: "a".repeat(32), name, kind: "claude", model: "m", effort: null, cwd: dir, created_at: new Date(0).toISOString(), carriers: {} };
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, JSON.stringify(record));
    expect(workerOf(name).worker.backend).toBe("headless");
    expect(readWorker(name).backend).toBe("headless");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    writeFileSync(file, JSON.stringify({ ...record, backend: "pane" }));
    expect(workerOf(name).worker.backend).toBe("pane");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
