// test/aion-chain-fallback.test.mjs
// Catalog misses (401/403/404) must not trip the Bitdeer breaker.
// The chain walks remaining nvidia-catalog models instead of BLOCKED.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AionChain, isModelCatalogFailure } from '../lib/aion_chain.js';
import { CircuitBreaker } from '../lib/router.js';
import { isNvidiaCatalogModel } from '../lib/aion_settings.js';

function catalogErr(status, message = 'unauthorized') {
  const err = new Error(message);
  err.status = status;
  err.code = `http_${status}`;
  return err;
}

test('isModelCatalogFailure treats 400/401/403/404/429 as catalog misses', () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    assert.equal(isModelCatalogFailure(catalogErr(status)), true, String(status));
  }
  const net = new Error('ECONNRESET');
  net.code = 'ECONNRESET';
  assert.equal(isModelCatalogFailure(net), false);
});

test('chat walks past a 401 catalog miss without opening the breaker', async () => {
  let calls = 0;
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
  const provider = {
    name: 'bitdeer',
    async invoke({ payload }) {
      calls += 1;
      if (payload.model.includes('GLM-5')) throw catalogErr(401, '401 unauthorized');
      return { content: 'ok-from-fallback', model: payload.model, finish_reason: 'stop' };
    },
  };
  const chain = new AionChain({
    providers: [provider],
    breaker,
    store: { recordCall() {} },
  });
  const result = await chain.chat({
    messages: [{ role: 'user', content: 'hi' }],
    chain: [
      { provider: 'bitdeer', model: 'zai-org/GLM-5' },
      { provider: 'bitdeer', model: 'mistralai/Mistral-Large-3-675B-Instruct-2512' },
    ],
  });
  assert.equal(result.content, 'ok-from-fallback');
  assert.equal(result.model, 'mistralai/Mistral-Large-3-675B-Instruct-2512');
  assert.equal(calls, 2);
  assert.equal(breaker.isOpen('bitdeer'), false);
});

test('chat rejects non-catalog models on Bitdeer (nvidia catalog policy)', async () => {
  const chain = new AionChain({
    providers: [{ name: 'bitdeer', async invoke() { throw new Error('must not call'); } }],
    store: { recordCall() {} },
  });
  await assert.rejects(
    () => chain.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    /model_policy_rejected:gpt-4o/,
  );
  assert.equal(isNvidiaCatalogModel('gpt-4o'), false);
  assert.equal(isNvidiaCatalogModel('zai-org/GLM-5'), true);
});
