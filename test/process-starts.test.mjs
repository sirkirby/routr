// Inventory the process boundary, including renamed imports and injected defaults. Like runtime's import guard,
// this is a lexical check: computed imports/calls need review. Tests run before dependencies are installed in CI.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const syntax = new Bun.Transpiler({ loader: "js" });
const REGEX_PREFIX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof", "extends"]);
const CONTROL = new Set(["if", "while", "for", "with", "switch", "catch"]);
const tokens = (source, file = "<process allowlist>") => {
  const out = [], fail = (why) => { throw new Error(`cannot tokenize ${file}: ${why}`); };
  // Bun is the test runner, not an installed dependency. Validate syntax without executing or resolving imports;
  // the scanner below must also finish every lexical state before it may return any calls (the #109 regression).
  try { syntax.transformSync(source); } catch { fail("invalid JavaScript"); }
  let i = 0;
  const escaped = () => {
    if (i + 1 >= source.length) fail("unfinished escape");
    i += source[i + 1] === "\r" && source[i + 2] === "\n" ? 3 : 2;
  };
  const string = (quote) => {
    const start = i++;
    while (i < source.length) {
      if (source[i] === "\\") { escaped(); continue; }
      if (source[i] === quote) { out.push(source.slice(start, ++i)); return; }
      if (/[\r\n]/.test(source[i])) fail("newline in string");
      i++;
    }
    fail("unclosed string");
  };
  const regex = () => {
    const start = i++; let inClass = false;
    while (i < source.length) {
      const c = source[i];
      if (/[\r\n\u2028\u2029]/.test(c)) fail("newline in regex");
      if (c === "\\") { escaped(); continue; }
      if (c === "[" && !inClass) inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        i++; while (/[a-z]/i.test(source[i] ?? "")) i++;
        out.push(source.slice(start, i)); return;
      }
      i++;
    }
    fail("unclosed regex");
  };
  const template = () => {
    let start = i++;
    while (i < source.length) {
      if (source[i] === "\\") { escaped(); continue; }
      if (source[i] === "`") { out.push(source.slice(start, ++i)); return; }
      if (source[i] === "$" && source[i + 1] === "{") {
        out.push(source.slice(start, i + 2)); i += 2;
        code(true); // leaves the interpolation's closing brace for the next literal chunk
        start = i++;
      } else i++;
    }
    fail("unclosed template");
  };
  const code = (interpolation = false) => {
    const brackets = []; let previous = "", regexAllowed = true, controlEnd = false;
    while (i < source.length) {
      const c = source[i], next = source[i + 1];
      if (/\s/.test(c)) { i++; continue; }
      if ((i === 0 && source.startsWith("#!")) || (c === "/" && next === "/")) {
        while (i < source.length && !/[\r\n\u2028\u2029]/.test(source[i])) i++;
        continue;
      }
      if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end < 0) fail("unclosed comment");
        i = end + 2; continue;
      }
      if (c === "'" || c === '"' || c === "`" || (c === "/" && regexAllowed)) {
        if (c === "`") template(); else if (c === "/") regex(); else string(c);
        previous = "literal"; regexAllowed = false; controlEnd = false; continue;
      }
      const word = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/u.exec(source.slice(i))?.[0];
      if (word) {
        out.push(word); i += word.length;
        regexAllowed = previous !== "." && previous !== "?." && REGEX_PREFIX.has(word);
        previous = word; controlEnd = false; continue;
      }
      const number = /^(?:0[xob][\da-f_]+|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?[\d_]+)?|\.\d[\d_]*(?:e[+-]?[\d_]+)?)(?:n)?/i.exec(source.slice(i))?.[0];
      if (number) { out.push(number); i += number.length; previous = "number"; regexAllowed = false; controlEnd = false; continue; }
      if ("([{".includes(c)) {
        const member = [".", "?."].includes(out.at(-2));
        const control = c === "(" && !member && (CONTROL.has(previous) || (previous === "await" && out.at(-2) === "for"));
        // Only a known statement block enables a regex after }. Object, function-expression and arrow bodies don't.
        const block = c === "{" && (controlEnd || ["else", "do", "try", "finally", ";"].includes(previous) || (!previous && !interpolation) || (previous === "}" && regexAllowed));
        brackets.push({ close: { "(": ")", "[": "]", "{": "}" }[c], control, block });
        out.push(c); i++; previous = c; regexAllowed = true; controlEnd = false; continue;
      }
      if (")]}".includes(c)) {
        if (c === "}" && interpolation && !brackets.length) return;
        const open = brackets.pop();
        if (open?.close !== c) fail("unbalanced brackets");
        out.push(c); i++; previous = c; regexAllowed = open.control || open.block; controlEnd = open.control; continue;
      }
      const op = /^(?:>>>=|===|!==|>>>|\*\*=|&&=|\|\|=|\?\?=|<<=|>>=|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|\*\*|<<|>>|\.\.\.|[+\-*/%&|^]=)/.exec(source.slice(i))?.[0] ?? c;
      if (!/^[.,;:?+\-*/%&|^~!=<>#]+$/.test(op)) fail("unrecognized token");
      out.push(op); i += op.length; previous = op; regexAllowed = op !== "++" && op !== "--"; controlEnd = false;
    }
    if (brackets.length) fail("unbalanced brackets");
    if (interpolation) fail("unclosed template expression");
  };
  code(); return out;
};
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
  const ts = tokens(source, file);
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
  ["lib/runtime.mjs", "routr starting itself", 'start(process.execPath, [...(standalone() ? [] : [ROUTR_ENTRY]), ...args], { detached: true, stdio: "ignore" })', 1],
  ["lib/herdr.mjs", "herdr clients", 'via("herdr", args, { stdio: ["ignore", "pipe", "pipe"] })', 1],
  ["lib/update.mjs", "updater version inspection", 'spawn(self, ["--version"], { encoding: "utf8", timeout: 15000 })', 1],
  ["lib/update.mjs", "updater version confirmation", 'spawn(self, ["--version"], { encoding: "utf8" })', 1],
  ["lib/update.mjs", "updater skill install", 'spawn(self, ["skill", "install"], { encoding: "utf8" })', 1],
  ["lib/update.mjs", "detached updater", 'spawn(["update", "--background"])', 1],
  ["lib/uninstall.mjs", "uninstall's Windows removal", 'start("cmd", ["/c", `ping -n 4 127.0.0.1 >nul & del /f /q ${basename(aside)}`], { cwd: dirname(aside), detached: true, stdio: "ignore" })', 1],
].map(([file, why, call, count]) => ({ file, why, call: compact(call), count }));
// harnessEnv, or workerEnv for a worker's turn (harnessEnv with the checked trace-context carriers added back).
const filtered = (call) => /env:(?:\{\.\.\.)?(?:harnessEnv|workerEnv)\(/.test(call);
// A filter taken away: the start then gets routr's own environment, whole.
const unfiltered = (text) => text.replaceAll("harnessEnv()", "process.env").replaceAll("workerEnv(", "leakEnv(");
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
    const mutated = calls(unfiltered(source), path);
    for (const call of original) {
      const leak = unfiltered(call);
      expect(mutated).toContain(leak);
      expect(allowed(path, leak)).toBeUndefined();
    }
    expect(mutated.filter(filtered)).toEqual([]);
  }
});

test("regex literals containing quotes and backticks cannot hide a later process start", () => {
  const regex = "/['‘’‚‛\"`/\\]\\[]/g";
  const prefixes = [
    `const pattern = ${regex};`,
    `function pattern() { return ${regex}; }`,
    `function pattern() { throw ${regex}; }`,
    `const pattern = () => ${regex};`,
    `if (ready) ${regex}.test(text);`,
    `while (ready) ${regex}.test(text);`,
    `if (ready) {} ${regex}.test(text);`,
    `const pattern = { test: ${regex} };`,
    `const pattern = [${regex}];`,
    `consume(${regex});`,
    `const pattern = ready ? ${regex} : /other/;`,
    `const quotient = numerator / denominator / scale;`,
    'const pattern = /start\\("decoy"\\)/;',
  ];
  for (const prefix of prefixes) {
    const source = `import { start } from "./runtime.mjs"; ${prefix} start("harness", [], {});`;
    expect(calls(source, "lib/regex.mjs")).toEqual(['start("harness",[],{})']);
  }
});

test("literal template text is ignored but a process start in a template expression stays visible", () => {
  const source = 'import { start } from "./runtime.mjs"; const message = `start("literal") ${start("harness", [], {})}`;';
  expect(calls(source, "lib/template.mjs")).toEqual(['start("harness",[],{})']);
});

test("regex prefixes include expression keywords and operators, while division never hides a start", () => {
  const regex = "/['\"`/\\]\\[]/g";
  const prefixes = [
    ...["typeof", "new", "delete", "void"].map((word) => `${word} ${regex};`),
    `switch (value) { case ${regex}: break; }`,
    `do ${regex}.test(text); while (ready);`,
    `if (ready) {} else ${regex}.test(text);`,
    `const value = "key" in ${regex};`,
    `for (const value of ${regex}) {}`,
    `function* values() { yield ${regex}; }`,
    `async function value() { await ${regex}; }`,
    ...["=", "+", "-", "*", "/", "&&", "||", "??", ","].map((op) => `let value; value ${op} ${regex};`),
  ];
  for (const prefix of prefixes) expect(calls(`import { start } from "./runtime.mjs"; ${prefix} start("worker", [], {});`, "lib/prefixes.mjs")).toEqual(['start("worker",[],{})']);
  for (const left of ["value", "12", "(value)", "[value][0]", "{}", "function() {}", "value++", "obj.return", '"literal"', "`literal`"]) {
    expect(calls(`import { start } from "./runtime.mjs"; const result = ${left} / start("worker", [], {}) / scale;`, "lib/division.mjs")).toEqual(['start("worker",[],{})']);
  }
});

test("nested template expressions expose starts without exposing literal text or losing bracket state", () => {
  const source = 'import { start } from "./runtime.mjs"; const value = `literal start("decoy") ${ { value: `nested ${start("nested", [], {})}` } } ${/[' + "'\"`" + ']/.test(text) ? start("outer", [], {}) : ""}`; start("after", [], {});';
  expect(calls(source, "lib/nested.mjs")).toEqual(['start("nested",[],{})', 'start("outer",[],{})', 'start("after",[],{})']);
});

test("the inventory refuses malformed source with its filename instead of returning partial calls", () => {
  for (const suffix of ['"unclosed', "'unclosed", "`unclosed", "/[unclosed/", "/* unclosed", "(", "[", "{", "([)]", "const value = ;", '`outer ${`inner ${value}', '`outer ${ ({ nested: 1 })', '"escape\\', "/escape\\"]) {
    const source = `import { start } from "./runtime.mjs"; start("harness", [], {}); ${suffix}`;
    expect(() => calls(source, "lib/broken.mjs")).toThrow("lib/broken.mjs");
  }
});
