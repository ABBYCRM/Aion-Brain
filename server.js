// LLM gateway HTTP server.

import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Auditor } from './lib/auditor.js';
import {
  A2EProvider,
  AnthropicProvider,
  CircuitBreaker,
  EchoProvider,
  OpenAIProvider,
  Router,
} from './lib/router.js';
import { Store, defaultStorePath } from './lib/store.js';

const VERSION = '0.2.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const PORT = boundedInteger(process.env.PORT, 1, 65_535, 10_000);
const ROOT = process.cwd();
const REPORTS_DIR = process.env.LLM_GATEWAY_REPORTS_DIR || join(ROOT, 'reports');
const GATEWAY_KEYS = parseSecretSet(process.env.LLM_GATEWAY_API_KEYS);
const ADMIN_TOKENS = parseSecretSet(process.env.LLM_GATEWAY_ADMIN_TOKEN);
const CORS_ORIGINS = parseList(process.env.LLM_GATEWAY_CORS_ORIGINS);
const ALLOW_CLIENT_PROVIDER_KEYS = envBoolean('LLM_GATEWAY_ALLOW_CLIENT_PROVIDER_KEYS', false);
const ALLOW_ECHO = envBoolean('LLM_GATEWAY_ALLOW_ECHO', !IS_PRODUCTION);
const RATE_LIMIT_REQUESTS = boundedInteger(process.env.LLM_GATEWAY_RATE_LIMIT_REQUESTS, 1, 100_000, 120);
const RATE_LIMIT_WINDOW_MS = boundedInteger(process.env.LLM_GATEWAY_RATE_LIMIT_WINDOW_MS, 1_000, 3_600_000, 60_000);

validateProductionConfiguration();
mkdirSync(REPORTS_DIR, { recursive: true }); // startup-only

const store = new Store(defaultStorePath());
const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 30_000 });
const defaultProviders = buildDefaultProviders();
const defaultRouter = new Router({ providers: defaultProviders, breaker, store });
const app = express();
let server;
let shuttingDown = false;
let activeAudit = null;

app.disable('x-powered-by');
if (envBoolean('LLM_GATEWAY_TRUST_PROXY', IS_PRODUCTION)) app.set('trust proxy', 1);

app.use((req, res, next) => {
  const supplied = req.get('x-request-id');
  req.id = supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
  res.setHeader('x-request-id', req.id);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    if (res.statusCode >= 400 || durationMs > 1_000) {
      log(res.statusCode >= 500 ? 'error' : 'warn', 'request completed', {
        request_id: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: durationMs,
      });
    }
  });
  next();
});

app.use(corsMiddleware);
app.use(['/v1/images/edits', '/v1/videos'], express.raw({
  type: request => /^multipart\/form-data(?:;|$)/i.test(request.headers['content-type'] || ''),
  limit: '25mb',
}));
const jsonParser = express.json({ limit: '1mb', type: ['application/json', 'application/*+json'] });
app.use((req, res, next) => Buffer.isBuffer(req.body) ? next() : jsonParser(req, res, next));

const gatewayAuth = authMiddleware({ secrets: GATEWAY_KEYS, header: 'x-gateway-key', label: 'gateway' });
const adminAuth = authMiddleware({ secrets: ADMIN_TOKENS, header: 'x-admin-token', label: 'admin' });
const gatewayRateLimit = createRateLimiter({ max: RATE_LIMIT_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS });

app.get('/healthz', (req, res) => {
  let storageOk = false;
  try { storageOk = store.ping(); } catch {}
  res.status(storageOk ? 200 : 503).json({
    ok: storageOk,
    version: VERSION,
    uptime_s: Math.round(process.uptime()),
    ts: Date.now(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'llm-gateway',
    version: VERSION,
    status: 'available',
    documentation: 'README.md',
  });
});

app.use('/v1', gatewayAuth, gatewayRateLimit, clientProviderKeyPolicy);

app.post('/v1/chat/completions', asyncRoute(async (req, res) => {
  const body = requireJsonObject(req.body);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw httpError(400, 'invalid_messages', 'messages must be a non-empty array');
  }
  if (body.stream === true) throw httpError(400, 'streaming_not_supported', 'Streaming is not supported by this gateway');
  const result = await route(req, { operation: 'chat', payload: body });
  res.json({
    id: `chatcmpl-${req.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1_000),
    model: result.model || body.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.content ?? '' },
      finish_reason: result.finish_reason || 'stop',
    }],
    usage: result.usage || {},
    _meta: responseMeta(result, req.id),
  });
}));

app.post('/v1/images/generations', asyncRoute(async (req, res) => {
  const body = requireJsonObject(req.body);
  requireNonEmptyString(body.prompt, 'prompt');
  const result = await route(req, { operation: 'image.generate', payload: body });
  res.json({
    created: Math.floor(Date.now() / 1_000),
    model: result.model || body.model,
    data: (result.images || []).map(image => compact({ url: image.url, b64_json: image.b64 })),
    _meta: responseMeta(result, req.id),
  });
}));

app.post('/v1/images/edits', asyncRoute(async (req, res) => {
  const multipart = Buffer.isBuffer(req.body);
  const body = multipart ? null : requireJsonObject(req.body);
  if (!multipart) {
    requireNonEmptyString(body.prompt, 'prompt');
    requireNonEmptyString(body.image_b64, 'image_b64');
  }
  const result = await route(req, {
    operation: 'image.edit',
    payload: body || {},
    rawBody: multipart ? req.body : undefined,
    contentType: multipart ? req.get('content-type') : undefined,
  });
  res.json({
    created: Math.floor(Date.now() / 1_000),
    model: result.model || body?.model,
    data: (result.images || []).map(image => compact({ url: image.url, b64_json: image.b64 })),
    _meta: responseMeta(result, req.id),
  });
}));

app.post('/v1/videos', asyncRoute(async (req, res) => {
  const multipart = Buffer.isBuffer(req.body);
  const body = multipart ? null : requireJsonObject(req.body);
  if (!multipart) requireNonEmptyString(body.prompt, 'prompt');
  const result = await route(req, {
    operation: 'video.create',
    payload: body || {},
    rawBody: multipart ? req.body : undefined,
    contentType: multipart ? req.get('content-type') : undefined,
  });
  res.status(202).json({
    id: result.id,
    object: 'video',
    status: result.status || 'queued',
    progress: result.progress,
    model: result.model || body?.model,
    _meta: responseMeta(result, req.id),
  });
}));

app.post('/v1/messages', asyncRoute(async (req, res) => {
  const body = requireJsonObject(req.body);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw httpError(400, 'invalid_messages', 'messages must be a non-empty array');
  }
  const result = await route(req, { operation: 'anthropic.messages', payload: body });
  res.json({
    id: result.id || `msg-${req.id}`,
    type: 'message',
    role: 'assistant',
    model: result.model || body.model,
    content: result.content_blocks || [{ type: 'text', text: result.content || '' }],
    stop_reason: result.finish_reason || 'end_turn',
    usage: {
      input_tokens: result.usage?.input_tokens || 0,
      output_tokens: result.usage?.output_tokens || 0,
    },
    _meta: responseMeta(result, req.id),
  });
}));

app.use('/audit', adminAuth);
app.use('/calls', adminAuth);
app.use('/stats', adminAuth);

app.get('/audit', (req, res) => {
  const last = store.lastAudit();
  if (!last?.report) return res.status(404).json({ error: { code: 'no_audit', message: 'No audit report exists', request_id: req.id } });
  res.json(last.report);
});

app.get('/audit/quick', asyncRoute(async (req, res) => {
  res.json(await runAudit({ mode: 'quick', baseUrl: requestBaseUrl(req), persist: false }));
}));

app.post('/audit/run', asyncRoute(async (req, res) => {
  res.json(await runAudit({ mode: 'full', baseUrl: requestBaseUrl(req), persist: true }));
}));

app.get('/calls/recent', (req, res) => {
  const limit = boundedInteger(req.query.n, 1, 500, 50);
  res.json({ calls: store.recentCalls(limit) });
});

app.get('/stats', (req, res) => {
  const sinceMs = boundedInteger(req.query.since_ms, 60_000, 365 * 24 * 60 * 60 * 1_000, 24 * 60 * 60 * 1_000);
  res.json({ since_ms: sinceMs, stats: store.callStats(sinceMs) });
});

app.use((req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found', request_id: req.id } });
});

app.use((error, req, res, _next) => {
  const status = boundedInteger(error.status || error.statusCode, 400, 599, 500);
  const code = error.code || error.type || (status === 413 ? 'payload_too_large' : 'internal_error');
  if (status >= 500) {
    log('error', 'request failed', {
      request_id: req.id,
      code,
      error: error.message,
      stack: error.stack?.split('\n').slice(0, 5),
    });
  }
  const message = status >= 500 ? 'Internal server error' : (error.expose === false ? 'Request failed' : error.message);
  res.status(status).json({ error: { code, message, request_id: req.id } });
});

server = app.listen(PORT, '0.0.0.0', () => {
  log('info', 'llm-gateway listening', { port: PORT, version: VERSION, providers: defaultProviders.map(provider => provider.name) });
});

process.once('SIGTERM', () => shutdown('SIGTERM', 0));
process.once('SIGINT', () => shutdown('SIGINT', 0));
process.on('unhandledRejection', reason => {
  log('fatal', 'unhandled rejection', { error: reason instanceof Error ? reason.stack : String(reason) });
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', error => {
  log('fatal', 'uncaught exception', { error: error.stack || error.message });
  shutdown('uncaughtException', 1);
});

function buildDefaultProviders() {
  const providers = [];
  if (process.env.OPENAI_API_KEY) providers.push(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }));
  if (process.env.A2E_API_KEY) providers.push(new A2EProvider({ apiKey: process.env.A2E_API_KEY }));
  if (process.env.ANTHROPIC_API_KEY) providers.push(new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
  if (providers.length === 0 && ALLOW_ECHO) providers.push(new EchoProvider());
  if (providers.length === 0) throw new Error('No provider is configured and echo mode is disabled');
  return providers;
}

function resolveRouter(req) {
  if (!ALLOW_CLIENT_PROVIDER_KEYS) return defaultRouter;
  const providers = [];
  if (req.get('x-openai-key')) providers.push(new OpenAIProvider({ apiKey: req.get('x-openai-key') }));
  if (req.get('x-a2e-key')) providers.push(new A2EProvider({ apiKey: req.get('x-a2e-key') }));
  if (req.get('x-anthropic-key')) providers.push(new AnthropicProvider({ apiKey: req.get('x-anthropic-key') }));
  return providers.length ? new Router({ providers, breaker, store }) : defaultRouter;
}

async function route(req, input) {
  const result = await resolveRouter(req).call({
    ...input,
    appId: normalizeLabel(req.get('x-app-id'), 'unknown-app'),
    requestId: req.id,
  });
  if (!result.ok) {
    log('warn', 'all providers failed', { request_id: req.id, operation: input.operation, errors: result.errors });
    throw httpError(502, 'providers_unavailable', 'No configured provider completed the request');
  }
  return result;
}

async function runAudit({ mode, baseUrl, persist }) {
  if (activeAudit) return activeAudit;
  activeAudit = (async () => {
    const report = await new Auditor({ root: ROOT, mode, selfFetch: baseUrl }).run();
    if (persist) {
      store.recordAudit(report);
      await writeFile(join(REPORTS_DIR, `audit-${report.ts}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
    }
    return report;
  })();
  try { return await activeAudit; }
  finally { activeAudit = null; }
}

function corsMiddleware(req, res, next) {
  const origin = req.get('origin');
  const allowAllDevelopment = !IS_PRODUCTION && CORS_ORIGINS.length === 0;
  const allowed = !origin || allowAllDevelopment || CORS_ORIGINS.includes(origin);
  if (origin && !allowed) return next(httpError(403, 'origin_not_allowed', 'Origin is not allowed'));
  if (origin) {
    res.setHeader('access-control-allow-origin', allowAllDevelopment ? '*' : origin);
    if (!allowAllDevelopment) res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', [
    'content-type', 'x-gateway-key', 'x-admin-token', 'x-request-id', 'x-app-id',
    ...(ALLOW_CLIENT_PROVIDER_KEYS ? ['x-openai-key', 'x-anthropic-key', 'x-a2e-key'] : []),
  ].join(','));
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function clientProviderKeyPolicy(req, res, next) {
  if (ALLOW_CLIENT_PROVIDER_KEYS) return next();
  if (req.get('x-openai-key') || req.get('x-anthropic-key') || req.get('x-a2e-key')) {
    return next(httpError(403, 'client_provider_keys_disabled', 'Per-request provider credentials are disabled'));
  }
  next();
}

function authMiddleware({ secrets, header, label }) {
  return (req, res, next) => {
    if (secrets.length === 0 && !IS_PRODUCTION) return next();
    const supplied = req.get(header);
    if (!supplied || !secrets.some(secret => secureEqual(secret, supplied))) {
      res.setHeader('www-authenticate', `${label} key`);
      return next(httpError(401, `${label}_unauthorized`, `${label} authentication required`));
    }
    next();
  };
}

function createRateLimiter({ max, windowMs }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = createHash('sha256').update(`${req.get('x-gateway-key') || ''}|${req.ip || req.socket.remoteAddress || ''}`).digest('hex');
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    res.setHeader('ratelimit-limit', String(max));
    res.setHeader('ratelimit-remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('ratelimit-reset', String(Math.ceil(bucket.resetAt / 1_000)));
    if (bucket.count > max) return next(httpError(429, 'rate_limited', 'Rate limit exceeded'));
    if (buckets.size > 10_000) {
      for (const [bucketKey, value] of buckets) if (now >= value.resetAt) buckets.delete(bucketKey);
    }
    next();
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function shutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { reason, exit_code: exitCode });
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  const finish = () => {
    try { store.checkpoint(); } catch {}
    try { store.close(); } catch {}
    clearTimeout(forceExit);
    process.exitCode = exitCode;
  };
  if (!server) return finish();
  server.close(finish);
  server.closeIdleConnections?.();
}

function validateProductionConfiguration() {
  if (!IS_PRODUCTION) return;
  if (GATEWAY_KEYS.length === 0) throw new Error('LLM_GATEWAY_API_KEYS is required in production');
  if (ADMIN_TOKENS.length === 0) throw new Error('LLM_GATEWAY_ADMIN_TOKEN is required in production');
  if (CORS_ORIGINS.length === 0) throw new Error('LLM_GATEWAY_CORS_ORIGINS is required in production');
}

function requestBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function responseMeta(result, requestId) {
  return {
    provider: result.provider,
    latency_ms: result.latency_ms,
    attempt_latency_ms: result.attempt_latency_ms,
    request_id: requestId,
  };
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function requireJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw httpError(400, 'invalid_json_body', 'A JSON object body is required');
  }
  return value;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw httpError(400, `invalid_${field}`, `${field} is required`);
  return value;
}

function normalizeLabel(value, fallback) {
  if (!value) return fallback;
  return String(value).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128) || fallback;
}

function parseList(value) {
  return [...new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean))];
}

function parseSecretSet(value) {
  return parseList(value);
}

function secureEqual(expected, supplied) {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(String(supplied)).digest();
  return timingSafeEqual(a, b);
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(?:1|true|yes|on)$/i.test(value);
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}

function log(level, message, fields = {}) {
  const method = level === 'error' || level === 'fatal' ? 'error' : 'log';
  console[method](JSON.stringify({ t: new Date().toISOString(), level, msg: message, ...fields }));
}
