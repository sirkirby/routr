// `routr setup`: does what `routr doctor` says is missing. It writes the config for the harnesses found, points Claude
// Code's statusline at `routr statusline`, and (only for a person at a terminal) asks for the TypeSafe key.
// A person gets questions; an agent passes `--yes` and the choices it settled with the user as flags. Same code, same file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCOUNT_USE, CONFIG_PATH, loadConfig, SUB_DEFAULTS } from "./config.mjs";
import { LEVELS } from "./questions.mjs";
import { settingSummary } from "./wording.mjs";
import { envOff, setTelemetry } from "./telemetry.mjs";
import { inspect, paint, render, starterConfig, which } from "./doctor.mjs";
import { HARNESSES } from "./harnesses.mjs";
import { setKey } from "./key.mjs";
import { home, standalone } from "./runtime.mjs";
import { isOurStatusline } from "./statusline.mjs";
import { installSkill } from "./skill-install.mjs";
import { guided } from "./setup-guided.mjs";
import { CANCEL, createUI } from "./tui.mjs";
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
    const [name, v, extra] = (args[i + 1] ?? "").split("=");
    const value = extra === undefined ? parse(v) : null;
    if (!HARNESSES[name] || value == null) throw new Error(`${flag} takes <subscription>=${what}, with one of: ${Object.keys(HARNESSES).join(", ")}`);
    out[name] = value;
  }
  return out;
}
export const parseHardest = (args) => parsePairs(args, "--hardest", parseLevel, "basic|standard|strong");
export const parseUse = (args) => parsePairs(args, "--use", (v) => ACCOUNT_USE.includes(v) ? v : null, "normal|fallback");
// `--effort codex=high`: the everyday effort there, checked against the harness's own levels once it is found.
export const parseEffort = (args) => parsePairs(args, "--effort", (v) => (/^[a-z]+$/i.test(v ?? "") ? v.toLowerCase() : null), "<level>");
// `--enable agy` / `--disable agy`: which subscriptions routr may hand work to. Turning one off keeps its settings.
export function parseSwitches(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--enable" && args[i] !== "--disable") continue;
    const name = args[i + 1];
    if (!HARNESSES[name]) throw new Error(`${args[i]} takes a subscription name: one of ${Object.keys(HARNESSES).join(", ")}`);
    out[name] = args[i] === "--enable";
  }
  return out;
}
// `routr setup --show`: the settings as routr reads them, for an agent to see before it changes one. Asks no harness.
export function showSettings(path) {
  const { config, notes } = loadConfig(path);
  return { ok: true, config: path, exists: existsSync(path), ...config, ...(notes.length ? { notes } : {}) };
}
export const parseReserve = (args) => parsePairs(args, "--reserve", parseShare, "<0..1, or a percent>");

// Where each newly written pool that reads as metered goes in the ranking. `ask(name, note)` is the terminal question
// (absent under --yes, where the default stands); an answer starting with "w" means with, anything else after.
export async function meteredRanks(fresh, harnesses, ranks, ask) {
  for (const n of fresh) {
    if (harnesses[n]?.usage_class !== "metered" || ranks[n]) continue;
    ranks[n] = ask ? (/^w/i.test((await ask(n, harnesses[n].usage_note)).trim()) ? "with" : "after") : "after";
  }
  return ranks;
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
// network, or the user's own files: what is installed (`inspect`), the person's answers (`question`, read line by line
// in the tui's accessible mode, or `ui`, a ready-made tui), each harness's effort levels (`efforts`), and each step that
// writes outside the config (the skill, the telemetry state, the key).
export async function setup(args, { inspect: look = inspect, question, interactive: tty = Boolean(process.stdin.isTTY), env = process.env,
  install = installSkill, share: shareOn = setTelemetry, key = setKey, print = console.log, efforts: levelsOf = (n, model) => HARNESSES[n].efforts?.(model), ui: makeUI } = {}) {
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const path = flag("--config") ?? CONFIG_PATH;
  const interactive = tty && !args.includes("--yes");
  const say = (s) => { if (!args.includes("--json")) print(s); };
  const did = [], skipped = [];
  let models, ranks, hardest, reserves, efforts, switches, uses;
  try { models = parseModels(args); ranks = parseMetered(args); hardest = parseHardest(args); reserves = parseReserve(args); efforts = parseEffort(args); switches = parseSwitches(args); uses = parseUse(args); } catch (e) { return { ok: false, error: e.message }; }
  // The legacy flag remains a setter; explicit --use wins when both flags name the same account.
  uses = { ...Object.fromEntries(Object.entries(ranks).map(([n, rank]) => [n, rank === "with" ? "normal" : "fallback"])), ...uses };
  // --show only reads: with a change flag beside it, an agent could take the settings printed for the change made.
  if (args.includes("--show")) return Object.keys({ ...models, ...ranks, ...hardest, ...reserves, ...efforts, ...switches, ...uses }).length || args.includes("--force")
    ? { ok: false, error: "--show only reads your settings: run the change without it, then --show again to see it" } : showSettings(path);

  const guidedRun = interactive && !Object.keys({ ...models, ...ranks, ...hardest, ...reserves, ...efforts, ...switches, ...uses }).length;
  // Scripted answers (a test, or a caller with its own line reader) drive the tui's accessible mode: numbered questions.
  const ui = !guidedRun ? null : makeUI ? makeUI() : question ? createUI({ ask: question, accessible: true, output: { write: (t) => print(t.replace(/\n$/, "")) } }) : createUI();
  let r;
  if (ui) {
    ui.intro("routr setup");
    const spin = ui.spinner("Checking your harnesses, their sign-in, and your TypeSafe key");
    r = await look({ configPath: path, quiet: true });
    const ready = Object.keys(r.harnesses).filter((n) => r.harnesses[n].installed && r.harnesses[n].signed_in);
    spin.stop(`${ready.length} signed in (${ready.join(", ") || "none"}) · key ${r.key.works ? "works" : "missing"}`);
  } else {
    say("Looking at what is installed…");
    r = await look({ configPath: path, quiet: args.includes("--json") });
  }
  // Only a harness that is installed AND signed in can be set up: one signed out gets no work until the user signs in.
  const found = Object.keys(r.harnesses).filter((n) => r.harnesses[n].installed && r.harnesses[n].signed_in);
  // Installed but not signed in, and not set up (--force sets up nothing that was): said in every kind of run (--json
  // too), so an agent can tell the person.
  const kept = args.includes("--force") ? [] : r.config.subscriptions;
  const leftOut = Object.keys(r.harnesses).filter((n) => r.harnesses[n].installed && !r.harnesses[n].signed_in && !kept.includes(n))
    .map((n) => `${HARNESSES[n]?.label ?? n} left out: ${r.harnesses[n].sign_in}, then routr setup again`);
  for (const n of Object.keys(ranks)) {
    if (!found.includes(n)) return { ok: false, error: `--metered ${n}=…: ${r.harnesses[n]?.installed ? r.harnesses[n].sign_in : `\`${HARNESSES[n].executable}\` was not found on this machine`}` };
    if (r.harnesses[n].usage_class !== "metered") return { ok: false, error: `--metered ${n}=…: ${n} does not report as metered (${r.harnesses[n].usage_note ?? r.harnesses[n].usage}). For a seat routr cannot read, set "billing": "metered" in the config instead` };
  }
  for (const [n, id] of Object.entries(models)) {
    if (!found.includes(n)) return { ok: false, error: `--model ${n}=…: ${r.harnesses[n]?.installed ? r.harnesses[n].sign_in : `\`${HARNESSES[n].executable}\` was not found on this machine`}` };
    const list = r.harnesses[n].models;
    if (list?.length && !list.includes(id) && !HARNESSES[n].openList) return { ok: false, error: `--model ${n}=${id}: not in the harness's current list (${list.join(", ")})` };
  }
  for (const [flagName, set] of [["--hardest", hardest], ["--reserve", reserves], ["--use", uses]])
    for (const n of Object.keys(set)) if (!found.includes(n) && !r.config.subscriptions.includes(n)) return { ok: false, error: `${flagName} ${n}=…: ${n} is not configured and ${r.harnesses[n]?.installed ? r.harnesses[n].sign_in : `\`${HARNESSES[n].executable}\` was not found on this machine`}` };
  for (const [n, on] of Object.entries(switches)) {
    // Set up, it keeps its settings on or off; one turned off is turned on again only once it is signed in.
    if (r.config.subscriptions.includes(n) && (!on || found.includes(n) || !r.config.off?.includes(n))) continue;
    // A harness found now is added in this run, so it can be added turned off ("set up, but keep agy off").
    if (!on && !found.includes(n)) return { ok: false, error: `--disable ${n}: ${n} is not set up in routr, so there is nothing to turn off` };
    if (!found.includes(n)) return { ok: false, error: `--enable ${n}: ${r.harnesses[n]?.installed ? r.harnesses[n].sign_in : `\`${HARNESSES[n].executable}\` was not found on this machine`}` };
  }
  // An effort must be one the harness takes for the model it will run: the one given now, or the one already set.
  let current = {}; try { current = JSON.parse(readFileSync(path, "utf8")).subscriptions ?? {}; } catch {}
  for (const [n, level] of Object.entries(efforts)) {
    if (!HARNESSES[n].effort) return { ok: false, error: `--effort ${n}=…: ${HARNESSES[n].noEffort}` };
    if (!found.includes(n) && !r.config.subscriptions.includes(n)) return { ok: false, error: `--effort ${n}=…: ${n} is not configured and ${r.harnesses[n]?.installed ? r.harnesses[n].sign_in : `\`${HARNESSES[n].executable}\` was not found on this machine`}` };
    const levels = found.includes(n) ? await levelsOf(n, models[n] ?? current[n]?.default_model) : null;
    if (levels?.length && !levels.includes(level)) return { ok: false, error: `--effort ${n}=${level}: ${HARNESSES[n].label} takes ${levels.join(", ")}${models[n] ?? current[n]?.default_model ? ` for ${models[n] ?? current[n]?.default_model}` : ""}` };
  }
  // The skill agents read: missing, or left behind by an older routr. Writing it again is always safe, and it is done
  // whatever the person chose, since it is not a setting. From a source checkout (0.0.0-dev) a release's skill never
  // matches, and rewriting it would fight the installed binary.
  const skillStep = () => {
    const base = baseVersion(ROUTR_VERSION);
    if (r.skill.length && !(standalone() && r.skill.some((k) => baseVersion(k.version) !== base))) return false;
    install(); did.push(`installed the routr skill ${base} for your agents`); return true;
  };
  // A person at a terminal gets the guided flow; flags and --yes (an agent) never ask anything.
  const flagged = Object.keys({ ...models, ...ranks, ...hardest, ...reserves, ...efforts, ...switches, ...uses }).length > 0;
  let config = null;
  if (r.config.exists && !args.includes("--force")) { try { config = JSON.parse(readFileSync(path, "utf8")); } catch { return { ok: false, error: `${path} is not valid JSON. Fix it, or rewrite it with: routr setup --force` }; } }
  const claudeFile = join(home(), ".claude/settings.json");
  const statuslineOffer = found.includes("claude") && !args.includes("--no-statusline") && r.claude_usage_statusline.startsWith("missing")
    ? statuslinePlan(existsSync(claudeFile) ? readFileSync(claudeFile, "utf8") : null, statuslineCommand()) : null;
  let telemetryAsked = false;
  try { telemetryAsked = "telemetry" in JSON.parse(readFileSync(path, "utf8")); } catch {}
  let choices = null;
  if (ui && !flagged) {
    // The key first: nothing routr advises works without it, and it is typed by the person, never passed by an agent.
    if (!r.key.works) {
      ui.note("TypeSafe key", ["routr asks TypeSafe's Jev about each piece of work: it needs your key.", "Create one at https://console.typesafe.ai/keys, then paste it here (it is not shown)."]);
      const k = await key();
      (k.ok ? did : skipped).push(k.ok ? `saved the TypeSafe key to ${k.file}${k.works ? " and it works" : `: ${k.error}`}` : `TypeSafe key not saved: ${k.error}. Run \`routr key set\` when you have it`);
    }
    choices = await guided({ ui, r, config, efforts: levelsOf, statusline: statuslineOffer?.action === "write", telemetry: !telemetryAsked && !envOff(env) });
    if (choices === CANCEL) { ui.cancel("Setup stopped: nothing was written."); ui.close(); return { ok: false, cancelled: true, error: "setup stopped: nothing was written", did, skipped }; }
    if (!choices.write) {
      if (skillStep()) ui.note("Done", did);
      ui.outro("Your settings did not change."); ui.close();
      return { ok: true, did, skipped: [...skipped, ...leftOut, "nothing changed"], config: path, next_steps: r.next_steps };
    }
    Object.assign(models, choices.models); Object.assign(efforts, choices.efforts); Object.assign(hardest, choices.hardest);
    Object.assign(reserves, choices.reserves); Object.assign(switches, choices.switches); Object.assign(ranks, choices.ranks);
    Object.assign(uses, choices.uses);
  }

  skillStep();

  // 1. The config. An existing file is kept; harnesses found since then are added (turned off when the person left
  // them unticked), and each choice or flag is applied; nothing else is touched.
  const fresh = found.filter((n) => !config?.subscriptions?.[n]);
  const suggest = (n) => HARNESSES[n]?.suggested ?? { hardest_work: SUB_DEFAULTS.hardest_work, reserve: SUB_DEFAULTS.reserve };
  // A subscription written before setup asked (no hardest_work or reserve) gets the suggestion, as a new one does.
  const unset = Object.keys(config?.subscriptions ?? {}).filter((n) => config.subscriptions[n]?.hardest_work === undefined || config.subscriptions[n]?.reserve === undefined);
  const settings = Object.fromEntries([...fresh, ...unset].map((n) => [n, { hardest_work: suggest(n).hardest_work, reserve: suggest(n).reserve }]));
  // A choice or a flag always wins, for a new subscription or one already configured.
  for (const [n, v] of Object.entries(hardest)) settings[n] = { ...settings[n], hardest_work: v };
  for (const [n, v] of Object.entries(reserves)) settings[n] = { ...settings[n], reserve: v };
  // Fresh metered accounts keep the legacy fallback default until the person chooses normal use.
  let old = null; try { old = JSON.parse(readFileSync(path, "utf8")); } catch {}
  await meteredRanks(fresh.filter((n) => !old?.subscriptions?.[n]?.metered_rank), r.harnesses, ranks, null);
  // --force rewrites the file from the suggestions, but keeps the person's own choices: telemetry, automatic updates,
  // and which subscriptions are turned off.
  if (!config) {
    config = { ...starterConfig(found, models, ranks), ...(typeof old?.telemetry === "boolean" ? { telemetry: old.telemetry } : {}), ...(typeof old?.auto_update === "boolean" ? { auto_update: old.auto_update } : {}) };
    for (const [n, s] of Object.entries(old?.subscriptions ?? {})) if (config.subscriptions[n]) {
      if (s?.enabled === false) config.subscriptions[n].enabled = false;
      // A rebuild must not silently change where the person permits routine spending.
      for (const k of ["use", "metered_rank", "billing"]) if (s?.[k] !== undefined) config.subscriptions[n][k] = s[k];
    }
  }
  else for (const n of fresh) config.subscriptions = { ...config.subscriptions, [n]: starterConfig([n], models, ranks).subscriptions[n] };
  // Then every choice onto its subscription, new or old; what changed on an old one is said.
  const changed = [];
  const put = (n, k, v) => {
    const sub = config.subscriptions[n];
    if (!sub || v === undefined || sub[k] === v) return;
    if (!fresh.includes(n) && r.config.exists && !args.includes("--force")) changed.push(`${n}.${k} ${sub[k] === undefined ? "set to" : `${JSON.stringify(sub[k])} →`} ${JSON.stringify(v)}`);
    if (v === null) delete sub[k]; else sub[k] = v;
  };
  for (const [n, s] of Object.entries(settings)) { put(n, "hardest_work", s.hardest_work); put(n, "reserve", s.reserve); }
  for (const [n, id] of Object.entries(models)) put(n, "default_model", id);
  for (const [n, level] of Object.entries(efforts)) put(n, "default_effort", level);
  // A new model may not take the effort already set: it is reset to one it takes (medium where it can), and said.
  for (const [n, id] of Object.entries(models)) {
    const sub = config.subscriptions[n];
    if (!id || efforts[n] || !sub?.default_effort || !HARNESSES[n].effort) continue;
    const levels = await levelsOf(n, id);
    if (!levels?.length || levels.includes(sub.default_effort)) continue;
    const to = levels.includes("medium") ? "medium" : levels[0];
    changed.push(`${n}.default_effort ${JSON.stringify(sub.default_effort)} → ${JSON.stringify(to)} (${id} does not take ${sub.default_effort})`);
    sub.default_effort = to;
  }
  for (const [n, on] of Object.entries(switches)) put(n, "enabled", on);
  for (const [n, rank] of Object.entries(ranks)) put(n, "metered_rank", rank);
  for (const [n, use] of Object.entries(uses)) put(n, "use", use);
  if (changed.length) did.push(`changed ${changed.join(", ")}`);
  if (!r.config.exists || args.includes("--force") || fresh.length || changed.length) {
    mkdirSync(dirname(path), { recursive: true });
    if (r.config.exists) copyFileSync(path, `${path}.bak`);
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    did.push(`wrote ${path}${fresh.length ? ` with ${fresh.join(", ")}` : changed.length ? "" : " (no harness found yet: run `routr setup` again after installing one)"}`);
  } else skipped.push(`config ${path} already covers every harness found: kept as it is`);
  skipped.push(...leftOut);

  // 2. Claude Code's usage, which it reports only to its statusline. Someone else's statusline is never replaced.
  if (statuslineOffer && (choices ? choices.statusline === true : true)) {
    if (statuslineOffer.action === "write") {
      mkdirSync(dirname(claudeFile), { recursive: true });
      if (existsSync(claudeFile)) copyFileSync(claudeFile, `${claudeFile}.bak-before-routr`);
      writeFileSync(claudeFile, JSON.stringify(statuslineOffer.settings, null, 2) + "\n");
      did.push("set Claude Code's statusline to `routr statusline`: usage is read after your next Claude Code turn");
    } else if (statuslineOffer.action !== "none") skipped.push(`Claude statusline: ${statuslineOffer.why ?? "left alone"}`);
  } else if (statuslineOffer?.action === "write" && choices) skipped.push("Claude statusline left alone: Claude's usage is assumed, not read, until it is set (routr setup, menu: Claude Code's usage statusline)");
  // 3. Telemetry: off unless a person says yes. Asked once, default no; an agent's run never turns it on.
  if (!telemetryAsked && !envOff(env)) {
    if (choices?.telemetry !== undefined) {
      shareOn(choices.telemetry, path);
      (choices.telemetry ? did : skipped).push(choices.telemetry ? "telemetry on: anonymous outcomes, once a day (routr telemetry off to stop)" : "telemetry off (routr telemetry on, any time, to help tune routr)");
    } else skipped.push(choices ? "telemetry is off: routr telemetry on shares anonymous outcomes (docs/telemetry.md)" : "telemetry is off. Ask the user whether to share anonymous outcomes (docs/telemetry.md); if they say yes: routr telemetry on");
  }

  // Looked at again, not reused: this second look is what starts the first background usage reading (Cursor, Kiro)
  // for a subscription setup just configured, so a new install has a reading before its first dispatch.
  const after = await look({ configPath: path, quiet: true });
  const result = { ok: true, did, skipped, config: path, next_steps: after.next_steps };
  if (ui) {
    ui.note("Done", did.length ? did : ["nothing needed writing"]);
    if (skipped.length) ui.note("Notes", skipped, { dim: true });
    if (after.next_steps.length) ui.note("Still to do", after.next_steps.map((x, i) => `${i + 1}. ${x}`));
    ui.outro(`Change any setting later with routr setup, or ask your agent: every setting has a flag (routr setup --help).`);
    ui.close();
    return result;
  }
  if (args.includes("--json")) return result;
  say(`\n${did.map((d) => `${paint(32, "done")} ${d}`).concat(skipped.map((x) => `${paint(33, "note")} ${x}`)).join("\n")}\n\n${render(after)}`);
  if (!interactive && !args.includes("--yes") && !flagged) say("\nNot a terminal, so nothing was asked: suggestions were used. An agent changes a setting with a flag: routr setup --help lists them.");
  if (found.length && did.some((d) => d.startsWith("wrote"))) say(`\nYour settings are plain JSON at ${path}: ${Object.entries(config.subscriptions).map(([n, x]) => settingSummary(n, x)).join("; ")}. Change one any time: routr setup --yes --model <name>=<id> (or --effort, --hardest, --reserve, --use, --disable), or ask your agent.`);
  return result;
}
