// state-files.mjs: routr's own files, written whole and read back checked, and the locks that keep two routr processes
// from one job
import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ensureParent } from "../src/lib/state-files.mjs";
import * as files from "../src/lib/state-files.mjs";
import { cliEnv, scratch } from "./helpers.mjs";

test("two takers observing the same stale lock admit only one, with a token the loser cannot release", () => {
  const file = join(scratch("stale-lock-race"), "job.lock"); writeFileSync(file, "999999999");
  let second = false;
  const first = files.takeLock(file, () => true, { rename: (from, to) => {
    second = files.takeLock(file, () => true);
    renameSync(from, to);
  } });
  expect([first, second].filter(Boolean)).toHaveLength(1);
  const owner = JSON.parse(readFileSync(file, "utf8"));
  const token = owner.token;
  expect(files.lockOwned(file, token)).toBe(true);
  expect(owner).toMatchObject({ pid: process.pid, token: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(files.lockOwned(file, "another-token")).toBe(false);
  expect(files.releaseFileLock(file, "another-token")).toBe(false); expect(existsSync(file)).toBe(true);
  expect(files.lockOwned(file, token)).toBe(true);
  expect(files.releaseFileLock(file, token)).toBe(true); expect(existsSync(file)).toBe(false);
});

test("three takers cannot move a newer owner's lock during a stale takeover", () => {
  const file = join(scratch("three-lock-takers"), "job.lock"); writeFileSync(file, "999999999");
  let a = false, c = false;
  const b = files.takeLock(file, files.lockIsStale, { rename: (from, to) => {
    a = files.takeLock(file, files.lockIsStale);
    renameSync(from, to);
    c = files.takeLock(file, files.lockIsStale);
  } });
  expect([a, b, c].filter(Boolean)).toHaveLength(1);
  expect(files.lockOwned(file)).toBe(true);
});

test("stale takeovers need no hard links and preserve the winning owner's file", async () => {
  const file = join(scratch("lock-without-links"), "job.lock");
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/lock-no-links.mjs"), file], { stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(0);
  // Links are tried, refused, and the exclusive open used instead.
  const r = JSON.parse(await new Response(p.stdout).text());
  expect(r).toMatchObject({ winners: 1, owned: true }); expect(r.links).toBeGreaterThan(0);
});

test("a failed initial lock write removes only its own incomplete lock and allows a retry", () => {
  const file = join(scratch("lock-write-failure"), "uninstall.lock");
  const write = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  expect(files.takeLock(file, () => false, { write })).toBe(false);
  expect(existsSync(file)).toBe(false);
  expect(files.takeLock(file, () => false)).toBe(true);
  const before = readFileSync(file, "utf8");
  expect(files.takeLock(file, () => false, { write })).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("retries for non-stale uninstall and worker locks write no takeover guard", () => {
  for (const name of ["uninstalling", "worker.lock"]) {
    const dir = scratch("live-lock-retry"), file = join(dir, name), guard = `${file}.takeover`;
    expect(files.takeLock(file, () => false)).toBe(true);
    const before = readFileSync(file, "utf8"), guarded = []; let writes = 0;
    for (let retry = 0; retry < 3; retry++) expect(files.takeLock(file, () => { guarded.push(existsSync(guard)); return false; }, {
      write: (...args) => { writes++; writeFileSync(...args); }
    })).toBe(false);
    expect(writes).toBe(0); expect(guarded).toEqual([false, false, false]);
    expect(readFileSync(file, "utf8")).toBe(before); expect(readdirSync(dir)).toEqual([name]);
  }
});

test("a stale lock is checked again under the takeover guard before it can be moved", () => {
  const file = join(scratch("stale-lock-recheck"), "job.lock"), guard = `${file}.takeover`, guarded = [];
  writeFileSync(file, "999999999");
  expect(files.takeLock(file, () => { guarded.push(existsSync(guard)); return guarded.length === 1; })).toBe(false);
  expect(guarded).toEqual([false, true]); expect(readFileSync(file, "utf8")).toBe("999999999");
  expect(existsSync(guard)).toBe(false);
});

test("a guard with no pid to read is reclaimed only after minutes, and losing one prevents moving the main lock", () => {
  const file = join(scratch("takeover-guard"), "job.lock"), guard = `${file}.takeover`, ago = (ms) => new Date(Date.now() - ms);
  writeFileSync(file, "999999999"); writeFileSync(guard, "abandoned");
  expect(files.takeLock(file, () => true)).toBe(false);
  utimesSync(guard, ago(6000), ago(6000));
  expect(files.takeLock(file, () => true)).toBe(false); // seconds are not enough: its taker may be paused
  utimesSync(guard, ago(11 * 60_000), ago(11 * 60_000));
  expect(files.takeLock(file, () => {
    if (readFileSync(guard, "utf8") !== "abandoned") writeFileSync(guard, JSON.stringify({ pid: process.pid, token: "replacement" }));
    return true;
  })).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("999999999");
  expect(JSON.parse(readFileSync(guard)).token).toBe("replacement");
});

test("a guard whose owner crashed is reclaimed at once, and the lock behind it taken over", () => {
  const dir = scratch("crashed-guard"), file = join(dir, "job.lock"), guard = `${file}.takeover`;
  writeFileSync(file, "999999999"); writeFileSync(guard, JSON.stringify({ pid: 999999999, token: "crashed" }));
  expect(files.takeLock(file, files.lockIsStale)).toBe(true);
  expect(files.lockOwned(file)).toBe(true); expect(readdirSync(dir)).toEqual(["job.lock"]);
  // An owner that is alive keeps its guard, however old it is.
  files.releaseFileLock(file); writeFileSync(file, "999999999"); writeFileSync(guard, JSON.stringify({ pid: process.pid, token: "paused" }));
  utimesSync(guard, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  expect(files.takeLock(file, files.lockIsStale)).toBe(false);
  expect(files.takeLock(file, files.lockIsStale, { alive: (pid) => pid !== process.pid })).toBe(true);
});

test("a taker paused between its last guard check and its move keeps its guard: no one else takes the lock meanwhile", () => {
  // With a guard that expired by age: A paused after its check; B reclaimed A's guard and took the lock; A then moved
  // B's live lock aside, and C took the empty path while B worked.
  const file = join(scratch("paused-taker"), "job.lock"), guard = `${file}.takeover`, ago = new Date(Date.now() - 60_000);
  writeFileSync(file, "999999999");
  let b = false, c = false;
  const a = files.takeLock(file, files.lockIsStale, { rename: (from, to) => {
    if (from === file) { utimesSync(guard, ago, ago); b = files.takeLock(file, files.lockIsStale); }
    renameSync(from, to);
  } });
  c = files.takeLock(file, files.lockIsStale);
  expect([a, b, c]).toEqual([true, false, false]);
  expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(files.lockToken(file));
});

test("two takers reclaiming the same crashed guard cannot both act: one moves it, the other stops", () => {
  // B checks the dead guard, then pauses before moving it; D reclaims it meanwhile and pauses before moving the stale
  // lock; B's move then takes D's live guard, and E takes the lock that D is about to move.
  const dir = scratch("guard-reclaim-race"), file = join(dir, "job.lock"), guard = `${file}.takeover`;
  writeFileSync(file, "999999999"); writeFileSync(guard, JSON.stringify({ pid: 999999999, token: "crashed" }));
  let d = false, e = false;
  const b = files.takeLock(file, files.lockIsStale, { rename: (from, to) => {
    if (from !== guard) return renameSync(from, to);
    let moved = false;
    d = files.takeLock(file, files.lockIsStale, { rename: (f, t) => {
      if (f === file && !moved) { moved = true; renameSync(guard, to); e = files.takeLock(file, files.lockIsStale); }
      renameSync(f, t);
    } });
    if (!moved) renameSync(from, to);
  } });
  expect([b, d, e].filter(Boolean)).toHaveLength(1);
  expect(existsSync(file)).toBe(true); expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(files.lockToken(file));
  expect(readdirSync(dir).sort()).toEqual(["job.lock"]);
});

const paused = async (mode) => {
  const dir = scratch(`lock-pause-${mode}`);
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/lock-pauses.mjs"), mode, dir], { stdout: "pipe", stderr: "pipe" });
  expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
  return JSON.parse(await new Response(p.stdout).text());
};

test("an owner releasing its lock holds the guard: a takeover meanwhile cannot have its new lock removed", async () => {
  const r = await paused("release");
  expect(r).toMatchObject({ released: true, taken: false, lock: null });
});

test("a guard is never seen without its owner's pid, so an owner paused publishing it never acts unguarded", async () => {
  // Paused ten minutes as its guard is published, then released while a third process tries to take the lock over.
  const r = await paused("guard");
  expect(r.seen).not.toBe("no pid");
  expect(r.taken === false || r.lock === r.token).toBe(true); // a takeover that won keeps its lock
  expect(r).toMatchObject({ released: true, taken: false, lock: null });
});

test("a lock is never seen without its owner's pid, so a taker paused publishing it cannot share it", async () => {
  const r = await paused("lock");
  expect(r.seen).not.toBe("no pid");
  expect([r.other, r.mine].filter(Boolean)).toHaveLength(1);
  expect(r.lock).toBe(r.other ? r.otherToken : r.mineToken);
});

test("a claim on a dead guard is never seen without its owner's pid", async () => {
  const r = await paused("claim");
  expect(r.seen).not.toBe("no pid");
  expect(r.taken === undefined || r.taken === false || r.lock === r.token).toBe(true);
});

test("release makes one attempt at a busy guard and never waits: the lock stays for the stale rule", () => {
  const file = join(scratch("busy-release"), "job.lock"), guard = `${file}.takeover`;
  expect(files.takeLock(file, () => false)).toBe(true);
  writeFileSync(guard, JSON.stringify({ pid: process.pid, token: "busy" }));
  const wait = spyOn(Atomics, "wait");
  try {
    const began = performance.now();
    expect(files.releaseFileLock(file)).toBe(false);
    expect(wait).not.toHaveBeenCalled(); expect(performance.now() - began).toBeLessThan(100);
    expect(files.lockOwned(file)).toBe(true);
  } finally { wait.mockRestore(); }
  unlinkSync(guard);
  expect(files.releaseFileLock(file)).toBe(true); expect(existsSync(file)).toBe(false);
});

test("a moved lock with an unexpected generation is kept, never deleted as stale", () => {
  const dir = scratch("unexpected-lock"), file = join(dir, "job.lock"); writeFileSync(file, "999999999");
  expect(files.takeLock(file, () => true, { rename: (from, to) => { writeFileSync(from, "replacement"); renameSync(from, to); } })).toBe(false);
  const aside = readdirSync(dir).find((n) => n.startsWith("job.lock.stale."));
  expect(aside).toBeDefined(); expect(readFileSync(join(dir, aside), "utf8")).toBe("replacement");
});

test("a worker cleanup that loses its lock during checks keeps the worker and the replacement lock", async () => {
  const home = scratch("worker-lost-lock");
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/worker-lost-lock.mjs")], { env: cliEnv(home), stdout: "pipe", stderr: "pipe" });
  expect(await p.exited).toBe(0);
  expect(JSON.parse(await new Response(p.stdout).text())).toEqual({ stopped: true, kept: true, owner: "replacement" });
});

test("real processes racing over the same observed stale lock elect one owner", async () => {
  const dir = scratch("stale-lock-processes"), file = join(dir, "job.lock"); writeFileSync(file, "999999999");
  const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/lock-taker.mjs"), file, dir], { env: cliEnv(dir), stdout: "pipe", stderr: "pipe" }));
  try {
    const until = Date.now() + 10_000;
    while (readdirSync(dir).filter((n) => n.startsWith("ready-")).length < 2) {
      if (Date.now() > until) throw new Error("lock test start timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    writeFileSync(join(dir, "go"), "go");
    while (readdirSync(dir).filter((n) => n.startsWith("result-")).length < 2) {
      if (Date.now() > until) throw new Error("lock test result timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    writeFileSync(join(dir, "finish"), "finish");
    const answers = await Promise.all(children.map(async (p) => { expect(await p.exited).toBe(0); return JSON.parse(await new Response(p.stdout).text()); }));
    expect(answers.filter((r) => r.won)).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(answers.find((r) => r.won).token);
  } finally { for (const p of children) p.kill(); }
}, 20_000);

test("parent creation resolves relative files and accepts EEXIST only for an existing directory", () => {
  const exists = Object.assign(new Error("EEXIST: file already exists, mkdir '.'"), { code: "EEXIST" });
  const calls = [];
  // Bun on Windows can throw even with recursive:true when the parent is '.'. Simulate it on every platform.
  ensureParent("ledger.jsonl", { mkdir: (dir, opts) => { calls.push([dir, opts]); throw exists; } });
  expect(calls).toEqual([[resolve("."), { recursive: true }]]);
  expect(isAbsolute(calls[0][0])).toBe(true);
  const dir = scratch("parents"), file = join(dir, "collision"); writeFileSync(file, "keep");
  expect(() => ensureParent(join(file, "row.json"), { mkdir: () => { throw exists; } })).toThrow(exists);
  expect(() => ensureParent(join(dir, "gone", "row.json"), { mkdir: () => { throw exists; } })).toThrow(exists);
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  expect(() => ensureParent(join(dir, "row.json"), { mkdir: () => { throw denied; } })).toThrow(denied);
  ensureParent(join(dir, "new", "nested", "row.json"));
  expect(statSync(join(dir, "new", "nested")).isDirectory()).toBe(true);
  ensureParent(join(dir, "new", "nested", "another.json"));
});

test("the per-turn state files load only node built-ins", () => {
  const text = readFileSync(new URL("../src/lib/state-files.mjs", import.meta.url), "utf8");
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(text);
  expect(imports.every((entry) => entry.path.startsWith("node:"))).toBe(true);
});

// A file routr wrote and reads back is read, absent, or unreadable: never "absent" for one it could not read. On Windows
// a reader can meet a file another process holds or is replacing, so an unreadable one is read again for up to
// REPLACE_BUSY_MS; elsewhere routr's writers replace whole files, so one that does not parse is read once.
test("readJsonFile tells a file read from one absent and one there but unreadable, reading again on Windows", () => {
  const dir = scratch("read-json-file"), file = join(dir, "state.json");
  expect(files.readJsonFile(file)).toEqual({ absent: true });
  writeFileSync(file, '{"turn":2}');
  expect(files.readJsonFile(file)).toEqual({ value: { turn: 2 } });
  for (const bad of ["", '{"turn":', "not json"]) { writeFileSync(file, bad); expect(files.readJsonFile(file)).toEqual({ unreadable: "not_json" }); }
  // In use, then readable: read again with the old file in place, within the budget.
  let t = 0, tries = 0;
  const clock = { now: () => t, pause: (ms) => { expect(ms).toBe(5); t += ms; } };
  const inUse = () => Object.assign(new Error("in use"), { code: "EBUSY" });
  expect(files.readJsonFile(file, { busyFor: 100, ...clock, read: () => (++tries < 3 ? (() => { throw inUse(); })() : '{"turn":3}') })).toEqual({ value: { turn: 3 } });
  expect(tries).toBe(3);
  // Half written until the writer finishes: also read again.
  tries = 0; t = 0;
  expect(files.readJsonFile(file, { busyFor: 100, ...clock, read: () => (++tries < 2 ? '{"tu' : '{"turn":4}') })).toEqual({ value: { turn: 4 } });
  // Unreadable throughout: given up once the budget is spent, slow reads counted in.
  for (const [cost, want] of [[0, 21], [40, 3]]) {
    tries = 0; t = 0;
    expect(files.readJsonFile(file, { busyFor: 100, ...clock, read: () => { tries++; t += cost; throw inUse(); } })).toEqual({ unreadable: "EBUSY" });
    expect([cost, tries]).toEqual([cost, want]);
  }
  // Absent is absent at once, and off Windows (busyFor 0, the default there) nothing is read twice.
  tries = 0;
  expect(files.readJsonFile(file, { busyFor: 100, ...clock, read: () => { tries++; throw Object.assign(new Error("gone"), { code: "ENOENT" }); } })).toEqual({ absent: true });
  expect(tries).toBe(1);
  tries = 0;
  expect(files.readJsonFile(file, { busyFor: 0, ...clock, read: () => { tries++; throw inUse(); } })).toEqual({ unreadable: "EBUSY" });
  expect(tries).toBe(1);
  if (process.platform !== "win32") { tries = 0; expect(files.readJsonFile(file, { read: () => { tries++; throw inUse(); } })).toEqual({ unreadable: "EBUSY" }); expect(tries).toBe(1); }
});

test.skipIf(process.platform === "win32")("writeJsonAtomic userFile writes through the person's link, keeps it, and keeps the file's mode", () => {
  const dir = scratch("user-file"), real = join(dir, "dotfiles-settings.json"), link = join(dir, "settings.json");
  writeFileSync(real, "{}"); chmodSync(real, 0o600); symlinkSync(real, link);
  files.writeJsonAtomic(link, { a: 1 }, { indent: 2, preserveOnError: true, userFile: true });
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ a: 1 });
  expect(statSync(real).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir).sort()).toEqual(["dotfiles-settings.json", "settings.json"]); // no temporary file left
});

test.skipIf(process.platform === "win32")("writeJsonAtomic userFile keeps a link to a file not made yet, and a group-writable mode the umask would narrow", () => {
  const dir = scratch("user-file-edge"), target = join(dir, "dotfiles", "config.json"), link = join(dir, "config.json");
  mkdirSync(join(dir, "dotfiles")); symlinkSync("dotfiles/config.json", link); // relative, and dangling
  files.writeJsonAtomic(link, { a: 1 }, { userFile: true, preserveOnError: true });
  expect(lstatSync(link).isSymbolicLink()).toBe(true); expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ a: 1 });
  chmodSync(target, 0o660);
  const was = process.umask(0o022);
  try { files.writeJsonAtomic(link, { a: 2 }, { userFile: true, preserveOnError: true }); } finally { process.umask(was); }
  expect(statSync(target).mode & 0o777).toBe(0o660);
});

test.skipIf(process.platform === "win32")("writeJsonAtomic userFile takes a link's .. where its folder really is, and refuses a loop of links", () => {
  const dir = scratch("user-file-links");
  mkdirSync(join(dir, "physical", "nested"), { recursive: true }); symlinkSync("physical/nested", join(dir, "alias"));
  writeFileSync(join(dir, "physical", "target.json"), "{}"); writeFileSync(join(dir, "target.json"), JSON.stringify({ owner: "unrelated" }));
  symlinkSync("../target.json", join(dir, "physical", "nested", "settings.json"));
  files.writeJsonAtomic(join(dir, "alias", "settings.json"), { a: 1 }, { userFile: true, preserveOnError: true });
  expect(JSON.parse(readFileSync(join(dir, "physical", "target.json"), "utf8"))).toEqual({ a: 1 });
  expect(JSON.parse(readFileSync(join(dir, "target.json"), "utf8"))).toEqual({ owner: "unrelated" });
  symlinkSync("b.json", join(dir, "a.json")); symlinkSync("a.json", join(dir, "b.json"));
  expect(() => files.writeJsonAtomic(join(dir, "a.json"), { a: 1 }, { userFile: true })).toThrow("too many links");
  expect(lstatSync(join(dir, "a.json")).isSymbolicLink()).toBe(true);
});
