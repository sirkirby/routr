// `routr setup`: does what `routr doctor` says is missing. It writes the config for the harnesses found, points Claude
// Code's statusline at `routr statusline`, and (only for a person at a terminal) asks for the TypeSafe key.
// A person gets questions; an agent passes `--yes` and the choices it settled with the user as flags. Same code, same file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_PATH } from "./config.mjs";
import { NOTICE, setTelemetry, telemetryStatus } from "./telemetry.mjs";
import { HARNESSES, inspect, paint, render, starterConfig, SUGGESTED, which } from "./doctor.mjs";
import { setKey } from "./key.mjs";
import { standalone } from "./runtime.mjs";
import { isOurStatusline } from "./statusline.mjs";
import { installSkill } from "./skill-install.mjs";
import { baseVersion, ROUTR_VERSION } from "./version.mjs";

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

// `--metered codex=after|with`: where a seat that reads as metered (billed usage, no quota) goes in the ranking.
export function parseMetered(args) {
  const ranks = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--metered") continue;
    const [name, rank] = (args[i + 1] ?? "").split("=");
    if (!HARNESSES[name] || !["after", "with"].includes(rank)) throw new Error(`--metered takes <subscription>=after|with, with one of: ${Object.keys(HARNESSES).join(", ")}`);
    ranks[name] = rank;
  }
  return ranks;
}

// Where each newly written pool that reads as metered goes in the ranking. `ask(name, note)` is the terminal question
// (absent under --yes, where the default stands); an answer starting with "w" means with, anything else after.
export async function meteredRanks(fresh, harnesses, ranks, ask) {
  for (const n of fresh) {
    if (harnesses[n]?.usage_class !== "metered" || ranks[n]) continue;
    ranks[n] = ask ? (/^w/i.test((await ask(n, harnesses[n].usage_note)).trim()) ? "with" : "after") : "after";
  }
  return ranks;
}

// A list longer than this is searched, not printed: Cursor offers over 200 models (231 seen), and routr keeps no
// idea of which ones matter, so the user narrows it by typing part of a name.
const LIST_IN_FULL = 20;

// Every word typed must appear in the id: "grok high" finds `cursor-grok-4.6-high`.
export const narrow = (list, query) => { const words = query.toLowerCase().split(/\s+/).filter(Boolean); return list.filter((m) => words.every((w) => m.toLowerCase().includes(w))); };

// Returns the chosen id, or undefined when the user leaves it to the lead agent. `question` and `say` are passed in so a test can drive it.
export async function pickModel(list, question, say) {
  let shown = list.length <= LIST_IN_FULL ? list : [];
  if (!shown.length) say(`  ${list.length} models. Type part of a name to search (for example a family or a size).`);
  for (;;) {
    shown.forEach((m, i) => say(`  ${String(i + 1).padStart(2)}. ${m}`));
    const a = (await question(shown.length ? "Number, model id, or text to search (Enter to leave it to the lead agent): " : "Search, or a full model id (Enter to leave it to the lead agent): ")).trim();
    if (!a) return undefined;
    if (/^\d+$/.test(a) && shown[Number(a) - 1]) return shown[Number(a) - 1];
    if (list.includes(a)) return a;
    const hits = narrow(list, a);
    if (hits.length === 1) return hits[0];
    if (!hits.length) say(`  nothing matches "${a}"`);
    else if (hits.length > LIST_IN_FULL * 2) { say(`  ${hits.length} match "${a}": add a word to narrow it`); shown = []; continue; }
    shown = hits;
  }
}

// What to do with Claude Code's settings. Someone else's statusline is never replaced.
export function statuslinePlan(settingsText, command) {
  let settings = {};
  if (settingsText != null && settingsText.trim()) { try { settings = JSON.parse(settingsText); } catch { return { action: "skip", why: "~/.claude/settings.json is not valid JSON; left alone" }; } }
  const current = settings.statusLine?.command;
  if (isOurStatusline(current)) return { action: "none", why: "already set" };
  if (current) return { action: "skip", why: `you already have a statusline (${current}). Keep it, and have it pass its input to \`routr statusline\` for the snapshot: see the setup guide` };
  return { action: "write", settings: { ...settings, statusLine: { type: "command", command } } };
}

// The command Claude Code will run on every turn: a full path, because Claude's PATH is not the shell's.
function statuslineCommand() {
  const bin = standalone() ? process.execPath : which("routr") ?? "routr";
  return `${/\s/.test(bin) ? `"${bin}"` : bin} statusline`;
}

export async function setup(args) {
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const path = flag("--config") ?? CONFIG_PATH;
  const interactive = Boolean(process.stdin.isTTY) && !args.includes("--yes");
  const say = (s) => { if (!args.includes("--json")) console.log(s); };
  const did = [], skipped = [];
  let models, ranks;
  try { models = parseModels(args); ranks = parseMetered(args); } catch (e) { return { ok: false, error: e.message }; }

  say("Looking at what is installed…");
  const r = await inspect({ configPath: path, quiet: args.includes("--json") });
  const found = Object.keys(r.harnesses).filter((n) => r.harnesses[n].installed);
  for (const n of Object.keys(ranks)) {
    if (!found.includes(n)) return { ok: false, error: `--metered ${n}=…: \`${HARNESSES[n]}\` was not found on this machine` };
    if (r.harnesses[n].usage_class !== "metered") return { ok: false, error: `--metered ${n}=…: ${n} does not report as metered (${r.harnesses[n].usage_note ?? r.harnesses[n].usage}). For a seat routr cannot read, set "billing": "metered" in the config instead` };
  }
  for (const [n, id] of Object.entries(models)) {
    if (!found.includes(n)) return { ok: false, error: `--model ${n}=…: \`${HARNESSES[n]}\` was not found on this machine` };
    const list = r.harnesses[n].models;
    if (list?.length && !list.includes(id)) return { ok: false, error: `--model ${n}=${id}: not in the harness's current list (${list.join(", ")})` };
  }
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const yes = async (q) => !rl || !/^n/i.test((await rl.question(`${q} [Y/n] `)).trim());

  // 0. The skill agents read: missing, or left behind by an older routr. Writing it again is always safe.
  const base = baseVersion(ROUTR_VERSION);
  // From a source checkout (0.0.0-dev) a release's skill never matches, and rewriting it would fight the installed binary.
  if (!r.skill.length || (standalone() && r.skill.some((k) => baseVersion(k.version) !== base))) { installSkill(); did.push(`installed the routr skill ${base} for your agents`); }

  // 1. The config. An existing file is kept; harnesses found since then are added, nothing else is touched.
  let config = null;
  if (r.config.exists && !args.includes("--force")) { try { config = JSON.parse(readFileSync(path, "utf8")); } catch { return { ok: false, error: `${path} is not valid JSON. Fix it, or rewrite it with: routr setup --force` }; } }
  const fresh = found.filter((n) => !config?.subscriptions?.[n]);
  if (rl) for (const n of fresh) {
    const list = r.harnesses[n].models;
    if (models[n] || !list?.length) continue;
    say(`\n${paint(1, n)}: your everyday model there. Your agents start from it and go higher or lower as the work needs.`);
    models[n] = await pickModel(list, (q) => rl.question(q), say);
  }
  // A seat that reads as metered (measured on a ChatGPT Enterprise seat: no windows, unlimited credits) has no headroom
  // number, so its place in the ranking is the user's call. Asked once, when the pool is first written; `after` is the
  // default because included usage expires and billed usage does not.
  await meteredRanks(fresh, r.harnesses, ranks, rl && ((n, note) => { say(`\n${paint(1, n)} reports billed usage with no quota (${note}).`); return rl.question("Your subscriptions' included usage expires; this seat's usage is billed. Rank it after them, so it takes the overflow, or with them by an assumed headroom? [after/with, Enter = after] "); }));
  if (!config) config = starterConfig(found, models, ranks);
  else for (const n of fresh) config.subscriptions = { ...config.subscriptions, [n]: starterConfig([n], models, ranks).subscriptions[n] };
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
  // 3. Telemetry: on by default; a person is told and asked once, an agent's run leaves the default and says so.
  let asked = false;
  try { asked = "telemetry" in JSON.parse(readFileSync(path, "utf8")); } catch {}
  if (!asked && telemetryStatus({}).on) {
    if (rl) {
      say(`\n${NOTICE}`);
      const keep = await yes("Send them?");
      setTelemetry(keep, path);
      (keep ? did : skipped).push(keep ? "telemetry on: anonymous outcomes, once a day (routr telemetry off to stop)" : "telemetry off (routr telemetry on to help tune routr)");
    } else skipped.push(`telemetry is on by default. ${NOTICE}`);
  }
  rl?.close();

  // 4. The key, last, and only from a person: it must never pass through an agent.
  if (!r.key.works && interactive) { say(""); const k = await setKey(); (k.ok ? did : skipped).push(k.ok ? `saved the TypeSafe key to ${k.file}${k.works ? " and it works" : `: ${k.error}`}` : `TypeSafe key not saved: ${k.error}. Run \`routr key set\` when you have it`); }

  const after = await inspect({ configPath: path, quiet: true });
  const result = { ok: true, did, skipped, config: path, next_steps: after.next_steps };
  if (args.includes("--json")) return result;
  say(`\n${did.map((d) => `${paint(32, "done")} ${d}`).concat(skipped.map((s) => `${paint(33, "note")} ${s}`)).join("\n")}\n\n${render(after)}`);
  if (found.length && did.some((d) => d.startsWith("wrote"))) say(`\nYour config is plain JSON at ${path}. \`reserve\` is the share of each subscription routr never offers to workers (${found.map((n) => `${n} ${SUGGESTED[n].reserve}`).join(", ")}), and \`hardest_work\` is the hardest work you would hand it.${fresh.some((n) => ranks[n]) ? ` \`metered_rank\` places a seat billed per token (${fresh.filter((n) => ranks[n]).map((n) => `${n} ${ranks[n]}`).join(", ")}).` : ""} Change anything there at any time.`);
  return result;
}
