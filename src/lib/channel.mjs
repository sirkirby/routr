// The control channel to a headless worker's holder: the one process that owns the harness (headless.mjs). Measured as
// prototype p35 on macOS, Linux, Windows x64 and ARM64, compiled (routr-lab results/p35-channel-2026-10-21):
//   - Holdership is a numbered generation, claimed by exclusive create (`gen-N.claim`); five holders started at once,
//     exactly one won. Each generation binds its own endpoint and nothing deletes another live generation's.
//   - A generation is dead only on a definite "no listener" (ENOENT / ECONNREFUSED). Anything else, a timeout or a
//     refused proof, is unreachable: a frozen holder (SIGSTOP) timed out, it did not refuse.
//   - Both sides prove the run's secret before any text crosses: the server says nothing before the client's hello, and
//     the client sends no task until the server has proved itself (HMAC both ways). A wrong secret, an unproven client
//     and an impostor listening on the endpoint all got nothing.
//   - Windows: a named pipe, readable by Everyone and anonymous logons under libuv's default security (and remote
//     clients are not refused), so the handshake is the protection, not the pipe. POSIX: a Unix socket in an
//     owner-only folder (the socket file itself takes the umask), its path refused when over sun_path's limit.
// Requests are framed (one JSON line each, bounded), versioned, and answered by id with a fixed code.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { STATE_DIR, writeJsonAtomic } from "./runtime.mjs";

export const PROTO = 1;
const MAX_LINE = 64 * 1024, HANDSHAKE_MS = 3000;
const WIN = () => process.platform === "win32";
const hmac = (key, s) => createHmac("sha256", key).update(s).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
const fail = (code, message = code) => Object.assign(new Error(message), { code });

// A folder only this user can use: made 0700, and refused when it is a link, someone else's, or open to others
// (Windows: the user's profile folder already keeps others out; modes do not apply).
export function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw fail("not_private", `not a plain folder: ${dir}`);
  if (!WIN() && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid())) throw fail("not_private", `folder is open to others or not yours: ${dir}`);
  return dir;
}
export const SOCKET_DIR = () => join(STATE_DIR(), "s");
// The run's secret, written once, owner-only. Never in a process's arguments, never printed.
export const writeSecret = (dir) => writeFileSync(join(dir, "secret"), randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
const secretOf = (dir) => readFileSync(join(dir, "secret"), "utf8");

// sun_path holds 104 bytes on macOS and 108 on Linux, its NUL included. A longer path is refused, never moved or cut.
const SUN_MAX = () => (process.platform === "darwin" ? 103 : 107);
export function endpointFor(id, gen) {
  const r = randomBytes(8).toString("hex");
  if (WIN()) return `\\\\.\\pipe\\routr-${r}`;
  const p = join(privateDir(SOCKET_DIR()), `${id.slice(0, 8)}.${gen}.${r.slice(0, 6)}`);
  if (Buffer.byteLength(p) > SUN_MAX()) throw fail("path_too_long", `the worker's socket path is ${Buffer.byteLength(p)} bytes, over this system's ${SUN_MAX()}-byte limit`);
  return p;
}
// An endpoint this channel made: a pipe of routr's, or a socket in routr's own folder for this run.
export const ownEndpoint = (id, endpoint) => typeof endpoint === "string" && (WIN() ? /^\\\\\.\\pipe\\routr-[0-9a-f]{16}$/.test(endpoint)
  : endpoint.startsWith(SOCKET_DIR()) && /^[0-9a-f]{1,8}\.\d+\.[0-9a-f]{6}$/.test(endpoint.slice(SOCKET_DIR().length + 1)) && endpoint.slice(SOCKET_DIR().length + 1).startsWith(`${id.slice(0, 8)}.`));

// ---- generations --------------------------------------------------------------------------------------------------
export const genFile = (dir, n, kind) => join(dir, `gen-${n}.${kind}`);
export const generations = (dir) => { try { return readdirSync(dir).map((f) => Number(f.match(/^gen-(\d+)\.claim$/)?.[1])).filter((n) => n > 0).sort((a, b) => a - b); } catch { return []; } };
// Exclusive create: two claimants of one number cannot both win, and the loser does not try the next.
export function claim(dir, n) {
  try { writeFileSync(genFile(dir, n, "claim"), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 }); return true; }
  catch (e) { if (e?.code === "EEXIST") return false; throw e; }
}
export const markReady = (dir, n, info) => writeJsonAtomic(genFile(dir, n, "ready"), info);
export const markReleased = (dir, n, info) => writeJsonAtomic(genFile(dir, n, "released"), { at: Date.now(), ...info });

// What the highest generation is: none, released (it ended and said so), starting (claimed, not bound yet, its claimant
// alive), abandoned (claimed, never bound, claimant gone: it never started a harness), alive (answered and proved the
// secret), dead (a definite no-listener), unreachable (anything else). A claimant's live pid may be a reused one,
// which only errs toward "starting", the safe side.
export async function probe(dir, { timeout = HANDSHAKE_MS } = {}) {
  const n = generations(dir).at(-1);
  if (!n) return { state: "none", gen: 0 };
  const released = readJson(genFile(dir, n, "released"));
  const ready = readJson(genFile(dir, n, "ready"));
  if (released) return { state: "released", gen: n, ready, released };
  if (!ready) { const c = readJson(genFile(dir, n, "claim")); return { state: c && alivePid(c.pid) ? "starting" : "abandoned", gen: n }; }
  try {
    const c = await connect(dir, n, ready.endpoint, { timeout });
    const r = await c.request("ping", {}, timeout); c.close();
    return { state: "alive", gen: n, ready, ping: r };
  } catch (e) { return { state: ["ENOENT", "ECONNREFUSED"].includes(e?.code) ? "dead" : "unreachable", gen: n, ready }; }
}

// ---- framing ------------------------------------------------------------------------------------------------------
function lines(sock, onMsg, onBad) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    if (buf.length > MAX_LINE && !buf.includes("\n")) return onBad("frame_too_large");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (l.length > MAX_LINE) return onBad("frame_too_large");
      let m; try { m = JSON.parse(l); } catch { return onBad("frame_unreadable"); }
      if (!m || typeof m !== "object" || Array.isArray(m)) return onBad("frame_unreadable");
      onMsg(m);
    }
  });
}
const send = (sock, m) => { try { sock.write(JSON.stringify(m) + "\n"); } catch {} };

// ---- client: hello{v,nc} → challenge{ns, ps=H(k,"s|gen|nc|ns")} → proof{pc=H(k,"c|gen|ns|nc")} → ok, then requests --
export function connect(dir, gen, endpoint, { timeout = HANDSHAKE_MS, secret } = {}) {
  return new Promise((resolve, reject) => {
    let key; try { key = secret ?? secretOf(dir); } catch (e) { return reject(fail("no_secret", e?.message)); }
    const sock = net.createConnection(endpoint);
    const nc = randomBytes(16).toString("hex");
    let stage = "connect", settled = false, id = 0;
    const waiting = new Map();
    const stop = (e) => { if (settled) return; settled = true; clearTimeout(t); sock.destroy(); reject(e); };
    const t = setTimeout(() => stop(fail("ETIMEDOUT", "handshake timed out")), timeout);
    sock.on("error", (e) => { stop(e); for (const [, w] of waiting) w.reject(e); waiting.clear(); });
    sock.on("close", () => { stop(fail("ECLOSED", "closed during handshake")); for (const [, w] of waiting) w.reject(fail("ECLOSED", "closed")); waiting.clear(); });
    sock.on("connect", () => { stage = "hello"; send(sock, { t: "hello", v: PROTO, nc }); });
    lines(sock, (m) => {
      if (stage === "hello") {
        if (m.t !== "challenge") return stop(fail("server_unproven", "the holder did not answer the handshake"));
        if (m.v !== PROTO) return stop(fail("proto_mismatch", "the holder speaks another protocol version"));
        if (!same(m.ps, hmac(key, `s|${gen}|${nc}|${m.ns}`))) return stop(fail("server_unproven", "the holder did not prove the run's secret"));
        stage = "proof"; send(sock, { t: "proof", pc: hmac(key, `c|${gen}|${m.ns}|${nc}`) }); return;
      }
      if (stage === "proof") {
        if (m.t !== "ok") return stop(fail("client_refused", "the holder refused this client's proof"));
        stage = "open"; settled = true; clearTimeout(t);
        return resolve({
          request: (op, extra = {}, ms = 5000) => new Promise((res, rej) => {
            const i = ++id;
            const tt = setTimeout(() => { waiting.delete(i); rej(fail("ETIMEDOUT", `${op} timed out`)); }, ms);
            waiting.set(i, { resolve: (v) => { clearTimeout(tt); res(v); }, reject: (e) => { clearTimeout(tt); rej(e); } });
            send(sock, { t: "req", id: i, op, ...extra });
          }),
          close: () => sock.end(),
        });
      }
      if (m.t === "res" && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w.resolve(m); }
    }, (code) => stop(fail(code)));
  });
}

// ---- server: `handle(op, message)` answers each request with { code, ... } ------------------------------------------
export function serve(dir, gen, endpoint, handle) {
  const key = secretOf(dir);
  const server = net.createServer((sock) => {
    let stage = "hello", nc = null;
    const ns = randomBytes(16).toString("hex");
    const bye = (code) => { send(sock, { t: "err", code }); sock.destroy(); };
    const t = setTimeout(() => bye("handshake_timeout"), HANDSHAKE_MS);
    sock.on("error", () => {});
    sock.on("close", () => clearTimeout(t));
    lines(sock, async (m) => {
      if (stage === "hello") {
        if (m.t !== "hello" || typeof m.nc !== "string" || m.nc.length > 64) return bye("bad_hello");
        nc = m.nc; stage = "proof"; send(sock, { t: "challenge", v: PROTO, ns, ps: hmac(key, `s|${gen}|${nc}|${ns}`) }); return;
      }
      if (stage === "proof") {
        if (m.t !== "proof" || !same(m.pc, hmac(key, `c|${gen}|${ns}|${nc}`))) return bye("unproven");
        clearTimeout(t); stage = "open"; send(sock, { t: "ok" }); return;
      }
      if (m.t !== "req" || !Number.isInteger(m.id) || typeof m.op !== "string") return bye("bad_request");
      let r; try { r = await handle(m.op, m); } catch { r = { code: "failed" }; }
      send(sock, { t: "res", id: m.id, ...r });
    }, (code) => bye(code));
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => resolve(server)); });
}

// A dead generation's socket file, when it is this run's: nobody listens there and only that generation used the name.
export const removeEndpoint = (id, endpoint) => { if (!WIN() && ownEndpoint(id, endpoint) && existsSync(endpoint)) try { unlinkSync(endpoint); } catch {} };
