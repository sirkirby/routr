// setup.mjs, doctor.mjs, uninstall.mjs: what the user sees when setting routr up and taking it down
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/lib/config.mjs";
import { claudeSnapshot } from "../src/lib/usage.mjs";
import { HARDEST, LEVEL_MEANING, RESERVE } from "../src/lib/wording.mjs";
import { COMMANDS, formatCommandHelp } from "../src/lib/help.mjs";
import { cliEnv, NOW, row, scratch, SCRIPT } from "./helpers.mjs";

test("doctor reports opted-in telemetry sends in text and JSON and flags failures or stale pending rows", () => {
  const home = scratch("doctor-telemetry"), env = cliEnv(home, { PATH: home, ROUTR_NO_UPDATE: "1" });
  const config = join(home, ".config/routr/config.json"), state = join(home, ".local/share/routr/telemetry.json");
  const ledger = join(home, ".local/share/routr/ledger.jsonl"), log = join(home, ".cache/routr/telemetry.log");
  const json = () => JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json"], { env }).stdout.toString());
  const text = () => Bun.spawnSync([process.execPath, SCRIPT, "doctor"], { env }).stdout.toString();
  try {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ telemetry: false }));
    expect(json().telemetry).toEqual({ on: false, why_off: "not turned on (the default): routr telemetry on" });
    expect(text()).not.toContain("telemetry sends");
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    writeFileSync(config, JSON.stringify({ telemetry: true }));
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ opted_in_at: old, sent_through: old }));
    writeFileSync(ledger, JSON.stringify(row({ ts: new Date().toISOString() })) + "\n");
    // Opted in 72 h ago, a row pending, nothing ever sent: no send for over 48 h.
    expect(json().telemetry).toMatchObject({ on: true, last_send: null, pending: 1, quiet_hours: 72, needs_attention: true });
    expect(text()).toContain("!! telemetry sends: nothing sent yet · running from source: the daily job never runs here; use routr telemetry send · no send for over 48 h, 1 row pending");
    expect(text()).toContain("Telemetry is on but not sending: `routr telemetry status` says why");
    expect(text()).not.toContain("Everything routr needs is in place.");
    mkdirSync(dirname(log), { recursive: true });
    // A failed send from before the current yes (off, then on again) raises nothing now (from the verification of #40).
    writeFileSync(log, JSON.stringify({ at: new Date(Date.now() - 100 * 3600000).toISOString(), ok: false, sent: 0, error: "endpoint answered 500" }) + "\n");
    expect(json().telemetry).toMatchObject({ last_send: null, quiet_hours: 72 });
    writeFileSync(log, JSON.stringify({ at: new Date(Date.now() - 5 * 3600000).toISOString(), ok: true, sent: 3 }) + "\n");
    // From source the daily job never runs, so a pending row needs a hand send, however recent the last one.
    expect(json().telemetry).toMatchObject({ last_send: { ok: true, sent: 3 }, needs_attention: true });
    expect(text()).toContain("telemetry sends: last sent 5 h ago (3 rows) · running from source: the daily job never runs here; use routr telemetry send · 1 row pending"); // hours, as the updates line says them
    writeFileSync(log, JSON.stringify({ at: old, ok: true, sent: 3 }) + "\n");
    expect(json().telemetry.needs_attention).toBe(true);
    expect(text()).toContain("last sent 72 h ago (3 rows)");
    expect(text()).toContain("no send for over 48 h, 1 row pending");
    writeFileSync(log, JSON.stringify({ at: new Date().toISOString(), ok: false, sent: 0, error: "endpoint answered 500" }) + "\n");
    expect(json().telemetry).toMatchObject({ last_send: { ok: false, error: "endpoint answered 500" }, needs_attention: true });
    expect(text()).toContain("!! telemetry sends: last send failed 0 h ago: endpoint answered 500");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("doctor's next steps name the command for each thing missing, most important first", async () => {
  const { nextSteps, starterConfig } = await import("../src/lib/doctor.mjs");
  const { ROUTR_VERSION } = await import("../src/lib/version.mjs");
  const base = { key: { works: true }, config: { exists: true, subscriptions: ["claude"] }, harnesses: { claude: { installed: true, signed_in: true } }, skill: [{ version: ROUTR_VERSION.split("-")[0] }, { name: "routr-orchestrate", version: ROUTR_VERSION.split("-")[0] }], herdr: { path: "/x", skill: true } };
  expect(nextSteps(base)).toEqual([]);
  // Claude's usage is read through its own /usage: no statusline is ever a step.
  const fresh = nextSteps({ ...base, key: { works: false, found: false }, config: { exists: false, subscriptions: [] } });
  expect(fresh[0]).toContain("routr key set");
  expect(fresh[1]).toContain("routr setup");
  expect(fresh.length).toBe(2);
  expect(fresh.join(" ")).not.toContain("statusline");
  expect(nextSteps({ ...base, harnesses: { claude: { installed: true, signed_in: true }, codex: { installed: true, signed_in: true } } })[0]).toContain("codex");
  // Signed out: not offered to set up, and a configured one says how to sign in again.
  expect(nextSteps({ ...base, harnesses: { claude: { installed: true, signed_in: true }, codex: { installed: true, signed_in: false, sign_in: "not signed in: run `codex login`" } } })).toEqual([]);
  expect(nextSteps({ ...base, harnesses: { claude: { installed: true, signed_in: false, sign_in: "not signed in: run `claude auth login`" } } })).toEqual(["Claude Code is set up in routr but gets no work: not signed in: run `claude auth login`"]);
  // Turned off by the user: no nagging to sign in.
  expect(nextSteps({ ...base, config: { ...base.config, off: ["claude"] }, harnesses: { claude: { installed: true, signed_in: false, sign_in: "not signed in: run `claude auth login`" } } })).toEqual([]);
  // Claude answered and sent no windows: the user says whether the seat has a quota; once `billing` is set, nothing to do.
  const reading = (snap) => { const u = claudeSnapshot(snap, NOW / 1000); return { installed: true, signed_in: true, usage_class: u.class, usage_note: u.note, ...(u.reason ? { usage_reason: u.reason } : {}) }; };
  const noWindows = { ...base, harnesses: { claude: reading({ ts: NOW / 1000, rate_limits: null, answered: true, seen: null }) } };
  expect(nextSteps(noWindows)[0]).toContain('"billing": "metered"'); expect(nextSteps(noWindows)[0]).toContain('"billing": "included"');
  expect(nextSteps({ ...noWindows, config: { ...base.config, billing: { claude: "metered" } } })).toEqual([]);
  expect(nextSteps({ ...noWindows, config: { ...base.config, billing: { claude: "included" } } })).toEqual([]);
  expect(nextSteps({ ...noWindows, harnesses: { claude: reading({ ts: NOW / 1000, rate_limits: null, answered: false, seen: null }) } })).toEqual([]); // before the first response: nothing to say yet
  // The starter config never carries a placeholder: a model is there only when the user chose one.
  const c = starterConfig(["claude", "agy"], { claude: "sonnet" });
  expect(c.subscriptions.claude).toEqual({ hardest_work: "strong", reserve: 0.25, default_model: "sonnet", default_effort: "medium" });
  expect(c.subscriptions.agy).toEqual({ hardest_work: "standard", reserve: 0.1 });
  // Kiro starts on its own router with effort left to the model; a model the user picks replaces auto.
  expect(starterConfig(["kiro"]).subscriptions.kiro).toEqual({ hardest_work: "standard", reserve: 0.1, default_model: "auto", default_effort: "auto" });
  expect(starterConfig(["kiro"], { kiro: "glm-5" }).subscriptions.kiro.default_model).toBe("glm-5");
  expect(starterConfig(["codex"], {}, { codex: "with" }).subscriptions.codex).toMatchObject({ metered_rank: "with" });
  const { parseMetered, meteredRanks } = await import("../src/lib/setup.mjs");
  expect(parseMetered(["--metered", "codex=with", "--metered", "agy=after"])).toEqual({ codex: "with", agy: "after" });
  for (const bad of [["--metered", "codex=first"], ["--metered", "nope=after"], ["--metered"]]) expect(() => parseMetered(bad)).toThrow("--metered takes");
  // The rank question: only for a fresh pool that reads as metered and has no flag; Enter or anything but "w…" is after; --yes (no ask) is after.
  const hs = { codex: { usage_class: "metered", usage_note: "n" }, claude: { usage_class: "included" } };
  const asked = [];
  expect(await meteredRanks(["codex", "claude"], hs, {}, async (n) => { asked.push(n); return " With "; })).toEqual({ codex: "with" }); expect(asked).toEqual(["codex"]);
  expect(await meteredRanks(["codex"], hs, {}, async () => "")).toEqual({ codex: "after" });
  expect(await meteredRanks(["codex"], hs, { codex: "with" }, async () => { throw new Error("must not ask"); })).toEqual({ codex: "with" });
  expect(await meteredRanks(["codex"], hs, {}, null)).toEqual({ codex: "after" });
});

test("--model takes repeatable subscription=id pairs", async () => {
  const { parseModels } = await import("../src/lib/setup.mjs");
  expect(parseModels(["--yes", "--model", "claude=sonnet", "--model", "codex=m"])).toEqual({ claude: "sonnet", codex: "m" });
  expect(() => parseModels(["--model", "gpt=4"])).toThrow();
});

test("routr setup --yes writes the config once, keeps it afterwards, and starts no harness", () => {
  const home = scratch("setup");
  // An empty PATH: no harness is found, so none is started (a logged-out harness opens a browser to sign in).
  const env = cliEnv(home, { PATH: home });
  const first = Bun.spawnSync([process.execPath, SCRIPT, "setup", "--yes", "--json"], { env });
  expect(first.exitCode).toBe(0);
  const file = join(home, ".config/routr/config.json");
  expect(JSON.parse(first.stdout.toString()).did.join("\n")).toContain("wrote");
  expect(existsSync(join(home, ".agents/skills/routr/SKILL.md"))).toBe(true);              // a missing skill is repaired too
  expect(JSON.parse(readFileSync(file, "utf8")).subscriptions).toEqual({});
  writeFileSync(file, JSON.stringify({ subscriptions: {}, sure_at: 0.9 }));
  const again = Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--fix", "--yes", "--json"], { env }); // the same command under its familiar name
  expect(JSON.parse(again.stdout.toString()).did).toEqual([]);
  expect(JSON.parse(readFileSync(file, "utf8")).sure_at).toBe(0.9);
  const bad = Bun.spawnSync([process.execPath, SCRIPT, "setup", "--yes", "--model", "codex=m"], { env });
  expect(bad.exitCode).toBe(1);
  expect(Bun.spawnSync([process.execPath, SCRIPT, "setup", "--yes", "--metered", "codex=with"], { env }).exitCode).toBe(1); // codex is not found on an empty PATH
});

test("hardest_work and reserve are read from flags, and a bad value is refused", async () => {
  const { parseLevel, parseShare, parseHardest, parseReserve } = await import("../src/lib/setup.mjs");
  expect([parseLevel("Strong"), parseLevel("1"), parseLevel("3"), parseLevel("s"), parseLevel("")]).toEqual(["strong", "basic", "strong", null, null]);
  expect([parseShare("0.25"), parseShare("25%"), parseShare(".1"), parseShare("0"), parseShare("1.5"), parseShare("-1"), parseShare("x"), parseShare("")]).toEqual([0.25, 0.25, 0.1, 0, null, null, null, null]);
  expect(parseHardest(["--hardest", "cursor=strong", "--hardest", "agy=2"])).toEqual({ cursor: "strong", agy: "standard" });
  expect(parseReserve(["--reserve", "claude=30%"])).toEqual({ claude: 0.3 });
  for (const bad of [["--hardest", "cursor=huge"], ["--hardest", "gpt=strong"], ["--reserve", "claude=2"], ["--reserve", "claude"]])
    expect(() => (bad[0] === "--hardest" ? parseHardest : parseReserve)(bad)).toThrow();
});

test("routr setup changes a setting on an existing config, fills one that is missing, and doctor flags it until then", () => {
  const home = scratch("settings");
  const env = cliEnv(home, { PATH: home });
  const file = join(home, ".config/routr/config.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ telemetry: false, subscriptions: { cursor: { hardest_work: "standard", reserve: 0.1, default_model: "m" }, claude: { reserve: 0.25 } } }));
  const doctor = JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json"], { env }).stdout.toString());
  expect(doctor.config.problems.join(" ")).toContain("subscriptions.claude.hardest_work is not set");
  expect(doctor.next_steps.join(" ")).toContain("routr setup --hardest claude=");
  const r = Bun.spawnSync([process.execPath, SCRIPT, "setup", "--yes", "--json", "--hardest", "cursor=strong", "--reserve", "cursor=20%"], { env });
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.did.join(" ")).toContain('cursor.hardest_work "standard" → "strong"');
  expect(out.did.join(" ")).toContain('claude.hardest_work set to "strong"');
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.subscriptions.cursor).toEqual({ hardest_work: "strong", reserve: 0.2, default_model: "m" });
  expect(saved.subscriptions.claude).toEqual({ reserve: 0.25, hardest_work: "strong" });
  expect(JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json"], { env }).stdout.toString()).config.problems).toEqual([]);
  // A subscription neither configured nor found cannot be set.
  expect(Bun.spawnSync([process.execPath, SCRIPT, "setup", "--yes", "--hardest", "agy=strong"], { env }).exitCode).toBe(1);
});

// setup, driven end to end as a person would: scripted answers, a fake machine, nothing written outside a temp folder.
// Every question asked is recorded, and a question the scenario did not expect fails it.
async function runSetup({ config, args = [], answers = [], found = ["agy", "cursor"], signedOut = [], keyWorks = true, env = {}, efforts = async () => null, models = {}, skill = [{ where: "~/.agents/skills/routr", version: "0.0.0-dev" }, { name: "routr-orchestrate", where: "~/.agents/skills/routr-orchestrate", version: "0.0.0-dev" }], usage = {}, print = () => {} } = {}) {
  const { setup } = await import("../src/lib/setup.mjs");
  const dir = scratch("setup-run"), path = join(dir, "config.json");
  if (config) writeFileSync(path, JSON.stringify(config));
  const asked = [], shared = [], installs = [], keys = [];
  const inspect = async () => {
    const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    return { harnesses: Object.fromEntries(["claude", "codex", "cursor", "agy", "kiro"].map((n) => [n, { installed: found.includes(n) || signedOut.includes(n), signed_in: found.includes(n), ...(signedOut.includes(n) ? { sign_in: `not signed in: run \`${n}-cli login\`` } : {}), models: models[n] ?? [], usage_class: usage[n] ?? "included", usage_note: usage[n] === "metered" ? "metered: unlimited credits" : undefined }])),
      config: { path, exists: Boolean(saved), subscriptions: Object.keys(saved?.subscriptions ?? {}), off: Object.keys(saved?.subscriptions ?? {}).filter((n) => saved.subscriptions[n].enabled === false) }, skill,
      key: { works: keyWorks }, next_steps: [] };
  };
  const queue = [...answers];
  const question = async (q) => { asked.push(q.trim()); if (!queue.length) throw new Error(`unexpected question: ${q.trim()}`); return queue.shift(); };
  const r = await setup(["--config", path, "--json", ...args], { inspect, question, interactive: true, env,
    install: () => installs.push(1), share: (on) => shared.push(on), key: async () => { keys.push(1); return { ok: false, error: "none given" }; }, print, efforts });
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  return { r, asked, saved, shared, installs, keys, left: queue.length };
}

// The guided flow, answered line by line (the tui's accessible mode takes the same answers a screen reader user types).
const q = (asked, start) => asked.filter((x) => x.startsWith(start)).length;

test("setup, new install: which subscriptions, then each one's settings, telemetry off by default, then save and exit", async () => {
  // cursor then agy (the registry's order): model (Enter: leave it to the lead), hardest work, reserve; then telemetry; then Save and exit.
  const x = await runSetup({ answers: ["", "", "3", "4", "", "", "", "", "", "n", ""] });
  expect(x.r.ok).toBe(true);
  expect(x.asked[0]).toMatch(/^Which subscriptions may routr hand work to\?/);
  expect(q(x.asked, "Cursor: the hardest work routr may send there")).toBe(1);
  expect(q(x.asked, "Antigravity: reserve")).toBe(1);
  expect(q(x.asked, "Share anonymous outcomes once a day? [y/N]")).toBe(1);
  expect(q(x.asked, "Save your changes?")).toBe(1);
  expect(x.saved.subscriptions.cursor).toMatchObject({ hardest_work: "strong", reserve: 0.25, enabled: true });
  expect(x.saved.subscriptions.agy).toMatchObject({ hardest_work: "standard", reserve: 0.1, enabled: true });
  expect(x.shared).toEqual([false]);
  expect(x.left).toBe(0);
});

test("setup, new install: a harness left unticked is added turned off, with its settings, to turn on later", async () => {
  const x = await runSetup({ answers: ["2", "", "", "", "", "", "n", ""] }); // choose Cursor, confirm, model/hardest/reserve/use, telemetry, Save
  expect(x.saved.subscriptions.agy).toMatchObject({ enabled: false, hardest_work: "standard", reserve: 0.1 });
  expect(x.saved.subscriptions.cursor).toMatchObject({ enabled: true });
  expect(q(x.asked, "Antigravity:")).toBe(0); // nothing asked about one that is off
});

test("setup: a harness installed but not signed in is listed, greyed, with what to run, once per question, and cannot be chosen", async () => {
  // First run: Kiro is on the list with its sign-in; choosing it (3) says why and asks again; Enter keeps the two signed in.
  const said = [];
  const x = await runSetup({ signedOut: ["kiro"], answers: ["3", "", "", "", "", "", "", "", "", "", "n", ""], print: (t) => said.push(t) });
  expect(said.filter((t) => t.includes("Kiro: not signed in"))).toEqual(["  Kiro: not signed in: run `kiro-cli login`"]); // only as the reason a choice was refused
  const list = x.asked[0];
  expect(list).toContain("[-] Kiro (not signed in: run `kiro-cli login`)");
  expect(x.asked[1]).toMatch(/^Which subscriptions may routr hand work to\?/); // asked again after the refused choice
  expect(x.saved.subscriptions.kiro).toBeUndefined();
  expect(Object.keys(x.saved.subscriptions).sort()).toEqual(["agy", "cursor"]);
  expect(x.r.skipped).toContain("Kiro left out: not signed in: run `kiro-cli login`, then routr setup again");
  // An agent's run says it too, in the JSON it reads, for any harness: nothing is set up for one signed out.
  const agent = await runSetup({ args: ["--yes"], found: ["claude"], signedOut: ["codex", "kiro"] });
  expect(agent.r.skipped.filter((x) => x.includes("left out"))).toEqual(["Codex left out: not signed in: run `codex-cli login`, then routr setup again", "Kiro left out: not signed in: run `kiro-cli login`, then routr setup again"]);
  expect(Object.keys(agent.saved.subscriptions)).toEqual(["claude"]);
  // Run again: "Choose which subscriptions", Esc, and again: Kiro is on the list each time, and nothing is written.
  const told = [];
  const again = await runSetup({ config: x.saved, signedOut: ["kiro"], answers: ["2", "b", "2", "b", "6"], print: (t) => told.push(t) }); // …, then Exit (6th, after the update channel)
  expect(told.join("\n").match(/not signed in/g)).toHaveLength(1); // in the summary of settings, once
  const lists = again.asked.filter((a) => a.startsWith("Which subscriptions"));
  expect(lists.length).toBe(2);
  expect(lists.every((a) => a.includes("[-] Kiro (not signed in: run `kiro-cli login`)"))).toBe(true);
  expect(again.saved).toEqual(x.saved);
  expect(again.left).toBe(0);
});

test("from the review: one set up but signed out is never asked anything and is not turned on, and a run that changes nothing still says who was left out", async () => {
  const called = [];
  const efforts = async (n) => { called.push(n); return ["low", "medium", "high"]; };
  const config = { telemetry: false, subscriptions: { cursor: { hardest_work: "standard", reserve: 0.1, use: "normal" }, kiro: { hardest_work: "standard", reserve: 0.1, enabled: false }, codex: { hardest_work: "strong", reserve: 0.2 } } };
  // Walk through everything (4th with telemetry answered): Kiro, off, is a greyed row; Codex, on, can be turned off; Enter
  // keeps things; only Cursor's settings are walked; then Save (nothing changed, so none is offered: Exit).
  const x = await runSetup({ config, found: ["cursor"], signedOut: ["kiro", "codex"], efforts, answers: ["4", "", "", "", "", "", "5"] });
  expect(x.left).toBe(0);
  const list = x.asked.find((a) => a.startsWith("Which subscriptions"));
  expect(list).toContain("[-] Kiro (not signed in: run `kiro-cli login`)");
  expect(list).toContain("[x] Codex (strong work · reserve 20% · not signed in: run `codex-cli login`)".replace("strong work", "model left to the lead agent · strong work"));
  expect(x.asked.some((a) => a.startsWith("Kiro:") || a.startsWith("Codex:"))).toBe(false);
  expect(called.filter((n) => n !== "cursor")).toEqual([]);
  expect(x.saved).toEqual(config);
  expect(x.r.skipped).toEqual(["nothing changed"]); // both are set up: nothing was left out
  // "Change one subscription's settings" on one signed out says what to run and opens nothing.
  const said = [];
  const one = await runSetup({ config, found: ["cursor"], signedOut: ["kiro", "codex"], efforts, answers: ["", "1", "4", "5"], print: (t) => said.push(t) }); // Codex, told, Back, Exit
  expect(one.left).toBe(0);
  expect(one.asked.find((a) => a.startsWith("Which subscription?"))).toContain("Codex (model left to the lead agent · strong work · reserve 20% · not signed in: run `codex-cli login`)");
  expect(said.join("\n")).toContain("Codex: not signed in: run `codex-cli login`, then change its settings here.");
  expect(one.asked.some((a) => a.startsWith("Codex: which setting?"))).toBe(false);
  // An agent cannot turn it on either; it can still turn one off, or change a setting that asks nothing of the harness.
  expect((await runSetup({ config, found: ["cursor"], signedOut: ["kiro"], args: ["--yes", "--enable", "kiro"] })).r.error).toBe("--enable kiro: not signed in: run `kiro-cli login`");
  // --force sets up only what is signed in now, so one set up before is left out, and says so.
  const forced = await runSetup({ config, found: ["cursor"], signedOut: ["kiro"], args: ["--yes", "--force"] });
  expect(Object.keys(forced.saved.subscriptions)).toEqual(["cursor"]);
  expect(forced.r.skipped).toContain("Kiro left out: not signed in: run `kiro-cli login`, then routr setup again");
  const off = await runSetup({ config, found: ["cursor"], signedOut: ["codex"], args: ["--yes", "--disable", "codex", "--hardest", "codex=standard"] });
  expect(off.saved.subscriptions.codex).toMatchObject({ enabled: false, hardest_work: "standard" });
  // A person who exits without a change still hears about one not set up, as an agent's run does.
  const quiet = await runSetup({ config, found: ["cursor"], signedOut: ["agy"], answers: ["5"] }); // Exit
  expect(quiet.r.skipped).toEqual(["Antigravity left out: not signed in: run `agy-cli login`, then routr setup again", "nothing changed"]);
});

test("setup, run again: a menu to change one thing, then save and exit, and only that is written", async () => {
  const config = { subscriptions: { agy: { hardest_work: "standard", reserve: 0.1 }, cursor: { hardest_work: "standard", reserve: 0.1, default_model: "m" } } };
  // Change one subscription → Cursor → Hardest work → strong; Back to the subscriptions (4th), Back to the menu (3rd);
  // then Save and exit (6th), with no second question.
  const x = await runSetup({ config, answers: ["", "", "2", "3", "5", "3", "6"] });
  expect(x.asked[0]).toMatch(/^What would you like to do\?/);
  expect(x.saved.subscriptions.cursor).toEqual({ hardest_work: "strong", reserve: 0.1, default_model: "m" });
  expect(x.saved.subscriptions.agy).toEqual({ hardest_work: "standard", reserve: 0.1 });
  expect(x.r.did.join(" ")).toContain('cursor.hardest_work "standard" → "strong"');
  expect(x.shared).toEqual([]); // telemetry was on the menu, and not chosen: left as it was
  expect(x.left).toBe(0);
});

test("setup, run again: Exit changes nothing, and exiting without saving after a change writes nothing", async () => {
  const config = { telemetry: true, subscriptions: { agy: { hardest_work: "strong", reserve: 0.3 } } };
  const done = await runSetup({ config, found: ["agy"], answers: ["5"] }); // one, choose, channel, all, Exit
  expect(done.saved).toEqual(config);
  expect(done.r.skipped).toContain("nothing changed");
  const quit = await runSetup({ config, found: ["agy"], answers: ["", "", "2", "1", "b", "b", "6"] }); // agy → hardest → basic, Esc twice, Exit without saving (6th)
  expect(quit.r).toMatchObject({ ok: false, cancelled: true });
  expect(quit.saved).toEqual(config);
});

test("setup: the everyday model is picked from the harness's live list by typing part of its name", async () => {
  const list = [...Array.from({ length: 230 }, (_, i) => `vendor-model-${i}`), "cursor-grok-4.6-high", "grok-4.7-high", "grok-4.7-low"];
  const config = { telemetry: false, subscriptions: { cursor: { hardest_work: "standard", reserve: 0.1, default_model: "cursor-grok-4.6-high" } } };
  // Change one → Cursor (only one) → Everyday model → "4.7 high" (one match) → Esc twice → Save and exit (5th: telemetry is answered).
  const x = await runSetup({ config, found: ["cursor"], models: { cursor: list }, answers: ["", "", "", "4.7 high", "b", "b", "5"] });
  expect(x.saved.subscriptions.cursor.default_model).toBe("grok-4.7-high");
  expect(x.asked.find((a) => a.startsWith("Cursor: everyday model"))).toContain("234 to choose from"); // searched, never printed whole
});

test("setup: a harness whose list is a sample (Claude Code's aliases) takes an id it does not list, typed or by flag", async () => {
  const config = { telemetry: false, subscriptions: { claude: { hardest_work: "strong", reserve: 0.25, default_model: "opus" } } };
  // Change one → Claude (only one) → Everyday model → a full name → offered "as typed", chosen by its number → Esc twice → Save and exit.
  const x = await runSetup({ config, found: ["claude"], models: { claude: ["fable", "opus", "sonnet"] }, answers: ["", "", "", "claude-fable-5", "1", "b", "b", "5"] });
  expect(x.asked.some((a) => a.includes("claude-fable-5 (as typed)"))).toBe(true);
  expect(x.saved.subscriptions.claude.default_model).toBe("claude-fable-5");
  // Opened again, the saved id is just current: off a sample list is not gone (from the review).
  const again = await runSetup({ config: x.saved, found: ["claude"], models: { claude: ["fable", "opus", "sonnet"] }, answers: ["", "", "", "b", "b", "b", "5"] });
  const shown = again.asked.find((a) => a.startsWith("Claude Code: everyday model"));
  expect(shown).toContain("claude-fable-5 (current)");
  expect(shown).not.toContain("not in the harness's list now");
  const flag = await runSetup({ config, found: ["claude", "codex"], models: { claude: ["fable", "opus", "sonnet"], codex: ["gpt-5.5"] }, args: ["--yes", "--model", "claude=claude-fable-5"] });
  expect(flag.saved.subscriptions.claude.default_model).toBe("claude-fable-5");
  // A harness whose list is every id it takes still refuses one it does not list.
  const codex = await runSetup({ config, found: ["claude", "codex"], models: { codex: ["gpt-5.5"] }, args: ["--yes", "--model", "codex=gpt-9"] });
  expect(codex.r.error).toBe("--model codex=gpt-9: not in the harness's current list (gpt-5.5)");
});

test("setup: effort is chosen from the levels the harness takes for that model", async () => {
  const efforts = async (n, model) => (n === "codex" ? (model === "gpt-5.5" ? ["low", "medium", "high", "xhigh"] : null) : null);
  const x = await runSetup({ found: ["codex"], models: { codex: ["gpt-5.5", "gpt-5.6-terra"] }, efforts, answers: ["", "2", "3", "", "", "", "n", ""] }); // 1 is "leave it to the lead agent"
  expect(x.asked.find((a) => a.startsWith("Codex: everyday effort"))).toContain("xhigh");
  expect(x.saved.subscriptions.codex).toMatchObject({ default_model: "gpt-5.5", default_effort: "high" });
});

test("setup with a setting flag at a terminal changes just that, and asks nothing", async () => {
  const config = { telemetry: false, subscriptions: { agy: { hardest_work: "standard", reserve: 0.1 } } };
  const x = await runSetup({ config, found: ["agy"], args: ["--hardest", "agy=basic"] });
  expect(x.asked).toEqual([]);
  expect(x.saved.subscriptions.agy).toEqual({ hardest_work: "basic", reserve: 0.1 });
});

test("setup run by an agent (--yes) asks nothing, takes suggestions, never turns telemetry on, and never asks for the key", async () => {
  const x = await runSetup({ args: ["--yes"], keyWorks: false });
  expect(x.asked).toEqual([]);
  expect(x.saved.subscriptions.agy).toMatchObject({ hardest_work: "standard", reserve: 0.1 });
  expect(x.shared).toEqual([]);
  expect(x.keys).toEqual([]);
  expect(x.r.skipped.join(" ")).toContain("Ask the user whether to share");
  // A person at a terminal with no key is asked for it first: nothing routr advises works without it.
  const person = await runSetup({ keyWorks: false, found: ["agy"], answers: ["", "", "", "", "", "n", ""] });
  expect(person.keys).toEqual([1]);
});

test("the settings are worded once: setup, help, doctor and docs/ranking.md say the same", () => {
  // Every level's meaning, and the reserve's rule and "none", appear word for word in the user docs.
  const doc = readFileSync(new URL("../docs/ranking.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  for (const m of Object.values(LEVEL_MEANING)) expect(doc).toContain(m);
  expect(doc).toContain(RESERVE.none);
  // The help shows the same definitions the questions use.
  const help = formatCommandHelp(COMMANDS.setup);
  expect(help).toContain(HARDEST.flag);
  expect(help).toContain(RESERVE.flag);
  // A missing reserve and 0% mean the same thing, and doctor's note names the command that sets it.
  const dir = scratch("words"), f = join(dir, "c.json");
  writeFileSync(f, JSON.stringify({ subscriptions: { claude: { hardest_work: "strong" } } }));
  const { config, notes } = loadConfig(f);
  expect(config.subscriptions.claude.reserve).toBe(0);
  expect(notes).toEqual([`${RESERVE.unset("claude")}. ${RESERVE.choose("claude")}`]);
  writeFileSync(f, JSON.stringify({ subscriptions: { claude: { hardest_work: "strong", reserve: 0 } } }));
  expect(loadConfig(f).notes).toEqual([]); // 0% is a choice, not a problem
});

test("routr uninstall keeps the user's data unless purged, removes only routr's skills (a developer's link stays), and removes only its own statusline", async () => {
  const { uninstallPlan } = await import("../src/lib/uninstall.mjs");
  const { installSkill } = await import("../src/lib/skill-install.mjs");
  const home = scratch("un");
  const checkout = join(home, "checkout"); mkdirSync(checkout); writeFileSync(join(checkout, "SKILL.md"), "mine");
  for (const d of [".config/routr", ".local/share/routr", ".cache/routr", ".claude", ".kiro"]) mkdirSync(join(home, d), { recursive: true });
  installSkill({ home });
  writeFileSync(join(home, ".config/routr/config.json"), "{}");
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "opus", statusLine: { type: "command", command: "/x/routr statusline" } }));
  const linked = process.platform !== "win32";
  // A developer's own link into their checkout, where routr's link was: not routr's, so it stays.
  if (linked) { rmSync(join(home, ".claude/skills/routr"), { recursive: true, force: true }); (await import("node:fs")).symlinkSync(checkout, join(home, ".claude/skills/routr"), "dir"); }
  expect(uninstallPlan({ home }).keep.length).toBe(2);
  expect(uninstallPlan({ home, purge: true }).keep.length).toBe(0);
  const env = cliEnv(home);
  expect(Bun.spawnSync([process.execPath, SCRIPT, "uninstall"], { env, stdin: Buffer.from("") }).exitCode).toBe(1); // no terminal and no --yes: refuses
  expect(Bun.spawnSync([process.execPath, SCRIPT, "uninstall", "--dry-run"], { env }).exitCode).toBe(0);
  expect(existsSync(join(home, ".cache/routr"))).toBe(true);
  expect(Bun.spawnSync([process.execPath, SCRIPT, "uninstall", "--yes"], { env }).exitCode).toBe(0);
  expect(existsSync(join(home, ".agents/skills/routr"))).toBe(false);
  expect(existsSync(join(home, ".kiro/skills/routr"))).toBe(false);
  expect(existsSync(join(home, ".cache/routr"))).toBe(false);
  expect(existsSync(join(home, ".config/routr/config.json"))).toBe(true);
  expect(existsSync(join(home, ".kiro/skills/routr-orchestrate")) || existsSync(join(home, ".agents/skills/routr-orchestrate"))).toBe(false);
  if (linked) expect(readFileSync(join(home, ".claude/skills/routr/SKILL.md"), "utf8")).toBe("mine"); // the developer's link and its target stay
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"))).toEqual({ model: "opus" });
  expect(Bun.spawnSync([process.execPath, SCRIPT, "uninstall", "--yes", "--purge"], { env }).exitCode).toBe(0);
  expect(existsSync(join(home, ".config/routr"))).toBe(false);
  // Someone else's statusline is not ours to remove.
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ statusLine: { command: "~/mine.sh" } }));
  expect(uninstallPlan({ home }).statusline).toBe(false);
});

// ---- Findings from the independent review (2026-09-21) ----

test("only routr's own statusline counts as ours", async () => {
  const { isOurStatusline } = await import("../src/lib/statusline.mjs");
  for (const c of ["/home/u/.local/bin/routr statusline", '"C:\\Users\\u\\.local\\bin\\routr.exe" statusline', "routr statusline", "~/.claude/claude-statusline-usage.sh"]) expect(isOurStatusline(c)).toBe(true);
  for (const c of ["myroutr statusline", "~/mine.sh", "routr-statusline-fork", "", undefined]) expect(isOurStatusline(c)).toBe(false);
});

test("every setting can be changed by flag, so an agent can do it for the user: effort, on and off, and a look first", async () => {
  const base = { telemetry: false, subscriptions: { codex: { hardest_work: "strong", reserve: 0.2, default_model: "gpt-5.5", default_effort: "medium" }, agy: { hardest_work: "standard", reserve: 0.1 } } };
  const efforts = async (n, model) => (n === "codex" ? (model === "gpt-5.5" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high", "xhigh", "max"]) : null);
  const run = (args, config = base) => runSetup({ config, args: ["--yes", ...args], found: ["codex", "agy"], efforts });
  // --show: the settings as routr reads them; nothing asked of any harness, nothing written.
  const shown = await run(["--show"]);
  expect(shown.r).toMatchObject({ ok: true, exists: true, subscriptions: { codex: { enabled: true, default_effort: "medium", reserve: 0.2 } } });
  // Effort, checked against the levels the harness takes for the model it will run.
  expect((await run(["--effort", "codex=high"])).saved.subscriptions.codex.default_effort).toBe("high");
  expect((await run(["--effort", "codex=max"])).r).toMatchObject({ ok: false, error: "--effort codex=max: Codex takes low, medium, high, xhigh for gpt-5.5" });
  expect((await run(["--model", "codex=gpt-5.6-terra", "--effort", "codex=max"])).saved.subscriptions.codex).toMatchObject({ default_model: "gpt-5.6-terra", default_effort: "max" });
  expect((await run(["--effort", "agy=low"])).r.error).toContain("agy encodes effort in --model");
  // Off keeps every setting; on brings it back as it was.
  const off = await run(["--disable", "agy"]);
  expect(off.saved.subscriptions.agy).toEqual({ hardest_work: "standard", reserve: 0.1, enabled: false });
  expect((await run(["--enable", "agy"], off.saved)).saved.subscriptions.agy).toEqual({ hardest_work: "standard", reserve: 0.1, enabled: true });
  expect((await run(["--disable", "kiro"])).r.error).toBe("--disable kiro: kiro is not set up in routr, so there is nothing to turn off");
  expect((await run(["--enable", "nope"])).r.error).toContain("--enable takes a subscription name");
});

test("setup, guided: asks nothing about Claude's statusline and never writes Claude Code's settings", async () => {
  const settings = join(process.env.HOME, ".claude/settings.json");
  rmSync(settings, { force: true });
  // Claude only: choose, model (leave), hardest, reserve, use; then telemetry, Save. No statusline question.
  const x = await runSetup({ found: ["claude"], answers: ["", "", "", "", "", "n", ""] });
  expect(x.r.ok).toBe(true); expect(x.left).toBe(0);
  expect(x.asked.some((a) => /statusline/i.test(a))).toBe(false);
  expect(existsSync(settings)).toBe(false);
  expect([...x.r.did, ...x.r.skipped].join(" ")).not.toMatch(/statusline/i);
});

test("setup, run again: Esc at the menu with changes not saved offers the same way out, so nothing is lost by accident", async () => {
  const config = { telemetry: false, subscriptions: { agy: { hardest_work: "strong", reserve: 0.3 } } };
  const x = await runSetup({ config, found: ["agy"], answers: ["", "", "2", "1", "b", "b", "b", ""] }); // agy → hardest → basic, Esc up to the menu and once more, Save and exit
  expect(q(x.asked, "Save your changes?")).toBe(1);
  expect(x.saved.subscriptions.agy.hardest_work).toBe("basic");
});

test("an agent changing a setting through the real CLI: --show prints the settings, a flag changes one, --show sees it", () => {
  const home = scratch("agent"), env = cliEnv(home, { PATH: home }); // no harness to find: only flags on an existing config
  const file = join(home, ".config/routr/config.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ telemetry: false, subscriptions: { cursor: { hardest_work: "standard", reserve: 0.1, default_model: "cursor-grok-4.6-high" } } }));
  const show = () => { const r = Bun.spawnSync([process.execPath, SCRIPT, "setup", "--show"], { env }); expect(r.exitCode).toBe(0); return JSON.parse(r.stdout.toString()); };
  expect(show().subscriptions.cursor).toMatchObject({ enabled: true, hardest_work: "standard", reserve: 0.1 });
  const set = Bun.spawnSync([process.execPath, SCRIPT, "setup", "--yes", "--hardest", "cursor=strong", "--reserve", "cursor=20%"], { env });
  expect(set.exitCode).toBe(0);
  expect(set.stdout.toString()).toContain('cursor.hardest_work "standard" → "strong"');
  expect(show().subscriptions.cursor).toMatchObject({ hardest_work: "strong", reserve: 0.2 });
  expect(Bun.spawnSync([process.execPath, SCRIPT, "setup", "--yes", "--disable", "cursor"], { env }).exitCode).toBe(0);
  expect(show().subscriptions.cursor.enabled).toBe(false);
});

test("setup, run again: a subscription's settings are a list you come back to after each change, never 'All of these'", async () => {
  const config = { telemetry: false, subscriptions: { cursor: { hardest_work: "standard", reserve: 0.1, default_model: "m" } } };
  // Cursor → Hardest work → strong → (back on Cursor's list) Reserve → 20% → Back → Back → Save and exit.
  const x = await runSetup({ config, found: ["cursor"], answers: ["", "", "2", "3", "3", "3", "5", "2", "5"] });
  const lists = x.asked.filter((a) => a.startsWith("Cursor: which setting?"));
  expect(lists).toHaveLength(3); // before the first change, after it, and after the second
  expect(lists[1]).toContain("Hardest work (strong)"); // the new value, shown on the list you come back to
  expect(lists.join("\n")).not.toContain("All of these");
  expect(lists[0]).toMatch(/\d\. Back/);
  expect(x.saved.subscriptions.cursor).toMatchObject({ hardest_work: "strong", reserve: 0.2 });
});

test("setup fixes from the independent review: each finding stays fixed", async () => {
  // --disable on a first run: the harness found now is added, turned off ("set up, but keep agy off").
  const first = await runSetup({ args: ["--yes", "--disable", "agy"] });
  expect(first.saved.subscriptions.agy.enabled).toBe(false);
  expect(first.saved.subscriptions.cursor.enabled ?? true).toBe(true);
  // --show only reads: with a change beside it, nothing is done and it says so.
  expect((await runSetup({ args: ["--show", "--disable", "agy"] })).r).toMatchObject({ ok: false, error: expect.stringContaining("--show only reads") });
  // A new model that does not take the effort set: reset to one it takes, and said.
  const efforts = async (n, m) => (m === "m2" ? ["low", "medium"] : ["low", "medium", "high", "xhigh"]);
  const cfg = { telemetry: false, subscriptions: { codex: { hardest_work: "strong", reserve: 0.2, default_model: "m1", default_effort: "xhigh" } } };
  const moved = await runSetup({ config: cfg, found: ["codex"], efforts, args: ["--yes", "--model", "codex=m2"] });
  expect(moved.saved.subscriptions.codex).toMatchObject({ default_model: "m2", default_effort: "medium" });
  expect(moved.r.did.join(" ")).toContain("m2 does not take xhigh");
  // --force rewrites from the suggestions but keeps what the person chose: off stays off, and automatic updates.
  const forced = await runSetup({ config: { auto_update: false, telemetry: true, subscriptions: { agy: { enabled: false, hardest_work: "basic", reserve: 0 } } }, found: ["agy"], args: ["--yes", "--force"] });
  expect(forced.saved).toMatchObject({ auto_update: false, telemetry: true, subscriptions: { agy: { enabled: false } } });
  // Leaving the screen with nothing changed still installs a skill that is missing (it is not a setting).
  const kept = await runSetup({ config: { telemetry: false, subscriptions: { agy: { hardest_work: "standard", reserve: 0.1 } } }, found: ["agy"], skill: [], answers: ["5"] });
  expect(kept.installs).toEqual([1]);
  expect(kept.r.skipped).toContain("nothing changed");
  // An existing subscription with no effort set is not given one behind the person's back.
  const plain = await runSetup({ config: { telemetry: false, subscriptions: { codex: { hardest_work: "strong", reserve: 0.2 } } }, found: ["codex"], answers: ["5"] });
  expect(plain.asked[0]).toContain("Exit"); // nothing pending: no "Save and exit (1 change)"
  expect(plain.saved.subscriptions.codex.default_effort).toBeUndefined();
});

test("setup, guided: a metered seat can be normal use without an assumed budget", async () => {
  const x = await runSetup({ found: ["codex"], usage: { codex: "metered" }, answers: ["", "", "", "", "1", "n", ""] });
  expect(x.asked.some((a) => a.startsWith("Codex: how may routr use this account?"))).toBe(true);
  expect(x.saved.subscriptions.codex.use).toBe("normal");
  expect(x.r.skipped.join(" ")).not.toContain("Ask the user"); // a person's wording, not an agent's
});

test("account-use flags handle unknown billing and legacy settings without changing other preferences", async () => {
  const { parseUse } = await import("../src/lib/setup.mjs");
  expect(parseUse(["--use", "claude=normal", "--use", "codex=fallback"])).toEqual({ claude: "normal", codex: "fallback" });
  for (const value of ["claude=normal=extra", "claude=free", "nope=normal", "claude"]) expect(() => parseUse(["--use", value])).toThrow("--use takes");
  const config = { telemetry: false, subscriptions: { claude: { hardest_work: "strong", reserve: 0.2, billing: "metered", metered_rank: "after" }, codex: { hardest_work: "strong", reserve: 0.1, use: "fallback" } } };
  const x = await runSetup({ config, found: ["claude", "codex"], usage: { claude: "unknown", codex: "metered" }, args: ["--yes", "--use", "claude=normal"] });
  expect(x.asked).toEqual([]);
  expect(x.saved.subscriptions.claude).toEqual({ ...config.subscriptions.claude, use: "normal" });
  expect(x.saved.subscriptions.codex).toEqual(config.subscriptions.codex);
  const legacy = await runSetup({ config, found: ["claude", "codex"], usage: { codex: "metered" }, args: ["--yes", "--metered", "codex=with"] });
  expect(legacy.saved.subscriptions.codex).toMatchObject({ use: "normal", metered_rank: "with" });
  const both = await runSetup({ config, found: ["claude", "codex"], usage: { codex: "metered" }, args: ["--yes", "--metered", "codex=with", "--use", "codex=fallback"] });
  expect(both.saved.subscriptions.codex.use).toBe("fallback");
  const show = await runSetup({ config, args: ["--show", "--use", "claude=normal"] });
  expect(show.r.ok).toBe(false); expect(show.saved).toEqual(config);
  const signedOut = await runSetup({ config, found: ["codex"], signedOut: ["claude"], args: ["--yes", "--use", "claude=normal"] });
  expect(signedOut.saved.subscriptions.claude.use).toBe("normal");
  const forced = await runSetup({ config: x.saved, found: ["claude", "codex"], usage: { claude: "unknown", codex: "metered" }, args: ["--yes", "--force"] });
  expect(forced.saved.subscriptions.claude).toMatchObject({ billing: "metered", use: "normal", metered_rank: "after" });
  expect(forced.saved.subscriptions.codex.use).toBe("fallback");
  const oldWith = { telemetry: false, subscriptions: { codex: { hardest_work: "strong", reserve: 0, metered_rank: "with" } } };
  const rebuilt = await runSetup({ config: oldWith, found: ["codex"], usage: { codex: "metered" }, args: ["--yes", "--force"] });
  expect(rebuilt.saved.subscriptions.codex.metered_rank).toBe("with");
});

test("guided setup offers normal use for unknown billing and fallback for an included account", async () => {
  const unknown = await runSetup({ found: ["claude"], usage: { claude: "unknown" }, answers: ["", "", "", "", "1", "n", ""] });
  expect(unknown.saved.subscriptions.claude.use).toBe("normal");
  const included = await runSetup({ found: ["cursor"], answers: ["", "", "", "", "2", "n", ""] });
  expect(included.saved.subscriptions.cursor.use).toBe("fallback");
});

test("guided account-use selection pins the inferred default on existing accounts", async () => {
  const { accountUse } = await import("../src/lib/config.mjs");
  const config = { telemetry: false, subscriptions: { claude: { hardest_work: "strong", reserve: 0.2 } } };
  for (const [usage, answer, use] of [["unknown", "1", "normal"], ["metered", "2", "fallback"]]) {
    // Change one -> Claude -> Account use (fifth field) -> explicit selection -> back twice -> Save.
    const x = await runSetup({ config, found: ["claude"], usage: { claude: usage }, answers: ["", "", "5", answer, "b", "b", "5"] });
    expect(x.saved.subscriptions.claude.use).toBe(use);
    for (const cls of ["included", "unknown", "metered"]) expect(accountUse(x.saved.subscriptions.claude, cls)).toBe(use);
    expect(x.r.did.join(" ")).toContain("claude.use set to");
  }
  const untouched = await runSetup({ config, found: ["claude"], answers: ["5"] });
  expect(untouched.saved).toEqual(config);
});

test("setup --yes never writes Claude Code's settings, and --no-statusline is still accepted and does nothing", async () => {
  const settings = join(process.env.HOME, ".claude/settings.json");
  rmSync(settings, { force: true });
  for (const args of [["--yes"], ["--yes", "--no-statusline"]]) {
    const x = await runSetup({ found: ["claude"], args });
    expect(x.r.ok).toBe(true); expect(x.saved.subscriptions.claude).toBeDefined();
    expect(existsSync(settings)).toBe(false);
  }
  // A settings file the user has is left exactly as it was, statusline or none.
  const mine = JSON.stringify({ model: "opus" });
  mkdirSync(dirname(settings), { recursive: true }); writeFileSync(settings, mine);
  await runSetup({ found: ["claude"], args: ["--yes", "--force"] });
  expect(readFileSync(settings, "utf8")).toBe(mine); expect(existsSync(`${settings}.bak-before-routr`)).toBe(false);
});

test("from the verification pass: a model change on the screen shows the effort reset before saving, and --show refuses --force", async () => {
  const efforts = async (n, m) => (m === "m2" ? ["low", "medium"] : ["low", "medium", "high", "xhigh"]);
  const config = { telemetry: false, subscriptions: { codex: { hardest_work: "strong", reserve: 0.2, default_model: "m1", default_effort: "xhigh" } } };
  // Codex → Everyday model → m2 (listed 3rd after "leave it" and m1), Back, Back, Save and exit (5th).
  const said = [];
  const x = await runSetup({ config, found: ["codex"], models: { codex: ["m1", "m2"] }, efforts, answers: ["", "", "", "3", "b", "b", "5"], print: (t) => said.push(t) });
  expect(x.saved.subscriptions.codex).toMatchObject({ default_model: "m2", default_effort: "medium" });
  expect(x.asked.find((a) => a.startsWith("What would you like to do?") && a.includes("Save and exit"))).toContain("Save and exit (2 changes)");
  expect((await runSetup({ args: ["--show", "--force"] })).r.error).toContain("--show only reads");
});

test("doctor's text says each harness's state in words: signed in, signed out, turned off, off PATH, missing", async () => {
  const { render } = await import("../src/lib/doctor.mjs");
  const many = Array.from({ length: 30 }, (_, i) => `m${i}`);
  const r = {
    runtime: "routr 0.0.0-dev (from source)", from_source: true, herdr: { path: "/bin/herdr", inside_session: true, skill: true }, skill: [{ where: "~/.agents/skills/routr", version: "0.0.0-dev" }],
    harnesses: {
      claude: { command: "claude", installed: true, signed_in: true, usage: "live: 60% left (claude /usage, 0s old)", usage_source: "claude /usage", models: ["haiku", "sonnet"] },
      codex: { command: "codex", installed: true, signed_in: false, sign_in: "not signed in: run `codex login`" },
      cursor: { command: "cursor-agent", installed: true, signed_in: true, usage: "live: 90% left", models: many },
      agy: { command: "agy", installed: false, off_path: "/Users/x/.local/bin/agy" },
      kiro: { command: "kiro-cli", installed: true, signed_in: true, usage: "live: 100% left" },
    },
    key: { works: true, model: "jev", ms: 300 }, config: { path: "/c.json", exists: true, subscriptions: ["claude", "codex", "cursor", "kiro"], off: ["kiro"], problems: [], notes: [] },
    auto_update: { on: false, why_off: "running from source" }, telemetry: { on: false, why_off: "not turned on" }, next_steps: [],
  };
  const text = render(r);
  expect(text).toContain("claude  `claude` found · usage live: 60% left (claude /usage, 0s old)"); // where the reading came from
  expect(text).not.toMatch(/statusline/i);
  expect(text).toContain("codex   `codex` found, but not signed in: run `codex login`. routr leaves it out until then");
  expect(text).toContain("… (30 in all; run `cursor-agent models` for the rest)");
  expect(text).toContain("agy     `agy` is installed at /Users/x/.local/bin/agy but not on PATH");
  expect(text).toContain("kiro    `kiro-cli` found · turned off in your settings (routr setup --enable kiro)");
  r.harnesses.kiro = { command: "kiro-cli", installed: true, signed_in: false, sign_in: "not signed in: run `kiro-cli login`" };
  expect(render(r)).toContain("kiro    `kiro-cli` found · turned off in your settings (not signed in: run `kiro-cli login`, then routr setup --enable kiro)");
  // The update channel is shown with automatic updates, on or off: `routr update` by hand follows it too.
  expect(text).toContain("automatic updates off: running from source · stable channel");
  r.auto_update = { on: true, channel: "beta", checked_hours_ago: 3, last: null };
  expect(render(r)).toContain("automatic updates on · beta channel (beta and rc releases too; `routr setup --channel stable` leaves it) · last checked 3 h ago");
});

test("the update channel is a setting: --channel writes it, says what happens next, and the menu changes it too", async () => {
  const { channelNote, parseChannel } = await import("../src/lib/setup.mjs");
  const config = { telemetry: false, subscriptions: { agy: { hardest_work: "standard", reserve: 0.1 } } };
  const beta = await runSetup({ config, found: ["agy"], args: ["--yes", "--channel", "beta"] });
  expect(beta.saved).toEqual({ ...config, update_channel: "beta" });
  expect(beta.r.did).toContain('changed update_channel set to "beta"');
  expect(beta.r.did).toContain("update channel: beta. `routr update` installs the newest beta, rc or stable release now; otherwise the daily update does it");
  // Asking for the channel already in effect writes nothing; back to stable is a change, said as one.
  expect((await runSetup({ config, found: ["agy"], args: ["--yes", "--channel", "stable"] })).saved).toEqual(config);
  const back = await runSetup({ config: beta.saved, found: ["agy"], args: ["--yes", "--channel", "stable"] });
  expect(back.saved.update_channel).toBe("stable");
  expect(back.r.did).toContain('changed update_channel "beta" → "stable"');
  // Leaving beta on a pre-release binary: no update runs, and the words say what does not happen by itself.
  expect(channelNote("beta", "0.5.1", true, false)).toBe("update channel: beta. `routr update` installs the newest beta, rc or stable release now (automatic updates are off)");
  expect(channelNote("stable", "1.2.0-beta.1", true, false)).toBe("update channel: stable. You stay on 1.2.0-beta.1 until a stable release is newer; `routr update --force` installs the newest stable now (automatic updates are off)");
  expect(channelNote("stable", "0.6.0-beta.2", true)).toBe("update channel: stable. You stay on 0.6.0-beta.2 until a stable release is newer; `routr update --force` installs the newest stable now");
  // --force rebuilds the file and keeps the channel; --show refuses a change beside it; a bad value changes nothing.
  expect((await runSetup({ config: beta.saved, found: ["agy"], args: ["--yes", "--force"] })).saved.update_channel).toBe("beta");
  expect((await runSetup({ config, args: ["--show", "--channel", "beta"] })).r.error).toContain("--show only reads");
  const bad = await runSetup({ config, found: ["agy"], args: ["--yes", "--channel", "nightly"] });
  expect(bad.r).toEqual({ ok: false, error: "--channel takes stable or beta" });
  expect(bad.saved).toEqual(config);
  expect(parseChannel(["--yes"])).toBeUndefined();
  // At a terminal: the menu's Update channel (3rd) → Beta (2nd), then Save and exit (5th), shown in the review first.
  const said = [];
  const menu = await runSetup({ config, found: ["agy"], answers: ["3", "2", "5"], print: (t) => said.push(t) });
  expect(menu.left).toBe(0);
  expect(menu.asked[0]).toContain("Update channel (stable: stable releases, or beta builds too)");
  expect(said.join("\n")).toContain("Updates      stable channel");
  expect(said.join("\n")).toMatch(/update channel: stable \S+ beta/); // the review of what is saved
  expect(menu.saved).toEqual({ ...config, update_channel: "beta" });
  expect(menu.r.did).toContain('changed update_channel set to "beta"');
});

test("doctor reports both skills with their versions, setup repairs a missing one, and uninstall removes both everywhere", async () => {
  const { nextSteps, render, skillsMissing } = await import("../src/lib/doctor.mjs");
  const r = { runtime: "routr 0.0.0-dev (from source)", from_source: true, herdr: { path: "/bin/herdr", inside_session: true, skill: true },
    skill: [{ name: "routr", where: "~/.agents/skills/routr", version: "0.0.0-dev" }, { name: "routr", where: "~/.kiro/skills/routr", version: "0.0.0-dev" }],
    harnesses: {}, key: { works: true, model: "jev", ms: 300 }, config: { path: "/c.json", exists: true, subscriptions: [], off: [], problems: [], notes: [] },
    auto_update: { on: false, why_off: "running from source" }, telemetry: { on: false, why_off: "not turned on" }, next_steps: [] };
  expect(skillsMissing(r)).toEqual(["routr-orchestrate"]);
  expect(render(r)).toContain("routr skill ~/.agents/skills/routr, ~/.kiro/skills/routr are 0.0.0-dev");
  expect(render(r)).toContain("routr-orchestrate skill not installed for your agents: run `routr skill install`");
  expect(nextSteps(r)).toContain("Install the routr skills that match this routr: routr skill install");
  // A person who leaves setup unchanged still gets the missing skill installed (it is not a setting).
  const kept = await runSetup({ config: { telemetry: false, subscriptions: { agy: { hardest_work: "standard", reserve: 0.1 } } }, found: ["agy"], skill: r.skill, answers: ["5"] });
  expect(kept.installs).toEqual([1]);
  expect(kept.r.did).toContain("installed the routr skills 0.0.0 for your agents"); // the base version
  // The real thing, in a scratch home: both skills in every folder, read by doctor, then removed by uninstall.
  const { installSkill } = await import("../src/lib/skill-install.mjs");
  const { SKILL_FOLDERS, SKILLS } = await import("../src/lib/harnesses.mjs");
  const home = scratch("skills-un"); for (const d of [".claude", ".kiro", ".gemini/config"]) mkdirSync(join(home, d), { recursive: true });
  installSkill({ home });
  const env = cliEnv(home, { PATH: home });
  const doc = JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json"], { env }).stdout.toString());
  expect(doc.skill.map((k) => `${k.name} ${k.where} ${k.version}`)).toEqual(SKILLS.flatMap((s) => SKILL_FOLDERS.map((f) => `${s} ~/${f}/${s} 0.0.0-dev`)));
  expect(doc.next_steps.join(" ")).not.toContain("skill install");
  // Every file routr ships is checked, not SKILL.md alone: a copy without its openai.yaml is incomplete, and said.
  // A folder in place of a file is no file. And a harness set up here without routr's link (its link failed) is a repair.
  rmSync(join(home, ".agents/skills/routr-orchestrate/agents/openai.yaml")); mkdirSync(join(home, ".agents/skills/routr-orchestrate/agents/openai.yaml"));
  rmSync(join(home, ".kiro/skills/routr"), { recursive: true, force: true });
  const partial = JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json"], { env }).stdout.toString());
  expect(partial.skill.find((k) => k.where === "~/.agents/skills/routr-orchestrate").missing).toEqual(["agents/openai.yaml"]);
  expect(partial.skill_unlinked).toEqual([{ name: "routr", where: join("~", ".kiro/skills/routr"), for: "Kiro" }]);
  expect(partial.next_steps).toContain("Install the routr skills that match this routr: routr skill install");
  const text = Bun.spawnSync([process.execPath, SCRIPT, "doctor"], { env }).stdout.toString();
  expect(text).toContain("routr-orchestrate skill ~/.agents/skills/routr-orchestrate is incomplete (no agents/openai.yaml): run `routr skill install`");
  expect(text).toContain(`routr skill not linked for Kiro (${join("~", ".kiro/skills/routr")}): run \`routr skill install\``);
  // The repair it names works: install replaces routr's incomplete copy and links Kiro again.
  expect(Bun.spawnSync([process.execPath, SCRIPT, "skill", "install"], { env }).exitCode).toBe(0);
  expect(JSON.parse(Bun.spawnSync([process.execPath, SCRIPT, "doctor", "--json"], { env }).stdout.toString()).next_steps.join(" ")).not.toContain("skill install");
  expect(Bun.spawnSync([process.execPath, SCRIPT, "uninstall", "--yes"], { env }).exitCode).toBe(0);
  for (const s of SKILLS) for (const f of SKILL_FOLDERS) expect(existsSync(join(home, f, s))).toBe(false);
});

test("from a source checkout, setup never replaces a release's installed skills: it says what to run instead", async () => {
  const config = { telemetry: false, subscriptions: { agy: { hardest_work: "standard", reserve: 0.1 } } };
  const release = [{ name: "routr", where: "~/.agents/skills/routr", version: "0.5.0", ours: true, missing: [] }];
  const x = await runSetup({ config, found: ["agy"], skill: release, args: ["--yes"] }); // routr-orchestrate is missing
  expect(x.installs).toEqual([]);
  expect(x.r.skipped.join(" ")).toContain("this routr runs from a source checkout and the installed skills come from a release: run the installed routr's `routr skill install`");
  // Skills a source build wrote itself (0.0.0-dev), or none at all, it may (re)write.
  expect((await runSetup({ config, found: ["agy"], skill: [{ ...release[0], version: "0.0.0-dev" }], args: ["--yes"] })).installs).toEqual([1]);
  expect((await runSetup({ config, found: ["agy"], skill: [], args: ["--yes"] })).installs).toEqual([1]);
});

test("a skill is filled beside its place and renamed in: a failure leaves the old one whole", async () => {
  const { staged } = await import("../src/lib/skill-install.mjs");
  const { readdirSync } = await import("node:fs");
  const dir = scratch("staged"), dest = join(dir, "routr");
  staged(dest, (tmp) => { mkdirSync(tmp); writeFileSync(join(tmp, "SKILL.md"), "one"); });
  expect(() => staged(dest, (tmp) => { mkdirSync(tmp); writeFileSync(join(tmp, "SKILL.md"), "two"); throw new Error("disk full"); })).toThrow("disk full");
  expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("one");
  expect(readdirSync(dir)).toEqual(["routr"]); // no half-written folder left beside it
  staged(dest, (tmp) => { mkdirSync(tmp); writeFileSync(join(tmp, "SKILL.md"), "two"); });
  expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("two");
  expect(readdirSync(dir)).toEqual(["routr"]);
});
