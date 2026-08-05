// test/test-research.mjs
// Tests the default research function (DuckDuckGo HTML).
// - Pure parser test runs offline (no network).
// - Live test hits DDG; skipped if SKIP_LIVE=1 or no network.

import { defaultResearch, parseDdgHtml, unwrapDdgUrl, stripHtml, RESEARCH_META } from '../lib/research.js';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); pass++; },
    (e) => { console.log(`FAIL  ${name}  — ${e.message}`); fail++; }
  );
}

const SAMPLE_HTML = `
<html><body>
<div class="result">
  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexpressjs.com%2Fen%2Fguide%2Ferror-handling.html&rut=abc">Express error handling</a>
  <a class="result__snippet" href="#">Use try/catch around async route handlers, or wrap with asyncHandler middleware.</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/path?q=1">Plain &amp; direct link</a>
  <div class="result__snippet">Snippet with <b>bold</b> &amp; entities.</div>
</div>
<div class="result">
  <a class="result__a" href="/l/?uddg=https%3A%2F%2Fstackoverflow.com%2Fquestions%2F123">SO question</a>
  <a class="result__snippet">Follow-up snippet here.</a>
</div>
<div class="result results_links results_links_deep">
  <a class="result__a" href="https://github.com/nodejs/node">Node.js on GitHub</a>
  <a class="result__snippet" href="#">Official Node.js repository with issue tracker.</a>
</div>
</body></html>
`;

const SAMPLE_HTML_NO_RESULTS = `
<html><body>
<div class="result--no-result">No results found for that query.</div>
</body></html>
`;

await t('RESEARCH_META exposes provider info', () => {
  assert.equal(RESEARCH_META.provider, 'duckduckgo-html');
  assert.equal(RESEARCH_META.requires_api_key, false);
  assert.ok(RESEARCH_META.max_hits > 0);
});

await t('stripHtml decodes entities + collapses whitespace', () => {
  assert.equal(stripHtml('<b>hi</b> &amp; <i>bye</i>'), 'hi & bye');
  assert.equal(stripHtml('  a  b  c  '), 'a b c');
  assert.equal(stripHtml('&lt;tag&gt;'), '<tag>');
  assert.equal(stripHtml(''), '');
  assert.equal(stripHtml(null), '');
});

await t('unwrapDdgUrl unwraps uddg redirect', () => {
  const u = unwrapDdgUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexpressjs.com%2Fguide');
  assert.equal(u, 'https://expressjs.com/guide');
});

await t('unwrapDdgUrl passes through direct https', () => {
  const u = unwrapDdgUrl('https://example.com/page');
  assert.equal(u, 'https://example.com/page');
});

await t('unwrapDdgUrl returns "" for empty or javascript:', () => {
  assert.equal(unwrapDdgUrl(''), '');
  assert.equal(unwrapDdgUrl('javascript:alert(1)'), '');
});

await t('parseDdgHtml extracts organic results with unwrapped URLs', () => {
  const hits = parseDdgHtml(SAMPLE_HTML);
  assert.equal(hits.length, 4, 'expected 4 results');
  assert.equal(hits[0].url, 'https://expressjs.com/en/guide/error-handling.html');
  assert.match(hits[0].title, /Express error handling/);
  assert.match(hits[0].snippet, /try\/catch|asyncHandler/);
  assert.equal(hits[1].url, 'https://example.com/path?q=1');
  assert.match(hits[1].title, /Plain & direct link/);
  assert.match(hits[1].snippet, /Snippet with bold & entities/);
});

await t('parseDdgHtml caps at MAX_HITS', () => {
  const html = SAMPLE_HTML.repeat(3);
  const hits = parseDdgHtml(html);
  assert.ok(hits.length <= RESEARCH_META.max_hits, `got ${hits.length}, cap ${RESEARCH_META.max_hits}`);
});

await t('parseDdgHtml returns [] for empty/no-results', () => {
  assert.deepEqual(parseDdgHtml(''), []);
  assert.deepEqual(parseDdgHtml(SAMPLE_HTML_NO_RESULTS), []);
});

if (process.env.SKIP_LIVE === '1') {
  console.log('SKIP  live DDG test (SKIP_LIVE=1)');
} else {
  await t('defaultResearch hits real DDG (real or honest-empty)', async () => {
    // The DDG HTML endpoint is rate-limited and sometimes returns an anomaly
    // challenge. This test accepts any honest response: real results, no_results,
    // or research_error. It must NEVER throw.
    const hits = await defaultResearch('express error handling best practices', { timeout: 10_000 });
    assert.ok(Array.isArray(hits), 'hits is array');
    assert.ok(hits.length > 0, 'at least one hit');
    assert.ok(typeof hits[0].title === 'string', 'title is string');
    if (hits[0].url) {
      assert.ok(hits[0].url.startsWith('http'), `url looks like real URL: ${hits[0].url}`);
    }
    const isHonest = ['no_results', 'research_error'].includes(hits[0].title) || hits[0].url.startsWith('http');
    assert.ok(isHonest, 'response is honest (real url or known-empty marker)');
    console.log(`  → first hit: ${hits[0].title} ${hits[0].url ? '@ ' + hits[0].url : '(no url)'}`);
  }, 15_000);
}

await t('defaultResearch returns research_error on network failure (not throw)', async () => {
  const brokenFetch = async () => { throw new Error('ECONNREFUSED'); };
  const hits = await defaultResearch('anything', { fetchImpl: brokenFetch, timeout: 1000 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'research_error');
  assert.match(hits[0].snippet, /ECONNREFUSED/);
});

await t('defaultResearch caps query at 200 chars', async () => {
  const longQuery = 'x'.repeat(500);
  const brokenFetch = async (url) => {
    // Verify the URL has a q param of length <= 200*3 = 600 chars after encoding
    const u = new URL(url);
    const q = decodeURIComponent(u.searchParams.get('q') || '');
    assert.ok(q.length <= 200, `query length ${q.length} > 200`);
    return { ok: false, status: 500, text: async () => '' };
  };
  await defaultResearch(longQuery, { fetchImpl: brokenFetch, timeout: 1000 });
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
