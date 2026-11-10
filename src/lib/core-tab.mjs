// A terminal for a worker in herdr-core, in a tab of its own when the lead is in the app: which space, which names, and
// what the app is told. The terminal backend opens a worker's terminal here.
import { callHc, client, isAddress, renameTab } from "./hc.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// hc's names are unique among live terminals, at most 32 of the characters a worker's name uses, and the app's pop-ups
// say them, so a worker's own name comes first. One hc refuses gets one more try with the worker's id: a name used again
// before the last worker's terminal has gone needs that, and a refusal for any other reason refuses again.
const withId = (name, id) => `${name.slice(0, 23)}-${id.slice(0, 8)}`;

// The lead's own terminal: its address, and the app's space it is in (null off the app). Answers `{ code }` with one of
// callHc's codes when hc does not answer for it.
export async function leadTerminal(env, run = client) {
  const me = await callHc(["get", env.HC_TERMINAL_ID, "--json"], run);
  if (!me.ok) return { code: me.code };
  const space = me.data?.labels?.["herdr.space"];
  return { address: isAddress(me.data?.address) ? me.data.address : env.HC_TERMINAL_ID, space: typeof space === "string" && space ? space : null };
}

// Off the app (no space label) it is still a terminal, listed by `hc ls`. It outlives the lead and types nothing into the
// lead. `labels`: its own, beside the app's. `trying(name)`: told each name before it is asked for.
// Answers `{ terminal, name, tab }`, or `{ code, name }` with one of callHc's codes and what it last asked for.
export async function openTerminal({ name, id, cwd, lead, argv, labels = [], trying = () => {}, run = client, pause = sleep }) {
  const tab = lead.space ? `routr-${id}` : null;
  const open = (terminal) => { trying(terminal); return callHc(["run", "--bg", "--json", "--name", terminal, "--cwd", cwd, "--outlive-parent", "--no-notify",
    ...(tab ? ["--label", `herdr.space=${lead.space}`, "--label", `herdr.tab=${tab}`] : []), ...labels.flatMap((l) => ["--label", l]), "--", ...argv], run); };
  let terminal = name, r = await open(terminal);
  if (r.code === "refused") r = await open(terminal = withId(name, id));
  if (!r.ok) return { code: r.code, name: terminal };
  if (!isAddress(r.data?.address)) return { code: "unreadable", name: terminal };
  // The app numbers a tab it did not make. It takes a moment to adopt the terminal; a name that never lands costs only
  // the name, and with no app running there is nothing to name.
  if (tab) for (let i = 0; i < 6; i++) { if (await renameTab(tab, name, run)) break; await pause(300); }
  return { terminal: r.data.address, name: terminal, tab };
}
