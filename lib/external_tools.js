// lib/external_tools.js
// Real HTTP adapters for operator-configured keys. Secrets are read from
// process.env only — never committed, never logged. Missing or wrong-type
// keys fail soft with a structured error (no fabricated success).

import { createHmac } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 20_000;

export const TOOL_ENV = Object.freeze({
  STEEL_API_KEY: 'STEEL_API_KEY',
  FIRECRAWL_API_KEY: 'FIRECRAWL_API_KEY',
  SCRAPINGBEE_API_KEY: 'SCRAPINGBEE_API_KEY',
  SCRAPFLY_API_KEY: 'SCRAPFLY_API_KEY',
  SCREENSHOTONE_ACCESS_KEY: 'SCREENSHOTONE_ACCESS_KEY',
  SCREENSHOTONE_SECRET_KEY: 'SCREENSHOTONE_SECRET_KEY',
  COMPOSIO_API_KEY: 'COMPOSIO_API_KEY',
  EXA_API_KEY: 'EXA_API_KEY',
  TAVILY_API_KEY: 'TAVILY_API_KEY',
  HELICONE_API_KEY: 'HELICONE_API_KEY',
  E2B_API_KEY: 'E2B_API_KEY',
  HEDRA_API_KEY: 'HEDRA_API_KEY',
  RESEND_API_KEY: 'RESEND_API_KEY',
  GITHUB_PERSONAL_ACCESS_TOKEN: 'GITHUB_PERSONAL_ACCESS_TOKEN',
  NVIDIA_API_KEY: 'NVIDIA_API_KEY',
  GDY_API_KEY: 'GDY_API_KEY',
  GDY_API_KEY_ALT: 'GDY_API_KEY_ALT',
});

const DEFAULT_GDY_ORIGIN = 'https://gdy-tool-directory-a6hzh.ondigitalocean.app';
const DEFAULT_ARXIV_ENDPOINT = 'http://export.arxiv.org/api/query';

export function envSecret(name) {
  const v = process.env[name];
  if (v == null) return '';
  return String(v).trim();
}

export function configuredSecrets() {
  const out = {};
  for (const name of Object.values(TOOL_ENV)) {
    out[name] = Boolean(envSecret(name));
  }
  // NVIDIA_* extras already used by the chain (pool, base URL).
  out.NVIDIA_API_KEYS = Boolean(envSecret('NVIDIA_API_KEYS'));
  out.NVIDIA_BASE_URL = Boolean(envSecret('NVIDIA_BASE_URL'));
  out.GITHUB_TOKEN = Boolean(envSecret('GITHUB_TOKEN') || envSecret('GITHUB_PERSONAL_ACCESS_TOKEN'));
  // Combined boolean only — never the key material.
  out.GDY = Boolean(envSecret('GDY_API_KEY') || envSecret('GDY_API_KEY_ALT'));
  return out;
}

export function gdyConfigured() {
  return Boolean(envSecret('GDY_API_KEY') || envSecret('GDY_API_KEY_ALT'));
}

export function gdyApiBase() {
  const explicit = envSecret('GDY_API_BASE');
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = (envSecret('GDY_BASE_URL') || DEFAULT_GDY_ORIGIN).replace(/\/+$/, '');
  return /\/v1$/i.test(host) ? host : `${host}/v1`;
}

function unconfigured(tool, envName) {
  return { ok: false, error: `${tool}_unconfigured`, env: envName, tool };
}

async function httpJson(url, init, { timeoutMs = DEFAULT_TIMEOUT_MS, expectJson = true, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const res = await fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  if (expectJson && text) {
    try { json = JSON.parse(text); }
    catch { json = null; }
  }
  return { res, text, json };
}

function publicUrl(raw) {
  const s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) return { ok: false, error: 'url_must_be_http(s)' };
  let u;
  try { u = new URL(s); }
  catch { return { ok: false, error: 'invalid_url' }; }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return { ok: false, error: 'private_host_forbidden' };
  }
  return { ok: true, url: u.toString() };
}

// ---- Search cascade: Tavily → Exa → (caller falls back to DuckDuckGo) ----

export async function tavilySearch({ query, count = 5 } = {}) {
  const key = envSecret('TAVILY_API_KEY');
  if (!key) return unconfigured('tavily_search', 'TAVILY_API_KEY');
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query_required', tool: 'tavily_search' };
  const { res, json, text } = await httpJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q.slice(0, 400), max_results: Math.max(1, Math.min(10, count)), include_answer: false }),
  });
  if (!res.ok) return { ok: false, error: `tavily_http_${res.status}`, detail: (json && (json.error || json.message)) || text.slice(0, 200), tool: 'tavily_search' };
  const results = Array.isArray(json?.results) ? json.results.map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || r.snippet || '',
  })) : [];
  return { ok: true, evidence: { query: q, provider: 'tavily', count: results.length, results }, tool: 'tavily_search' };
}

export async function exaSearch({ query, count = 5 } = {}) {
  const key = envSecret('EXA_API_KEY');
  if (!key) return unconfigured('exa_search', 'EXA_API_KEY');
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query_required', tool: 'exa_search' };
  const { res, json, text } = await httpJson('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query: q.slice(0, 400), numResults: Math.max(1, Math.min(10, count)), type: 'auto', contents: { text: { maxCharacters: 400 } } }),
  });
  if (!res.ok) return { ok: false, error: `exa_http_${res.status}`, detail: (json && (json.error || json.message)) || text.slice(0, 200), tool: 'exa_search' };
  const results = Array.isArray(json?.results) ? json.results.map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.text || r.snippet || '',
  })) : [];
  return { ok: true, evidence: { query: q, provider: 'exa', count: results.length, results }, tool: 'exa_search' };
}

// ---- Scrapers ----

export async function firecrawlScrape({ url } = {}) {
  const key = envSecret('FIRECRAWL_API_KEY');
  if (!key) return unconfigured('firecrawl_scrape', 'FIRECRAWL_API_KEY');
  const checked = publicUrl(url);
  if (!checked.ok) return { ...checked, tool: 'firecrawl_scrape' };
  const { res, json, text } = await httpJson('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ url: checked.url, formats: ['markdown', 'links'] }),
  }, { timeoutMs: 45_000 });
  if (!res.ok) return { ok: false, error: `firecrawl_http_${res.status}`, detail: (json && (json.error || json.message)) || text.slice(0, 200), tool: 'firecrawl_scrape' };
  const data = json?.data || json;
  return {
    ok: true,
    evidence: {
      url: checked.url,
      title: data?.metadata?.title || null,
      markdown: String(data?.markdown || '').slice(0, 20_000),
      links: Array.isArray(data?.links) ? data.links.slice(0, 20) : [],
    },
    tool: 'firecrawl_scrape',
  };
}

export async function scrapingbeeScrape({ url } = {}) {
  const key = envSecret('SCRAPINGBEE_API_KEY');
  if (!key) return unconfigured('scrapingbee_scrape', 'SCRAPINGBEE_API_KEY');
  const checked = publicUrl(url);
  if (!checked.ok) return { ...checked, tool: 'scrapingbee_scrape' };
  const endpoint = `https://app.scrapingbee.com/api/v1/?api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(checked.url)}&render_js=false`;
  const { res, text } = await httpJson(endpoint, { method: 'GET', headers: { accept: 'text/html' } }, { expectJson: false, timeoutMs: 30_000 });
  if (!res.ok) return { ok: false, error: `scrapingbee_http_${res.status}`, detail: text.slice(0, 200), tool: 'scrapingbee_scrape' };
  return { ok: true, evidence: { url: checked.url, text: text.slice(0, 20_000), bytes: text.length }, tool: 'scrapingbee_scrape' };
}

export async function scrapflyScrape({ url } = {}) {
  const key = envSecret('SCRAPFLY_API_KEY');
  if (!key) return unconfigured('scrapfly_scrape', 'SCRAPFLY_API_KEY');
  const checked = publicUrl(url);
  if (!checked.ok) return { ...checked, tool: 'scrapfly_scrape' };
  const endpoint = `https://api.scrapfly.io/scrape?key=${encodeURIComponent(key)}&url=${encodeURIComponent(checked.url)}&asp=true`;
  const { res, json, text } = await httpJson(endpoint, { method: 'GET', headers: { accept: 'application/json' } }, { timeoutMs: 30_000 });
  if (!res.ok) return { ok: false, error: `scrapfly_http_${res.status}`, detail: (json && (json.error || json.message)) || text.slice(0, 200), tool: 'scrapfly_scrape' };
  const content = json?.result?.content || '';
  return { ok: true, evidence: { url: checked.url, text: String(content).slice(0, 20_000) }, tool: 'scrapfly_scrape' };
}

/**
 * ScreenshotOne signed take(). Matches CaseClosedFL / VIDEO-Engine-CCFL:
 * HMAC-SHA256 over the canonical query string; secret is never a query param.
 */
export function signScreenshotOneQuery(params, secret) {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  if (!secret) return { query, signature: null };
  const signature = createHmac('sha256', secret).update(query).digest('hex');
  return { query: `${query}&signature=${signature}`, signature };
}

export async function screenshotOne({ url, fullPage = false } = {}) {
  const access = envSecret('SCREENSHOTONE_ACCESS_KEY');
  const secret = envSecret('SCREENSHOTONE_SECRET_KEY');
  if (!access) return unconfigured('screenshotone', 'SCREENSHOTONE_ACCESS_KEY');
  const checked = publicUrl(url);
  if (!checked.ok) return { ...checked, tool: 'screenshotone' };
  const params = {
    access_key: access,
    url: checked.url,
    full_page: Boolean(fullPage),
    format: 'png',
  };
  const { query } = signScreenshotOneQuery(params, secret);
  const res = await fetch(`https://api.screenshotone.com/take?${query}`, {
    method: 'GET',
    headers: { accept: 'image/png,application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `screenshotone_http_${res.status}`, detail: detail.slice(0, 200), tool: 'screenshotone' };
  }
  const mime = res.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    ok: true,
    evidence: { url: checked.url, mime, bytes: buf.length, base64_preview: buf.toString('base64').slice(0, 120), signed: Boolean(secret) },
    tool: 'screenshotone',
  };
}

// ---- Composio: ak_ project REST; ck_ consumer MCP; oak_ rejected ----

export function classifyComposioKey(raw) {
  const key = String(raw || '').trim();
  if (!key) return { type: 'missing', ok: false, error: 'COMPOSIO_API_KEY is empty' };
  if (key.startsWith('ak_')) return { type: 'project', ok: true, prefix: 'ak_' };
  if (key.startsWith('ck_')) {
    return {
      type: 'consumer',
      ok: false,
      prefix: 'ck_',
      error: 'COMPOSIO_API_KEY is a Connect consumer key (ck_). Aion-Brain executes project REST keys (ak_) only. Use VIDEO-Engine Claw composio_action for ck_ MCP tools, or set an ak_ project key.',
    };
  }
  if (key.startsWith('oak_')) {
    return {
      type: 'oak',
      ok: false,
      prefix: 'oak_',
      error: 'COMPOSIO_API_KEY starts with oak_ (org/legacy). This backend expects ak_ (project REST). oak_ is rejected so we do not call the wrong Composio API.',
    };
  }
  return {
    type: 'unknown',
    ok: false,
    prefix: key.slice(0, 4),
    error: `COMPOSIO_API_KEY has unrecognized prefix "${key.slice(0, 4)}". Expected ak_ (project REST). ck_ consumer and oak_ keys are not executed here.`,
  };
}

export async function composioAction({ slug, args = {}, entityId = 'default' } = {}) {
  const key = envSecret('COMPOSIO_API_KEY');
  const kind = classifyComposioKey(key);
  if (!key) return unconfigured('composio_action', 'COMPOSIO_API_KEY');
  if (!kind.ok) return { ok: false, error: kind.error, key_type: kind.type, tool: 'composio_action' };
  const action = String(slug || '').trim();
  if (!action) return { ok: false, error: 'slug_required', tool: 'composio_action' };
  const { res, json, text } = await httpJson(`https://backend.composio.dev/api/v2/actions/${encodeURIComponent(action)}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ entityId: String(entityId || 'default'), input: args && typeof args === 'object' ? args : {} }),
  }, { timeoutMs: 45_000 });
  if (!res.ok) {
    return {
      ok: false,
      error: `composio_http_${res.status}`,
      detail: (json && (json.error || json.message || json.message_code)) || text.slice(0, 240),
      key_type: kind.type,
      tool: 'composio_action',
    };
  }
  return { ok: json?.successful !== false && json?.error == null, evidence: json, key_type: kind.type, tool: 'composio_action' };
}

export async function composioHealth() {
  const key = envSecret('COMPOSIO_API_KEY');
  const kind = classifyComposioKey(key);
  if (!key) return { ok: false, configured: false, error: 'COMPOSIO_API_KEY is empty', tool: 'composio_health' };
  if (!kind.ok) return { ok: false, configured: true, key_type: kind.type, error: kind.error, tool: 'composio_health' };
  const { res, json, text } = await httpJson('https://backend.composio.dev/api/v2/actions', {
    method: 'GET',
    headers: { 'x-api-key': key, accept: 'application/json' },
  });
  return {
    ok: res.ok,
    configured: true,
    key_type: kind.type,
    status: res.status,
    evidence: res.ok ? { action_count: Array.isArray(json?.items) ? json.items.length : (json?.items ? 1 : 0) } : { error: text.slice(0, 200) },
    tool: 'composio_health',
  };
}

// ---- E2B / Hedra / Resend / GitHub ----

export async function e2bRun({ code, language = 'python' } = {}) {
  const key = envSecret('E2B_API_KEY');
  if (!key) return unconfigured('e2b_run', 'E2B_API_KEY');
  const src = String(code || '').trim();
  if (!src) return { ok: false, error: 'code_required', tool: 'e2b_run' };
  const { res, json, text } = await httpJson('https://api.e2b.dev/sandbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ template: language === 'js' || language === 'javascript' ? 'base' : 'base', timeout: 30 }),
  }, { timeoutMs: 15_000 });
  if (!res.ok) return { ok: false, error: `e2b_http_${res.status}`, detail: (json && (json.message || json.error)) || text.slice(0, 200), tool: 'e2b_run' };
  return {
    ok: true,
    evidence: { sandbox_id: json?.sandboxID || json?.id || null, note: 'sandbox created; code execution is a follow-up. No stdout fabricated.', language },
    tool: 'e2b_run',
  };
}

export async function hedraStatus() {
  const key = envSecret('HEDRA_API_KEY');
  if (!key) return unconfigured('hedra_status', 'HEDRA_API_KEY');
  const { res, json, text } = await httpJson('https://api.hedra.com/v3/models', {
    method: 'GET',
    headers: { authorization: `Key ${key}`, accept: 'application/json' },
  });
  if (!res.ok) return { ok: false, error: `hedra_http_${res.status}`, detail: text.slice(0, 200), tool: 'hedra_status' };
  const models = Array.isArray(json) ? json : (json?.models || json?.data || []);
  return { ok: true, evidence: { model_count: Array.isArray(models) ? models.length : 0 }, tool: 'hedra_status' };
}

export async function resendSend({ to, subject, text } = {}) {
  const key = envSecret('RESEND_API_KEY');
  if (!key) return unconfigured('resend_send', 'RESEND_API_KEY');
  const dest = String(to || '').trim();
  const subj = String(subject || '').trim();
  const body = String(text || '').trim();
  if (!dest || !subj || !body) return { ok: false, error: 'to_subject_text_required', tool: 'resend_send' };
  const { res, json, text: raw } = await httpJson('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: process.env.RESEND_FROM || 'Aion-Brain <noreply@abbycrm.com>', to: [dest], subject: subj, text: body }),
  });
  if (!res.ok) return { ok: false, error: `resend_http_${res.status}`, detail: (json && (json.message || json.error)) || raw.slice(0, 200), tool: 'resend_send' };
  return { ok: true, evidence: { id: json?.id || null }, tool: 'resend_send' };
}

export function githubToken() {
  return envSecret('GITHUB_PERSONAL_ACCESS_TOKEN') || envSecret('GITHUB_TOKEN');
}

export async function githubRepo({ repository } = {}) {
  const token = githubToken();
  if (!token) return unconfigured('github_repo', 'GITHUB_PERSONAL_ACCESS_TOKEN');
  const repo = String(repository || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { ok: false, error: 'invalid_repository', tool: 'github_repo' };
  const { res, json, text } = await httpJson(`https://api.github.com/repos/${repo}`, {
    method: 'GET',
    headers: githubHeaders(token),
  });
  if (!res.ok) return { ok: false, error: json?.message || `github_http_${res.status}`, detail: text.slice(0, 160), tool: 'github_repo' };
  return {
    ok: true,
    evidence: {
      full_name: json.full_name,
      description: json.description,
      default_branch: json.default_branch,
      stars: json.stargazers_count,
      open_issues: json.open_issues_count,
      html_url: json.html_url,
    },
    tool: 'github_repo',
  };
}

function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'AionBrain/0.1.16',
    'x-github-api-version': '2022-11-28',
  };
}

export function heliconeHeaders() {
  const enabled = /^(1|true|yes)$/i.test(String(process.env.HELICONE_ENABLED || ''));
  if (!enabled) return null;
  const base = String(process.env.NVIDIA_BASE_URL || '');
  if (!/helicone/i.test(base)) return null;
  const key = envSecret('HELICONE_API_KEY');
  if (!key) return null;
  return {
    'Helicone-Auth': `Bearer ${key}`,
    'Helicone-Target-URL': process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com',
  };
}

// ---- GDY (Go Duck Yourself) OSINT tool directory ----
// Bearer from GDY_API_KEY; on HTTP 401 retry once with GDY_API_KEY_ALT.
// Never log key material. Fail soft when unconfigured.

function gdyKeys() {
  const primary = envSecret('GDY_API_KEY');
  const alt = envSecret('GDY_API_KEY_ALT');
  const keys = [];
  if (primary) keys.push(primary);
  if (alt && alt !== primary) keys.push(alt);
  return keys;
}

function redactSecrets(text, secrets) {
  let s = String(text || '');
  for (const secret of secrets) {
    if (secret) s = s.split(secret).join('[redacted]');
  }
  return s;
}

function sanitizeGdyTool(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: raw.id != null ? String(raw.id) : null,
    name: raw.name != null ? String(raw.name).slice(0, 240) : null,
    url: raw.url != null ? String(raw.url).slice(0, 500) : null,
    categoryId: raw.categoryId != null ? String(raw.categoryId) : null,
    categoryLabel: raw.categoryLabel != null ? String(raw.categoryLabel) : null,
    hostname: raw.hostname != null ? String(raw.hostname) : null,
  };
}

async function gdyGet(path, query, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, tool = 'gdy' } = {}) {
  const keys = gdyKeys();
  if (!keys.length) return unconfigured(tool, 'GDY_API_KEY');
  const url = new URL(`${gdyApiBase()}${path.startsWith('/') ? path : `/${path}`}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  let last = { ok: false, error: `${tool}_request_failed`, tool };
  try {
    for (let i = 0; i < keys.length; i += 1) {
      const { res, json, text } = await httpJson(url.toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${keys[i]}`,
          accept: 'application/json, text/markdown, text/plain;q=0.8',
          'user-agent': 'AionBrain/0.1.17 (+tool gdy)',
        },
      }, { timeoutMs, fetchImpl });
      if (res.status === 401 && i === 0 && keys.length > 1) {
        last = { ok: false, error: `${tool}_http_401`, tool, status: 401 };
        continue;
      }
      if (!res.ok) {
        return {
          ok: false,
          error: `${tool}_http_${res.status}`,
          detail: redactSecrets((json && (json.error || json.message)) || text, keys).slice(0, 200),
          tool,
          status: res.status,
        };
      }
      return { ok: true, json, text, used_alt: i > 0, tool };
    }
  } catch (e) {
    const name = e && e.name;
    const error = name === 'TimeoutError' || name === 'AbortError' ? `${tool}_timeout` : `${tool}_network`;
    return { ok: false, error, tool };
  }
  return last;
}

export async function gdySearch({ query, q, limit } = {}, opts = {}) {
  const qv = String(query || q || '').trim();
  if (!qv) return { ok: false, error: 'query_required', tool: 'gdy_search' };
  const lim = Math.max(1, Math.min(100, Number(limit) || 20));
  const raw = await gdyGet('/search', { q: qv.slice(0, 400), limit: lim }, { ...opts, tool: 'gdy_search' });
  if (!raw.ok) return raw;
  const data = Array.isArray(raw.json?.data) ? raw.json.data.map(sanitizeGdyTool).filter(Boolean) : [];
  return {
    ok: true,
    evidence: {
      query: raw.json?.query || qv,
      total: Number.isFinite(Number(raw.json?.total)) ? Number(raw.json.total) : data.length,
      count: data.length,
      tools: data,
      used_alt: raw.used_alt === true,
    },
    tool: 'gdy_search',
  };
}

export async function gdyRagContext({ query, q, limit, format } = {}, opts = {}) {
  const qv = String(query || q || '').trim();
  if (!qv) return { ok: false, error: 'query_required', tool: 'gdy_rag_context' };
  const lim = Math.max(1, Math.min(50, Number(limit) || 10));
  const fmt = ['markdown', 'text', 'json'].includes(String(format || '')) ? String(format) : 'markdown';
  const raw = await gdyGet('/rag/context', { q: qv.slice(0, 400), limit: lim, format: fmt }, { ...opts, tool: 'gdy_rag_context' });
  if (!raw.ok) return raw;
  const markdown = fmt === 'json'
    ? JSON.stringify(raw.json || {}).slice(0, 24_000)
    : String(raw.text || '').slice(0, 24_000);
  return {
    ok: true,
    evidence: {
      query: qv,
      format: fmt,
      markdown,
      used_alt: raw.used_alt === true,
    },
    tool: 'gdy_rag_context',
  };
}

export async function gdyCategories(_args = {}, opts = {}) {
  const raw = await gdyGet('/categories', {}, { ...opts, tool: 'gdy_categories' });
  if (!raw.ok) return raw;
  const list = Array.isArray(raw.json?.data) ? raw.json.data
    : (Array.isArray(raw.json) ? raw.json : []);
  const categories = list.slice(0, 50).map((c) => {
    if (!c || typeof c !== 'object') return { id: String(c), label: String(c) };
    return {
      id: c.id != null ? String(c.id) : (c.slug || c.name || null),
      label: c.label || c.name || c.title || null,
      count: Number.isFinite(Number(c.count)) ? Number(c.count) : (c.toolCount ?? null),
    };
  });
  return { ok: true, evidence: { count: categories.length, categories, used_alt: raw.used_alt === true }, tool: 'gdy_categories' };
}

export async function gdyTools({ q, category, page, perPage } = {}, opts = {}) {
  const query = {
    q: q ? String(q).slice(0, 400) : undefined,
    category: category ? String(category).slice(0, 120) : undefined,
    page: Math.max(1, Number(page) || 1),
    perPage: Math.max(1, Math.min(200, Number(perPage) || 50)),
  };
  const raw = await gdyGet('/tools', query, { ...opts, tool: 'gdy_tools' });
  if (!raw.ok) return raw;
  const data = Array.isArray(raw.json?.data) ? raw.json.data.map(sanitizeGdyTool).filter(Boolean)
    : (Array.isArray(raw.json) ? raw.json.map(sanitizeGdyTool).filter(Boolean) : []);
  return {
    ok: true,
    evidence: {
      q: query.q || null,
      category: query.category || null,
      page: query.page,
      count: data.length,
      tools: data,
      used_alt: raw.used_alt === true,
    },
    tool: 'gdy_tools',
  };
}

// ---- Public arXiv Atom API (no GDY key) ----

function arxivSearchQuery(q) {
  if (/^(all|ti|au|abs|cat|co|id):/i.test(q)) return q;
  // Unquoted spaces are treated as OR by the arXiv API.
  if (/\s/.test(q)) return `all:"${q.replace(/"/g, '')}"`;
  return `all:${q}`;
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function parseArxivAtom(xml, limit = 5) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(String(xml || ''))) && entries.length < limit) {
    const block = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<(?:atom:)?${tag}[^>]*>([\\s\\S]*?)</(?:atom:)?${tag}>`, 'i').exec(block);
      return r ? decodeXml(r[1]) : '';
    };
    const authors = [];
    const authorRe = /<(?:atom:)?author>[\s\S]*?<(?:atom:)?name>([\s\S]*?)<\/(?:atom:)?name>/gi;
    let a;
    while ((a = authorRe.exec(block))) authors.push(decodeXml(a[1]));
    const htmlLink = /<link[^>]+rel="alternate"[^>]+href="([^"]+)"/i.exec(block)
      || /<link[^>]+href="([^"]+)"[^>]+rel="alternate"/i.exec(block);
    const anyLink = /<link[^>]+href="([^"]+)"/i.exec(block);
    const id = pick('id');
    entries.push({
      id,
      title: pick('title'),
      summary: pick('summary').slice(0, 800),
      authors,
      link: (htmlLink && htmlLink[1]) || id || (anyLink && anyLink[1]) || '',
      published: pick('published') || null,
    });
  }
  return entries;
}

export async function arxivSearch({ query, max_results, maxResults } = {}, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query_required', tool: 'arxiv_search' };
  const n = Math.max(1, Math.min(25, Number(max_results ?? maxResults) || 5));
  const endpoint = envSecret('ARXIV_API_BASE') || DEFAULT_ARXIV_ENDPOINT;
  const url = `${endpoint.replace(/\/+$/, '')}?search_query=${encodeURIComponent(arxivSearchQuery(q))}&start=0&max_results=${n}`;
  const fetchFn = opts.fetchImpl || globalThis.fetch;
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        accept: 'application/atom+xml, application/xml, text/xml',
        'user-agent': 'AionBrain/0.1.17 (+tool arxiv_search)',
      },
      signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `arxiv_http_${res.status}`, tool: 'arxiv_search' };
    const xml = await res.text();
    const papers = parseArxivAtom(xml, n);
    return { ok: true, evidence: { query: q, count: papers.length, papers }, tool: 'arxiv_search' };
  } catch (e) {
    const name = e && e.name;
    const error = name === 'TimeoutError' || name === 'AbortError' ? 'arxiv_timeout' : 'arxiv_network';
    return { ok: false, error, tool: 'arxiv_search' };
  }
}
