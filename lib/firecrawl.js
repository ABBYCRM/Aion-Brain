// lib/firecrawl.js
// Firecrawl v2 scrape + scrape-bound Interact client.
// Uses the documented lifecycle: scrape -> interact (prompt/code) -> stop.

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';
const DEFAULT_TIMEOUT_MS = 45_000;

export class FirecrawlClient {
  constructor({ apiKey = '', baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  _headers() {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async scrape(url, { formats = ['markdown'], profile = undefined } = {}) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('firecrawl_invalid_url');
    if (!Array.isArray(formats) || formats.length === 0 || !formats.every(x => typeof x === 'string' && x)) {
      throw new Error('firecrawl_invalid_formats');
    }
    const body = { url: parsed.toString(), formats };
    if (profile !== undefined) body.profile = profile;
    const payload = await this._request('/v2/scrape', { method: 'POST', body });
    const scrapeId = payload?.data?.metadata?.scrapeId || payload?.data?.metadata?.scrape_id;
    return { ...payload, scrapeId: scrapeId || null };
  }

  async interact(scrapeId, { prompt, code, language = 'node', timeout = 30, origin } = {}) {
    this._assertScrapeId(scrapeId);
    const hasPrompt = typeof prompt === 'string' && prompt.trim().length > 0;
    const hasCode = typeof code === 'string' && code.trim().length > 0;
    if (hasPrompt === hasCode) throw new Error('firecrawl_prompt_or_code_required');
    if (hasPrompt && prompt.length > 10_000) throw new Error('firecrawl_prompt_too_long');
    if (hasCode && code.length > 100_000) throw new Error('firecrawl_code_too_long');
    if (!['node', 'python', 'bash'].includes(language)) throw new Error('firecrawl_invalid_language');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) throw new Error('firecrawl_invalid_timeout');

    const body = hasPrompt ? { prompt } : { code, language, timeout };
    if (origin) body.origin = String(origin).slice(0, 200);
    return this._request(`/v2/scrape/${encodeURIComponent(scrapeId)}/interact`, {
      method: 'POST',
      body,
      timeoutMs: (timeout + 10) * 1000,
    });
  }

  async stop(scrapeId) {
    this._assertScrapeId(scrapeId);
    return this._request(`/v2/scrape/${encodeURIComponent(scrapeId)}/interact`, { method: 'DELETE' });
  }

  _assertScrapeId(scrapeId) {
    if (typeof scrapeId !== 'string' || !/^[A-Za-z0-9_-]{6,200}$/.test(scrapeId)) {
      throw new Error('firecrawl_invalid_scrape_id');
    }
  }

  async _request(path, { method, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this._headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error || payload?.message || `firecrawl_http_${response.status}`;
      throw new Error(String(message));
    }
    return payload;
  }
}

export function createFirecrawlClient(opts) {
  return new FirecrawlClient(opts);
}
