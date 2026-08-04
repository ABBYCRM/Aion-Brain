import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const PORT = 10_999 + Math.floor(Math.random() * 1_000);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const DATA_DIR = join(process.cwd(), `data-smoke-${RUN_ID}`);
const REPORTS_DIR = join(process.cwd(), `reports-smoke-${RUN_ID}`);
const GATEWAY_KEY = 'smoke-gateway-key';
const ADMIN_TOKEN = 'smoke-admin-token';
const ALLOWED_ORIGIN = 'https://app.example';

await mkdir(DATA_DIR, { recursive: true });
await mkdir(REPORTS_DIR, { recursive: true });

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(PORT),
  LLM_GATEWAY_DATA_DIR: DATA_DIR,
  LLM_GATEWAY_REPORTS_DIR: REPORTS_DIR,
  LLM_GATEWAY_API_KEYS: GATEWAY_KEY,
  LLM_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
  LLM_GATEWAY_CORS_ORIGINS: ALLOWED_ORIGIN,
  LLM_GATEWAY_ALLOW_ECHO: 'true',
  LLM_GATEWAY_RATE_LIMIT_REQUESTS: '1000',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  A2E_API_KEY: '',
};

const server = spawn(process.execPath, ['server.js'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk.toString(); });
server.stderr.on('data', chunk => { serverLog += chunk.toString(); });

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(path, options = {}) {
  return fetch(`${BASE}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`server exited during startup with ${server.exitCode}`);
    try {
      const response = await request('/healthz');
      if (response.ok) return;
    } catch {}
    await wait(200);
  }
  throw new Error('server did not become healthy within 10 seconds');
}

function gatewayHeaders(extra = {}) {
  return { 'content-type': 'application/json', 'x-gateway-key': GATEWAY_KEY, ...extra };
}

let fatalError = null;
try {
  await waitForServer();

  {
    const response = await request('/healthz');
    const body = await response.json();
    check('health reports storage readiness', response.status === 200 && body.ok === true && body.version === '0.2.0');
  }

  {
    const response = await request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'echo', messages: [{ role: 'user', content: 'hello' }] }),
    });
    check('gateway rejects unauthenticated inference', response.status === 401, `status=${response.status}`);
  }

  {
    const response = await request('/v1/chat/completions', {
      method: 'POST',
      headers: gatewayHeaders({ 'x-request-id': 'smoke-request-1', 'x-app-id': 'smoke' }),
      body: JSON.stringify({ model: 'echo', messages: [{ role: 'user', content: 'hello' }] }),
    });
    const body = await response.json();
    check('chat completion works', response.ok && body.choices?.[0]?.message?.content === '[echo:chat] hello');
    check('request ID round trips', response.headers.get('x-request-id') === 'smoke-request-1');
  }

  {
    const response = await request('/v1/images/generations', {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({ model: 'echo-image', prompt: 'a cat' }),
    });
    const body = await response.json();
    check('image generation returns an image', response.ok && typeof body.data?.[0]?.b64_json === 'string' && body.data[0].b64_json.length > 20);
  }

  {
    const response = await request('/v1/images/edits', {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({ model: 'echo-image', prompt: 'edit', image_b64: 'aW1hZ2U=' }),
    });
    const body = await response.json();
    check('JSON image edit returns an image', response.ok && typeof body.data?.[0]?.b64_json === 'string');
  }

  {
    const response = await request('/v1/videos', {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({ model: 'echo-video', prompt: 'a dog' }),
    });
    const body = await response.json();
    check('video creation returns a queued job', response.status === 202 && body.id === 'video_echo' && body.status === 'queued');
  }

  {
    const response = await request('/v1/messages', {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({ model: 'echo-anthropic', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }),
    });
    const body = await response.json();
    check('Anthropic-compatible messages route works', response.ok && body.type === 'message' && body.content?.[0]?.type === 'text');
  }

  {
    const response = await request('/v1/chat/completions', {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({ model: 'echo', messages: [] }),
    });
    const body = await response.json();
    check('invalid request is rejected', response.status === 400 && body.error?.code === 'invalid_messages');
  }

  {
    const response = await request('/audit/quick');
    check('audit endpoint rejects unauthenticated access', response.status === 401, `status=${response.status}`);
  }

  {
    const response = await request('/audit/quick', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const body = await response.json();
    check('quick audit verifies real health', response.ok && body.status === 'HEALTH_VERIFIED' && body.assurance === 'runtime-health-only');
  }

  {
    const response = await request('/audit/run', { method: 'POST', headers: { 'x-admin-token': ADMIN_TOKEN } });
    const body = await response.json();
    check('full audit reports bounded assurance', response.ok && body.assurance === 'static-and-runtime-health-only' && body.status !== 'VERIFIED_COMPLETE');
    check('full audit has no unverified fix claims', body.unverified_fixes === 0, `unverified=${body.unverified_fixes}`);
  }

  {
    const response = await request('/calls/recent?n=20', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const body = await response.json();
    check('call log is admin-protected and populated', response.ok && Array.isArray(body.calls) && body.calls.length >= 5, `count=${body.calls?.length}`);
  }

  {
    const response = await request('/stats', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const body = await response.json();
    check('stats are admin-protected and populated', response.ok && Array.isArray(body.stats) && body.stats.length > 0);
  }

  {
    const response = await request('/v1/chat/completions', {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN },
    });
    check('CORS allows configured origin only', response.status === 204 && response.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN);
  }

  {
    const response = await request('/v1/chat/completions', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    check('CORS rejects an unconfigured origin', response.status === 403, `status=${response.status}`);
  }

  {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const response = await request('/v1/chat/completions', {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({ model: 'echo', messages: [{ role: 'user', content: huge }] }),
    });
    check('JSON body limit is enforced', response.status === 413, `status=${response.status}`);
  }
} catch (error) {
  fatalError = error;
  console.error('SMOKE ERROR:', error.stack || error.message);
} finally {
  server.kill('SIGTERM');
  await wait(300);
  if (server.exitCode === null) server.kill('SIGKILL');
  await rm(DATA_DIR, { recursive: true, force: true });
  await rm(REPORTS_DIR, { recursive: true, force: true });
}

const failed = results.filter(result => !result.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
if (failed.length || fatalError) {
  for (const failure of failed) console.error(`FAILED: ${failure.name}${failure.detail ? ` — ${failure.detail}` : ''}`);
  console.error('\n--- server log tail ---');
  console.error(serverLog.split('\n').slice(-30).join('\n'));
  process.exitCode = 1;
}
