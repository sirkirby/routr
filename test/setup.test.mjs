// setup.mjs, doctor.mjs, uninstall.mjs: what the user sees when setting routr up and taking it down
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/lib/config.mjs";
import { claudeSnapshot } from "../src/lib/usage.mjs";
import { HARDEST, LEVEL_MEANING, RESERVE } from "../src/lib/wording.mjs";
import { COMMANDS, formatCommandHelp } from "../src/lib/help.mjs";
import { cliEnv, NOW, said, scratch, SCRIPT } from "./helpers.mjs";
test("doctor's next steps name the command for each thing missing, most important first", async () => {
  const { nextSteps, starterConfig, STATUSLINE_MISSING } = await import("../src/lib/doctor.mjs");
  const { ROUTR_VERSION } = await import("../src/lib/version.mjs");
  const base = { key: { works: true }, config: { exists: true, subscriptions: ["claude"] }, harnesses: { claude: { installed: true } }, claude_usage_statusline: "installed", skill: [{ version: ROUTR_VERSION.split("-")[0] }], herdr: { path: "/x", skill: true } };
  expect(nextSteps(base)).toEqual([]);
  const fresh = nextSteps({ ...base, key: { works: false, found: false }, config: { exists: false, subscriptions: [] }, claude_usage_statusline: STATUSLINE_MISSING });
  expect(fresh[0]).toContain("routr key set");
  expect(fresh[1]).toContain("routr setup");
  expect(fresh.length).toBe(3);
  expect(nextSteps({ ...base, harnesses: { claude: { installed: true }, codex: { installed: true } } })[0]).toContain("codex");
  // Claude answered and sent no windows: the user says whether the seat has a quota; once `billing` is set, nothing to do.
  const reading = (snap) => { const u = claudeSnapshot(snap, NOW / 1000); return { installed: true, usage_class: u.class, usage_note: u.note, ...(u.reason ? { usage_reason: u.reason } : {}) }; };
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

test("hardest_work and reserve are asked with a suggestion, read from flags, and a bad answer asks again", async () => {
  const { parseLevel, parseShare, parseHardest, parseReserve, askSettings } = await import("../src/lib/setup.mjs");
  expect([parseLevel("Strong"), parseLevel("1"), parseLevel("3"), parseLevel("s"), parseLevel("")]).toEqual(["strong", "basic", "strong", null, null]);
  expect([parseShare("0.25"), parseShare("25%"), parseShare(".1"), parseShare("0"), parseShare("1.5"), parseShare("-1"), parseShare("x"), parseShare("")]).toEqual([0.25, 0.25, 0.1, 0, null, null, null, null]);
  expect(parseHardest(["--hardest", "cursor=strong", "--hardest", "agy=2"])).toEqual({ cursor: "strong", agy: "standard" });
  expect(parseReserve(["--reserve", "claude=30%"])).toEqual({ claude: 0.3 });
  for (const bad of [["--hardest", "cursor=huge"], ["--hardest", "gpt=strong"], ["--reserve", "claude=2"], ["--reserve", "claude"]])
    expect(() => (bad[0] === "--hardest" ? parseHardest : parseReserve)(bad)).toThrow();
  const answers = (list) => { const q = [...list]; return async () => q.shift(); };
  const said = [];
  expect(await askSettings("cursor", { hardest_work: "standard", reserve: 0.1 }, answers(["", ""]), (m) => said.push(m))).toEqual({ hardest_work: "standard", reserve: 0.1 });
  expect(await askSettings("cursor", { hardest_work: "standard", reserve: 0.1 }, answers(["huge", "strong", "lots", "20%"]), (m) => said.push(m))).toEqual({ hardest_work: "strong", reserve: 0.2 });
  expect(said).toHaveLength(2); // one nudge per bad answer
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
async function runSetup({ config, args = [], answers = [], found = ["agy", "cursor"], keyWorks = true, env = {} } = {}) {
  const { setup } = await import("../src/lib/setup.mjs");
  const dir = scratch("setup-run"), path = join(dir, "config.json");
  if (config) writeFileSync(path, JSON.stringify(config));
  const asked = [], shared = [], installs = [], keys = [];
  const inspect = async () => {
    const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    return { harnesses: Object.fromEntries(["claude", "codex", "cursor", "agy"].map((n) => [n, { installed: found.includes(n), models: [], usage_class: "included" }])),
      config: { path, exists: Boolean(saved), subscriptions: Object.keys(saved?.subscriptions ?? {}) }, skill: [{ where: "~/.agents/skills/routr", version: "0.0.0-dev" }],
      claude_usage_statusline: "not needed", key: { works: keyWorks }, next_steps: [] };
  };
  const queue = [...answers];
  const question = async (q) => { asked.push(q.trim()); if (!queue.length) throw new Error(`unexpected question: ${q.trim()}`); return queue.shift(); };
  const r = await setup(["--config", path, "--json", ...args], { inspect, question, interactive: true, env,
    install: () => installs.push(1), share: (on) => shared.push(on), key: async () => { keys.push(1); return { ok: false, error: "none given" }; }, print: () => {} });
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  return { r, asked, saved, shared, installs, keys, left: queue.length };
}

test("setup, new install: asks each subscription's hardest work and reserve, suggestion on Enter, then telemetry", async () => {
  const x = await runSetup({ answers: ["strong", "25%", "", "", "n"] }); // asked in the harness order: cursor, then agy
  expect(x.r.ok).toBe(true);
  expect(said(x.asked, "Go through them now")).toBe(0); // nothing to go through yet
  expect(x.asked.filter((q) => q === HARDEST.question("agy", "standard").trim())).toHaveLength(1);
  expect(x.asked.filter((q) => q === HARDEST.question("cursor", "standard").trim())).toHaveLength(1);
  expect(x.asked).toContain(RESERVE.question("cursor", "10%").trim());
  expect(x.saved.subscriptions.agy).toMatchObject({ hardest_work: "standard", reserve: 0.1 });
  expect(x.saved.subscriptions.cursor).toMatchObject({ hardest_work: "strong", reserve: 0.25 });
  expect(x.asked.at(-1)).toBe("Share them? [y/N]");
  expect(x.shared).toEqual([false]);
  expect(x.left).toBe(0);
});

test("setup, upgrade from a config written before it asked: offers the settings, current values as defaults", async () => {
  const config = { subscriptions: { agy: { hardest_work: "standard", reserve: 0.1 }, cursor: { hardest_work: "standard", reserve: 0.1, default_model: "m" } } };
  const x = await runSetup({ config, answers: ["", "", "", "strong", "", "n"] });
  expect(x.asked[0]).toBe("Go through them now? Enter keeps each one as it is [Y/n]");
  expect(x.asked[1]).toBe(HARDEST.question("agy", "standard").trim()); // in config order; the current value as default
  expect(x.saved.subscriptions.cursor).toEqual({ hardest_work: "strong", reserve: 0.1, default_model: "m" });
  expect(x.saved.subscriptions.agy).toEqual({ hardest_work: "standard", reserve: 0.1 });
  expect(x.r.did.join(" ")).toContain('cursor.hardest_work "standard" → "strong"');
  expect(said(x.asked, "Share them?")).toBe(1); // no telemetry entry in that config: asked, default no
  expect(x.left).toBe(0);
});

test("setup keeps what is already answered: telemetry on is not asked again, and declining the review changes nothing", async () => {
  const config = { telemetry: true, subscriptions: { agy: { hardest_work: "strong", reserve: 0.3 } } };
  const x = await runSetup({ config, found: ["agy"], answers: ["n"] });
  expect(x.asked).toEqual(["Go through them now? Enter keeps each one as it is [Y/n]"]);
  expect(x.saved).toEqual(config);
  expect(x.shared).toEqual([]);
  // Telemetry off by the person's own choice is not asked again either.
  const off = await runSetup({ config: { ...config, telemetry: false }, found: ["agy"], answers: ["n"] });
  expect(said(off.asked, "Share them?")).toBe(0);
});

test("setup with a setting flag at a terminal changes just that, without the review", async () => {
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
  // A person at a terminal with no key is asked for it, last.
  const person = await runSetup({ keyWorks: false, found: ["agy"], answers: ["", "", "n"] });
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

test("setup searches a long model list instead of printing it", async () => {
  const { narrow, pickModel } = await import("../src/lib/setup.mjs");
  const list = Array.from({ length: 230 }, (_, i) => `vendor-model-${i}`).concat(["cursor-grok-4.6-high", "cursor-grok-4.7-high", "cursor-grok-4.7-low"]);
  expect(narrow(list, "grok high")).toEqual(["cursor-grok-4.6-high", "cursor-grok-4.7-high"]);
  const drive = async (answers, l = list) => { const said = []; const got = await pickModel(l, async () => answers.shift(), (s) => said.push(s)); return { got, said }; };
  const r = await drive(["grok", "2"]);
  expect(r.got).toBe("cursor-grok-4.7-high");
  expect(r.said.length).toBeLessThan(8);                                 // the count and three matches, never 233 lines
  expect((await drive(["grok 4.7 low"])).got).toBe("cursor-grok-4.7-low"); // a single match is taken
  expect((await drive(["vendor", "zzz", ""])).got).toBeUndefined();        // too many, then none, then Enter: left to the lead
  expect((await drive(["2"], ["a", "b"])).got).toBe("b");                  // a short list is printed and picked by number
  const said = [], asked = [];                                              // Kiro: Enter keeps its own router
  expect(await pickModel(["auto", "glm-5"], async (q) => { asked.push(q); return ""; }, (s) => said.push(s), "auto")).toBe("auto");
  expect(asked[0]).toContain("Enter = auto");
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
