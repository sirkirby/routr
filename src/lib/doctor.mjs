// `routr doctor`: read-only setup check. Finds the harnesses that are installed, the usage sources that exist,
// the TypeSafe key, and the config, and ends with the commands that fix what is missing. It writes nothing:
// `routr setup` (lib/setup.mjs) does, from the same inspection.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { CONFIG_PATH, loadConfig } from "./config.mjs";
import { HARNESSES as HARNESS_TABLE } from "./harness.mjs";
import { jevModel, KEY_FILES, loadKey, ping } from "./jev.mjs";
import { JEV_MODEL } from "./questions.mjs";
import { CLAUDE_SNAPSHOT, NO_WINDOWS_AFTER_ANSWER, readUsage, run } from "./usage.mjs";
import { autoUpdateStatus, latestVersion, newer } from "./update.mjs";
import { telemetryStatus } from "./telemetry.mjs";
import { standalone } from "./runtime.mjs";
import { isOurStatusline } from "./statusline.mjs";
import { baseVersion, ROUTR_VERSION } from "./version.mjs";

// Subscription name → the command its harness is launched with, from the one table launch uses.
export const HARNESSES = Object.fromEntries(Object.entries(HARNESS_TABLE).map(([name, h]) => [name, h.executable]));
export const SUGGESTED = { claude: { hardest_work: "strong", reserve: 0.25 }, codex: { hardest_work: "strong", reserve: 0.2 }, cursor: { hardest_work: "standard", reserve: 0.1, assumed_headroom: 0.5 }, agy: { hardest_work: "standard", reserve: 0.1 } };

// Each harness's LIVE model list, asked of the harness itself: routr keeps no model list of its own.
const MODEL_LISTS = {
  claude: async () => ["haiku", "sonnet", "opus"], // aliases Claude Code resolves itself; `--model` also takes full ids
  codex: async () => { try { const o = JSON.parse(await run("codex", ["debug", "models"], { timeoutMs: 15000 })); return (o.models ?? o).map((m) => m.slug ?? m.id).filter(Boolean); } catch { return null; } },
  cursor: async () => ((await run("cursor-agent", ["models"], { timeoutMs: 20000 })) ?? "").split("\n").map((l) => l.match(/^\s*([a-z0-9][\w.-]+) - /i)?.[1]).filter(Boolean),
  agy: async () => ((await run("agy", ["models"], { timeoutMs: 20000 })) ?? "").split("\n").map((l) => l.match(/^([a-z0-9][\w.-]+)\t/i)?.[1]).filter(Boolean),
};

// Search PATH directly (no shell), so this works the same on macOS, Linux, and Windows.
export function which(cmd) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) for (const ext of exts) {
    const p = join(dir, cmd + ext);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

// Installed but not on this process's PATH (seen on a fresh Mac: ~/.local/bin is only added by the interactive shell).
function offPath(cmd) {
  const home = homedir(), win = process.platform === "win32";
  const exts = win ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of [join(home, ".local/bin"), join(home, ".bun/bin"), join(home, "bin"), ...(win ? [] : ["/opt/homebrew/bin", "/usr/local/bin"])]) for (const ext of exts) {
    const p = join(dir, cmd + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

const MODELS_SHOWN = 12;

// Only Claude Code and Codex take a reasoning effort of their own; Cursor and Antigravity model ids carry it.
export const TAKES_EFFORT = Object.keys(HARNESS_TABLE).filter((n) => HARNESS_TABLE[n].effort);

// The config `routr setup` writes: the user's defaults for the harnesses found. A model is set only when the user chose one.
// `ranks` holds `metered_rank` per pool that reads as metered at setup, written out so the key is there to change.
export function starterConfig(found, models = {}, ranks = {}) {
  return { fallback_level: "standard", sure_at: 0.8, risk_above: 0.75, prefer: { research: "strong", review: "strong" },
    subscriptions: Object.fromEntries(found.map((n) => [n, { ...SUGGESTED[n], ...(models[n] ? { default_model: models[n] } : {}), ...(TAKES_EFFORT.includes(n) ? { default_effort: "medium" } : {}), ...(ranks[n] ? { metered_rank: ranks[n] } : {}) }])) };
}

const STATUSLINE_MISSING = "missing: without it Claude usage is assumed, not read";

// What is left to do, most important first, each with the command that does it.
export function nextSteps(r) {
  const steps = [];
  if (!r.key.works) steps.push(r.key.found ? `The TypeSafe key was found but the test call failed (${r.key.error}). Create a new one at https://console.typesafe.ai/keys and run: routr key set`
    : "Add your TypeSafe API key. Create one at https://console.typesafe.ai/keys, then run: routr key set");
  if (!r.config.exists) steps.push("Create your config (your defaults for each subscription found): routr setup");
  else if (Object.entries(r.harnesses).some(([n, h]) => h.installed && !r.config.subscriptions.includes(n))) steps.push(`Add the harnesses found since the config was written (${Object.entries(r.harnesses).filter(([n, h]) => h.installed && !r.config.subscriptions.includes(n)).map(([n]) => n).join(", ")}): routr setup`);
  if (!Object.values(r.harnesses).some((h) => h.installed)) steps.push("Install and log in to at least one harness: Claude Code, Codex, Cursor (cursor-agent), or Antigravity (agy)");
  if (r.claude_usage_statusline === STATUSLINE_MISSING) steps.push("Let routr read Claude Code's usage (sets Claude's statusline command): routr setup");
  // Claude answered a prompt and still sent no windows: a seat with no quota, or a plan routr has not seen send them.
  // routr does not guess which; the user says, either way, and the step clears.
  const cl = r.harnesses.claude;
  if (cl?.installed && cl.usage_reason === NO_WINDOWS_AFTER_ANSWER && !r.config.billing?.claude)
    steps.push(`Claude answered a prompt but reported no usage windows, and routr cannot tell why. If this seat has no quota (usage-based Enterprise, an API key), add "billing": "metered" under subscriptions.claude in ${r.config.path} and routr ranks it as billed usage. If it has a quota (routr has not yet seen a Team or Enterprise seat send windows), add "billing": "included", or check again after another turn`);
  if (!r.skill.length || (!r.from_source && r.skill.some((k) => baseVersion(k.version) !== baseVersion(ROUTR_VERSION)))) steps.push("Install the routr skill that matches this routr: routr skill install");
  if (r.update_available) steps.push(`Update to ${r.update_available}: routr update`);
  if (!r.herdr.path) steps.push("For orchestration, install herdr (https://herdr.dev). Sizing subagents works without it");
  else if (!r.herdr.skill) steps.push("Install herdr's agent skill: npx skills add herdrdev/herdr --skill herdr -g");
  return steps;
}

// Everything doctor reports, as data. `routr setup` starts from the same inspection.
export async function inspect({ configPath, quiet } = {}) {
  const r = { from_source: !standalone(), runtime: `routr ${ROUTR_VERSION} (${standalone() ? "standalone binary" : `from source under ${globalThis.Bun ? "bun " + Bun.version : "node " + process.version}`})`, herdr: { path: which("herdr") ?? offPath("herdr"), inside_session: process.env.HERDR_ENV === "1",
    // The orchestrator guide leans on herdr's own skill for pane and agent commands; routr does not bundle it.
    skill: [".agents/skills/herdr", ".claude/skills/herdr"].some((d) => existsSync(join(homedir(), d, "SKILL.md"))) }, harnesses: {}, key: {}, config: {}, starter_config: null };
  // Every check that waits on something else (the release lookup, each harness, the key's test call) runs at once:
  // one after another, a logged-out harness that is slow to answer made doctor sit silent for most of a minute.
  // A person at a terminal sees each one finish, on stderr so the report and `--json` stay clean.
  const found = Object.keys(HARNESSES).filter((n) => which(HARNESSES[n]));
  const tty = Boolean(process.stderr.isTTY) && !quiet;
  const step = async (label, p) => { try { return await p; } finally { if (tty) process.stderr.write(`  checked ${label}\n`); } };
  if (tty) process.stderr.write(`Checking ${["the TypeSafe key", ...found.map((n) => `\`${HARNESSES[n]}\``)].join(", ")} (a harness can take up to 20 s to answer)…\n`);
  const keyCheck = async () => { loadKey(); r.key.found = true; return ping(); };
  // The release lookup is one short, non-fatal call. Only doctor and `routr update` make it; the advice commands never call home.
  const [latest, usage, key, ...models] = await Promise.all([
    process.env.ROUTR_NO_UPDATE ? null : latestVersion(3000).catch(() => null),
    // Every installed harness is shown, but only a configured one may start a background refresh (Cursor's reading).
    step("usage", readUsage(found, {}, { background: Object.keys(loadConfig(configPath ?? CONFIG_PATH).config.subscriptions ?? {}) })),
    step("the TypeSafe key", keyCheck().then((t) => ({ t }), (e) => ({ e }))),
    ...found.map((n) => step(`${n}'s models`, Promise.resolve(MODEL_LISTS[n]?.()).then((l) => l || null, () => null))),
  ]);
  if (latest && standalone() && newer(latest, ROUTR_VERSION)) r.update_available = latest; // a source checkout is not updated
  for (const n of Object.keys(HARNESSES)) {
    const u = usage.find((x) => x.pool === n);
    r.harnesses[n] = { command: HARNESSES[n], installed: found.includes(n), off_path: found.includes(n) ? null : offPath(HARNESSES[n]), usage: !found.includes(n) ? null : u.headroom != null ? `live: ${Math.round(u.headroom * 100)}% left${u.class === "capped" ? " of the cap" : ""} (${u.source}, ${u.ageSec}s old)` : u.class === "metered" ? `${u.note} (${u.source})` : `none: ${u.note}`, ...(found.includes(n) ? { usage_class: u.class, usage_note: u.note, ...(u.reason ? { usage_reason: u.reason } : {}) } : {}) };
  }
  if (key.t) { r.key.works = true; r.key.ms = Math.round(key.t.latencyMs); r.key.model = key.t.model; }
  else { r.key.found ??= false; r.key.works = false; r.key.error = String(key.e?.message ?? key.e).slice(0, 160); r.key.where = `set TYPESAFE_API_KEY, or put TYPESAFE_API_KEY=... in ${KEY_FILES[0]}`; }
  const lists = Object.fromEntries(found.map((n, i) => [n, models[i]]));
  for (const n of found) r.harnesses[n].models = lists[n];
  // The installer writes the skill and the binary together, but a skill copied by hand or left behind by an older
  // install can drift: it may name commands this binary lacks, or miss ones it has.
  r.skill = [".agents/skills/routr", ".claude/skills/routr"].map((d) => {
    try { return { where: `~/${d}`, version: readFileSync(join(homedir(), d, "SKILL.md"), "utf8").match(/^\s*version:\s*"?([^"\n]+)"?/m)?.[1] ?? "unknown" }; } catch { return null; }
  }).filter(Boolean);
  const path = configPath ?? CONFIG_PATH;
  const { config, notes } = loadConfig(path);
  r.config = { path, exists: existsSync(path), subscriptions: Object.keys(config.subscriptions), billing: Object.fromEntries(Object.entries(config.subscriptions).filter(([, s]) => s.billing).map(([n, s]) => [n, s.billing])), notes };
  // A metered pool's place in the ranking is the user's setting; say which applies where the usage is shown. A class
  // the user set by hand replaces the reader's note, which would otherwise ask for what is already set.
  for (const [n, sub] of Object.entries(config.subscriptions)) {
    const h = r.harnesses[n];
    if (!h?.installed) continue;
    if (sub.billing) h.usage = h.usage_class === "unknown" ? `${sub.billing} by your setting (billing: ${sub.billing})` : `${h.usage} · billing: ${sub.billing} by your setting`;
    if ((sub.billing ?? h.usage_class) === "metered") h.usage += sub.metered_rank === "with" ? " · ranked with your subscriptions by assumed_headroom (metered_rank: with)" : " · ranked after your subscriptions (metered_rank: after)";
  }
  // The one moment a default needs the user's attention: the harness no longer offers it.
  for (const [n, sub] of Object.entries(config.subscriptions)) {
    if (!sub.default_model) notes.push(`subscriptions.${n}: no default_model set; the orchestrator will pick from the harness's live list`);
    else if (lists[n]?.length && !lists[n].includes(sub.default_model)) notes.push(`subscriptions.${n}.default_model "${sub.default_model}" is not in the harness's current model list: choose a new default`);
  }
  // Configured but no snapshot yet is not a failure: Claude writes the first snapshot on its next turn.
  let wired = false;
  try { wired = isOurStatusline(JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf8")).statusLine?.command); } catch {}
  r.claude_usage_statusline = existsSync(CLAUDE_SNAPSHOT) ? "installed" : !found.includes("claude") ? "not needed"
    : wired ? "configured: the first snapshot appears after the next Claude Code turn" : STATUSLINE_MISSING;
  if (!r.config.exists) r.starter_config = starterConfig(found);
  r.auto_update = autoUpdateStatus(config);
  r.telemetry = telemetryStatus(config);
  r.next_steps = nextSteps(r);
  return r;
}

export async function doctor({ json, configPath }) {
  const r = await inspect({ configPath, quiet: json });
  if (json) return console.log(JSON.stringify(r, null, 1));
  console.log(`routr doctor (changes nothing; \`routr doctor --fix\` does what it can of the next steps)\n\n${render(r)}`);
}

// Colour only for a person at a terminal, and never when NO_COLOR is set (https://no-color.org).
const COLOUR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
export const paint = (code, s) => (COLOUR ? `\x1b[${code}m${s}\x1b[0m` : s);

// `!!` (red) stops routr from working as intended; `--` (yellow) is optional or absent; `ok` (green) is fine.
export function render(r) {
  const out = [];
  const mark = (state) => (state === true || state === "ok" ? paint(32, "ok ") : state === "need" ? paint("1;31", "!! ") : paint(33, "-- "));
  const line = (state, text) => out.push(mark(state) + (state === "need" ? paint(31, text) : text));
  const { notes } = r.config;
  line(!r.update_available, `${r.runtime}${r.update_available ? ` · ${r.update_available} is available: run \`routr update\`` : ""}`);
  line(Boolean(r.herdr.path), `herdr ${r.herdr.path ? (r.herdr.inside_session ? "(inside a herdr session)" : "(installed; not inside a session)") : "not found: orchestration needs it (https://herdr.dev). Sizing subagents works without it"}`);
  if (r.herdr.path) line(r.herdr.skill, `herdr skill ${r.herdr.skill ? "installed" : "not found: the orchestrator guide uses it. Install with: npx skills add herdrdev/herdr --skill herdr -g"}`);
  const base = baseVersion(ROUTR_VERSION);
  if (!r.skill.length) line("need", "routr skill not installed for your agents: run `routr skill install`");
  for (const k of r.skill) line(r.from_source || baseVersion(k.version) === base ? "ok" : "need", `routr skill ${k.where} is ${k.version}${r.from_source || baseVersion(k.version) === base ? "" : ` but this routr is ${base}: run \`routr skill install\`, or upgrade routr, so the guides and the command agree`}`);
  const any = Object.values(r.harnesses).some((h) => h.installed);
  for (const [n, h] of Object.entries(r.harnesses)) line(h.installed ? "ok" : h.off_path || !any ? "need" : "absent", `${n.padEnd(7)} ${h.installed ? `\`${h.command}\` found · usage ${h.usage}` : h.off_path ? `\`${h.command}\` is installed at ${h.off_path} but not on PATH: add its folder to PATH so routr and herdr can start it` : `\`${h.command}\` not found`}${h.models?.length ? `\n            models: ${h.models.slice(0, MODELS_SHOWN).join(", ")}${h.models.length > MODELS_SHOWN ? `, … (${h.models.length} in all; run \`${h.command} models\` for the rest)` : ""}` : ""}`);
  line(r.key.works ? "ok" : "need", `TypeSafe key ${r.key.works ? `works (${r.key.model}${jevModel() !== JEV_MODEL ? `, asked as ${jevModel()} by ROUTR_JEV_MODEL` : ""}, ${r.key.ms} ms)` : `${r.key.found ? "found but failed" : "missing"}: ${r.key.error}`}`);
  line(r.config.exists ? "ok" : "need", `config ${r.config.path}${r.config.exists ? ` · subscriptions: ${r.config.subscriptions.join(", ") || "none"}` : " not found: run `routr setup` to create it"}${r.config.exists && notes.length ? `\n   ${notes.join("\n   ")}` : ""}`);
  line(r.claude_usage_statusline !== STATUSLINE_MISSING, `Claude usage statusline: ${r.claude_usage_statusline}`);
  const au = r.auto_update;
  line("ok", `automatic updates ${au.on ? `on · last checked ${au.checked_hours_ago == null ? "never" : au.checked_hours_ago + " h ago"}${au.last ? ` · last result: ${au.last.error ?? au.last.note}` : ""}` : `off: ${au.why_off}`}`);
  if (r.telemetry) line("ok", r.telemetry.on ? "telemetry on: anonymous outcomes (never text) once a day · `routr share` shows exactly what · `routr telemetry off` stops it"
    : `telemetry off${r.telemetry.why_off.startsWith("not turned on") ? " (the default)" : `: ${r.telemetry.why_off}`} · \`routr telemetry on\` shares anonymous outcomes that help tune routr (docs/telemetry.md)`);
  out.push("", r.next_steps.length ? paint(1, "Next steps") : paint(32, "Everything routr needs is in place."));
  r.next_steps.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
  return out.join("\n");
}
