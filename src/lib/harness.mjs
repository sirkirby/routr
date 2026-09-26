// Measured interactive flags; see references/harnesses.md.
// `confirm`: a question the harness asks at every start because of the permissive flags routr itself passed (not a
// folder trust), answered with the one option that holds for this session only. `showsModel`: how to tell from the
// screen that the harness took `--model`, for a harness that silently runs its default on an id it does not know.
// `list`: the harness's own command that lists its model ids. `autoEffort`: the effort that means "the model's own
// default", passed as no flag at all.
export const HARNESSES = {
  claude: { executable: "claude", permissions: ["--dangerously-skip-permissions"], model: "--model", effort: "--effort" },
  codex: { executable: "codex", permissions: ["--yolo"], model: "-m", effort: "-c", list: "codex debug models" },
  cursor: { executable: "cursor-agent", permissions: ["--yolo", "--trust"], model: "--model", list: "cursor-agent models" },
  agy: { executable: "agy", permissions: ["--dangerously-skip-permissions"], model: "--model", list: "agy models" },
  // Kiro CLI 2.24.1, measured 2026-09-26: `--trust-all-tools` asks "Kiro is running in trust all tools mode" with
  // "No, exit" selected; "Yes, and don't ask again" would change the user's Kiro settings, so never that one.
  // `--effort` is per model (kiro.dev/docs/models/effort: the newer Claude and GPT models); a model without it, `auto`
  // included, shows effort "n/a" and ignores the flag silently (measured). Kiro remembers an explicit level as the
  // user's default for that model (its docs), so `auto`, the default, passes none and the model decides.
  kiro: { executable: "kiro-cli", permissions: ["chat", "--trust-all-tools"], model: "--model", effort: "--effort", autoEffort: "auto", list: "kiro-cli chat --list-models",
    confirm: { question: /\brunning in trust all tools mode\b/i, answer: /^Yes, I accept$/i, answered: /\bTrust All Tools active\b/i },
    // The footer reads `kiro_default · claude-sonnet-4.5 · ◔ 5%`; with an unknown id it reads `kiro_default · ◔ 5%`.
    showsModel: (screen, model) => screen.split("\n").some((l) => l.split("·").map((s) => s.trim()).includes(model)) },
};
export const KINDS = Object.keys(HARNESSES);
const KIND_ERROR = `--kind must be ${KINDS.slice(0, -1).join(", ")}, or ${KINDS.at(-1)}`;
export const kindError = () => new Error(KIND_ERROR);

export function plan({ kind, model, effort, cwd, dryRun = false, cursorConfigDir }) {
  const h = Object.hasOwn(HARNESSES, kind) && HARNESSES[kind];
  if (!h) throw kindError();
  if (!model && !dryRun) throw new Error("--model is required; a worker must not use the harness default");
  if (effort && !h.effort) throw new Error(kind === "agy"
    ? "agy encodes effort in --model; omit --effort (passing both silently selects HIGH)"
    : "cursor has no separate --effort flag; choose a model id with the desired effort");
  if (kind === "agy" && !cwd) throw new Error("agy requires a directory for --add-dir");
  const argv = [...h.permissions];
  if (kind === "agy") argv.push("--add-dir", cwd);
  if (model) argv.push(h.model, model);
  if (effort === h.autoEffort) effort = undefined;
  if (effort) argv.push(h.effort, kind === "codex" ? `model_reasoning_effort=${effort}` : effort);
  return {
    executable: h.executable, argv,
    env: kind === "cursor" ? { CURSOR_CONFIG_DIR: cursorConfigDir ?? "<private-cursor-config-dir>" } : {},
    warnings: [
      ...(!model ? ["Plan only: choose --model before launching."] : []),
      ...(kind === "cursor" ? ["Cursor changes its configured default model; launch uses a private copy of ~/.cursor/cli-config.json."] : []),
      ...(h.confirm ? ["Kiro asks to confirm trust-all-tools mode at every start; launch answers \"Yes, I accept\" (this session only)."] : []),
      // Kiro's docs: "start with --effort, and Kiro remembers it for future sessions" (~/.kiro/settings/cli.json). Not
      // measured: no model on the measured account took effort.
      ...(kind === "kiro" && effort ? [`Kiro remembers --effort as the user's default for ${model ?? "this model"} in ~/.kiro/settings/cli.json (its docs say so), and a model without effort ignores it silently: check the model's /effort panel.`] : []),
    ],
  };
}
