// Measured interactive flags; see references/harnesses.md.
export const HARNESSES = {
  claude: { executable: "claude", permissions: ["--dangerously-skip-permissions"], model: "--model", effort: "--effort" },
  codex: { executable: "codex", permissions: ["--yolo"], model: "-m", effort: "-c" },
  cursor: { executable: "cursor-agent", permissions: ["--yolo", "--trust"], model: "--model" },
  agy: { executable: "agy", permissions: ["--dangerously-skip-permissions"], model: "--model" },
};

export function plan({ kind, model, effort, cwd, dryRun = false, cursorConfigDir }) {
  const h = Object.hasOwn(HARNESSES, kind) && HARNESSES[kind];
  if (!h) throw new Error("--kind must be claude, codex, cursor, or agy");
  if (!model && !dryRun) throw new Error("--model is required; a worker must not use the harness default");
  if (effort && !h.effort) throw new Error(kind === "agy"
    ? "agy encodes effort in --model; omit --effort (passing both silently selects HIGH)"
    : "cursor has no separate --effort flag; choose a model id with the desired effort");
  if (kind === "agy" && !cwd) throw new Error("agy requires a directory for --add-dir");
  const argv = [...h.permissions];
  if (kind === "agy") argv.push("--add-dir", cwd);
  if (model) argv.push(h.model, model);
  if (effort) argv.push(h.effort, kind === "codex" ? `model_reasoning_effort=${effort}` : effort);
  return {
    executable: h.executable, argv,
    env: kind === "cursor" ? { CURSOR_CONFIG_DIR: cursorConfigDir ?? "<private-cursor-config-dir>" } : {},
    warnings: [
      ...(!model ? ["Plan only: choose --model before launching."] : []),
      ...(kind === "cursor" ? ["Cursor changes its configured default model; launch uses a private copy of ~/.cursor/cli-config.json."] : []),
    ],
  };
}
