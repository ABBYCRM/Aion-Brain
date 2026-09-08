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
import { ToolRegistry, TOOL_CATALOG } from './lib/brain_tools.js';
import { runLattice } from './lib/lattice.js';
import { ActiveState } from './lib/state.js';
import { AgentMemory } from './lib/memory.js';
import { mkdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSearcher as buildDdgSearcher } from './lib/duckduckgo.js';
import * as skillCatalog from './lib/skill_catalog.js';
import { registerSQMRoutes } from './lib/sqm.js';
import { pickSkills, buildSkillContext } from './lib/skill_router.js';
import { AgentRuntime } from './lib/agent_runtime.js';
import { configuredSecrets, classifyComposioKey, envSecret, gdyConfigured } from './lib/external_tools.js';
import { PHASE_ORDER } from './lib/self_state.js';

const PORT = parseInt(process.env.PORT || '10000', 10);
const ROOT = process.cwd();
const REPORTS_DIR = process.env.LLM_GATEWAY_REPORTS_DIR || join(ROOT, 'reports');
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

const store = new Store(defaultStorePath());
const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 30_000 });

// Build the default provider chain from env. Order = primary -> fallback.
// Keep this in sync with AionChain.fromEnv() — this chain backs the
// OpenAI-compatible /v1/* routes, that one backs /api/chat. NVIDIA and xAI
// were previously missing here, so a deployment with only those keys set
// silently fell through to EchoProvider and echoed requests back.
function buildDefaultChain() {
  const chain = [];
  if (process.env.OPENAI_API_KEY) chain.push(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }));
  if (process.env.NVIDIA_API_KEY) {
    chain.push(new OpenAIProvider({
      name: 'nvidia',
      apiKey: process.env.NVIDIA_API_KEY,
      baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    }));
  }
  if (process.env.XAI_API_KEY) {
    chain.push(new OpenAIProvider({
      name: 'xai',
      apiKey: process.env.XAI_API_KEY,
      baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
    }));
  }
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
const brainStartedAt = Date.now();
const aionChain = AionChain.fromEnv({ breaker, store, appId: 'aion-brain' });
// Long-lived per-process state (free-energy + decision bias) and durable memory
// (episodes, facts, goals). Both feed the /api/chat pipeline.
const activeState = new ActiveState();
const memory = new AgentMemory(join(process.env.LLM_GATEWAY_DATA_DIR || './data', 'memory.db'));
// Wire the kernel-level searcher (DuckDuckGo HTML) and the AionChain
// (for the skill reranker). AION owns its own web_search; the brain
// also exposes web_search so direct callers (curl, scripts) can use it.
const ddgSearcher = buildDdgSearcher();
const brainTools = new ToolRegistry({ searcher: ddgSearcher, chain: aionChain });
const agentRuntime = new AgentRuntime({ chain: aionChain, tools: brainTools });

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
  res.json({
    ok: true,
    ts: Date.now(),
    uptime_s: Math.round(process.uptime()),
    version: '0.1.20',
    secrets: { gdy: gdyConfigured() },
  });
});

app.get('/', (req, res) => {
  const last = store.lastAudit();
  res.json({
    name: 'llm-gateway',
    version: '0.1.20',
    description: 'Plug-and-play LLM gateway with AION 7-law kernel, NVIDIA-first provider chain, ECC skill-pack auto-router, DuckDuckGo + Reddit + Steel.dev tools, and self-auditor',
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
      'GET  /api/skills',
      'GET  /api/skills/:name',
      'POST /api/skills/pick',
      'POST /api/skills/context',
      'GET  /api/tools',
      'POST /api/tools/:name',
      'POST /api/agent/run',
      'POST /api/claw/execute',
      'GET  /api/claw/contract',
      'GET  /api/claw/tools',
      'POST /api/claw/tools/:name',
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

// ---- Skills catalog (ECC bundle) ----
//
// GET /api/skills          -> { count, skills: [{name,title,description,path}] }
// GET /api/skills/:name    -> { name, title, description, path, body, length }
// POST /api/skills/pick    -> { skills: [...] }  (reranker or lexical fallback)
// POST /api/skills/context -> { included, context }  (load N skill bodies)
registerSQMRoutes(app, aionRequire);

app.get('/api/skills', async (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  try {
    const skills = await skillCatalog.list();
    res.json({ count: skills.length, skills });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/skills/:name(*)', async (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  try {
    const entry = await skillCatalog.get(req.params.name);
    if (!entry) return res.status(404).json({ ok: false, error: 'not_found', name: req.params.name });
    res.json({ ...entry, length: (entry.body || '').length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/skills/pick', async (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ ok: false, error: 'query_required' });
  const k = Math.max(1, Math.min(10, Number(req.body?.k) || 3));
  try {
    const out = await pickSkills(query, { chain: aionChain, k });
    res.json({
      query,
      k,
      source: out.source,
      used_reranker: out.used_reranker,
      indices: out.indices || null,
      raw_model_output: out.raw || null,
      skills: out.skills.map((s) => ({ name: s.name, title: s.title, description: s.description, path: s.path })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/skills/context', async (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  if (names.length === 0) return res.status(400).json({ ok: false, error: 'names_required' });
  try {
    const out = await buildSkillContext(names);
    res.json({ requested: names, included: out.included, length: out.context.length, context: out.context });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

  // Opt-in agentic path: same SSE names Claw already consumes (decision,
  // delta, done) plus self_state / tool events. Default remains the
  // single-shot consult so existing smoke tests stay stable.
  if (req.body?.agentic === true) {
    const sessionId = String(req.body?.session_id || req.header('x-aion-session-id') || principal.subject || req.id);
    const ctx = new MissionContext({ userInput: userText, history: messages.slice(0, -1) });
    const decision = resolveDecision(ctx);
    let ran;
    try {
      ran = await agentRuntime.run({
        goal: userText,
        acceptance: Array.isArray(req.body?.acceptance) ? req.body.acceptance : [],
        sessionId,
        model: req.body?.model || aionSettings.primaryModel,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
    const answer = answerFromAgent(ran);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-AION-Decision', decision.state);
    res.setHeader('X-AION-Session-Id', sessionId);
    res.flushHeaders && res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'decision', request_id: ctx.requestId, decision })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'self_state', self_state: ran.self_state, status: ran.status, verified: ran.verified })}\n\n`);
    for (const c of ran.cycles || []) {
      if (c.action?.kind === 'tool') {
        res.write(`data: ${JSON.stringify({ type: 'tool_start', name: c.action.tool })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'tool_end', name: c.action.tool, ok: c.action.ok })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ type: 'attempt', provider: 'aion-agent', model: aionSettings.agentModel, index: 1 })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'open', provider: 'aion-agent', model: aionSettings.agentModel, streaming: 'simulated' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'delta', text: answer })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', streaming: 'simulated', provider: 'aion-agent', model: aionSettings.agentModel, finish_reason: ran.complete ? 'stop' : 'incomplete', verified: ran.verified })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Build AION decision
  const history = messages.slice(0, -1).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }));
  const ctx = new MissionContext({ userInput: userText, history });
  const decision = resolveDecision(ctx);

  // Stable per-conversation session ID. req.id is a fresh random UUID on
  // every single request, so using it here (the old behavior) meant the
  // durable-memory lookup below always missed — every request looked like
  // the first message of a session that never existed before. Callers
  // that want real cross-turn recall pass session_id (or x-aion-session-id);
  // it survives page reloads because the frontend persists the
  // conversation's own ID. Falls back to the per-subject key so at least
  // same-key callers share memory instead of nothing recalling at all.
  const sessionId = String(req.body?.session_id || req.header('x-aion-session-id') || principal.subject || req.id);
  res.setHeader('X-AION-Session-Id', sessionId);

  // Memory pack: durable context from previous episodes + facts + goals
  let memoryPack = null;
  try {
    memoryPack = memory.contextPack({ sessionId, subject: principal.subject, limit: 8 });
  } catch { memoryPack = null; }

  // Optional tool: AION owns the real web search; default no-op here.
  const toolEvidence = null;

  // Lattice: 3 roles in parallel; majority + critic veto
  let lattice = null;
  try {
    lattice = await runLattice({ ctx, decision, toolEvidence, activeState, memoryPack, tools: brainTools });
  } catch (e) {
    lattice = { consensus: decision.state, votes: {}, rationale: `lattice_error: ${e.message}`, error: true };
  }

  // Decision bias from active state
  const bias = activeState.decisionBias();
  if (bias?.preferDefer && lattice.consensus === 'COMMIT') {
    lattice = { ...lattice, consensus: 'DEFER', rationale: (lattice.rationale || '') + ' | active_state_prefer_defer' };
  }

  // Auto-pick skills from the ECC pack and inject their bodies as
  // system context. Skipped if the user passes { skills: false }.
  // Capped at top-K (env RERANKER_TOP_K, default 3) to keep the prompt small.
  let skillInject = null;
  if (req.body?.skills !== false) {
    try {
      const picked = await pickSkills(userText, { chain: aionChain });
      if (picked.skills.length > 0) {
        const ctx = await buildSkillContext(picked.skills.map((s) => s.name));
        if (ctx.context) skillInject = { ...picked, context: ctx.context, included: ctx.included };
      } else {
        skillInject = { ...picked, context: '', included: [] };
      }
    } catch { skillInject = null; }
  }

  // Build AION system prompt (with tool + lattice + memory pack context).
  // memoryPack.contextPack() returns { episodes, facts, goals } — episodes
  // are this session's own prior turns (durable across requests now that
  // sessionId is stable); facts/goals are cross-session long-term memory.
  const toolContext = toolEvidence ? JSON.stringify(toolEvidence).slice(0, 1000) : '';
  const notesLines = [
    ...(memoryPack?.episodes || []).slice().reverse().map(e => `- [prior ${e.role}] ${e.content}`),
    ...(memoryPack?.facts || []).map(f => `- known fact: ${f}`),
    ...(memoryPack?.goals || []).map(g => `- active goal: ${g.title} (${Math.round((g.progress || 0) * 100)}%)`),
  ];
  const notesContext = notesLines.join('\n');
  const systemPrompt = buildSystemPrompt(decision, {
    toolContext,
    notesContext,
    lattice: { consensus: lattice.consensus, rationale: lattice.rationale, votes: lattice.votes },
  });
  // Prepend the auto-picked skills (if any) to the system prompt as
  // additional context. Skills are guidance, not commands — the model
  // is told to use them as context, not blindly follow.
  const systemContent = skillInject && skillInject.context
    ? `${systemPrompt}\n\n${skillInject.context}`
    : systemPrompt;
  const fullMessages = [{ role: 'system', content: systemContent }, ...messages];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-AION-Decision', decision.state);
  if (skillInject) {
    res.setHeader('X-AION-Skills-Source', String(skillInject.source || 'none'));
    res.setHeader('X-AION-Skills-Count', String(skillInject.included?.length || 0));
  }
  res.flushHeaders && res.flushHeaders();

  // 1) decision event
  res.write(`data: ${JSON.stringify({ type: 'decision', request_id: ctx.requestId, decision })}\n\n`);

  // 2) lattice consensus event (proves runLattice fired end-to-end)
  res.write(`data: ${JSON.stringify({
    type: 'lattice',
    consensus: lattice.consensus,
    votes: lattice.votes,
    rationale: lattice.rationale,
    free_energy: activeState.freeEnergy(),
  })}\n\n`);

  // 2.5) skill injection event (proves the reranker fired and what it picked)
  if (skillInject) {
    res.write(`data: ${JSON.stringify({
      type: 'skills',
      source: skillInject.source,
      used_reranker: skillInject.used_reranker,
      included: skillInject.included || [],
      candidate_count: skillInject.skills?.length || 0,
      raw_model_output: skillInject.raw || null,
    })}\n\n`);
  }

  // 3) stream
  let streamOk = true;
  let streamError = null;
  let assistantText = '';
  try {
    for await (const evt of aionChain.stream({ messages: fullMessages, temperature, maxTokens })) {
      res.write(evt);
      // Accumulate the real reply text so the post-stream episode below
      // remembers what was actually said, not a placeholder string.
      const m = evt.match(/^data: (.+)$/m);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          if (parsed.type === 'delta' && typeof parsed.text === 'string') assistantText += parsed.text;
        } catch { /* non-JSON or [DONE] line */ }
      }
    }
  } catch (e) {
    streamOk = false;
    streamError = e.message;
    res.write(`data: ${JSON.stringify({ type: 'error', kind: 'stream_failed', message: e.message })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();

  // 4) post-stream: observe + remember episode + log
  activeState.observe({
    state: decision.state,
    score: decision.score,
    error: !streamOk,
    latencyMs: Date.now() - ctx.startedAt,
  });
  try {
    // Remember both sides of the turn under the stable sessionId so the
    // next request with the same session_id actually recalls this
    // exchange via the memoryPack build above.
    memory.rememberEpisode({
      sessionId,
      role: 'user',
      content: userText,
      meta: { request_id: ctx.requestId, principal: principal.subject },
    });
    memory.rememberEpisode({
      sessionId,
      role: 'assistant',
      content: assistantText || (streamOk ? '' : `[stream_error: ${streamError}]`),
      decisionState: lattice.consensus,
      decisionScore: decision.score,
      meta: { request_id: ctx.requestId, principal: principal.subject, lattice: lattice.consensus, stream_error: streamError },
    });
  } catch { /* non-fatal */ }
  // record
  store.recordCall({
    ts: ctx.startedAt,
    app_id: principal.subject,
    provider: 'aion',
    model: aionSettings.primaryModel,
    operation: 'aion.chat',
    status: streamOk ? 200 : 500,
    latency_ms: Date.now() - ctx.startedAt,
    request_id: ctx.requestId,
  });
});

// ---- AION API: state, tools catalog, tool runner ----

app.get('/api/state', (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  res.json({
    ok: true,
    app: 'aion-brain',
    version: '0.1.20',
    environment: process.env.ENVIRONMENT || 'development',
    primary_model: aionSettings.primaryModel,
    agent_model: aionSettings.agentModel,
    fallback_models: aionSettings.fallbackModels,
    providers: aionChain.providers.map(p => p.name),
    continuity_pack: { laws: AION_CONTINUITY_PACK.core_laws, states: AION_CONTINUITY_PACK.decision_states },
    uptime_ms: Date.now() - (brainStartedAt || Date.now()),
    active_state: activeState.snapshot(),
    control_loop: {
      phases: PHASE_ORDER,
      tools_configured: configuredSecrets(),
      composio_key_type: envSecret('COMPOSIO_API_KEY') ? classifyComposioKey(envSecret('COMPOSIO_API_KEY')).type : 'missing',
    },
  });
});

// Memory read API (admin only — durable SQLite, can leak session context otherwise)
app.get('/api/memory/episodes', (req, res) => {
  try { aionAdmin(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  const sessionId = (req.query.sessionId && String(req.query.sessionId)) || null;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  const eps = memory.recentEpisodes({ sessionId, limit });
  res.json({ ok: true, episodes: eps, count: eps.length });
});

app.get('/api/tools', (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  res.json({ ok: true, tools: brainTools.catalog(), count: brainTools.catalog().length });
});

app.post('/api/tools/:name', async (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  const name = String(req.params.name || '').trim();
  if (!brainTools.has(name)) return res.status(404).json({ ok: false, error: `unknown_tool:${name}` });
  const args = (req.body && typeof req.body === 'object') ? req.body : {};
  const result = await brainTools.run(name, args);
  store.recordCall({ ts: Date.now(), app_id: 'aion-brain', provider: 'tool', model: name, operation: `tool.${name}`, status: result.ok ? 200 : 400, latency_ms: 0, request_id: req.id });
  res.status(result.ok ? 200 : 400).json({ ok: result.ok, tool: name, ...result });
});

// ---- Agentic control loop + VIDEO-Engine-CCFL claw contract ----
// Claw (lib/claw/aion.ts) already calls /api/state, /api/chat, /api/tools/:name.
// /api/claw/execute is the dead-loop-free path: SELF_STATE cycle + real tool
// execution. /api/chat?agentic=true uses the same runtime and still emits
// the existing SSE event names so aionConsult keeps working.

const CLAW_CONTRACT = Object.freeze({
  version: '0.1.20',
  phases: PHASE_ORDER,
  endpoints: {
    execute: { method: 'POST', path: '/api/claw/execute', alias: '/api/agent/run' },
    tools_catalog: { method: 'GET', path: '/api/claw/tools', alias: '/api/tools' },
    tool_run: { method: 'POST', path: '/api/claw/tools/:name', alias: '/api/tools/:name' },
    consult: { method: 'POST', path: '/api/chat', notes: 'Set agentic:true to run the control loop inside the existing SSE stream' },
    state: { method: 'GET', path: '/api/state' },
  },
  auth: 'X-AION-Key or Authorization: Bearer (must match AION_API_KEYS)',
  execute_body: {
    goal: 'string (or prompt, or messages[].content)',
    acceptance: '[{ id, description, tool? }] — COMPLETE is refused until each check has evidence_id',
    session_id: 'optional; Claw should pass claw:<conversationId>',
    max_cycles: '1..24, default 8',
    stream: 'if true, SSE events: phase, tool_start, tool_end, self_state, done',
  },
  self_state_fields: [
    'active_goal', 'current_plan', 'current_step', 'completed_steps', 'pending_steps',
    'working_memory', 'relevant_long_term_memory', 'assumptions', 'known_facts',
    'unknowns', 'uncertainties', 'current_strategy', 'alternative_strategies',
    'available_tools', 'tool_status', 'previous_tool_results', 'errors', 'warnings',
    'blockers', 'resource_usage', 'remaining_budget', 'progress', 'confidence',
    'expected_outcome', 'observed_outcome',
  ],
  health: ['HEALTHY', 'DEGRADED', 'LOOP_DETECTED', 'BLOCKED', 'UNSTABLE'],
  epistemic: ['KNOWN', 'INFERRED', 'ASSUMED', 'UNKNOWN', 'CONTRADICTED'],
  completion: 'status=COMPLETE only when every acceptance check is verified by a successful tool result. Confidence is not proof.',
  anti_loop: 'Same strategy failing ≥2 times with no new evidence → LOOP_DETECTED; identical retry is forbidden.',
});

function goalFromBody(body) {
  if (typeof body?.goal === 'string' && body.goal.trim()) return body.goal.trim();
  if (typeof body?.prompt === 'string' && body.prompt.trim()) return body.prompt.trim();
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  if (!lastUser) return '';
  return typeof lastUser.content === 'string'
    ? lastUser.content.trim()
    : (Array.isArray(lastUser.content) ? lastUser.content.map((p) => p.text || '').join('\n').trim() : '');
}

function answerFromAgent(result) {
  const responds = (result.cycles || [])
    .map((c) => c.action)
    .filter((a) => a && a.kind === 'respond' && a.text)
    .map((a) => a.text);
  if (responds.length) return responds.at(-1);
  const tools = result.self_state?.previous_tool_results || [];
  const lastOk = [...tools].reverse().find((t) => t.ok);
  if (lastOk) return `Executed ${lastOk.tool} (${lastOk.id}). Status ${result.status}. Verified=${result.verified}.`;
  return `Status ${result.status}: ${result.reason}. Verified=${result.verified}.`;
}

async function runAgentFromRequest(req, principal) {
  const goal = goalFromBody(req.body || {});
  if (!goal) {
    const err = new Error('goal_required');
    err.statusCode = 400;
    err.public = { ok: false, error: 'goal_required' };
    throw err;
  }
  const sessionId = String(req.body?.session_id || req.header('x-aion-session-id') || `claw:${principal.subject}`);
  const acceptance = Array.isArray(req.body?.acceptance)
    ? req.body.acceptance
    : (Array.isArray(req.body?.checks) ? req.body.checks : []);
  const maxCycles = Number.isFinite(req.body?.max_cycles) ? req.body.max_cycles : undefined;
  const result = await agentRuntime.run({
    goal,
    acceptance,
    sessionId,
    maxCycles,
    model: req.body?.model || aionSettings.primaryModel,
  });
  return { goal, sessionId, result, answer: answerFromAgent(result) };
}

app.get('/api/claw/contract', (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  res.json({ ok: true, contract: CLAW_CONTRACT });
});

app.get('/api/claw/tools', (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  res.json({ ok: true, tools: brainTools.catalog(), count: brainTools.catalog().length });
});

app.post('/api/claw/tools/:name', async (req, res) => {
  try { aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  const name = String(req.params.name || '').trim();
  if (!brainTools.has(name)) return res.status(404).json({ ok: false, error: `unknown_tool:${name}` });
  const args = (req.body && typeof req.body === 'object') ? req.body : {};
  const result = await brainTools.run(name, args);
  store.recordCall({ ts: Date.now(), app_id: 'aion-brain', provider: 'tool', model: name, operation: `claw.tool.${name}`, status: result.ok ? 200 : 400, latency_ms: 0, request_id: req.id });
  res.status(result.ok ? 200 : 400).json({ ok: result.ok, tool: name, ...result });
});

async function handleAgentExecute(req, res) {
  let principal;
  try { principal = aionRequire(req); } catch (e) { return res.status(e.statusCode || 401).json(e.public || { detail: e.message }); }
  let ran;
  try {
    ran = await runAgentFromRequest(req, principal);
  } catch (e) {
    return res.status(e.statusCode || 500).json(e.public || { ok: false, error: e.message });
  }
  const { result, answer, sessionId } = ran;
  store.recordCall({
    ts: Date.now(),
    app_id: principal.subject,
    provider: 'aion-agent',
    model: aionSettings.agentModel,
    operation: 'aion.agent',
    status: result.complete ? 200 : 202,
    latency_ms: result.duration_ms,
    request_id: req.id,
  });
  const payload = {
    ok: true,
    source: 'aion-brain',
    status: result.status,
    reason: result.reason,
    complete: result.complete,
    verified: result.verified,
    answer,
    session_id: sessionId,
    self_state: result.self_state,
    cycles: (result.cycles || []).map((c) => ({
      health: c.health?.status,
      issues: c.issues?.issues,
      action: c.action ? { kind: c.action.kind, tool: c.action.tool, ok: c.action.ok, rejected: c.action.rejected, reason: c.action.reason } : null,
      termination: c.termination,
    })),
    previous_tool_results: result.self_state?.previous_tool_results || [],
    duration_ms: result.duration_ms,
  };
  const wantStream = req.body?.stream === true || (req.header('accept') || '').includes('text/event-stream');
  if (!wantStream) return res.status(result.complete ? 200 : 202).json(payload);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-AION-Session-Id', sessionId);
  res.flushHeaders && res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'self_state', self_state: result.self_state })}\n\n`);
  for (const c of result.cycles || []) {
    res.write(`data: ${JSON.stringify({ type: 'phase', health: c.health?.status, issues: c.issues?.issues, action: c.action?.kind, tool: c.action?.tool })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ type: 'delta', text: answer })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'done', status: result.status, verified: result.verified, provider: 'aion-agent', model: aionSettings.agentModel })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

app.post('/api/agent/run', handleAgentExecute);
app.post('/api/claw/execute', handleAgentExecute);

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
    version: '0.1.20',
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
