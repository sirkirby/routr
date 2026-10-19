// Inputs from the independent review, through the source CLI with no provider or harness calls.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adviseCommand } from "../src/lib/commands.mjs";
import { failedUsage } from "../src/lib/usage.mjs";
import { cfg, cliEnv, scratch, SCRIPT } from "./helpers.mjs";
import { BRIEF_MARKER, KEY_MARKER, PROVIDER_MARKER } from "./fixtures/provider-fetch.mjs";

const ts = { provider: "typesafe", model: "jev-1.13.0" }, cf = { provider: "cloudflare", model: "clef" }, local = { provider: "ollama", model: "clef-flash:9b-q8_0" };
const credentials = { TYPESAFE_API_KEY: KEY_MARKER, CLOUDFLARE_API_TOKEN: KEY_MARKER, CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" };
function machine(decision) {
  const home = scratch("decision-review"), folder = join(home, ".config/routr"), config = join(folder, "config.json"); mkdirSync(folder, { recursive: true });
  const settings = { ...(decision === undefined ? {} : { decision }), auto_update: false, telemetry: false, subscriptions: {} };
  writeFileSync(config, JSON.stringify(settings, null, 2) + "\n");
  const brief = join(home, "brief"), report = join(home, "report"); writeFileSync(brief, BRIEF_MARKER); writeFileSync(report, "Verified work. ".repeat(30));
  const run = (args, { replies = {}, env = {}, input = "" } = {}) => {
    const r = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "fixtures/decision-list-fetch.mjs"), SCRIPT, ...args], {
      env: cliEnv(home, { PATH: home, NO_COLOR: "1", ...credentials, ROUTR_TEST_REPLIES: JSON.stringify(replies), ...env }), stdin: Buffer.from(input),
    });
    expect(r.exitCode).toBe(0);
    const stdout = r.stdout.toString(), stderr = r.stderr.toString();
    for (const marker of [BRIEF_MARKER, KEY_MARKER, PROVIDER_MARKER]) { expect(stdout).not.toContain(marker); expect(stderr).not.toContain(marker); }
    return { stdout, stderr, json: () => JSON.parse(stdout) };
  };
  return { home, config, brief, report, run };
}

test("review 1: every key provider preserves the list; plain key set skips local entries", () => {
  const m = machine([ts, cf]), before = readFileSync(m.config, "utf8");
  const missing = m.run(["key", "set", "ollama"]).json();
  expect(missing.note).toContain("not in your decision list"); expect(missing.note).toContain("routr setup --decision typesafe:jev-1.13.0,cloudflare:clef,ollama");
  expect(readFileSync(m.config, "utf8")).toBe(before);
  const localFirst = machine([local, cf]);
  const present = localFirst.run(["key", "set", "ollama"]).json(); expect(present.note).toContain("needs no key"); expect(present.note).not.toContain("routr setup");
  const plain = localFirst.run(["key", "set"], { input: `${KEY_MARKER}\n${credentials.CLOUDFLARE_ACCOUNT_ID}\n` }).json(); expect(plain).toMatchObject({ provider: "cloudflare", works: true });
  expect(plain.note).toBeUndefined();
  const onlyLocal = machine([local]).run(["key", "set"]).json(); expect(onlyLocal.note).toContain("needs no key"); expect(onlyLocal.note).not.toContain("routr setup");
});

test("review 2: a backup reading asks the lead to explain the first failure, not judge the missing level", async () => {
  const m = machine([ts, cf]);
  const r = m.run(["dispatch", "--task-file", m.brief], { replies: { typesafe: "http500" } }).json();
  const next = r.next.map((n) => n.why).join(" ");
  expect(next).toContain("backup decision model answered"); expect(next).toContain("first choice"); expect(next).toContain("HTTP 500");
  expect(next).not.toContain("judge those parts yourself"); expect(next).not.toContain("Judge the level yourself");
  const down = m.run(["dispatch", "--task-file", m.brief], { replies: { typesafe: "http500", cloudflare: "network" } }).json();
  expect(down.next.map((n) => n.why).join(" ")).toContain("Judge the level yourself");
  const withUsage = await adviseCommand("dispatch", BRIEF_MARKER, { config: cfg() }, {}, {
    askFn: async () => ({ provider: r.provider, model: r.decision_model, answers: { level: { score: 1, confidence: 1 }, work_type: { choice: "implement" }, high_blast_radius: { noul: 0 } }, unavailable: r.unavailable }),
    read: async () => [failedUsage("codex", "app-server")],
  });
  expect(withUsage.unavailable.some((u) => u.part === "usage")).toBe(true);
  expect(withUsage.next.map((n) => n.why).join(" ")).toContain("judge those parts yourself");

});

test("review 3a: doctor tests a broken backup even after a ready first model", () => {
  const m = machine([ts, cf]), replies = { cloudflare: "network" };
  const r = m.run(["doctor", "--json"], { replies }).json();
  expect(r.decision).toMatchObject([{ provider: "typesafe", works: true }, { provider: "cloudflare", works: false, code: "unreachable" }]);
  const text = m.run(["doctor"], { replies }).stdout;
  expect(text).toContain("jev-1.13.0 answers"); expect(text).toContain("clef: key found but the test call failed");
});

test("review 3b: 429 retries exhaust only the per-entry cap and leave time to ask a backup", () => {
  const m = machine([ts, cf]), started = performance.now();
  // Two-second replies put another retry past 8 s but inside 10 s. Immediate 429s do not distinguish those caps.
  const r = m.run(["dispatch", "--task-file", m.brief], { replies: { typesafe: "http429" }, env: { ROUTR_TEST_DELAYS: '{"typesafe":2000}' } }).json();
  expect(r).toMatchObject({ provider: "cloudflare", decision_model: "clef", unavailable: [{ provider: "typesafe", code: "provider_error", status: 429 }] });
  expect(performance.now() - started).toBeGreaterThan(7000); expect(performance.now() - started).toBeLessThan(9500);
}, 12000);

test("review 4: setup leaves equivalent object, omitted and list settings byte-for-byte; first setup reports a write", () => {
  for (const decision of [undefined, ts, [ts]]) {
    const m = machine(decision), before = readFileSync(m.config, "utf8");
    const r = m.run(["setup", "--yes", "--decision", "typesafe", "--json"]).json();
    expect(readFileSync(m.config, "utf8")).toBe(before); expect(existsSync(`${m.config}.bak`)).toBe(false);
    expect(r.did.join(" ")).not.toContain("changed decision"); expect(r.did.join(" ")).not.toContain(`wrote ${m.config}`);
    expect(r.skipped.join(" ")).toContain("kept as it is");
  }
  const m = machine();
  const config = join(m.home, "first.json"), r = m.run(["setup", "--yes", "--config", config, "--decision", "cloudflare", "--json"]).json();
  expect(r.did.join(" ")).toContain(`wrote ${config}`); expect(r.did.join(" ")).not.toContain("changed decision");
  expect(JSON.parse(readFileSync(config, "utf8")).decision).toEqual([{ provider: "cloudflare", model: null }]);
});

test("reviews 5 and 7: settings and setup drop duplicate resolved models and give concrete surviving-list remedies", () => {
  const m = machine(["typesafe", ts, { provider: "typesafe" }, cf, cf]);
  const r = m.run(["subagent", "--task-file", m.brief], { replies: { typesafe: "network", cloudflare: "network" } }).json();
  expect(r.unavailable).toHaveLength(2); expect(r.warnings).toHaveLength(3);
  expect(r.warnings[0]).toContain('"typesafe"'); expect(r.warnings[0]).toContain('an object'); expect(r.warnings[0]).not.toContain("provider undefined");
  for (const warning of r.warnings) expect(warning).toContain("routr setup --decision typesafe:jev-1.13.0,cloudflare:clef");
  expect(r.warnings[1]).toContain("duplicate"); expect(r.warnings[2]).toContain("duplicate");
  const setup = machine([cf]), out = setup.run(["setup", "--yes", "--decision", "typesafe,typesafe:jev-1.13.0", "--json"]).json();
  expect(JSON.parse(readFileSync(setup.config, "utf8")).decision).toEqual([{ provider: "typesafe", model: null }]);
  expect(out.skipped.join(" ")).toContain("duplicate"); expect(out.skipped.join(" ")).toContain("routr setup --decision typesafe:jev-1.13.0");
});

test("review 6: every no-reading command and headline identify the last failed model", () => {
  const m = machine([ts, cf]);
  for (const command of [["dispatch", "--task-file", m.brief], ["subagent", "--task-file", m.brief], ["check", "--brief", m.brief, "--report", m.report]]) {
    const r = m.run(command, { replies: { typesafe: "http500", cloudflare: "network" } }).json();
    expect(r.provider).toBe("cloudflare"); expect(r.headline).toContain("clef on Cloudflare Workers AI"); expect(r.unavailable.map((u) => u.provider)).toEqual(["typesafe", "cloudflare"]);
  }
});

test("review 8: help, terminal progress, import direction and the new changelog line stay consistent", () => {
  const m = machine([ts]);
  expect(m.run(["key", "--help"]).stdout).toContain("first entry that needs a key");
  const progress = m.run(["doctor"], { env: { ROUTR_TEST_TTY: "1" } }).stderr;
  expect(progress).toContain("Checking the decision models…"); expect(progress).not.toContain("decision models and ");
  const ledger = readFileSync(join(import.meta.dir, "../src/lib/ledger.mjs"), "utf8");
  expect(ledger).toStartWith("// The run ledger"); expect(ledger).not.toContain('from "./advice-file.mjs"');
  const changelog = readFileSync(join(import.meta.dir, "../CHANGELOG.md"), "utf8");
  expect(changelog).toMatch(/Choose an ordered list[^\n]+\n- Every command/);
});
