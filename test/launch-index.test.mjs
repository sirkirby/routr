import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./helpers.mjs";
import { LaunchIndex } from "../src/lib/launch-index.mjs";

const first = { launch_id: "12345678-1234-4123-8123-123456789abc", advice_id: "abc12345", backend: "pane", repository: "https://github.com/acme/repo", project_hash: "a".repeat(64), path_hash: "b".repeat(64), branch: "worker", pane_id: "pane-1", terminal_id: "terminal-1", traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", created_at: "2026-10-25T12:00:00.000Z" };
test("launch index links only a unique match, fences pane reuse, and retains immutable recovery entries", () => {
  const home = scratch("index"), index = new LaunchIndex({ home, now: () => Date.parse(first.created_at) });
  mkdirSync(join(home, ".local/state/routr"), { recursive: true });
  expect(index.match({ advice_id: first.advice_id })).toBeNull();
  expect(index.add(first)).toBe(true);
  expect(index.match({ advice_id: first.advice_id })).toMatchObject(first);
  expect(index.match({ pane_id: "pane-1", terminal_id: "terminal-2" })).toBeNull();
  expect(index.match({ pane_id: "pane-1", terminal_id: "terminal-1" })).toMatchObject(first);
  expect(index.match({ project_hash: "c".repeat(64), branch: "worker" })).toBeNull();
  expect(index.match({ project_hash: first.project_hash, branch: "worker" })).toMatchObject(first);
  expect(index.match({ project_hash: first.project_hash, repository: "https://github.com/acme/other", branch: "worker" })).toBeNull();
  expect(index.match({ project_hash: first.project_hash, repository: first.repository, branch: "worker" })).toMatchObject(first);
  expect(index.match({ path_hash: first.path_hash })).toMatchObject(first);
  expect(index.recovery({ advice_id: first.advice_id, pane_id: "pane-1", terminal_id: "terminal-1" })).toMatchObject(first);
  expect(index.recovery({ advice_id: "12345678", pane_id: "pane-1", terminal_id: "terminal-1" })).toBeNull();
  expect(index.add({ ...first, spanId: "1234567890abcdef" })).toBe(false);
  expect(index.match({ advice_id: first.advice_id }).spanId).toBe(first.spanId);
  index.finish(first.launch_id);
  expect(index.match({ advice_id: first.advice_id }).finished_at).toBe(first.created_at);
  const second = { ...first, launch_id: "22345678-1234-4123-8123-123456789abc", terminal_id: "terminal-2", spanId: "1234567890abcdef" };
  expect(index.add(second)).toBe(true);
  expect(index.match({ advice_id: first.advice_id })).toBeNull();
  expect(index.match({ pane_id: "pane-1", terminal_id: "terminal-2" })).toMatchObject(second);
  expect(index.recovery({ advice_id: first.advice_id, pane_id: "pane-1", terminal_id: "terminal-1" })).toBeNull(); // finished entries never revive
});

test("the 30-day sweep removes only owned file names, ignores malformed or linked entries and respects uninstall", () => {
  const home = scratch("index-sweep"), state = join(home, ".local/state/routr"), index = new LaunchIndex({ home, now: () => Date.parse(first.created_at) });
  mkdirSync(state, { recursive: true }); index.add(first);
  const foreign = join(state, "launches/keep.json"); writeFileSync(foreign, JSON.stringify(first));
  const old = new LaunchIndex({ home, now: () => Date.parse(first.created_at) + 30 * 86400000 });
  expect(old.match({ advice_id: first.advice_id })).toBeNull(); old.sweep();
  expect(existsSync(foreign)).toBe(true);
  expect(existsSync(join(state, "launches", first.launch_id + ".json"))).toBe(false);
  writeFileSync(join(state, "uninstalling"), "{}");
  expect(index.add(first)).toBe(false);
  expect(readFileSync(foreign, "utf8")).toBe(JSON.stringify(first));
});
