// Drop-in JSON client for the gateway. Provider credentials are opt-in and
// gateway authentication is kept separate from upstream provider keys.

import { randomUUID } from 'node:crypto';

export class GatewayError extends Error {
  constructor(message, { status, code, requestId, body } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
  }
}

export class GatewayClient {
  constructor({
    baseUrl,
    gatewayKey,
    openAIKey,
    anthropicKey,
    a2eKey,
    appId = 'unknown-app',
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
  } = {}) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.gatewayKey = gatewayKey;
    this.openAIKey = openAIKey;
    this.anthropicKey = anthropicKey;
    this.a2eKey = a2eKey;
    this.appId = appId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  _headers({ requestId = randomUUID(), extra = {} } = {}) {
    const headers = {
      'content-type': 'application/json',
      'x-app-id': this.appId,
      'x-request-id': requestId,
      ...extra,
    };
    if (this.gatewayKey) headers['x-gateway-key'] = this.gatewayKey;
    if (this.openAIKey) headers['x-openai-key'] = this.openAIKey;
    if (this.anthropicKey) headers['x-anthropic-key'] = this.anthropicKey;
    if (this.a2eKey) headers['x-a2e-key'] = this.a2eKey;
    return headers;
  }

  async _postJSON(path, body, { signal, requestId, timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref?.();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this._headers({ requestId }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); }
        catch {
          throw new GatewayError(`${path} returned invalid JSON`, {
            status: response.status,
            requestId: response.headers?.get?.('x-request-id') || requestId,
            body: text.slice(0, 300),
          });
        }
      }
      if (!response.ok) {
        throw new GatewayError(parsed?.error?.message || `${path} failed with ${response.status}`, {
          status: response.status,
          code: parsed?.error?.code,
          requestId: parsed?.error?.request_id || response.headers?.get?.('x-request-id') || requestId,
          body: parsed,
        });
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', forwardAbort);
    }
  }

  chat({ model, messages, ...rest }, options) {
    return this._postJSON('/v1/chat/completions', { model, messages, ...rest }, options);
  }

  image({ model = 'gpt-image-2', prompt, n = 1, size = '1024x1024', ...rest } = {}, options) {
    return this._postJSON('/v1/images/generations', { model, prompt, n, size, ...rest }, options);
  }

  imageEdit({ model = 'gpt-image-2', image_b64, prompt, ...rest } = {}, options) {
    return this._postJSON('/v1/images/edits', { model, image_b64, prompt, ...rest }, options);
  }

  video({ model = 'sora-2', prompt, ...rest } = {}, options) {
    return this._postJSON('/v1/videos', { model, prompt, ...rest }, options);
  }

  messages(body, options) {
    return this._postJSON('/v1/messages', body, options);
  }
}

export function fromEnv() {
  return new GatewayClient({
    baseUrl: process.env.LLM_GATEWAY_URL || 'http://localhost:10000',
    gatewayKey: process.env.LLM_GATEWAY_API_KEY,
    openAIKey: process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    a2eKey: process.env.A2E_API_KEY,
    appId: process.env.LLM_GATEWAY_APP_ID || 'env-app',
  });
}
