// test/test-streaming.mjs
// Regression: true token-level streaming, not simulated.
// The OpenAIProvider class is the repository's OpenAI-wire-format transport;
// Aion production binds that transport exclusively to NVIDIA NIM.

import assert from 'node:assert/strict';
import { AionChain } from '../lib/aion_chain.js';
import { AnthropicProvider, EchoProvider, OpenAIProvider } from '../lib/router.js';

let pass = 0;
let fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); pass++; },
    (e) => { console.log(`FAIL  ${name}  — ${e.message}`); fail++; }
  );
}

function makeSseBody(events) {
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function makeAnthropicBody(events) {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

class FakeReader {
  constructor(chunks) { this.chunks = chunks; this.i = 0; }
  async read() {
    if (this.i >= this.chunks.length) return { done: true, value: undefined };
    const value = this.chunks[this.i++];
    return { done: false, value: new TextEncoder().encode(value) };
  }
  releaseLock() {}
}

function fakeBody(chunks) {
  const reader = new FakeReader(chunks);
  return { getReader: () => reader };
}

function fakeFetchWithSse(body) {
  return async () => ({
    ok: true,
    status: 200,
    body: fakeBody([body]),
  });
}

await t('OpenAI-compatible transport yields deltas in order from SSE', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key', name: 'nvidia' });
  const body = makeSseBody([
    { id: '1', object: 'chat.completion.chunk', model: 'nvidia/test', choices: [{ delta: { content: 'Hello' }, index: 0 }] },
    { id: '2', object: 'chat.completion.chunk', model: 'nvidia/test', choices: [{ delta: { content: ' world' }, index: 0 }] },
    { id: '3', object: 'chat.completion.chunk', model: 'nvidia/test', choices: [{ delta: {}, index: 0 }] },
    { id: '4', object: 'chat.completion.chunk', model: 'nvidia/test', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    { model: 'nvidia/test', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
  ]);
  const events = [];
  for await (const ev of provider.streamChat({
    payload: { model: 'nvidia/test', messages: [{ role: 'user', content: 'hi' }] },
    fetchImpl: fakeFetchWithSse(body),
  })) events.push(ev);
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['Hello', ' world']);
  const done = events.find(e => e.type === 'done');
  assert.ok(done, 'has done');
  assert.equal(done.finish_reason, 'stop');
  assert.equal(done.model, 'nvidia/test');
  assert.equal(done.usage.completion_tokens, 2);
});

await t('OpenAI-compatible transport accumulates reasoning_content and tool_calls', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key', name: 'nvidia' });
  const body = makeSseBody([
    { choices: [{ delta: { reasoning_content: 'think ' }, index: 0 }] },
    { choices: [{ delta: { reasoning_content: 'more' }, index: 0 }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"t' } }] }, index: 0 }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ext":"hi"}' } }] }, index: 0 }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
  ]);
  const events = [];
  for await (const ev of provider.streamChat({
    payload: { model: 'nvidia/test', messages: [] },
    fetchImpl: fakeFetchWithSse(body),
  })) events.push(ev);
  assert.equal(events.filter(e => e.type === 'reasoning').map(e => e.text).join(''), 'think more');
  const done = events.find(e => e.type === 'done');
  assert.equal(done.finish_reason, 'tool_calls');
  assert.equal(done.tool_calls[0].function.name, 'echo');
  assert.equal(done.tool_calls[0].function.arguments, '{"text":"hi"}');
  assert.equal(done.reasoning_content, 'think more');
});

await t('OpenAI-compatible transport keeps partial line in buffer', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key', name: 'nvidia' });
  const fullBody = makeSseBody([
    { choices: [{ delta: { content: 'token-1' }, index: 0 }] },
    { choices: [{ delta: { content: 'token-2' }, index: 0 }] },
  ]);
  const half = Math.floor(fullBody.length / 2);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: fakeBody([fullBody.slice(0, half), fullBody.slice(half)]),
  });
  const deltas = [];
  for await (const ev of provider.streamChat({
    payload: { model: 'nvidia/test', messages: [] },
    fetchImpl,
  })) if (ev.type === 'delta') deltas.push(ev.text);
  assert.deepEqual(deltas, ['token-1', 'token-2']);
});

await t('OpenAI-compatible transport reports non-2xx response', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key', name: 'nvidia' });
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  let caught = null;
  try {
    for await (const _ev of provider.streamChat({
      payload: { model: 'nvidia/test', messages: [] },
      fetchImpl,
    })) { /* exhaust */ }
  } catch (e) { caught = e; }
  assert.ok(caught, 'threw');
  assert.equal(caught.status, 401);
  assert.equal(caught.code, 'http_401');
});

// Router-level Anthropic parsing remains regression-covered because Router is
// a reusable transport module, but AionChain.fromEnv never instantiates it.
await t('AnthropicProvider.streamChat parses message events', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test-ant-key' });
  const body = makeAnthropicBody([
    { event: 'message_start', data: { type: 'message_start', message: { model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  const events = [];
  for await (const ev of provider.streamChat({
    payload: { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
    fetchImpl: async () => ({ ok: true, status: 200, body: fakeBody([body]) }),
  })) events.push(ev);
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['Hi', ' there']);
  const done = events.find(e => e.type === 'done');
  assert.equal(done.finish_reason, 'end_turn');
  assert.equal(done.usage.input_tokens, 10);
  assert.equal(done.usage.output_tokens, 2);
});

await t('AnthropicProvider.streamChat reports non-2xx', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test-ant-key' });
  let caught = null;
  try {
    for await (const _ev of provider.streamChat({
      payload: { model: 'test', messages: [] },
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }),
    })) { /* exhaust */ }
  } catch (e) { caught = e; }
  assert.ok(caught, 'threw');
  assert.equal(caught.status, 401);
});

function parseSseStream(sseStrings) {
  const out = [];
  for (const s of sseStrings) {
    for (const line of s.split('\n')) {
      const match = line.match(/^data: (.+)$/);
      if (!match) continue;
      const data = match[1].trim();
      if (data === '[DONE]') continue;
      try { out.push(JSON.parse(data)); } catch { /* ignore non-JSON */ }
    }
  }
  return out;
}

await t('AionChain true-streams through an NVIDIA-named provider', async () => {
  const body = makeSseBody([
    { choices: [{ delta: { content: 'A' }, index: 0 }] },
    { choices: [{ delta: { content: 'B' }, index: 0 }] },
    { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
    { model: 'nvidia/nemotron-3-super-120b-a12b', choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  ]);
  const provider = new OpenAIProvider({ apiKey: 'test-key', name: 'nvidia' });
  provider.streamChat = ({ payload }) => new OpenAIProvider({
    apiKey: 'test-key',
    name: 'nvidia',
  }).streamChat({
    payload,
    fetchImpl: async () => ({ ok: true, status: 200, body: fakeBody([body]) }),
  });
  const chain = new AionChain({ providers: [provider], store: { record: () => {} } });
  const sseOut = [];
  for await (const ev of chain.stream({ messages: [{ role: 'user', content: 'x' }] })) sseOut.push(ev);
  const events = parseSseStream(sseOut);
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['A', 'B']);
  assert.equal(events.find(e => e.type === 'open')?.streaming, 'true');
  assert.equal(events.find(e => e.type === 'done')?.streaming, 'true');
});

await t('AionChain supports explicit hermetic EchoProvider injection', async () => {
  const echo = new EchoProvider({ name: 'echo' });
  const chain = new AionChain({ providers: [echo], store: { record: () => {} } });
  const sseOut = [];
  for await (const ev of chain.stream({ messages: [{ role: 'user', content: 'hi' }] })) sseOut.push(ev);
  const events = parseSseStream(sseOut);
  assert.equal(events.find(e => e.type === 'done')?.streaming, 'simulated');
});

if (process.env.SKIP_LIVE === '1' || !(process.env.NVIDIA_API_KEYS || process.env.NVIDIA_API_KEY)) {
  console.log('SKIP  live NVIDIA NIM stream (no NVIDIA key or SKIP_LIVE=1)');
} else {
  await t('AionChain.fromEnv against NVIDIA NIM emits streaming:true', async () => {
    const chain = AionChain.fromEnv();
    const sseOut = [];
    for await (const ev of chain.stream({
      messages: [{ role: 'user', content: 'Say only: OK' }],
      temperature: 0,
      maxTokens: 10,
    })) sseOut.push(ev);
    const events = parseSseStream(sseOut);
    const openEv = events.find(e => e.type === 'open');
    const done = events.find(e => e.type === 'done');
    assert.equal(openEv?.streaming, 'true', `open.streaming=${openEv?.streaming}`);
    assert.equal(done?.streaming, 'true', `done.streaming=${done?.streaming}`);
    assert.ok(done?.latency_ms > 0, 'latency recorded');
    assert.equal(done?.provider, 'nvidia');
  });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
