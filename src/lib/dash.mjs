// `routr dash`: one HTML page of this machine's ledger, all of it, the latest revision of each run. It counts what was
// asked, what was chosen and how it turned out. It calls no harness and makes no network call. The page is embedded
// the way the guides are, so a compiled binary writes it with no checkout beside it. Each row is projected field by
// field: never a note, a brief's hash or length, an advice id, a run id or a path.
import page from "./dash.html" with { type: "text" };
import { chmodSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { firstTime, LEDGER_PATH, latestRuns, projectAdvised, projectChose, read, repositoryName } from "./ledger.mjs";
import { doNext } from "./next.mjs";
import { answer, refusal } from "./output.mjs";
import { CACHE_DIR, home, writeTextAtomic } from "./state-files.mjs";
import { openInBrowser } from "./processes.mjs";

const LEDGER_WHY = "The ledger could not be read: runs are not shown, and their counts are unknown";
// The page carries this, and `--out` replaces a file only when the file already carries it.
export const DASH_PAGE = '<meta name="generator" content="routr dash">';
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// One row the page can draw. Names are the page's. advised and chose are the ledger's scalars; anything else stays out.
export function dashRow(e) {
  const advised = projectAdvised(e.advised), chose = projectChose(e.chose), outcome = obj(e.outcome) ? e.outcome : null;
  const headroom = obj(e.headroom) ? e.headroom : {};
  return {
    t: typeof e.ts === "string" ? e.ts : null, p: typeof e.project === "string" ? e.project : null,
    a: advised?.level ?? null, unsure: advised?.sure === false, risk: !!advised?.high_risk,
    c: chose?.level ?? null, s: chose?.subscription ?? null, m: chose?.model ?? null, f: chose?.effort ?? null,
    first: outcome ? firstTime({ outcome }) : false, attempts: Number.isInteger(outcome?.attempts) ? outcome.attempts : null,
    fail: outcome?.check === "fail", causes: Array.isArray(outcome?.causes) ? outcome.causes.filter((x) => typeof x === "string") : [],
    room: Object.fromEntries(Object.entries(headroom).flatMap(([k, v]) => (Number.isFinite(v?.usable) ? [[k, v.usable]] : []))),
  };
}
export const dashRows = (entries) => latestRuns(entries).map(dashRow);

// `<` becomes a JSON escape, so a name cannot close the script tag the JSON sits in. The page draws with textContent.
export function dashHtml({ rows, at, project, unavailable = null }) {
  const json = JSON.stringify({ rows, at, project, unavailable }).replace(/</g, "\\u003c");
  return page.replace("/*DATA*/", () => json);
}

function parse(words) {
  const o = { noOpen: false }, rest = [...words];
  while (rest.length) {
    const w = rest.shift();
    if (w === "--no-open") {
      if (o.noOpen) throw new Error("dash: --no-open was given more than once");
      o.noOpen = true; continue;
    }
    if (w !== "--cwd" && w !== "--out") throw new Error(`dash: unknown ${w.startsWith("-") ? "flag" : "argument"} ${w}; routr dash [--cwd <folder>] [--out <file>] [--no-open]`);
    const key = w === "--cwd" ? "cwd" : "out";
    if (o[key] != null) throw new Error(`dash: ${w} was given more than once`);
    const v = rest.shift();
    if (!v || v.startsWith("--")) throw new Error(`dash: ${w} takes ${w === "--cwd" ? "a folder" : "a file"}`);
    if (w === "--cwd") {
      let dir; try { dir = statSync(resolve(v)).isDirectory(); } catch { dir = false; }
      if (!dir) throw new Error(`dash: --cwd ${v} is not a folder`);
      o.cwd = resolve(v);
    } else {
      const file = resolve(v);
      let dir = false; try { dir = statSync(file).isDirectory(); } catch {}
      if (dir) throw new Error(`dash: --out ${v} is a folder`);
      o.out = file;
    }
  }
  return o;
}

// null: nothing is there to replace (including a parent that is a file). false: something is there and it is not a
// page this command wrote, so `--out` refuses. A symlink is read for that check and, when it is a page, replaced.
function dashPage(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() && !st.isSymbolicLink()) return false;
    return readFileSync(file, "utf8").includes(DASH_PAGE);
  } catch (e) { return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? null : false; }
}

function writePage(file, html) {
  writeTextAtomic(file, html, { mode: 0o600 }); // rename over the path: a symlink there is replaced, not followed
  if (process.platform !== "win32") chmodSync(file, 0o600); // the mode flag is masked by the umask; this is the mode asked for
}

// `home` is where the default file goes. `open` is the browser start (openInBrowser). `output.isTTY` is the terminal.
export function dashCommand(words, { warnings = [], ledger = LEDGER_PATH(), home: homeDir = home(), cwd = process.cwd(), output = process.stdout, open = openInBrowser, now = () => new Date().toISOString() } = {}) {
  let o;
  try { o = parse(words); } catch (e) { return refusal("no dash", e.message, warnings); }
  const folder = o.cwd ?? resolve(cwd), project = repositoryName(folder), file = o.out ?? join(CACHE_DIR(homeDir), "dash.html");
  if (o.out) {
    const own = dashPage(file);
    if (own === false) return refusal("no dash", `dash: ${file} is not a page routr dash wrote; choose another`, warnings);
  }
  let entries, unreadable = false;
  try { entries = read(ledger); } catch { unreadable = true; }
  const rows = unreadable ? [] : dashRows(entries), runs = unreadable ? null : rows.length;
  const unavailable = unreadable ? [{ part: "ledger", code: "unreadable", why: LEDGER_WHY }] : [];
  const html = dashHtml({ rows, at: now(), project, unavailable: unreadable ? LEDGER_WHY : null });
  try { writePage(file, html); } catch { return refusal("no dash", `dash: could not write ${file}`, warnings); }
  const terminal = Boolean(output.isTTY), tryOpen = terminal && !o.noOpen;
  let opened = false;
  if (tryOpen) try { opened = open(file) === true; } catch { opened = false; }
  const count = runs == null ? "" : ` (${runs} ${runs === 1 ? "run" : "runs"})`;
  const openBit = opened ? " and opened it" : tryOpen ? "; could not open it" : "";
  const lead = unreadable ? "the ledger could not be read; " : "";
  return answer({ ok: true, headline: `routr: ${lead}wrote ${file}${count}${openBit}`, unavailable, warnings: [...warnings],
    next: opened ? [] : [doNext(`Give the person this path: ${file}`)], file, opened, runs, project });
}
