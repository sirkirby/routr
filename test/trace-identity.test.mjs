import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./helpers.mjs";
import { canonicalRepository, traceIdentity, pathHash } from "../src/lib/trace-identity.mjs";

test("VCS URLs canonicalize known SSH forms without credentials, suffixes or endpoint text", () => {
  for (const remote of ["git@github.com:acme/repo.git", "ssh://git@github.com/acme/repo.git", "https://github.com/acme/repo.git/"])
    expect(canonicalRepository(remote)).toBe("https://github.com/acme/repo");
  for (const remote of ["https://user:KEY_MARKER@github.com/acme/repo", "/private/repo", "file:///private/repo", "https://host/repo?key=KEY_MARKER", "https://host/repo#fragment", "git@host:../../repo", "https://host/a%2fb", "git://host/repo", "bad remote"])
    expect(canonicalRepository(remote)).toBeNull();
});

test("identity uses git's common repository, relative folders and branch, with no native paths", () => {
  const root = scratch("identity"), repo = join(root, "repo"), linked = join(root, "linked"); mkdirSync(repo);
  const git = (...args) => { const r = Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }); expect(r.exitCode).toBe(0); };
  git("init", "-b", "main"); git("remote", "add", "origin", "git@github.com:acme/repo.git");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
  git("worktree", "add", "-b", "worker", linked); mkdirSync(join(linked, "src"));
  const a = traceIdentity(join(linked, "src")), b = traceIdentity(repo);
  expect(a.attributes).toEqual({ "vcs.repository.url.full": "https://github.com/acme/repo", "vcs.ref.head.name": "worker", "routr.cwd": "src", "routr.worktree": "linked" });
  expect(a.project_hash).toBe(b.project_hash); expect(a.path_hash).not.toBe(b.path_hash);
  expect(a.path_hash).toBe(pathHash(linked));
  expect(JSON.stringify(a)).not.toContain(root);
  git("-C", linked, "checkout", "--detach"); expect(traceIdentity(linked).attributes).not.toHaveProperty("vcs.ref.head.name");
  expect(traceIdentity(join(root, "absent"))).toEqual({ attributes: {} });
});
