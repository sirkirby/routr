// `routr setup`: does what `routr doctor` says is missing. It writes the config for the harnesses found and (only for
// a person at a terminal) asks which decision model to use and for its key. It leaves Claude Code's settings alone: Claude's usage is read
// through its own `/usage` (usage.mjs), so routr no longer needs Claude's statusline slot. `--no-statusline` is
// still accepted, and does nothing, for scripts written for an older routr.
// A person gets questions; an agent passes `--yes` and the choices it settled with the user as flags. Same code, same file.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { ACCOUNT_USE, CONFIG_PATH, loadConfig, SUB_DEFAULTS, UPDATE_CHANNELS } from "./config.mjs";
import { LEVELS } from "./questions.mjs";
import { settingSummary } from "./wording.mjs";
import { envOff, setTelemetry } from "./telemetry.mjs";
import { inspect, paint, render, skillsIncomplete, skillsMissing, starterConfig } from "./doctor.mjs";
import { HARNESSES } from "./harnesses.mjs";
import { setKey } from "./key.mjs";
import { standalone, writeJsonAtomic } from "./runtime.mjs";
import { updatesOff } from "./update.mjs";
import { installSkill } from "./skill-install.mjs";
import { askDecision, decisionLabel, guided } from "./setup-guided.mjs";
import { decisionTarget, decisionTargets, decisionSettings, PROVIDER_NAMES, PROVIDERS } from "./providers.mjs";
import { secretsFor } from "./systemone.mjs";
import { CANCEL, createUI } from "./tui.mjs";
import { baseVersion, ROUTR_VERSION } from "./version.mjs";
import { newOtelConsent, otelEndpoint, otelStatus, otelSwitch, prepareOtel, startOtelSender } from "./otel.mjs";

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

// Where each newly written pool that reads as metered goes in the ranking. `ask(name, note)` is the terminal question
// (absent under --yes, where the default stands); an answer starting with "w" means with, anything else after.
export async function meteredRanks(fresh, harnesses, ranks, ask) {
  for (const n of fresh) {
    if (harnesses[n]?.usage_class !== "metered" || ranks[n]) continue;
    ranks[n] = ask ? (/^w/i.test((await ask(n, harnesses[n].usage_note)).trim()) ? "with" : "after") : "after";
  }
  return ranks;
}

// `deps` are seams so a test can drive a whole run, questions and all, without a terminal, the machine's harnesses, the
// network, or the user's own files: what is installed (`inspect`), the person's answers (`question`, read line by line
// in the tui's accessible mode, or `ui`, a ready-made tui), each harness's effort levels (`efforts`), and each step that
// writes outside the config (the skill, the telemetry state, the key), and whether a provider's key is saved (`hasKey`).
export async function setup(args, { inspect: look = inspect, question, interactive: tty = Boolean(process.stdin.isTTY), env = process.env,
  install = installSkill, share: shareOn = setTelemetry, key = setKey, hasKey = (provider) => { try { secretsFor(provider, { env }); return true; } catch { return false; } }, print = console.log, efforts: levelsOf = (n, model) => HARNESSES[n].efforts?.(model), ui: makeUI, isStandalone = standalone, otelStart = startOtelSender, otelHome, writeConfig = writeJsonAtomic } = {}) {
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const path = flag("--config") ?? CONFIG_PATH;
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
  let models, ranks, hardest, reserves, efforts, switches, uses, channel, decision;
  try { models = parseModels(args); ranks = parseMetered(args); hardest = parseHardest(args); reserves = parseReserve(args); efforts = parseEffort(args); switches = parseSwitches(args); uses = parseUse(args); channel = parseChannel(args); decision = parseDecision(args, skipped); } catch (e) { return { ok: false, error: e.message }; }
  // The legacy flag remains a setter; explicit --use wins when both flags name the same account.
  uses = { ...Object.fromEntries(Object.entries(ranks).map(([n, rank]) => [n, rank === "with" ? "normal" : "fallback"])), ...uses };
  // Whether any setting flag was given, read once here, before a guided run adds its choices to the same maps.
  const flagged = Object.keys({ ...models, ...ranks, ...hardest, ...reserves, ...efforts, ...switches, ...uses }).length > 0 || channel !== undefined || decision !== undefined || otelSet || otelOff;
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
  // The skills agents read (routr, and routr-orchestrate): one missing or incomplete, or left behind by an older routr.
  // Writing them again is always safe, and it is done whatever the person chose, since it is not a setting. From a
  // source checkout (0.0.0-dev) a release's skill never matches, and rewriting it would fight the installed binary: a
  // release's skills already there are left alone, and the person is told what to run instead.
  const skillStep = () => {
    const base = baseVersion(ROUTR_VERSION), ours = r.skill.filter((k) => k.ours !== false);
    const gaps = [...skillsMissing(r).map((n) => `${n} is missing`), ...skillsIncomplete(r).map((k) => `${k.where} lacks ${k.missing.join(", ")}`)];
    if (!gaps.length && !(isStandalone() && ours.some((k) => baseVersion(k.version) !== base))) return false;
    if (!isStandalone() && ours.some((k) => baseVersion(k.version) !== base)) {
      skipped.push(`routr's skills need repair (${gaps.join("; ")}), but this routr runs from a source checkout and the installed skills come from a release: run the installed routr's \`routr skill install\` (usually ~/.local/bin/routr skill install)`);
      return false;
    }
    // Only what was installed is said; a step that failed makes the whole run unsuccessful (`failure` below).
    const out = install(), failed = out?.failed ?? [];
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
    choices = await guided({ ui, r, config, efforts: levelsOf, telemetry: !telemetryAsked && !envOff(env), decided: decision ?? null });
    if (choices === CANCEL) { return stopped(); }
    if (!choices.write) {
      repairQueue(config);
      if (skillStep()) { if (did.length) ui.note("Done", did); if (skillFailures.length) ui.note("Failed", skillFailures); }
      ui.outro("Your settings did not change."); ui.close();
      return { ok: true, did, skipped: [...skipped, ...leftOut, "nothing changed"], config: path, next_steps: r.next_steps, ...failure() };
    }
    Object.assign(models, choices.models); Object.assign(efforts, choices.efforts); Object.assign(hardest, choices.hardest);
    Object.assign(reserves, choices.reserves); Object.assign(switches, choices.switches); Object.assign(ranks, choices.ranks);
    Object.assign(uses, choices.uses);
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
  // Fresh metered accounts keep the legacy fallback default until the person chooses normal use.
  let old = null; try { old = JSON.parse(readFileSync(path, "utf8")); } catch {}
  await meteredRanks(fresh.filter((n) => !old?.subscriptions?.[n]?.metered_rank), r.harnesses, ranks, null);
  // --force rewrites the file from the suggestions, but keeps the person's own choices: telemetry, automatic updates
  // and their channel, the decision model, and which subscriptions are turned off.
  if (!config) {
    config = { ...starterConfig(found, models, ranks), ...(typeof old?.telemetry === "boolean" ? { telemetry: old.telemetry } : {}), ...(typeof old?.auto_update === "boolean" ? { auto_update: old.auto_update } : {}),
      ...(UPDATE_CHANNELS.includes(old?.update_channel) ? { update_channel: old.update_channel } : {}), ...(old?.decision ? { decision: old.decision } : {}), ...(old?.otel ? { otel: old.otel } : {}),
      // A sure_at the person set is theirs; 0.8 was Jev's, written by an older setup, and now follows the model.
      ...(typeof old?.sure_at === "number" && old.sure_at !== 0.8 ? { sure_at: old.sure_at } : {}) };
    if (old?.sure_at === 0.8) did.push(`dropped sure_at 0.8, an older setup's default: it now follows the decision model (if you chose 0.8 yourself, put "sure_at": 0.8 back in ${path})`);
    for (const [n, s] of Object.entries(old?.subscriptions ?? {})) if (config.subscriptions[n]) {
      if (s?.enabled === false) config.subscriptions[n].enabled = false;
      // A rebuild must not silently change where the person permits routine spending.
      for (const k of ["use", "metered_rank", "billing"]) if (s?.[k] !== undefined) config.subscriptions[n][k] = s[k];
    }
  }
  else for (const n of fresh) config.subscriptions = { ...config.subscriptions, [n]: starterConfig([n], models, ranks).subscriptions[n] };
  // Then every choice onto its subscription, new or old; what changed on an old one is said.
  const changed = [];
  const otelChanged = otelOff || otelEndpointValue !== undefined;
  if (otelChanged) {
    if (otelOff) delete config.otel;
    else config.otel = { endpoint: otelEndpointValue, consent: newOtelConsent() };
    changed.push(`OpenTelemetry export ${otelOff ? "off" : "on"}`);
  }
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
  if (changed.length) did.push(`changed ${changed.join(", ")}`);
  if (!r.config.exists || args.includes("--force") || fresh.length || changed.length) {
    if (r.config.exists) copyFileSync(path, `${path}.bak`);
    writeConfig(path, config, { indent: 2, preserveOnError: true }); // Review 3: never expose a missing-config window to the sender.
    did.push(`wrote ${path}${fresh.length ? ` with ${fresh.join(", ")}` : changed.length ? "" : " (no harness found yet: run `routr setup` again after installing one)"}`);
  } else skipped.push(`config ${path} already covers every harness found: kept as it is`);
  repairQueue(config);
  if (otelChanged) {
    otelStart({ home: otelHome, configPath: path }); // V4: only the sender removes old-consent files, including on off
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
  if (found.length && did.some((d) => d.startsWith("wrote"))) say(`\nYour settings are plain JSON at ${path}: ${Object.entries(config.subscriptions).map(([n, x]) => settingSummary(n, x)).join("; ")}. Change one any time: routr setup --yes --model <name>=<id> (or --effort, --hardest, --reserve, --use, --disable, --channel, --decision), or ask your agent.`);
  return result;
}
