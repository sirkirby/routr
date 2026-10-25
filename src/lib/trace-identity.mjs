import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { harnessEnv, realPath, startSync } from "./runtime.mjs";

// Stage 2 prep, VCS 1.44.0: a URL is a repository identity, never a transport credential or arbitrary remote text.
export function canonicalRepository(remote) {
  if (typeof remote !== "string" || /[\s?#%]/.test(remote)) return null;
  let text = remote.replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = text.match(/^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+)$/);
  if (scp) text = `https://${scp[1]}/${scp[2]}`;
  try {
    if (/^ssh:\/\/git@[A-Za-z0-9.-]+\//.test(text)) text = text.replace(/^ssh:\/\/git@/, "https://");
    const url = new URL(text);
    if (url.protocol === "ssh:" && url.username === "git" && !url.password && !url.port) { url.protocol = "https:"; url.username = ""; }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname || !/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(url.pathname)) return null;
    // Check before URL's dot-segment normalization, which could hide an ambiguous source remote.
    if (text.split(/[/:]/).some((p) => p === "." || p === "..")) return null;
    return url.href.replace(/\/$/, "");
  } catch { return null; }
}
const hash = (s) => createHash("sha256").update(s).digest("hex");
export const pathHash = (path) => { try { const p = realPath(path); return hash(process.platform === "win32" ? p.toLowerCase() : p); } catch { return null; } };
export const relativeName = (v) => typeof v === "string" && v.length <= 240 && !isAbsolute(v) && !/[:\\\x00-\x1f\x7f]/.test(v) && v.split("/").every((p) => p && p !== "..") ? v : null;
export const branchName = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(v) && !v.includes("..") ? v : null;
export function traceIdentity(cwd = process.cwd()) {
  const git = (args) => {
    try { const r = startSync("git", ["-C", cwd, ...args], { env: harnessEnv(), encoding: "utf8", timeout: 1000, maxBuffer: 16384, stdio: ["ignore", "pipe", "ignore"] }); return r.status === 0 ? r.stdout.replace(/\r?\n$/, "") : null; } catch { return null; }
  };
  try {
    const dirs = git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"])?.split(/\r?\n/);
    if (dirs?.length !== 2) return { attributes: {} };
    const [root, common] = dirs, projectRoot = dirname(common), rel = relative(projectRoot, root), worktree = rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) ? rel : basename(root);
    const repository = canonicalRepository(git(["config", "--get", "remote.origin.url"])), branch = branchName(git(["symbolic-ref", "--quiet", "--short", "HEAD"]));
    const attributes = {}, folder = relativeName(relative(root, resolve(cwd)).split(sep).join("/") || "."), tree = relativeName(worktree.split(sep).join("/"));
    if (repository) attributes["vcs.repository.url.full"] = repository;
    if (branch) attributes["vcs.ref.head.name"] = branch;
    if (folder) attributes["routr.cwd"] = folder;
    if (tree) attributes["routr.worktree"] = tree;
    return { attributes, project_hash: pathHash(common), path_hash: pathHash(root) };
  } catch { return { attributes: {} }; }
}
