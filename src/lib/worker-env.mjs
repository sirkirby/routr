// The environment a harness or a worker process gets, and nothing else: the lead's session variables and the W3C
// trace-context carriers taken out of what a harness inherits, the carriers checked and handed on (and the warnings when
// they are not), the config locations, and what each backend adds on top: a headless turn, a terminal worker's runner,
// a pane routr splits. The pane, headless and terminal backends all build their workers' environments here.
import { warning } from "./warnings.mjs";

// A variable by name, case-insensitively, as Windows' environment is.
export const envGet = (env, name) => { const k = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()); return k ? env[k] : undefined; };

// The environment for harness reads, detached routr jobs, headless turns (through workerEnv) and the private herdr
// server: routr's own,
// without the trace-context carriers (below), and without herdr's pane variables (HERDR_ENV, HERDR_SOCKET_PATH,
// HERDR_PANE_ID, ...). A harness inherits them, and herdr's integration hooks in
// that harness (e.g. ~/.claude/hooks/herdr-agent-state.sh, which acts only when all three are set) would report
// routr's few-second read as an agent session in the user's pane. routr's own herdr calls (herdr.mjs runHerdr,
// scratch-terminal.mjs clients) keep them: herdr needs them to find its session. Windows names are case-insensitive, hence /i.
// The lead's own session variables go too: CLAUDECODE and Claude Code's session and messaging ones make a Claude that
// routr starts take itself for a child of the lead's session, and CODEX_THREAD_ID ties a Codex to the lead's thread
// (measured 2026-10-21: a child otherwise inherited the lead identity). Herdr 0.9.5 binary strings list the eight pane
// names: config (HERDR_CONFIG_PATH, HERDR_HOME, HERDR_LOG) must stay so server and clients use the same settings.
// herdr-core's three terminal names go the same way (seen in an app terminal, hc 0.1.17, 2026-11-03); HC_SESSION, which
// chooses a core, stays. routr's own hc calls keep them (hc.mjs).
// The other harness session names were checked in vendor source and installed binaries
// 2026-10-24 (versions and sources in references/harnesses.md). Exact names, not harness prefixes: sign-in, provider
// and config settings (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, CODEX_HOME, CURSOR_CONFIG_DIR, …) stay.
const LEAD_SESSION = /^(?:HERDR_(?:ENV|SOCKET_PATH|CLIENT_SOCKET_PATH|SESSION|BIN_PATH|WORKSPACE_ID|TAB_ID|PANE_ID)|HC_(?:TERMINAL_ID|TERMINAL_SOCKET|SCOPE)|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(?:ENTRYPOINT|EXECPATH|SESSION_ID|SESSION_ATTENDED|CHILD_SESSION|BRIDGE_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|SSE_PORT)|CODEX_THREAD_ID|CODEX_SESSION_ID|CODEX_TOOL_CALL_ID|CODEX_SANDBOX|CODEX_SANDBOX_NETWORK_DISABLED|CURSOR_CONVERSATION_ID|CURSOR_REQUEST_ID|CURSOR_AGENT|CURSOR_ASKPASS_SOCKET|CURSOR_ASKPASS_SECRET|CURSOR_AGENT_STORE_FILES_DIR|CURSOR_AGENT_STORE_SHARED_PATHS|CURSOR_SANDBOX|AGENT_TRANSCRIPTS|ANTIGRAVITY_CONVERSATION_ID|KIRO_SESSION_ID)$/i;

// W3C trace context, as OpenTelemetry's "environment variables as context propagation carriers" names it: routr hands
// the carriers in its own environment on to workers unchanged when export is off. This transport boundary checks
// opaque strings; traces owns W3C parsing and sampled launch parentage. Harness reads and detached routr jobs get none
// (harnessEnv); a worker start adds the checked ones back (workerEnv).
export const CARRIERS = ["TRACEPARENT", "TRACESTATE", "BAGGAGE"];
const CARRIER = new RegExp(`^(?:${CARRIERS.join("|")})$`, "i");
// routr's own limit on what it hands on, not the W3C grammar: printable ASCII and horizontal tab (Baggage's optional
// whitespace; nothing in the three formats needs more), so no control character reaches a child's environment or
// herdr's argv. Bytes: room for later traceparent versions, W3C's minimum tracestate to propagate, and W3C's minimum
// baggage size, taken here as routr's maximum.
export const CARRIER_MAX = Object.freeze({ TRACEPARENT: 512, TRACESTATE: 512, BAGGAGE: 8192 });
const CARRIER_TEXT = /^[\t\x20-\x7e]*$/;
// Shown in output where a carrier stands: its value never is.
export const FORWARDED = "<forwarded>";
// { carriers, withheld }: those within the limits, by name, and the names of those present but outside them.
// `present(v)` says whether a value counts as there at all. Checked by character first, so a length is a count of bytes.
const checked = (get, present = (v) => v != null && v !== "") => {
  const carriers = {}, withheld = [];
  for (const name of CARRIERS) {
    const v = get(name);
    if (!present(v, name)) continue;
    if (typeof v === "string" && v !== "" && CARRIER_TEXT.test(v) && v.length <= CARRIER_MAX[name]) carriers[name] = v; else withheld.push(name);
  }
  return { carriers, withheld };
};
// The carriers in an environment: by exact name, and case-insensitively on Windows, as its environment is. An empty
// value is absent, as an unset variable.
const carrierIn = (env, name, platform) => (platform === "win32" ? envGet(env, name) : env[name]);
export const carriersFrom = (env = process.env, { platform = process.platform } = {}) => checked((n) => carrierIn(env, n, platform));
// The carriers a worker was saved with (headless worker.json), checked again on every load: only the three names, and
// only own keys; anything else in the object is ignored. Only an absent key is absent: launch saves no other kind, so
// one present that is not a non-empty string (null, "", a number) was changed since, and is withheld and named.
const own = (saved, n) => saved && typeof saved === "object" && !Array.isArray(saved) && Object.hasOwn(saved, n);
export const savedCarriers = (saved) => checked((n) => (own(saved, n) ? saved[n] : undefined), (v, n) => own(saved, n));
// Every carrier value present in an environment, within routr's limits or not: what pane text is redacted of.
export const carrierValues = (env = process.env, { platform = process.platform } = {}) => CARRIERS.map((n) => carrierIn(env, n, platform)).filter((v) => typeof v === "string" && v !== "");
// Pane text (a screen routr returns) with each of `values` replaced by a fixed placeholder. A pane wraps a long line at
// its width, and a terminal may show a TAB as spaces: a value is matched across line breaks, a TAB as spaces too.
// A value split by anything else the screen drew (a colour code inside it) is not matched.
export const CARRIER_SHOWN = "<carrier>";
export function redactCarriers(text, values) {
  if (typeof text !== "string" || !values?.length) return text;
  // Longest first, so a value inside another is not replaced in part.
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    const pattern = [...v].map((c) => (c === "\t" ? "[\t ]+" : c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"))).join("(?:\r?\n)?");
    text = text.replace(new RegExp(pattern, "g"), CARRIER_SHOWN);
  }
  return text;
}
export const harnessEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !LEAD_SESSION.test(k) && !CARRIER.test(k)));
// A worker's environment: the harness environment, the carriers it was given (checked again here, so nothing unchecked
// is ever spread into it), then the adapter's own variables, which win for their keys.
export const workerEnv = (carriers, extra = {}, env = process.env) => ({ ...harnessEnv(env), ...savedCarriers(carriers).carriers, ...extra });

// Where a harness finds its sign-in and settings. A worker in a herdr-core terminal starts from the core's environment,
// not its lead's (measured 2026-11-03, hc 0.1.17: variables set on the `hc run` client did not arrive), so a lead on a
// sandboxed account would get workers on the core's account without these. Exactly these names, only when the caller
// set them, saved with the worker and checked again on every load. Paths: no key or token is among them.
export const CONFIG_LOCATIONS = Object.freeze(["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]);
const LOCATION = /^[^\0-\x1f\x7f]{1,4096}$/;
const locations = (get) => Object.fromEntries(CONFIG_LOCATIONS.map((n) => [n, get(n)]).filter(([, v]) => typeof v === "string" && LOCATION.test(v)));
export const configLocations = (env = process.env, { platform = process.platform } = {}) => locations((n) => carrierIn(env, n, platform));
export const savedConfigLocations = (saved) => locations((n) => (own(saved, n) ? saved[n] : undefined));
// A later layer wins its name; on Windows names differ only by case, so the name it replaces goes too.
const layered = (platform, ...layers) => {
  const out = {}, names = new Map();
  for (const layer of layers) for (const [k, v] of Object.entries(layer)) {
    const key = platform === "win32" ? k.toUpperCase() : k;
    if (names.has(key)) delete out[names.get(key)];
    names.set(key, k); out[k] = v;
  }
  return out;
};
// A terminal worker's environment, as its runner builds it inside the terminal. The terminal's own, through harnessEnv,
// so a lead's identity a core picked up from the shell it started in is gone. Then the runner's own terminal names put
// back: they are this terminal's, not the lead's, and the harness's `hc send` names it by them. Then only what launch saved: the
// checked carriers, the config locations, and the adapter's variables (`adapter`), which win for their keys, so Cursor's
// private config folder beats a caller's CURSOR_CONFIG_DIR. Nothing else of the caller's reaches it.
const TERMINAL_OWN = ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"];
export const terminalEnv = ({ carriers, config, adapter = {} }, env = process.env, { platform = process.platform } = {}) => {
  const mine = Object.fromEntries(TERMINAL_OWN.map((n) => [n, carrierIn(env, n, platform)]).filter(([, v]) => typeof v === "string" && v !== ""));
  return layered(platform, harnessEnv(env), mine, savedCarriers(carriers).carriers, savedConfigLocations(config), adapter);
};

// The warnings for carriers a launch could not hand on: each withheld carrier by name and limit, never its value. A
// TRACEPARENT out of limits under a routr launch span is replaced by that span (traces' launchCarriers says which).
export const carrierWithheld = (name) => warning("carrier_withheld", `${name} was not passed to the worker: routr passes it only when it is at most ${CARRIER_MAX[name]} bytes of printable ASCII or tabs`);
export const launchCarrierWarnings = (found) => found.withheld.map((n) => found.launchSpan && n === "TRACEPARENT"
  ? warning("launch_parent_replaced", "The inherited TRACEPARENT exceeded routr's forwarding limits; the worker gets this routr launch span instead")
  : carrierWithheld(n));

// Trace-context carriers reach only a pane launch splits (herdr's `pane split --env`), beside the caller or in a new
// worktree. In an existing pane (--pane, an adopted agent) this fixed warning says the launch passed none: never that the
// worker has none (a --pane rerun into a pane routr split already has them in its shell), and never with a value.
const PASSED_NONE = (names) => `This launch passed none of ${names.join(", ")} to the worker: an existing pane keeps the environment its shell, or the agent already running there, started with, and routr never types a carrier into a shell`;
// The subagent fallbacks a pane worker's plan carries: its environment without the names the adapter sets for itself.
const fallbacksOf = (plan, adapter) => Object.fromEntries(Object.entries(plan).filter(([k]) => !Object.hasOwn(adapter, k)));
// Like carriers, fallback environment enters only a pane we create, never an assignment in an existing shell;
// a --pane retry keeps the environment that its original split supplied and applies nothing again.
const paneFallbacks = (pane, out, fallbackEnv) => {
  if (!pane) return fallbackEnv;
  for (const k of Object.keys(fallbackEnv)) delete out.start.env[k];
  if (Object.keys(fallbackEnv).length) out.warnings.push(warning("subagent_fallback_not_passed", "This launch passed no subagent environment fallback to the existing pane; its shell or agent keeps the environment it started with, including any fallback from the original split on a retry."));
  return {};
};
// The carriers this launch hands on: a pane it splits (beside the caller, or in a worktree) gets the ones within
// routr's limits, with a warning for each withheld; an existing pane gets none, said once. Only names and FORWARDED
// reach the output.
const paneCarriers = (pane, out, found) => {
  if (!pane) {
    out.warnings.push(...launchCarrierWarnings(found));
    out.start.env = { ...out.start.env, ...Object.fromEntries(Object.keys(found.carriers).map((k) => [k, FORWARDED])) };
    return found.carriers;
  }
  const present = CARRIERS.filter((n) => Object.hasOwn(found.carriers, n) || found.withheld.includes(n));
  if (present.length) out.warnings.push(warning("carriers_not_passed", found.launchSpan
    ? "This launch did not pass its routr launch span or carriers to the worker: an existing pane keeps the environment its shell, or the agent already running there, started with, and routr never types a carrier into a shell"
    : PASSED_NONE(present)));
  return {};
};
// A pane worker's environment, for the split that makes its pane: `carried`, the carriers (`found`, as traces'
// launchCarriers gives them), and `extraEnv`, its subagent fallbacks (`plan`, the plan's environment, less `adapter`, the
// names the harness adapter sets for itself). Both are empty for an existing pane (`pane`, launch --pane); `fallbacks`
// is what the plan had to give either way. Fills `out`, launch's answer: its warnings, and in `out.start.env` each
// carrier shown as FORWARDED.
export const paneEnv = ({ pane, found, plan, adapter = {} }, out) => {
  const fallbackEnv = fallbacksOf(plan, adapter);
  return { carried: paneCarriers(pane, out, found), extraEnv: paneFallbacks(pane, out, fallbackEnv), fallbacks: fallbackEnv };
};
