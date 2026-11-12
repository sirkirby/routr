// `routr setup`: does what `routr doctor` says is missing. It writes the config for the harnesses found and (only for
// a person at a terminal) asks which decision model to use and for its key. It leaves Claude Code's settings alone: Claude's usage is read
// through its own `/usage` (usage.mjs), so routr no longer needs Claude's statusline slot. `--no-statusline` is
// still accepted, and does nothing, for scripts written for an older routr.
// A person gets questions; an agent passes `--yes` and the choices it settled with the user as flags. Same code, same file.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { COMMANDS } from "./command-table.mjs";
import { ACCOUNT_USE, CONFIG_PATH, isShare, loadConfig, SHARE_MAX, SUB_DEFAULTS, UPDATE_CHANNELS } from "./config.mjs";
import { LEVELS } from "./questions.mjs";
import { settingSummary } from "./wording.mjs";
import { envOff, setTelemetry } from "./telemetry.mjs";
import { inspect, paint, render, skillsIncomplete, skillsMissing, starterConfig } from "./doctor.mjs";
import { accountAt, accountName, accountSkillFolder, accountSkillFolders, HARNESSES, signIn, signInWhy } from "./harnesses.mjs";
import { setKey } from "./key.mjs";
import { standalone } from "./processes.mjs";
import { configDirOf, realOr, writeJsonAtomic } from "./state-files.mjs";
import { updatesOff } from "./update.mjs";
import { installSkill } from "./skill-install.mjs";
import { askDecision, decisionLabel, guided, takesSettings } from "./setup-guided.mjs";
import { decisionTarget, decisionTargets, decisionSettings, PROVIDER_NAMES, PROVIDERS } from "./providers.mjs";
import { secretsFor } from "./systemone.mjs";
import { CANCEL, createUI } from "./tui.mjs";
import { baseVersion, ROUTR_VERSION } from "./version.mjs";
import { newOtelConsent, otelEndpoint, otelStatus, otelSwitch, prepareOtel, startOtelSender } from "./otel.mjs";

const named = (name) => Object.hasOwn(HARNESSES, name) || Boolean(accountName(name));
const NAMES = `one of: ${Object.keys(HARNESSES).join(", ")}, or an extra account's name (<harness>-<name>)`;
// `--account claude-work=~/.claude-work`: another account of a harness, signed in from that folder (repeatable).
export function parseAccounts(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--account") continue;
    const at = (args[i + 1] ?? "").indexOf("="), name = (args[i + 1] ?? "").slice(0, Math.max(at, 0)), folder = (args[i + 1] ?? "").slice(at + 1), dir = configDirOf(folder);
    if (at < 1 || !accountName(name)) throw new Error(`--account takes <harness>-<name>=<folder>, on ${Object.keys(HARNESSES).filter((k) => HARNESSES[k].folder).map((k) => HARNESSES[k].label).join(" or ")} (claude-work=~/.claude-work): a-z, 0-9, - and _, 32 characters at most`);
    if (!dir) throw new Error(`--account ${name}=…: the folder must be a full path or one under ~/`);
    out[name] = { ...accountName(name), folder, dir };
  }
  return out;
}

// `--model claude=sonnet --model codex=<id>`: repeatable name=id pairs.
export function parseModels(args) {
  const models = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--model") continue;
    const [name, id] = (args[i + 1] ?? "").split("=");
    if (!named(name) || !id) throw new Error(`--model takes <subscription>=<model id>, with ${NAMES}`);
    models[name] = id;
  }
  return models;
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
    if (!named(name) || value == null) throw new Error(`${flag} takes <subscription>=${what}, with ${NAMES}`);
    out[name] = value;
  }
  return out;
}
export const parseHardest = (args) => parsePairs(args, "--hardest", parseLevel, "basic|standard|strong");
export const parseUse = (args) => parsePairs(args, "--use", (v) => ACCOUNT_USE.includes(v) ? v : null, "normal|fallback");
// `--share claude=3`: this account's weight in the launch ratio between eligible normal metered accounts (shares.mjs); `off` removes it.
export const parseLaunchShare = (args) => parsePairs(args, "--share", (v) => v === "off" ? "off" : /^\d+$/.test(v ?? "") && isShare(Number(v)) ? Number(v) : null, `<1-${SHARE_MAX}>|off`);
// `--effort codex=high`: the everyday effort there, checked against the harness's own levels once it is found.
export const parseEffort = (args) => parsePairs(args, "--effort", (v) => (/^[a-z]+$/i.test(v ?? "") ? v.toLowerCase() : null), "<level>");
// `--enable agy` / `--disable agy`: which subscriptions routr may hand work to. Turning one off keeps its settings.
export function parseSwitches(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--enable" && args[i] !== "--disable") continue;
    const name = args[i + 1];
    if (!named(name)) throw new Error(`${args[i]} takes a subscription name: ${NAMES}`);
    out[name] = args[i] === "--enable";
  }
  return out;
}
// `routr setup --show`: the settings as routr reads them, for an agent to see before it changes one. Asks no harness.
export function showSettings(path, opts = {}) {
  const { config, notes } = loadConfig(path);
  return { ok: true, config: path, exists: existsSync(path), ...config, otel: otelStatus(config, opts.env, opts), ...(notes.length ? { notes } : {}) };
}
export const parseReserve = (args) => parsePairs(args, "--reserve", parseShare, "<0..1, or a percent>");
// `--channel beta|stable`: which releases updates follow. A setting, not an update flag, so the daily update keeps it.
export function parseChannel(args) {
  const i = args.indexOf("--channel");
  if (i < 0) return undefined;
  if (!UPDATE_CHANNELS.includes(args[i + 1])) throw new Error(`--channel takes ${UPDATE_CHANNELS.join(" or ")}`);
  return args[i + 1];
}
// `--decision typesafe,cloudflare:clef-flash`: the ordered models that may read each brief. A provider
// alone takes its default model; a model must be one routr has measured there (providers.mjs).
export function parseDecision(args, warnings = []) {
  const i = args.indexOf("--decision");
  if (i < 0) return undefined;
  const entries = (args[i + 1] ?? "").split(",").map((part) => {
    const v = part.trim(), at = v.indexOf(":");
    return { provider: at < 0 ? v : v.slice(0, at), model: at < 0 ? null : v.slice(at + 1) || null };
  });
  const result = decisionSettings(entries), bad = result.problems.find((p) => p.code !== "duplicate");
  if (bad) throw new Error(`--decision takes <provider>[:<model>],... in order, with one of: ${PROVIDER_NAMES.join(", ")}. ${bad.why}`);
  warnings.push(...result.warnings);
  return decisionTargets({ decision: result.decision }, {}, { localLast: false }).map(({ provider, model }) => ({ provider, model }));
}
// What setup says after the channel changed. It runs no update and asks GitHub nothing, so it names no version.
// Nothing moves a pre-release back to stable by itself (update.mjs): a person leaving beta on one is told so.
// With automatic updates off, only `routr update` moves it, and the note says why they are off: `off` is updatesOff's
// answer (update.mjs, the one doctor shows too), null when they are on. Reading only the config said "the daily update
// does it" under ROUTR_NO_UPDATE and from a source checkout, where no daily update runs.
export function channelNote(channel, running = ROUTR_VERSION, isStandalone = standalone(), off = null) {
  const auto = !off, later = auto ? "; otherwise the daily update does it" : ` (automatic updates are off: ${off})`;
  if (channel === "beta") return `update channel: beta. \`routr update\` installs the newest beta, rc or stable release now${later}`;
  const pre = isStandalone && running.includes("-");
  return `update channel: stable. ${pre ? `You stay on ${running} until a stable release is newer; \`routr update --force\` installs the newest stable now${auto ? "" : later}` : `\`routr update\` installs the newest stable release now${later}`}`;
}

// `deps` are seams so a test can drive a whole run, questions and all, without a terminal, the machine's harnesses, the
// network, or the user's own files: what is installed (`inspect`), the person's answers (`question`, read line by line
// in the tui's accessible mode, or `ui`, a ready-made tui), each harness's effort levels (`efforts`), and each step that
// writes outside the config (the skill, the telemetry state, the key), and whether a provider's key is saved (`hasKey`).
export async function setup(args, { inspect: look = inspect, question, interactive: tty = Boolean(process.stdin.isTTY), env = process.env,
  install = installSkill, share: shareOn = setTelemetry, key = setKey, hasKey = (provider) => { try { secretsFor(provider, { env }); return true; } catch { return false; } }, print = console.log, efforts: levelsOf = (n, model) => HARNESSES[n].efforts?.(model), accountSignIn = (a) => signIn(a, { fresh: true }), ui: makeUI, isStandalone = standalone, otelStart = startOtelSender, otelHome, writeConfig = writeJsonAtomic } = {}) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fix") continue; // doctor --fix forwards its arguments here
    const option = COMMANDS.setup.flags.find((f) => f.name === args[i]);
    if (!option) return { ok: false, error: `Unknown setup flag or argument: ${args[i]}. See routr setup --help; account use is --use <name>=fallback or --use <name>=normal` };
    if (option.arg) i++;
  }
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const path = flag("--config") ?? CONFIG_PATH();
  const interactive = tty && !args.includes("--yes");
  const say = (s) => { if (!args.includes("--json")) print(s); };
  const did = [], skipped = [];
  const repairQueue = (config) => {
    if (!otelSwitch(config, {}).on) return;
    const problem = otelStatus(config, {}, { home: otelHome }).queue_error;
    if (prepareOtel({ home: otelHome })) { if (problem) did.push("repaired OpenTelemetry queue folders"); }
    else if (problem) skipped.push(problem);
  };
  let otelEndpointValue;
  const otelOff = args.includes("--otel-off"), otelSet = args.includes("--otel-endpoint");
  if (otelOff && otelSet) return { ok: false, error: "choose --otel-endpoint or --otel-off, not both" };
  if (otelSet) try { otelEndpointValue = otelEndpoint(flag("--otel-endpoint")); } catch (e) { return { ok: false, error: e.message }; }
  let models, hardest, reserves, efforts, switches, uses, launchShares, channel, decision, adds;
  try { adds = parseAccounts(args); models = parseModels(args); hardest = parseHardest(args); reserves = parseReserve(args); efforts = parseEffort(args); switches = parseSwitches(args); uses = parseUse(args); launchShares = parseLaunchShare(args); channel = parseChannel(args); decision = parseDecision(args, skipped); } catch (e) { return { ok: false, error: e.message }; }
  // Whether any setting flag was given, read once here, before a guided run adds its choices to the same maps.
  const flagged = Object.keys({ ...adds, ...models, ...hardest, ...reserves, ...efforts, ...switches, ...uses, ...launchShares }).length > 0 || channel !== undefined || decision !== undefined || otelSet || otelOff;
  // --show only reads: with a change flag beside it, an agent could take the settings printed for the change made.
  if (args.includes("--show")) return flagged || args.includes("--force")
    ? { ok: false, error: "--show only reads your settings: run the change without it, then --show again to see it" } : showSettings(path, { home: otelHome, env });

  const guidedRun = interactive && !flagged;
  // Scripted answers (a test, or a caller with its own line reader) drive the tui's accessible mode: numbered questions.
  const ui = !guidedRun ? null : makeUI ? makeUI() : question ? createUI({ ask: question, accessible: true, output: { write: (t) => print(t.replace(/\n$/, "")) } }) : createUI();
  let r;
  if (ui) {
    ui.intro("routr setup");
    const spin = ui.spinner("Checking your harnesses, their sign-in, and your decision model");
    r = await look({ configPath: path, quiet: true });
    const ready = Object.keys(r.harnesses).filter((n) => r.harnesses[n].installed && r.harnesses[n].signed_in);
    spin.stop(`${ready.length} signed in (${ready.join(", ") || "none"}) · decision model ${r.decision.some((k) => k.works) ? "answers" : "not answering yet"}`);
  } else {
    say("Looking at what is installed…");
    r = await look({ configPath: path, quiet: args.includes("--json") });
  }
  // Only a harness that is installed AND signed in, or has an extra account that is (takesSettings), can be set up:
  // one signed out gets no work until the user signs in.
  const found = Object.keys(r.harnesses).filter((n) => takesSettings(r, n));
  // Installed but not signed in, and not set up (--force sets up nothing that was): said in every kind of run (--json
  // too), so an agent can tell the person.
  const kept = args.includes("--force") ? [] : r.config.subscriptions;
  const leftOut = Object.keys(r.harnesses).filter((n) => r.harnesses[n].installed && !found.includes(n) && !kept.includes(n))
    .map((n) => `${HARNESSES[n]?.label ?? n} left out: ${r.harnesses[n].sign_in}, then routr setup again`);
  // An extra account: one this run adds must be on an installed harness and signed in from its folder, as a harness
  // must be; routr says what to run and never signs in. A setting named for one is for an account the config has, or
  // one added now. From here on a flag's name is checked as its harness (`of`).
  const isAccount = (n) => !Object.hasOwn(HARNESSES, n), of = (n) => (isAccount(n) ? accountName(n).harness : n);
  // Why an account cannot be added, or null: the same check for a flag and for the guided flow (`again`: what to do
  // once the folder is signed in).
  // `pending`: accounts the guided flow has accepted in this run, not yet written: a later one may not take their folder.
  const pending = {};
  const cannotAdd = async (n, a, again) => {
    if (!r.harnesses[a.harness]?.installed) return `\`${HARNESSES[a.harness].executable}\` was not found on this machine`;
    if (r.config.subscriptions.includes(n) && r.accounts?.[n] === undefined) return `${n} is already a subscription of its own in your config`;
    // One folder is one account: the config loader would leave a second name on it out, so it is refused here.
    const same = [...Object.entries(loadConfig(path).config.subscriptions).filter(([, x]) => x.harness === a.harness).map(([x, v]) => [x, v.config_dir]), ...Object.entries({ ...adds, ...pending }).filter(([, x]) => x.harness === a.harness).map(([x, v]) => [x, v.dir])]
      .find(([x, dir]) => x !== n && realOr(dir) === realOr(a.dir));
    if (same) return `its folder is ${same[0]}'s too, and one folder is one account`;
    const account = accountAt(n, a.harness, a.dir), { state } = await accountSignIn(account);
    return state === "yes" ? null : `${signInWhy(account, state)}, then ${again}`;
  };
  for (const [n, a] of Object.entries(adds)) { const why = await cannotAdd(n, a, `routr setup --account ${n}=${a.folder} again`); if (why) return { ok: false, error: `--account ${n}=…: ${why}` }; }
  const known = (n) => !isAccount(n) || Object.hasOwn(adds, n) || r.accounts?.[n] !== undefined;
  for (const [flagName, set] of [["--model", models], ["--effort", efforts], ["--hardest", hardest], ["--reserve", reserves], ["--use", uses], ["--share", launchShares], ["--enable/--disable", switches]])
    for (const n of Object.keys(set)) if (!known(n)) return { ok: false, error: `${flagName} ${n}: ${n} is not an account in your config; add it first: routr setup --account ${n}=<folder>` };
  for (const [n, id] of Object.entries(models)) {
    if (isAccount(n)) { const list = r.harnesses[of(n)]?.models; if (list?.length && !list.includes(id) && !HARNESSES[of(n)].openList) return { ok: false, error: `--model ${n}=${id}: not in the harness's current list (${list.join(", ")})` }; continue; }
    if (!found.includes(n)) return { ok: false, error: `--model ${n}=…: ${r.harnesses[n]?.installed ? r.harnesses[n].sign_in : `\`${HARNESSES[n].executable}\` was not found on this machine`}` };
    const list = r.harnesses[n].models;
    if (list?.length && !list.includes(id) && !HARNESSES[n].openList) return { ok: false, error: `--model ${n}=${id}: not in the harness's current list (${list.join(", ")})` };
  }
  for (const [flagName, set] of [["--hardest", hardest], ["--reserve", reserves], ["--use", uses], ["--share", launchShares]])
    for (const n of Object.keys(set)) if (!isAccount(n) && !found.includes(n) && !r.config.subscriptions.includes(n)) return { ok: false, error: `${flagName} ${n}=…: ${n} is not configured and ${r.harnesses[n]?.installed ? r.harnesses[n].sign_in : `\`${HARNESSES[n].executable}\` was not found on this machine`}` };
  for (const [n, on] of Object.entries(switches)) {
    // An extra account is turned on only once it is signed in, as a harness is; one added now was just checked.
    if (isAccount(n)) { if (on && r.accounts?.[n]?.signed_in === false) return { ok: false, error: `--enable ${n}: ${r.accounts[n].sign_in}` }; continue; }
    // Set up, it keeps its settings on or off; one turned off is turned on again only once it is signed in.
    if (r.config.subscriptions.includes(n) && (!on || found.includes(n) || !r.config.off?.includes(n))) continue;
    // A harness found now is added in this run, so it can be added turned off ("set up, but keep agy off").
    if (!on && !found.includes(n)) return { ok: false, error: `--disable ${n}: ${n} is not set up in routr, so there is nothing to turn off` };
    if (!found.includes(n)) return { ok: false, error: `--enable ${n}: ${r.harnesses[n]?.installed ? r.harnesses[n].sign_in : `\`${HARNESSES[n].executable}\` was not found on this machine`}` };
  }
  // An effort must be one the harness takes for the model it will run: the one given now, or the one already set.
  let current = {}; try { current = JSON.parse(readFileSync(path, "utf8")).subscriptions ?? {}; } catch {}
  for (const [n, level] of Object.entries(efforts)) {
    if (!HARNESSES[of(n)].effort) return { ok: false, error: `--effort ${n}=…: ${HARNESSES[of(n)].noEffort}` };
    if (isAccount(n)) { const own = current[of(n)]?.accounts?.[accountName(n).short], // its own model, none included (null), else its harness's
      model = models[n] !== undefined ? models[n] : own && typeof own === "object" && own.default_model !== undefined ? own.default_model : models[of(n)] ?? current[of(n)]?.default_model, levels = await levelsOf(of(n), model);
      if (levels?.length && !levels.includes(level)) return { ok: false, error: `--effort ${n}=${level}: ${HARNESSES[of(n)].label} takes ${levels.join(", ")}${model ? ` for ${model}` : ""}` }; continue; }
    if (!found.includes(n) && !r.config.subscriptions.includes(n)) return { ok: false, error: `--effort ${n}=…: ${n} is not configured and ${r.harnesses[n]?.installed ? r.harnesses[n].sign_in : `\`${HARNESSES[n].executable}\` was not found on this machine`}` };
    const levels = found.includes(n) ? await levelsOf(n, models[n] ?? current[n]?.default_model) : null;
    if (levels?.length && !levels.includes(level)) return { ok: false, error: `--effort ${n}=${level}: ${HARNESSES[n].label} takes ${levels.join(", ")}${models[n] ?? current[n]?.default_model ? ` for ${models[n] ?? current[n]?.default_model}` : ""}` };
  }
  // The skills agents read (routr, and routr-orchestrate): one missing or incomplete, or left behind by an older routr.
  // Writing them again is always safe, and it is done whatever the person chose, since it is not a setting. From a
  // source checkout (0.0.0-dev) a release's skill never matches, and rewriting it would fight the installed binary: a
  // release's skills already there are left alone, and the person is told what to run instead.
  const skillStep = () => {
    const base = baseVersion(ROUTR_VERSION), ours = r.skill.filter((k) => k.ours !== false);
    const gaps = [...skillsMissing(r).map((n) => `${n} is missing`), ...skillsIncomplete(r).map((k) => `${k.where} lacks ${k.missing.join(", ")}`)];
    // An account added in this run has no link in its folder yet: the same step makes it.
    if (!gaps.length && !Object.keys(adds).length && !(isStandalone() && ours.some((k) => baseVersion(k.version) !== base))) return false;
    if (!isStandalone() && ours.some((k) => baseVersion(k.version) !== base)) {
      skipped.push(`routr's skills need repair (${gaps.join("; ")}), but this routr runs from a source checkout and the installed skills come from a release: run the installed routr's \`routr skill install\` (usually ~/.local/bin/routr skill install)`);
      return false;
    }
    // Only what was installed is said; a step that failed makes the whole run unsuccessful (`failure` below).
    // Each extra account's skills folder is a place like a harness's own: those in the config, and those added now.
    const places = [...accountSkillFolders(loadConfig(path).config), ...Object.entries(adds).flatMap(([n, a]) => accountSkillFolder(n, a.harness, a.dir))];
    const out = install({ accounts: places.filter((x, i) => places.findIndex((y) => y.path === x.path) === i) }), failed = out?.failed ?? [];
    if (!failed.length) did.push(`installed the routr skills ${base} for your agents`);
    else if (out.installed?.length) did.push(`installed the routr skills ${base} at ${out.installed.map((x) => x.where).join(", ")}`);
    skillFailures.push(...failed.map((f) => `${f.where}: ${f.error}`));
    for (const k of out?.kept ?? []) skipped.push(`${k.where}: ${k.why}`);
    return true;
  };
  const skillFailures = [];
  const failure = () => (skillFailures.length ? { ok: false, error: `routr's skills were not fully installed (${skillFailures.join("; ")}): fix that, then run routr skill install`, failed: skillFailures } : {});
  // A person at a terminal gets the guided flow; flags and --yes (an agent) never ask anything.
  let config = null;
  if (r.config.exists && !args.includes("--force")) { try { config = JSON.parse(readFileSync(path, "utf8")); } catch { return { ok: false, error: `${path} is not valid JSON. Fix it, or rewrite it with: routr setup --force` }; } }
  let telemetryAsked = false;
  try { telemetryAsked = "telemetry" in JSON.parse(readFileSync(path, "utf8")); } catch {}
  let choices = null;
  // A provider's key, typed by the person (never passed by an agent), when the provider chosen has none yet; for a local
  // one, whether it is ready. Once per provider in a run: a model changed on the same provider asks nothing again.
  const handled = new Set();
  // Stopping before the review writes no settings; a key typed on the way was saved when it was typed, and is said.
  const stopped = () => { const kept = did.filter((d) => d.startsWith("saved the")); const said = `setup stopped: your settings were not changed${kept.length ? ` (${kept.join("; ")})` : ", and nothing was written"}`;
    ui.cancel(said[0].toUpperCase() + said.slice(1) + "."); ui.close(); return { ok: false, cancelled: true, error: said, did, skipped }; };
  const keyFor = async ({ provider, model }) => {
    const P = PROVIDERS[provider];
    const once = P.local ? `${provider}:${model}` : provider; // a key per provider; a local model's readiness per model
    if (handled.has(once)) return;
    handled.add(once);
    if (P.local) { const not = await P.ready(model, env); ui.note(P.label, [not ? `Runs on this machine: no key. ${not}` : `${model} is pulled and Ollama is running: nothing more to do.`]); return; }
    // The provider doctor just tried and found failing is asked again even with a key saved (one revoked, or mistyped).
    if (!r.decision.some((k) => k.provider === provider && !k.works) && hasKey(provider)) return;
    ui.note(`${P.label} key`, [`routr asks the decision model about each piece of work: it needs your ${P.label} key.`, P.get]);
    const k = await key({ provider });
    (k.ok ? did : skipped).push(k.ok ? `saved the ${P.label} key to ${k.file}${k.works ? " and it works" : `: ${k.error}`}` : `${P.label} key not saved: ${k.error}. Run \`routr key set ${provider}\` when you have it`);
  };
  if (ui && !flagged) {
    // The decision model first, and its key: nothing routr advises works without one.
    if (!r.decision.some((k) => k.works)) {
      ui.note("Decision model", ["routr asks a small decision model about each piece of work. TypeSafe's Jev needs a TypeSafe key;", "Cloudflare's Clef runs on your Cloudflare account, or free on this machine through Ollama."]);
      const d = await askDecision(ui, decisionTargets(config ? loadConfig(path).config : null, {}));
      if (d === CANCEL) { return stopped(); }
      if (Array.isArray(d)) { decision = d; for (const entry of d) await keyFor(entry); }
    }
    choices = await guided({ ui, r, config, efforts: levelsOf, telemetry: !telemetryAsked && !envOff(env), decided: decision ?? null,
      addAccount: async (n, folder) => { const a = { ...accountName(n), folder, dir: configDirOf(folder) }, why = await cannotAdd(n, a, "add it here again"); if (!why) pending[n] = a; return why; } });
    if (choices === CANCEL) { return stopped(); }
    if (!choices.write) {
      repairQueue(config);
      if (skillStep()) { if (did.length) ui.note("Done", did); if (skillFailures.length) ui.note("Failed", skillFailures); }
      ui.outro("Your settings did not change."); ui.close();
      return { ok: true, did, skipped: [...skipped, ...leftOut, "nothing changed"], config: path, next_steps: r.next_steps, ...failure() };
    }
    for (const [n, folder] of Object.entries(choices.accounts ?? {})) adds[n] = { ...accountName(n), folder, dir: configDirOf(folder) };
    Object.assign(models, choices.models); Object.assign(efforts, choices.efforts); Object.assign(hardest, choices.hardest);
    Object.assign(reserves, choices.reserves); Object.assign(switches, choices.switches);
    Object.assign(uses, choices.uses);
    Object.assign(launchShares, choices.shares);
    if (choices.channel) channel = choices.channel;
    if (choices.otelEndpoint !== undefined) otelEndpointValue = choices.otelEndpoint;
    if (choices.decision) { decision = choices.decision; for (const entry of decision) await keyFor(entry); }
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
  let old = null; try { old = JSON.parse(readFileSync(path, "utf8")); } catch {}
  // --force rewrites the file from the suggestions, but keeps the person's own choices: telemetry, automatic updates
  // and their channel, the decision model, and which subscriptions are turned off.
  if (!config) {
    config = { ...starterConfig(found, models), ...(typeof old?.telemetry === "boolean" ? { telemetry: old.telemetry } : {}), ...(typeof old?.auto_update === "boolean" ? { auto_update: old.auto_update } : {}),
      ...(UPDATE_CHANNELS.includes(old?.update_channel) ? { update_channel: old.update_channel } : {}), ...(old?.decision ? { decision: old.decision } : {}), ...(old?.otel ? { otel: old.otel } : {}),
      // A sure_at the person set is theirs; 0.8 was Jev's, written by an older setup, and now follows the model.
      ...(typeof old?.sure_at === "number" && old.sure_at !== 0.8 ? { sure_at: old.sure_at } : {}) };
    if (old?.sure_at === 0.8) did.push(`dropped sure_at 0.8, an older setup's default: it now follows the decision model (if you chose 0.8 yourself, put "sure_at": 0.8 back in ${path})`);
    for (const [n, s] of Object.entries(old?.subscriptions ?? {})) if (config.subscriptions[n]) {
      if (s?.enabled === false) config.subscriptions[n].enabled = false;
      // A rebuild must not silently change where the person permits routine spending.
      for (const k of ["use", "billing", "share", "accounts"]) if (s?.[k] !== undefined) config.subscriptions[n][k] = s[k];
    }
    // Nor drop the extra accounts written under a harness this rebuild did not find: its entry stays as it was.
    for (const [n, s] of Object.entries(old?.subscriptions ?? {})) if (!config.subscriptions[n] && s?.accounts != null) config.subscriptions[n] = s;
  }
  else for (const n of fresh) config.subscriptions = { ...config.subscriptions, [n]: starterConfig([n], models).subscriptions[n] };
  // Then every choice onto its subscription, new or old; what changed on an old one is said.
  const changed = [];
  const otelChanged = otelOff || otelEndpointValue !== undefined;
  if (otelChanged) {
    if (otelOff) delete config.otel;
    else config.otel = { endpoint: otelEndpointValue, consent: newOtelConsent() };
    changed.push(`OpenTelemetry export ${otelOff ? "off" : "on"}`);
  }
  // The accounts this run adds, under their harness's entry: a new one as its folder, one already there pointed at the
  // folder given, its own settings kept. A harness with no entry yet (signed out on its own) gets the suggested one.
  for (const [n, a] of Object.entries(adds)) {
    if (!config.subscriptions[a.harness]) config.subscriptions[a.harness] = starterConfig([a.harness], models).subscriptions[a.harness];
    const list = (config.subscriptions[a.harness].accounts ??= {}), was = list[a.short];
    if (was && typeof was === "object") { if (was.folder !== a.folder) { changed.push(`${n}'s folder ${JSON.stringify(was.folder)} → ${JSON.stringify(a.folder)}`); was.folder = a.folder; } }
    else if (was !== a.folder) { changed.push(was === undefined ? `added ${n}, signed in from ${a.folder}, with ${HARNESSES[a.harness].label}'s settings` : `${n}'s folder ${JSON.stringify(was)} → ${JSON.stringify(a.folder)}`); list[a.short] = a.folder; }
  }
  // Where a subscription's settings are written: its own entry, or for an extra account its entry under its harness's
  // `accounts`, written as its folder alone until it has a setting of its own.
  const entryOf = (n, write) => {
    if (!isAccount(n)) return config.subscriptions[n];
    const a = accountName(n), list = config.subscriptions[a.harness]?.accounts;
    if (!list || list[a.short] === undefined) return null;
    if (typeof list[a.short] === "string") { if (!write) return {}; list[a.short] = { folder: list[a.short] }; }
    return list[a.short];
  };
  const put = (n, k, v) => {
    if (!entryOf(n) || v === undefined || entryOf(n)[k] === v) return;
    if (v === null && entryOf(n)[k] === undefined && isAccount(n) && config.subscriptions[of(n)]?.[k] == null) return; // none already, as its harness
    const sub = entryOf(n, true);
    if (!fresh.includes(n) && r.config.exists && !args.includes("--force")) changed.push(`${n}.${k} ${sub[k] === undefined ? "set to" : `${JSON.stringify(sub[k])} →`} ${JSON.stringify(v)}`);
    // Nothing of its own: the key goes. For an account whose harness has that setting, null is written, which is how
    // it has none where its harness has one (config.mjs).
    if (v === null && !(isAccount(n) && config.subscriptions[of(n)]?.[k] != null)) delete sub[k]; else sub[k] = v;
  };
  for (const [n, s] of Object.entries(settings)) { put(n, "hardest_work", s.hardest_work); put(n, "reserve", s.reserve); }
  for (const [n, id] of Object.entries(models)) put(n, "default_model", id);
  for (const [n, level] of Object.entries(efforts)) put(n, "default_effort", level);
  // A new model may not take the effort already set: it is reset to one it takes (medium where it can), and said.
  for (const [n, id] of Object.entries(models)) {
    const sub = entryOf(n);
    if (!id || efforts[n] || !sub?.default_effort || !HARNESSES[of(n)].effort) continue;
    const levels = await levelsOf(of(n), id);
    if (!levels?.length || levels.includes(sub.default_effort)) continue;
    const to = levels.includes("medium") ? "medium" : levels[0];
    changed.push(`${n}.default_effort ${JSON.stringify(sub.default_effort)} → ${JSON.stringify(to)} (${id} does not take ${sub.default_effort})`);
    sub.default_effort = to;
  }
  for (const [n, on] of Object.entries(switches)) put(n, "enabled", on);
  for (const [n, use] of Object.entries(uses)) put(n, "use", use);
  for (const [n, w] of Object.entries(launchShares)) if (w !== "off" || entryOf(n)?.share !== undefined || (isAccount(n) && config.subscriptions[of(n)]?.share != null)) put(n, "share", w === "off" ? null : w);
  // The update channel is one setting for the whole file. An invalid value reads as stable, so it is replaced either way.
  // Asking for the channel already in effect writes nothing, unless the file holds a value routr cannot read.
  const channelWas = UPDATE_CHANNELS.includes(config.update_channel) ? config.update_channel : "stable";
  const channelMoved = channel !== undefined && channel !== channelWas;
  if (channelMoved || (channel !== undefined && config.update_channel !== undefined && config.update_channel !== channel)) {
    if (r.config.exists && !args.includes("--force")) changed.push(`update_channel ${config.update_channel === undefined ? "set to" : `${JSON.stringify(config.update_channel)} →`} ${JSON.stringify(channel)}`);
    config.update_channel = channel;
  }
  // Default model pins follow routr's measured registry; an explicitly different model keeps its name.
  if (decision) {
    const checked = decisionSettings(config.decision);
    const was = decisionTargets({ decision: checked.decision }, {}, { localLast: false });
    const moved = decisionLabel(was) !== decisionLabel(decision);
    const entries = decision.map(({ provider, model }) => ({ provider, model: model === decisionTarget({ decision: { provider } }, {}).model ? null : model }));
    if (moved || checked.problems.length) {
      if (r.config.exists && !args.includes("--force")) changed.push(moved ? `decision ${decisionLabel(was)} → ${decisionLabel(decision)}`
        : `decision file to remove ${checked.problems.length} dropped ${checked.problems.length === 1 ? "entry" : "entries"} (effective list stays ${decisionLabel(was)})`);
      config.decision = entries;
      if (moved && config.sure_at === 0.8) { delete config.sure_at; changed.push("sure_at 0.8 removed: it now follows the decision model"); }
      for (const { provider, model } of decision) {
        const P = PROVIDERS[provider];
        if (!ui && !P.local && !hasKey(provider)) skipped.push(`${P.label} needs its key: the user runs routr key set ${provider} in their own terminal`);
        if (!ui && P.local) { const not = await P.ready(model, env); if (not) skipped.push(`${P.label}: ${not} (a download of more than 10 GB: ask the user first)`); }
      }
    }
  }
  for (const [n, sub] of Object.entries(config.subscriptions ?? {})) for (const key of ["metered_rank", "assumed_headroom"]) if (sub?.[key] !== undefined) {
    delete sub[key]; changed.push(`${n}.${key} removed (no longer used)${key === "metered_rank" ? `; this seat now takes everyday work unless --use ${n}=fallback is set` : ""}`);
  }
  if (changed.length) did.push(`changed ${changed.join(", ")}`);
  if (!r.config.exists || args.includes("--force") || fresh.length || changed.length) {
    if (r.config.exists) copyFileSync(path, `${path}.bak`);
    writeConfig(path, config, { indent: 2, preserveOnError: true, userFile: true }); // Never expose a missing-config window to the sender.
    did.push(`wrote ${path}${fresh.length ? ` with ${fresh.join(", ")}` : changed.length ? "" : " (no harness found yet: run `routr setup` again after installing one)"}`);
  } else skipped.push(`config ${path} already covers every harness found: kept as it is`);
  repairQueue(config);
  if (otelChanged) {
    otelStart({ home: otelHome, configPath: path }); // Only the sender removes old-consent files, including on off
  }
  if (channelMoved) did.push(channelNote(channel, ROUTR_VERSION, isStandalone(), updatesOff(config, { isStandalone, env }))); // what happens next; setup itself updates nothing
  skipped.push(...leftOut);

  // 2. Telemetry: off unless a person says yes. Asked once, default no; an agent's run never turns it on.
  if (!telemetryAsked && !envOff(env)) {
    if (choices?.telemetry !== undefined) {
      shareOn(choices.telemetry, path);
      (choices.telemetry ? did : skipped).push(choices.telemetry ? "telemetry on: anonymous outcomes, once a day (routr telemetry off to stop)" : "telemetry off (routr telemetry on, any time, to help tune routr)");
    } else skipped.push(choices ? "telemetry is off: routr telemetry on shares anonymous outcomes (docs/telemetry.md)" : "telemetry is off. Ask the user whether to share anonymous outcomes (docs/telemetry.md); if they say yes: routr telemetry on");
  }

  // Looked at again, not reused: this second look is what starts the first background usage reading (Cursor, Kiro)
  // for a subscription setup just configured, so a new install has a reading before its first dispatch.
  const after = await look({ configPath: path, quiet: true });
  const result = { ok: true, did, skipped, config: path, next_steps: after.next_steps, ...failure() };
  if (ui) {
    ui.note("Done", did.length ? did : ["nothing needed writing"]);
    if (skipped.length) ui.note("Notes", skipped, { dim: true });
    if (skillFailures.length) ui.note("Failed", skillFailures);
    if (after.next_steps.length) ui.note("Still to do", after.next_steps.map((x, i) => `${i + 1}. ${x}`));
    ui.outro(`Change any setting later with routr setup, or ask your agent: every setting has a flag (routr setup --help).`);
    ui.close();
    return result;
  }
  if (args.includes("--json")) return result;
  say(`\n${did.map((d) => `${paint(32, "done")} ${d}`).concat(skipped.map((x) => `${paint(33, "note")} ${x}`)).join("\n")}\n\n${render(after)}`);
  if (!interactive && !args.includes("--yes") && !flagged) say("\nNot a terminal, so nothing was asked: suggestions were used. An agent changes a setting with a flag: routr setup --help lists them.");
  if (found.length && did.some((d) => d.startsWith("wrote"))) say(`\nYour settings are plain JSON at ${path}: ${Object.entries(config.subscriptions).map(([n, x]) => settingSummary(n, x)).join("; ")}. Change one any time: routr setup --yes --model <name>=<id> (or --effort, --hardest, --reserve, --use, --share, --disable, --channel, --decision), or ask your agent.`);
  return result;
}
