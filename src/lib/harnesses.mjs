// Everything routr knows about each harness, in one place: adding a harness is one entry here (and its row in
// references/harnesses.md). Launch flags are measured; see references/harnesses.md. Every field below that the rest of
// routr reads is checked on every entry by a test (FIELDS in test/harnesses.test.mjs), so a new harness missing one fails.
//   label, executable: how it is named to a person, and the command that starts it. installAs: how the install hint
//     names it ("Cursor (cursor-agent)": the command, where the name does not already say it). shortLabel: its name in a
//     sentence that names several, or names it again ("Claude", where the label is "Claude Code").
//   app: the name it gives itself in program status, which herdr-core shows (routr-lab p50; Cursor reports none, so
//     "cursor", the name of its icon in the Herdr app).
//   skills: the skills folder it reads, when not the shared ~/.agents/skills (routr's skills are linked there on
//     install, when the folder above it exists: that harness is set up on this machine).
//   permissions, model, effort: its permissive flags and model/effort syntax. effortValue(level): the value passed
//     after `effort`, when not the level itself. autoEffort: the effort that means "the model's own default", passed
//     as no flag at all, and autoEffortMeans what choosing it means, as setup says. noEffort: why a separate effort is refused. dirFlag: the flag naming the working directory,
//     for a harness that ignores its current one. notes(model, effort): what launch tells the orchestrator about this start.
//   remembersEffort: it keeps an explicit effort as the user's default for that model, so launch asks the lead to check
//     the effort in force in this panel of its screen (Kiro's /effort: above its entry).
//   privateConfig: it rewrites its own config as it runs, so every run of it (a worker's, or routr's own usage read)
//     runs on a private copy: `file`, under home, copied into a folder of the run's own (privateConfigCopy) that
//     `variable` names to it (configEnv), removed when the run ends. In a pane, the folder is typed into the pane's own
//     shell, which removes it when the harness exits (herdr.mjs's SHELLS): on a POSIX shell the shell's own command
//     starts it, not herdr's agent start, so herdr learns its name after.
//   otelProvider: its OpenTelemetry `gen_ai.provider.name` on a headless worker's turn (docs/opentelemetry.md): routr's
//     best knowledge of the platform it runs on, not the model's author.
//   subagents({ model, effort }): optional defaults for unnamed subagent choices, as argv/env/warnings. Absent means
//     no setting for all subagents was found; launch refuses either default rather than silently ignoring it.
//   trust(dir): its own flags that trust the worker's folder for this run only and save nothing, where it has them:
//     added to a start with a screen (its headless start asks no folder question), so a worker's tab or pane does not
//     stop at the folder-trust question a headless worker never gets. A harness without them may still ask: its
//     `startup` says how the user avoids that. Measured 2026-11-04, routr-lab p53: without it Codex and Kiro V3 waited
//     at that question reporting no status to herdr-core, so a launch in the Herdr app waited out its timeout.
//   startup: what to tell the orchestrator when the harness stops at a question before it can start (routr answers
//     none; herdr reports it blocked). unknownModelRunsDefault: it runs its default model on an id it does not know,
//     without a word, so launch checks the id against its own list (models()) first.
//   list: its own command that lists model ids; models(): that list, read now (routr keeps no model list of its own).
//     openList: the list is a sample, not every id it takes, so an id not on it is not refused; it says what else it
//     takes (Claude Code names its aliases; its help says it also takes a model's full name).
//     efforts(model): the effort levels it accepts for that model, read from the harness too, or null when it does
//     not say (a harness without `effort` has none: its model ids carry it).
//   auth: how to tell it is signed in (signin.mjs): `check` is its own status command, which never starts a sign-in,
//     `signedIn(out, code)` reads the answer (stdout and stderr together), `signIn` says how the user signs in.
//     Measured signed in and signed out, 2026-09-26; each parser matches the text both ways, not the exit code alone.
//     `billing(out, code)`, optional: what that same answer says about billing: `{ billing: "metered", why }` when
//     it states per-token billing, else null (the usage windows decide, as before). No further call: it is read from
//     the answer routr already asks for, kept with the sign-in answer (signin.mjs), and it settles a reading that
//     brought no windows, never one that did, nor the user's own `billing` (readUsage below, pick.mjs). Only Claude
//     has one: Codex's metered seat already shows in its usage shape (usage.mjs), and the other status answers say
//     nothing about billing (measured 2026-09-26).
//   quiet: the harness's own arguments that keep the user's lifecycle hooks (and MCP servers) out of routr's own read
//     of it. Only Claude Code has them. None found for agy or kiro; Codex's `-c features.hooks=false` is unverified, so
//     it is left out. Where there is none the user's hooks run as configured, which is intended: a tool that records
//     each session (Myco, say) recording routr's read is not a fault.
//   interactive: the words before its permissive flags when it runs with a screen, and only then: Kiro's `--v2 chat`, where
//     its headless start is `acp` (Kiro 3.0: `chat` alone stops at a choice between V3 and V2 on a machine with saved V2
//     sessions, measured 2026-11-03; its docs say a version flag skips that for one launch and saves no default).
//   core: what differs in a herdr-core terminal, over the same fields (`interactive`, `permissions`, `startup`). Core takes
//     status only from the program, and herdr reads the screen, so the two can need different starts. Codex's `--no-daemon`:
//     without it its commands run outside hc (core's manual). Kiro's V3 start: above its entry.
//   promptFlag: the flag before a first message given as an argument, where it is not a plain
//     positional (Antigravity's `-i`; measured 2026-11-03 for all five).
//   noStatus: it reports no status to herdr-core (Cursor 2026.10.22, measured), so only its own `hc send` says it finished.
//   suggested: the settings setup offers for it. usage: `source` names its reader; `read` runs on every call and must be
//     fast; `check` takes a fresh reading now and prints it raw (`routr usage <name>`). `byHand`: how a person reads its
//     usage when routr cannot (said with a failed read, and as a next step). `windows`: the names of the windows its
//     reader produces, the only ones OpenTelemetry export sends. `readHelp`, `checkHelp`: what help says of how it is
//     read, and of what `check` does. `needsHerdrOn`: the platforms where its reader needs herdr, which doctor asks for.
//     `unexplainedNoWindows`: its reader can answer with no windows for a reason routr cannot tell (a seat with no quota,
//     or a plan routr has not seen send them), so doctor asks the person to say how it bills. Cursor's and Kiro's readers bring herdr's terminal and
//     their snapshot rules with them, so they load when first read: help, --version, and every command that reads no
//     usage stay light. (Literal import paths, so the compiled binary still bundles them.)
import { warning } from "./warnings.mjs";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { home } from "./state-files.mjs";
import { run } from "./processes.mjs";
import { billingFromSignIn, keptSignIn, signInHint, signInState } from "./signin.mjs";
import { cachedReadings, keepReadings } from "./usage-cache.mjs";
import { NO_WINDOWS_AFTER_ANSWER, readAgy, readClaude, readCodexLive, summarize, failedUsage, usageReadingTime, withUsageReadingTime } from "./usage.mjs";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// JSON's string escapes are TOML basic-string escapes too, except JSON permits a literal DEL and TOML does not.
const tomlString = (s) => JSON.stringify(s).replaceAll("\x7f", "\\u007f");
// A TOML literal string where the text allows one ('…': no escapes, so no backslash for a shell to collapse: fish reads
// \\ inside single quotes as one), else a basic string. Literal strings hold no ' and no control character.
const tomlText = (s) => (/['\x00-\x08\x0a-\x1f\x7f]/.test(s) ? tomlString(s) : `'${s}'`);

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

// What `claude auth status` says about billing (Claude's `auth.billing`). Measured 2026-10-07 (Claude Code,
// macOS): an API key login prints `"authMethod": "api_key"`, `"apiProvider": "firstParty"` and no
// subscriptionType, and its `/usage` then shows only a session cost summary, no windows: the same as a
// subscription login whose credentials were not available (`--bare`, 2026-10-05). So `/usage` alone cannot tell
// per-token billing from missing credentials, and authMethod can. A subscription login prints `"authMethod":
// "claude.ai"` and a subscriptionType: windows decide. Read from Claude Code's own code (2.1.293), not
// measured: `api_key_helper` is an API key from the user's apiKeyHelper; the apiProvider values its code sets
// for a cloud provider (below) are that provider's account, billed per token by it (its docs); `gateway` is a
// Claude apps gateway, whose spend limit arrives as a window, so it is left to the windows.
// Both are allow-lists: any other value, or one that is not a string, is null (an unknown provider once counted
// as metered, its raw text in the reason). Every reason is a fixed string from these tables, never text from
// the answer, which also carries the email, organisation and ids. Its code always sets authMethod, to one of
// CLAUDE_AUTH (initialised to "none"), and with a cloud provider always to `third_party`; so authMethod is
// checked first, and a cloud provider counts only beside `third_party`. Only an ABSENT apiProvider is
// first-party (an older answer); an explicit null or any non-string is no reading (`null` once read as
// first-party, and a cloud provider once counted whatever authMethod said).
// A usage-based Enterprise seat, measured 2026-10-27 (Claude Code 2.1.311, macOS): `"authMethod": "claude.ai"`,
// `"apiProvider": "firstParty"` and `"subscriptionType": "enterprise"`, with `/usage` showing no windows and only
// credits spent. An Enterprise seat with a quota keeps the same subscriptionType (Anthropic's Team/Enterprise
// article: older Enterprise seats carry limits), so the plan name alone does not decide: this reading applies only
// to a `/usage` that answered with no windows (`when`, withBilling). A failed read stays a failed read.
const CLAUDE_AUTH = new Set(["none", "third_party", "claude.ai", "api_key_helper", "oauth_token", "api_key"]);
const CLAUDE_CLOUD = new Set(["bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle"]);
const CLAUDE_CLOUD_WHY = "Claude Code runs through a cloud provider's account, billed per token by that provider (from its docs, not measured)";
const CLAUDE_ENTERPRISE_WHY = "signed in to a Claude Enterprise seat whose /usage shows no usage windows, billed by usage";
const CLAUDE_KEY_WHY = { api_key: "signed in with an API key, billed per token", api_key_helper: "signed in with an API key from apiKeyHelper, billed per token (not measured)" };
export function claudeBilling(out) {
  const text = String(out ?? "");
  let o = null;
  try { o = JSON.parse(text); } catch { try { o = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch {} }
  if (!o || typeof o !== "object" || Array.isArray(o) || o.loggedIn !== true) return null;
  const auth = o.authMethod;
  if (typeof auth !== "string" || !CLAUDE_AUTH.has(auth)) return null;
  const provider = Object.hasOwn(o, "apiProvider") ? o.apiProvider : "firstParty";
  if (typeof provider !== "string") return null;
  if (CLAUDE_CLOUD.has(provider)) return auth === "third_party" ? { billing: "metered", why: CLAUDE_CLOUD_WHY } : null;
  if (provider !== "firstParty") return null;
  if (auth === "claude.ai") return o.subscriptionType === "enterprise" ? { billing: "metered", why: CLAUDE_ENTERPRISE_WHY, when: "no_windows" } : null;
  if (!Object.hasOwn(CLAUDE_KEY_WHY, auth)) return null;
  return { billing: "metered", why: CLAUDE_KEY_WHY[auth] };
}

export const HARNESSES = {
  claude: { label: "Claude Code", executable: "claude", app: "claude-code", installAs: "Claude Code", shortLabel: "Claude", skills: ".claude/skills", otelProvider: "anthropic",
    permissions: ["--dangerously-skip-permissions"], model: "--model", effort: "--effort",
    // Measured 2.1.316, 2026-11-02: plain Agent and /code-review; both explicit spawn settings beat a differing pair.
    subagents: ({ model, effort }) => ({ env: { ...(model ? { CLAUDE_CODE_SUBAGENT_MODEL: model } : {}), ...(effort ? { CLAUDE_CODE_SUBAGENT_EFFORT: effort } : {}) },
      warnings: effort ? [warning("subagent_effort_version", "Anthropic's 2.1.316 changelog says CLAUDE_CODE_SUBAGENT_EFFORT was added there; earlier versions were not tested.")] : [] }),
    // `"loggedIn": false` and exit 1 when signed out.
    auth: { check: ["auth", "status"], signedIn: (out) => /"loggedIn"\s*:\s*true/.test(out), signIn: "run `claude auth login`", billing: (out) => claudeBilling(out) },
    // Its help names the latest aliases (fable, opus, sonnet on 2.1.283); its help says `--model` also takes a model's full name.
    models: async () => modelsInHelp(await readClaudeHelp()), openList: "takes a model's full name, which it does not list",
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
    usage: { source: "claude /usage", read: (o) => readClaude({ ...o, quiet: HARNESSES.claude.quiet }),
      // Its /usage lines and its statusline's rate_limits (usage.mjs); `spend_limit` behind a Claude apps gateway.
      windows: ["five_hour", "seven_day", "spend_limit"], byHand: "open Claude Code and read /usage, then pass --headroom claude=<share left>",
      readHelp: "Claude Code's is read from its own /usage (hooks and MCP servers off), or from `routr statusline`'s snapshot when one is under 5 minutes old.",
      // Its /usage, or its statusline after a prompt, showed no windows: routr does not guess which plan that is.
      unexplainedNoWindows: true } },
  codex: { label: "Codex", executable: "codex", app: "codex", installAs: "Codex", shortLabel: "Codex", otelProvider: "openai", core: { interactive: ["--no-daemon"] },
    // `-c check_for_update_on_startup=false` (its own config key, for this run only): 2026-09-28 a worker's Codex showed
    // "Update available" just after herdr reported it ready, and the Enter that submitted the task chose "Update now".
    // `--dangerously-bypass-hook-trust`: a hook the user has not trusted in Codex (new, or changed since) opens "Hooks need
    // review" at startup, which herdr reads as idle, so the task's Enter chose "Review hooks" and launch reported a
    // worker that never got it (0.160.0 and 0.161.0, herdr rules 2026.10.01.1, 2026-10-08). With the flag Codex starts
    // at its input box. Cost: every enabled hook, a repository's own .codex/hooks.json included, runs unreviewed in a
    // worker; turning hooks off instead would also stop the user's own (session recorders). In `codex --help` of every
    // npm release checked, 0.135.0 to 0.161.0; older ones not checked.
    // Measured 0.160.0, 2026-10-08: even with --yolo it asks to trust a folder not under a trusted one (herdr: blocked,
    // trust_directory), and the trust given in one worktree applied to its repository: later worktrees were not asked.
    // It has no trust flag. `trust`: its `projects` setting given whole for this run (`-c`, its own override; TOML inline
    // table), naming only the worker's folder. Measured 0.166.0, 2026-11-04: a new repository, and a worktree of one,
    // started at its input box, and ~/.codex/config.toml was unchanged; the dotted form (`projects."<dir>".trust_level`)
    // still asked. For that run its other `projects` entries (other folders' trust) are not read.
    trust: (dir) => ["-c", `projects={${tomlText(dir)}={trust_level="trusted"}}`],
    startup: "routr starts Codex trusting the worker's folder for this run only, saving nothing, so it asks no folder-trust question; a question it asks at start is another one, for you or the user to answer.",
    permissions: ["--yolo", "--dangerously-bypass-hook-trust", "-c", "check_for_update_on_startup=false"], model: "-m", effort: "-c", effortValue: (level) => `model_reasoning_effort=${level}`, list: "codex debug models",
    // Measured 0.166.0, 2026-11-02: these must be TOML strings, including for ids with punctuation (harnesses.md).
    subagents: ({ model, effort }) => ({ argv: [...(model ? ["-c", `agents.default_subagent_model=${tomlString(model)}`] : []),
      ...(effort ? ["-c", `agents.default_subagent_reasoning_effort=${tomlString(effort)}`] : [])] }),
    // "Logged in using ChatGPT" / "Not logged in" (exit 1), both on stderr.
    auth: { check: ["login", "status"], signedIn: (out, code) => code === 0 && /^\s*Logged in\b/m.test(out), signIn: "run `codex login`" },
    // Only the models Codex lists (visibility "list"); each carries its own levels (gpt-5.5 stops at xhigh, measured).
    models: async () => (await readCodexModels())?.filter((m) => m.visibility !== "hide").map((m) => m.slug ?? m.id).filter(Boolean) ?? null,
    efforts: async (model) => (await readCodexModels())?.find((m) => (m.slug ?? m.id) === model)?.supported_reasoning_levels?.map((e) => e.effort ?? e) ?? null,
    suggested: { hardest_work: "strong", reserve: 0.2 },
    // Its rate limits' primary and secondary, a member's monthly cap, and a spend control's stop (codexSnapshot).
    usage: { source: "app-server", read: readCodexLive, windows: ["primary", "secondary", "monthly_cap", "spend_limit"],
      byHand: "open Codex and read /status, then pass --headroom codex=<share left>" } },
  cursor: { label: "Cursor", executable: "cursor-agent", app: "cursor", installAs: "Cursor (cursor-agent)", shortLabel: "Cursor", noStatus: true, otelProvider: "cursor",
    permissions: ["--yolo", "--trust"], model: "--model", list: "cursor-agent models",
    noEffort: "cursor has no separate --effort flag; choose a model id with the desired effort",
    // Seen 2026-09-25: it rewrote cli-config.json (its default model) and added a project folder for the working directory.
    privateConfig: { file: ".cursor/cli-config.json", variable: "CURSOR_CONFIG_DIR" },
    notes: () => [warning("cursor_private_config", "Cursor changes its configured default model; launch uses a private copy of ~/.cursor/cli-config.json.")],
    // Its own long-lived helper, one per project folder, which outlives a headless turn in that turn's process group, and
    // the language server it starts (observed 2026-10-22: references/harnesses.md, "Cursor headless"). Cursor installs as
    // <versions>/<v>/cursor-agent (what the command on PATH links to), and runs the helper as <versions>/<v>/node
    // <versions>/<v>/index.js worker-server: that exact line, in that install, is the helper; neither counts as the
    // worker still running.
    helper: { command: (exe) => { const v = esc(dirname(dirname(exe))); return new RegExp(`^${v}/([^/\\s]+)/node ${v}/\\1/index\\.js worker-server$`); },
      children: [/^npm exec typescript-language-server --stdio$/, /^(\S*\/)?node \S+\/node_modules\/\.bin\/typescript-language-server --stdio$/],
      left: (cwd) => warning("cursor_helper_left", `Cursor's own worker-server for ${cwd} may still be running, as after a cursor-agent run there: it is Cursor's, and routr leaves it`) },
    // "✓ Logged in as <email>" / "Not logged in", and exit 0 BOTH ways: only the text tells.
    auth: { check: ["status"], signedIn: (out) => /\bLogged in as\b/.test(out) && !/\bNot logged in\b/.test(out), signIn: "run `cursor-agent login`" },
    models: () => lines("cursor-agent", ["models"], /^\s*([a-z0-9][\w.-]+) - /i),
    suggested: { hardest_work: "standard", reserve: 0.1 },
    // `check`: `routr usage cursor` reads it now; `fields` are what that answer's `reading` keeps, `used` its headline.
    usage: { source: "cursor /usage", read: async (o) => (await import("./cursor-usage.mjs")).readCursor(o), check: async (o) => (await import("./cursor-usage.mjs")).refreshCursor({ ...o, ready: ready("cursor") }),
      fields: ["plan", "included_used_pct", "auto_used_pct", "api_used_pct", "headroom"], used: (r) => `Included ${r.included_used_pct}% used`, windows: ["included"],
      byHand: 'run `cursor-agent`, type /usage, read "Included N% used", and pass --headroom cursor=<1 - N/100>',
      checkHelp: "takes a fresh reading of Cursor's own /usage screen now, in a private herdr session",
      // Its /usage screen opens in routr's own terminal on macOS and Linux, and in a private herdr session on Windows.
      needsHerdrOn: ["win32"] } },
  // Skills: measured 2026-10-05 on agy 1.2.17: asked to list its skills, it named one placed in ~/.gemini/config/skills
  // and none of those in ~/.gemini/antigravity-cli/skills (the folder its web docs name) or ~/.agents/skills (it reads
  // only a workspace's .agents/skills). Its bundled guide and its binary name ~/.gemini/config/skills too.
  agy: { label: "Antigravity", executable: "agy", app: "antigravity", installAs: "Antigravity (agy)", shortLabel: "Antigravity", skills: ".gemini/config/skills", promptFlag: "-i", otelProvider: "gcp.gen_ai",
    // Measured 2026-11-03 in a core terminal: it reports blocked at this question.
    startup: "Antigravity asks whether to trust a folder it has not been told to trust, and waits at that question.",
    permissions: ["--dangerously-skip-permissions"], model: "--model", list: "agy models", dirFlag: "--add-dir",
    noEffort: "agy encodes effort in --model; omit --effort (agy 1.2.11 refuses one that disagrees with the id)",
    // No status command. `agy models` says "Please sign in to view available models" (exit 1) when signed out, and never
    // starts a sign-in; its `-p /usage` DOES (Google's sign-in, waiting for a code), so it is only read once signed in.
    auth: { check: ["models"], signedIn: (out, code) => code === 0 && !/\bsign in\b/i.test(out), signIn: "run `agy` and sign in" },
    models: () => lines("agy", ["models"], /^([a-z0-9][\w.-]+)\t/i),
    suggested: { hardest_work: "standard", reserve: 0.1 },
    // Its Gemini pool's buckets (readAgy); a bucket it names otherwise is `unknown`, never sent.
    usage: { source: "agy /usage", read: readAgy, windows: ["5h", "weekly"], byHand: "run `agy` and read /usage, then pass --headroom agy=<share left>" } },
  // A pane stays on V2, `--v2 chat --trust-tools=*`: `--trust-tools=*` allows every built-in tool (its /tools list: all 14
  // "allowed") and asks nothing (Kiro CLI 2.24.1, measured 2026-09-28; MCP tools not measured; `--v2` from its docs, not yet
  // measured). herdr's rules do not read V3's questions: measured 2026-11-04 (kiro-cli 3.0.0, herdr 0.9.5), herdr read V3's
  // folder trust as idle and ready, so launch's paste and Enter chose "Trust, continue" for the person, and the task never
  // arrived. Kiro's notice says V2 "will be removed in January": before then a pane needs herdr to recognise V3, or another way.
  // A core terminal runs V3, as core takes status only from the program, and Kiro reports none at that question, so launch
  // returns needs_input. Its V3 screen ignores `--trust-tools` (its docs: honored only with --no-interactive; measured
  // 2026-11-04: a worker asked approval to read its own prompt file), so it takes `--trust-all-tools`, which reads freely
  // after a warning at start with "No, exit" selected, reported as blocked. "Yes, and don't ask again" saves
  // `chat.disableTrustAllConfirmation` in ~/.kiro/settings/cli.json, and the next start in a trusted folder asked nothing.
  // Its folder trust is `--trust-workspace` there (`trust`): "for this launch only (V3 only)... the decision is not
  // saved" (its help). Measured 2026-11-04 in a core terminal: with it Kiro reported idle within 2 s; without it, at the
  // folder question, it reported nothing for 46 s, and an unanswered question wrote nothing under ~/.kiro. routr answers
  // no question: the trust-all-tools warning stays the person's.
  // `--effort` is per model (kiro.dev/docs/models/effort: the newer Claude and GPT models); a model without it, `auto`
  // included, shows effort "n/a" and ignores the flag silently (measured). Kiro remembers an explicit level as the
  // user's default for that model (its docs), so `auto`, the default, passes none and the model decides.
  kiro: { label: "Kiro", executable: "kiro-cli", app: "kiro-cli", installAs: "Kiro (kiro-cli)", shortLabel: "Kiro", skills: ".kiro/skills", otelProvider: "kiro", // Kiro reads only ~/.kiro/skills (measured)
    interactive: ["--v2", "chat"], permissions: ["--trust-tools=*"], model: "--model", effort: "--effort", autoEffort: "auto", autoEffortMeans: "the model decides; nothing is saved in Kiro", list: "kiro-cli chat --list-models",
    // 2026-09-26: an unknown id ran its default model without a word (its footer then showed no model). Checked
    // against `kiro-cli chat --list-models` before launch, not read from its screen; drop once Kiro refuses one.
    unknownModelRunsDefault: true,
    // The trust-all-tools warning is reported as blocked (Kiro 3.0, measured 2026-11-03/04).
    core: { interactive: ["--v3", "chat"], permissions: ["--trust-all-tools"], trust: () => ["--trust-workspace"],
      startup: "routr starts Kiro V3 trusting the worker's folder for this launch only (--trust-workspace, not saved), so it asks no folder-trust question. It may ask whether to run in trust-all-tools mode, for the user to answer: No, exit is selected; Yes, and don't ask again saves the answer, and later starts ask nothing." },
    // Its docs: "start with --effort, and Kiro remembers it for future sessions". Not measured: no model on the
    // measured account took effort.
    remembersEffort: "/effort",
    notes: (model, effort) => [...(effort ? [warning("kiro_effort_default", `Kiro remembers --effort as the user's default for ${model ?? "this model"} in ~/.kiro/settings/cli.json (its docs say so), and a model without effort ignores it silently.`)] : [])],
    // `{"accountType":"SocialGitHub","email":…}` / `{"account":null}` (exit 1). Any `chat` command opens a sign-in.
    auth: { check: ["whoami", "--format", "json"], signedIn: (out, code) => code === 0 && /"email"\s*:\s*"[^"]/.test(out), signIn: "run `kiro-cli login`" },
    // Its help lists the levels; `auto` (no flag) leaves effort to the model, and is the only choice a model without levels has.
    efforts: async () => { const l = effortsInHelp(await run("kiro-cli", ["chat", "--help"], { timeoutMs: 10000 })); return l ? ["auto", ...l] : null; },
    models: async () => { try { return JSON.parse(await run("kiro-cli", ["chat", "--list-models", "--format", "json"], { timeoutMs: 20000 })).models.map((m) => m.model_id).filter(Boolean); } catch { return null; } },
    // Kiro's own router, which its docs recommend and which picks the model per task, and effort left to the model:
    // `auto` passes no --effort, which Kiro would otherwise remember as the user's default for that model.
    suggested: { hardest_work: "standard", reserve: 0.1, default_model: "auto", default_effort: "auto" },
    // A read that leaves its usage session behind says so in `note`: `left` is the warning and the step for it.
    usage: { source: "kiro /usage", read: async (o) => (await import("./kiro-usage.mjs")).readKiro(o), check: async (o) => (await import("./kiro-usage.mjs")).refreshKiro({ ...o, ready: ready("kiro") }),
      fields: ["plan", "credits_used", "credits_limit", "used_pct", "resets_at", "unrecognized_lines", "headroom"], used: (r) => `${r.used_pct}% used`, windows: ["monthly_credits"],
      byHand: 'run `kiro-cli chat --no-interactive /usage`, read "Credits (X of Y covered in plan)", and pass --headroom kiro=<1 - X/Y>',
      checkHelp: "runs Kiro's /usage now and deletes the empty session it leaves",
      left: { warning: () => warning("kiro_session_left", "Kiro kept an empty usage session"), next: "Inspect Kiro's saved sessions to remove the empty usage session" } } },
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
// A harness with a `privateConfig`: the environment naming its private folder `dir` to it (a placeholder in a plan made
// without one), and the folder a run folder keeps it in. Every other harness has none.
export const configEnv = (kind, dir) => { const c = HARNESSES[kind]?.privateConfig; return c ? { [c.variable]: dir ?? `<private-${kind}-config-dir>` } : {}; };
export const privateConfigDir = (kind, runDir) => join(runDir, `${kind}-config`);
// Its private copy: `dir` made for the owner only, and its config file copied in, readable by the owner only, from
// `from` (its own file under home, unless a test or a read names another). Nothing is left when the copy fails, and it
// is never run on its account's own config instead. `failed(error, from)`: the error to throw then; by default one that
// says to sign in, which writes that file (a pane launch keeps the file system's own). A folder that cannot be removed
// never replaces that error: the caller's own cleanup tries again and says what was left (a pane's `cursor_config_left`).
const signInFirst = (kind) => (_, from) => new Error(`${HARNESSES[kind].label} has no config at ${from}: sign in with \`${HARNESSES[kind].executable}\` first`);
export function privateConfigCopy(kind, dir, { from = join(home(), HARNESSES[kind].privateConfig.file), failed = signInFirst(kind), remove = rmSync } = {}) {
  const to = join(dir, basename(HARNESSES[kind].privateConfig.file));
  mkdirSync(dir, { mode: 0o700 });
  try { copyFileSync(from, to); chmodSync(to, 0o600); }
  catch (e) { try { remove(dir, { recursive: true, force: true }); } catch {} throw failed(e, from); }
  return dir;
}
// Where routr's skills are installed: the shared folder, then each harness's own.
export const SKILL_FOLDERS = [".agents/skills", ...KINDS.map((n) => HARNESSES[n].skills).filter(Boolean)];
// The skills routr installs, each a folder under skills/ in this repository: the routr skill, and routr-orchestrate,
// which only the user starts (`/routr-orchestrate <plan>`).
export const SKILLS = ["routr", "routr-orchestrate"];


export const MODEL_REQUIRED = "--model is required; a worker must not use the harness default";
export function subagentDefaults({ kind, subagentModel, subagentEffort }) {
  const h = Object.hasOwn(HARNESSES, kind) && HARNESSES[kind];
  if (!h) throw kindError();
  if ((subagentModel || subagentEffort) && !h.subagents) throw new Error(`${h.label} (${kind}) has no setting for all subagents; --subagent-model and --subagent-effort are unsupported`);
  return { argv: [], env: {}, warnings: [], ...(h.subagents?.({ model: subagentModel, effort: subagentEffort }) ?? {}) };
}
// `interactive: false`: the flags for a headless start, which has words of its own in place of `interactive`. `core`: as it
// starts in a herdr-core terminal. `cursorConfigDir`: the private folder of a harness with a `privateConfig` (configEnv).
export function plan({ kind, model, effort, cwd, dryRun = false, cursorConfigDir, subagentModel, subagentEffort, interactive = true, core = false }) {
  const h = Object.hasOwn(HARNESSES, kind) && HARNESSES[kind];
  if (!h) throw kindError();
  const subagents = subagentDefaults({ kind, subagentModel, subagentEffort });
  if (!model && !dryRun) throw new Error(MODEL_REQUIRED);
  if (effort && !h.effort) throw new Error(h.noEffort);
  if (h.dirFlag && !cwd) throw new Error(`${kind} requires a directory for ${h.dirFlag}`);
  if (effort === h.autoEffort) effort = undefined;
  const start = core ? { ...h, ...h.core } : h;
  const argv = [...(interactive ? start.interactive ?? [] : []), ...start.permissions, ...(interactive && start.trust && cwd ? start.trust(cwd) : []), ...(h.dirFlag ? [h.dirFlag, cwd] : []), ...(model ? [h.model, model] : []),
    ...(effort ? [h.effort, h.effortValue?.(effort) ?? effort] : []), ...subagents.argv];
  return {
    executable: h.executable, argv, env: { ...configEnv(kind, cursorConfigDir), ...subagents.env },
    warnings: [...(!model ? [warning("model_required", "Plan only: choose --model before launching.")] : []), ...(h.notes?.(model, effort) ?? []), ...subagents.warnings],
  };
}

// What a harness runs with in a herdr-core terminal: its plan there, and its first message as an argument. That message is never the brief: `hc` keeps a terminal's argv, and `ps` shows it (p50).
export const terminalPlan = (o, firstMessage) => {
  const h = HARNESSES[o.kind], p = plan({ ...o, core: true });
  return { ...p, argv: [...p.argv, ...(h.promptFlag ? [h.promptFlag] : []), firstMessage] };
};

// Each harness's usage reader, by name, so doctor, dispatch, and `routr usage` read the same way.
export const SOURCES = Object.fromEntries(KINDS.map((n) => [n, HARNESSES[n].usage]));

// One unreadable source must not take the others (or the routing advice) down with it. Readers run in parallel.
// `given` holds headroom the caller read itself (0..1); it wins over any reading.
// `background` names the subscriptions whose reader may start a background refresh (default: all asked for).
// `why(name)`: null when it is signed in, or why not. One that is not is never read (its reading could open a sign-in),
// and dispatch leaves it out (pick.mjs). `billing(name, { fresh })`: `{ billing, not }`, what its sign-in answer said
// about billing (signin.mjs, kept beside `why`'s answer) or null, and, when it was asked again, why it is not signed
// in now (null when it is).
export async function readUsage(names, given = {}, { sources = SOURCES, background = names, why = (n) => (HARNESSES[n] ? notReady(n) : null), billing = billingFor, observe = (read) => read(), keep = keepReadings } = {}) {
  // What its sources read, before billing settles it, is kept for the reads that must not wait (cachedUsage, below):
  // they settle billing again from the kept sign-in answer, as this does.
  const read = [], rows = await readEach(names, given, { sources, background, why, billing, observe, read });
  keep(read);
  return rows;
}
const signedOut = (name, note) => ({ ...summarize({ pool: name, source: "sign-in check", note }), signedIn: false });
function readEach(names, given, { sources, background, why, billing, observe, read = [] }) {
  return Promise.all(names.map((name) => observe(async () => {
    const src = sources[name], source = src?.source ?? name;
    try {
      // Signed in first: a number the caller read cannot put work on a harness that cannot take it (launch refuses it).
      const not = await why(name);
      if (not) return signedOut(name, not);
      if (typeof given[name] === "number") return { pool: name, source: "given by caller", given: true, ageSec: 0, windows: [], headroom: Math.min(1, Math.max(0, given[name])) };
      let u;
      if (!src?.read) u = failedUsage(name, source, "source_missing");
      else try { u = await src.read({ background: background.includes(name) }); } catch { u = failedUsage(name, source); }
      read.push(u);
      // The billing reading settles only a reading without windows, and then it must be today's: a sign-in kept for 6
      // hours can predate a switch between a subscription and an API key (a switch an hour in still ranked the
      // old way). So in exactly that case the status check runs again now. With windows there is no call. That
      // check is a sign-in check too: unless it answers signed in, this call leaves the harness out, as any
      // signed-out one (a fresh "loggedIn": false still left it a candidate with unknown room).
      const b = await billing(name, { fresh: u?.headroom == null });
      if (b?.not) return signedOut(name, b.not);
      return withBilling(name, u, b?.billing);
    } catch { return failedUsage(name, source); }
  })));
}

// Usage that must not wait: each subscription's last kept reading (usage-cache.mjs), aged to now, with no harness
// called, no status check run. A harness whose kept sign-in answer says it is not signed in is out, as in readUsage;
// one with no kept reading is unknown (`not_read_yet`) while a detached `routr usage` (with `configPath`, the caller's
// `--config`) reads it. Billing is settled from the kept sign-in answer, as readUsage settles it from the same answer
// (without asking again: nothing here waits). `refreshing` says a read was started.
export function cachedUsage(names, { cache = cachedReadings, signIn = keptSignIn, configPath } = {}) {
  const { rows, refreshing } = cache(names, { configPath });
  return { refreshing, rows: names.map((name) => {
    const { state, billing } = signIn(name) ?? {};
    if (HARNESSES[name] && state && state !== "yes") return signedOut(name, signInHint(HARNESSES[name], state));
    return withBilling(name, rows.find((r) => r.pool === name) ?? failedUsage(name, SOURCES[name]?.source ?? name, "not_read_yet"), billing);
  }) };
}

// What the harness's sign-in status says about billing: the kept answer, or with `fresh` its status check run again
// now, bypassing the cache and updating it (signin.mjs, the same probe and timeout). Only a harness with an
// `auth.billing` reader is asked again; when that answer is not "signed in", `not` says why (signInHint) and there is
// no billing reading. `harness` and the rest are signin.mjs's seams, for tests.
export async function billingFor(name, { fresh = false, harness = HARNESSES[name], ...o } = {}) {
  if (fresh && harness?.auth?.billing) {
    const state = await signInState(name, harness, { ...o, fresh: true });
    if (state !== "yes") return { billing: null, not: signInHint(harness, state) };
  }
  return { billing: billingFromSignIn(name), not: null };
}

// A reading, settled by what the harness's own status said about billing (`auth.billing`). With no windows it is that
// class, the status command its source, and the reason its note: an API-key Claude is `metered` instead of "no
// windows, set billing yourself" (measured 2026-10-07: its /usage cannot tell). Windows that did arrive are kept, and
// the disagreement is noted, not resolved by a guess. The user's own `billing` still wins over this (pick.mjs).
export function withBilling(name, u, b) {
  if (b?.billing !== "metered" || !u) return u;
  // A reading that holds only when the seat answered with no windows (an Enterprise login) leaves windows, and a
  // read that failed, as they are: a failed read can carry the reason from an old snapshot, and is still a failure.
  if (b.when === "no_windows" && (u.reason !== NO_WINDOWS_AFTER_ANSWER || u.failure)) return u;
  const from = HARNESSES[name] ? `${HARNESSES[name].executable} ${HARNESSES[name].auth.check.join(" ")}` : "sign-in check";
  if (u.headroom != null) return withUsageReadingTime({ ...u, note: [u.note, `\`${from}\` says ${b.why}, yet usage windows arrived: ranked on the windows`].filter(Boolean).join("; ") }, usageReadingTime(u));
  const rest = { ...u };
  delete rest.reason; // the "no windows" reason asks the user to set billing, which is now known
  return { ...rest, source: from, class: "metered", billing: { billing: "metered", why: b.why, source: from }, note: `metered: ${b.why}` };
}
