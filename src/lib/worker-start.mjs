// What starting a worker of routr's own (headless, or in a core terminal) takes before it runs: what refuses it, nothing
// written yet, and then its run folder and worktree, taken back whole if the start stops before anything ran. Each backend
// adds what it runs and how; `where` says, in its refusals, where this lead is.
import { warning } from "./warnings.mjs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ownedBy, reserve, runDir } from "./worker-record.mjs";
import { copyInto, makeWorktree, newWorktree, unmakeWorktree } from "./worktree.mjs";
import { HARNESSES } from "./harnesses.mjs";
import { configOf } from "./config.mjs";
import { OFF } from "./wording.mjs";
import { home } from "./runtime.mjs";

// A lead's sandbox carries over to what it starts (prototype p36, 2026-10-22): inside Claude Code's Bash sandbox a
// worker could not write routr's state folder or reach api.anthropic.com, and inside Codex's (workspace-write) it could
// not write that folder and `claude` said "Not logged in", its Keychain hidden. Each says it is there.
const SANDBOXES = [["SANDBOX_RUNTIME", "Claude Code's Bash sandbox"], ["CODEX_SANDBOX", "Codex's sandbox"]];
export const sandboxOf = (env) => SANDBOXES.find(([k]) => env[k])?.[1] ?? null;
const SANDBOXED = (which) => `this command runs inside ${which}, and a worker started from there cannot write routr's state or reach its provider; run it outside the sandbox (in Claude Code, as a command the sandbox does not wrap; in Codex, with sandbox_mode danger-full-access or an approved escalation)`;
export const refuseSandbox = (env) => { const sandbox = sandboxOf(env); if (sandbox) throw new Error(SANDBOXED(sandbox)); };
const TAKEN = (name) => `a worker named ${name} exists; finish it with routr cleanup --worker ${name}, or choose another --name`;
export const refuseTaken = (name) => { if (existsSync(runDir(name))) throw new Error(TAKEN(name)); };

// The flags and the task a worker of routr's own needs, or refuses. `where`: "outside herdr", and how it runs there.
export function refuseInputs(o, prompt, { where, runs }) {
  for (const f of ["pane", "direction"]) if (o[f] != null) throw new Error(`--${f} needs herdr; ${where} a worker ${runs}, with no pane`);
  if (prompt == null) throw new Error(`${where} a worker starts with its task: pass --task-file (or --task) and --advice`);
}
// The user's setting for this subscription, its sign-in, and (Kiro) its model id: asked last, as asking a signed-out
// harness anything can open its sign-in.
export async function refuseSettings(o, out, { settings, ready, checkListed = async () => {} }) {
  const loaded = settings(), config = configOf(loaded);
  out.warnings.push(...(loaded.notes ?? []));
  if (config.subscriptions[o.kind]?.enabled === false) throw new Error(OFF.launch(HARNESSES[o.kind].label, o.kind));
  const signedOut = await ready(o.kind);
  if (signedOut) throw new Error(`${HARNESSES[o.kind].label} cannot take work: ${signedOut}`);
  await checkListed();
  return config;
}

// The name reserved and the worktree made, its copies in: `{ dir, wt, unreserve }`. `unreserve` takes back what this
// launch wrote, and nothing started. Only while it is still this reservation's (its token): never a folder another
// launch of that name made since. A failure anywhere here leaves nothing.
export async function takeRun(o, out, plannedTree) {
  let dir, token;
  try { ({ dir, token } = reserve(o.name)); }
  catch (e) {
    if (e?.code === "EEXIST") throw new Error(TAKEN(o.name));
    if (e?.code === "EPERM" || e?.code === "EACCES") throw new Error(SANDBOXED("a sandbox, or a folder routr cannot write"));
    throw e;
  }
  let wt = null;
  const unreserve = async () => { if (wt) await unmakeWorktree(wt, out); try { if (ownedBy(dir, token)) rmSync(dir, { recursive: true, force: true }); } catch {} out.worker = null; };
  try {
    if (plannedTree) {
      wt = newWorktree(o, plannedTree, out.cwd);
      await makeWorktree(wt, out);
      // A worktree holds tracked files only: --copy brings named untracked files across, at the same relative path.
      for (const rel of o.copy ?? []) {
        const from = join(out.cwd, rel);
        if (!existsSync(from)) { out.warnings.push(warning("copy_missing", `--copy ${rel}: not found in ${out.cwd}; skipped`)); continue; }
        copyInto(from, wt.path, rel, wt);
        out.steps.push({ step: "copy", ok: true, detail: `Copied ${rel} into the worktree` });
      }
      out.cwd = wt.path;
      out.worktree = { branch: o.worktree, ...(o.base ? { base: o.base } : {}), path: wt.path, workspace: null };
      out.steps.push({ step: "worktree", ok: true, detail: `Created ${wt.path} on branch ${o.worktree}${o.base ? ` from ${o.base}` : ""}` });
    }
  } catch (e) { await unreserve(); throw e; }
  return { dir, wt, unreserve };
}
// How a record names the worktree a launch made.
export const worktreeRecord = (wt) => (wt ? { worktree: { branch: wt.branch, base: wt.base, path: wt.path, source: wt.source, start: wt.start, folder: wt.folder } } : {});
// Cursor rewrites its config as it runs (its default model, a project folder): it runs on a private copy in the
// run folder, made now from ~/.cursor/cli-config.json as a pane's is, and removed with the run folder.
export const cursorConfigOf = (dir) => join(dir, "cursor-config");
export function privateCursorConfig(dir) {
  const conf = cursorConfigOf(dir);
  mkdirSync(conf, { mode: 0o700 });
  try { copyFileSync(join(home(), ".cursor", "cli-config.json"), join(conf, "cli-config.json")); chmodSync(join(conf, "cli-config.json"), 0o600); }
  catch { throw new Error(`Cursor has no config at ${join(home(), ".cursor", "cli-config.json")}: sign in with \`cursor-agent\` first`); }
}
