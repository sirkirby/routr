// Everything routr knows about each harness, in one place: adding a harness is one entry here (and its row in
// references/harnesses.md). Launch flags are measured; see references/harnesses.md.
//   label, executable: how it is named to a person, and the command that starts it.
//   skills: the skills folder it reads, when not the shared ~/.agents/skills (the skill is linked there on install).
//   permissions, model, effort: its permissive flags and model/effort syntax. effortValue(level): the value passed
//     after `effort`, when not the level itself. autoEffort: the effort that means "the model's own default", passed
//     as no flag at all. noEffort: why a separate effort is refused. dirFlag: the flag naming the working directory,
//     for a harness that ignores its current one. env(dir): its environment, given a private config folder.
//     notes(model, effort): what launch tells the orchestrator about this start.
//   confirm: a question it asks at every start because of the permissive flags routr itself passed (not a folder
//     trust), answered with the one option that holds for this session only. showsModel: how to tell from the
//     screen that it took `--model`, for a harness that silently runs its default on an id it does not know.
//   list: its own command that lists model ids; models(): that list, read now (routr keeps no model list of its own).
//   suggested: the settings setup offers for it. usage: `read` runs on every call and must be fast; `check` takes a
//     fresh reading now and prints it raw (`routr usage <name>`).
import { readCursor, refreshCursor } from "./cursor-usage.mjs";
import { readKiro, refreshKiro } from "./kiro-usage.mjs";
import { run } from "./runtime.mjs";
import { readAgy, readClaude, readCodexLive, summarize } from "./usage.mjs";

const lines = async (cmd, args, pattern) => ((await run(cmd, args, { timeoutMs: 20000 })) ?? "").split("\n").map((l) => l.match(pattern)?.[1]).filter(Boolean);

export const HARNESSES = {
  claude: { label: "Claude Code", executable: "claude", skills: ".claude/skills",
    permissions: ["--dangerously-skip-permissions"], model: "--model", effort: "--effort",
    models: async () => ["haiku", "sonnet", "opus"], // aliases Claude Code resolves itself; `--model` also takes full ids
    suggested: { hardest_work: "strong", reserve: 0.25 },
    usage: { read: readClaude } },
  codex: { label: "Codex", executable: "codex",
    permissions: ["--yolo"], model: "-m", effort: "-c", effortValue: (level) => `model_reasoning_effort=${level}`, list: "codex debug models",
    models: async () => { try { const o = JSON.parse(await run("codex", ["debug", "models"], { timeoutMs: 15000 })); return (o.models ?? o).map((m) => m.slug ?? m.id).filter(Boolean); } catch { return null; } },
    suggested: { hardest_work: "strong", reserve: 0.2 },
    usage: { read: readCodexLive } },
  cursor: { label: "Cursor", executable: "cursor-agent",
    permissions: ["--yolo", "--trust"], model: "--model", list: "cursor-agent models",
    noEffort: "cursor has no separate --effort flag; choose a model id with the desired effort",
    env: (dir) => ({ CURSOR_CONFIG_DIR: dir ?? "<private-cursor-config-dir>" }),
    notes: () => ["Cursor changes its configured default model; launch uses a private copy of ~/.cursor/cli-config.json."],
    models: () => lines("cursor-agent", ["models"], /^\s*([a-z0-9][\w.-]+) - /i),
    suggested: { hardest_work: "standard", reserve: 0.1, assumed_headroom: 0.5 },
    usage: { read: readCursor, check: refreshCursor } },
  agy: { label: "Antigravity", executable: "agy",
    permissions: ["--dangerously-skip-permissions"], model: "--model", list: "agy models", dirFlag: "--add-dir",
    noEffort: "agy encodes effort in --model; omit --effort (passing both silently selects HIGH)",
    models: () => lines("agy", ["models"], /^([a-z0-9][\w.-]+)\t/i),
    suggested: { hardest_work: "standard", reserve: 0.1 },
    usage: { read: readAgy } },
  // Kiro CLI 2.24.1, measured 2026-09-26: `--trust-all-tools` asks "Kiro is running in trust all tools mode" with
  // "No, exit" selected; "Yes, and don't ask again" would change the user's Kiro settings, so never that one.
  // `--effort` is per model (kiro.dev/docs/models/effort: the newer Claude and GPT models); a model without it, `auto`
  // included, shows effort "n/a" and ignores the flag silently (measured). Kiro remembers an explicit level as the
  // user's default for that model (its docs), so `auto`, the default, passes none and the model decides.
  kiro: { label: "Kiro", executable: "kiro-cli", skills: ".kiro/skills", // Kiro reads only ~/.kiro/skills (measured)
    permissions: ["chat", "--trust-all-tools"], model: "--model", effort: "--effort", autoEffort: "auto", list: "kiro-cli chat --list-models",
    confirm: { question: /\brunning in trust all tools mode\b/i, answer: /^Yes, I accept$/i, answered: /\bTrust All Tools active\b/i },
    // The footer reads `kiro_default · claude-sonnet-4.5 · ◔ 5%`; with an unknown id it reads `kiro_default · ◔ 5%`.
    showsModel: (screen, model) => screen.split("\n").some((l) => l.split("·").map((s) => s.trim()).includes(model)),
    // Its docs: "start with --effort, and Kiro remembers it for future sessions". Not measured: no model on the
    // measured account took effort.
    notes: (model, effort) => ["Kiro asks to confirm trust-all-tools mode at every start; launch answers \"Yes, I accept\" (this session only).",
      ...(effort ? [`Kiro remembers --effort as the user's default for ${model ?? "this model"} in ~/.kiro/settings/cli.json (its docs say so), and a model without effort ignores it silently: check the model's /effort panel.`] : [])],
    models: async () => { try { return JSON.parse(await run("kiro-cli", ["chat", "--list-models", "--format", "json"], { timeoutMs: 20000 })).models.map((m) => m.model_id).filter(Boolean); } catch { return null; } },
    // Kiro's own router, which its docs recommend and which picks the model per task, and effort left to the model:
    // `auto` passes no --effort, which Kiro would otherwise remember as the user's default for that model.
    suggested: { hardest_work: "standard", reserve: 0.1, default_model: "auto", default_effort: "auto" },
    usage: { read: readKiro, check: refreshKiro } },
};
export const KINDS = Object.keys(HARNESSES);
const KIND_ERROR = `--kind must be ${KINDS.slice(0, -1).join(", ")}, or ${KINDS.at(-1)}`;
export const kindError = () => new Error(KIND_ERROR);
// The harnesses that take a reasoning effort of their own; Cursor and Antigravity model ids carry it.
export const TAKES_EFFORT = KINDS.filter((n) => HARNESSES[n].effort);
// Where the routr skill is installed: the shared folder, then each harness's own.
export const SKILL_FOLDERS = [".agents/skills", ...KINDS.map((n) => HARNESSES[n].skills).filter(Boolean)];
// "Claude Code, Codex, Cursor (cursor-agent), …": the command is named where the name does not already say it.
export const named = (n) => (HARNESSES[n].label.toLowerCase().startsWith(HARNESSES[n].executable) ? HARNESSES[n].label : `${HARNESSES[n].label} (${HARNESSES[n].executable})`);

export function plan({ kind, model, effort, cwd, dryRun = false, cursorConfigDir }) {
  const h = Object.hasOwn(HARNESSES, kind) && HARNESSES[kind];
  if (!h) throw kindError();
  if (!model && !dryRun) throw new Error("--model is required; a worker must not use the harness default");
  if (effort && !h.effort) throw new Error(h.noEffort);
  if (h.dirFlag && !cwd) throw new Error(`${kind} requires a directory for ${h.dirFlag}`);
  if (effort === h.autoEffort) effort = undefined;
  const argv = [...h.permissions, ...(h.dirFlag ? [h.dirFlag, cwd] : []), ...(model ? [h.model, model] : []),
    ...(effort ? [h.effort, h.effortValue?.(effort) ?? effort] : [])];
  return {
    executable: h.executable, argv, env: h.env?.(cursorConfigDir) ?? {},
    warnings: [...(!model ? ["Plan only: choose --model before launching."] : []), ...(h.notes?.(model, effort) ?? [])],
  };
}

// Each harness's usage reader, by name, so doctor, dispatch, and `routr usage` read the same way.
export const SOURCES = Object.fromEntries(KINDS.map((n) => [n, HARNESSES[n].usage]));

// One unreadable source must not take the others (or the routing advice) down with it. Readers run in parallel.
// `given` holds headroom the caller read itself (0..1); it wins over any reading.
// `background` names the subscriptions whose reader may start a background refresh (default: all asked for).
export async function readUsage(names, given = {}, { sources = SOURCES, background = names } = {}) {
  return Promise.all(names.map(async (name) => {
    if (typeof given[name] === "number") return { pool: name, source: "given by caller", given: true, ageSec: 0, windows: [], headroom: Math.min(1, Math.max(0, given[name])) };
    const src = sources[name];
    if (!src?.read) return summarize({ pool: name, source: "none", note: "no usage source: read it yourself and pass --headroom " + name + "=<0..1>" });
    try { return await src.read({ background: background.includes(name) }); } catch (e) { return summarize({ pool: name, source: "unreadable", note: `usage unreadable: ${String(e?.message ?? e).slice(0, 80)}` }); }
  }));
}
