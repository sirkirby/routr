// Inventory the process boundary, including renamed imports and injected defaults. Like runtime's import guard,
// this is a lexical check: computed imports/calls need review. Strings (including shell templates) are not JS calls.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const tokens = (source) => [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|\?\?|\S/g)].map((m) => m[0]).filter((t) => !t.startsWith("//") && !t.startsWith("/*"));
const compact = (s) => tokens(s).join("");
const calls = (source, file) => {
  const names = new Set(file === "lib/runtime.mjs" ? ["start", "startSync"] : []);
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!/(?:runtime\.mjs|node:child_process)$/.test(m[2])) continue;
    for (const entry of m[1].split(",")) {
      const [name, alias] = entry.trim().split(/\s+as\s+/);
      if (["start", "startSync", "spawn", "spawnSync"].includes(name)) names.add(alias ?? name);
    }
  }
  // Refuse an unhandled import shape rather than silently missing namespace member calls.
  if (/import\s+(?!\{)[^;]+from\s*["'][^"']*(?:runtime\.mjs|child_process)["']/.test(source)) throw new Error(`unhandled process import: ${file}`);
  const ts = tokens(source);
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < ts.length - 3; i++) if (/^[\w$]+$/.test(ts[i]) && ts[i + 1] === "=" && names.has(ts[i + 2]) && [",", "}", ")", ";"].includes(ts[i + 3]) && !names.has(ts[i])) { names.add(ts[i]); changed = true; }
  }
  const found = [];
  for (let i = 0; i < ts.length; i++) {
    let open = i + 1;
    if (ts[i] === "(" && names.has(ts[i + 1]) && ts[i + 2] === "??" && names.has(ts[i + 3]) && ts[i + 4] === ")") open = i + 5;
    else if (!names.has(ts[i]) || ts[i - 1] === ".") continue;
    if (ts[open] !== "(") continue;
    let depth = 1, end = open + 1;
    for (; end < ts.length && depth; end++) { if (ts[end] === "(") depth++; if (ts[end] === ")") depth--; }
    if (depth) throw new Error(`unclosed process call: ${file}`);
    found.push(ts.slice(i, end).join(""));
  }
  return found;
};

// Exact calls, not whole files: another start beside a client or updater must still pass the filter.
const ALLOWED = [
  ["lib/runtime.mjs", "platform adapters", "via(...prepare(cmd, args, opts, platform))", 2],
  ["lib/runtime.mjs", "Windows taskkill", '(via ?? spawn)(exe, ["/PID", String(child.pid), "/T", "/F"], startOptions({ stdio: "ignore" }))', 1],
  ["lib/runtime.mjs", "routr starting itself", 'start(process.execPath, [...(standalone() ? [] : [process.argv[1]]), ...args], { detached: true, stdio: "ignore" })', 1],
  ["lib/herdr.mjs", "herdr clients", 'via("herdr", args, { stdio: ["ignore", "pipe", "pipe"] })', 1],
  ["lib/update.mjs", "updater version inspection", 'spawn(self, ["--version"], { encoding: "utf8", timeout: 15000 })', 1],
  ["lib/update.mjs", "updater version confirmation", 'spawn(self, ["--version"], { encoding: "utf8" })', 1],
  ["lib/update.mjs", "updater skill install", 'spawn(self, ["skill", "install"], { encoding: "utf8" })', 1],
  ["lib/update.mjs", "detached updater", 'spawn(["update", "--background"])', 1],
  ["lib/uninstall.mjs", "uninstall's Windows removal", 'start("cmd", ["/c", `ping -n 4 127.0.0.1 >nul & del /f /q ${basename(aside)}`], { cwd: dirname(aside), detached: true, stdio: "ignore" })', 1],
].map(([file, why, call, count]) => ({ file, why, call: compact(call), count }));
const filtered = (call) => /env:(?:\{\.\.\.)?harnessEnv\(/.test(call);
const allowed = (file, call) => ALLOWED.find((a) => a.file === file.replaceAll("\\", "/") && a.call === call);

test("every process start filters the harness environment or names an exact non-harness exception", () => {
  const root = join(import.meta.dir, "../src"), seen = new Map(), refused = [];
  let sanitized = 0;
  for (const file of readdirSync(root, { recursive: true }).map(String).filter((f) => /\.[cm]?[jt]s$/.test(f))) {
    for (const call of calls(readFileSync(join(root, file), "utf8"), file.replaceAll("\\", "/"))) {
      if (filtered(call)) { sanitized++; continue; }
      const allow = allowed(file, call);
      if (allow) seen.set(allow.why, (seen.get(allow.why) ?? 0) + 1);
      else refused.push({ file, call });
    }
  }
  expect(refused).toEqual([]);
  expect(sanitized).toBeGreaterThanOrEqual(4); // run, probe, headless turns, private server
  for (const a of ALLOWED) expect([a.why, seen.get(a.why)]).toEqual([a.why, a.count]);
});

test("the inventory detects a new or renamed start and a removed filter on every harness path", () => {
  for (const name of ["start", "startSync"]) {
    const source = `import { ${name} as launch } from "./runtime.mjs"; launch("new-harness", [], {});`;
    expect(calls(source, "lib/new.mjs")).toEqual(['launch("new-harness",[],{})']);
    expect(filtered(calls(source, "lib/new.mjs")[0])).toBe(false);
    expect(allowed("lib/new.mjs", calls(source, "lib/new.mjs")[0])).toBeUndefined();
  }
  for (const file of ["runtime", "terminal", "headless"]) {
    const path = `lib/${file}.mjs`, source = readFileSync(join(import.meta.dir, "../src", path), "utf8");
    const original = calls(source, path).filter(filtered);
    expect(original.length).toBeGreaterThan(0);
    const mutated = calls(source.replaceAll("harnessEnv()", "process.env"), path);
    for (const call of original) {
      const leak = call.replaceAll("harnessEnv()", "process.env");
      expect(mutated).toContain(leak);
      expect(allowed(path, leak)).toBeUndefined();
    }
    expect(mutated.filter(filtered)).toEqual([]);
  }
});
