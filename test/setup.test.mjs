// setup.mjs, doctor.mjs, uninstall.mjs: what the user sees when setting routr up and taking it down
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/lib/config.mjs";
import { claudeSnapshot } from "../src/lib/usage.mjs";
import { HARDEST, LEVEL_MEANING, RESERVE } from "../src/lib/wording.mjs";
import { COMMANDS, formatCommandHelp } from "../src/lib/help.mjs";
import { cliEnv, NOW, scratch, SCRIPT } from "./helpers.mjs";
test("doctor's next steps name the command for each thing missing, most important first", async () => {
  const { nextSteps, starterConfig, STATUSLINE_MISSING } = await import("../src/lib/doctor.mjs");
  const { ROUTR_VERSION } = await import("../src/lib/version.mjs");
  const base = { key: { works: true }, config: { exists: true, subscriptions: ["claude"] }, harnesses: { claude: { installed: true, signed_in: true } }, claude_usage_statusline: "installed", skill: [{ version: ROUTR_VERSION.split("-")[0] }], herdr: { path: "/x", skill: true } };
  expect(nextSteps(base)).toEqual([]);
  const fresh = nextSteps({ ...base, key: { works: false, found: false }, config: { exists: false, subscriptions: [] }, claude_usage_statusline: STATUSLINE_MISSING });
  expect(fresh[0]).toContain("routr key set");
  expect(fresh[1]).toContain("routr setup");
  expect(fresh.length).toBe(3);
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

test("setup never replaces a statusline the user already has", async () => {
  const { statuslinePlan, parseModels } = await import("../src/lib/setup.mjs");
  expect(statuslinePlan(null, "/b/routr statusline")).toEqual({ action: "write", settings: { statusLine: { type: "command", command: "/b/routr statusline" } } });
  expect(statuslinePlan('{"model":"opus"}', "/b/routr statusline").settings.model).toBe("opus");
  expect(statuslinePlan('{"statusLine":{"command":"~/mine.sh"}}', "x").action).toBe("skip");
  expect(statuslinePlan('{"statusLine":{"command":"/b/routr statusline"}}', "x").action).toBe("none");
  expect(statuslinePlan("{not json", "x").action).toBe("skip");
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
async function runSetup({ config, args = [], answers = [], found = ["agy", "cursor"], keyWorks = true, env = {}, efforts = async () => null, models = {} } = {}) {
  const { setup } = await import("../src/lib/setup.mjs");
  const dir = scratch("setup-run"), path = join(dir, "config.json");
  if (config) writeFileSync(path, JSON.stringify(config));
  const asked = [], shared = [], installs = [], keys = [];
  const inspect = async () => {
    const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    return { harnesses: Object.fromEntries(["claude", "codex", "cursor", "agy", "kiro"].map((n) => [n, { installed: found.includes(n), signed_in: found.includes(n), models: models[n] ?? [], usage_class: "included" }])),
      config: { path, exists: Boolean(saved), subscriptions: Object.keys(saved?.subscriptions ?? {}) }, skill: [{ where: "~/.agents/skills/routr", version: "0.0.0-dev" }],
      claude_usage_statusline: "not needed", key: { works: keyWorks }, next_steps: [] };
  };
  const queue = [...answers];
  const question = async (q) => { asked.push(q.trim()); if (!queue.length) throw new Error(`unexpected question: ${q.trim()}`); return queue.shift(); };
  const r = await setup(["--config", path, "--json", ...args], { inspect, question, interactive: true, env,
    install: () => installs.push(1), share: (on) => shared.push(on), key: async () => { keys.push(1); return { ok: false, error: "none given" }; }, print: () => {}, efforts });
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  return { r, asked, saved, shared, installs, keys, left: queue.length };
}

// The guided flow, answered line by line (the tui's accessible mode takes the same answers a screen reader user types).
const q = (asked, start) => asked.filter((x) => x.startsWith(start)).length;

test("setup, new install: which subscriptions, then each one's settings, telemetry off by default, and a review before writing", async () => {
  // cursor then agy (the registry's order): model (Enter: leave it to the lead), hardest work, reserve; then telemetry; then Write.
  const x = await runSetup({ answers: ["", "", "3", "4", "", "", "", "n", ""] });
  expect(x.r.ok).toBe(true);
  expect(x.asked[0]).toMatch(/^Which subscriptions may routr hand work to\?/);
  expect(q(x.asked, "Cursor: the hardest work routr may send there")).toBe(1);
  expect(q(x.asked, "Antigravity: reserve")).toBe(1);
  expect(q(x.asked, "Share anonymous outcomes once a day? [y/N]")).toBe(1);
  expect(q(x.asked, "Write these changes?")).toBe(1);
  expect(x.saved.subscriptions.cursor).toMatchObject({ hardest_work: "strong", reserve: 0.25, enabled: true });
  expect(x.saved.subscriptions.agy).toMatchObject({ hardest_work: "standard", reserve: 0.1, enabled: true });
  expect(x.shared).toEqual([false]);
  expect(x.left).toBe(0);
});

test("setup, new install: a harness left unticked is added turned off, with its settings, to turn on later", async () => {
  const x = await runSetup({ answers: ["2", "", "", "", "", "n", ""] }); // untick Antigravity, then Cursor's three, telemetry, Write
  expect(x.saved.subscriptions.agy).toMatchObject({ enabled: false, hardest_work: "standard", reserve: 0.1 });
  expect(x.saved.subscriptions.cursor).toMatchObject({ enabled: true });
  expect(q(x.asked, "Antigravity:")).toBe(0); // nothing asked about one that is off
});

test("setup, run again: a menu to change one thing, a review, and only that is written", async () => {
  const config = { subscriptions: { agy: { hardest_work: "standard", reserve: 0.1 }, cursor: { hardest_work: "standard", reserve: 0.1, default_model: "m" } } };
  // Change one subscription → Cursor → hardest work → strong; back at the menu: Review and write (5th) → Write.
  const x = await runSetup({ config, answers: ["", "", "2", "3", "5", ""] });
  expect(x.asked[0]).toMatch(/^What would you like to do\?/);
  expect(x.saved.subscriptions.cursor).toEqual({ hardest_work: "strong", reserve: 0.1, default_model: "m" });
  expect(x.saved.subscriptions.agy).toEqual({ hardest_work: "standard", reserve: 0.1 });
  expect(x.r.did.join(" ")).toContain('cursor.hardest_work "standard" → "strong"');
  expect(x.shared).toEqual([]); // telemetry was on the menu, and not chosen: left as it was
  expect(x.left).toBe(0);
});

test("setup, run again: Done changes nothing, and quitting after a change writes nothing", async () => {
  const config = { telemetry: true, subscriptions: { agy: { hardest_work: "strong", reserve: 0.3 } } };
  const done = await runSetup({ config, found: ["agy"], answers: ["4"] }); // one, choose, all, Done
  expect(done.saved).toEqual(config);
  expect(done.r.skipped).toContain("nothing changed");
  const quit = await runSetup({ config, found: ["agy"], answers: ["", "", "2", "1", "5"] }); // agy → hardest → basic, then Quit (5th)
  expect(quit.r).toMatchObject({ ok: false, cancelled: true });
  expect(quit.saved).toEqual(config);
});

test("setup: the everyday model is picked from the harness's live list by typing part of its name", async () => {
  const list = [...Array.from({ length: 230 }, (_, i) => `vendor-model-${i}`), "cursor-grok-4.6-high", "grok-4.7-high", "grok-4.7-low"];
  const config = { telemetry: false, subscriptions: { cursor: { hardest_work: "standard", reserve: 0.1, default_model: "cursor-grok-4.6-high" } } };
  // Change one → Cursor (only one) → Everyday model → "4.7 high" (one match) → Review (4th: telemetry is answered) → Write.
  const x = await runSetup({ config, found: ["cursor"], models: { cursor: list }, answers: ["", "", "", "4.7 high", "4", ""] });
  expect(x.saved.subscriptions.cursor.default_model).toBe("grok-4.7-high");
  expect(x.asked.find((a) => a.startsWith("Cursor: everyday model"))).toContain("234 to choose from"); // searched, never printed whole
});

test("setup: effort is chosen from the levels the harness takes for that model", async () => {
  const efforts = async (n, model) => (n === "codex" ? (model === "gpt-5.5" ? ["low", "medium", "high", "xhigh"] : null) : null);
  const x = await runSetup({ found: ["codex"], models: { codex: ["gpt-5.5", "gpt-5.6-terra"] }, efforts, answers: ["", "2", "3", "", "", "n", ""] }); // 1 is "leave it to the lead agent"
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
  const person = await runSetup({ keyWorks: false, found: ["agy"], answers: ["", "", "", "", "n", ""] });
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

test("routr uninstall keeps the user's data unless purged, unlinks a linked skill, and removes only its own statusline", async () => {
  const { uninstallPlan } = await import("../src/lib/uninstall.mjs");
  const home = scratch("un");
  const checkout = join(home, "checkout"); mkdirSync(checkout); writeFileSync(join(checkout, "SKILL.md"), "mine");
  for (const d of [".config/routr", ".local/share/routr", ".cache/routr", ".agents/skills/routr", ".claude/skills", ".kiro/skills/routr"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".config/routr/config.json"), "{}");
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "opus", statusLine: { type: "command", command: "/x/routr statusline" } }));
  const linked = process.platform !== "win32";
  if (linked) (await import("node:fs")).symlinkSync(checkout, join(home, ".claude/skills/routr"), "dir");
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
  if (linked) expect(readFileSync(join(checkout, "SKILL.md"), "utf8")).toBe("mine");    // the link went, its target did not
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
