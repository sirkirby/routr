// `routr doctor`: read-only setup check. Finds the harnesses that are installed, the usage sources that exist,
// the TypeSafe key, and the config; proposes a starter config. It writes nothing: the setup skill (or you) does.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { CONFIG_PATH, loadConfig } from "./config.mjs";
import { ask, KEY_FILES, loadKey } from "./jev.mjs";
import { CLAUDE_SNAPSHOT, readUsage, run } from "./usage.mjs";
import { ROUTR_VERSION } from "./version.mjs";

// Subscription name → the command its harness is launched with.
const HARNESSES = { claude: "claude", codex: "codex", cursor: "cursor-agent", agy: "agy" };
const SUGGESTED = { claude: { hardest_work: "strong", reserve: 0.25 }, codex: { hardest_work: "strong", reserve: 0.2 }, cursor: { hardest_work: "standard", reserve: 0.1, assumed_headroom: 0.5 }, agy: { hardest_work: "standard", reserve: 0.1 } };

// Each harness's LIVE model list, asked of the harness itself: routr keeps no model list of its own.
const MODEL_LISTS = {
  claude: async () => ["haiku", "sonnet", "opus"], // aliases Claude Code resolves itself; `--model` also takes full ids
  codex: async () => { try { const o = JSON.parse(await run("codex", ["debug", "models"], { timeoutMs: 15000 })); return (o.models ?? o).map((m) => m.slug ?? m.id).filter(Boolean); } catch { return null; } },
  cursor: async () => ((await run("cursor-agent", ["models"], { timeoutMs: 20000 })) ?? "").split("\n").map((l) => l.match(/^\s*([a-z0-9][\w.-]+) - /i)?.[1]).filter(Boolean),
  agy: async () => ((await run("agy", ["models"], { timeoutMs: 20000 })) ?? "").split("\n").map((l) => l.match(/^([a-z0-9][\w.-]+)\t/i)?.[1]).filter(Boolean),
};

// Search PATH directly (no shell), so this works the same on macOS, Linux, and Windows.
function which(cmd) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) for (const ext of exts) {
    const p = join(dir, cmd + ext);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

// Installed but not on this process's PATH (seen on a fresh Mac: ~/.local/bin is only added by the interactive shell).
function offPath(cmd) {
  const home = homedir();
  for (const dir of [join(home, ".local/bin"), join(home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, "bin")]) {
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}

const MODELS_SHOWN = 12;

export async function doctor({ json, configPath }) {
  // A compiled release binary has no script path of its own; a source checkout runs under Bun.
  const standalone = !/\.m?js$/.test(process.argv[1] ?? "");
  const r = { runtime: `routr ${ROUTR_VERSION} (${standalone ? "standalone binary" : `from source under ${globalThis.Bun ? "bun " + Bun.version : "node " + process.version}`})`, herdr: { path: which("herdr") ?? offPath("herdr"), inside_session: process.env.HERDR_ENV === "1",
    // The orchestrator guide leans on herdr's own skill for pane and agent commands; routr does not bundle it.
    skill: [".agents/skills/herdr", ".claude/skills/herdr"].some((d) => existsSync(join(homedir(), d, "SKILL.md"))) }, harnesses: {}, key: {}, config: {}, starter_config: null };
  const found = Object.keys(HARNESSES).filter((n) => which(HARNESSES[n]));
  const usage = await readUsage(found);
  for (const n of Object.keys(HARNESSES)) {
    const u = usage.find((x) => x.pool === n);
    r.harnesses[n] = { command: HARNESSES[n], installed: found.includes(n), off_path: found.includes(n) ? null : offPath(HARNESSES[n]), usage: !found.includes(n) ? null : u.headroom != null ? `live: ${Math.round(u.headroom * 100)}% left (${u.source}, ${u.ageSec}s old)` : `none: ${u.note}` };
  }
  try {
    loadKey(); r.key.found = true;
    const t = await ask({ task: { brief: "Fix a typo in README.md" } }, { ping: { type: "noul", instructions: "Does `task.brief` describe a software task?" } }, undefined, 10000);
    r.key.works = true; r.key.ms = Math.round(t.latencyMs); r.key.model = t.model;
  } catch (e) { r.key.found ??= false; r.key.works = false; r.key.error = String(e?.message ?? e).slice(0, 160); r.key.where = `set TYPESAFE_API_KEY, or put TYPESAFE_API_KEY=... in ${KEY_FILES[0]}`; }
  const lists = Object.fromEntries(await Promise.all(found.map(async (n) => [n, (await MODEL_LISTS[n]?.()) || null])));
  for (const n of found) r.harnesses[n].models = lists[n];
  const path = configPath ?? CONFIG_PATH;
  const { config, notes } = loadConfig(path);
  r.config = { path, exists: existsSync(path), subscriptions: Object.keys(config.subscriptions), notes };
  // The one moment a default needs the user's attention: the harness no longer offers it.
  for (const [n, sub] of Object.entries(config.subscriptions)) {
    if (!sub.default_model) notes.push(`subscriptions.${n}: no default_model set; the orchestrator will pick from the harness's live list`);
    else if (lists[n]?.length && !lists[n].includes(sub.default_model)) notes.push(`subscriptions.${n}.default_model "${sub.default_model}" is not in the harness's current model list: choose a new default`);
  }
  // Configured but no snapshot yet is not a failure: Claude writes the first snapshot on its next turn.
  let wired = false;
  try { wired = /claude-statusline-usage|routr(\.exe)?"? statusline/.test(JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf8")).statusLine?.command ?? ""); } catch {}
  r.claude_usage_statusline = existsSync(CLAUDE_SNAPSHOT) ? "installed" : !found.includes("claude") ? "not needed"
    : wired ? "configured: the first snapshot appears after the next Claude Code turn" : "missing: without it Claude usage is assumed, not read";
  if (!r.config.exists) r.starter_config = { fallback_level: "standard", sure_at: 0.8, risk_above: 0.75, prefer: { research: "strong", review: "strong" }, subscriptions: Object.fromEntries(found.map((n) => [n, { ...SUGGESTED[n], default_model: "<choose from the models listed above>", default_effort: "medium" }])) };

  if (json) return console.log(JSON.stringify(r, null, 1));
  const ok = (b) => (b ? "ok " : "-- ");
  console.log(`routr doctor (changes nothing)\n\n${ok(true)}${r.runtime}\n${ok(r.herdr.path)}herdr ${r.herdr.path ? (r.herdr.inside_session ? "(inside a herdr session)" : "(installed; not inside a session)") : "not found: orchestration needs it (https://herdr.dev). Sizing subagents works without it"}`);
  if (r.herdr.path) console.log(`${ok(r.herdr.skill)}herdr skill ${r.herdr.skill ? "installed" : "not found: the orchestrator guide uses it. Install with: npx skills add herdrdev/herdr --skill herdr -g"}`);
  for (const [n, h] of Object.entries(r.harnesses)) console.log(`${ok(h.installed)}${n.padEnd(7)} ${h.installed ? `\`${h.command}\` found · usage ${h.usage}` : h.off_path ? `\`${h.command}\` is installed at ${h.off_path} but not on PATH: add its folder to PATH so routr and herdr can start it` : `\`${h.command}\` not found`}${h.models?.length ? `\n            models: ${h.models.slice(0, MODELS_SHOWN).join(", ")}${h.models.length > MODELS_SHOWN ? `, … (${h.models.length} in all; run \`${h.command} models\` for the rest)` : ""}` : ""}`);
  console.log(`${ok(r.key.works)}TypeSafe key ${r.key.works ? `works (${r.key.model}, ${r.key.ms} ms)` : `${r.key.found ? "found but failed" : "missing"}: ${r.key.error}`}`);
  console.log(`${ok(r.config.exists)}config ${r.config.path}${r.config.exists ? ` · subscriptions: ${r.config.subscriptions.join(", ") || "none"}` : " not found"}${r.config.exists && notes.length ? `\n   ${notes.join("\n   ")}` : ""}`);
  console.log(`${ok(r.claude_usage_statusline !== "missing: without it Claude usage is assumed, not read")}Claude usage statusline: ${r.claude_usage_statusline}`);
  if (r.starter_config) console.log(`\nStarter config for what was found (review the reserves, then save to ${path}):\n${JSON.stringify(r.starter_config, null, 2)}`);
}
