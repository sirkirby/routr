// cleanup.mjs: finishing a worker, its worktree or its pane, without losing anything in it
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { quote } from "../src/lib/herdr.mjs";
import { cleanup, dropCopy, linkedWorktree, parseCleanupArgs, parseStatus, parseWorktreeHeads, sameFile } from "../src/lib/cleanup.mjs";
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

// One repository with its main checkout and the worktrees given; `panes` per workspace (a function: read each time);
// `processes` per pane, for one with no agent (null: herdr cannot say); git answers from `status` and `flags` (ls-files
// -v) per worktree path, `orphaned` (worktree paths, or recorded commits, no ref holds), `heads` (git's recorded commit
// per path), and `merged` (branches -d may delete).
// A worktree's commit is "h" + its path, unless `commit(dir, n)` (n: the how-manieth read) says otherwise.
function fake({ worktrees = [], panes = {}, processes = {}, status = {}, flags = {}, orphaned = [], heads = {}, merged = [], removeFails = null, commit = (dir) => `h${dir}`, during = {} } = {}) {
  const reads = {};
  const calls = [], gits = [];
  const source = "/repo";
  const deps = {
    env: { HERDR_PANE_ID: "w1:p1" }, linked: () => true, // the tests below that use real folders give it its real test
    run: async (a) => {
      calls.push(a);
      if (a[0] === "worktree" && a[1] === "list") return herdrOK({ source: { source_checkout_path: source }, worktrees: [{ branch: "main", path: source, is_linked_worktree: false, open_workspace_id: "w1" }, ...worktrees] });
      const now = typeof panes === "function" ? panes() : panes;
      if (a[0] === "pane" && a[1] === "list") return herdrOK({ panes: a[2] === "--workspace" ? now[a[3]] ?? [] : Object.values(now).flat() });
      if (a[0] === "pane" && a[1] === "process-info") {
        const fg = processes[a[3]] === undefined ? [{ pid: 1 }] : processes[a[3]];
        return fg === null ? herdrError("timeout") : herdrOK({ process_info: { shell_pid: 1, foreground_processes: fg } });
      }
      if (a[0] === "workspace" && a[1] === "list") return herdrOK({ workspaces: worktrees.filter((w) => w.open_workspace_id).map((w) => ({ workspace_id: w.open_workspace_id, worktree: { is_linked_worktree: true, checkout_path: w.path, repo_root: source } })) });
      if (a[0] === "worktree" && a[1] === "remove") return removeFails ? herdrError(removeFails) : herdrOK({ type: "worktree_removed" });
      if (a[0] === "pane" && a[1] === "close") return herdrOK({ type: "ok" });
      throw new Error(`Unexpected herdr ${a.join(" ")}`);
    },
    git: async (dir, a) => {
      gits.push([dir, ...a]);
      if (a[0] === "status") return { out: status[dir] ?? "", err: "", code: 0 };
      if (a[0] === "rev-parse") { reads[dir] = (reads[dir] ?? 0) + 1; return { out: `${commit(dir, reads[dir])}\n`, err: "", code: 0 }; }
      await during[a[0]]?.(dir);
      if (a[0] === "ls-files") return { out: flags[dir] ?? "H a.txt\0", err: "", code: 0 };
      if (a[0] === "for-each-ref") return { out: orphaned.some((o) => a[2] === o || a[2] === `h${o}`) ? "" : "refs/heads/x\n", err: "", code: 0 };
      if (a[0] === "worktree" && a[1] === "list") return { out: Object.entries(heads).map(([p, h]) => `worktree ${p}\nHEAD ${h}\ndetached\nprunable gitdir file points to non-existent location\n`).join("\n"), err: "", code: 0 };
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
    status: { "/wt/dirty": " M src/a.mjs\0", "/wt/made": "?? notes.md\0" }, orphaned: ["/wt/lost"],
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
  mkdirSync(join(repo, ".git")); writeFileSync(join(w, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "w")}\n`);
  const f = fake({ worktrees: [wt("copied", { path: w })], status: { [w]: "?? fx/data.json\0?? .env.test\0" } }); f.deps.linked = linkedWorktree;
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
  const f = fake({ worktrees: [wt("done"), wt("dirty"), wt("gone", { is_prunable: true })], status: { "/wt/dirty": " M a\0" }, heads: { "/wt/gone": "abc123" } });
  const r = await cleanup(["--cwd", "/repo"], f.deps);
  expect(r).toMatchObject({ ok: true, state: "listed" });
  expect(r.worktrees.map((w) => [w.branch, w.removable])).toEqual([["done", true], ["dirty", false], ["gone", true]]);
  expect(r.then).toContain(`routr cleanup --cwd ${quote(resolve("/repo"))} --path <path>`);
  expect(f.calls.some((a) => ["remove", "close"].includes(a[1]))).toBe(false);
  expect(f.gits.some((g) => (g[1] === "worktree" && g[2] === "remove") || g[1] === "branch")).toBe(false);
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

// From the review of b32617a: each of these let cleanup remove a worktree it should have kept.
test("a pane cleanup cannot read, or one running a command, keeps the worktree; so does a worker started after the check", async () => {
  const why = async (f, name) => { const r = await cleanup(["--cwd", "/repo", "--worktree", name], f.deps); expect(r).toMatchObject({ ok: false, state: "refused" }); expect(f.calls.some((a) => a[1] === "remove")).toBe(false); return r.refused.why; };
  const shell = { w5: [{ pane_id: "w5:p1", agent_status: "unknown" }] };
  expect(await why(fake({ worktrees: [wt("x", { open_workspace_id: "w5" })], panes: shell, processes: { "w5:p1": null } }), "x")).toContain("Could not read");
  expect(await why(fake({ worktrees: [wt("x", { open_workspace_id: "w5" })], panes: shell, processes: { "w5:p1": [{ pid: 1 }, { pid: 7, name: "bun" }] } }), "x")).toContain("running bun");
  let reads = 0;
  const late = fake({ worktrees: [wt("x", { open_workspace_id: "w5" })], panes: () => ({ w5: [idle("w5:p1", ++reads > 1 ? "working" : "idle")] }) });
  expect(await why(late, "x")).toContain("working");
});

test("a file git is told not to check, a detached commit no ref holds, and a gone worktree's lost commit all keep it", async () => {
  const f = fake({ worktrees: [wt("hidden"), wt("moved"), wt("gone", { is_prunable: true }), wt("kept", { is_prunable: true }), wt("unknown", { is_prunable: true })],
    flags: { "/wt/hidden": "H a.txt\0S secret.json\0h tuned.cfg\0" }, orphaned: ["/wt/moved", "dead1"], heads: { "/wt/gone": "dead1", "/wt/kept": "beef2" } });
  const r = async (name) => cleanup(["--cwd", "/repo", "--worktree", name], f.deps);
  expect((await r("hidden")).refused.why).toContain("secret.json, tuned.cfg");
  // herdr listed it on a branch; it is checked as it is now, detached or not.
  expect((await r("moved")).refused.why).toContain("no branch or tag holds");
  expect((await r("gone")).refused).toMatchObject({ why: expect.stringContaining("dead1"), then: expect.stringContaining("branch <name> dead1") });
  expect((await r("unknown")).state).toBe("refused");
  expect(await r("kept")).toMatchObject({ ok: true, state: "removed" });
  expect(f.gits.filter((g) => g[1] === "worktree" && g[2] === "remove").map((g) => g[3])).toEqual(["/wt/kept"]);
});

test("a copy is removed only through no link, and only while it is still the copy", () => {
  const root = scratch("drop"), repo = join(root, "repo"), w = join(root, "w");
  for (const d of [join(repo, "fx"), join(w, "fx")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(repo, "fx", "a.json"), "{}"); writeFileSync(join(w, "fx", "a.json"), "{}");
  writeFileSync(join(repo, "fx", "b.json"), "{}"); writeFileSync(join(w, "fx", "b.json"), "changed");
  expect(dropCopy(w, repo, "fx/b.json")).toBe(false); expect(existsSync(join(w, "fx", "b.json"))).toBe(true);
  // The worktree's folder swapped for a link into the main checkout: the main checkout's file must survive.
  renameSync(join(w, "fx"), join(w, "fx-real")); symlinkSync(join(repo, "fx"), join(w, "fx"));
  expect(dropCopy(w, repo, "fx/a.json")).toBe(false); expect(existsSync(join(repo, "fx", "a.json"))).toBe(true);
  expect(dropCopy(join(w, "fx-real"), join(repo, "fx"), "a.json")).toBe(true); expect(existsSync(join(w, "fx-real", "a.json"))).toBe(false);
});

test("git's worktree records: each path with its commit", () => {
  expect(parseWorktreeHeads("worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w/x y\nHEAD bbb\ndetached\nprunable gitdir file points to non-existent location\n"))
    .toEqual(new Map([["/r", "aaa"], ["/w/x y", "bbb"]]));
});

// From the review of 980f1b2: changes made while cleanup runs, between its check and its removal.
test("a copy changed, or a worktree swapped for a link to the main checkout, while cleanup runs removes nothing of either", async () => {
  for (const swap of [false, true]) {
    const root = scratch("mid"), repo = join(root, "repo"), w = join(root, "w");
    for (const d of [repo, w]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "notes.txt"), "same"); }
    mkdirSync(join(repo, ".git")); writeFileSync(join(w, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "w")}\n`);
    const during = { "for-each-ref": () => {
      if (!swap) return writeFileSync(join(w, "notes.txt"), "the worker's own words");
      renameSync(w, `${w}-real`); symlinkSync(repo, w);
    } };
    const f = fake({ worktrees: [wt("mid", { path: w })], status: { [w]: "?? notes.txt\0" }, during }); f.deps.linked = linkedWorktree;
    f.deps.run = ((run) => async (a) => (a[0] === "worktree" && a[1] === "list" ? herdrOK({ source: { source_checkout_path: repo }, worktrees: [wt("mid", { path: w })] }) : run(a)))(f.deps.run);
    expect(await cleanup(["--cwd", repo, "--worktree", "mid"], f.deps)).toMatchObject({ ok: false, state: "refused" });
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("same");
    expect(readFileSync(join(swap ? `${w}-real` : w, "notes.txt"), "utf8")).toBe(swap ? "same" : "the worker's own words");
    expect(f.gits.some((g) => g[1] === "worktree" && g[2] === "remove")).toBe(false);
  }
});

test("a commit made, or a worker started, after the check stops the removal; so does a pane list herdr did not give whole", async () => {
  const moved = fake({ worktrees: [wt("x")], commit: (dir, n) => `h${dir}${n > 1 ? "-new" : ""}` });
  expect((await cleanup(["--cwd", "/repo", "--worktree", "x"], moved.deps)).refused.why).toContain("another commit");
  expect(moved.gits.some((g) => g[1] === "worktree" && g[2] === "remove")).toBe(false);
  let reads = 0;
  const started = fake({ panes: () => ({ w1: [{ ...idle("w1:p2", ++reads > 1 ? "working" : "done"), workspace_id: "w1" }] }) });
  expect((await cleanup(["--pane", "w1:p2"], started.deps)).refused.why).toContain("working");
  expect(started.calls.some((a) => a[1] === "close")).toBe(false);
  const broken = fake({ worktrees: [wt("x", { open_workspace_id: "w5" })] });
  broken.deps.run = ((run) => async (a) => (a[0] === "pane" && a[1] === "list" ? herdrOK({ panes: [{ agent_status: "idle" }] }) : run(a)))(broken.deps.run);
  expect(await cleanup(["--cwd", "/repo", "--worktree", "x"], broken.deps)).toMatchObject({ ok: false, state: "failed" });
  expect(broken.calls.some((a) => a[1] === "remove")).toBe(false);
});

// From the review of 31f9ddf: the swap made before cleanup fixed where the worktree is.
test("a worktree swapped for a link to the main checkout before cleanup looks at it is not taken for the worktree", async () => {
  const root = scratch("early"), repo = join(root, "repo"), w = join(root, "w");
  for (const d of [repo, w]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "notes.txt"), "same"); }
  mkdirSync(join(repo, ".git")); writeFileSync(join(w, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "w")}\n`);
  expect([linkedWorktree(w, repo), linkedWorktree(repo, repo), linkedWorktree(join(root, "none"), repo)]).toEqual([true, false, false]);
  const f = fake({ worktrees: [wt("early", { path: w })], status: { [w]: "?? notes.txt\0", [repo]: "?? notes.txt\0" } }); f.deps.linked = linkedWorktree;
  f.deps.run = ((run) => async (a) => {
    if (a[0] === "worktree" && a[1] === "list") { renameSync(w, `${w}-real`); symlinkSync(repo, w); return herdrOK({ source: { source_checkout_path: repo }, worktrees: [wt("early", { path: w })] }); }
    return run(a);
  })(f.deps.run);
  expect((await cleanup(["--cwd", repo, "--worktree", "early"], f.deps)).refused.why).toContain("not a linked worktree");
  expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("same");
  expect(f.gits).toHaveLength(0);
});

test("the panes are read last: a worker started while the commit is compared again is still seen", async () => {
  let started = false;
  const f = fake({ worktrees: [wt("x", { open_workspace_id: "w5" })], panes: () => ({ w5: [idle("w5:p1", started ? "working" : "idle")] }),
    commit: (dir, n) => { if (n > 1) started = true; return `h${dir}`; } });
  expect((await cleanup(["--cwd", "/repo", "--worktree", "x"], f.deps)).refused.why).toContain("working");
  expect(f.calls.some((a) => a[1] === "remove")).toBe(false);
});
