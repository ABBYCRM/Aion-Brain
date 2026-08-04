import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Auditor } from '../lib/auditor.js';
import { GatewayClient, GatewayError } from '../lib/client.js';
import {
  CircuitBreaker,
  OpenAIProvider,
  Router,
} from '../lib/router.js';

test('circuit breaker preserves failures until threshold and opens', () => {
  const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  breaker.recordFailure('primary');
  assert.equal(breaker.isOpen('primary'), false);
  assert.equal(breaker.state('primary').count, 1);
  breaker.recordFailure('primary');
  assert.equal(breaker.isOpen('primary'), true);
  assert.equal(breaker.state('primary').count, 2);
});

test('unsupported provider capability falls through without opening circuit', async () => {
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
  const providers = [
    {
      name: 'unsupported',
      async invoke() {
        throw Object.assign(new Error('not supported'), { code: 'unsupported_operation', status: 400 });
      },
    },
    {
      name: 'working',
      async invoke() { return { model: 'ok', content: 'done' }; },
    },
  ];
  const result = await new Router({ providers, breaker }).call({ operation: 'chat', payload: {} });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'working');
  assert.equal(breaker.state('unsupported').count, 0);
});

test('OpenAI video creation uses multipart form data', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ id: 'video_1', status: 'queued', model: 'sora-2' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider = new OpenAIProvider({ apiKey: 'test-key' });
  const result = await provider.invoke({
    operation: 'video.create',
    payload: { model: 'sora-2', prompt: 'test', seconds: 4 },
    fetchImpl,
  });
  assert.equal(captured.url, 'https://api.openai.com/v1/videos');
  assert.ok(captured.init.body instanceof FormData);
  assert.equal(captured.init.headers.authorization, 'Bearer test-key');
  assert.equal(result.id, 'video_1');
});

test('GatewayClient reports typed HTTP errors with request IDs', async () => {
  const client = new GatewayClient({
    baseUrl: 'https://gateway.invalid',
    gatewayKey: 'gateway-key',
    fetchImpl: async (_url, init) => new Response(JSON.stringify({
      error: { code: 'invalid_messages', message: 'bad messages', request_id: init.headers['x-request-id'] },
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    client.chat({ model: 'x', messages: [] }, { requestId: 'req-1' }),
    error => error instanceof GatewayError
      && error.status === 400
      && error.code === 'invalid_messages'
      && error.requestId === 'req-1',
  );
});

test('auditor excludes generated data directories and does not overclaim completeness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aion-audit-'));
  try {
    await mkdir(join(root, 'lib'));
    await mkdir(join(root, 'data-real-123'));
    await writeFile(join(root, 'lib', 'safe.js'), 'export const fixedSymbol = true;\n');
    await writeFile(join(root, 'data-real-123', 'leak.json'), JSON.stringify({ token: 'fixedSymbol' }));
    await writeFile(join(root, 'CHANGELOG.md'), '## 0.1.1 — fix\n- `fixedSymbol`\n');
    const auditor = new Auditor({
      root,
      mode: 'full',
      selfFetch: 'http://self',
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    const report = await auditor.run();
    assert.equal(report.phases.inventory.manifest.some(item => item.path.startsWith('data-real-')), false);
    assert.equal(report.unverified_fixes, 0);
    assert.equal(report.status, 'STATIC_HEALTH_VERIFIED');
    assert.match(report.assurance, /static-and-runtime-health-only/);
    assert.ok(report.limitations.length >= 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auditor fails an absent claimed symbol', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aion-audit-'));
  try {
    await writeFile(join(root, 'app.js'), 'export const present = true;\n');
    await writeFile(join(root, 'CHANGELOG.md'), '## 0.1.1 — security fix\n- `missingSymbol`\n');
    const report = await new Auditor({
      root,
      mode: 'full',
      selfFetch: 'http://self',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    }).run();
    assert.equal(report.status, 'FAILED');
    assert.equal(report.unverified_fixes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
