// test/external_tools.test.mjs
// Mocked fetch only. No real GDY keys and no live network in these tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configuredSecrets, gdyConfigured, gdyApiBase,
  gdySearch, gdyRagContext, gdyCategories, gdyTools,
  arxivSearch, parseArxivAtom,
} from '../lib/external_tools.js';
import { ToolRegistry } from '../lib/brain_tools.js';

const originalFetch = globalThis.fetch;
const saved = { ...process.env };

function restoreEnv() {
  for (const key of ['GDY_API_KEY', 'GDY_API_KEY_ALT', 'GDY_API_BASE', 'GDY_BASE_URL', 'ARXIV_API_BASE']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>A Test Paper on Retrieval</title>
    <summary>An abstract about RAG and OSINT tools.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link href="http://arxiv.org/abs/2401.00001v1" rel="alternate" type="text/html"/>
    <published>2024-01-01T00:00:00Z</published>
  </entry>
</feed>`;

test('configuredSecrets reports GDY as a boolean and never the key', () => {
  delete process.env.GDY_API_KEY;
  delete process.env.GDY_API_KEY_ALT;
  const empty = configuredSecrets();
  assert.equal(empty.GDY, false);
  assert.equal(empty.GDY_API_KEY, false);
  assert.equal(gdyConfigured(), false);

  process.env.GDY_API_KEY = 'gdy_live_test_primary_value';
  const on = configuredSecrets();
  assert.equal(on.GDY, true);
  assert.equal(on.GDY_API_KEY, true);
  const dumped = JSON.stringify(on);
  assert.equal(dumped.includes('gdy_live_test_primary_value'), false);
  assert.ok(!Object.values(on).some((v) => typeof v === 'string' && v.includes('gdy_live')));
});

test('gdyApiBase prefers GDY_API_BASE then GDY_BASE_URL+/v1', () => {
  delete process.env.GDY_API_BASE;
  delete process.env.GDY_BASE_URL;
  assert.equal(gdyApiBase(), 'https://gdy-tool-directory-a6hzh.ondigitalocean.app/v1');
  process.env.GDY_BASE_URL = 'https://example.test';
  assert.equal(gdyApiBase(), 'https://example.test/v1');
  process.env.GDY_API_BASE = 'https://example.test/v1';
  assert.equal(gdyApiBase(), 'https://example.test/v1');
});

test('gdy_search fails soft when unconfigured and does not fetch', async () => {
  delete process.env.GDY_API_KEY;
  delete process.env.GDY_API_KEY_ALT;
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error('must not call'); };
  const result = await gdySearch({ query: 'osint' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'gdy_search_unconfigured');
  assert.equal(result.env, 'GDY_API_KEY');
  assert.equal(called, 0);
});

test('gdy_search returns structured evidence and never echoes the bearer', async () => {
  process.env.GDY_API_KEY = 'gdy_live_test_primary_value';
  process.env.GDY_API_BASE = 'https://gdy.test/v1';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), auth: options.headers.authorization });
    assert.equal(options.headers.authorization, 'Bearer gdy_live_test_primary_value');
    assert.ok(options.signal);
    return Response.json({
      query: 'shodan',
      total: 1,
      data: [{ id: 't1', name: 'Shodan', url: 'https://www.shodan.io', categoryId: 'recon', categoryLabel: 'Recon', hostname: 'www.shodan.io', apiKey: 'should-not-leak' }],
    });
  };
  const result = await gdySearch({ query: 'shodan', limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'gdy_search');
  assert.equal(result.evidence.total, 1);
  assert.equal(result.evidence.tools[0].name, 'Shodan');
  assert.equal(result.evidence.tools[0].apiKey, undefined);
  assert.match(calls[0].url, /https:\/\/gdy\.test\/v1\/search\?/);
  assert.match(calls[0].url, /q=shodan/);
  const dumped = JSON.stringify(result);
  assert.equal(dumped.includes('gdy_live_test_primary_value'), false);
  assert.equal(dumped.includes('should-not-leak'), false);
});

test('gdy_search retries once with GDY_API_KEY_ALT on 401', async () => {
  process.env.GDY_API_KEY = 'gdy_live_test_primary_value';
  process.env.GDY_API_KEY_ALT = 'gdy_live_test_alt_value';
  const auths = [];
  globalThis.fetch = async (_url, options) => {
    auths.push(options.headers.authorization);
    if (auths.length === 1) return new Response('nope', { status: 401 });
    return Response.json({ query: 'osint', total: 0, data: [] });
  };
  const result = await gdySearch({ query: 'osint' });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.used_alt, true);
  assert.deepEqual(auths, ['Bearer gdy_live_test_primary_value', 'Bearer gdy_live_test_alt_value']);
  assert.equal(JSON.stringify(result).includes('gdy_live_test'), false);
});

test('gdy_rag_context / gdy_categories / gdy_tools parse structured evidence', async () => {
  process.env.GDY_API_KEY = 'gdy_live_test_primary_value';
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/rag/context')) return new Response('# GDY context\n- Shodan', { headers: { 'content-type': 'text/markdown' } });
    if (path.includes('/categories')) return Response.json({ data: [{ id: 'recon', label: 'Recon', count: 12 }] });
    if (path.includes('/tools')) return Response.json({ data: [{ id: 't1', name: 'Shodan', url: 'https://www.shodan.io' }] });
    return new Response('missing', { status: 404 });
  };
  const rag = await gdyRagContext({ query: 'shodan' });
  assert.equal(rag.ok, true);
  assert.match(rag.evidence.markdown, /Shodan/);
  const cats = await gdyCategories();
  assert.equal(cats.ok, true);
  assert.equal(cats.evidence.categories[0].id, 'recon');
  const tools = await gdyTools({ q: 'shodan', category: 'recon', page: 1 });
  assert.equal(tools.ok, true);
  assert.equal(tools.evidence.tools[0].name, 'Shodan');
});

test('arxiv_search works without a GDY key and parses Atom fields', async () => {
  delete process.env.GDY_API_KEY;
  delete process.env.GDY_API_KEY_ALT;
  assert.equal(gdyConfigured(), false);
  let seen = '';
  globalThis.fetch = async (url, options) => {
    seen = String(url);
    assert.ok(options.signal);
    assert.match(seen, /export\.arxiv\.org\/api\/query/);
    assert.match(seen, /search_query=all/);
    assert.match(seen, /max_results=3/);
    return new Response(SAMPLE_ATOM, { headers: { 'content-type': 'application/atom+xml' } });
  };
  const result = await arxivSearch({ query: 'retrieval augmented generation', max_results: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'arxiv_search');
  assert.equal(result.evidence.count, 1);
  assert.equal(result.evidence.papers[0].title, 'A Test Paper on Retrieval');
  assert.equal(result.evidence.papers[0].id, 'http://arxiv.org/abs/2401.00001v1');
  assert.deepEqual(result.evidence.papers[0].authors, ['Ada Lovelace', 'Alan Turing']);
  assert.match(result.evidence.papers[0].summary, /RAG/);
  assert.equal(result.evidence.papers[0].link, 'http://arxiv.org/abs/2401.00001v1');
});

test('parseArxivAtom is used by the search helper', () => {
  const papers = parseArxivAtom(SAMPLE_ATOM, 5);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].published, '2024-01-01T00:00:00Z');
});

test('arxiv_search fails soft on timeout/network', async () => {
  globalThis.fetch = async () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    throw err;
  };
  const result = await arxivSearch({ query: 'transformers' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'arxiv_timeout');
});

test('ToolRegistry lists and executes GDY/arXiv (fail-soft, mocked)', async () => {
  delete process.env.GDY_API_KEY;
  const tools = new ToolRegistry();
  const names = tools.catalog().map((t) => t.name);
  for (const n of ['gdy_search', 'gdy_rag_context', 'gdy_categories', 'gdy_tools', 'arxiv_search']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const unconfigured = await tools.run('gdy_search', { query: 'osint' });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.error, 'gdy_search_unconfigured');

  globalThis.fetch = async () => new Response(SAMPLE_ATOM, { headers: { 'content-type': 'application/atom+xml' } });
  const papers = await tools.run('arxiv_search', { query: 'osint', max_results: 1 });
  assert.equal(papers.ok, true);
  assert.equal(papers.evidence.papers[0].title, 'A Test Paper on Retrieval');
});
