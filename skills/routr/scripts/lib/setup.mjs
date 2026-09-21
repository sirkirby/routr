// `routr setup`: does what `routr doctor` says is missing. It writes the config for the harnesses found, points Claude
// Code's statusline at `routr statusline`, and (only for a person at a terminal) asks for the TypeSafe key.
// A person gets questions; an agent passes `--yes` and the choices it settled with the user as flags. Same code, same file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_PATH } from "./config.mjs";
import { HARNESSES, inspect, paint, render, starterConfig, SUGGESTED, which } from "./doctor.mjs";
import { setKey } from "./key.mjs";

// `--model claude=sonnet --model codex=<id>`: repeatable name=id pairs.
export function parseModels(args) {
  const models = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--model") continue;
    const [name, id] = (args[i + 1] ?? "").split("=");
    if (!HARNESSES[name] || !id) throw new Error(`--model takes <subscription>=<model id>, with one of: ${Object.keys(HARNESSES).join(", ")}`);
    models[name] = id;
  }
  return models;
}

// What to do with Claude Code's settings. Someone else's statusline is never replaced.
export function statuslinePlan(settingsText, command) {
  let settings = {};
  if (settingsText != null && settingsText.trim()) { try { settings = JSON.parse(settingsText); } catch { return { action: "skip", why: "~/.claude/settings.json is not valid JSON; left alone" }; } }
  const current = settings.statusLine?.command;
  if (current && /routr(\.exe)?"? statusline|claude-statusline-usage/.test(current)) return { action: "none", why: "already set" };
  if (current) return { action: "skip", why: `you already have a statusline (${current}). Keep it, and have it pass its input to \`routr statusline\` for the snapshot: see the setup guide` };
  return { action: "write", settings: { ...settings, statusLine: { type: "command", command } } };
}

// The command Claude Code will run on every turn: a full path, because Claude's PATH is not the shell's.
function statuslineCommand() {
  const standalone = !/\.m?js$/.test(process.argv[1] ?? "");
  const bin = standalone ? process.execPath : which("routr") ?? "routr";
  return `${/\s/.test(bin) ? `"${bin}"` : bin} statusline`;
}

export async function setup(args) {
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const path = flag("--config") ?? CONFIG_PATH;
  const interactive = Boolean(process.stdin.isTTY) && !args.includes("--yes");
  const say = (s) => { if (!args.includes("--json")) console.log(s); };
  const did = [], skipped = [];
  let models;
  try { models = parseModels(args); } catch (e) { return { ok: false, error: e.message }; }

  say("Looking at what is installed…");
  const r = await inspect({ configPath: path, quiet: args.includes("--json") });
  const found = Object.keys(r.harnesses).filter((n) => r.harnesses[n].installed);
  for (const [n, id] of Object.entries(models)) {
    if (!found.includes(n)) return { ok: false, error: `--model ${n}=…: \`${HARNESSES[n]}\` was not found on this machine` };
    const list = r.harnesses[n].models;
    if (list?.length && !list.includes(id)) return { ok: false, error: `--model ${n}=${id}: not in the harness's current list (${list.join(", ")})` };
  }
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const yes = async (q) => !rl || !/^n/i.test((await rl.question(`${q} [Y/n] `)).trim());

  // 1. The config. An existing file is kept; harnesses found since then are added, nothing else is touched.
  let config = null;
  if (r.config.exists && !args.includes("--force")) { try { config = JSON.parse(readFileSync(path, "utf8")); } catch { return { ok: false, error: `${path} is not valid JSON. Fix it, or rewrite it with: routr setup --force` }; } }
  const fresh = found.filter((n) => !config?.subscriptions?.[n]);
  if (rl) for (const n of fresh) {
    const list = r.harnesses[n].models;
    if (models[n] || !list?.length) continue;
    say(`\n${paint(1, n)}: your everyday model there. Your agents start from it and go higher or lower as the work needs.`);
    list.forEach((m, i) => say(`  ${String(i + 1).padStart(2)}. ${m}`));
    const a = (await rl.question("Number or model id (Enter to leave it to the lead agent): ")).trim();
    const pick = /^\d+$/.test(a) ? list[Number(a) - 1] : a;
    if (pick && list.includes(pick)) models[n] = pick; else if (a) say(`  "${a}" is not in the list: left unset`);
  }
  if (!config) config = starterConfig(found, models);
  else for (const n of fresh) config.subscriptions = { ...config.subscriptions, [n]: starterConfig([n], models).subscriptions[n] };
  if (!r.config.exists || args.includes("--force") || fresh.length) {
    mkdirSync(dirname(path), { recursive: true });
    if (r.config.exists) copyFileSync(path, `${path}.bak`);
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    did.push(`wrote ${path}${fresh.length ? ` with ${fresh.join(", ")}` : " (no harness found yet: run `routr setup` again after installing one)"}`);
  } else skipped.push(`config ${path} already covers every harness found: kept as it is`);

  // 2. Claude Code's usage, which it reports only to its statusline.
  if (found.includes("claude") && !args.includes("--no-statusline") && r.claude_usage_statusline.startsWith("missing")) {
    const file = join(homedir(), ".claude/settings.json");
    const plan = statuslinePlan(existsSync(file) ? readFileSync(file, "utf8") : null, statuslineCommand());
    if (plan.action === "write" && (await yes("\nClaude Code reports usage only to its statusline. Set `routr statusline` as Claude's statusline command?"))) {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) copyFileSync(file, `${file}.bak-before-routr`);
      writeFileSync(file, JSON.stringify(plan.settings, null, 2) + "\n");
      did.push("set Claude Code's statusline to `routr statusline`: usage is read after your next Claude Code turn");
    } else if (plan.action !== "none") skipped.push(`Claude statusline: ${plan.why ?? "left alone"}`);
  }
  rl?.close();

  // 3. The key, last, and only from a person: it must never pass through an agent.
  if (!r.key.works && interactive) { say(""); const k = await setKey(); (k.ok ? did : skipped).push(k.ok ? `saved the TypeSafe key to ${k.file}${k.works ? " and it works" : `: ${k.error}`}` : `TypeSafe key: ${k.error}`); }

  const after = await inspect({ configPath: path, quiet: true });
  const result = { ok: true, did, skipped, config: path, next_steps: after.next_steps };
  if (args.includes("--json")) return result;
  say(`\n${did.map((d) => `${paint(32, "done")} ${d}`).concat(skipped.map((s) => `${paint(33, "kept")} ${s}`)).join("\n")}\n\n${render(after)}`);
  if (found.length && did.some((d) => d.startsWith("wrote"))) say(`\nYour config is plain JSON at ${path}. \`reserve\` is the share of each subscription routr never offers to workers (${found.map((n) => `${n} ${SUGGESTED[n].reserve}`).join(", ")}), and \`hardest_work\` is the hardest work you would hand it. Change anything there at any time.`);
  return result;
}
