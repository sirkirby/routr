// One vocabulary for herdr and git failures. Callers (including injected transports) cross this boundary before
// inspecting results; process messages and unrecognised structured values never become routr's prose.
import { isAbsolute, win32 } from "node:path";
import { doNext } from "./next.mjs";
import { KINDS } from "./harnesses.mjs";
const states = new Set(["idle", "working", "blocked", "done"]);
export const agentState = (s) => states.has(s) ? s : "unknown";
export const stateWords = (s) => s === "unknown" ? "in a state routr does not know" : s;
const absolutePath = (s) => typeof s === "string" && s.length > 0 && !/[\x00-\x1f\x7f]/.test(s) && (isAbsolute(s) || win32.isAbsolute(s));
const folder = (s) => absolutePath(s) && s.length <= 512;
const id = (s) => typeof s === "string" && s.length > 0;
const knownErrors = new Set(["timeout", "agent_not_running", "agent_not_found", "agent_not_ready", "agent_prompt_stalled", "server_not_running"]);
export function processFailure(tool, args, code, missing = false) {
  const command = (args[0] === "--session" ? args.slice(2) : args).slice(0, 2).join(" ");
  const call = `${tool} ${command}`;
  const why = missing ? "herdr is not installed or not on PATH (herdr_unreachable)." : code.endsWith("unreachable") ? `${call} did not answer (${code}).`
    : code.endsWith("invalid_response") ? `${call} returned an answer routr cannot read (${code}).`
    : `${tool} refused ${command} (${code}).`;
  return { ok: false, code, why, ...(missing ? { missing: true, next: [doNext("Install herdr or put its executable on PATH, then retry this command")] } : {}) };
}
export const processError = (r) => new Error(r.why);
export function herdrResult(args, r) {
  if (r?.ok !== true) {
    const raw = r?.data?.error?.code;
    if (["herdr_unreachable", "herdr_refused", "herdr_invalid_response"].includes(r?.code)) return { ...processFailure("herdr", args, r.code, r.missing === true), data: { error: { ...(knownErrors.has(raw) ? { code: raw } : {}) } } };
    const code = !r || ["timeout", "connect_failed", "server_not_running"].includes(raw) ? "herdr_unreachable" : "herdr_refused";
    return { ...processFailure("herdr", args, code), data: { error: { ...(knownErrors.has(raw) ? { code: raw } : {}) } } };
  }
  const invalid = () => ({ ...processFailure("herdr", args, "herdr_invalid_response"), data: {} });
  let data = r.data;
  if (data?.error || data?.ok === false) return herdrResult(args, { ok: false, data });
  // Private sessions prefix their commands. Validate the actual command in exactly the same way.
  const a = args[0] === "--session" ? args.slice(2) : args;
  const key = a.slice(0, 2).join(" "), v = data?.result;
  if ((data == null || data === "") && key !== "pane read") return { ...processFailure("herdr", args, "herdr_unreachable"), data: {} };
  if ((!data || typeof data !== "object" || Array.isArray(data)) && key !== "pane read") return invalid();
  if (key === "agent get") {
    if (!v || typeof v !== "object") return invalid();
    const g = v.agent;
    if (g != null && (typeof g !== "object" || Array.isArray(g))) return invalid();
    data = { result: { agent: g == null ? null : { agent: KINDS.includes(g.agent) ? g.agent : "another agent",
      agent_status: agentState(g.agent_status), ...(typeof g.interactive_ready === "boolean" ? { interactive_ready: g.interactive_ready } : {}),
      ...(folder(g.foreground_cwd ?? g.cwd) ? { cwd: g.foreground_cwd ?? g.cwd, foreground_cwd: g.foreground_cwd ?? g.cwd } : {}) } } };
  } else if (key === "agent explain") {
    const x = v ?? data;
    if (!x || typeof x !== "object") return invalid();
    if (!Object.hasOwn(x, "state")) return { ok: true, data: {} };
    const rule = x.matched_rule?.id, rules = x.manifest_version;
    data = { state: agentState(x.state), ...(typeof rule === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(rule) ? { matched_rule: { id: rule } } : {}),
      ...(typeof rules === "string" && /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(rules) ? { manifest_version: rules } : {}) };
  } else if (key === "pane process-info") {
    const p = v?.process_info;
    if (!p || !Array.isArray(p.foreground_processes) || p.foreground_processes.some((f) => !f || !Number.isInteger(f.pid)) || !Number.isInteger(p.shell_pid)) return invalid();
    data = { result: { process_info: { shell_pid: p.shell_pid, foreground_processes: p.foreground_processes.map((f) => ({ pid: f.pid,
      // Only a known shell name is needed; arbitrary process names never leave the boundary.
      name: /^(?:bash|zsh|fish|sh|nu|pwsh|powershell|cmd)(?:\.exe)?$/i.test(f.name ?? "") ? f.name : "shell",
      ...(folder(f.cwd) ? { cwd: f.cwd } : {}) })) } } };
  } else if (key === "pane list") {
    if (!Array.isArray(v?.panes) || v.panes.some((p) => !id(p?.pane_id))) return invalid();
    data = { result: { panes: v.panes.map((p) => ({ pane_id: p.pane_id, ...(id(p.workspace_id) ? { workspace_id: p.workspace_id } : {}), agent_status: agentState(p.agent_status) })) } };
  } else if (key === "pane split" || key === "pane current") {
    if (!id(v?.pane?.pane_id)) return invalid();
    data = { result: { pane: { pane_id: v.pane.pane_id } } };
  } else if (key === "pane layout") {
    if (!Array.isArray(v?.layout?.panes) || v.layout.panes.some((p) => !id(p?.pane_id) || !Number.isFinite(p.rect?.width) || !Number.isFinite(p.rect?.height))) return invalid();
    data = { result: { layout: { panes: v.layout.panes.map((p) => ({ pane_id: p.pane_id, rect: { width: p.rect.width, height: p.rect.height } })) } } };
  } else if (key === "worktree create" || key === "workspace create") {
    if (!id(v?.root_pane?.pane_id) || (key === "worktree create" && !absolutePath(v?.worktree?.path))) return invalid();
    data = { result: { root_pane: { pane_id: v.root_pane.pane_id }, ...(key === "worktree create" ? { worktree: { path: v.worktree.path } } : {}),
      ...(id(v.workspace?.workspace_id) ? { workspace: { workspace_id: v.workspace.workspace_id } } : {}) } };
  } else if (key === "worktree list") {
    const source = v?.source?.source_checkout_path ?? v?.source?.repo_root;
    if (!absolutePath(source) || !Array.isArray(v?.worktrees) || v.worktrees.some((w) => !absolutePath(w?.path) || (w.branch != null && !id(w.branch)))) return invalid();
    data = { result: { source: { source_checkout_path: source }, worktrees: v.worktrees.map((w) => ({ path: w.path, branch: w.branch ?? null,
      is_linked_worktree: w.is_linked_worktree === true, is_prunable: w.is_prunable === true, is_detached: w.is_detached === true,
      ...(id(w.open_workspace_id) ? { open_workspace_id: w.open_workspace_id } : {}) })) } };
  } else if (key === "workspace list") {
    if (!Array.isArray(v?.workspaces)) return invalid();
    if (v.workspaces.some((w) => !id(w?.workspace_id) || (w.worktree?.is_linked_worktree && !absolutePath(w.worktree.checkout_path)))) return invalid();
    data = { result: { workspaces: v.workspaces.map((w) => ({ workspace_id: w.workspace_id, ...(w.worktree?.is_linked_worktree ? { worktree: {
      is_linked_worktree: true, checkout_path: w.worktree.checkout_path, ...(absolutePath(w.worktree.repo_root) ? { repo_root: w.worktree.repo_root } : {}) } } : {}) })) } };
  } else if (key === "agent prompt" || key === "agent wait") {
    // Only lifecycle values are permitted to escape a prompt/wait answer.
    data = { result: { ...(v?.state != null ? { state: agentState(v.state) } : {}) } };
  } else if (key === "session list") {
    if (!Array.isArray(data?.sessions) || data.sessions.some((s) => !id(s?.name))) return invalid();
    data = { sessions: data.sessions.map((s) => ({ name: s.name, ...(absolutePath(s.session_dir) ? { session_dir: s.session_dir } : {}) })) };
  } else if (key !== "pane read") data = { result: {} }; // successful actions carry no free text
  return { ok: true, data };
}
export async function callHerdr(run, args, timeout) {
  try { return herdrResult(args, await run(args, timeout)); }
  catch (e) { return { ...processFailure("herdr", args, "herdr_unreachable", e?.code === "ENOENT"), data: {} }; }
}
export async function callGit(run, dir, args) {
  let r;
  try { r = await run(dir, args); } catch {}
  if (!r) return processFailure("git", args, "git_unreachable");
  if (r.code !== 0) return processFailure("git", args, "git_refused");
  const reads = ["rev-parse", "status", "ls-files", "for-each-ref"].includes(args[0]) || args[0] === "worktree" && args[1] === "list";
  const invalid = () => processFailure("git", args, "git_invalid_response");
  if (reads && typeof r.out !== "string") return invalid();
  if (!reads) return { ok: true, code: 0, out: "" };
  const out = r.out;
  const relative = (p) => p.length > 0 && !isAbsolute(p) && !win32.isAbsolute(p) && !p.split(/[\\/]/).some((s) => s === ".." || s === ".");
  const records = out.split("\0").filter(Boolean);
  const status = () => {
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      if (!/^[ MADRCU?!T][ MADRCU?!T] /.test(row) || !relative(row.slice(3))) return false;
      if (/[RC]/.test(row.slice(0, 2)) && !relative(records[++i] ?? "")) return false;
    }
    return true;
  };
  const top = () => { const p = out.replace(/\r?\n$/, ""); return p.length > 0 && !/[\r\n\0]/.test(p) && (isAbsolute(p) || win32.isAbsolute(p)); };
  const valid = args[0] === "rev-parse" && args.includes("--show-toplevel") ? top()
    : args[0] === "rev-parse" ? /^[0-9a-f]{40,64}\s*$/.test(out)
    : args[0] === "status" ? !out || out.endsWith("\0") && status()
    : args[0] === "ls-files" ? !out || out.endsWith("\0") && records.every((s) => /^[A-Za-z?] /.test(s) && relative(s.slice(2)))
    : args[0] === "for-each-ref" ? !out.trim() || out.trim().split("\n").every((s) => /^refs\/(?:heads|remotes|tags)\/\S+$/.test(s))
    : out.trim().split(/\r?\n\r?\n/).every((block) => /^worktree .+\r?\n(?:HEAD [0-9a-f]{40,64}|bare)(?:\r?\n|$)/.test(block)); // a bare repository's own record has no HEAD
  if (!valid) return invalid();
  return { ok: true, code: 0, out };
}

// Recovery from a missing executable is the same in every command, even when the failed read was tolerated.
export function processSteps(out, result) {
  for (const step of result.next ?? []) if (!out.next.some((s) => s.why === step.why)) out.next.push(step);
  return result;
}
