// lib/steel_browser.js
// Steel.dev thin client — used by the kernel-level steel_browser tool.
//
// Steel provides hosted browser sessions with a simple REST API:
//   POST /v1/sessions       -> { id, ... }   (create session)
//   GET  /v1/sessions/{id}  -> { ...status } (poll / release)
//   POST /v1/sessions/{id}/content -> { ... } (snapshot HTML, headers, status)
//   POST /v1/sessions/{id}/actions -> { ... } (click, type, scroll, screenshot, etc.)
//
// We deliberately keep this client small and synchronous-shaped: the
// kernel-level tool returns when the action has completed (or timed out).
// Composio + Playwright + other heavy browser workflows still live in
// the AION Python backend. This is the low-overhead fallback for any
// model that just needs "open this URL and tell me what's on it".
//
// Auth: STEEL_API_KEY env var. The Steel API accepts the key in the
// `Authorization: Bearer <key>` header (their docs at docs.steel.dev
// confirm the bearer format). All request/response bodies are JSON.

const STEEL_BASE_URL = (process.env.STEEL_BASE_URL || 'https://api.steel.dev').replace(/\/$/, '');

class SteelError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'SteelError';
    this.status = status;
    this.code = code;
  }
}

async function call(method, path, body, { timeoutMs = 30_000 } = {}) {
  const apiKey = process.env.STEEL_API_KEY;
  if (!apiKey) throw new SteelError('STEEL_API_KEY not configured', { code: 'unconfigured' });
  const url = `${STEEL_BASE_URL}${path}`;
  const init = {
    method,
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new SteelError(`steel ${method} ${path} failed: ${e.message}`, { code: 'network' });
  }
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { /* not JSON, leave as text */ }
  }
  if (!res.ok) {
    throw new SteelError(
      `steel ${method} ${path} HTTP ${res.status}: ${(json && (json.error || json.message)) || text.slice(0, 300)}`,
      { status: res.status, code: (json && json.code) || `http_${res.status}` },
    );
  }
  return json === null ? { ok: true, _raw: text } : json;
}

/**
 * Create a fresh Steel session.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]  session lifetime
 * @param {string} [opts.proxy]            optional proxy URL
 * @param {boolean} [opts.stealth=true]    enable stealth mode
 * @returns {Promise<{id:string,...}>}
 */
export async function createSession(opts = {}) {
  return call('POST', '/v1/sessions', {
    timeout: Math.ceil((opts.timeoutMs || 30_000) / 1000),
    proxy: opts.proxy,
    stealth: opts.stealth !== false,
  });
}

/**
 * Release a Steel session. Best-effort; the platform also auto-reaps.
 */
export async function releaseSession(id) {
  try { return await call('DELETE', `/v1/sessions/${encodeURIComponent(id)}`); }
  catch { return { ok: false, released: false }; }
}

/**
 * Read the current page content for a session (snapshot HTML/text).
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {boolean} [opts.fullPage=true]
 * @returns {Promise<object>}  Steel response — typically { html, text, status, url, title }
 */
export async function getContent(sessionId, opts = {}) {
  return call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/content`, {
    fullPage: opts.fullPage !== false,
  }, { timeoutMs: 30_000 });
}

/**
 * Run one or more browser actions in a session and return the result.
 * @param {string} sessionId
 * @param {Array} actions  e.g. [{type:'navigate',url:'https://...'}, {type:'screenshot'}]
 * @returns {Promise<object>}
 */
export async function runActions(sessionId, actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new SteelError('actions must be a non-empty array', { code: 'bad_input' });
  }
  return call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/actions`, { actions }, { timeoutMs: 60_000 });
}

/**
 * Convenience: open a URL in a fresh session, return the page text + title + url.
 * Caps the page text at 20 KB so we don't blow the LLM context.
 */
export async function fetchUrl(url, { sessionTimeoutMs = 30_000, textLimit = 20_000 } = {}) {
  let session;
  try {
    session = await createSession({ timeoutMs: sessionTimeoutMs });
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
  try {
    const content = await getContent(session.id, { fullPage: false });
    // The above reads the current page; navigate first, then read again.
    await runActions(session.id, [{ type: 'navigate', url }]);
    const after = await getContent(session.id, { fullPage: false });
    const text = (after && (after.text || after.html)) || '';
    return {
      ok: true,
      session_id: session.id,
      url,
      title: (after && after.title) || null,
      status: (after && after.status) || null,
      text: String(text).slice(0, textLimit),
      text_truncated: String(text).length > textLimit,
    };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  } finally {
    if (session && session.id) releaseSession(session.id);
  }
}

export { SteelError };
