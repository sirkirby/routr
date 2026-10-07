// cleanup.mjs: finishing a worker, its worktree or its pane, without losing anything in it
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, parseCleanupArgs, parseStatus, sameFile } from "../src/lib/cleanup.mjs";
import { herdrError, herdrOK, scratch } from "./helpers.mjs";

test("cleanup names one worker, by branch, folder, or pane; --delete-branch only for a worktree", () => {
  expect(parseCleanupArgs(["--cwd", "/r", "--worktree", "feat/x", "--delete-branch"])).toMatchObject({ cwd: "/r", worktree: "feat/x", deleteBranch: true, dryRun: false });
  expect(parseCleanupArgs([])).toMatchObject({ dryRun: false });
  for (const bad of [["--worktree", "a", "--pane", "w1:p1"], ["--worktree", "-a"], ["--worktree", "a b"], ["--pane", "w1:p1", "--delete-branch"],
    ["--pane", "w1:p1", "--cwd", "/r"], ["--force"], ["--worktree", "a", "--worktree", "b"], ["--path"]]) expect(() => parseCleanupArgs(bad)).toThrow();
});

test("git status -z: changes, untracked files, and a rename's second path", () => {
  expect(parseStatus(" M a.txt\0?? new.txt\0R  b.txt\0old.txt\0?? dir/c.txt\0")).toEqual({ changed: ["a.txt", "b.txt"], untracked: ["new.txt", "dir/c.txt"] });
  expect(parseStatus("")).toEqual({ changed: [], untracked: [] });
});

test("a copy is the same bytes, or the same link; anything else is not", () => {
  const d = scratch("same");
  writeFileSync(join(d, "a"), "x"); writeFileSync(join(d, "b"), "x"); writeFileSync(join(d, "c"), "y");
  symlinkSync("a", join(d, "l1")); symlinkSync("a", join(d, "l2")); symlinkSync("c", join(d, "l3"));
  expect([sameFile(join(d, "a"), join(d, "b")), sameFile(join(d, "a"), join(d, "c")), sameFile(join(d, "a"), join(d, "none"))]).toEqual([true, false, false]);
  expect([sameFile(join(d, "l1"), join(d, "l2")), sameFile(join(d, "l1"), join(d, "l3")), sameFile(join(d, "l1"), join(d, "a"))]).toEqual([true, false, false]);
});

// One repository with its main checkout and the worktrees given; `panes` per workspace; git answers from `status`
// (per worktree path), `contains` (detached HEADs a ref holds), and `merged` (branches -d may delete).
function fake({ worktrees = [], panes = {}, status = {}, contains = [], merged = [], removeFails = null } = {}) {
  const calls = [], gits = [];
  const source = "/repo";
  const deps = {
    env: { HERDR_PANE_ID: "w1:p1" },
    run: async (a) => {
      calls.push(a);
      if (a[0] === "worktree" && a[1] === "list") return herdrOK({ source: { source_checkout_path: source }, worktrees: [{ branch: "main", path: source, is_linked_worktree: false, open_workspace_id: "w1" }, ...worktrees] });
      if (a[0] === "pane" && a[1] === "list") return herdrOK({ panes: a[2] === "--workspace" ? panes[a[3]] ?? [] : Object.values(panes).flat() });
      if (a[0] === "pane" && a[1] === "process-info") return herdrOK({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } });
      if (a[0] === "workspace" && a[1] === "list") return herdrOK({ workspaces: worktrees.filter((w) => w.open_workspace_id).map((w) => ({ workspace_id: w.open_workspace_id, worktree: { is_linked_worktree: true, checkout_path: w.path, repo_root: source } })) });
      if (a[0] === "worktree" && a[1] === "remove") return removeFails ? herdrError(removeFails) : herdrOK({ type: "worktree_removed" });
      if (a[0] === "pane" && a[1] === "close") return herdrOK({ type: "ok" });
      throw new Error(`Unexpected herdr ${a.join(" ")}`);
    },
    git: async (dir, a) => {
      gits.push([dir, ...a]);
      if (a[0] === "status") return { out: status[dir] ?? "", err: "", code: 0 };
      if (a[0] === "for-each-ref") return { out: contains.includes(dir) ? "refs/heads/x\n" : "", err: "", code: 0 };
      if (a[0] === "worktree" && a[1] === "remove") return { out: "", err: "", code: 0 };
      if (a[0] === "branch") return merged.includes(a[2]) ? { out: "Deleted", err: "", code: 0 } : { out: "", err: `error: the branch '${a[2]}' is not fully merged\nhint: run git branch -D`, code: 1 };
      throw new Error(`Unexpected git ${a.join(" ")}`);
    },
  };
  return { calls, gits, deps };
}
const wt = (branch, over = {}) => ({ branch, path: `/wt/${branch}`, is_linked_worktree: true, open_workspace_id: null, ...over });
const idle = (pane_id, agent_status = "idle") => ({ pane_id, agent_status });

test("a finished worker's worktree is removed through herdr when its workspace is open, through git when it is not", async () => {
  const f = fake({ worktrees: [wt("open", { open_workspace_id: "w5" }), wt("orphan")], panes: { w5: [idle("w5:p1", "done")] } });
  const r = await cleanup(["--cwd", "/repo", "--worktree", "open"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "removed", worktree: { branch: "open", workspace: "w5" }, branch: { name: "open", deleted: false } });
  expect(f.calls).toContainEqual(["worktree", "remove", "--workspace", "w5"]); // never --force
  const o = await cleanup(["--cwd", "/repo", "--worktree", "orphan"], f.deps);
  expect(o).toMatchObject({ ok: true, state: "removed" });
  expect(f.gits).toContainEqual(["/repo", "worktree", "remove", "/wt/orphan"]);
  expect(f.gits.flat()).not.toContain("--force");
});

test("cleanup refuses while anything runs, and never removes work: changes, new files, a commit on no branch", async () => {
  const f = fake({
    worktrees: [wt("working", { open_workspace_id: "w5" }), wt("asking", { open_workspace_id: "w6" }), wt("mine", { open_workspace_id: "w7" }), wt("dirty"), wt("made"), wt(null, { path: "/wt/lost", is_detached: true }), wt(null, { path: "/wt/held", is_detached: true })],
    panes: { w5: [idle("w5:p1", "working")], w6: [idle("w6:p1", "blocked")], w7: [idle("w1:p1")] },
    status: { "/wt/dirty": " M src/a.mjs\0", "/wt/made": "?? notes.md\0" }, contains: ["/wt/held"],
  });
  const why = async (...a) => { const r = await cleanup(["--cwd", "/repo", ...a], f.deps); expect(r).toMatchObject({ ok: false, state: "refused" }); return r.refused.why; };
  expect(await why("--worktree", "working")).toContain("working");
  expect(await why("--worktree", "asking")).toContain("waiting at a question");
  expect(await why("--worktree", "mine")).toContain("your own pane");
  expect(await why("--worktree", "dirty")).toContain("src/a.mjs");
  expect(await why("--worktree", "made")).toContain("notes.md");
  expect(await why("--path", "/wt/lost")).toContain("no branch or tag holds");
  expect(await why("--worktree", "main")).toContain("main checkout");
  expect(f.calls.filter((a) => a[1] === "remove")).toHaveLength(0);
  expect(await cleanup(["--cwd", "/repo", "--path", "/wt/held"], f.deps)).toMatchObject({ ok: true, state: "removed" });
});

test("files copied in at launch and left unchanged go with the worktree; a changed copy stays", async () => {
  const root = scratch("copies"), repo = join(root, "repo"), w = join(root, "w");
  for (const d of [repo, w, join(repo, "fx"), join(w, "fx")]) mkdirSync(d, { recursive: true });
  for (const d of [repo, w]) { writeFileSync(join(d, "fx", "data.json"), "{}"); writeFileSync(join(d, ".env.test"), "A=1"); }
  const f = fake({ worktrees: [wt("copied", { path: w })], status: { [w]: "?? fx/data.json\0?? .env.test\0" } });
  f.deps.run = ((run) => async (a) => (a[1] === "list" && a[0] === "worktree" ? herdrOK({ source: { source_checkout_path: repo }, worktrees: [wt("copied", { path: w })] }) : run(a)))(f.deps.run);
  const plan = await cleanup(["--cwd", repo, "--worktree", "copied", "--dry-run"], f.deps);
  expect(plan).toMatchObject({ ok: true, state: "planned" }); expect(existsSync(join(w, ".env.test"))).toBe(true);
  writeFileSync(join(w, ".env.test"), "A=2");
  expect(await cleanup(["--cwd", repo, "--worktree", "copied"], f.deps)).toMatchObject({ state: "refused" });
  writeFileSync(join(w, ".env.test"), "A=1");
  expect(await cleanup(["--cwd", repo, "--worktree", "copied"], f.deps)).toMatchObject({ ok: true, state: "removed" });
  expect([existsSync(join(w, ".env.test")), existsSync(join(w, "fx", "data.json"))]).toEqual([false, false]);
});

test("--delete-branch deletes a merged branch and keeps one that is not, saying why", async () => {
  const f = fake({ worktrees: [wt("landed"), wt("open-work")], merged: ["landed"] });
  expect(await cleanup(["--cwd", "/repo", "--worktree", "landed", "--delete-branch"], f.deps)).toMatchObject({ ok: true, branch: { name: "landed", deleted: true } });
  const kept = await cleanup(["--cwd", "/repo", "--worktree", "open-work", "--delete-branch"], f.deps);
  expect(kept).toMatchObject({ ok: true, state: "removed", branch: { name: "open-work", deleted: false } });
  expect(kept.warnings[0]).toContain("not fully merged"); expect(kept.warnings[0]).not.toContain("hint");
  expect(f.gits.filter((g) => g[1] === "branch").map((g) => g[2])).toEqual(["-d", "-d"]); // never -D
});

test("a race after the check leaves the worktree: herdr's refusal is reported, not forced", async () => {
  const f = fake({ worktrees: [wt("racy", { open_workspace_id: "w5" })], panes: { w5: [idle("w5:p1")] }, removeFails: "dirty_worktree_requires_force" });
  expect(await cleanup(["--cwd", "/repo", "--worktree", "racy", "--delete-branch"], f.deps)).toMatchObject({ ok: false, state: "refused" });
  expect(f.gits.some((g) => g[1] === "branch")).toBe(false);
});

test("with no worker named, cleanup lists every worktree and what it would do, and changes nothing", async () => {
  const f = fake({ worktrees: [wt("done"), wt("dirty"), wt("gone", { is_prunable: true })], status: { "/wt/dirty": " M a\0" } });
  const r = await cleanup(["--cwd", "/repo"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "listed" });
  expect(r.worktrees.map((w) => [w.branch, w.removable])).toEqual([["done", true], ["dirty", false], ["gone", true]]);
  expect(r.then).toContain("routr cleanup --cwd /repo --path <path>");
  expect(f.calls.some((a) => ["remove", "close"].includes(a[1]))).toBe(false);
  expect(f.gits.some((g) => ["worktree", "branch"].includes(g[1]))).toBe(false);
});

test("a name that matches nothing removes nothing and names what is there", async () => {
  const r = await cleanup(["--cwd", "/repo", "--worktree", "typo"], fake({ worktrees: [wt("real")] }).deps);
  expect(r).toMatchObject({ ok: true, state: "absent" });
  expect(r.warnings[0]).toContain("real");
});

test("--pane closes a worker's split pane, never its worktree's only pane or a busy one", async () => {
  const f = fake({ worktrees: [wt("solo", { open_workspace_id: "w5" })], panes: { w1: [idle("w1:p1"), idle("w1:p2", "done"), idle("w1:p3", "working")], w5: [idle("w5:p1")] } });
  f.deps.run = ((run) => async (a) => (a[0] === "pane" && a[1] === "list" && a.length === 2
    ? herdrOK({ panes: [{ ...idle("w1:p2", "done"), workspace_id: "w1" }, { ...idle("w1:p3", "working"), workspace_id: "w1" }, { ...idle("w5:p1"), workspace_id: "w5" }] }) : run(a)))(f.deps.run);
  expect(await cleanup(["--pane", "w1:p2"], f.deps)).toMatchObject({ ok: true, state: "closed" });
  expect(f.calls).toContainEqual(["pane", "close", "w1:p2"]);
  expect((await cleanup(["--pane", "w1:p3"], f.deps)).refused.why).toContain("working");
  const solo = await cleanup(["--pane", "w5:p1"], f.deps);
  expect(solo.refused.then).toBe("routr cleanup --cwd /repo --path /wt/solo");
  expect(await cleanup(["--pane", "w9:p9"], f.deps)).toMatchObject({ ok: true, state: "absent" });
  expect(f.calls.filter((a) => a[1] === "close")).toHaveLength(1);
});

test("herdr out of reach fails with what happened, and removes nothing", async () => {
  const r = await cleanup(["--cwd", "/repo", "--worktree", "x"], { run: async () => herdrError("connect_failed"), git: async () => { throw new Error("no git"); }, env: {} });
  expect(r).toMatchObject({ ok: false, state: "failed" });
  expect(r.steps[0].detail).toContain("connect_failed");
});
