// telemetry.mjs: what is shared, when, and that nothing leaks
import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { COMMANDS } from "../src/lib/help.mjs";
import { row, scratch } from "./helpers.mjs";
test("shared rows carry what tuning needs and nothing that identifies the user or the work", async () => {
  const { shareRows } = await import("../src/lib/ledger.mjs");
  const text = JSON.stringify(shareRows([row()]));
  for (const secret of ["abc12345", "deadbeefcafe", "billing", "acme", "10:11", "big-model", "small-model", "usable"]) expect(text).not.toContain(secret);
  const [r] = shareRows([row()]);
  expect(r).toMatchObject({ v: 1, day: "2026-09-21", advised: { level: "standard", facts: { approach_open: 0.9 } }, chose: { subscription: "codex", level: "standard" }, outcome: { attempts: 1 }, subagents: [{ advised: "basic" }] });
  expect(JSON.stringify(shareRows([row()], { withModels: true }))).toContain("big-model");
});

test("the Jev version that answered travels from the advice into the ledger and the shared rows", async () => {
  const { toEntry, shareRows } = await import("../src/lib/ledger.mjs");
  const e = toEntry({ id: "x", level: "basic", sure: true, facts: {}, question_set: "r4", jev_model: "jev-9.9.9" }, { verdict: "done", check: "pass" });
  expect(e.jev_model).toBe("jev-9.9.9");
  expect(shareRows([e])[0].jev_model).toBe("jev-9.9.9");                   // routr's model, not the user's: it identifies nothing
  expect(toEntry({ id: "y", level: "basic", sure: false, facts: {}, fallback: true }, {}).jev_model).toBeNull(); // fallback advice: Jev never answered
  expect(shareRows([row()])[0].jev_model).toBeNull();                         // rows written before the field existed
});

test("telemetry rows carry what tuning needs, never text or anything that points back at the user's work", async () => {
  const { telemetryRows } = await import("../src/lib/telemetry.mjs");
  const [r] = telemetryRows([row({ jev_model: "jev-1.13.0" })], "install-a");
  const text = JSON.stringify(r);
  for (const secret of ["abc12345", "deadbeefcafe", "billing", "acme", "10:11", "usable", "count files"]) expect(text).not.toContain(secret);
  expect(r).toMatchObject({ day: "2026-09-21", jev_model: "jev-1.13.0", chose: { model: "big-model" }, outcome: { seconds: 60 }, subagents: [{ advised: "basic", model: "small-model" }] });
  // Anything typed by hand is cut to a known value or a short name before it can leave the machine.
  const [h] = telemetryRows([row({ chose: { subscription: "codex", model: "sonnet, since the acme repo's Stripe key handling is subtle", effort: "high", level: "extreme" },
    outcome: { verdict: "done: fixed the acme migration", check: "pass", attempts: 1 }, subagents: [{ subtask: "x", advised: "strong", model: "sonnet because billing is hard" }] })], "install-a");
  expect(h.chose).toEqual({ subscription: "codex", model: "other", effort: "high", level: "other" });
  expect(h.outcome.verdict).toBe("other");
  expect(h.subagents).toEqual([{ advised: "strong", model: "other" }]);
  expect(JSON.stringify(h)).not.toMatch(/acme|billing|Stripe/);
  expect(telemetryRows([5, null, { ts: "x" }, row()], "install-a")).toHaveLength(1);                   // a line that is not a row is skipped
  // No shape admits a path, URL, email, token, or a project name where only a known value belongs (the review's cases).
  const [p] = telemetryRows([row({ question_set: "https://acme.internal/q", jev_model: "chris@acme.com",
    advised: { level: "standard", sure: true, work_type: "fix-the-acme-payments-webhook", facts: { approach_open: 0.9, acme_payments_secret_project: 0.5 } },
    chose: { subscription: "acme-corp-enterprise", model: "/Users/chris/Repos/acme-secret", effort: "ghp_16C7e42F292c6912E7710c838347Ae178B4a", level: "standard" },
    subagents: [{ advised: "strong", model: "/Users/chris/acme-payments/src/billing.ts" }, { advised: "basic", model: "sk-proj-AbCdEfGhIjKlMnOpQrStUv" }] })], "install-a");
  expect(JSON.stringify(p)).not.toMatch(/acme|Users|ghp_|sk-proj|@|https/);
  expect(p.advised.facts).toEqual({ approach_open: 0.9 });
  for (const m of ["gpt-5.6-terra", "claude-opus-5-5[1m]", "cursor-grok-4.6-high", "gemini-3.8-flash-medium", "opus"])
    expect(telemetryRows([row({ chose: { subscription: "codex", model: m, effort: "xhigh", level: "strong" } })], "i")[0].chose).toEqual({ subscription: "codex", model: m, effort: "xhigh", level: "strong" });
  expect(telemetryRows([row({ chose: { subscription: "agy", model: "x", effort: "default", level: "basic" } })], "i")[0].chose.effort).toBe("default"); // seen in a real row
  expect(r.row_key).toMatch(/^[0-9a-f]{32}$/);
  expect(telemetryRows([row({ jev_model: "jev-1.13.0" })], "install-a")[0].row_key).toBe(r.row_key); // resending is harmless
  expect(telemetryRows([row()], "install-b")[0].row_key).not.toBe(r.row_key);                         // and unlinkable across installs
  // The endpoint refuses any string longer than 80 characters: a row must never need one.
  const long = []; JSON.stringify(r, (k, v) => { if (typeof v === "string" && v.length > 80) long.push(k); return v; });
  expect(long).toEqual([]);
});

test("telemetry is off unless the person turns it on, and the usual switches keep it off", async () => {
  const { telemetryStatus, setTelemetry } = await import("../src/lib/telemetry.mjs");
  const yes = { opted_in_at: "2026-09-24T00:00:00.000Z" };
  expect(telemetryStatus({}, {}, {}).on).toBe(false);                               // the default: nothing is shared
  expect(telemetryStatus({ telemetry: "yes" }, {}, yes).on).toBe(false);            // only a real true turns it on
  expect(telemetryStatus({ telemetry: true }, {}, yes).on).toBe(true);
  expect(telemetryStatus({ telemetry: true }, {}, {}).why_off).toContain("before sharing became opt-in"); // 0.1.21's default yes is not a yes
  expect(telemetryStatus({ telemetry: true }, { DO_NOT_TRACK: "1" }, yes).why_off).toBe("DO_NOT_TRACK is set");
  expect(telemetryStatus({ telemetry: true }, { DO_NOT_TRACK: "0" }, yes).on).toBe(true);
  expect(telemetryStatus({ telemetry: true }, { ROUTR_TELEMETRY: "off" }, yes).on).toBe(false);
  expect(telemetryStatus({ telemetry: true }, { CI: "true" }, yes).why_off).toBe("running in CI");
  const { loadConfig } = await import("../src/lib/config.mjs");
  const dir = scratch("tel"), ledger = join(dir, "ledger.jsonl");
  try {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ prefer: { review: "standard" } }));
    expect(loadConfig(join(dir, "c.json")).config.telemetry).toBe(false);
    expect(loadConfig(join(dir, "missing.json")).config.telemetry).toBe(false);
    // Turning it on records the yes and starts the mark at that moment, so nothing from before (or from a stretch with
    // it off) is ever sent by the daily job.
    writeFileSync(join(dir, "telemetry.json"), JSON.stringify({ install_id: "i", started: "2026-01-01T00:00:00.000Z", sent_through: "2026-01-02T00:00:00.000Z" }));
    expect(setTelemetry(true, join(dir, "c.json"), { ledger, now: "2026-07-01T00:00:00.000Z" }).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "c.json"), "utf8"))).toEqual({ prefer: { review: "standard" }, telemetry: true }); // the rest is kept
    expect(JSON.parse(readFileSync(join(dir, "telemetry.json"), "utf8"))).toEqual({ install_id: "i", opted_in_at: "2026-07-01T00:00:00.000Z", started: "2026-07-01T00:00:00.000Z", sent_through: "2026-07-01T00:00:00.000Z" });
    expect(loadConfig(join(dir, "c.json")).config.telemetry).toBe(true);
    setTelemetry(false, join(dir, "c.json"), { ledger });
    expect(JSON.parse(readFileSync(join(dir, "telemetry.json"), "utf8")).opted_in_at).toBeNull();
    // A hand edit to false, seen by the daily job, withdraws the yes too.
    const { forgetConsentUnlessOn } = await import("../src/lib/telemetry.mjs");
    setTelemetry(true, join(dir, "c.json"), { ledger });
    forgetConsentUnlessOn({ telemetry: false }, ledger);
    expect(JSON.parse(readFileSync(join(dir, "telemetry.json"), "utf8")).opted_in_at).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("telemetry sends only rows it has not sent, and moves on only after the endpoint accepts them", async () => {
  const dir = scratch("send");
  try {
    const ledger = join(dir, "ledger.jsonl");
    writeFileSync(ledger, [row({ ts: "2026-09-21T10:00:00.000Z" }), row({ ts: "2026-09-22T10:00:00.000Z" })].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { sendRows } = await import("../src/lib/telemetry.mjs");
    const bodies = [];
    let status = 500;
    const fetchFn = async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response("{}", { status }); };
    // The first send on an install starts from now: history recorded before telemetry arrived stays local.
    expect(await sendRows({ ledger, fetchFn, now: "2026-09-23T00:00:00.000Z" })).toEqual({ ok: true, sent: 0 });
    expect(bodies).toHaveLength(0);
    writeFileSync(join(dir, "telemetry.json"), JSON.stringify({ started: "2026-09-01T00:00:00.000Z", sent_through: "2026-09-01T00:00:00.000Z" }));
    const failed = await sendRows({ ledger, fetchFn });
    expect(failed.ok).toBe(false);
    status = 200;
    expect((await sendRows({ ledger, fetchFn })).sent).toBe(2);   // the failed batch is sent again
    expect((await sendRows({ ledger, fetchFn })).sent).toBe(0);   // and not a third time
    expect(bodies[1].rows.length).toBe(2);
    expect((await sendRows({ ledger, fetchFn, all: true })).sent).toBe(2);                     // --all: everything, on request
    expect(bodies[1]).toMatchObject({ version: expect.any(String), os: `${process.platform}-${process.arch}` });
    expect(JSON.stringify(bodies)).not.toContain("private note");
    expect(JSON.parse(readFileSync(join(dir, "telemetry.json"), "utf8")).sent_through).toBe("2026-09-22T10:00:00.000Z"); // beside the ledger it read
    const { pendingCount } = await import("../src/lib/telemetry.mjs");
    expect(pendingCount(ledger)).toBe(0);
    writeFileSync(ledger, readFileSync(ledger, "utf8") + JSON.stringify(row({ ts: "2026-09-23T10:00:00.000Z" })) + "\n");
    expect(pendingCount(ledger)).toBe(1);                                                        // what share reports as waiting
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("feedback sends what the person wrote, and nothing when there is nothing to send", async () => {
  const { sendFeedback } = await import("../src/lib/telemetry.mjs");
  const dir = scratch("fb"), ledger = join(dir, "ledger.jsonl");
  const sent = [];
  const fetchFn = async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  expect((await sendFeedback("  ", { fetchFn, ledger })).ok).toBe(false);
  expect((await sendFeedback("x".repeat(4001), { fetchFn, ledger })).ok).toBe(false);
  expect((await sendFeedback("the cursor usage read failed twice", { fetchFn, ledger })).ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toBe("the cursor usage read failed twice");
  rmSync(dir, { recursive: true, force: true });
});

test("Jev is asked for the pinned version unless ROUTR_JEV_MODEL names another", async () => {
  const { JEV_MODEL } = await import("../src/lib/questions.mjs");
  const { ask, jevModel } = await import("../src/lib/jev.mjs");
  expect(JEV_MODEL).toMatch(/^jev-\d+\.\d+\.\d+$/);                          // an exact version, never an alias that moves under the evidence
  const saved = { env: process.env.ROUTR_JEV_MODEL, key: process.env.TYPESAFE_API_KEY, fetch: globalThis.fetch };
  const sent = [];
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init.body).model); return new Response(JSON.stringify({ model: "jev-x", answers: {} })); };
  process.env.TYPESAFE_API_KEY = "test-key";
  try {
    delete process.env.ROUTR_JEV_MODEL;
    expect(jevModel()).toBe(JEV_MODEL);
    await ask({}, {});
    process.env.ROUTR_JEV_MODEL = " jev-preview ";
    expect(jevModel()).toBe("jev-preview");
    await ask({}, {});
    expect(sent).toEqual([JEV_MODEL, "jev-preview"]);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [["ROUTR_JEV_MODEL", saved.env], ["TYPESAFE_API_KEY", saved.key]]) v == null ? delete process.env[k] : (process.env[k] = v);
  }
});

// ---- Telemetry: data must not be LOST either. Leak tests above check that text cannot get out; these check that real
// values survive, that what routr says about sending matches what it does, and that the disclosure page lists every field.
test("every value seen in real rows, and every value routr documents, survives telemetry as itself", async () => {
  const { telemetryRows } = await import("../src/lib/telemetry.mjs");
  const seen = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/seen-values.json"), "utf8"));
  // What `routr record` documents (help table) belongs in the seen lists too.
  const doc = Object.fromEntries(COMMANDS.record.flags.filter((f) => /^<.*\|.*>$/.test(f.arg ?? "")).map((f) => [f.name.slice(2), f.arg.slice(1, -1).split("|")]));
  for (const k of ["verdict", "check"]) for (const v of doc[k]) expect(seen[k]).toContain(v);
  const { HARNESSES } = await import("../src/lib/harnesses.mjs");
  expect(seen.subscription.sort()).toEqual(Object.keys(HARNESSES).sort());
  const lost = [];
  const at = (field, v) => row({ chose: { subscription: field === "subscription" ? v : "codex", model: field === "model" ? v : "m-1", effort: field === "effort" ? v : "low", level: "basic" },
    outcome: { verdict: field === "verdict" ? v : "done", check: field === "check" ? v : "pass", attempts: 1 } });
  for (const field of ["effort", "model", "subscription", "verdict", "check"]) for (const v of seen[field]) {
    const [r] = telemetryRows([at(field, v)], "i");
    const got = { effort: r.chose.effort, model: r.chose.model, subscription: r.chose.subscription, verdict: r.outcome.verdict, check: r.outcome.check }[field];
    if (got !== v) lost.push(`${field}=${v} → ${got}`);
  }
  expect(lost).toEqual([]);
});

test("routr share says what will really happen to the rows, in each state", async () => {
  const { shareCommand } = await import("../src/lib/commands.mjs");
  const dir = scratch("sharemsg"), ledger = join(dir, "ledger.jsonl"), out = join(dir, "out.jsonl");
  try {
    writeFileSync(ledger, [row({ ts: "2026-09-21T10:00:00.000Z" }), row({ ts: "2026-09-23T10:00:00.000Z" })].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const say = (config, isStandalone = () => true, env = {}) => shareCommand({ ledger, out }, config, { env, isStandalone });
    expect(say({ telemetry: false })).toContain("none of these is shared");
    expect(existsSync(join(dir, "telemetry.json"))).toBe(false);                 // looking creates no install id
    writeFileSync(join(dir, "telemetry.json"), JSON.stringify({ opted_in_at: "2026-09-22T00:00:00.000Z", sent_through: "2026-09-22T00:00:00.000Z" }));
    const on = say({ telemetry: true });
    expect(on).toContain("1 of these is waiting to be sent");                     // only the row after the yes
    expect(on).toContain("once a day");
    const source = say({ telemetry: true }, () => false);
    expect(source).not.toContain("once a day");                                    // the daily job does not run from source
    expect(source).toContain("routr telemetry send");
    expect(say({ telemetry: true }, () => true, { DO_NOT_TRACK: "1" })).toContain("none of these is shared");
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(2);         // the file shows every row, in sent form
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("docs/telemetry.md lists every field a sent row carries", async () => {
  const { telemetryRows } = await import("../src/lib/telemetry.mjs");
  const page = readFileSync(join(import.meta.dir, "../docs/telemetry.md"), "utf8").toLowerCase();
  const [r] = telemetryRows([row({ jev_model: "jev-1.13.0" })], "i");
  const missing = [];
  for (const [k, v] of Object.entries(r)) {
    if (!page.includes(`\`${k}\``)) missing.push(k);
    if (v && typeof v === "object" && !Array.isArray(v) && k !== "facts")
      for (const sub of Object.keys(v)) if (sub !== "facts" && !page.includes(sub.replace(/_/g, " ")) && !page.includes(sub)) missing.push(`${k}.${sub}`);
  }
  expect(missing).toEqual([]);
});

test("end to end: nothing leaves before a yes, then only rows after it, with no text (real CLI, mock endpoint)", async () => {
  const got = [];
  const server = Bun.serve({ port: 0, fetch: async (req) => { const b = await req.json(); got.push(b); return Response.json({ accepted: b.rows?.length ?? 0, refused: 0 }); } });
  const home = scratch("e2e");
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, ROUTR_NO_UPDATE: "1", ROUTR_TELEMETRY_URL: `http://127.0.0.1:${server.port}`, TYPESAFE_API_KEY: "" };
    for (const k of ["CI", "DO_NOT_TRACK", "ROUTR_TELEMETRY", "GITHUB_ACTIONS"]) delete env[k];
    const cli = (...args) => Bun.spawn(["bun", join(import.meta.dir, "../src/routr.mjs"), ...args], { env, stdout: "pipe", stderr: "pipe" });
    const run = async (...args) => { const p = cli(...args); const [o] = await Promise.all([new Response(p.stdout).text(), p.exited]); return o; };
    const advice = join(home, "advice.json");
    const record = async () => {
      writeFileSync(advice, JSON.stringify({ id: "a1b2c3d4", ts: new Date().toISOString(), mode: "dispatch", question_set: "r4", jev_model: "jev-1.13.0", brief_sha: "deadbeefcafe", brief_chars: 900,
        level: "standard", sure: true, work_type: "debug", high_risk: false, facts: { approach_open: { p: 0.9 }, cause_unknown: { p: 0.95 } } }));
      await run("record", "--advice", advice, "--subscription", "codex", "--model", "gpt-5.6-terra", "--effort", "default", "--verdict", "done: fixed the acme billing bug", "--check", "pass", "--note", "private: acme", "--project", "acme-payments");
    };
    await record();                                                              // before any yes
    expect(await run("telemetry", "send")).toContain("nothing was sent");
    expect(got).toHaveLength(0);
    expect(await run("telemetry", "on")).toContain('"telemetry": "on"');
    await new Promise((r) => setTimeout(r, 20));
    await record();                                                              // after the yes
    expect(await run("share")).toContain("1 of these is waiting to be sent");
    const sent = JSON.parse(await run("telemetry", "send"));
    expect(sent).toMatchObject({ ok: true, sent: 1 });
    expect(got).toHaveLength(1);
    expect(got[0].rows).toHaveLength(1);
    const [r] = got[0].rows;
    expect(r).toMatchObject({ chose: { subscription: "codex", model: "gpt-5.6-terra", effort: "default" }, outcome: { verdict: "other", check: "pass" }, advised: { facts: { approach_open: 0.9, cause_unknown: 0.95 } } });
    expect(JSON.stringify(got)).not.toMatch(/acme|private|deadbeef|a1b2c3d4/);
    expect(JSON.parse(await run("telemetry", "send")).sent).toBe(0);                // never twice
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
