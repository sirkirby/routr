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
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import { readJsonFile, STATE_DIR, writeJsonAtomic } from "./runtime.mjs";

export const PROTO = 1;
// One frame holds a whole task: launch and send refuse a message over MESSAGE_MAX before anything starts. Until a peer
// has proved the secret, a frame is a handshake line and is held to 1 KB.
const MAX_LINE = 4 * 1024 * 1024, HANDSHAKE_LINE = 1024, HANDSHAKE_MS = 3000;
export const MESSAGE_MAX = 3 * 1024 * 1024;
// A proof or challenge is an HMAC-SHA256 in hex; nonces are 32 hex characters. Anything else is refused as it is.
const HEX64 = /^[0-9a-f]{64}$/, NONCE = /^[0-9a-f]{32}$/;
const WIN = () => process.platform === "win32";
const hmac = (key, s) => createHmac("sha256", key).update(s).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && HEX64.test(a) && HEX64.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
// Whether this home's socket paths fit, checked by launch before it starts anything (the longest name a generation
// below a million can take).
export const socketPathFits = () => WIN() || Buffer.byteLength(join(SOCKET_DIR(), "x".repeat(8) + ".999999." + "x".repeat(6))) <= SUN_MAX();
export function endpointFor(id, gen) {
  const r = randomBytes(8).toString("hex");
  if (WIN()) return `\\\\.\\pipe\\routr-${id.slice(0, 8)}-${r}`;
  const p = join(privateDir(SOCKET_DIR()), `${id.slice(0, 8)}.${gen}.${r.slice(0, 6)}`);
  if (Buffer.byteLength(p) > SUN_MAX()) throw fail("path_too_long", `the worker's socket path is ${Buffer.byteLength(p)} bytes, over this system's ${SUN_MAX()}-byte limit`);
  return p;
}
// An endpoint this channel made: a pipe of routr's, or a socket in routr's own folder for this run.
// Its folder exactly, a name of this run's own shape, and (to remove it) a socket, never a file or a link.
export const ownEndpoint = (id, endpoint) => typeof endpoint === "string" && (WIN() ? new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\routr-${id.slice(0, 8)}-[0-9a-f]{16}$`).test(endpoint)
  : dirname(endpoint) === SOCKET_DIR() && new RegExp(`^${id.slice(0, 8)}\\.\\d+\\.[0-9a-f]{6}$`).test(basename(endpoint)));

// ---- generations --------------------------------------------------------------------------------------------------
export const genFile = (dir, n, kind) => join(dir, `gen-${n}.${kind}`);
export const generations = (dir) => { try { return readdirSync(dir).map((f) => Number(f.match(/^gen-(\d+)\.claim$/)?.[1])).filter((n) => n > 0).sort((a, b) => a - b); } catch { return []; } };
// Exclusive and whole: the claim is written to a file of its own, then linked to its name, which fails when the name
// exists. Two claimants of one number cannot both win, the loser does not try the next, and no one reads a claim
// half written.
export function claim(dir, n) {
  const tmp = join(dir, `.claim-${n}-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
  try { linkSync(tmp, genFile(dir, n, "claim")); return true; }
  catch (e) { if (e?.code === "EEXIST") return false; throw e; }
  finally { rmSync(tmp, { force: true }); }
}
export const markReady = (dir, n, info) => writeJsonAtomic(genFile(dir, n, "ready"), info);
export const markReleased = (dir, n, info) => writeJsonAtomic(genFile(dir, n, "released"), { at: Date.now(), ...info });

// What the highest generation is: none, released (it ended and said so), starting (claimed, not bound yet, its claimant
// alive), abandoned (claimed, never bound, claimant gone: it never started a harness), alive (answered and proved the
// secret), dead (a definite no-listener), unreachable (anything else). A claimant's live pid may be a reused one,
// which only errs toward "starting", the safe side. A claim is never seen half written (claim, below); one with no
// readable pid was not written by routr, and is unreachable: nothing is assumed about it. So is a released marker that
// is there and cannot be read (readJsonFile), which says neither that the holder ended nor that it did not, and a
// ready marker (or, before it, a claim) that cannot be read when no release was recorded: a readable release is still
// the holder's word. Such
// an answer carries `unreadable: { file, code }`, so a command can name the file.
export async function probe(dir, { timeout = HANDSHAKE_MS } = {}) {
  const n = generations(dir).at(-1);
  if (!n) return { state: "none", gen: 0 };
  const releasedRead = readJsonFile(genFile(dir, n, "released")), readyRead = readJsonFile(genFile(dir, n, "ready"));
  const unreadable = (kind, code) => ({ state: "unreachable", gen: n, unreadable: { file: `gen-${n}.${kind}`, code } });
  if (releasedRead.unreadable) return unreadable("released", releasedRead.unreadable);
  const released = releasedRead.value ?? null, ready = readyRead.value ?? null;
  if (released) return { state: "released", gen: n, ready, released };
  if (readyRead.unreadable) return unreadable("ready", readyRead.unreadable);
  if (!ready) {
    const claimRead = readJsonFile(genFile(dir, n, "claim"));
    if (claimRead.unreadable) return unreadable("claim", claimRead.unreadable);
    const c = claimRead.value;
    if (Number.isInteger(c?.pid)) return { state: alivePid(c.pid) ? "starting" : "abandoned", gen: n };
    return { state: "unreachable", gen: n };
  }
  try {
    const c = await connect(dir, n, ready.endpoint, { timeout });
    const r = await c.request("ping", {}, timeout); c.close();
    return { state: "alive", gen: n, ready, ping: r };
  } catch (e) {
    // A holder that has just ended closes its channel right after it says so: read again before calling it dead.
    const late = readJsonFile(genFile(dir, n, "released"));
    if (late.unreadable) return { ...unreadable("released", late.unreadable), ready };
    if (late.value) return { state: "released", gen: n, ready, released: late.value };
    return { state: ["ENOENT", "ECONNREFUSED"].includes(e?.code) ? "dead" : "unreachable", gen: n, ready };
  }
}

// ---- framing ------------------------------------------------------------------------------------------------------
function lines(sock, onMsg, onBad, max = () => MAX_LINE) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    if (buf.length > max() && !buf.includes("\n")) return onBad("frame_too_large");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (l.length > max()) return onBad("frame_too_large");
      let m; try { m = JSON.parse(l); } catch { return onBad("frame_unreadable"); }
      if (!m || typeof m !== "object" || Array.isArray(m)) return onBad("frame_unreadable");
      Promise.resolve().then(() => onMsg(m)).catch(() => onBad("failed"));
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
      if (m.t === "err") return stop(fail(typeof m.code === "string" && /^[a-z_]{1,32}$/.test(m.code) ? m.code : "refused", "the holder refused the connection"));
      if (stage === "hello") {
        if (m.t !== "challenge" || !NONCE.test(m.ns ?? "")) return stop(fail("server_unproven", "the holder did not answer the handshake"));
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
        if (m.t !== "hello" || !NONCE.test(m.nc ?? "")) return bye("bad_hello");
        if (m.v !== PROTO) return bye("proto_mismatch");
        nc = m.nc; stage = "proof"; send(sock, { t: "challenge", v: PROTO, ns, ps: hmac(key, `s|${gen}|${nc}|${ns}`) }); return;
      }
      if (stage === "proof") {
        if (m.t !== "proof" || !same(m.pc, hmac(key, `c|${gen}|${ns}|${nc}`))) return bye("unproven");
        clearTimeout(t); stage = "open"; send(sock, { t: "ok" }); return;
      }
      if (m.t !== "req" || !Number.isInteger(m.id) || typeof m.op !== "string") return bye("bad_request");
      let r; try { r = await handle(m.op, m); } catch { r = { code: "failed" }; }
      send(sock, { t: "res", id: m.id, ...r });
    }, (code) => bye(code), () => (stage === "open" ? MAX_LINE : HANDSHAKE_LINE));
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => resolve(server)); });
}

// A dead generation's socket file, when it is this run's: nobody listens there and only that generation used the name.
export const removeEndpoint = (id, endpoint) => { if (!WIN() && ownEndpoint(id, endpoint)) try { if (lstatSync(endpoint).isSocket()) unlinkSync(endpoint); } catch {} };
