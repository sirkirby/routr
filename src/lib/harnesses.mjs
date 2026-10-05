// Everything routr knows about each harness, in one place: adding a harness is one entry here (and its row in
// references/harnesses.md). Launch flags are measured; see references/harnesses.md.
//   label, executable: how it is named to a person, and the command that starts it. installAs: how the install hint
//     names it ("Cursor (cursor-agent)": the command, where the name does not already say it).
//   skills: the skills folder it reads, when not the shared ~/.agents/skills (routr's skills are linked there on
//     install, when the folder above it exists: that harness is set up on this machine).
//   permissions, model, effort: its permissive flags and model/effort syntax. effortValue(level): the value passed
//     after `effort`, when not the level itself. autoEffort: the effort that means "the model's own default", passed
//     as no flag at all. noEffort: why a separate effort is refused. dirFlag: the flag naming the working directory,
//     for a harness that ignores its current one. env(dir): its environment, given a private config folder.
//     notes(model, effort): what launch tells the orchestrator about this start.
//   startup: what to tell the orchestrator when the harness stops at a question before it can start (routr answers
//     none; herdr reports it blocked). unknownModelRunsDefault: it runs its default model on an id it does not know,
//     without a word, so launch checks the id against its own list (models()) first.
//   list: its own command that lists model ids; models(): that list, read now (routr keeps no model list of its own).
//     openList: the list is a sample, not every id it takes (Claude Code names its aliases; its help says it also takes a model's full name),
//     so an id not on it is not refused.
//     efforts(model): the effort levels it accepts for that model, read from the harness too, or null when it does
//     not say (a harness without `effort` has none: its model ids carry it).
//   auth: how to tell it is signed in (signin.mjs): `check` is its own status command, which never starts a sign-in,
//     `signedIn(out, code)` reads the answer (stdout and stderr together), `signIn` says how the user signs in.
//     Measured signed in and signed out, 2026-09-26; each parser matches the text both ways, not the exit code alone.
//   quiet: the harness's own arguments that keep the user's lifecycle hooks (and MCP servers) out of routr's own read
//     of it. Only Claude Code has them. None found for agy or kiro; Codex's `-c features.hooks=false` is unverified, so
//     it is left out. Where there is none the user's hooks run as configured, which is intended: a tool that records
//     each session (Myco, say) recording routr's read is not a fault.
//   suggested: the settings setup offers for it. usage: `read` runs on every call and must be fast; `check` takes a
//     fresh reading now and prints it raw (`routr usage <name>`). Cursor's and Kiro's readers bring herdr's terminal and
//     their snapshot rules with them, so they load when first read: help, --version, and every command that reads no
//     usage stay light. (Literal import paths, so the compiled binary still bundles them.)
import { run } from "./runtime.mjs";
import { signInHint, signInState } from "./signin.mjs";
import { readAgy, readClaude, readCodexLive, summarize } from "./usage.mjs";

// The levels a help text lists after its --effort flag: "(low, medium, high, xhigh, max)", as Claude Code and Kiro print them.
export const effortsInHelp = (help) => { const m = String(help ?? "").match(/--effort\b[^(]*\((?:e\.g\.\s*)?([a-z]+(?:,\s*[a-z]+)+)\)/i); return m ? m[1].split(/,\s*/) : null; };
// The aliases a help text names for --model: "an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')", as
// Claude Code prints it (2.1.283, 2026-09-26). The flag's description runs until the next flag.
export const modelsInHelp = (help) => {
  const at = String(help ?? "").indexOf("--model <");
  if (at < 0) return null;
  const desc = String(help).slice(at).split(/\n\s*--?[a-z]/i)[0].replace(/\s+/g, " ");
  const aliases = desc.match(/alias[^(]*\(([^)]*)\)/i)?.[1].match(/'([a-z0-9.-]+)'/gi)?.map((q) => q.slice(1, -1));
  return aliases?.length ? aliases : null;
};
// `claude --help`, read once per run: its model aliases and its effort levels come from the same text.
let claudeHelp = null;
const readClaudeHelp = () => (claudeHelp ??= run("claude", ["--help"], { timeoutMs: 10000 }));
// `codex debug models`, read once per run: the model list and each model's own effort levels come from the same answer.
let codexModels = null;
const readCodexModels = () => (codexModels ??= run("codex", ["debug", "models"], { timeoutMs: 15000 }).then((out) => { try { const o = JSON.parse(out); return o.models ?? o; } catch { return null; } }));
const lines = async (cmd, args, pattern) => ((await run(cmd, args, { timeoutMs: 20000 })) ?? "").split("\n").map((l) => l.match(pattern)?.[1]).filter(Boolean);

export const HARNESSES = {
  claude: { label: "Claude Code", executable: "claude", installAs: "Claude Code", skills: ".claude/skills",
    permissions: ["--dangerously-skip-permissions"], model: "--model", effort: "--effort",
    // `"loggedIn": false` and exit 1 when signed out.
    auth: { check: ["auth", "status"], signedIn: (out) => /"loggedIn"\s*:\s*true/.test(out), signIn: "run `claude auth login`" },
    // Its help names the latest aliases (fable, opus, sonnet on 2.1.283); its help says `--model` also takes a model's full name.
    models: async () => modelsInHelp(await readClaudeHelp()), openList: true,
    efforts: async () => effortsInHelp(await readClaudeHelp()),
    // Measured 2.1.284, 2026-09-28: it asks whether to trust a folder not under one already trusted (herdr: blocked at
    // startup), and a git worktree counts as its main repository: a worktree in ~/.herdr/worktrees of a repository under
    // a trusted folder went straight to its prompt.
    startup: "Claude Code asks to trust a folder it has not been told to trust; a worktree counts as its repository. Once the user has trusted the repository in Claude (run `claude` in it and choose Yes), no worker in its worktrees is asked.",
    suggested: { hardest_work: "strong", reserve: 0.25 },
    // routr's own read starts Claude with the user's settings, so a gateway or env set there still applies, but with
    // their hooks and MCP servers off. Measured 2.1.289, 2026-10-05: without the setting the user's SessionStart and
    // SessionEnd hooks ran (seen in --debug-file), with it none did; `--setting-sources=project` also stops them but
    // drops the user's settings. `--strict-mcp-config` with no --mcp-config starts none of their MCP servers, which
    // took the read from 7.1-8.8 s to 4.4-5.2 s wall. `--bare` is no use: it skips the keychain and shows no numbers.
    quiet: ["--settings", '{"disableAllHooks":true}', "--strict-mcp-config"],
    usage: { read: (o) => readClaude({ ...o, quiet: HARNESSES.claude.quiet }) } },
  codex: { label: "Codex", executable: "codex", installAs: "Codex",
    // `-c check_for_update_on_startup=false` (its own config key, for this run only): 2026-09-28 a worker's Codex showed
    // "Update available" just after herdr reported it ready, and the Enter that submitted the task chose "Update now".
    permissions: ["--yolo", "-c", "check_for_update_on_startup=false"], model: "-m", effort: "-c", effortValue: (level) => `model_reasoning_effort=${level}`, list: "codex debug models",
    // "Logged in using ChatGPT" / "Not logged in" (exit 1), both on stderr.
    auth: { check: ["login", "status"], signedIn: (out, code) => code === 0 && /^\s*Logged in\b/m.test(out), signIn: "run `codex login`" },
    // Only the models Codex lists (visibility "list"); each carries its own levels (gpt-5.5 stops at xhigh, measured).
    models: async () => (await readCodexModels())?.filter((m) => m.visibility !== "hide").map((m) => m.slug ?? m.id).filter(Boolean) ?? null,
    efforts: async (model) => (await readCodexModels())?.find((m) => (m.slug ?? m.id) === model)?.supported_reasoning_levels?.map((e) => e.effort ?? e) ?? null,
    suggested: { hardest_work: "strong", reserve: 0.2 },
    usage: { read: readCodexLive } },
  cursor: { label: "Cursor", executable: "cursor-agent", installAs: "Cursor (cursor-agent)",
    permissions: ["--yolo", "--trust"], model: "--model", list: "cursor-agent models",
    noEffort: "cursor has no separate --effort flag; choose a model id with the desired effort",
    env: (dir) => ({ CURSOR_CONFIG_DIR: dir ?? "<private-cursor-config-dir>" }),
    notes: () => ["Cursor changes its configured default model; launch uses a private copy of ~/.cursor/cli-config.json."],
    // "✓ Logged in as <email>" / "Not logged in", and exit 0 BOTH ways: only the text tells.
    auth: { check: ["status"], signedIn: (out) => /\bLogged in as\b/.test(out) && !/\bNot logged in\b/.test(out), signIn: "run `cursor-agent login`" },
    models: () => lines("cursor-agent", ["models"], /^\s*([a-z0-9][\w.-]+) - /i),
    suggested: { hardest_work: "standard", reserve: 0.1, assumed_headroom: 0.5 },
    usage: { read: async (o) => (await import("./cursor-usage.mjs")).readCursor(o), check: async (o) => (await import("./cursor-usage.mjs")).refreshCursor({ ...o, ready: ready("cursor") }) } },
  // Skills: measured 2026-10-05 on agy 1.2.17: asked to list its skills, it named one placed in ~/.gemini/config/skills
  // and none of those in ~/.gemini/antigravity-cli/skills (the folder its web docs name) or ~/.agents/skills (it reads
  // only a workspace's .agents/skills). Its bundled guide and its binary name ~/.gemini/config/skills too.
  agy: { label: "Antigravity", executable: "agy", installAs: "Antigravity (agy)", skills: ".gemini/config/skills",
    permissions: ["--dangerously-skip-permissions"], model: "--model", list: "agy models", dirFlag: "--add-dir",
    noEffort: "agy encodes effort in --model; omit --effort (agy 1.2.11 refuses one that disagrees with the id)",
    // No status command. `agy models` says "Please sign in to view available models" (exit 1) when signed out, and never
    // starts a sign-in; its `-p /usage` DOES (Google's sign-in, waiting for a code), so it is only read once signed in.
    auth: { check: ["models"], signedIn: (out, code) => code === 0 && !/\bsign in\b/i.test(out), signIn: "run `agy` and sign in" },
    models: () => lines("agy", ["models"], /^([a-z0-9][\w.-]+)\t/i),
    suggested: { hardest_work: "standard", reserve: 0.1 },
    usage: { read: readAgy } },
  // Kiro CLI 2.24.1: `--trust-all-tools` asks "Kiro is running in trust all tools mode" at every start, with "No, exit"
  // selected, and herdr reads that screen as idle (2026-09-26/28). `--trust-tools=*` allows every built-in tool (its
  // /tools list: all 14 "allowed") and asks nothing (measured 2026-09-28; MCP tools not measured).
  // `--effort` is per model (kiro.dev/docs/models/effort: the newer Claude and GPT models); a model without it, `auto`
  // included, shows effort "n/a" and ignores the flag silently (measured). Kiro remembers an explicit level as the
  // user's default for that model (its docs), so `auto`, the default, passes none and the model decides.
  kiro: { label: "Kiro", executable: "kiro-cli", installAs: "Kiro (kiro-cli)", skills: ".kiro/skills", // Kiro reads only ~/.kiro/skills (measured)
    permissions: ["chat", "--trust-tools=*"], model: "--model", effort: "--effort", autoEffort: "auto", list: "kiro-cli chat --list-models",
    // 2026-09-26: an unknown id ran its default model without a word (its footer then showed no model). Checked
    // against `kiro-cli chat --list-models` before launch, not read from its screen; drop once Kiro refuses one.
    unknownModelRunsDefault: true,
    // Its docs: "start with --effort, and Kiro remembers it for future sessions". Not measured: no model on the
    // measured account took effort.
    notes: (model, effort) => [...(effort ? [`Kiro remembers --effort as the user's default for ${model ?? "this model"} in ~/.kiro/settings/cli.json (its docs say so), and a model without effort ignores it silently: check the model's /effort panel.`] : [])],
    // `{"accountType":"SocialGitHub","email":…}` / `{"account":null}` (exit 1). Any `chat` command opens a sign-in.
    auth: { check: ["whoami", "--format", "json"], signedIn: (out, code) => code === 0 && /"email"\s*:\s*"[^"]/.test(out), signIn: "run `kiro-cli login`" },
    // Its help lists the levels; `auto` (no flag) leaves effort to the model, and is the only choice a model without levels has.
    efforts: async () => { const l = effortsInHelp(await run("kiro-cli", ["chat", "--help"], { timeoutMs: 10000 })); return l ? ["auto", ...l] : null; },
    models: async () => { try { return JSON.parse(await run("kiro-cli", ["chat", "--list-models", "--format", "json"], { timeoutMs: 20000 })).models.map((m) => m.model_id).filter(Boolean); } catch { return null; } },
    // Kiro's own router, which its docs recommend and which picks the model per task, and effort left to the model:
    // `auto` passes no --effort, which Kiro would otherwise remember as the user's default for that model.
    suggested: { hardest_work: "standard", reserve: 0.1, default_model: "auto", default_effort: "auto" },
    usage: { read: async (o) => (await import("./kiro-usage.mjs")).readKiro(o), check: async (o) => (await import("./kiro-usage.mjs")).refreshKiro({ ...o, ready: ready("kiro") }) } },
};
export const KINDS = Object.keys(HARNESSES);
// Is this harness signed in: "yes", "no", or "no answer"? Kept in the cache between calls (signin.mjs); `fresh` checks
// again now. `notReady` says why a harness gets no work, or null when it is signed in.
export const signIn = (name, o) => signInState(name, HARNESSES[name], o);
export const notReady = async (name, o) => { const state = await signIn(name, o); return state === "yes" ? null : signInHint(HARNESSES[name], state); };
// A refresh's gate: a harness's own reading must never start its sign-in.
const ready = (name) => () => notReady(name);
const KIND_ERROR = `--kind must be ${KINDS.slice(0, -1).join(", ")}, or ${KINDS.at(-1)}`;
export const kindError = () => new Error(KIND_ERROR);
// The harnesses that take a reasoning effort of their own; Cursor and Antigravity model ids carry it.
export const TAKES_EFFORT = KINDS.filter((n) => HARNESSES[n].effort);
// Where routr's skills are installed: the shared folder, then each harness's own.
export const SKILL_FOLDERS = [".agents/skills", ...KINDS.map((n) => HARNESSES[n].skills).filter(Boolean)];
// The skills routr installs, each a folder under skills/ in this repository: the routr skill, and routr-orchestrate,
// which only the user starts (`/routr-orchestrate <plan>`).
export const SKILLS = ["routr", "routr-orchestrate"];


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
// `why(name)`: null when it is signed in, or why not. One that is not is never read (its reading could open a sign-in),
// and dispatch leaves it out (pick.mjs).
export async function readUsage(names, given = {}, { sources = SOURCES, background = names, why = (n) => (HARNESSES[n] ? notReady(n) : null) } = {}) {
  return Promise.all(names.map(async (name) => {
    // Signed in first: a number the caller read cannot put work on a harness that cannot take it (launch refuses it).
    const not = await why(name);
    if (not) return { ...summarize({ pool: name, source: "sign-in check", note: not }), signedIn: false };
    if (typeof given[name] === "number") return { pool: name, source: "given by caller", given: true, ageSec: 0, windows: [], headroom: Math.min(1, Math.max(0, given[name])) };
    const src = sources[name];
    if (!src?.read) return summarize({ pool: name, source: "none", note: "no usage source: read it yourself and pass --headroom " + name + "=<share left, 0.9 or 90%>" });
    try { return await src.read({ background: background.includes(name) }); } catch (e) { return summarize({ pool: name, source: "unreadable", note: `usage unreadable: ${String(e?.message ?? e).slice(0, 80)}` }); }
  }));
}
