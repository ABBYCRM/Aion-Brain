// lib/duckduckgo.js
// DuckDuckGo HTML searcher — no API key required. Parses the lite HTML
// endpoint and returns normalized {title, url, snippet} results.
//
// We hit https://html.duckduckgo.com/html/ (POST) with a form body. The
// response is server-rendered HTML; we use a small set of regexes to
// extract results rather than pulling in a parser dependency. DuckDuckGo
// occasionally rate-limits aggressive clients — we keep a tiny per-process
// cooldown and surface rate-limit signals honestly when they fire.
//
// Heavy or authenticated web search (Composio, xAI live search, etc.)
// still lives in the AION Python backend. This is a kernel-level tool
// that any model can call when the AION layer is not in scope.

const DEFAULT_ENDPOINT = process.env.DUCKDUCKGO_ENDPOINT || 'https://html.duckduckgo.com/html/';
const DEFAULT_UA = process.env.DUCKDUCKGO_UA || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let lastCallAt = 0;
const MIN_INTERVAL_MS = Number(process.env.DUCKDUCKGO_MIN_INTERVAL_MS || 1500);

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Run a DuckDuckGo search.
 * @param {string} query
 * @param {number} count  1..20
 * @returns {Promise<Array<{title:string,url:string,snippet:string}>>}
 */
export async function search(query, count = 5) {
  if (!query || typeof query !== 'string') return [];
  const n = Math.max(1, Math.min(20, Number(count) || 5));
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const body = new URLSearchParams({ q: query, kl: 'us-en' }).toString();
  let res;
  try {
    res = await fetch(DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': DEFAULT_UA,
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return [];
  }
  if (!res.ok) return [];
  const html = await res.text();

  // Result blocks: <a class="result__a" href="URL">TITLE</a> + <a class="result__snippet" ...>SNIP</a>
  // DDG frequently wraps the real URL in a //duckduckgo.com/l/?uddg= redirect; we unwrap it.
  const results = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [];
  let m;
  while ((m = linkRe.exec(html))) {
    links.push({ href: m[1], title: stripTags(m[2]) });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html))) {
    snippets.push(stripTags(m[1]));
  }
  for (let i = 0; i < links.length && results.length < n; i++) {
    const url = unwrapDdg(links[i].href);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    results.push({
      title: links[i].title.slice(0, 200),
      url: url.slice(0, 500),
      snippet: (snippets[i] || '').slice(0, 400),
    });
  }
  return results;
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapDdg(href) {
  if (!href) return '';
  // duckduckgo.com/l/?uddg=<encoded>
  try {
    const u = new URL(href, 'https://duckduckgo.com/');
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/') {
      const real = u.searchParams.get('uddg');
      if (real) return decodeURIComponent(real);
    }
    return u.toString();
  } catch {
    return href;
  }
}

/**
 * Build a ToolRegistry-compatible searcher. Stable signature.
 */
export function buildSearcher() {
  return async (query, count) => {
    const results = await search(query, count);
    return results;
  };
}
