// lib/research.js
// Default research function for the BOS-OMEGA Brain.
// Uses DuckDuckGo's public HTML endpoint (no API key required).
// Returns: [{ title, url, snippet }, ...]  (max 5 hits)
//
// NOT the official DDG Instant Answer API.
// NOT a headless browser.
// Fragile if DDG changes their HTML class names (result__a / result__snippet).
// Production can swap in Brave / Tavily / Exa via `new Brain({ researchFn })`.

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_HITS = 5;
const MAX_QUERY_LEN = 200;
// Some DDG endpoints throttle or serve an anomaly challenge to non-browser UAs.
// A modern Chrome UA + a referrer dramatically reduces the chance of being
// classified as a bot. Production deployments can override via env or researchFn.
const USER_AGENT = process.env.DDG_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Default research function. Fetches DDG HTML and parses organic results.
 * Never throws — returns a structured list, even on failure.
 * @param {string} query
 * @param {{ timeout?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function defaultResearch(query, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const q = encodeURIComponent(String(query || '').slice(0, MAX_QUERY_LEN));
  const url = `https://html.duckduckgo.com/html/?q=${q}`;

  let text;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
        ? AbortSignal.timeout(timeout)
        : undefined,
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'referer': 'https://duckduckgo.com/',
      },
    });
    if (!res.ok) {
      return [{ title: 'research_error', url: '', snippet: `ddg http ${res.status}` }];
    }
    text = await res.text();
  } catch (e) {
    return [{ title: 'research_error', url: '', snippet: String(e?.message || e) }];
  }

  const hits = parseDdgHtml(text);
  if (hits.length === 0) {
    return [{ title: 'no_results', url: '', snippet: 'ddg returned no organic results' }];
  }
  return hits.slice(0, MAX_HITS);
}

/**
 * Parse DuckDuckGo's HTML result page. Returns up to MAX_HITS organic results.
 * Each result: { title, url (unwrapped), snippet }
 */
export function parseDdgHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return [];

  // DuckDuckGo HTML: <a class="result__a" href="...">Title</a>
  // followed (later in the block) by <a class="result__snippet" ...>snippet</a> or
  // <div class="result__snippet">snippet</div>.
  // We use a single regex that captures: href, title, optional snippet.
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|<div\s+class="result\s|result--no-result|$)/gi;

  const out = [];
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const rawUrl = m[1] || '';
    const rawTitle = m[2] || '';
    const tail = m[3] || '';

    // Snippet is the first occurrence of class="result__snippet" inside tail
    const snipM = tail.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    const rawSnippet = snipM ? snipM[1] : '';

    const finalUrl = unwrapDdgUrl(rawUrl);
    if (!finalUrl) continue;

    out.push({
      title: stripHtml(rawTitle).slice(0, 240),
      url: finalUrl,
      snippet: stripHtml(rawSnippet).slice(0, 400),
    });
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

/**
 * DuckDuckGo wraps real URLs in a redirect: /l/?uddg=<encoded>
 * Unwrap to the real destination.
 */
export function unwrapDdgUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl, 'https://duckduckgo.com');
    if (u.searchParams.has('uddg')) {
      try { return decodeURIComponent(u.searchParams.get('uddg')); }
      catch { return u.searchParams.get('uddg') || ''; }
    }
    // Already a direct link
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    return '';
  } catch {
    return '';
  }
}

/**
 * Strip HTML tags + decode common entities + collapse whitespace.
 */
export function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

export const RESEARCH_META = {
  provider: 'duckduckgo-html',
  endpoint: 'https://html.duckduckgo.com/html/',
  max_query_len: MAX_QUERY_LEN,
  max_hits: MAX_HITS,
  default_timeout_ms: DEFAULT_TIMEOUT_MS,
  requires_api_key: false,
};
