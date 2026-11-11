// `routr dash`: the projection, what the file may hold, the page's own bounds, the ledger's bad lines, refusals,
// and when a browser is started. No model and no harness.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DASH_PAGE, dashCommand, dashRows } from "../src/lib/dash.mjs";
import { projectName } from "../src/lib/ledger.mjs";
import { browserArgv, openInBrowser } from "../src/lib/processes.mjs";
import { cliEnv, scratch, SCRIPT } from "./helpers.mjs";

const RUN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AT = "2026-11-05T12:00:00.000Z";
const quiet = { isTTY: false };
const tty = { isTTY: true };
const noBrowser = () => { throw new Error("browser opened"); };

function go(args = ["--no-open"], { home = scratch("dash"), ledger, output = quiet, open = noBrowser, cwd, now = () => AT } = {}) {
  return dashCommand(args, { home, ledger: ledger ?? join(home, "missing.jsonl"), output, open, cwd: cwd ?? home, now });
}
const htmlOf = (r) => readFileSync(r.file, "utf8");
const embedded = (html) => JSON.parse(html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1]);

const entry = (over = {}) => ({
  ts: "2026-10-01T00:00:00.000Z", project: "alpha", run_id: RUN, id: "advice-id", brief_sha: "abc", brief_chars: 12,
  advised: { level: "standard", sure: true, high_risk: false },
  chose: { subscription: "codex", model: "recorded-model", effort: "low", level: "standard" },
  outcome: { verdict: "done", check: "pass", attempts: 1, causes: [], note: "a note" },
  headroom: { codex: { usable: 0.4, usage: "live" }, agy: { usable: "no" } }, ...over,
});

test("a row is the latest revision, projected field by field", () => {
  const rows = dashRows([
    entry({ chose: { subscription: "codex", model: "old-model", effort: "low", level: "basic" }, outcome: { verdict: "partial", check: "fail", attempts: 2, causes: ["execution", 1], note: "OLD-NOTE" } }),
    entry({ ts: "2026-10-08T00:00:00.000Z", advised: { level: "basic", sure: false, high_risk: true }, chose: { subscription: "claude", model: "recorded-model", effort: "high", level: "strong" }, outcome: { verdict: "done", check: "pass", attempts: 1, causes: [] } }),
    entry({ run_id: "not-a-run", ts: "2026-10-15T00:00:00.000Z", project: 12, headroom: null, advised: null, chose: null, outcome: null }),
    { ts: "2026-10-16T00:00:00.000Z", project: "beta" },
  ]);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toEqual({
    t: "2026-10-08T00:00:00.000Z", p: "alpha", a: "basic", unsure: true, risk: true,
    c: "strong", s: "claude", m: "recorded-model", f: "high", first: true, attempts: 1, fail: false, causes: [], room: { codex: 0.4 },
  });
  expect(rows[1]).toMatchObject({ t: "2026-10-15T00:00:00.000Z", p: null, a: null, c: null, first: false, attempts: null, fail: false, causes: [], room: {} });
  expect(rows[2].p).toBe("beta");
  expect(JSON.stringify(rows)).not.toContain("OLD-NOTE");
  expect(JSON.stringify(rows)).not.toContain("old-model");
  const roomy = dashRows([entry()])[0];
  expect(roomy).toMatchObject({ first: true, fail: false, room: { codex: 0.4 }, causes: [] });
  expect(roomy.room.agy).toBeUndefined();
  expect(dashRows([entry({ outcome: { verdict: "done", check: "fail", attempts: 1, causes: ["execution"] } })])[0]).toMatchObject({ first: false, fail: true, causes: ["execution"] });
});

test("a note, a brief hash and length, an advice id, a run id and a path never reach the file", () => {
  const home = scratch("dash-private"), ledger = join(home, "ledger.jsonl");
  const note = "NOTE-PRIVATE-MARKER-9f3a", hash = "BRIEFHASH-PRIVATE-9f3a", id = "ADVICE-PRIVATE-9f3a", path = "/private/path/SECRET-PATH-9f3a";
  writeFileSync(ledger, JSON.stringify(entry({
    id, brief_sha: hash, brief_chars: 424242, project: "ledger-project", note, path, cwd: path,
    outcome: { verdict: "done", check: "pass", attempts: 1, causes: [], note },
  })) + "\n");
  const r = go(["--no-open"], { home, ledger, cwd: home });
  const html = htmlOf(r);
  for (const secret of [note, hash, "424242", id, RUN, path]) expect(html).not.toContain(secret);
  expect(html).toContain("recorded-model");
  expect(html).toContain("ledger-project");
  expect(r.runs).toBe(1);
  const data = embedded(html);
  expect(Object.keys(data.rows[0]).sort()).toEqual(["a", "attempts", "c", "causes", "f", "fail", "first", "m", "p", "risk", "room", "s", "t", "unsure"]);
});

test("a name cannot break out of the embedded JSON, and the page loads nothing", () => {
  const home = scratch("dash-xss"), ledger = join(home, "ledger.jsonl");
  const name = "</script><img onerror=alert(1)>";
  writeFileSync(ledger, JSON.stringify(entry({ project: name, chose: { subscription: "codex", model: name, effort: "low", level: "standard" } })) + "\n");
  const html = htmlOf(go(["--no-open"], { home, ledger }));
  expect(html.match(/<\/script>/gi)).toHaveLength(2);
  expect(html).not.toContain("<img");
  expect(html).toContain("\\u003c/script>");
  expect(html).toContain("\\u003cimg onerror=alert(1)>");
  const data = embedded(html);
  expect([data.rows[0].p, data.rows[0].m]).toEqual([name, name]);
  expect(html).toContain(`content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"`);
  const urls = html.match(/https?:\/\/[^"'\\\s)]+/g) ?? [];
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.every((u) => u === "http://www.w3.org/2000/svg")).toBe(true);
  expect(html).not.toMatch(/\bfetch\s*\(|\bXMLHttpRequest\b|\bimport\s*\(|@import\b/);
  expect(html).not.toContain("/*DATA*/");
});

test("non-object lines are skipped, an empty ledger is empty, and an unreadable one is said", () => {
  const home = scratch("dash-lines"), ledger = join(home, "ledger.jsonl");
  const marker = "NONOBJECT-MARKER-9f3a";
  writeFileSync(ledger, `not json ${marker}\nnull\n[]\n7\n"${marker}"\n${JSON.stringify(entry({ project: "kept" }))}\n`);
  const mixed = go(["--no-open"], { home, ledger });
  expect([mixed.ok, mixed.runs, mixed.unavailable]).toEqual([true, 1, []]);
  expect(htmlOf(mixed)).not.toContain(marker);
  expect(embedded(htmlOf(mixed)).rows[0].p).toBe("kept");

  const emptyHome = scratch("dash-empty"), empty = join(emptyHome, "ledger.jsonl");
  writeFileSync(empty, "");
  for (const ledger of [empty, join(emptyHome, "absent.jsonl")]) {
    const r = go(["--no-open"], { home: emptyHome, ledger });
    expect([r.ok, r.runs, r.unavailable, embedded(htmlOf(r)).rows]).toEqual([true, 0, [], []]);
  }

  const badHome = scratch("dash-unreadable"), bad = join(badHome, "ledger.jsonl");
  mkdirSync(bad);
  const r = go(["--no-open"], { home: badHome, ledger: bad });
  const why = "The ledger could not be read: runs are not shown, and their counts are unknown";
  expect([r.ok, r.runs, r.unavailable]).toEqual([true, null, [{ part: "ledger", code: "unreadable", why }]]);
  expect(r.headline).toBe(`routr: the ledger could not be read; wrote ${r.file}`);
  expect(embedded(htmlOf(r)).unavailable).toBe(why);
  expect(r.project).toBe(basename(badHome)); // outside a repository: the folder's name, as board and launch give it
});

test("bad input is refused and nothing is written", () => {
  const home = scratch("dash-refuse"), file = join(home, "block"), repo = join(home, "repo");
  mkdirSync(repo); writeFileSync(file, "x");
  const out = join(home, "page.html");
  for (const [args, why] of [
    [["--cwd"], "takes a folder"], [["--cwd", repo, "--cwd", repo], "more than once"], [["--level", "strong"], "unknown flag"],
    [["--cwd", join(home, "gone")], "is not a folder"], [["--cwd", file], "is not a folder"], [["--out"], "takes a file"],
    [["--out", home], "is a folder"], [["--no-open", "--no-open"], "more than once"], [["extra"], "unknown argument"],
  ]) {
    const r = go(args, { home, open: noBrowser });
    expect([r.ok, r.error]).toEqual([false, expect.stringContaining(why)]);
    expect(r.file).toBeUndefined();
  }
  const blocked = go(["--out", join(file, "dash.html")], { home });
  expect([blocked.ok, blocked.error]).toEqual([false, expect.stringContaining("could not write")]);
  expect(existsSync(out)).toBe(false);
  expect(existsSync(join(home, ".cache/routr/dash.html"))).toBe(false);
});

test("the project filter is board's project (the repository, else the folder), and the file still holds every project", () => {
  const home = scratch("dash-scope"), repo = join(home, "my-app"), ledger = join(home, "ledger.jsonl");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(ledger, [entry({ project: "my-app" }), entry({ run_id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", project: "other" })].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const inside = go(["--no-open"], { home, ledger, cwd: repo });
  expect(inside.project).toBe("my-app");
  expect(embedded(htmlOf(inside)).rows.map((r) => r.p).sort()).toEqual(["my-app", "other"]);
  const outside = go(["--cwd", home, "--no-open"], { home, ledger });
  expect(outside.project).toBe(basename(home));
  expect(embedded(htmlOf(outside)).project).toBe(basename(home));
  expect([outside.project, inside.project]).toEqual([projectName(home), projectName(repo)]);
});

test("a pipe or --no-open never opens anything; a terminal does, and a failed open still gives the path", () => {
  const home = scratch("dash-open"), ledger = join(home, "missing.jsonl");
  const calls = [];
  const open = (file) => { calls.push(file); return true; };
  const piped = go([], { home, ledger, output: quiet, open });
  expect([calls, piped.opened, piped.next[0].why]).toEqual([[], false, `Give the person this path: ${piped.file}`]);
  const held = go(["--no-open"], { home, ledger, output: tty, open });
  expect([calls, held.opened, held.next]).toEqual([[], false, [{ kind: "do", why: `Give the person this path: ${held.file}` }]]);
  const shown = go([], { home, ledger, output: tty, open });
  expect([calls, shown.opened, shown.next, shown.headline]).toEqual([[shown.file], true, [], `routr: wrote ${shown.file} (0 runs) and opened it`]);
  const failed = go([], { home, ledger, output: tty, open: () => false });
  expect([failed.ok, failed.opened, failed.headline, failed.next[0].why]).toEqual([true, false, `routr: wrote ${failed.file} (0 runs); could not open it`, `Give the person this path: ${failed.file}`]);
  expect(failed.file).toBe(join(home, ".cache/routr/dash.html"));
  const other = scratch("dash-out"), named = join(other, "out", "page.html");
  const asked = go(["--out", named, "--no-open"], { home: other, ledger: join(other, "missing.jsonl") });
  expect(asked.file).toBe(resolve(named));
  expect(existsSync(join(other, ".cache/routr/dash.html"))).toBe(false);
});

test("each platform starts its own opener, directly", () => {
  const file = join(scratch("dash-argv"), "dash.html");
  const path = resolve(file);
  expect(browserArgv(file, "darwin")).toEqual(["open", path]);
  expect(browserArgv(file, "linux")).toEqual(["xdg-open", path]);
  expect(browserArgv(file, "win32")).toEqual(["rundll32", "url.dll,FileProtocolHandler", path]);
  expect(browserArgv(file, "freebsd")).toBeNull();
});

test.skipIf(process.platform === "win32")("the file is owner-only on POSIX", () => {
  const home = scratch("dash-mode");
  const named = join(home, "page.html");
  for (const args of [["--no-open"], ["--out", named, "--no-open"]]) {
    const r = go(args, { home });
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.file, "utf8")).toContain(DASH_PAGE);
  }
  const loose = join(home, "loose.html");
  writeFileSync(loose, "keep", { mode: 0o644 });
  const refused = go(["--out", loose, "--no-open"], { home });
  expect([refused.ok, refused.file, refused.error]).toEqual([false, undefined, expect.stringContaining(resolve(loose))]);
  expect(refused.error).toContain("choose another");
  expect([readFileSync(loose, "utf8"), statSync(loose).mode & 0o777]).toEqual(["keep", 0o644]);
  writeFileSync(loose, DASH_PAGE, { mode: 0o644 });
  const r = go(["--out", loose, "--no-open"], { home });
  expect(statSync(r.file).mode & 0o777).toBe(0o600);
  chmodSync(r.file, 0o644);
  expect(statSync(go(["--out", loose, "--no-open"], { home }).file).mode & 0o777).toBe(0o600);
});

test.skipIf(process.platform === "win32")("a symlink is replaced, and the file it pointed at is left as it was", () => {
  const home = scratch("dash-link"), target = join(home, "secret.txt"), link = join(home, ".cache/routr/dash.html");
  writeFileSync(target, "SECRET-TARGET-9f3a", { mode: 0o644 });
  mkdirSync(join(home, ".cache/routr"), { recursive: true });
  symlinkSync(target, link);
  const r = go(["--no-open"], { home });
  expect(r.ok).toBe(true);
  expect(lstatSync(link).isSymbolicLink()).toBe(false);
  expect(readFileSync(link, "utf8")).toContain(DASH_PAGE);
  expect(statSync(link).mode & 0o777).toBe(0o600);
  expect([readFileSync(target, "utf8"), statSync(target).mode & 0o777]).toEqual(["SECRET-TARGET-9f3a", 0o644]);
  const out = join(home, "out.html");
  symlinkSync(target, out);
  const refused = go(["--out", out, "--no-open"], { home });
  expect(refused.ok).toBe(false);
  expect(lstatSync(out).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("SECRET-TARGET-9f3a");
});

test("the page source draws with textContent and names itself", () => {
  const src = readFileSync(new URL("../src/lib/dash.html", import.meta.url), "utf8");
  expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  expect(src).toContain(DASH_PAGE);
  expect(src).toContain("textContent");
});

test("openInBrowser starts the platform's argv and reports a failed start", () => {
  const file = join(scratch("dash-start"), "dash.html");
  const seen = [];
  const start = (cmd, args, opts) => { seen.push([[cmd, ...args], opts]); return { status: 0 }; };
  expect(openInBrowser(file, { start })).toBe(true);
  expect(seen[0][0]).toEqual(browserArgv(file));
  expect(seen[0][1]).toMatchObject({ stdio: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
  expect(openInBrowser(file, { start: () => ({ status: 1 }) })).toBe(false);
  expect(openInBrowser(file, { start: () => ({ status: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }) })).toBe(false);
  expect(openInBrowser(file, { start: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } })).toBe(false);
  expect(openInBrowser(file, { start: () => ({ status: null, signal: "SIGKILL" }) })).toBe(false);
  expect(openInBrowser(file, { platform: "freebsd", start: () => { throw new Error("started"); } })).toBe(false);
});

test("a global flag cannot take --cwd, --out or --no-open as its value", () => {
  const home = scratch("dash-cli"), repo = join(home, "repo");
  mkdirSync(repo);
  for (const extra of [["--headroom", "--cwd"], ["--config", "--out"], ["--headroom", "--no-open"]]) {
    const cli = Bun.spawnSync([process.execPath, SCRIPT, "dash", ...extra, repo], { env: cliEnv(home) });
    const out = JSON.parse(cli.stdout.toString());
    expect([cli.stderr.toString(), out.ok, out.error]).toEqual(["", false, expect.stringContaining("cannot be a value")]);
  }
});

// The page's own script, run against a minimal DOM: what a person reads on it, not how it is built.
class FakeNode {
  constructor(tag) { this.tag = tag; this.kids = []; this.attrs = {}; this.style = {}; this.own = ""; this.value = ""; this.clientWidth = 600; }
  get textContent() { return this.own + this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
  set textContent(v) { this.own = String(v); this.kids = []; }
  get options() { return this.kids.filter((k) => k.tag === "option"); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "value") this.value = String(v); }
  append(...ks) { this.kids.push(...ks); }
  replaceChildren(...ks) { this.kids = ks; this.own = ""; }
  addEventListener() {}
  getBoundingClientRect() { return { x: 0, y: 0 }; }
  all(tag) { return this.kids.flatMap((k) => (typeof k === "string" ? [] : [...(k.tag === tag ? [k] : []), ...k.all(tag)])); }
}
function drawPage(html) {
  const ids = new Map(), data = new FakeNode("script");
  data.textContent = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1];
  const document = {
    getElementById: (id) => (id === "data" ? data : ids.get(id) ?? (ids.set(id, new FakeNode("div")), ids.get(id))),
    createElement: (t) => new FakeNode(t), createElementNS: (_ns, t) => new FakeNode(t), querySelector: () => new FakeNode("div"),
  };
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function("document", "Node", "addEventListener", "innerWidth", code)(document, FakeNode, () => {}, 1024);
  return (id) => document.getElementById(id);
}
const rowsOf = (node) => node.all("tr").map((tr) => tr.all("td").map((td) => td.textContent)).filter((r) => r.length);

test("the page counts done first time out of every recorded run; mean attempts only from runs that recorded them", () => {
  const home = scratch("dash-first"), ledger = join(home, "ledger.jsonl"), at = "2026-10-01T00:00:00.000Z";
  writeFileSync(ledger, [entry({ ts: at }), entry({ ts: at, run_id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", outcome: { verdict: "done", check: "pass" } })].map((e) => JSON.stringify(e)).join("\n") + "\n");
  mkdirSync(join(home, "alpha")); // outside a repository the folder is the project, so the page opens on alpha's runs
  const $ = drawPage(htmlOf(go(["--no-open"], { home, ledger, cwd: join(home, "alpha"), now: () => "2026-10-02T00:00:00.000Z" })));
  expect($("project").value).toBe("alpha");
  const tiles = $("tiles").kids.map((t) => t.textContent);
  expect(tiles).toContain("50%done first time (1 of 2)");
  expect(rowsOf($("direction"))[0]).toEqual(["Followed", "2", "50% (1)", "1.0"]);
  expect(rowsOf($("choices"))[0].at(-1)).toBe("50% of 2");
  expect($("gaps").textContent).toContain("1 runs recorded no attempts: they are not done first time, and mean attempts leaves them out.");
});
