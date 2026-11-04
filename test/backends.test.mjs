// Where a worker runs, chosen in one place, and what a worker record that names no backend reads as.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "../src/lib/backends.mjs";
import { privateDir } from "../src/lib/channel.mjs";
import { FORMAT, readWorker, runDir, WORKERS_DIR, workerOf } from "../src/lib/worker-record.mjs";
import { KINDS } from "../src/lib/harnesses.mjs";

test("a worker runs in a pane inside herdr, in a terminal inside herdr-core, and headless anywhere else, whatever the harness", () => {
  for (const kind of [...KINDS, null]) {
    expect(executionFor({ HERDR_ENV: "1" }, kind)).toBe("pane");
    expect(executionFor({ HERDR_ENV: "1", HC_TERMINAL_ID: "t7" }, kind)).toBe("pane");
    expect(executionFor({}, kind)).toBe("headless");
    expect(executionFor({ HC_TERMINAL_ID: "t7" }, kind)).toBe("terminal");
    expect(executionFor({ HC_TERMINAL_ID: "t7", HERDR_ENV: "0" }, kind)).toBe("terminal");
    expect(executionFor({ HC_TERMINAL_ID: "" }, kind)).toBe("headless");
    for (const other of ["", "0", "true"]) expect(executionFor({ HERDR_ENV: other }, kind)).toBe("headless");
  }
});

test("a worker record that names no backend reads as headless, and reading it writes nothing back", () => {
  const name = "backend-default", dir = runDir(name), file = join(dir, "worker.json");
  const record = { format: FORMAT, id: "a".repeat(32), name, kind: "claude", model: "m", effort: null, cwd: dir, created_at: new Date(0).toISOString(), carriers: {} };
  // As reserve makes it. Every file in a run shares this home, and a workers folder open to others would be refused to
  // whichever launch comes next, in whatever order the platform lists the files (seen on Linux only, in #151's CI).
  privateDir(WORKERS_DIR()); mkdirSync(dir);
  try {
    writeFileSync(file, JSON.stringify(record));
    expect(workerOf(name).worker.backend).toBe("headless");
    expect(readWorker(name).backend).toBe("headless");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    writeFileSync(file, JSON.stringify({ ...record, backend: "pane" }));
    expect(workerOf(name).worker.backend).toBe("pane");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  if (process.platform !== "win32") expect(statSync(WORKERS_DIR()).mode & 0o077).toBe(0);
});
