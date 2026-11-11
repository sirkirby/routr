// The three fixes of the usage-readings change, through the command line only (nothing imported from routr), so the
// same file shows what an earlier routr did: a background refresh of Cursor's usage carries the caller's --config, a
// new machine with no cache folder starts one, and board does not repeat a "being taken" note after the refresh landed.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliEnv, fakeExecutable, scratch, SCRIPT } from "./helpers.mjs";

// A routr CLI with its detached starts recorded (fixtures/spawn-recorder.mjs), in a home of its own, with no harness on
// PATH but the ones a test puts there, and Cursor signed in unless the test says otherwise.
const cliHome = (name, { signedIn = true, cache = true } = {}) => {
  const home = scratch(name), spawns = join(home, "spawns.jsonl");
  mkdirSync(join(home, "rel"), { recursive: true });
  writeFileSync(join(home, "rel/c.json"), JSON.stringify({ subscriptions: { cursor: { hardest_work: "strong", reserve: 0 } }, auto_update: false }));
  if (cache) { mkdirSync(join(home, ".cache/routr"), { recursive: true }); if (signedIn) writeFileSync(join(home, ".cache/routr/signed-in.json"), JSON.stringify({ cursor: { ts: Date.now() / 1000, state: "yes" } })); }
  return { home, spawns, config: resolve(realpathSync(home), "rel/c.json"), started: () => (existsSync(spawns) ? readFileSync(spawns, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
};
const cli = (h, args, env = {}, preload = []) => {
  const p = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "fixtures/spawn-recorder.mjs"), ...preload.flatMap((f) => ["--preload", f]), SCRIPT, ...args],
    { cwd: h.home, env: cliEnv(h.home, { PATH: h.home, ROUTR_NO_REFRESH: "", ROUTR_TEST_SPAWNS: h.spawns, ...env }), stdin: "ignore" });
  expect(p.exitCode, p.stderr.toString()).toBe(0);
  return JSON.parse(p.stdout.toString());
};

test("routr usage and dispatch start Cursor's background refresh with the caller's --config, resolved", () => {
  const usage = cliHome("cli-config-usage");
  cli(usage, ["usage", "--config", "rel/c.json"]);
  expect(usage.started()).toEqual([["usage", "--background", "--claim", expect.any(String), "--config", usage.config]]);
  const dispatch = cliHome("cli-config-dispatch");
  cli(dispatch, ["dispatch", "--config", "rel/c.json", "fix the typo in the readme"], { TYPESAFE_API_KEY: "fixture-key", ROUTR_TEST_PROVIDER: "typesafe", ROUTR_TEST_REPLY: "valid" },
    [join(import.meta.dir, "fixtures/provider-fetch.mjs")]);
  expect(dispatch.started()).toEqual([["usage", "--background", "--claim", expect.any(String), "--config", dispatch.config]]);
});

test("on a new machine with no cache folder at all, the first routr usage starts Cursor's background refresh", () => {
  const h = cliHome("cli-cold", { cache: false });
  fakeExecutable(h.home, "cursor-agent", 'console.log("✓ Logged in as someone@example.com");');
  expect(existsSync(join(h.home, ".cache"))).toBe(false);
  const out = cli(h, ["usage", "--config", "rel/c.json"]);
  expect(h.started()).toHaveLength(1);
  expect(h.started()).toEqual([["usage", "--background", "--claim", expect.any(String), "--config", h.config]]);
  expect(out.subscriptions.ranked.find((x) => x.subscription === "cursor").note).toContain("a fresh reading is being taken in the background");
});

// 1. A good reading, five hours old; 2. a live call starts a refresh and serves it, saying so. The home, and that answer.
function agedThenLive(name) {
  const h = cliHome(name), at = Date.now() / 1000 - 5 * 3600;
  // Kept as this routr keeps it, and as an earlier one did (which this one removes).
  mkdirSync(join(h.home, ".cache/routr/usage"), { recursive: true });
  writeFileSync(join(h.home, ".cache/routr/cursor-usage.json"), JSON.stringify({ ts: at, tried: at, reading: { included_used_pct: 40, auto_used_pct: null, api_used_pct: null } }));
  writeFileSync(join(h.home, ".cache/routr/usage/cursor.json"), JSON.stringify({ reading: { source: "cursor /usage", takenAt: at, trustedUntil: at + 86400,
    windows: [{ name: "included", usedPct: 40, windowMin: null, resetsAt: null }], note: "Included 40% used (Auto ?, API ?)" }, attempt: { at, by: null, outcome: "ok" } }));
  const live = cli(h, ["usage", "--config", "rel/c.json"]);
  expect(live.subscriptions.ranked.find((x) => x.subscription === "cursor").note).toBe("Included 40% used (Auto ?, API ?); a fresh reading is being taken in the background");
  return h;
}
const boardRow = (h) => cli(h, ["board", "--config", "rel/c.json"]).subscriptions.ranked.find((x) => x.subscription === "cursor");

test("board does not repeat 'being taken' once the refresh a live call started has landed", () => {
  const h = agedThenLive("cli-board-note");
  // 3. That refresh lands.
  const [argv] = h.started();
  cli(h, argv, { ROUTR_TEST_CURSOR_PCT: "30" });
  // 4. Board, with no live call since: the new reading, and no suffix.
  const row = boardRow(h);
  expect(row.note).not.toContain("being taken");
  expect(row).toMatchObject({ note: "Included 30% used (Auto ?, API ?)", headroom: 0.7 });
  expect(h.started()).toHaveLength(1);
});

test("board does not repeat 'being taken' when the refresh a live call started never lands", () => {
  // Its process died: nothing landed, and no reading is being taken any more.
  const h = agedThenLive("cli-board-died");
  const row = boardRow(h);
  expect(row.note).not.toContain("being taken");
  expect(row).toMatchObject({ note: "Included 40% used (Auto ?, API ?)", headroom: 0.6 });
});
