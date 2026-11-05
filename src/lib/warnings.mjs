// Codes are assigned at the warning's origin, never inferred from outside text. Keep the public string unchanged.
import { CARRIER_MAX } from "./runtime.mjs";
export const WARNING_CODES = Object.freeze({
  config_missing: "No config; defaults used", config_unreadable: "Config unreadable; defaults used",
  config_share: "Invalid share; default used", config_channel: "Invalid update channel", config_otel: "Invalid export setting",
  config_prefer: "Invalid preferred level", config_hardest: "Missing or invalid hardest work", config_reserve: "Missing or invalid reserve",
  config_choice: "Invalid subscription choice", config_enabled: "Invalid enabled setting", decision_dropped: "Invalid or duplicate decision entry dropped",
  headroom_ignored: "Invalid headroom input ignored", lead_session_ignored: "Invalid lead session ignored", brief_flag: "Flag-like brief input",
  report_short: "Report is very short", advice_unchecked: "Advice not checked against a task", usage_stale: "Usage reader has stopped working",
  kiro_session_left: "Kiro kept an empty usage session", subscription_unconfigured: "Subscription is not configured",
  model_required: "Plan needs a model", cursor_private_config: "Cursor uses a private config", kiro_effort_default: "Kiro remembers effort",
  subagent_effort_version: "Vendor dates subagent effort to Claude Code 2.1.316",
  subagent_fallback_not_passed: "Existing pane or agent keeps its subagent fallback",
  carrier_withheld: "Carrier exceeds forwarding limits", launch_parent_replaced: "Inherited parent replaced by launch span",
  carriers_not_passed: "Launch passed no carriers to an existing or adopted pane", sandbox: "Sandbox may limit harness access",
  branch_unowned: "Branch ownership cannot be proved", worktree_left: "Launch worktree was left", branch_changed: "Launch branch has changed",
  copy_missing: "Requested copy source is missing", messages_dropped: "Stopped worker had queued messages",
  terminal_followed: "A terminal worker is followed with hc", terminal_left: "A finished worker terminal could not be removed", terminal_status_unknown: "The harness reports no status to herdr-core",
  worker_not_shown: "No terminal shows the worker", process_unseen: "Saved process id cannot prove the harness state", cleanup_unseen: "Cleanup sees git state only", launch_history_unreadable: "Launch history could not be read", launch_not_found: "Launch is not in the launch history", headroom_unused: "Given headroom was not used", cleanup_terminals_only: "Cleanup sees git state and core terminals",
  other_worktrees: "Repository has other worktrees", branch_unmerged: "Unmerged branch was kept", detached_unseen: "Detached commands cannot be seen",
  cursor_helper_left: "Cursor owns its worker server", work_kept: "Worker changes remain in the working folder",
  rename_failed: "Adopted agent could not be renamed", cursor_config_left: "Unused Cursor config could not be removed",
  pane_left: "Launch pane was left alive", cursor_config_retained: "Possible worker still needs Cursor config", prompt_uncertain: "Prompt may have been submitted",
});
const origins = new Map();
export function warning(code, text) {
  if (!Object.hasOwn(WARNING_CODES, code) || typeof text !== "string") throw new Error("unregistered warning");
  origins.set(text, code);
  return text;
}
export const warningCode = (text) => origins.get(text);

export const carrierWithheld = (name) => warning("carrier_withheld", `${name} was not passed to the worker: routr passes it only when it is at most ${CARRIER_MAX[name]} bytes of printable ASCII or tabs`);
