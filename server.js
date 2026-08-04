// server.js
// llm-gateway — drop-in LLM gateway with self-auditor.
// intentionally-sync: reports-dir creation is a one-time startup concern.
// OpenAI-compatible at the edge so any SDK works by changing baseURL.
//
// Routes:
//   GET  /healthz
//   GET  /                       gateway info + audit summary
//   POST /v1/chat/completions    OpenAI-compatible chat
//   POST /v1/images/generations  OpenAI-compatible image gen
//   POST /v1/images/edits        OpenAI-compatible image edit
//   POST /v1/videos              OpenAI-compatible video create
//   POST /v1/messages            Anthropic passthrough
//   GET  /audit                  last audit report
//   POST /audit/run              run a fresh audit (async)
//   GET  /audit/quick            quick health + drift check
//   GET  /calls/recent           recent call log
//   GET  /stats                  aggregated call stats

import express from 'express';
import { randomUUID } from 'node:crypto';
import { Store, defaultStorePath } from './lib/store.js';
import {
  Router, CircuitBreaker,
  OpenAIProvider, A2EProvider, AnthropicProvider, EchoProvider,
} from './lib/router.js';
import { Auditor } from './lib/auditor.js';
import { Brain } from './lib/brain.js';
import { AION_CONTINUITY_PACK, MissionContext, buildSystemPrompt, resolveDecision, DecisionState } from './lib/aion_kernel.js';
import { AionChain } from './lib/aion_chain.js';
import { aionSettings } from './lib/aion_settings.js';
import { mkdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = parseInt(process.env.PORT || '10000', 10);
const ROOT = process.cwd();
const REPORTS_DIR = process.env.LLM_GATEWAY_REPORTS_DIR || join(ROOT, 'reports');
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

const store = new Store(defaultStorePath());
const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 30_000 });

// Build the default provider chain from env. Order = primary -> fallback.
function buildDefaultChain() {
  const chain = [];
  if (process.env.OPENAI_API_KEY) chain.push(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }));
  if (process.env.A2E_API_KEY) chain.push(new A2EProvider({ apiKey: process.env.A2E_API_KEY }));
  // Always include anthropic if key set
  if (process.env.ANTHROPIC_API_KEY) chain.push(new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
  if (chain.length === 0) {
    // Dev fallback so the gateway still works for tests / demos
    chain.push(new EchoProvider({ name: 'echo', latencyMs: 5 }));
  }
  return chain;
}

let router = new Router({ providers: buildDefaultChain(), breaker, store });
const aionChain = AionChain.fromEnv({ breaker, store, appId: 'aion-brain' });

// Validate AION settings on boot (fail-closed in production)
try {
  aionSettings.validateStartup();
} catch (e) {
  console.error(JSON.stringify({
    t: new Date().toISOString(),
    msg: 'aion.startup.fatal',
    error: e.message
  }));
  process.exit(1);
}

// ---- AION auth (X-AION-Key / Authorization: Bearer) ----
function _aionAuthenticate(req) {
  const token = req.header('x-aion-key') || (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!aionSettings.authRequired()) {
    return { subject: 'development', is_admin: true };
  }
  if (!token) return null;
  if (aionSettings.isAdminKey(token)) return { subject: aionSettings.subjectFor(token), is_admin: true };
  if (aionSettings.isUserKey(token)) return { subject: aionSettings.subjectFor(token), is_admin: false };
  return null;
}
function aionRequire(req) {
  const p = _aionAuthenticate(req);
  if (!p) {
    const err = new Error('authentication_failed');
    err.statusCode = 401;
    err.public = { detail: 'invalid_credentials' };
    throw err;
  }
  return p;
}
function aionAdmin(req) {
  const p = aionRequire(req);
  if (!p.is_admin) {
    const err = new Error('admin_required');
    err.statusCode = 403;
    err.public = { detail: 'admin_required' };
    throw err;
  }
  return p;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Request ID + lightweight logger
app.use((req, res, next) => {
  req.id = req.header('x-request-id') || randomUUID();
  res.setHeader('x-request-id', req.id);
  const t = Date.now();
  res.on('finish', () => {
    // Log only errors and slow requests
    const dt = Date.now() - t;
    if (res.statusCode >= 400 || dt > 1000) {
      console.log(JSON.stringify({ t: new Date().toISOString(), req_id: req.id, m: req.method, p: req.path, s: res.statusCode, ms: dt }));
    }
  });
  next();
});

// CORS — explicit, no credentials
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-openai-key,x-anthropic-key,x-a2e-key,x-aion-key,x-app-id,x-request-id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Per-request credentials: prefer header, then env, then configured chain.
function resolveProviders(req) {
  const headerKey = req.header('x-openai-key') || req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const a2eKey = req.header('x-a2e-key');
  const anthKey = req.header('x-anthropic-key') || req.header('x-anthropic-key'.toLowerCase());
  if (headerKey || a2eKey || anthKey) {
    const chain = [];
    if (headerKey) chain.push(new OpenAIProvider({ apiKey: headerKey.replace(/^Bearer\s+/i, '') }));
    if (a2eKey) chain.push(new A2EProvider({ apiKey: a2eKey }));
    if (anthKey) chain.push(new AnthropicProvider({ apiKey: anthKey }));
    if (chain.length === 0) return router;
    return new Router({ providers: chain, breaker, store });
  }
  return router;
}

// ---- Health & info ----

app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: Date.now(), uptime_s: Math.round(process.uptime()), version: '0.1.8' });
});

app.get('/', (req, res) => {
  const last = store.lastAudit();
  res.json({
    name: 'llm-gateway',
    version: '0.1.8',
    description: 'Plug-and-play LLM gateway with self-auditor',
    providers: router.providers.map(p => p.name),
    audit: last ? { ts: last.ts, mode: last.mode, status: last.status, p0: last.p0_count, p1: last.p1_count } : null,
    endpoints: [
      'GET  /healthz',
      'POST /v1/chat/completions',
      'POST /v1/images/generations',
      'POST /v1/images/edits',
      'POST /v1/videos',
      'POST /v1/messages',
      'GET  /audit',
      'POST /audit/run',
      'GET  /audit/quick',
      'GET  /calls/recent',
      'GET  /stats',
    ],
  });
});

// ---- LLM routes ----

app.post('/v1/chat/completions', async (req, res) => {
  const r = resolveProviders(req);
  const result = await r.call({
    operation: 'chat',
    payload: req.body,
    appId: req.header('x-app-id'),
    requestId: req.id,
  });
  if (!result.ok) return res.status(502).json({ error: { code: 'all_providers_failed', errors: result.errors, request_id: req.id } });
  res.json({
    id: `chatcmpl-${req.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.content },
      finish_reason: result.finish_reason || 'stop',
    }],
    usage: result.usage || {},
    _meta: { provider: result.provider, latency_ms: result.latency_ms, request_id: req.id },
  });
});

app.post('/v1/images/generations', async (req, res) => {
  const r = resolveProviders(req);
  const result = await r.call({
    operation: 'image.generate',
    payload: req.body,
    appId: req.header('x-app-id'),
    requestId: req.id,
  });
  if (!result.ok) return res.status(502).json({ error: { code: 'all_providers_failed', errors: result.errors, request_id: req.id } });
  res.json({
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    data: (result.images || []).map(im => ({ url: im.url, b64_json: im.b64 })),
    _meta: { provider: result.provider, latency_ms: result.latency_ms, request_id: req.id },
  });
});

app.post('/v1/images/edits', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  // Accept multipart via fetch upstream; for simplicity, require JSON { image_b64, prompt, ... }
  // (Real multipart passthrough is provider-specific; clients can use the JSON variant.)
  let body = req.body;
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString('utf8')); } catch { body = {}; }
  }
  const r = resolveProviders(req);
  const result = await r.call({
    operation: 'image.edit',
    payload: body,
    appId: req.header('x-app-id'),
    requestId: req.id,
  });
  if (!result.ok) return res.status(502).json({ error: { code: 'all_providers_failed', errors: result.errors, request_id: req.id } });
  res.json({
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    data: (result.images || []).map(im => ({ url: im.url, b64_json: im.b64 })),
    _meta: { provider: result.provider, latency_ms: result.latency_ms, request_id: req.id },
  });
});

app.post('/v1/videos', async (req, res) => {
  const r = resolveProviders(req);
  const result = await r.call({
    operation: 'video.create',
    payload: req.body,
    appId: req.header('x-app-id'),
    requestId: req.id,
  });
  if (!result.ok) return res.status(502).json({ error: { code: 'all_providers_failed', errors: result.errors, request_id: req.id } });
  res.status(202).json({ id: result.id, status: result.status || 'queued', model: result.model, _meta: { provider: result.provider, request_id: req.id } });
});

app.post('/v1/messages', async (req, res) => {
  const r = resolveProviders(req);
  const result = await r.call({
    operation: 'chat',
    payload: { ...req.body, model: req.body?.model || 'claude-3-5-sonnet-latest' },
    appId: req.header('x-app-id'),
    requestId: req.id,
  });
  if (!result.ok) return res.status(502).json({ error: { code: 'all_providers_failed', errors: result.errors, request_id: req.id } });
  res.json({
    id: `msg-${req.id}`,
    type: 'message',
    role: 'assistant',
    model: result.model,
    content: [{ type: 'text', text: result.content || '' }],
    stop_reason: result.finish_reason || 'end_turn',
    usage: { input_tokens: result.usage?.input_tokens || 0, output_tokens: result.usage?.output_tokens || 0 },
    _meta: { provider: result.provider, latency_ms: result.latency_ms, request_id: req.id },
  });
});

// ---- AION API routes (v2 contract) ----
// Ported from AION v2 FastAPI app. Same request/response shapes, same SSE
// event names, same fail-closed auth, same 200+ok=false discipline.

app.get('/api/continuity-pack', (req, res) => {
  res.json(AION_CONTINUITY_PACK);
});

app.get('/api/models', (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  res.json({
    chain: aionSettings.fallbackModels[0] ? [aionSettings.primaryModel, ...aionSettings.fallbackModels] : [aionSettings.primaryModel],
    primary: aionSettings.primaryModel,
    providers: aionChain.providers.map(p => ({ name: p.name, base: p.baseUrl || null, configured: Boolean(p.apiKey || true) })),
  });
});

app.get('/api/audit/recent', (req, res) => {
  try { aionAdmin(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  const last = store.lastAudit();
  const events = last ? [last] : [];
  res.json({ events });
});

app.post('/api/decision', (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  const userInput = String(req.body?.user_input || '').trim();
  if (!userInput) return res.status(400).json({ detail: 'user_input_required' });
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(0, 100) : [];
  const ctx = new MissionContext({ userInput, history });
  const decision = resolveDecision(ctx);
  store.recordCall({ ts: Date.now(), app_id: ctx.fingerprint(), provider: 'kernel', model: '7-law', operation: 'aion.decision', status: 200, latency_ms: 0, request_id: ctx.requestId });
  res.json({ request_id: ctx.requestId, decision });
});

app.post('/api/chat', async (req, res) => {
  let principal;
  try { principal = aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (messages.length === 0) return res.status(400).json({ ok: false, error: 'messages_required', kind: 'invalid_request' });
  // Enforce client role restriction (no system role)
  for (const m of messages) {
    if (m && m.role && !['user', 'assistant'].includes(m.role)) {
      return res.status(422).json({ detail: `role '${m.role}' not allowed` });
    }
  }
  const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
  if (!lastUser) return res.status(400).json({ ok: false, error: 'user_message_required', kind: 'invalid_request' });
  const userText = typeof lastUser.content === 'string' ? lastUser.content
    : (Array.isArray(lastUser.content) ? lastUser.content.map(p => p.text || '').join('\n') : '');
  const temperature = Number.isFinite(req.body?.temperature) ? req.body.temperature : 0.7;
  const maxTokens = Number.isFinite(req.body?.max_tokens) ? req.body.max_tokens : 1024;
  if (maxTokens < aionSettings.minCompletionTokens || maxTokens > aionSettings.maxCompletionTokens) {
    return res.status(422).json({ detail: `max_tokens must be ${aionSettings.minCompletionTokens}..${aionSettings.maxCompletionTokens}` });
  }
  if (userText.length > aionSettings.maxMessageChars) {
    return res.status(400).json({ ok: false, error: 'message_text_too_large', kind: 'invalid_request' });
  }
  // Build AION decision
  const history = messages.slice(0, -1).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }));
  const ctx = new MissionContext({ userInput: userText, history });
  const decision = resolveDecision(ctx);
  // Build AION system prompt (placeholder; no tools yet)
  const systemPrompt = buildSystemPrompt(decision, { toolContext: '', notesContext: '' });
  const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-AION-Decision', decision.state);
  res.flushHeaders && res.flushHeaders();

  // 1) decision event
  res.write(`data: ${JSON.stringify({ type: 'decision', request_id: ctx.requestId, decision })}\n\n`);

  // 2) stream
  try {
    for await (const evt of aionChain.stream({ messages: fullMessages, temperature, maxTokens })) {
      res.write(evt);
    }
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', kind: 'stream_failed', message: e.message })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
  // record
  store.recordCall({
    ts: ctx.startedAt,
    app_id: principal.subject,
    provider: 'aion',
    model: aionSettings.primaryModel,
    operation: 'aion.chat',
    status: 200,
    latency_ms: Date.now() - ctx.startedAt,
    request_id: ctx.requestId,
  });
});

// ---- Audit routes ----

const auditor = new Auditor({ root: ROOT, mode: 'full' });

app.get('/audit', (req, res) => {
  const last = store.lastAudit();
  if (!last) return res.json({ status: 'NO_AUDIT_YET', message: 'POST /audit/run to run one' });
  res.json(last.report);
});

app.get('/audit/quick', async (req, res) => {
  const quickAuditor = new Auditor({ root: ROOT, mode: 'quick', selfFetch: () => `${req.protocol}://${req.get('host')}` });
  const report = await quickAuditor.run();
  res.json(report);
});

app.post('/audit/run', async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const fullAuditor = new Auditor({ root: ROOT, mode: 'full', selfFetch: () => baseUrl });
  const report = await fullAuditor.run();
  // Persist
  store.recordAudit(report);
  const file = join(REPORTS_DIR, `audit-${report.ts}.json`);
  try { await writeFile(file, JSON.stringify(report, null, 2)); } catch (e) { console.error('write report failed', e.message); }
  res.json(report);
});

// ---- BOS-OMEGA Brain routes ----
// Autonomous audit → research → propose (apply only for already-verified local patches)

const brain = new Brain({ root: ROOT, store });

app.post('/brain/audit-and-fix', async (req, res) => {
  const apply = req.body?.apply === true;
  const severities = Array.isArray(req.body?.severities) ? req.body.severities : ['P0', 'P1'];
  try {
    const result = await brain.runCycle({ apply, severities });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { code: 'brain_cycle_failed', message: e.message, request_id: req.id } });
  }
});

app.get('/brain/status', (req, res) => {
  res.json({
    name: 'BOS-OMEGA Brain',
    version: '0.1.8',
    endpoints: [
      'POST /brain/audit-and-fix  { apply?: boolean, severities?: string[] }',
      'GET  /brain/status',
    ],
    policy: 'propose_only by default; apply=true only re-applies already-verified local patches. No hallucinated code is written.',
  });
});

// ---- Observability ----

app.get('/calls/recent', (req, res) => {
  const n = Math.min(parseInt(req.query.n || '50', 10), 500);
  res.json({ calls: store.recentCalls(n) });
});

app.get('/stats', (req, res) => {
  res.json({ stats: store.callStats() });
});

// ---- Error handler ----

app.use((err, req, res, _next) => {
  // body-parser / express built-in errors carry .status (e.g. 413 PayloadTooLargeError)
  const status = err.status || err.statusCode || 500;
  const code = err.type || (status === 413 ? 'payload_too_large' : 'internal');
  if (status >= 500) {
    console.error(JSON.stringify({ t: new Date().toISOString(), req_id: req.id, err: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') }));
  }
  res.status(status).json({ error: { code, message: err.message, request_id: req.id } });
});

// ---- Graceful shutdown ----

function shutdown(sig) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: `shutting down on ${sig}` }));
  server.close(() => { try { store.close(); } catch {} ; process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'llm-gateway listening', port: PORT, providers: router.providers.map(p => p.name) }));
});
