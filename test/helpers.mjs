// Shared by several test files: fixtures, fakes, and the scratch folder the preload (setup.mjs) made.
import { chmodSync, copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../src/lib/config.mjs";
// Made by test/setup.mjs, which bunfig.toml preloads for every test file.
export const SCRATCH = process.env.ROUTR_TEST_SCRATCH;
if (!SCRATCH) throw new Error("test/setup.mjs did not run: run the tests from the repository root with `bun test`, so bunfig.toml preloads it");
export const scratch = (name) => mkdtempSync(join(SCRATCH, `${name}-`));
// Session names observed in the harnesses (references/harnesses.md); independent of runtime's removal rule.
export const LEAD_ENV = Object.fromEntries([
  "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_SESSION", "HERDR_BIN_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID",
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SSE_PORT",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TOOL_CALL_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CURSOR_CONVERSATION_ID", "CURSOR_REQUEST_ID", "CURSOR_AGENT",
  "CURSOR_ASKPASS_SOCKET", "CURSOR_ASKPASS_SECRET", "CURSOR_AGENT_STORE_FILES_DIR", "CURSOR_AGENT_STORE_SHARED_PATHS", "CURSOR_SANDBOX", "AGENT_TRANSCRIPTS",
  "ANTIGRAVITY_CONVERSATION_ID", "KIRO_SESSION_ID",
].map((k) => [k, "lead-session"]));
export const CONFIG_ENV = { CODEX_HOME: "/codex-config", CURSOR_CONFIG_DIR: "/cursor-config", CLAUDE_CODE_OAUTH_TOKEN: "fixture-token",
  HERDR_CONFIG_PATH: "/herdr-config", HERDR_LOG: "debug", HERDR_HOME: "/herdr-home", herdr_other: "kept",
  CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "fixture-key", OPENAI_API_KEY: "fixture-key", NOT_HERDR_ENV: "kept",
  SUDO_ASKPASS: "/user-askpass", CODEX_SESSION_ID_EXTRA: "kept", CURSOR_AGENT_EXTRA: "kept", KIRO_SESSION_ID_EXTRA: "kept", ANTIGRAVITY_CONVERSATION_ID_EXTRA: "kept" };
// The CLI as a test spawns it, and the environment it gets: a scratch home, no decision provider key, and whatever `over` adds
// (PATH: home, for a spawn that could otherwise start a harness).
export const SCRIPT = join(import.meta.dir, "../src/routr.mjs");
// A CLI run in a test sees the same environment locally and in CI: the variables that turn telemetry off are dropped
// (CI sets CI and GITHUB_ACTIONS), and a test that wants one passes it in `over`.
const QUIET = ["CI", "GITHUB_ACTIONS", "DO_NOT_TRACK", "ROUTR_TELEMETRY"];
export const cliEnv = (home, over = {}) => {
  const given = { HOME: home, USERPROFILE: home, TYPESAFE_API_KEY: "", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", OLLAMA_HOST: "", ROUTR_DECISION_MODEL: "", ...over };
  // A plain env object can contain both Path and PATH, unlike Windows' process.env. Drop inherited aliases before
  // overriding, so child processes and routr's case-insensitive lookup both see the isolated fake-tool PATH.
  const replaced = new Set([...QUIET, ...Object.keys(given)].map((k) => k.toLowerCase()));
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !replaced.has(k.toLowerCase()))), ...given };
};

export const cfg = (over = {}) => ({ ...DEFAULTS, subscriptions: {
  claude: { hardest_work: "strong", reserve: 0.25, assumed_headroom: 0.5 },
  codex: { hardest_work: "strong", reserve: 0.2, assumed_headroom: 0.5 },
  cursor: { hardest_work: "standard", reserve: 0.1, assumed_headroom: 0.5 },
}, ...over });

export const ans = (score, confidence, kind = "implement", blast = 0.1, kinds = { [kind]: 1 }) =>
  ({ level: { score, confidence, probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 } }, work_type: { choice: kind, confidence: 1, probabilities: kinds }, high_blast_radius: { noul: blast } });

export const live = (pool, headroom) => ({ pool, source: "t", ageSec: 5, windows: [{}], headroom });

export const NOW = 1_800_000_000_000, win = (usedPct, hoursLeft, windowMin = 10080) => ({ name: "seven_day", usedPct, windowMin, resetsAt: NOW / 1000 + hoursLeft * 3600 });

export const none = (pool) => ({ pool, source: "none", ageSec: null, windows: [], headroom: null });

export const fact = (a, over) => ({ ...a, ...Object.fromEntries(Object.entries(over).map(([k, p]) => [k, { noul: p }])) });

export const metered = (pool) => ({ pool, source: "app-server", ageSec: 1, windows: [], headroom: null, class: "metered", note: "metered: unlimited credits, usage is billed, no quota reported" });

export const herdrOK = (result = {}) => ({ ok: true, data: { result } });

export const herdrError = (code) => ({ ok: false, data: { error: { code, message: code } } });

export const shellInfo = (foreground_processes = [{ pid: 1, cwd: process.cwd() }]) => herdrOK({ process_info: { shell_pid: 1, foreground_processes } });

export const row = (over = {}) => ({ ts: "2026-09-21T10:11:12.000Z", id: "abc12345", asked_at: "2026-09-21T10:11:00.000Z", mode: "dispatch", question_set: "r4", brief_sha: "deadbeefcafe", brief_chars: 300,
  advised: { level: "standard", sure: true, between: null, work_type: "research", high_risk: false, fallback: false, facts: { approach_open: 0.9 } },
  headroom: { codex: { usable: 0.3, usage: "live" } }, chose: { subscription: "codex", model: "big-model", effort: "medium", level: "standard" },
  outcome: { verdict: "done", check: "pass", seconds: 60, attempts: 1, note: "private note about the client's billing bug" }, subagents: [{ subtask: "count files in the acme repo", advised: "basic", model: "small-model" }], ...over });
// cmd-shim 9.0.2 (npm 11's bin-links) output for a bin whose first line is `#!/usr/bin/env node`, byte for byte.
export const npmShim = (target) => "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n"
  + 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\n'
  + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

// Fake CLIs on an isolated PATH: a POSIX executable or a recognized npm shim using this test's Bun binary.
// The shim starts the interpreter directly, like herdr.exe, so multiline worker prompts never pass through cmd.exe.
export function fakeExecutable(bin, name, code, { platform = process.platform } = {}) {
  const file = join(bin, name);
  if (platform === "win32") {
    writeFileSync(`${file}.mjs`, code);
    const node = join(bin, "node.exe");
    if (!existsSync(node)) copyFileSync(process.execPath, node);
    writeFileSync(`${file}.cmd`, npmShim(`${name}.mjs`));
  } else { writeFileSync(file, `#!${process.execPath}\n${code}`); chmodSync(file, 0o755); }
}
