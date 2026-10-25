// Only this boundary builds shipped spans, events and usage observations. Raw output never enters an OTLP encoder.
import { IDENTITY_ATTRIBUTES, LOG_EVENTS, NEEDS_INPUT_CODES, OTEL_ATTRIBUTES, TRACE_ATTRIBUTES, signalAttributes, typed } from "./otel-schema.mjs";
export { LOG_EVENTS, NEEDS_INPUT_CODES, OTEL_ATTRIBUTES, TRACE_ATTRIBUTES } from "./otel-schema.mjs";
import { warning, warningCode, carrierWithheld } from "./warnings.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { encodeTraces, encodeLogs, headroomObservation, otelSession, otelSwitch } from "./otel.mjs";
import { loadConfig } from "./config.mjs";
import { carriersFrom, savedCarriers } from "./runtime.mjs";
import { parseTraceparent, leadSession, sessionId } from "./trace-context.mjs";
import { pick, modelName, EFFORTS, questionSet, VERDICTS, CHECK_RESULTS } from "./shaped.mjs";
import { HARNESSES, SOURCES } from "./harnesses.mjs";
import { CHECKS, FACTS, LEVELS, questions } from "./questions.mjs";
import { DECISION_CODES, decisionTarget, PROVIDER_NAMES, KNOWN_MODELS } from "./providers.mjs";
import { OUTCOME_CAUSES } from "./ledger.mjs";
import { usageReadingTime } from "./usage.mjs";
import { usageFailure, USAGE_FAILURES } from "./usage-failure.mjs";
import { traceIdentity, pathHash } from "./trace-identity.mjs";
import { LaunchIndex, launchContext } from "./launch-index.mjs";
import { callHerdr, herdrId } from "./process-boundary.mjs";

const context = new AsyncLocalStorage(), nanos = () => BigInt(Date.now()) * 1000000n;
// A span's times: its start read from the wall clock once, every later time (its end, the logs taken from it) as that
// start plus monotonic time since, so a clock change during a command or a long turn cannot make a duration negative
// or inflate it (the plan's clock rule; from the review of 14a45ca).
export const spanClock = () => { const start = nanos(), mono = process.hrtime.bigint(); return { start, now: () => start + (process.hrtime.bigint() - mono) }; };
const clocks = new WeakMap();
const started = (span, clock = spanClock()) => { span.startTimeUnixNano = clock.start; clocks.set(span, clock); return span; };
const spanNow = (span) => clocks.get(span)?.now() ?? nanos();
export function traceOutput(result) { const c = context.getStore(); if (c) c.output = result; }
const subscriptions = Object.keys(HARNESSES);
export const ERROR_CODES = [...new Set([...DECISION_CODES, ...Object.keys(USAGE_FAILURES), "unreadable", "refused", "failed", "not_started", "no_finish", "stopped", "_OTHER"])];
const put = (span, values) => Object.assign(span.attributes, signalAttributes(values, Object.keys(TRACE_ATTRIBUTES)));
export function inputNeeded(code) {
  const c = context.getStore(); if (c?.span && NEEDS_INPUT_CODES.includes(code)) c.inputCode = code;
}
const logRecord = (span, eventName, values, timeUnixNano = spanNow(span)) => {
  const spec = LOG_EVENTS[eventName], attributes = {};
  for (const key of IDENTITY_ATTRIBUTES) {
    if (span.attributes[key] != null) attributes[key] = span.attributes[key];
  }
  for (const [key, value] of Object.entries(values)) if (spec.attributes[key] && typed(value, spec.attributes[key])) attributes[key] = value;
  return { eventName, timeUnixNano, observedTimeUnixNano: timeUnixNano, flags: span.flags, severityNumber: spec.severityNumber, severityText: spec.severityText, traceId: span.traceId, spanId: span.spanId, attributes: signalAttributes(attributes, [...IDENTITY_ATTRIBUTES, ...Object.keys(spec.attributes)]) };
};
const decisionName = (v) => KNOWN_MODELS.includes(v) ? v : modelName(v);
const probability = (v) => typeof v === "number" && v >= 0 && v <= 1 ? v : null;
const error = (span, code) => { put(span, { "error.type": pick(code, ERROR_CODES) === "other" ? "_OTHER" : code ?? "_OTHER" }); span.status = { code: 2 }; };
export function recordSpan(entry) {
  try {
    const c = context.getStore(); if (!c?.span) return;
    const { outcome: o, chose: choice } = entry;
    put(c.span, { "routr.verdict": pick(o.verdict, VERDICTS), "routr.check": pick(o.check, CHECK_RESULTS), "routr.level": pick(choice.level, LEVELS),
      "routr.attempts": o.attempts, "routr.seconds": o.seconds, "routr.causes": o.causes?.map((v) => pick(v, OUTCOME_CAUSES)), "routr.subscription": pick(choice.subscription, subscriptions),
      "routr.effort": pick(choice.effort, EFFORTS), "routr.effort_from": pick(choice.effort_from, ["given", "model id", "config default"]), "routr.advice.id": /^[a-f0-9]{8}$/.test(entry.id) ? entry.id : null });
    if (/^[a-f0-9]{8}$/.test(entry.id)) link(c.index.match({ advice_id: entry.id }));
  } catch {} // A trace projection cannot undo a written ledger row.
}
function link(entry) {
  const c = context.getStore(), v = launchContext(entry); if (!c?.span || !v) return;
  c.span.links ??= [];
  if (!c.span.links.some((l) => l.traceId === v.traceId && l.spanId === v.spanId)) c.span.links.push({ traceId: v.traceId, spanId: v.spanId });
  c.matched.add(v.launch_id);
}
export function currentLaunch(config, env = process.env) {
  const c = context.getStore();
  if (c?.span && c.command === "launch") return { launch_id: c.launchId, traceId: c.span.traceId, spanId: c.span.spanId };
  // Off is no sampling decision. Retain an enabled launch's unsampled parent even when a later holder opts in.
  return otelSwitch(config, env).on && parseTraceparent(carriersFrom(env).carriers.TRACEPARENT)?.sampled === false ? { sampled: false } : null;
}
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
    const c = context.getStore(); if (!c?.span || c.command !== "cleanup") return;
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
  const c = context.getStore(); if (!c?.span || c.command !== "launch") return;
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
    if (c?.span) {
      t = decisionTarget(config);
      span = started({ name: "classify", kind: 3, traceId: c.span.traceId, spanId: randomBytes(8).toString("hex"), parentSpanId: c.span.spanId, flags: 1, attributes: { ...c.identity.attributes } });
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
  finally { try { span.endTimeUnixNano = spanNow(span); c.spans.push(span); } catch {} }
}
const usageState = (row) => row.signedIn === false ? "excluded" : row.kept ? "kept" : row.given ? "given" : row.ageSec != null ? "live" : "assumed";
function usageObservations(row, observations) {
  if (!subscriptions.includes(row?.pool) || usageState(row) !== "live" || !Number.isFinite(row.headroom)) return;
  // Metrics have their own consent, independent of trace sampling.
  for (const w of row.windows ?? []) {
    if (!Number.isFinite(w.usedPct)) continue;
    const observation = headroomObservation({ subscription: row.pool, window: w.name, value: Math.min(1, Math.max(0, 1 - w.usedPct / 100)), time: usageReadingTime(row, w) });
    if (observation) observations.push(observation);
  }
}
function usageRow(row, startTimeUnixNano, endTimeUnixNano) {
  try {
    const c = context.getStore(); if (!c || !subscriptions.includes(row?.pool)) return;
    c.observed.add(row);
    const state = usageState(row);
    usageObservations(row, c.observations);
    if (!c.span) return;
    const span = { name: `routr usage ${row.pool}`, kind: 1, traceId: c.span.traceId, spanId: randomBytes(8).toString("hex"), parentSpanId: c.span.spanId, flags: 1, startTimeUnixNano, endTimeUnixNano, attributes: { ...c.identity.attributes } };
    put(span, { "routr.subscription": row.pool, "routr.usage.state": state,
      "routr.usage.source": pick(row.source, [...Object.values(SOURCES).map((s) => s.source), "sign-in check", "given by caller", "none", "statusline", "session log"]) });
    // A kept reading recovers a failed refresh; the read operation still produced usable data.
    if (row.failure && row.headroom == null) error(span, row.failure.code);
    if (row.failure) c.logs.push(logRecord(span, "routr.usage.failed", { "error.type": usageFailure(row.failure.code).code, "routr.subscription": row.pool }, endTimeUnixNano));
    c.spans.push(span);
  } catch {} // A failed observation must leave its usage reading usable.
}
// `since`: a spanClock the caller started before a reading of its own (a named fresh read), which then times them all.
export async function usageSpans(run, { since } = {}) {
  const c = context.getStore();
  if (!c) return run((read) => read());
  const clock = since ?? spanClock();
  const observe = since == null ? async (read) => { const at = spanClock(), row = await read(); usageRow(row, at.start, at.now()); return row; } : (read) => read();
  const rows = await run(observe), end = clock.now();
  // Injected bulk readers still cross the projection, while the real reader measures each parallel source itself.
  for (const row of rows) if (!c.observed.has(row)) usageRow(row, clock.start, end);
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
const spanCarriers = (saved, span, inherited) => {
  const carriers = { ...saved, TRACEPARENT: `00-${span.traceId}-${span.spanId}-01` };
  if (!inherited || inherited.traceId !== span.traceId) delete carriers.TRACESTATE;
  return carriers;
};
export function launchCarriers(env) {
  const found = carriersFrom(env), c = context.getStore();
  if (!c?.span || c.span.name !== "routr launch") return found;
  const carriers = spanCarriers(found.carriers, c.span, c.inherited);
  return { carriers, withheld: found.withheld, launchSpan: true };
}
export const launchCarrierWarnings = (found) => found.withheld.map((n) => found.launchSpan && n === "TRACEPARENT"
  ? warning("launch_parent_replaced", "The inherited TRACEPARENT exceeded routr's forwarding limits; the worker gets this routr launch span instead")
  : carrierWithheld(n));
// Headless turn consent: fresh consent per turn; missing launch uses saved-parent sampling, or a root
// without one.
export const WORKER_STATES = Object.freeze(["starting", "working", "waiting", "idle", "failed", "stopped", "no_task"]);
const WORKER_PROVIDERS = { claude: "anthropic", codex: "openai", cursor: "cursor", agy: "gcp.gen_ai", kiro: "kiro" };
// Read identity only for a generated turn, once per holder: export-off startup performs no git reads.
export function workerTracing(worker, options = {}) {
  let identity;
  const getIdentity = () => (identity ??= traceIdentity(worker.cwd).attributes);
  return (number) => workerTurn(worker, number, { ...options, identity: getIdentity });
}
export function workerTurn(worker, number, { env = process.env, otel = {}, identity } = {}) {
  const saved = savedCarriers(worker.carriers).carriers;
  let span, session, inherited;
  try {
    const launch = launchContext(worker.launch); inherited = parseTraceparent(saved.TRACEPARENT);
    session = otelSession(loadConfig(otel.configPath).config, env, otel);
    if (session.on && (launch || !Object.hasOwn(worker, "launch")) && inherited?.sampled !== false && Object.hasOwn(WORKER_PROVIDERS, worker.kind) && /^[a-z][a-z0-9_-]{0,31}$/.test(worker.name)) {
      const parent = launch ?? inherited;
      span = started({ name: `invoke_agent ${worker.name}`, kind: 3, traceId: parent?.traceId ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), ...(parent ? { parentSpanId: parent.spanId } : {}),
        flags: 1, attributes: {} });
      put(span, identity ? identity() : traceIdentity(worker.cwd).attributes);
      put(span, { "gen_ai.operation.name": "invoke_agent", "gen_ai.provider.name": WORKER_PROVIDERS[worker.kind], "gen_ai.agent.name": worker.name,
        "routr.kind": pick(worker.kind, subscriptions), "routr.backend": "headless", "routr.launch.id": launch?.launch_id, "routr.model": modelName(worker.model), "routr.effort": pick(worker.effort, EFFORTS), "routr.turn": number });
    }
  } catch {} // Missing context, malformed state or optional observation cannot change a turn.
  let ended = false;
  const transitions = [], queueLogs = (events) => { if (events.length) session.queue("logs", encodeLogs(events.map(([from, to, timeUnixNano]) => logRecord(span, "routr.worker.state", {
    "routr.worker.state.from": from, "routr.worker.state.to": to }, timeUnixNano)), { schemaUrl: "https://opentelemetry.io/schemas/1.44.0", attributeTypes: OTEL_ATTRIBUTES })); };
  return {
    generated: Boolean(span),
    carriers: span ? spanCarriers(saved, span, inherited) : saved,
    state(from, to) {
      try {
        if (!span || from === to || !WORKER_STATES.includes(from) || !WORKER_STATES.includes(to)) return;
        const event = [from, to, spanNow(span)];
        if (ended) queueLogs([event]); else transitions.push(event);
      } catch {} // A lifecycle observation cannot interrupt the holder's state write.
    },
    end(outcome, messages, conversation, usage) {
      if (ended) return; ended = true;
      try {
        if (!span) return;
        put(span, { "routr.turn.outcome": pick(outcome, ["finished", "failed", "not_started", "no_finish", "stopped"]), "routr.turn.messages": messages,
          "gen_ai.conversation.id": typeof conversation === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(conversation) ? conversation : null });
        for (const key of ["input_tokens", "output_tokens", "cache_read.input_tokens", "cache_write.input_tokens", "reasoning.output_tokens"]) {
          const v = usage?.[key]; if (Number.isSafeInteger(v) && v >= 0 && (!key.includes(".") || v > 0)) put(span, { [`gen_ai.usage.${key}`]: v });
        }
        if (outcome !== "finished") error(span, outcome);
        span.endTimeUnixNano = spanNow(span);
        session.queue("traces", encodeTraces([span], { schemaUrl: "https://opentelemetry.io/schemas/1.44.0", attributeTypes: TRACE_ATTRIBUTES }));
        queueLogs(transitions);
      } catch {} // Disk, consent or encoder failure never fails, delays or retries a worker turn.
    },
  };
}
export function commandTrace(command, setup = {}, run) {
  if (context.getStore()) return run(); // Internal cleanup of an unstarted launch belongs to that launch.
  let session, span, batch;
  try {
    const { config, env = process.env, otel = {}, lead, explicitLevel, cwd } = typeof setup === "function" ? setup() : setup;
    session = otelSession(config, env, otel);
    const inherited = parseTraceparent(carriersFrom(env).carriers.TRACEPARENT);
    if (session.on) batch = { observations: [], observed: new Set(), env, command };
    if (session.on && inherited?.sampled !== false) {
      span = started({ name: `routr ${command}`, kind: 1, traceId: inherited?.traceId ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"),
        ...(inherited ? { parentSpanId: inherited.spanId } : {}), flags: 1, attributes: {} });
      const id = leadSession(env, lead); if (id && ["dispatch", "subagent", "launch"].includes(command)) put(span, { "routr.lead.session_id": id });
      const identity = traceIdentity(cwd); put(span, identity.attributes);
      batch = { ...batch, span, spans: [span], logs: [], inherited, env, explicitLevel, identity, command, index: new LaunchIndex({ home: otel.home }), launchId: randomUUID(), matched: new Set(), observed: new Set() };
    }
  } catch {} // Setup is optional too: a bad config or identity lookup cannot refuse a command.
  if (!batch) return run();
  const finish = (result) => {
    try {
      const output = batch.output ?? result;
      if (span) {
        resultAttributes(command, span, output); span.endTimeUnixNano = spanNow(span);
        if (batch.inputCode) batch.logs.push(logRecord(span, "routr.needs_input", { "routr.needs_input.why": batch.inputCode }));
        for (const text of output?.warnings ?? []) {
          const code = warningCode(text); if (code) batch.logs.push(logRecord(span, "routr.warning", { "routr.warning.code": code }));
        }
        const queued = session.queue("traces", encodeTraces(batch.spans, { schemaUrl: "https://opentelemetry.io/schemas/1.44.0", attributeTypes: TRACE_ATTRIBUTES }));
        if (batch.logs.length) session.queue("logs", encodeLogs(batch.logs, { schemaUrl: "https://opentelemetry.io/schemas/1.44.0", attributeTypes: OTEL_ATTRIBUTES }));
        if (queued && batch.entry) { batch.index.sweep(); batch.index.add(batch.entry); }
        if (queued && command === "cleanup" && ["removed", "closed", "absent"].includes((batch.output ?? result)?.state)) for (const id of batch.matched) batch.index.finish(id);
      }
    } catch {} // A malformed record, full disk or revoked consent never changes a command result.
    for (const observation of batch.observations) session.queue("metrics", observation);
    return result;
  };
  return context.run(batch, () => {
    try {
      const result = run();
      return result && typeof result.then === "function" ? result.then(finish, (e) => { finish(); throw e; }) : finish(result);
    } catch (e) { finish(); throw e; }
  });
}
