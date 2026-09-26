// `routr setup` for a person at a terminal: a guided flow that only COLLECTS choices and hands them back in the shape
// the flags take (models, efforts, hardest, reserves, switches), so setup applies them with the same code an agent's
// `--yes` run uses, and the two can never disagree. Nothing is written here; the review screen comes before any write.
// First run: which subscriptions routr may use, then one screen of settings for each. Run again: a summary of what is
// set and a menu to change one thing (aws configure's "Enter keeps the current value"), or to walk everything.
import { HARNESSES, TAKES_EFFORT } from "./harnesses.mjs";
import { LEVELS } from "./questions.mjs";
import { BACK, CANCEL } from "./tui.mjs";
import { NOTICE } from "./telemetry.mjs";
import { LEVEL_MEANING, RESERVE } from "./wording.mjs";

const LEAVE = ""; // "leave the model to the lead agent": no default_model
const PRESETS = [0, 0.1, 0.2, 0.25, 0.3, 0.5];
const pct = (x) => `${Math.round(x * 100)}%`;
const FIELDS = { model: "Everyday model", effort: "Everyday effort", hardest: "Hardest work", reserve: "Reserve" };

// One line per subscription: what it runs and what it takes.
export const describe = (n, s) => (s.enabled === false ? "off (settings kept)"
  : `${s.default_model || "model left to the lead agent"}${s.default_effort ? ` @ ${s.default_effort}` : ""} · ${s.hardest_work} work · reserve ${pct(s.reserve ?? 0)}`);

// `r` is doctor's inspection, `config` the file as it is (null on a first run). `efforts(n, model)` lists a harness's
// levels for a model. Returns the choices, or CANCEL when the person quits without writing.
export async function guided({ ui, r, config, efforts, statusline = false, telemetry = false }) {
  const current = config?.subscriptions ?? {};
  const signedIn = (n) => r.harnesses[n]?.installed && r.harnesses[n]?.signed_in;
  const candidates = Object.keys(HARNESSES).filter((n) => signedIn(n) || current[n]);
  // The working copy: what is set now, or the suggestions for a harness routr has not set up yet.
  const draft = Object.fromEntries(candidates.map((n) => [n, { enabled: current[n] ? current[n].enabled !== false : true,
    ...HARNESSES[n].suggested, ...(TAKES_EFFORT.includes(n) ? { default_effort: HARNESSES[n].suggested.default_effort ?? "medium" } : {}), ...current[n] }]));
  const answers = {};

  // Each field is its own question; each returns BACK or CANCEL as the tui does.
  const ask = {
    model: async (n) => {
      const list = r.harnesses[n]?.models ?? [];
      const options = list.map((id) => ({ value: id, label: id }));
      const now = draft[n].default_model ?? LEAVE;
      if (now && !list.includes(now)) options.unshift({ value: now, label: now, hint: "current, not in the harness's list now" });
      const v = await ui.search({ message: `${HARNESSES[n].label}: everyday model ${ui.style.dim("(your agents start here and go up or down with the work)")}`,
        options, initial: now, pinned: [{ value: LEAVE, label: "leave it to the lead agent", hint: "no default" }] });
      if (typeof v === "string") draft[n].default_model = v || null;
      return v;
    },
    effort: async (n) => {
      if (!TAKES_EFFORT.includes(n)) return "skip";
      const levels = await efforts(n, draft[n].default_model);
      if (!levels?.length) return "skip";
      const now = levels.includes(draft[n].default_effort) ? draft[n].default_effort : levels.includes("medium") ? "medium" : levels[0];
      const v = await ui.select({ message: `${HARNESSES[n].label}: everyday effort`, initial: now,
        options: levels.map((l) => ({ value: l, label: l, hint: l === "auto" ? "the model decides; nothing is saved in Kiro" : undefined })) });
      if (typeof v === "string") draft[n].default_effort = v;
      return v;
    },
    hardest: async (n) => {
      const v = await ui.select({ message: `${HARNESSES[n].label}: the hardest work routr may send there`, initial: draft[n].hardest_work,
        options: LEVELS.map((l) => ({ value: l, label: l, hint: LEVEL_MEANING[l] })) });
      if (typeof v === "string") draft[n].hardest_work = v;
      return v;
    },
    reserve: async (n) => {
      const now = draft[n].reserve ?? 0;
      const options = [...new Set([...PRESETS, now])].sort((a, b) => a - b).map((x) => ({ value: x, label: pct(x), hint: x === 0 ? "hold nothing back" : undefined }));
      let v = await ui.select({ message: `${HARNESSES[n].label}: reserve ${ui.style.dim(`(${RESERVE.rule})`)}`, initial: now, options: [...options, { value: "other", label: "another share…" }] });
      if (v === "other") v = await ui.text({ message: `${HARNESSES[n].label}: reserve, 0 to 100%`, initial: pct(now),
        parse: (t) => { const s = String(t).trim(), x = s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s) > 1 ? Number(s) / 100 : Number(s); if (!s || !Number.isFinite(x) || x < 0 || x > 1) throw new Error("a share from 0% to 100%"); return Math.round(x * 100) / 100; } });
      if (typeof v === "number") draft[n].reserve = v;
      return v;
    },
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
  const all = Object.keys(FIELDS);

  // Which subscriptions routr may hand work to. Unchecked, a new harness is kept, turned off, so it can be turned on later.
  const choose = async () => {
    for (const n of Object.keys(HARNESSES)) if (r.harnesses[n]?.installed && !r.harnesses[n]?.signed_in) ui.line(ui.style.dim(`${HARNESSES[n].label}: ${r.harnesses[n].sign_in}`));
    if (!candidates.length) { ui.line("No harness is installed and signed in yet: sign in to one, then run routr setup again."); return "none"; }
    const v = await ui.multiselect({ message: "Which subscriptions may routr hand work to?", min: 1,
      options: candidates.map((n) => ({ value: n, label: HARNESSES[n].label, hint: current[n] ? describe(n, draft[n]) : "new" })),
      initial: candidates.filter((n) => draft[n].enabled) });
    if (Array.isArray(v)) for (const n of candidates) draft[n].enabled = v.includes(n);
    return v;
  };
  const extras = async () => {
    if (statusline) { const v = await ui.confirm({ message: "Claude Code reports usage only to its statusline. Set `routr statusline` as Claude's statusline command?", initial: true }); if (v === CANCEL || v === BACK) return v; answers.statusline = v; }
    if (telemetry) {
      for (const l of NOTICE.split("\n")) ui.line(ui.style.dim(l));
      const v = await ui.confirm({ message: "Share anonymous outcomes once a day?", initial: false });
      if (v === CANCEL || v === BACK) return v;
      answers.telemetry = v;
    }
    return "done";
  };

  // What would change, one line each: the review, and the count on the menu.
  const changes = () => {
    const out = [];
    for (const n of candidates) {
      const was = current[n], now = draft[n];
      if (!was) { out.push(`${HARNESSES[n].label}: ${now.enabled ? `added · ${describe(n, now)}` : "added, turned off"}`); continue; }
      if ((was.enabled !== false) !== now.enabled) out.push(`${HARNESSES[n].label}: ${now.enabled ? "turned on" : "turned off (settings kept)"}`);
      for (const [k, label] of [["default_model", "model"], ["default_effort", "effort"], ["hardest_work", "hardest work"], ["reserve", "reserve"]]) {
        const a = was[k] ?? null, b = now[k] ?? null;
        if (a !== b) out.push(`${HARNESSES[n].label}: ${label} ${k === "reserve" ? pct(a ?? 0) : a ?? "none"} ${ui.glyphs.arrow} ${k === "reserve" ? pct(b ?? 0) : b ?? "none"}`);
      }
    }
    if (answers.statusline) out.push("Claude Code's statusline: set to routr statusline");
    if (answers.telemetry !== undefined) out.push(`telemetry: ${answers.telemetry ? "on" : "off"}`);
    return out;
  };
  // Write, go back, or quit: nothing has been written until "Write".
  const review = async () => {
    const list = changes();
    ui.note(list.length ? "Review" : "Nothing to change", list.length ? list : ["your settings stay as they are"]);
    if (!list.length) return "write";
    return ui.select({ message: "Write these changes?", initial: "write", options: [
      { value: "write", label: "Write them", hint: config ? "the old file is kept as config.json.bak" : undefined },
      { value: "back", label: "Go back and change something" }, { value: "quit", label: "Quit without writing" }] });
  };

  // First run: every step in order; Esc steps back.
  const full = async () => {
    const steps = ["choose", "settings", "extras", "review"];
    for (let s = 0; s < steps.length;) {
      let v;
      if (steps[s] === "choose") v = await choose();
      else if (steps[s] === "settings") {
        v = "done";
        for (const n of candidates.filter((x) => draft[x].enabled)) { v = await fields(n, all); if (v !== "done") break; }
      } else if (steps[s] === "extras") v = await extras();
      else { v = await review(); if (v === "back") { s = 0; continue; } if (v === "quit") return CANCEL; if (v === "write") break; }
      if (v === CANCEL) return CANCEL;
      if (v === "none") return "none";
      if (v === BACK) { s = Math.max(0, s - 1); continue; }
      s++;
    }
    return "write";
  };

  // Run again: what is set, then a menu, until the person writes or leaves.
  const menu = async () => {
    ui.note("Your settings", candidates.map((n) => `${HARNESSES[n].label.padEnd(12)} ${current[n] ? describe(n, draft[n]) : "detected, not set up yet"}`));
    for (;;) {
      const pending = changes().length;
      const v = await ui.select({ message: "What would you like to do?", initial: "one", options: [
        { value: "one", label: "Change one subscription's settings", hint: "model, effort, hardest work, reserve" },
        { value: "choose", label: "Choose which subscriptions routr uses", hint: "turn one on or off" },
        ...(statusline || telemetry ? [{ value: "extras", label: statusline ? "Claude Code's usage statusline" : "Anonymous outcomes (telemetry)" }] : []),
        { value: "all", label: "Walk through everything" },
        pending ? { value: "review", label: `Review and write (${pending} change${pending === 1 ? "" : "s"})` } : { value: "done", label: "Done: nothing to change" },
        ...(pending ? [{ value: "quit", label: "Quit without writing" }] : [])] });
      if (v === CANCEL || v === "quit") return CANCEL;
      if (v === "done" || (v === BACK && !pending)) return "nothing";
      if (v === "review" || v === BACK) { const w = await review(); if (w === "write") return "write"; if (w === "quit" || w === CANCEL) return CANCEL; continue; }
      if (v === "choose") { const c = await choose(); if (c === CANCEL) return CANCEL; if (Array.isArray(c)) for (const n of c.filter((x) => !current[x])) if (await fields(n, all) === CANCEL) return CANCEL; continue; }
      if (v === "extras") { if (await extras() === CANCEL) return CANCEL; continue; }
      if (v === "all") { const f = await full(); if (f === CANCEL) return CANCEL; if (f === "write") return "write"; continue; }
      // One subscription, then one field of it, or all four.
      const n = await ui.select({ message: "Which subscription?", initial: candidates[0], options: candidates.map((x) => ({ value: x, label: HARNESSES[x].label, hint: describe(x, draft[x]) })) });
      if (n === CANCEL) return CANCEL;
      if (n === BACK) continue;
      const f = await ui.select({ message: `${HARNESSES[n].label}: what to change?`, initial: "model", options: [
        ...Object.entries(FIELDS).filter(([k]) => k !== "effort" || TAKES_EFFORT.includes(n)).map(([k, label]) => ({ value: k, label })),
        { value: "all", label: "All of these" }] });
      if (f === CANCEL) return CANCEL;
      if (f === BACK) continue;
      if (await fields(n, f === "all" ? all : [f]) === CANCEL) return CANCEL;
    }
  };

  const outcome = config ? await menu() : await full();
  if (outcome === CANCEL) return CANCEL;
  // In the flags' shape, so setup applies them as it applies --model, --effort, --hardest, --reserve, --enable/--disable.
  const out = { models: {}, efforts: {}, hardest: {}, reserves: {}, switches: {}, ...answers, write: outcome === "write" };
  for (const n of candidates) {
    const was = current[n] ?? {}, d = draft[n];
    if (d.default_model !== (was.default_model ?? undefined) && d.default_model) out.models[n] = d.default_model;
    if (d.default_model === null && was.default_model) out.models[n] = null;
    if (TAKES_EFFORT.includes(n) && d.default_effort && d.default_effort !== was.default_effort) out.efforts[n] = d.default_effort;
    if (d.hardest_work !== was.hardest_work) out.hardest[n] = d.hardest_work;
    if (d.reserve !== was.reserve) out.reserves[n] = d.reserve;
    if (!current[n] || (was.enabled !== false) !== d.enabled) out.switches[n] = d.enabled;
  }
  return out;
}
