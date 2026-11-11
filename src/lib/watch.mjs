// `routr watch`: one headless worker's progress, followed in a terminal until it is cleaned up. It reads what the holder
// wrote and changes nothing, so closing it stops nothing. Fixed words only: tool names, states and report paths, never
// the worker's text. In a herdr-core terminal it also reports status over OSC 7501, the only way core takes one.
import { workers } from "./worker.mjs";
import { inCore } from "./backends.mjs";
import { HARNESSES } from "./harnesses.mjs";
import { parseNamed } from "./workers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base64 = (s) => Buffer.from(s).toString("base64");
// A worker's state as program status. `unreadable` says nothing: it may be running, and the last report stands.
const STATUS = { starting: "working", working: "working", waiting: "working", idle: "done", stopped: "idle", failed: "error", no_task: "error", lost: "error", unreachable: "error" };
// Core's own encoding (crates/herdr-core/src/status.rs): fields joined by ":", title and msg in base64, ended by ST.
export const statusReport = (v) => {
  const state = STATUS[v.state];
  return state ? `\x1b]7501;state=${state}:app=${HARNESSES[v.kind]?.app ?? v.kind}:title=${base64(v.name)}\x1b\\` : null;
};
// The lines a new look at the worker adds, oldest first. `seen` is what was already said, and is updated.
export function changes(v, seen, at = "") {
  const lines = [], say = (text) => lines.push(`${at ? `${at}  ` : ""}${text}`);
  for (const t of v.turns ?? []) {
    if (t.outcome === "running" || seen.turns.has(t.turn)) continue;
    seen.turns.add(t.turn);
    say(`turn ${t.turn} ended (${t.outcome})${t.report ? `: report at ${t.report}` : ""}`);
  }
  const tool = v.last_tool && v.state === "working" ? v.last_tool : null;
  if (v.state !== "unreadable" && (v.state !== seen.state || v.turn !== seen.turn || (tool && tool !== seen.tool) || (v.tasks ?? 0) !== (seen.tasks ?? 0))) {
    say(`${v.state}${v.turn ? `, turn ${v.turn}` : ""}${tool ? `, ${tool}` : ""}${v.tasks ? `, ${v.tasks} background command${v.tasks > 1 ? "s" : ""}` : ""}`);
    seen.state = v.state; seen.turn = v.turn; seen.tool = tool; seen.tasks = v.tasks ?? 0;
  }
  return lines;
}
const clock = (t) => new Date(t).toTimeString().slice(0, 8);

export async function watchCommand(args, { env = process.env, write = (s) => process.stdout.write(s), pause = sleep, now = () => Date.now(), workers: ws = workers({ env }) } = {}) {
  const o = parseNamed(args, "watch", ["name"]);
  if (o.names.length !== 1) throw new Error("watch takes one --name");
  const name = o.names[0], it = ws.one(name), off = it.follows("watch");
  // One whose record cannot be read is not followed: what it is is not known.
  if (!it.record) throw new Error(`no worker named ${name}; routr workers lists them`);
  if (off) throw new Error(`${off.why}; its terminal shows it`);
  const w = it.record, status = inCore(env), seen = { turns: new Set(), state: null, turn: null, tool: null };
  write(`${status ? `\x1b]2;${name}\x07` : ""}routr worker ${name}: ${HARNESSES[w.kind]?.label ?? w.kind}, ${w.model}${w.effort ? ` at ${w.effort}` : ""}\nin ${w.cwd}\nClosing this does not stop the worker. Ends when the worker is cleaned up.\n\n`);
  let last = null;
  for (;;) {
    // Gone, or another worker launched under this name since: this one is over. A record it cannot read just now is
    // neither: view shows it as `unreadable`, and it is looked at again. Every look asks the holder, so a lost worker
    // stays lost: without that, its saved state would read `working` again between checks.
    const id = it.still(), v = id === "same" || id.unreadable ? (await it.look())?.view : null;
    if (!v) { write(`${clock(now())}  cleaned up\n`); return 0; }
    for (const l of changes(v, seen, clock(now()))) write(`${l}\n`);
    const report = status ? statusReport(v) : null;
    if (report && report !== last) { write(report); last = report; }
    // view looks for a group left behind once a worker is not running, which starts ps: less often then.
    await pause(STATUS[v.state] === "working" ? 1000 : 3000);
  }
}
