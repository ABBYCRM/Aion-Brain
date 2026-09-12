// test/bitdeer_primary.test.mjs
// Production inference is BITDEER-PRIMARY. Extra GEMINI/XAI/KIMI/OPENAI keys
// are optional side tools and must never join the /v1 or /api/chat chain.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AionChain } from '../lib/aion_chain.js';
import { aionSettings, isNvidiaCatalogModel } from '../lib/aion_settings.js';
import { buildDefaultChain, resolveProviders, NVIDIA_CORS_HEADERS } from '../lib/nvidia_only_providers.js';
import { pickForcedTool } from '../lib/agent_runtime.js';
import { connectorsSnapshot } from '../lib/connectors.js';
import { TOOL_CATALOG } from '../lib/brain_tools.js';

const SIDE_KEYS = ['OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'KIMI_API_KEY', 'ANTHROPIC_API_KEY', 'A2E_API_KEY'];
const BITDEER_KEYS = ['BITDEER_API_KEY', 'BITDEER_API_KEYS', 'NVIDIA_API_KEY', 'NVIDIA_API_KEYS', 'AION_ECHO_ONLY'];

function saveEnv(names) {
  const snap = {};
  for (const name of names) snap[name] = process.env[name];
  return snap;
}

function restoreEnv(snap) {
  for (const [name, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function headerReq(headers) {
  return {
    header(name) {
      const key = String(name || '').toLowerCase();
      return headers[key] || headers[name] || undefined;
    },
  };
}

test('buildDefaultChain stays Bitdeer-only when extra provider keys are set', () => {
  const snap = saveEnv([...SIDE_KEYS, ...BITDEER_KEYS]);
  try {
    delete process.env.AION_ECHO_ONLY;
    process.env.BITDEER_API_KEY = 'bd-test-key-do-not-leak';
    delete process.env.BITDEER_API_KEYS;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_API_KEYS;
    process.env.OPENAI_API_KEY = 'sk-test-do-not-leak';
    process.env.XAI_API_KEY = 'xai-test-do-not-leak';
    process.env.GEMINI_API_KEY = 'gem-test-do-not-leak';
    process.env.KIMI_API_KEY = 'kimi-test-do-not-leak';
    process.env.ANTHROPIC_API_KEY = 'anth-test-do-not-leak';
    process.env.A2E_API_KEY = 'a2e-test-do-not-leak';

    const names = buildDefaultChain().map((p) => p.name);
    assert.deepEqual(names, ['bitdeer']);
    assert.equal(names.includes('openai'), false);
    assert.equal(names.includes('xai'), false);
  } finally {
    restoreEnv(snap);
  }
});

test('AionChain.fromEnv stays Bitdeer-only when extra provider keys are set', () => {
  const snap = saveEnv([...SIDE_KEYS, ...BITDEER_KEYS]);
  try {
    delete process.env.AION_ECHO_ONLY;
    process.env.BITDEER_API_KEY = 'bd-test-key-do-not-leak';
    process.env.OPENAI_API_KEY = 'sk-test-do-not-leak';
    process.env.XAI_API_KEY = 'xai-test-do-not-leak';
    process.env.GEMINI_API_KEY = 'gem-test-do-not-leak';
    process.env.KIMI_API_KEY = 'kimi-test-do-not-leak';

    const chain = AionChain.fromEnv({ appId: 'bitdeer-primary-test' });
    assert.deepEqual(chain.providers.map((p) => p.name), ['bitdeer']);
  } finally {
    restoreEnv(snap);
  }
});

test('AION_ECHO_ONLY keeps echo even when extra keys and Bitdeer are set', () => {
  const snap = saveEnv([...SIDE_KEYS, ...BITDEER_KEYS]);
  try {
    process.env.AION_ECHO_ONLY = '1';
    process.env.BITDEER_API_KEY = 'bd-test-key-do-not-leak';
    process.env.OPENAI_API_KEY = 'sk-test-do-not-leak';
    process.env.XAI_API_KEY = 'xai-test-do-not-leak';

    assert.deepEqual(buildDefaultChain().map((p) => p.name), ['echo']);
    assert.deepEqual(AionChain.fromEnv({ appId: 'echo-test' }).providers.map((p) => p.name), ['echo']);
  } finally {
    restoreEnv(snap);
  }
});

test('primaryModel and agentModel stay on the nvidia/Bitdeer catalog', () => {
  assert.ok(isNvidiaCatalogModel(aionSettings.primaryModel), `primaryModel=${aionSettings.primaryModel}`);
  assert.ok(isNvidiaCatalogModel(aionSettings.agentModel), `agentModel=${aionSettings.agentModel}`);
  assert.equal(aionSettings.primaryModel, 'zai-org/GLM-5');
  assert.equal(aionSettings.agentModel, 'mistralai/Mistral-Large-3-675B-Instruct-2512');
  for (const model of aionSettings.fallbackModels) {
    assert.ok(isNvidiaCatalogModel(model), `fallback=${model}`);
  }
});

test('resolveProviders ignores OpenAI/xAI/A2E/Anthropic headers', () => {
  const router = { name: 'default-bitdeer-router' };
  const resolved = resolveProviders(
    headerReq({
      'x-openai-key': 'sk-header-do-not-leak',
      'x-a2e-key': 'a2e-header-do-not-leak',
      'x-anthropic-key': 'anth-header-do-not-leak',
      authorization: 'Bearer sk-bearer-do-not-leak',
    }),
    { breaker: {}, store: {}, router },
  );
  assert.equal(resolved, router);

  const bitdeer = resolveProviders(
    headerReq({ 'x-bitdeer-key': 'bd-header-do-not-leak' }),
    { breaker: {}, store: {}, router },
  );
  assert.notEqual(bitdeer, router);
  assert.equal(bitdeer.providers[0].name, 'bitdeer');
});

test('NVIDIA_CORS_HEADERS does not advertise non-Bitdeer key headers', () => {
  assert.match(NVIDIA_CORS_HEADERS, /x-bitdeer-key/);
  assert.match(NVIDIA_CORS_HEADERS, /x-nvidia-key/);
  assert.equal(NVIDIA_CORS_HEADERS.includes('x-openai-key'), false);
  assert.equal(NVIDIA_CORS_HEADERS.includes('x-anthropic-key'), false);
  assert.equal(NVIDIA_CORS_HEADERS.includes('x-a2e-key'), false);
});

test('planner never prefers openai_chat for generic production chat', () => {
  const available = [
    'openai_chat', 'gemini_chat', 'xai_chat', 'kimi_chat',
    'datetime', 'web_search', 'echo',
  ];
  const generic = pickForcedTool(
    { active_goal: 'answer the user about today', available_tools: available, previous_tool_results: [] },
    { forbidden_strategies: [] },
  );
  assert.ok(generic);
  assert.equal(['openai_chat', 'gemini_chat', 'xai_chat', 'kimi_chat'].includes(generic), false);

  assert.equal(
    pickForcedTool(
      { active_goal: 'ask gemini about this', available_tools: available, previous_tool_results: [] },
      { forbidden_strategies: [] },
    ),
    'gemini_chat',
  );
});

test('optional side-tool catalog and connectors say they are not production defaults', () => {
  for (const name of ['gemini_chat', 'xai_chat', 'kimi_chat', 'openai_chat']) {
    const tool = TOOL_CATALOG.find((t) => t.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.match(tool.description, /optional side tool/i);
    assert.match(tool.description, /never a production chat default/i);
  }
  const snap = connectorsSnapshot();
  for (const name of ['openai', 'gemini', 'xai', 'kimi']) {
    const c = snap.connectors.find((x) => x.name === name);
    assert.ok(c, `missing connector ${name}`);
    assert.match(c.when, /optional side tool/i);
  }
  const bitdeer = snap.connectors.find((x) => x.name === 'bitdeer');
  assert.match(bitdeer.when, /BITDEER-PRIMARY|primaryModel/i);
});

test('server.js uses nvidia_only_providers and does not rebuild an OpenAI/xAI /v1 chain', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/lib\/nvidia_only_providers\.js'/);
  assert.match(src, /NVIDIA_CORS_HEADERS/);
  assert.equal(/if \(process\.env\.OPENAI_API_KEY\)/.test(src), false);
  assert.equal(/if \(process\.env\.XAI_API_KEY\)/.test(src), false);
  assert.equal(/req\.header\('x-openai-key'\)/.test(src), false);
  assert.equal(/new A2EProvider/.test(src), false);
  assert.equal(/new AnthropicProvider/.test(src), false);
});
