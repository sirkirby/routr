// Every existing command scenario also checks the public envelope and absence of retired fields.
import { expect } from "bun:test";
import * as commands from "../src/lib/commands.mjs";
import { launch as launchCommand } from "../src/lib/launch.mjs";
import { cleanup as cleanupCommand } from "../src/lib/cleanup.mjs";
export * from "../src/lib/commands.mjs";
export * from "../src/lib/launch.mjs";
export * from "../src/lib/cleanup.mjs";
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
