// `routr setup` for a person at a terminal: a guided flow that only COLLECTS choices and hands them back in the shape
// the flags take (models, efforts, hardest, reserves, switches), so setup applies them with the same code an agent's
// `--yes` run uses, and the two can never disagree. Nothing is written here; the review screen comes before any write.
// First run: which subscriptions routr may use, then one screen of settings for each. Run again: a summary of what is
// set and a menu to change one thing (aws configure's "Enter keeps the current value"), or to walk everything.
import { accountName, HARNESSES, TAKES_EFFORT } from "./harnesses.mjs";
import { configDirOf } from "./state-files.mjs";
import { LEVELS } from "./questions.mjs";
import { BACK, CANCEL } from "./tui.mjs";
import { NOTICE } from "./telemetry.mjs";
import { LEVEL_MEANING, RESERVE } from "./wording.mjs";
import { isShare, SHARE_MAX, UPDATE_CHANNELS } from "./config.mjs";
import { decisionTargets, modelsHere, PROVIDER_NAMES, PROVIDERS } from "./providers.mjs";
import { otelEndpoint } from "./otel.mjs";

const LEAVE = ""; // "leave the model to the lead agent": no default_model
const NO_SHARE = "none"; // no launch share: the account counts as 1 beside one that has a share
const PRESETS = [0, 0.1, 0.2, 0.25, 0.3, 0.5];
const pct = (x) => `${Math.round(x * 100)}%`;
const FIELDS = { model: "Everyday model", effort: "Everyday effort", hardest: "Hardest work", reserve: "Reserve", use: "Account use", share: "Launch share" };

// Which decision model reads each brief: every model routr has measured that runs on this machine, with what it needs
// and how it did on routr's own items (providers.mjs, `hint`). Returns a list of { provider, model }, BACK or CANCEL.
export const decisionLabel = (d) => Array.isArray(d) ? d.map(decisionLabel).join(" then ") : `${PROVIDERS[d.provider].label} · ${d.model}`;
export async function askDecision(ui, now) {
  const current = Array.isArray(now) ? now : [now];
  const options = PROVIDER_NAMES.flatMap((p) => modelsHere(p).map((m) => ({ value: `${p}\u0000${m}`, label: `${PROVIDERS[p].label} · ${m}`, hint: PROVIDERS[p].models[m].hint })));
  const v = await ui.select({ message: `Which decision model reads each brief? ${ui.style.dim("(first choice; local models are tried after hosted models)")}`, initial: `${current[0].provider}\u0000${current[0].model}`, options });
  if (typeof v !== "string") return v;
  const backup = await ui.select({ message: "Optional backup decision model?", initial: current[1] ? `${current[1].provider}\u0000${current[1].model}` : "none",
    options: [{ value: "none", label: "No backup" }, ...options.filter((o) => o.value !== v)] });
  if (typeof backup !== "string") return backup;
  return [v, ...(backup === "none" ? [] : [backup])].map((value) => { const [provider, model] = value.split("\u0000"); return { provider, model }; });
}

// One line per subscription: what it runs and what it takes.
export const describe = (n, s) => (s.enabled === false ? "off (settings kept)"
  : `${s.default_model || "model left to the lead agent"}${s.default_effort ? ` @ ${s.default_effort}` : ""} · ${s.hardest_work} work · reserve ${pct(s.reserve ?? 0)}${s.use ? ` · ${s.use} use` : ""}${s.share != null ? ` · share ${s.share}` : ""}`);

// A harness setup can take settings for: installed and signed in, or signed out on its own with an extra account signed
// in, which takes its settings.
export const takesSettings = (r, n) => r.harnesses[n]?.installed && (r.harnesses[n].signed_in || Object.values(r.accounts ?? {}).some((a) => a.harness === n && a.signed_in));
// `r` is doctor's inspection, `config` the file as it is (null on a first run). `efforts(n, model)` lists a harness's
// levels for a model. Returns the choices, or CANCEL when the person quits without writing.
export async function guided({ ui, r, config, efforts, telemetry = false, decided = null, accounts: acct = null }) {
  const file = config?.subscriptions ?? {};
  // An extra account is a subscription here like any other, named <harness>-<name> and asked the same questions. What
  // it has now is its harness's settings with its own over them, as the config is read, so only a setting the person
  // makes differ from its harness's is written for it. `accountsAdded`: accounts added in this run, with their folder.
  const of = (n) => (Object.hasOwn(HARNESSES, n) ? n : accountName(n).harness), H = (n) => HARNESSES[of(n)];
  const label = (n) => (Object.hasOwn(HARNESSES, n) ? HARNESSES[n].label : `${H(n).label} · ${accountName(n).short}`);
  const without = (o, keys) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));
  const inherited = (h) => without(file[h], ["accounts", "enabled"]);
  const current = { ...file }, accountsAdded = {};
  for (const h of Object.keys(HARNESSES)) for (const [short, e] of Object.entries(file[h]?.accounts ?? {})) {
    if (!r.accounts?.[`${h}-${short}`]) continue; // one routr left out (doctor says why) is not offered
    current[`${h}-${short}`] = { ...inherited(h), ...without(e && typeof e === "object" ? e : {}, ["folder"]) };
  }
  const isAccount = (n) => !Object.hasOwn(HARNESSES, n);
  // What an account states itself, and what the person answered for it in this run (`touched`). Every other setting
  // of its is its harness's as it stands NOW, changes made to the harness in this run included (`sync`), so the
  // lists and the review show what will be read back, and an answer that matches the harness's old value is kept
  // when the harness moves.
  const KEYS = ["default_model", "default_effort", "hardest_work", "reserve", "use", "share"];
  const ownOf = (n) => { const a = accountName(n), e = file[a.harness]?.accounts?.[a.short]; return e && typeof e === "object" ? e : {}; };
  const touched = {}, stated = (n, k) => touched[n]?.has(k) || Object.hasOwn(ownOf(n), k);
  // A harness with no entry yet (signed out on its default folder) gets the starter one when its account is saved:
  // the account is shown and compared against that.
  const starter = (h) => ({ ...HARNESSES[h].suggested, ...(TAKES_EFFORT.includes(h) ? { default_effort: HARNESSES[h].suggested.default_effort ?? "medium" } : {}) });
  const harnessNow = (n, k) => (draft[of(n)] ?? file[of(n)] ?? starter(of(n)))[k];
  const sync = () => { for (const n of candidates) if (isAccount(n)) for (const k of KEYS) if (!stated(n, k)) draft[n][k] = harnessNow(n, k) ?? (k === "hardest_work" || k === "reserve" ? H(n).suggested[k] : undefined); };
  const signedNow = new Set(); // accounts signed in from this screen, after the inspection found them signed out
  const signedIn = (n) => (isAccount(n) ? Boolean(accountsAdded[n]) || signedNow.has(n) || r.accounts?.[n]?.signed_in === true : takesSettings(r, n));
  // Each harness, then its accounts.
  const candidates = Object.keys(HARNESSES).flatMap((n) => [...(signedIn(n) || current[n] ? [n] : []), ...Object.keys(current).filter((x) => isAccount(x) && of(x) === n)]);
  // Installed but not signed in, and not set up: listed with what to run, never offered until the sign-in is done.
  const waiting = Object.keys(HARNESSES).filter((n) => r.harnesses[n]?.installed && !signedIn(n) && !current[n]);
  const signInOf = (n) => (isAccount(n) ? r.accounts?.[n]?.sign_in ?? "not signed in" : r.harnesses[n]?.installed ? r.harnesses[n].sign_in ?? "not signed in" : `\`${H(n).executable}\` was not found on this machine`);
  // One set up but not signed in (or not installed) keeps its settings and can be turned off, but not turned on, and
  // its settings are not walked: the model list and the effort levels come from the harness, and asking a harness that
  // is not signed in can open its sign-in (signin.mjs).
  const locked = (n) => !signedIn(n) && !(current[n] && current[n].enabled !== false);
  // The working copy: what is set now, or the suggestions for a harness routr has not set up yet.
  // An existing subscription is drafted as it is (no effort suggested where none is set: that would be a change the
  // person did not make); `enabled` is computed last, the way loadConfig reads it.
  const draft = Object.fromEntries(candidates.map((n) => [n, { ...(current[n] ? { hardest_work: H(n).suggested.hardest_work, reserve: H(n).suggested.reserve, ...current[n] }
    : starter(n)),
    enabled: current[n] ? current[n].enabled !== false : true }]));
  const answers = {};

  // Each field is its own question; each returns BACK or CANCEL as the tui does.
  const ask = {
    model: async (n) => {
      const list = r.harnesses[of(n)]?.models ?? [];
      const options = list.map((id) => ({ value: id, label: id }));
      const now = draft[n].default_model ?? LEAVE;
      // A list that is only a sample (Claude Code's aliases) does not mean an id off it has gone.
      if (now && !list.includes(now)) options.unshift({ value: now, label: now, hint: H(n).openList ? "current" : "current, not in the harness's list now" });
      const v = await ui.search({ message: `${label(n)}: everyday model ${ui.style.dim("(your agents start here and go up or down with the work)")}`,
        options, initial: now, pinned: [{ value: LEAVE, label: "leave it to the lead agent", hint: "no default" }], typed: Boolean(H(n).openList) });
      if (typeof v === "string") {
        draft[n].default_model = v || null;
        // A model that does not take the effort set gets one it does (medium where it can), before the list of changes is
        // shown: the same rule setup applies to --model, so what is shown is what is saved.
        const levels = v && TAKES_EFFORT.includes(of(n)) && draft[n].default_effort ? await efforts(of(n), v) : null;
        if (levels?.length && !levels.includes(draft[n].default_effort)) draft[n].default_effort = levels.includes("medium") ? "medium" : levels[0];
      }
      return v;
    },
    effort: async (n) => {
      if (!TAKES_EFFORT.includes(of(n))) return "skip";
      const levels = await efforts(of(n), draft[n].default_model);
      if (!levels?.length) return "skip";
      const now = levels.includes(draft[n].default_effort) ? draft[n].default_effort : levels.includes("medium") ? "medium" : levels[0];
      const v = await ui.select({ message: `${label(n)}: everyday effort`, initial: now,
        options: levels.map((l) => ({ value: l, label: l, hint: l === H(n).autoEffort ? H(n).autoEffortMeans : undefined })) });
      if (typeof v === "string") draft[n].default_effort = v;
      return v;
    },
    hardest: async (n) => {
      const v = await ui.select({ message: `${label(n)}: the hardest work routr may send there`, initial: draft[n].hardest_work,
        options: LEVELS.map((l) => ({ value: l, label: l, hint: LEVEL_MEANING[l] })) });
      if (typeof v === "string") draft[n].hardest_work = v;
      return v;
    },
    reserve: async (n) => {
      const now = draft[n].reserve ?? 0;
      const options = [...new Set([...PRESETS, now])].sort((a, b) => a - b).map((x) => ({ value: x, label: pct(x), hint: x === 0 ? "hold nothing back" : undefined }));
      let v = await ui.select({ message: `${label(n)}: reserve ${ui.style.dim(`(${RESERVE.rule})`)}`, initial: now, options: [...options, { value: "other", label: "another share…" }] });
      if (v === "other") v = await ui.text({ message: `${label(n)}: reserve, 0 to 100%`, initial: pct(now),
        parse: (t) => { const s = String(t).trim(), x = s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s) > 1 ? Number(s) / 100 : Number(s); if (!s || !Number.isFinite(x) || x < 0 || x > 1) throw new Error("a share from 0% to 100%"); return Math.round(x * 100) / 100; } });
      if (typeof v === "number") draft[n].reserve = v;
      return v;
    },
  };
  const useOf = (n) => draft[n].use ?? "normal";
  ask.use = async (n) => {
    const v = await ui.select({ message: `${label(n)}: how may routr use this account?`, initial: useOf(n), options: [
      { value: "normal", label: "Normal use", hint: "consider it for everyday work, including funded enterprise usage" },
      { value: "fallback", label: "Fallback", hint: "use when normal accounts cannot suitably take the work" }] });
    // Visiting this setting is an explicit choice, even when it matches the default.
    if (typeof v === "string") draft[n].use = v;
    return v;
  };
  // Offer weights for normal metered pairs; ranking excludes caps with no usable room.
  // Inspection gives the class, not usable room: a weight can be configured before room returns.
  // Setup keeps an included reading; otherwise billing, then the observed class. A billing correction can hide
  // a metered budget here; ranking still counts its window.
  const reads = (n) => { const seen = (isAccount(n) ? r.accounts?.[n] : r.harnesses[n])?.usage_class; return seen === "included" ? seen : draft[n].billing ?? seen; };
  // An account added in this run was not read by the inspection, so its class is not known: it is asked its share
  // beside another metered account, and ranking counts the weight only once it reads metered.
  const sharer = (x) => draft[x].enabled && (reads(x) === "metered" || Boolean(accountsAdded[x])) && useOf(x) === "normal";
  const shares = (n) => sharer(n) && candidates.filter(sharer).length >= 2 && candidates.some((x) => sharer(x) && !accountsAdded[x]);
  ask.share = async (n) => {
    const now = draft[n].share ?? NO_SHARE;
    const options = [...new Set([1, 2, 3, 4, 5, ...(now === NO_SHARE ? [] : [now])])].sort((a, b) => a - b).map((x) => ({ value: x, label: String(x) }));
    let v = await ui.select({ message: `${label(n)}: launch share ${ui.style.dim("(its weight in how you split launches between these accounts: 3 here and 1 on another is about three for every one)")}`,
      initial: now, options: [{ value: NO_SHARE, label: "no share", hint: "counts as 1 when another account in the ratio has one" }, ...options, { value: "other", label: "another weight…" }] });
    if (v === "other") v = await ui.text({ message: `${label(n)}: launch share, 1 to ${SHARE_MAX}`, initial: now === NO_SHARE ? "" : String(now),
      parse: (t) => { const x = Number(String(t).trim()); if (!/^\d+$/.test(String(t).trim()) || !isShare(x)) throw new Error(`a whole number from 1 to ${SHARE_MAX}`); return x; } });
    if (v === NO_SHARE) draft[n].share = null;
    else if (typeof v === "number") draft[n].share = v;
    return v;
  };
  // An answer for an account is its own from then on, whatever its harness's value is or becomes. A model answer can
  // move its effort too.
  const FIELD_KEY = { model: "default_model", effort: "default_effort", hardest: "hardest_work", reserve: "reserve", use: "use", share: "share" };
  for (const f of Object.keys(FIELD_KEY)) { const inner = ask[f]; ask[f] = async (n) => {
    const effort = draft[n].default_effort, v = await inner(n);
    if (isAccount(n) && v !== BACK && v !== CANCEL && v !== "skip") { (touched[n] ??= new Set()).add(FIELD_KEY[f]); if (draft[n].default_effort !== effort) touched[n].add("default_effort"); }
    sync();
    return v;
  }; }
  const fieldsOf = (n) => Object.keys(FIELDS).filter((k) => (k !== "effort" || TAKES_EFFORT.includes(of(n))) && (k !== "share" || shares(n)));
  // Walking an account's settings asks the share last and separately (askShares): whether it applies depends on every
  // account's use, and a new metered account only becomes normal use when its own Account use is answered.
  const walkFields = (n) => fieldsOf(n).filter((k) => k !== "share");
  const askShares = async (names) => {
    const list = names.filter(shares);
    for (let i = 0; i < list.length;) {
      const v = await ask.share(list[i]);
      if (v === CANCEL) return CANCEL;
      if (v === BACK) { if (i === 0) return BACK; i--; continue; }
      i++;
    }
    return "done";
  };
  // Several fields in order; Esc goes back one field, and back past the first returns BACK.
  const fields = async (n, list) => {
    for (let i = 0; i < list.length;) {
      const v = await ask[list[i]](n);
      if (v === CANCEL) return CANCEL;
      if (v === BACK) { if (i === 0) return BACK; i--; continue; }
      i++;
    }
    return "done";
  };


  // Which subscriptions routr may hand work to. Unchecked, a new harness is kept, turned off, so it can be turned on later.
  // A harness not signed in says so on its own line of the list, so going back to this question does not repeat it.
  const choose = async () => {
    if (!candidates.length) {
      for (const n of waiting) ui.line(`${label(n)}: ${signInOf(n)}`, { dim: true });
      // A harness signed out on its default folder can still have another folder signed in: that account is offered.
      if (acct && multi.length) { const a = await askAccounts(); if (a === CANCEL) return CANCEL; }
      if (!candidates.length) { ui.line("No harness is installed and signed in yet: sign in to one, then run routr setup again."); return "none"; }
    }
    const v = await ui.multiselect({ message: "Which subscriptions may routr hand work to?", min: 1,
      options: [...candidates, ...waiting].map((n) => (waiting.includes(n) || locked(n)
        ? { value: n, label: label(n), disabled: signInOf(n) }
        : { value: n, label: listed(n), hint: [current[n] ? describe(n, draft[n]) : "new", ...(signedIn(n) ? [] : [signInOf(n)])].join(" · ") })),
      initial: candidates.filter((n) => draft[n].enabled) });
    if (Array.isArray(v)) for (const n of candidates) draft[n].enabled = v.includes(n);
    return v;
  };
  // The update channel: one setting for the whole file, offered from the menu only (a first run keeps stable). A value
  // routr cannot read counts as stable, as loadConfig reads it.
  const channelNow = UPDATE_CHANNELS.includes(config?.update_channel) ? config.update_channel : "stable";
  // The decision model in effect now, as loadConfig reads it (a first run's choice was made before the key: `decided`).
  const decisionNow = decisionTargets(config, {}, { localLast: false }).map(({ provider, model }) => ({ provider, model }));
  if (decided) answers.decision = decided;
  const askChannel = async () => {
    const v = await ui.select({ message: "Which releases should routr update to?", initial: answers.channel ?? channelNow, options: [
      { value: "stable", label: "Stable", hint: "releases only (the default)" },
      { value: "beta", label: "Beta", hint: "also beta and release-candidate builds; a newer stable release still wins" }] });
    if (typeof v === "string") answers.channel = v;
    return v;
  };
  const extras = async () => {
    if (telemetry) {
      ui.line(NOTICE, { dim: true });
      const v = await ui.confirm({ message: "Share anonymous outcomes once a day?", initial: false });
      if (v === CANCEL || v === BACK) return v;
      answers.telemetry = v;
    }
    if (!config?.otel) return askOtel();
    return "done";
  };
  const askOtel = async () => {
    ui.line("OpenTelemetry sends traces, logs and a subscription headroom gauge to your endpoint, including repository names, relative paths and ids; never briefs, reports or secrets. Schema: https://github.com/sirkirby/routr/blob/main/docs/opentelemetry.md. Set authentication separately with routr key set otel-headers.", { dim: true });
    const v = await ui.confirm({ message: "Export OpenTelemetry to your own endpoint?", initial: false });
    if (v === CANCEL || v === BACK || !v) return v;
    const endpoint = await ui.text({ message: "OpenTelemetry endpoint", initial: "", parse: otelEndpoint });
    if (typeof endpoint === "string") answers.otelEndpoint = endpoint;
    return endpoint;
  };

  // The harnesses that can have another account: one with a folder setting, installed here.
  const multi = Object.keys(HARNESSES).filter((h) => HARNESSES[h].folder && r.harnesses[h]?.installed);
  // The folder an account is signed in from, as written: one added in this run, or the config's.
  const folderOf = (n) => { if (accountsAdded[n]) return accountsAdded[n]; const a = accountName(n), e = file[a.harness]?.accounts?.[a.short]; return e && typeof e === "object" ? e.folder : e; };
  // An account's line in a list: its folder beside its name, so two accounts of one harness can be told apart at a glance.
  const listed = (n) => (isAccount(n) && folderOf(n) ? `${label(n)} ${ui.style.dim(`(${folderOf(n)})`)}` : label(n));
  const addLabel = (h) => `+ Add another ${HARNESSES[h].label} account`;
  // Adding one, start to finish, without leaving setup: its name, its folder (suggested from the name), the harness's
  // own sign-in run here when the folder is not signed in and the person says yes, the harness opened once where a new
  // folder asks first-run questions, then the settings that usually differ. `acct` is setup's: `check` says why a
  // folder cannot be added (`signedOut`: only because it is not signed in), `signIn` and `open` run the harness in this
  // terminal and come back when it exits. routr starts a sign-in nowhere else, and only on that yes.
  const handOff = (run) => (ui.handOff ? ui.handOff(run) : run());
  // After a sign-in run here, for a harness whose new folder asks first-run questions: wherever the sign-in was run
  // from. Back or no leaves it signed in, with what is left to do said.
  const offerOpen = async (n, name, folder) => {
    const h = of(n);
    if (!HARNESSES[h].folder.firstRun || !acct.open) return null;
    const go = await ui.confirm({ message: `Open ${HARNESSES[h].label} in it once now? ${ui.style.dim(`(a new folder asks its first-run questions, and a worker stops at them: answer them, then quit ${HARNESSES[h].label} to come back here)`)}`, initial: true });
    if (go === CANCEL) return CANCEL;
    if (go === true) await handOff(() => acct.open(n, folder));
    else ui.line(`${name}: not opened. A worker there stops at ${HARNESSES[h].label}'s first-run questions until someone answers them once.`);
    return null;
  };
  const askAccount = async (h) => {
    const short = await ui.text({ message: `${HARNESSES[h].label}: a name for this account ${ui.style.dim(`(for example work or personal2: routr calls it ${h}-<name>)`)}`, initial: "",
      parse: (t) => { const v = String(t).trim(), n = `${h}-${v}`; if (!/^[a-z0-9][a-z0-9_-]*$/.test(v) || n.length > 32) throw new Error("a-z, 0-9, - and _, and 32 characters at most with the harness's name"); if (removed.includes(n)) throw new Error(`${n} is being removed in this run: save, then add it again`); if (current[n] || Object.hasOwn(HARNESSES, n)) throw new Error(`${n} is already a subscription`); return v; } });
    if (typeof short !== "string") return short;
    const n = `${h}-${short}`, folder = await ui.text({ message: `Its folder ${ui.style.dim(`(where ${HARNESSES[h].label} keeps this login, apart from your others: Enter takes the one shown, or give one already signed in)`)}`, initial: `~/${HARNESSES[h].folder.default}-${short}`,
      parse: (t) => { const v = String(t).trim(); if (!configDirOf(v)) throw new Error("a full path, or one under ~/"); return v; } });
    if (typeof folder !== "string") return folder;
    let no = await acct.check(n, folder), fresh = false;
    if (no?.signedOut && acct.signIn) {
      const go = await ui.confirm({ message: `${folder} is not signed in yet. Sign in now? ${ui.style.dim(`(${HARNESSES[h].label}'s own sign-in runs here: sign in with the account this is for, and setup carries on when it is done)`)}`, initial: true });
      if (go === CANCEL || go === BACK) return go;
      if (go) {
        fresh = true; await handOff(() => acct.signIn(n, folder)); no = await acct.check(n, folder);
        ui.line(""); // the harness's last line is its own: what setup says next starts on a line of its own
        if (no?.signedOut) { ui.line(`${HARNESSES[h].label} · ${short}: ${folder} is still not signed in, so it was not added. Choose "${addLabel(h)}" again to try once more.`); return "none"; }
      }
    }
    if (no) { ui.line(`${HARNESSES[h].label} · ${short}: ${no.why}`); return "none"; }
    if (fresh && await offerOpen(n, `${HARNESSES[h].label} · ${short}`, folder) === CANCEL) return CANCEL;
    acct.keep?.(n, folder); // from here it is this run's: its folder is taken until it is saved or removed
    accountsAdded[n] = folder; current[n] = { ...inherited(h), ...Object.fromEntries(["default_model", "default_effort", "hardest_work", "reserve", "use", "share"].filter((k) => draft[h]?.[k] !== undefined).map((k) => [k, draft[h][k]])) };
    draft[n] = { ...current[n], hardest_work: current[n].hardest_work ?? HARNESSES[h].suggested.hardest_work, reserve: current[n].reserve ?? HARNESSES[h].suggested.reserve, enabled: true };
    candidates.splice(Math.max(candidates.indexOf(h), ...candidates.map((x, i) => (isAccount(x) && of(x) === h ? i : -1))) + 1, 0, n);
    ui.line(`${label(n)} is signed in from ${folder}. It starts with ${HARNESSES[h].label}'s settings, model and effort included: change those under Subscriptions.`, { dim: true });
    // Asked now: what usually differs between two accounts of one harness. Its model and effort stay its harness's
    // until changed, so answering nothing writes nothing of its own.
    const v = await fields(n, ["hardest", "reserve", "use"]);
    return v === CANCEL ? CANCEL : n;
  };
  // Taking an account out of routr: its entry goes, and its folder and sign-in stay as they are. One added in this run
  // is simply not written.
  const removed = [], removedFolder = {};
  const removeAccount = async (n) => {
    const go = await ui.confirm({ message: `Remove ${label(n)} from routr? ${ui.style.dim(`(routr stops using it: ${folderOf(n)} and its sign-in stay as they are)`)}`, initial: false });
    if (go !== true) return go;
    candidates.splice(candidates.indexOf(n), 1);
    removedFolder[n] = folderOf(n);
    if (accountsAdded[n]) delete accountsAdded[n]; else removed.push(n);
    // Nothing of it is left in this run: its name (one added here) and its folder can be used again.
    delete current[n]; delete draft[n]; delete touched[n]; acct?.drop?.(n);
    return true;
  };
  // A first run offers it after the subscriptions are chosen, as a list with "no" first: one line per harness that can
  // have another account.
  const askAccounts = async () => {
    if (!acct || !multi.length) return "done";
    for (;;) {
      const v = await ui.select({ message: `Do you have another ${multi.map((h) => HARNESSES[h].label).join(" or ")} subscription to use too? ${ui.style.dim("(a second login of the same harness, kept in a folder of its own)")}`, initial: "no",
        options: [{ value: "no", label: "No, carry on" }, ...multi.map((h) => ({ value: h, label: addLabel(h) }))] });
      if (v === CANCEL || v === BACK) return v;
      if (v === "no") return "done";
      if (await askAccount(v) === CANCEL) return CANCEL;
    }
  };

  // What would change, one line each: the review, and the count on the menu.
  const changes = () => {
    const out = [];
    for (const n of candidates) {
      // An account is compared with what it would read without this run's answers for it: its own settings, else its
      // harness's as they now stand.
      const now = draft[n], was = isAccount(n) && current[n] ? { ...current[n], ...Object.fromEntries(KEYS.filter((k) => !Object.hasOwn(ownOf(n), k)).map((k) => [k, harnessNow(n, k)])) } : current[n];
      // Its harness with no entry yet gets one, which the account's unanswered settings are read from: said, with them.
      if (accountsAdded[n] && !file[of(n)] && !draft[of(n)] && !out.some((l) => l.startsWith(`${H(n).label}: `))) out.push(`${H(n).label}: added for its account · ${describe(of(n), { ...starter(of(n)), enabled: true })}`);
      if (accountsAdded[n]) out.push(`${label(n)}: added, signed in from ${accountsAdded[n]}`);
      if (!was) { out.push(`${label(n)}: ${now.enabled ? `added · ${describe(n, now)}` : "added, turned off"}`); continue; }
      if ((was.enabled !== false) !== now.enabled) out.push(`${label(n)}: ${now.enabled ? "turned on" : "turned off (settings kept)"}`);
      for (const [k, what] of [["default_model", "model"], ["default_effort", "effort"], ["hardest_work", "hardest work"], ["reserve", "reserve"], ["use", "account use"], ["share", "launch share"]]) {
        const a = was[k] ?? null, b = now[k] ?? null;
        if (a !== b) out.push(`${label(n)}: ${what} ${k === "reserve" ? pct(a ?? 0) : a ?? "none"} ${ui.glyphs.arrow} ${k === "reserve" ? pct(b ?? 0) : b ?? "none"}`);
      }
    }
    for (const n of removed) out.push(`${H(n).label} · ${accountName(n).short}: removed from routr (its folder ${removedFolder[n]} is left as it is)`);
    if (answers.telemetry !== undefined) out.push(`telemetry: ${answers.telemetry ? "on" : "off"}`);
    if (answers.otelEndpoint !== undefined) out.push("OpenTelemetry export: on");
    if (answers.channel && answers.channel !== channelNow) out.push(`update channel: ${channelNow} ${ui.glyphs.arrow} ${answers.channel}`);
    if (answers.decision && decisionLabel(answers.decision) !== decisionLabel(decisionNow)) out.push(`decision model: ${decisionLabel(decisionNow)} ${ui.glyphs.arrow} ${decisionLabel(answers.decision)}`);
    return out;
  };
  // The end of the run: what changed, then the usual way out. Save is the default; nothing is written before it.
  const finish = async () => {
    const list = changes();
    if (!list.length) return "nothing";
    ui.note("Your changes", list);
    return ui.select({ message: "Save your changes?", initial: "write", options: [
      { value: "write", label: "Save and exit", hint: config ? "the old file is kept as config.json.bak" : undefined },
      { value: "back", label: "Go back" }, { value: "quit", label: "Exit without saving" }] });
  };

  // First run: every step in order; Esc steps back.
  const full = async () => {
    const steps = ["choose", "settings", "accounts", "shares", "extras", "finish"];
    for (let s = 0; s < steps.length;) {
      let v;
      if (steps[s] === "choose") v = await choose();
      else if (steps[s] === "settings") {
        v = "done";
        for (const n of candidates.filter((x) => draft[x].enabled && signedIn(x) && !accountsAdded[x])) { v = await fields(n, walkFields(n)); if (v !== "done") break; } // an account added in this run was asked its settings then
      } else if (steps[s] === "accounts") v = await askAccounts();
      else if (steps[s] === "shares") v = await askShares(candidates.filter((x) => signedIn(x)));
      else if (steps[s] === "extras") v = await extras();
      else { v = await finish(); if (v === "back") { s = 0; continue; } if (v === "quit") return CANCEL; if (v === "write" || v === "nothing") return v; }
      if (v === CANCEL) return CANCEL;
      if (v === "none") return "none";
      if (v === BACK) { s = Math.max(0, s - 1); continue; }
      s++;
    }
    return "write";
  };

  // Run again: what is set, then a menu, until the person writes or leaves.
  const menu = async () => {
    const wide = Math.max(12, ...candidates.map((n) => label(n).length));
    ui.note("Your settings", [...candidates.map((n) => `${label(n).padEnd(wide)} ${current[n] ? describe(n, draft[n]) : "detected, not set up yet"}${signedIn(n) ? "" : ` · ${signInOf(n)}`}`),
      ...waiting.map((n) => `${label(n).padEnd(wide)} ${signInOf(n)}`), `${"Decisions".padEnd(wide)} ${decisionLabel(answers.decision ?? decisionNow)}${answers.decision && decisionLabel(answers.decision) !== decisionLabel(decisionNow) ? " (not saved yet)" : ""}`, `${"Updates".padEnd(wide)} ${channelNow} channel`]);
    for (;;) {
      const pending = changes().length;
      const v = await ui.select({ message: "What would you like to do?", initial: "one", options: [
        { value: "one", label: "Subscriptions", hint: acct && multi.length ? `change one's settings, or add another ${multi.map((h) => HARNESSES[h].label).join(" or ")} account` : "change one's model, effort, hardest work, reserve, account use, launch share" },
        { value: "choose", label: "Choose which subscriptions routr uses", hint: "turn one on or off" },
        ...(telemetry ? [{ value: "extras", label: "Anonymous outcomes (telemetry)" }] : []),
        { value: "channel", label: "Update channel", hint: `${answers.channel ?? channelNow}: stable releases, or beta builds too` },
        { value: "decision", label: "Decision model", hint: decisionLabel(answers.decision ?? decisionNow) },
        { value: "all", label: "Walk through everything" },
        { value: "otel", label: "OpenTelemetry export", hint: "send to your own endpoint (routr setup --otel-off stops it)" },
        pending ? { value: "save", label: `Save and exit (${pending} change${pending === 1 ? "" : "s"})` } : { value: "done", label: "Exit" },
        ...(pending ? [{ value: "quit", label: "Exit without saving" }] : [])] });
      if (v === CANCEL || v === "quit") return CANCEL;
      if (v === "done" || (v === BACK && !pending)) return "nothing";
      if (v === "save") { ui.note("Saving", changes()); return "write"; }
      // Esc with changes not saved: the same way out as at the end of a first run, so nothing is lost by accident.
      if (v === BACK) { const w = await finish(); if (w === "write") return "write"; if (w === "quit" || w === CANCEL) return CANCEL; continue; }
      if (v === "choose") { const c = await choose(); if (c === CANCEL) return CANCEL; if (Array.isArray(c)) { const added = c.filter((x) => !current[x]); for (const n of added) if (await fields(n, walkFields(n)) === CANCEL) return CANCEL; if (await askShares(added) === CANCEL) return CANCEL; } continue; }
      if (v === "extras") { if (await extras() === CANCEL) return CANCEL; continue; }
      if (v === "otel") { if (await askOtel() === CANCEL) return CANCEL; continue; }
      if (v === "channel") { if (await askChannel() === CANCEL) return CANCEL; continue; }
      if (v === "decision") { const d = await askDecision(ui, answers.decision ?? decisionNow); if (d === CANCEL) return CANCEL; if (Array.isArray(d)) answers.decision = d; continue; }
      if (v === "all") { const f = await full(); if (f === CANCEL) return CANCEL; if (f === "write") return "write"; continue; }
      // Nested like any settings menu: a subscription, then its settings, each with its value now. Changing one comes
      // back to the same list with the new value; Back (or Esc) goes up one level, to the subscriptions, then the menu.
      let n = candidates[0];
      for (;;) {
        // The list is where an account is added too: one line per harness that can have another, after the subscriptions.
        const adds = acct ? multi.map((h) => ({ value: `+${h}`, label: addLabel(h), hint: "another subscription of it, signed in from a folder of its own" })) : [];
        const picked = await ui.select({ message: "Subscriptions", initial: candidates.includes(n) ? n : candidates[0], options: [
          ...candidates.map((x) => ({ value: x, label: listed(x), hint: signedIn(x) ? describe(x, draft[x]) : `${describe(x, draft[x])} · ${signInOf(x)}` })), ...adds, { value: BACK, label: "Back" }] });
        if (picked === CANCEL) return CANCEL;
        if (picked === BACK) break;
        if (picked.startsWith("+")) { const a = await askAccount(picked.slice(1)); if (a === CANCEL) return CANCEL; if (accountsAdded[a]) { if (await askShares([a]) === CANCEL) return CANCEL; n = a; } continue; }
        n = picked;
        if (!signedIn(n) && isAccount(n) && acct) {
          // An account that is not signed in has no settings to walk, and can still be signed in here or taken out.
          const here = r.harnesses[of(n)]?.installed && acct.signIn;
          const what = await ui.select({ message: r.harnesses[of(n)]?.installed ? `${label(n)} is not signed in` : `${label(n)}: ${signInOf(n)}`, initial: here ? "signin" : BACK, options: [
            ...(here ? [{ value: "signin", label: "Sign in now", hint: `${H(n).label}'s own sign-in runs here, for ${folderOf(n)}` }] : []),
            { value: "remove", label: "Remove this account from routr", hint: "its folder stays as it is" }, { value: BACK, label: "Back" }] });
          if (what === CANCEL) return CANCEL;
          if (what === "remove") { if (await removeAccount(n) === CANCEL) return CANCEL; }
          else if (what === "signin") {
            await handOff(() => acct.signIn(n, folderOf(n))); ui.line("");
            const no = await acct.check(n, folderOf(n));
            if (no) ui.line(`${label(n)}: ${no.signedOut ? `${folderOf(n)} is still not signed in` : no.why}`); else { signedNow.add(n); ui.line(`${label(n)} is signed in.`, { dim: true }); if (await offerOpen(n, label(n), folderOf(n)) === CANCEL) return CANCEL; }
          }
          continue;
        }
        if (!signedIn(n)) { ui.line(`${label(n)}: ${signInOf(n)}, then change its settings here.`, { dim: true }); continue; }
        let f = "model";
        for (;;) {
          const now = { model: draft[n].default_model || "left to the lead agent", effort: draft[n].default_effort ?? "not set", hardest: draft[n].hardest_work, reserve: pct(draft[n].reserve ?? 0), use: useOf(n), share: draft[n].share ?? "none" };
          f = await ui.select({ message: `${label(n)}: which setting?`, initial: f, options: [
            ...fieldsOf(n).map((k) => ({ value: k, label: FIELDS[k], hint: now[k] })),
            ...(isAccount(n) ? [{ value: "remove", label: "Remove this account from routr", hint: "its folder and sign-in stay as they are" }] : []),
            { value: BACK, label: "Back" }] });
          if (f === CANCEL) return CANCEL;
          if (f === BACK) break;
          if (f === "remove") { const gone = await removeAccount(n); if (gone === CANCEL) return CANCEL; if (gone === true) break; f = "model"; continue; }
          if (await ask[f](n) === CANCEL) return CANCEL; // Esc inside a setting keeps its value and comes back here
        }
      }
    }
  };

  const outcome = config ? await menu() : await full();
  if (outcome === CANCEL) return CANCEL;
  // In the flags' shape, so setup applies them as it applies --model, --effort, --hardest, --reserve, --enable/--disable.
  const out = { models: {}, efforts: {}, hardest: {}, reserves: {}, switches: {}, uses: {}, shares: {}, accounts: { ...accountsAdded }, removeAccounts: [...removed], ...answers, write: outcome === "write" };
  if (out.channel === channelNow) delete out.channel; // as --channel: only a change is applied
  if (out.decision && decisionLabel(out.decision) === decisionLabel(decisionNow)) delete out.decision; // as --decision
  sync();
  for (const n of candidates) {
    const d = draft[n];
    if (isAccount(n)) {
      // Only what the person answered, and only where it differs from what the account would read anyway.
      const base = (k) => (Object.hasOwn(ownOf(n), k) ? ownOf(n)[k] : harnessNow(n, k) ?? (k === "hardest_work" || k === "reserve" ? H(n).suggested[k] : null)) ?? null, differs = (k) => touched[n]?.has(k) && (d[k] ?? null) !== (k === "use" ? base(k) ?? "normal" : base(k));
      if (differs("default_model")) out.models[n] = d.default_model || null;
      if (differs("default_effort") && d.default_effort) out.efforts[n] = d.default_effort;
      if (differs("hardest_work")) out.hardest[n] = d.hardest_work;
      if (differs("reserve")) out.reserves[n] = d.reserve;
      if (differs("use")) out.uses[n] = d.use;
      if (differs("share")) out.shares[n] = d.share ?? "off";
      if ((current[n].enabled !== false) !== d.enabled) out.switches[n] = d.enabled;
      continue;
    }
    const was = current[n] ?? {};
    if (d.default_model !== (was.default_model ?? undefined) && d.default_model) out.models[n] = d.default_model;
    if (d.default_model === null && was.default_model) out.models[n] = null;
    if (TAKES_EFFORT.includes(n) && d.default_effort && d.default_effort !== was.default_effort) out.efforts[n] = d.default_effort;
    if (d.hardest_work !== was.hardest_work) out.hardest[n] = d.hardest_work;
    if (d.reserve !== was.reserve) out.reserves[n] = d.reserve;
    if (!current[n] || (was.enabled !== false) !== d.enabled) out.switches[n] = d.enabled;
    if (d.use && d.use !== was.use) out.uses[n] = d.use;
    if ((d.share ?? null) !== (was.share ?? null)) out.shares[n] = d.share ?? "off";
  }
  return out;
}
