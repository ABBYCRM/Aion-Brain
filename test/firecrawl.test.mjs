import test from 'node:test';
import assert from 'node:assert/strict';

import { FirecrawlClient } from '../lib/firecrawl.js';
import { ToolRegistry } from '../lib/tools.js';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('FirecrawlClient runs scrape -> interact -> stop with documented v2 endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/v2/scrape')) {
      return response({ success: true, data: { metadata: { scrapeId: 'scrape_abc123' }, markdown: '# Example' } });
    }
    if (init.method === 'POST' && url.endsWith('/v2/scrape/scrape_abc123/interact')) {
      return response({ success: true, output: 'clicked', exitCode: 0, killed: false });
    }
    if (init.method === 'DELETE' && url.endsWith('/v2/scrape/scrape_abc123/interact')) {
      return response({ success: true });
    }
    return response({ error: 'unexpected' }, 500);
  };

  const client = new FirecrawlClient({ apiKey: 'test-key', fetchImpl });
  const scraped = await client.scrape('https://example.com', { formats: ['markdown'] });
  assert.equal(scraped.scrapeId, 'scrape_abc123');

  const interacted = await client.interact(scraped.scrapeId, { prompt: 'Click the first result' });
  assert.equal(interacted.output, 'clicked');

  const stopped = await client.stop(scraped.scrapeId);
  assert.equal(stopped.success, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
  assert.equal(JSON.parse(calls[1].init.body).prompt, 'Click the first result');
  assert.equal(calls[2].init.method, 'DELETE');
});

test('FirecrawlClient validates mutually exclusive prompt/code and timeouts', async () => {
  const client = new FirecrawlClient({ fetchImpl: async () => response({ success: true }) });
  await assert.rejects(() => client.interact('scrape_abc123', {}), /prompt_or_code_required/);
  await assert.rejects(
    () => client.interact('scrape_abc123', { prompt: 'x', code: 'return 1' }),
    /prompt_or_code_required/
  );
  await assert.rejects(
    () => client.interact('scrape_abc123', { code: 'return 1', timeout: 301 }),
    /invalid_timeout/
  );
});

test('ToolRegistry exposes Firecrawl tools and returns structured tool results', async () => {
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/v2/scrape')) {
      return response({ success: true, data: { metadata: { scrapeId: 'scrape_tool123' } } });
    }
    if (url.includes('/interact') && init.method === 'DELETE') return response({ success: true });
    return response({ success: true, output: 'done', exitCode: 0 });
  };
  const registry = new ToolRegistry({ fetchImpl });
  assert.ok(registry.list().some(tool => tool.name === 'firecrawl_scrape'));
  assert.ok(registry.list().some(tool => tool.name === 'firecrawl_interact'));
  assert.ok(registry.list().some(tool => tool.name === 'firecrawl_stop'));

  const scrape = await registry.run('firecrawl_scrape', { url: 'https://example.com' });
  assert.equal(scrape.ok, true);
  assert.equal(scrape.result.scrapeId, 'scrape_tool123');

  const interact = await registry.run('firecrawl_interact', {
    scrapeId: 'scrape_tool123', prompt: 'Extract the title',
  });
  assert.equal(interact.ok, true);
  assert.equal(interact.result.output, 'done');

  const stop = await registry.run('firecrawl_stop', { scrapeId: 'scrape_tool123' });
  assert.equal(stop.ok, true);
});
