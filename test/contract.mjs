// Every existing command scenario also checks the public envelope and absence of retired fields.
import { expect } from "bun:test";
import { USAGE_BY_HAND } from "../src/lib/usage-failure.mjs";
import * as commands from "../src/lib/commands.mjs";
import { launch as launchCommand } from "../src/lib/launch.mjs";
import { cleanup as cleanupCommand } from "../src/lib/cleanup.mjs";
export * from "../src/lib/commands.mjs";
export * from "../src/lib/launch.mjs";
export * from "../src/lib/cleanup.mjs";
// The complete moved-sentence table, matched case-insensitively wherever explanatory prose can live.
// Recovery actions belonging to an unavailable entry and harness startup notes remain explanations.
export const MOVED_INSTRUCTIONS = [
  /fix the brief(?: first|:)/i, /start at (?:basic|standard|strong)/i, /go higher if a fact/i,
  /you can: you know the codebase/i, /settle these from the codebase/i,
  /go with (?:basic|standard|strong) unless/i, /do not go below standard/i, /review the result/i,
  /choose a suitable model and effort/i, /hold the work/i, /choose a lower level/i,
  /tell (?:the user|them)\b/i, /ask which subscription to use meanwhile/i,
  /by hand:/i, /read .{0,60}usage by hand/i, /pass --headroom/i,
  /(?:^|[.:;]\s*)(?:if .{0,60}, )?set [`"]?billing:/i, /read capacity yourself/i,
  /inspect (?:it|(?:the )?pane.{0,50}) before (?:closing|retrying)/i,
  /inspect its saved sessions/i, /remove (?:it|the private cursor config.{0,80}) if/i,
  /address (?:it|this worker) by (?:its|the) pane/i,
  /check the model['’]s \/effort panel/i, /plan only: choose --model/i, /choose --model before launching/i,
  /omit --task-file only/i, /say so in --note/i, /revise this row with --run-id/i,
];
export function noMovedInstructions(out) {
  const walk = (value, path = []) => {
    if (path[0] === "next") return;
    if (typeof value === "string" && path.some((p) => ["notes", "note", "why", "warnings"].includes(p)))
      for (const pattern of MOVED_INSTRUCTIONS) expect(value).not.toMatch(pattern);
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
  };
  walk(out);
}
export function contract(r) {
  expect(Object.keys(r).slice(0, 5)).toEqual(["ok", "headline", "unavailable", "warnings", "next"]);
  expect(typeof r.ok).toBe("boolean"); expect(r.headline).toStartWith("routr: ");
  for (const key of ["unavailable", "warnings", "next"]) expect(Array.isArray(r[key])).toBe(true);
  if (Object.hasOwn(r, "error")) { expect(r.ok).toBe(false); expect(typeof r.error).toBe("string"); }
  for (const key of ["command", "planned_command", "argv", "env", "fallback", "rule", "refused", "how", "read_yourself", "recorded", "config_notes", "input_notes", "warning"]) expect(r).not.toHaveProperty(key);
  if (r.mode === "check") expect(r).toHaveProperty("question_set");
  if (r.subscriptions || r.subscription) expect(r).toHaveProperty("level");
  if (r.state && r.state !== "needs_input") expect(r).not.toHaveProperty("needs_input");
  if (r.needs_input) { expect(r.needs_input).not.toHaveProperty("screen"); expect(r.needs_input).not.toHaveProperty("pane"); }
  if (r.state) {
    const lead = r.kind !== undefined ? {
      planned: "routr: planned ", ready: `routr: ${r.name} is ready`, prompted: `routr: ${r.name} (${r.kind}) took its task`,
      needs_input: `routr: ${r.name} needs input`, failed: "routr: launch failed:",
    } : { listed: "routr:", absent: "routr: nothing to remove:", planned: "routr: would ", refused: "routr: kept ", failed: "routr: cleanup failed:", closed: "routr: closed ", removed: "routr: removed " };
    expect(r.headline).toStartWith(lead[r.state]);
    expect(r.headline).not.toContain("undefined");
    expect(r.ok).toBe(!["failed", "needs_input", "refused"].includes(r.state) && !r.error);
    if (r.state === "needs_input") expect(r.headline).toContain(r.needs_input.why);
  }
  noMovedInstructions(r);
  const steps = r.next.map((n) => n.why).join(" ");
  if (r.mode === "dispatch" && r.unavailable.length) expect(steps).toMatch(/tell the user what was unavailable/i);
  for (const u of r.unavailable.filter((u) => u.part === "usage")) {
    if (USAGE_BY_HAND[u.subscription]) expect(r.next).toContainEqual(expect.objectContaining({ template: `--headroom ${u.subscription}=<share left>` }));
    if (u.code === "internal_error") expect(steps).toMatch(/read capacity yourself/i);
  }
  if (r.level === "basic") expect(steps).not.toMatch(/choose a lower level/i);
  if (r.high_risk) expect(steps).toMatch(/do not go below standard.*review the result/i);
  if (r.answers && r.sure === false) expect(steps).toMatch(/start at (basic|standard|strong)/i);
  if (r.subscriptions?.ranked.length && !r.subscriptions.candidates.normal.length && !r.subscriptions.candidates.fallback.length) expect(r.next[0].why).toMatch(/hold the work.*reserve/i);
  const walk = (value, path = []) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "argv") expect(path[0] === "next" || path.join(".") === "start").toBe(true);
      if (key === "reason") throw new Error("excluded reasons must be why");
      walk(child, [...path, key]);
    }
  };
  walk(r);
  return r;
}
export const adviseCommand = async (...a) => contract(await commands.adviseCommand(...a));
export const checkCommand = async (...a) => contract(await commands.checkCommand(...a));
export const recordCommand = (...a) => contract(commands.recordCommand(...a));
export const usageCommand = async (...a) => contract(await commands.usageCommand(...a));
export const launch = async (...a) => contract(await launchCommand(...a));
export const cleanup = async (...a) => contract(await cleanupCommand(...a));
