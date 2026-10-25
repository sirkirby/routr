// Only this boundary builds shipped spans. Raw command output never enters an OTLP encoder.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { encodeTraces, otelSession } from "./otel.mjs";
import { carriersFrom, carrierWithheld } from "./runtime.mjs";
import { parseTraceparent, leadSession, sessionId } from "./trace-context.mjs";
import { pick, modelName, EFFORTS, questionSet, VERDICTS, CHECK_RESULTS } from "./shaped.mjs";
import { HARNESSES, SOURCES } from "./harnesses.mjs";
import { CHECKS, FACTS, LEVELS, questions } from "./questions.mjs";
import { DECISION_CODES, decisionTarget, PROVIDER_NAMES, KNOWN_MODELS } from "./providers.mjs";
import { OUTCOME_CAUSES } from "./ledger.mjs";
import { USAGE_FAILURES } from "./usage-failure.mjs";
import { traceIdentity, pathHash } from "./trace-identity.mjs";
import { LaunchIndex, launchContext } from "./launch-index.mjs";
import { callHerdr, herdrId } from "./process-boundary.mjs";

const context = new AsyncLocalStorage(), nanos = () => BigInt(Date.now()) * 1000000n;
export function traceOutput(result) { const c = context.getStore(); if (c) c.output = result; }
const subscriptions = Object.keys(HARNESSES);
export const ERROR_CODES = [...new Set([...DECISION_CODES, ...Object.keys(USAGE_FAILURES), "unreadable", "refused", "failed", "_OTHER"])];
export const TRACE_ATTRIBUTES = Object.freeze({ "routr.lead.session_id": "string", "routr.question_set.version": "string", "routr.candidates": "string[]", "routr.unavailable": "string[]",
  "vcs.repository.url.full": "string", "vcs.ref.head.name": "string", "routr.cwd": "string", "routr.worktree": "string",
  "routr.kind": "string", "routr.backend": "string", "routr.launch.id": "string", "gen_ai.agent.name": "string", "gen_ai.conversation.id": "string", "routr.model": "string", "routr.advice.matched": "boolean", "routr.carriers.forwarded": "string[]",
  ...Object.fromEntries([...Object.keys(FACTS), "level", "high_blast_radius"].map((k) => [`routr.assessment.${k}`, "double"])), "routr.assessment.work_type": "string",
  ...Object.fromEntries(Object.keys(CHECKS).map((k) => [`routr.check.${k}`, "double"])), "routr.check.flags": "string[]",
  "gen_ai.operation.name": "string", "gen_ai.provider.name": "string", "gen_ai.request.model": "string", "gen_ai.response.model": "string",
  ...Object.fromEntries(["input_tokens", "output_tokens", "cache_read.input_tokens", "cache_write.input_tokens", "reasoning.output_tokens"].map((k) => [`gen_ai.usage.${k}`, "int"])),
  "routr.usage.state": "string", "routr.usage.source": "string",
  ...Object.fromEntries(["launch", "send", "wait", "workers", "stop", "cleanup", "record"].map((k) => [`routr.${k}.state`, "string"])),
  "routr.verdict": "string", "routr.check": "string", "routr.level": "string", "routr.attempts": "int", "routr.seconds": "double", "routr.causes": "string[]", "routr.subscription": "string", "routr.effort": "string", "routr.effort_from": "string", "routr.advice.id": "string", "error.type": "string" });
const typed = (value, type) => type === "string" ? typeof value === "string" : type === "boolean" ? typeof value === "boolean" : type === "string[]" ? Array.isArray(value) && value.every((v) => typeof v === "string") : type === "int" ? Number.isSafeInteger(value) && value >= 0 : typeof value === "number" && Number.isFinite(value);
const put = (span, values) => { for (const [key, value] of Object.entries(values)) if (TRACE_ATTRIBUTES[key] && value != null && typed(value, TRACE_ATTRIBUTES[key])) span.attributes[key] = value; };
const decisionName = (v) => KNOWN_MODELS.includes(v) ? v : modelName(v);
const probability = (v) => typeof v === "number" && v >= 0 && v <= 1 ? v : null;
const error = (span, code) => { put(span, { "error.type": pick(code, ERROR_CODES) === "other" ? "_OTHER" : code ?? "_OTHER" }); span.status = { code: 2 }; };
export function recordSpan(entry) {
  try {
    const c = context.getStore(); if (!c) return;
    const { outcome: o, chose: choice } = entry;
    put(c.span, { "routr.verdict": pick(o.verdict, VERDICTS), "routr.check": pick(o.check, CHECK_RESULTS), "routr.level": pick(choice.level, LEVELS),
      "routr.attempts": o.attempts, "routr.seconds": o.seconds, "routr.causes": o.causes?.map((v) => pick(v, OUTCOME_CAUSES)), "routr.subscription": pick(choice.subscription, subscriptions),
      "routr.effort": pick(choice.effort, EFFORTS), "routr.effort_from": pick(choice.effort_from, ["given", "model id", "config default"]), "routr.advice.id": /^[a-f0-9]{8}$/.test(entry.id) ? entry.id : null });
    if (/^[a-f0-9]{8}$/.test(entry.id)) link(c.index.match({ advice_id: entry.id }));
  } catch {} // A trace projection cannot undo a written ledger row.
}
function link(entry) {
  const c = context.getStore(), v = launchContext(entry); if (!c || !v) return;
  c.span.links ??= [];
  if (!c.span.links.some((l) => l.traceId === v.traceId && l.spanId === v.spanId)) c.span.links.push({ traceId: v.traceId, spanId: v.spanId });
  c.matched.add(v.launch_id);
}
export const currentLaunch = () => { const c = context.getStore(); return c?.command === "launch" ? { launch_id: c.launchId, traceId: c.span.traceId, spanId: c.span.spanId } : null; };
export function linkWorker(worker) { try { const c = context.getStore(); if (c && ["send", "wait", "workers", "stop", "cleanup"].includes(c.command)) link(worker.launch); } catch {} }
export function adviceForLaunch(id) { const c = context.getStore(); if (c?.command === "launch" && /^[a-f0-9]{8}$/.test(id)) c.adviceId = id; }
async function paneFacts(pane, run) {
  try { const r = await callHerdr(run, ["pane", "get", pane], 1000); return r.ok ? r.data?.result?.pane : null; } catch { return null; }
}
function conversation(facts) {
  const id = facts?.agent_session?.kind === "id" ? sessionId(facts.agent_session.value) : null;
  const c = context.getStore(); if (c && id) put(c.span, { "gen_ai.conversation.id": id });
}
export async function cleanupLink(o, run) {
  try {
    const c = context.getStore(); if (!c || c.command !== "cleanup") return;
    if (o.pane && c.env.HERDR_ENV === "1") {
      const facts = await paneFacts(o.pane, run); conversation(facts);
      if (typeof facts?.terminal_id === "string") link(c.index.match({ pane_id: o.pane, terminal_id: facts.terminal_id }, { activeOnly: true }));
    } else if (o.path) { const path_hash = pathHash(o.path); if (path_hash) link(c.index.match({ path_hash }, { activeOnly: true })); }
    else if (o.worktree) {
      const identity = traceIdentity(o.cwd);
      if (identity.project_hash) link(c.index.match({ project_hash: identity.project_hash, repository: identity.attributes["vcs.repository.url.full"] ?? null, branch: o.worktree }, { activeOnly: true }));
    }
  } catch {} // Index or pane observation failure never changes cleanup.
}
export async function completeLaunch(r, run, { rerun = false } = {}) {
  const c = context.getStore(); if (!c || c.command !== "launch") return;
  const identity = traceIdentity(r.cwd), facts = r.pane && r.state !== "planned" ? await paneFacts(r.pane, run) : null;
  put(c.span, identity.attributes); conversation(facts);
  const reused = rerun && c.adviceId && facts?.terminal_id ? c.index.recovery({ advice_id: c.adviceId, pane_id: r.pane, terminal_id: facts.terminal_id }) : null;
  if (reused) { c.launchId = reused.launch_id; link(reused); }
  put(c.span, { "routr.kind": pick(r.kind, subscriptions), "routr.backend": c.env.HERDR_ENV === "1" ? "pane" : "headless", "routr.launch.id": c.launchId,
    "gen_ai.agent.name": /^[a-z][a-z0-9_-]{0,31}$/.test(r.name) ? r.name : null, "routr.model": modelName(r.model), "routr.effort": pick(r.effort, EFFORTS),
    "routr.advice.matched": typeof r.advice?.matches === "boolean" ? r.advice.matches : null, "routr.carriers.forwarded": ["TRACEPARENT", "TRACESTATE", "BAGGAGE"].filter((n) => r.start?.env?.[n] === "<forwarded>") });
  if (!reused && (herdrId(r.pane) || r.worker) && ["ready", "prompted", "needs_input"].includes(r.state)) c.entry = { launch_id: c.launchId, advice_id: c.adviceId ?? null, backend: c.env.HERDR_ENV === "1" ? "pane" : "headless", repository: identity.attributes["vcs.repository.url.full"] ?? null,
    project_hash: identity.project_hash ?? null, path_hash: identity.path_hash ?? null, branch: identity.attributes["vcs.ref.head.name"] ?? null,
    pane_id: herdrId(r.pane) ? r.pane : null, terminal_id: typeof facts?.terminal_id === "string" ? facts.terminal_id : null,
    traceId: c.span.traceId, spanId: c.span.spanId, created_at: new Date().toISOString() };
}
export async function decisionSpan(config, run) {
  let c, t, span;
  const identity = (provider, model) => {
    const name = decisionName(model) ?? "other";
    span.name = `classify ${name}`;
    put(span, { "gen_ai.operation.name": "classify", "gen_ai.provider.name": pick(provider, PROVIDER_NAMES), "gen_ai.request.model": name });
  };
  try {
    c = context.getStore();
    if (c) {
      t = decisionTarget(config);
      span = { name: "classify", kind: 3, traceId: c.span.traceId, spanId: randomBytes(8).toString("hex"), parentSpanId: c.span.spanId, flags: 1, startTimeUnixNano: nanos(), attributes: { ...c.identity.attributes } };
      identity(t.provider, t.model);
    }
  } catch { span = null; } // Optional setup cannot skip or repeat the provider call.
  if (!span) return run();
  try {
    const r = await run();
    try {
      identity(r.provider, r.request_model ?? t.model);
      put(span, { "gen_ai.response.model": r.response_model == null ? null : decisionName(r.response_model) });
      for (const key of ["input_tokens", "output_tokens", "cache_read.input_tokens", "cache_write.input_tokens", "reasoning.output_tokens"]) {
        const v = r.usage?.[key]; if (Number.isSafeInteger(v) && v >= 0 && (!key.includes(".") || v > 0)) put(span, { [`gen_ai.usage.${key}`]: v });
      }
    } catch {} // Observation cannot replace the provider's reply or its original failure.
    return r;
  } catch (e) { try { identity(e.provider ?? t.provider, e.model ?? t.model); error(span, e.code); } catch {} throw e; }
  finally { try { span.endTimeUnixNano = nanos(); c.spans.push(span); } catch {} }
}
function usageRow(row, startTimeUnixNano, endTimeUnixNano) {
  try {
    const c = context.getStore(); if (!c || !subscriptions.includes(row?.pool)) return;
    const span = { name: `routr usage ${row.pool}`, kind: 1, traceId: c.span.traceId, spanId: randomBytes(8).toString("hex"), parentSpanId: c.span.spanId, flags: 1, startTimeUnixNano, endTimeUnixNano, attributes: { ...c.identity.attributes } };
    put(span, { "routr.subscription": row.pool, "routr.usage.state": row.signedIn === false ? "excluded" : row.kept ? "kept" : row.given ? "given" : row.ageSec != null ? "live" : "assumed",
      "routr.usage.source": pick(row.source, [...Object.values(SOURCES).map((s) => s.source), "sign-in check", "given by caller", "none", "statusline", "session log"]) });
    // A kept reading recovers a failed refresh; the read operation still produced usable data.
    if (row.failure && row.headroom == null) error(span, row.failure.code);
    c.spans.push(span); c.observed.add(row);
  } catch {} // A failed observation must leave its usage reading usable.
}
export async function usageSpans(run, { startedAt } = {}) {
  const c = context.getStore();
  if (!c) return run((read) => read());
  const start = startedAt == null ? nanos() : BigInt(startedAt) * 1000000n;
  const observe = startedAt == null ? async (read) => { const at = nanos(), row = await read(); usageRow(row, at, nanos()); return row; } : (read) => read();
  const rows = await run(observe), end = nanos();
  // Injected bulk readers still cross the projection, while the real reader measures each parallel source itself.
  for (const row of rows) if (!c.observed.has(row)) usageRow(row, start, end);
  return rows;
}
function resultAttributes(command, span, r) {
  if (!r) return;
  if (["dispatch", "subagent", "check"].includes(command)) {
    put(span, { "routr.question_set.version": questionSet(r.question_set), "routr.unavailable": r.unavailable?.map((u) => pick(u.code, ERROR_CODES)) });
    if (command === "check") {
      for (const key of Object.keys(CHECKS)) put(span, { [`routr.check.${key}`]: probability(r.checks?.[key]?.p) });
      put(span, { "routr.check.flags": [...Object.entries(CHECKS).filter(([k, v]) => r.checks?.[k]?.reading === v.flag).map(([k]) => k), ...(["partial", "blocked", "unstated"].includes(r.claimed) ? [`verdict_${r.claimed}`] : [])] });
    } else {
      for (const key of Object.keys(FACTS)) put(span, { [`routr.assessment.${key}`]: probability(r.facts?.[key]?.p) });
      put(span, { "routr.assessment.level": r.answers?.level?.score, "routr.assessment.high_blast_radius": probability(r.answers?.high_blast_radius),
        "routr.assessment.work_type": pick(r.answers?.work_type?.choice, Object.keys(questions.work_type.criteria)), "routr.candidates": [...(r.subscriptions?.candidates?.normal ?? []), ...(r.subscriptions?.candidates?.fallback ?? [])].map((v) => pick(v, subscriptions)) });
    }
  }
  if (command === "usage" && context.getStore()?.explicitLevel) put(span, { "routr.level": pick(r.level, LEVELS) });
  if (["launch", "send", "wait", "workers", "stop", "cleanup", "record"].includes(command)) put(span, { [`routr.${command}.state`]: pick(r.state ?? (r.ok ? "done" : "failed"), ["planned", "ready", "prompted", "needs_input", "failed", "refused", "none", "finished", "running", "idle", "resumed", "queued", "delivered", "unknown", "stopped", "absent", "listed", "closed", "removed", "done"]) });
  if (r.ok === false) error(span, ["refused", "failed"].includes(r.state) ? r.state : r.unavailable?.at(-1)?.code);
}
export function launchCarriers(env) {
  const found = carriersFrom(env), c = context.getStore();
  if (!c || c.span.name !== "routr launch") return found;
  const carriers = { ...found.carriers, TRACEPARENT: `00-${c.span.traceId}-${c.span.spanId}-01` };
  if (!c.inherited) delete carriers.TRACESTATE;
  return { carriers, withheld: found.withheld, launchSpan: true };
}
export const launchCarrierWarnings = (found) => found.withheld.map((n) => found.launchSpan && n === "TRACEPARENT"
  ? "The inherited TRACEPARENT exceeded routr's forwarding limits; the worker gets this routr launch span instead"
  : carrierWithheld(n));
export function commandTrace(command, setup = {}, run) {
  if (context.getStore()) return run(); // Internal cleanup of an unstarted launch belongs to that launch.
  let session, span, batch;
  try {
    const { config, env = process.env, otel = {}, lead, explicitLevel, cwd } = typeof setup === "function" ? setup() : setup;
    session = otelSession(config, env, otel);
    const inherited = parseTraceparent(carriersFrom(env).carriers.TRACEPARENT);
    if (session.on && inherited?.sampled !== false) {
      span = { name: `routr ${command}`, kind: 1, traceId: inherited?.traceId ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"),
        ...(inherited ? { parentSpanId: inherited.spanId } : {}), flags: 1, startTimeUnixNano: nanos(), attributes: {} };
      const id = leadSession(env, lead); if (id && ["dispatch", "subagent", "launch"].includes(command)) put(span, { "routr.lead.session_id": id });
      const identity = traceIdentity(cwd); put(span, identity.attributes);
      batch = { span, spans: [span], inherited, env, explicitLevel, identity, command, index: new LaunchIndex({ home: otel.home }), launchId: randomUUID(), matched: new Set(), observed: new Set() };
    }
  } catch {} // Setup is optional too: a bad config or identity lookup cannot refuse a command.
  if (!batch) return run();
  const finish = (result) => {
    try {
      resultAttributes(command, span, batch.output ?? result); span.endTimeUnixNano = nanos();
      const queued = session.queue("traces", encodeTraces(batch.spans, { schemaUrl: "https://opentelemetry.io/schemas/1.44.0", attributeTypes: TRACE_ATTRIBUTES }));
      if (queued && batch.entry) { batch.index.sweep(); batch.index.add(batch.entry); }
      if (queued && command === "cleanup" && ["removed", "closed", "absent"].includes((batch.output ?? result)?.state)) for (const id of batch.matched) batch.index.finish(id);
    } catch {} // A malformed record, full disk or revoked consent never changes a command result.
    return result;
  };
  return context.run(batch, () => {
    try {
      const result = run();
      return result && typeof result.then === "function" ? result.then(finish, (e) => { finish(); throw e; }) : finish(result);
    } catch (e) { finish(); throw e; }
  });
}
