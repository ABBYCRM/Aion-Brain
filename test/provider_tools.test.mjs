// test/provider_tools.test.mjs
// Mocked fetch only. No live provider keys.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotSecrets, stripChatProviderEnv, loadedSecret, forgetSecretForTests,
  rememberSecretForTests, CHAT_STRIP_KEYS,
} from '../lib/secrets.js';
import {
  youtubeSearch, youtubeVideo, geminiChat, xaiChat, kimiChat,
  openaiChat, openaiEmbed, embeddingsEmbed,
  pineconeQuery, pineconeUpsert, hedraGenerate, hedraJob,
  composioListTools, composioToolSchema,
} from '../lib/provider_tools.js';
import { connectorsSnapshot } from '../lib/connectors.js';
import { ToolRegistry } from '../lib/brain_tools.js';
import { envSecret } from '../lib/external_tools.js';

const originalFetch = globalThis.fetch;

function clearProviderEnv() {
  for (const name of [
    'YOUTUBE_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'KIMI_API_KEY',
    'OPENAI_API_KEY', 'EMBEDDINGS_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX_HOST',
    'HEDRA_API_KEY', 'COMPOSIO_API_KEY',
  ]) {
    forgetSecretForTests(name);
  }
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderEnv();
});

test('loadedSecret recovers chat keys after nvidia_only strip', () => {
  process.env.XAI_API_KEY = 'xai-live-test-key-do-not-leak';
  snapshotSecrets(['XAI_API_KEY']);
  stripChatProviderEnv();
  assert.equal(process.env.XAI_API_KEY, undefined);
  assert.equal(loadedSecret('XAI_API_KEY'), 'xai-live-test-key-do-not-leak');
  assert.equal(envSecret('XAI_API_KEY'), 'xai-live-test-key-do-not-leak');
  assert.ok(CHAT_STRIP_KEYS.includes('XAI_API_KEY'));
});

test('provider tools fail soft when unconfigured and do not fetch', async () => {
  clearProviderEnv();
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error('must not call'); };
  const tools = [
    youtubeSearch({ query: 'osint' }),
    geminiChat({ prompt: 'hi' }),
    xaiChat({ prompt: 'hi' }),
    kimiChat({ prompt: 'hi' }),
    openaiChat({ prompt: 'hi' }),
    openaiEmbed({ input: 'hi' }),
    pineconeQuery({ query: 'trinity' }),
    hedraGenerate({ prompt: 'a cat' }),
    composioListTools({ toolkit: 'gmail' }),
  ];
  const results = await Promise.all(tools);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.match(r.error, /_unconfigured$/);
  }
  assert.equal(called, 0);
});

test('youtube_search and youtube_video parse official Data API shapes', async () => {
  rememberSecretForTests('YOUTUBE_API_KEY', 'yt-live-test-key');
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/search?')) {
      return Response.json({
        items: [{ id: { videoId: 'dQw4w9wgXcQ' }, snippet: { title: 'Never', channelTitle: 'Rick', description: 'astley', publishedAt: '2009-10-25T00:00:00Z' } }],
      });
    }
    return Response.json({
      items: [{
        id: 'dQw4w9wgXcQ',
        snippet: { title: 'Never', channelTitle: 'Rick', description: 'astley' },
        statistics: { viewCount: '1' },
        contentDetails: { duration: 'PT3M33S' },
      }],
    });
  };
  const search = await youtubeSearch({ query: 'never gonna', count: 3 });
  assert.equal(search.ok, true);
  assert.equal(search.evidence.results[0].videoId, 'dQw4w9wgXcQ');
  assert.match(calls[0], /youtube\/v3\/search/);
  assert.equal(JSON.stringify(search).includes('yt-live-test-key'), false);

  const video = await youtubeVideo({ url: 'https://youtu.be/dQw4w9wgXcQ' });
  assert.equal(video.ok, true);
  assert.equal(video.evidence.duration, 'PT3M33S');
});

test('gemini / xai / kimi / openai chat use loaded keys and return text', async () => {
  rememberSecretForTests('GEMINI_API_KEY', 'gem-live-test-key');
  rememberSecretForTests('XAI_API_KEY', 'xai-live-test-key');
  rememberSecretForTests('KIMI_API_KEY', 'kimi-live-test-key');
  rememberSecretForTests('OPENAI_API_KEY', 'sk-live-test-key');
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init.body);
    if (u.includes('generativelanguage.googleapis.com')) {
      assert.ok(u.includes('key=gem-live-test-key'));
      return Response.json({ candidates: [{ content: { parts: [{ text: 'gemini-ok' }] } }] });
    }
    if (u.includes('api.x.ai')) {
      assert.equal(init.headers.authorization, 'Bearer xai-live-test-key');
      assert.equal(body.model, 'grok-4');
      return Response.json({ choices: [{ message: { content: 'xai-ok' } }] });
    }
    if (u.includes('api.moonshot.ai')) {
      assert.equal(init.headers.authorization, 'Bearer kimi-live-test-key');
      return Response.json({ choices: [{ message: { content: 'kimi-ok' } }] });
    }
    if (u.includes('api.openai.com/v1/chat')) {
      return Response.json({ choices: [{ message: { content: 'openai-ok' } }] });
    }
    if (u.includes('/embeddings')) {
      return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], model: 'text-embedding-3-small' });
    }
    return new Response('missing', { status: 404 });
  };
  assert.equal((await geminiChat({ prompt: 'hi' })).evidence.text, 'gemini-ok');
  assert.equal((await xaiChat({ prompt: 'hi' })).evidence.text, 'xai-ok');
  assert.equal((await kimiChat({ prompt: 'hi' })).evidence.text, 'kimi-ok');
  assert.equal((await openaiChat({ prompt: 'hi' })).evidence.text, 'openai-ok');
  const emb = await openaiEmbed({ input: 'hi' });
  assert.equal(emb.ok, true);
  assert.equal(emb.evidence.dimensions, 3);
  const dumped = JSON.stringify(await geminiChat({ prompt: 'again' }));
  assert.equal(dumped.includes('gem-live-test-key'), false);
});

test('pinecone query/upsert and hedra generate/job are real HTTP', async () => {
  rememberSecretForTests('PINECONE_API_KEY', 'pc-live-test-key');
  process.env.PINECONE_INDEX_HOST = 'example-index.svc.pinecone.io';
  rememberSecretForTests('HEDRA_API_KEY', 'hd-live-test-key');
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/query')) {
      assert.equal(init.headers['Api-Key'], 'pc-live-test-key');
      return Response.json({ matches: [{ id: 'c1', score: 0.9, metadata: { text: 'Trinity GO', source_id: 'canon' } }] });
    }
    if (u.includes('/vectors/upsert')) {
      return Response.json({ upsertedCount: 1 });
    }
    if (u.includes('/v3/models/gpt-image-2') && init.method === 'POST') {
      assert.equal(init.headers.authorization, 'Key hd-live-test-key');
      return Response.json({ job_id: 'job_abc', status: 'accepted' }, { status: 202 });
    }
    if (u.includes('/v3/jobs/job_abc')) {
      return Response.json({ id: 'job_abc', status: 'COMPLETED', outputs: [{ url: 'https://cdn.example/out.png' }] });
    }
    return new Response('missing', { status: 404 });
  };
  const q = await pineconeQuery({ query: 'Trinity' });
  assert.equal(q.ok, true);
  assert.equal(q.evidence.matches[0].text, 'Trinity GO');
  const up = await pineconeUpsert({ id: 'm1', text: 'operator note Trinity' });
  assert.equal(up.ok, true);
  const gen = await hedraGenerate({ prompt: 'a space cat' });
  assert.equal(gen.ok, true);
  assert.equal(gen.evidence.job_id, 'job_abc');
  const job = await hedraJob({ jobId: 'job_abc' });
  assert.equal(job.ok, true);
  assert.equal(job.evidence.status, 'COMPLETED');
});

test('composio_list_tools and composio_tool_schema are ak_ live catalog', async () => {
  rememberSecretForTests('COMPOSIO_API_KEY', 'ak_live_test_project');
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/v2/actions/GMAIL_SEND_EMAIL')) {
      return Response.json({ name: 'GMAIL_SEND_EMAIL', description: 'Send email', parameters: { type: 'object' } });
    }
    if (u.includes('/api/v2/actions')) {
      return Response.json({ items: [{ name: 'GMAIL_SEND_EMAIL', appName: 'gmail', description: 'Send email' }] });
    }
    return new Response('missing', { status: 404 });
  };
  const list = await composioListTools({ toolkit: 'gmail', search: 'send' });
  assert.equal(list.ok, true);
  assert.equal(list.evidence.tools[0].slug, 'GMAIL_SEND_EMAIL');
  const schema = await composioToolSchema({ slug: 'GMAIL_SEND_EMAIL' });
  assert.equal(schema.ok, true);
  assert.equal(schema.evidence.slug, 'GMAIL_SEND_EMAIL');
});

test('ToolRegistry catalogs new providers and keeps cursor_*', async () => {
  const tools = new ToolRegistry();
  const names = tools.catalog().map((t) => t.name);
  for (const n of [
    'cursor_launch', 'cursor_status', 'cursor_reply', 'cursor_cancel',
    'youtube_search', 'youtube_video', 'gemini_chat', 'xai_chat', 'kimi_chat',
    'openai_chat', 'openai_embed', 'embeddings_embed',
    'pinecone_query', 'pinecone_upsert',
    'hedra_status', 'hedra_generate', 'hedra_job',
    'composio_health', 'composio_list_tools', 'composio_tool_schema', 'composio_action',
  ]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const yt = tools.catalog().find((t) => t.name === 'youtube_search');
  assert.match(yt.description, /when/i);
  const unconfigured = await tools.run('gemini_chat', { prompt: 'hi' });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.error, 'gemini_chat_unconfigured');
});

test('connectorsSnapshot lists new providers with when, never secret values', () => {
  rememberSecretForTests('GEMINI_API_KEY', 'gem-super-secret-do-not-leak');
  rememberSecretForTests('YOUTUBE_API_KEY', 'yt-super-secret-do-not-leak');
  const snap = connectorsSnapshot();
  const blob = JSON.stringify(snap);
  assert.equal(blob.includes('gem-super-secret'), false);
  assert.equal(blob.includes('yt-super-secret'), false);
  for (const name of ['youtube', 'gemini', 'xai', 'kimi', 'openai', 'embeddings', 'pinecone', 'hedra', 'composio', 'cursor']) {
    const c = snap.connectors.find((x) => x.name === name);
    assert.ok(c, `missing connector ${name}`);
    assert.equal(typeof c.when, 'string');
    assert.ok(c.when.length > 10);
  }
  assert.equal(snap.connectors.find((c) => c.name === 'gemini').configured, true);
  assert.equal(snap.connectors.find((c) => c.name === 'youtube').configured, true);
});
