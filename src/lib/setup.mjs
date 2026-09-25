// `routr setup`: does what `routr doctor` says is missing. It writes the config for the harnesses found, points Claude
// Code's statusline at `routr statusline`, and (only for a person at a terminal) asks for the TypeSafe key.
// A person gets questions; an agent passes `--yes` and the choices it settled with the user as flags. Same code, same file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_PATH, SUB_DEFAULTS } from "./config.mjs";
import { LEVELS } from "./questions.mjs";
import { HARDEST, RESERVE, SETTINGS_INTRO, settingSummary } from "./wording.mjs";
import { envOff, NOTICE, setTelemetry } from "./telemetry.mjs";
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

// `--hardest cursor=strong`: the most demanding work the user sends to a subscription.
// `--reserve claude=0.25` (or 25%): the share routr holds back from workers (wording.mjs has the words people see).
// Both decide the ranking, so both are the user's to set: asked at a terminal, or passed as flags, at setup or any time.
export const parseLevel = (a) => { const t = String(a ?? "").trim().toLowerCase(); return LEVELS.find((l, i) => t === l || t === String(i + 1)) ?? null; };
export const parseShare = (a) => { const t = String(a ?? "").trim(), n = t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : Number(t); return t && Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 100) / 100 : null; };
function parsePairs(args, flag, parse, what) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const [name, v] = (args[i + 1] ?? "").split("=");
    const value = parse(v);
    if (!HARNESSES[name] || value == null) throw new Error(`${flag} takes <subscription>=${what}, with one of: ${Object.keys(HARNESSES).join(", ")}`);
    out[name] = value;
  }
  return out;
}
export const parseHardest = (args) => parsePairs(args, "--hardest", parseLevel, "basic|standard|strong");
export const parseReserve = (args) => parsePairs(args, "--reserve", parseShare, "<0..1, or a percent>");

// A person's answer to the two questions; Enter keeps the suggestion, and an answer that is not one asks again.
export async function askSettings(n, suggested, question, say) {
  let hardest = null, reserve = null;
  while (!hardest) { const a = (await question(HARDEST.question(n, suggested.hardest_work))).trim(); hardest = a ? parseLevel(a) : suggested.hardest_work; if (!hardest) say(HARDEST.retry); }
  while (reserve == null) { const a = (await question(RESERVE.question(n, `${Math.round(suggested.reserve * 100)}%`))).trim(); reserve = a ? parseShare(a) : suggested.reserve; if (reserve == null) say(RESERVE.retry); }
  return { hardest_work: hardest, reserve };
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

// `deps` are seams so a test can drive a whole run, questions and all, without a terminal, the machine's harnesses, the
// network, or the user's own files: what is installed (`inspect`), the person's answers (`question`), and each step
// that writes outside the config (the skill, the telemetry state, the key).
export async function setup(args, { inspect: look = inspect, question, interactive: tty = Boolean(process.stdin.isTTY), env = process.env,
  install = installSkill, share: shareOn = setTelemetry, key = setKey, print = console.log } = {}) {
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const path = flag("--config") ?? CONFIG_PATH;
  const interactive = tty && !args.includes("--yes");
  const say = (s) => { if (!args.includes("--json")) print(s); };
  const did = [], skipped = [];
  let models, ranks, hardest, reserves;
  try { models = parseModels(args); ranks = parseMetered(args); hardest = parseHardest(args); reserves = parseReserve(args); } catch (e) { return { ok: false, error: e.message }; }

  say("Looking at what is installed…");
  const r = await look({ configPath: path, quiet: args.includes("--json") });
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
  for (const [flagName, set] of [["--hardest", hardest], ["--reserve", reserves]])
    for (const n of Object.keys(set)) if (!found.includes(n) && !r.config.subscriptions.includes(n)) return { ok: false, error: `${flagName} ${n}=…: ${n} is not configured and \`${HARNESSES[n]}\` was not found on this machine` };
  const rl = interactive && !question ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = interactive ? (question ?? ((q) => rl.question(q))) : null; // null: nobody to ask (--yes, or no terminal)
  const yes = async (q) => !ask || !/^n/i.test((await ask(`${q} [Y/n] `)).trim());

  // 0. The skill agents read: missing, or left behind by an older routr. Writing it again is always safe.
  const base = baseVersion(ROUTR_VERSION);
  // From a source checkout (0.0.0-dev) a release's skill never matches, and rewriting it would fight the installed binary.
  if (!r.skill.length || (standalone() && r.skill.some((k) => baseVersion(k.version) !== base))) { install(); did.push(`installed the routr skill ${base} for your agents`); }

  // 1. The config. An existing file is kept; harnesses found since then are added, nothing else is touched.
  let config = null;
  if (r.config.exists && !args.includes("--force")) { try { config = JSON.parse(readFileSync(path, "utf8")); } catch { return { ok: false, error: `${path} is not valid JSON. Fix it, or rewrite it with: routr setup --force` }; } }
  const fresh = found.filter((n) => !config?.subscriptions?.[n]);
  // hardest_work and reserve decide where work may go, so they are asked, never slipped in: for each subscription
  // being written, and for one already configured without them. Enter keeps the suggestion; a flag answers instead.
  const suggest = (n) => SUGGESTED[n] ?? { hardest_work: SUB_DEFAULTS.hardest_work, reserve: SUB_DEFAULTS.reserve };
  const unset = Object.keys(config?.subscriptions ?? {}).filter((n) => config.subscriptions[n]?.hardest_work === undefined || config.subscriptions[n]?.reserve === undefined);
  // A person running setup again is offered their settings to go through, each current value the default, so a config
  // written before setup asked (or by an agent) gets a person's answers too; nobody has to know the flags. Not under
  // --yes, and not when a flag already says what to change.
  const flagged = Object.keys({ ...models, ...ranks, ...hardest, ...reserves }).length > 0;
  const configured = Object.keys(config?.subscriptions ?? {}).filter((n) => !unset.includes(n));
  let review = [];
  if (ask && configured.length && !flagged) {
    say(`\nYour settings: ${configured.map((n) => settingSummary(n, config.subscriptions[n])).join("; ")}.`);
    if (await yes("Go through them now? Enter keeps each one as it is")) review = configured;
  }
  const settings = {};
  let explained = false;
  for (const n of [...fresh, ...unset, ...review]) {
    const list = r.harnesses[n]?.models;
    if (ask && fresh.includes(n) && !models[n] && list?.length) {
      say(`\n${paint(1, n)}: your everyday model there. Your agents start from it and go higher or lower as the work needs.`);
      models[n] = await pickModel(list, ask, say);
    }
    if (ask && !(hardest[n] && reserves[n] != null)) {
      if (!explained) { say(`\n${SETTINGS_INTRO}`); explained = true; }
      if (!fresh.includes(n) || !list?.length) say(`\n${paint(1, n)}:`);
      const now = review.includes(n) ? { hardest_work: config.subscriptions[n].hardest_work, reserve: config.subscriptions[n].reserve } : suggest(n);
      settings[n] = await askSettings(n, now, ask, say);
    } else settings[n] = { hardest_work: suggest(n).hardest_work, reserve: suggest(n).reserve };
  }
  // A flag always wins, for a new subscription or one already configured: this is also how a setting is changed later.
  for (const [n, v] of Object.entries(hardest)) settings[n] = { ...settings[n], hardest_work: v };
  for (const [n, v] of Object.entries(reserves)) settings[n] = { ...settings[n], reserve: v };
  // A seat that reads as metered (measured on a ChatGPT Enterprise seat: no windows, unlimited credits) has no headroom
  // number, so its place in the ranking is the user's call. Asked once, when the pool is first written; `after` is the
  // default because included usage expires and billed usage does not.
  await meteredRanks(fresh, r.harnesses, ranks, ask && ((n, note) => { say(`\n${paint(1, n)} reports billed usage with no quota (${note}).`); return ask("Your subscriptions' included usage expires; this seat's usage is billed. Rank it after them, so it takes the overflow, or with them by an assumed headroom? [after/with, Enter = after] "); }));
  let kept; try { kept = JSON.parse(readFileSync(path, "utf8")).telemetry; } catch {} // --force keeps the person's telemetry choice
  if (!config) config = { ...starterConfig(found, models, ranks), ...(typeof kept === "boolean" ? { telemetry: kept } : {}) };
  else for (const n of fresh) config.subscriptions = { ...config.subscriptions, [n]: starterConfig([n], models, ranks).subscriptions[n] };
  // Then every choice onto its subscription, new or old; what changed on an old one is said.
  const changed = [];
  const put = (n, k, v) => {
    const sub = config.subscriptions[n];
    if (!sub || v === undefined || sub[k] === v) return;
    if (!fresh.includes(n) && r.config.exists && !args.includes("--force")) changed.push(`${n}.${k} ${sub[k] === undefined ? "set to" : `${JSON.stringify(sub[k])} →`} ${JSON.stringify(v)}`);
    sub[k] = v;
  };
  for (const [n, s] of Object.entries(settings)) { put(n, "hardest_work", s.hardest_work); put(n, "reserve", s.reserve); }
  for (const [n, id] of Object.entries(models)) put(n, "default_model", id);
  for (const [n, rank] of Object.entries(ranks)) put(n, "metered_rank", rank);
  if (changed.length) did.push(`changed ${changed.join(", ")}`);
  if (!r.config.exists || args.includes("--force") || fresh.length || changed.length) {
    mkdirSync(dirname(path), { recursive: true });
    if (r.config.exists) copyFileSync(path, `${path}.bak`);
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    did.push(`wrote ${path}${fresh.length ? ` with ${fresh.join(", ")}` : changed.length ? "" : " (no harness found yet: run `routr setup` again after installing one)"}`);
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
  // 3. Telemetry: off unless a person says yes. Asked once, default no; an agent's run never turns it on.
  let asked = false;
  try { asked = "telemetry" in JSON.parse(readFileSync(path, "utf8")); } catch {}
  if (!asked && !envOff(env)) {
    if (ask) {
      say(`\n${NOTICE}`);
      const share = /^y/i.test((await ask("Share them? [y/N] ")).trim());
      shareOn(share, path);
      (share ? did : skipped).push(share ? "telemetry on: anonymous outcomes, once a day (routr telemetry off to stop)" : "telemetry off (routr telemetry on, any time, to help tune routr)");
    } else skipped.push("telemetry is off. Ask the user whether to share anonymous outcomes (docs/telemetry.md); if they say yes: routr telemetry on");
  }
  rl?.close();

  // 4. The key, last, and only from a person: it must never pass through an agent.
  if (!r.key.works && interactive) { say(""); const k = await key(); (k.ok ? did : skipped).push(k.ok ? `saved the TypeSafe key to ${k.file}${k.works ? " and it works" : `: ${k.error}`}` : `TypeSafe key not saved: ${k.error}. Run \`routr key set\` when you have it`); }

  const after = await look({ configPath: path, quiet: true });
  const result = { ok: true, did, skipped, config: path, next_steps: after.next_steps };
  if (args.includes("--json")) return result;
  say(`\n${did.map((d) => `${paint(32, "done")} ${d}`).concat(skipped.map((s) => `${paint(33, "note")} ${s}`)).join("\n")}\n\n${render(after)}`);
  if (found.length && did.some((d) => d.startsWith("wrote"))) say(`\nYour settings are plain JSON at ${path}: ${Object.entries(config.subscriptions).map(([n, s]) => settingSummary(n, s)).join("; ")}. Change one any time: routr setup --hardest <name>=basic|standard|strong --reserve <name>=<share>, or edit the file.`);
  return result;
}
