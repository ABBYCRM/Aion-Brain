// Provider routing, circuit breaking, failover, and response normalization.

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_UPSTREAM_ERROR_CHARS = 500;

export async function fetchWithTimeout(fetchImpl, url, init = {}, ms = DEFAULT_TIMEOUT_MS) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('No fetch implementation available');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`upstream timeout after ${ms}ms`)), ms);
  timeout.unref?.();

  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
  if (upstreamSignal) {
    if (upstreamSignal.aborted) abortFromUpstream();
    else upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
  }

  try {
    return await f(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener?.('abort', abortFromUpstream);
  }
}

export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 30_000 } = {}) {
    if (!Number.isInteger(threshold) || threshold < 1) throw new TypeError('threshold must be a positive integer');
    if (!Number.isFinite(cooldownMs) || cooldownMs < 1) throw new TypeError('cooldownMs must be positive');
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = new Map();
  }

  isOpen(provider) {
    const state = this.failures.get(provider);
    if (!state?.openedAt) return false;
    if (Date.now() - state.openedAt >= this.cooldownMs) {
      this.failures.delete(provider);
      return false;
    }
    return true;
  }

  recordSuccess(provider) {
    this.failures.delete(provider);
  }

  recordFailure(provider) {
    const previous = this.failures.get(provider) || { count: 0, openedAt: null };
    const count = previous.count + 1;
    this.failures.set(provider, {
      count,
      openedAt: count >= this.threshold ? (previous.openedAt || Date.now()) : null,
    });
  }

  state(provider) {
    const current = this.failures.get(provider);
    if (!current) return { open: false, count: 0, openedAt: null };
    return {
      open: this.isOpen(provider),
      count: current.count,
      openedAt: current.openedAt,
    };
  }
}

export class Router {
  constructor({ providers = [], breaker, store, fetchImpl } = {}) {
    if (!Array.isArray(providers) || providers.length === 0) throw new TypeError('providers must be a non-empty array');
    this.providers = providers;
    this.breaker = breaker || new CircuitBreaker();
    this.store = store;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  async call({ operation, payload, rawBody, contentType, appId, requestId }) {
    const totalStart = Date.now();
    const errors = [];

    for (let index = 0; index < this.providers.length; index += 1) {
      const provider = this.providers[index];
      if (this.breaker.isOpen(provider.name)) {
        errors.push({ provider: provider.name, code: 'circuit_open', status: 503 });
        continue;
      }

      const attemptStart = Date.now();
      try {
        const result = await provider.invoke({
          operation,
          payload,
          rawBody,
          contentType,
          fetchImpl: this.fetchImpl,
        });
        const attemptLatency = Date.now() - attemptStart;
        this.breaker.recordSuccess(provider.name);
        this._recordCall({
          ts: totalStart,
          app_id: appId,
          provider: provider.name,
          model: result.model || payload?.model || null,
          operation,
          status: 200,
          latency_ms: attemptLatency,
          tokens_in: result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? null,
          tokens_out: result.usage?.output_tokens ?? result.usage?.completion_tokens ?? null,
          cost_usd: result.cost_usd ?? null,
          request_id: requestId,
          meta: { attempt: index + 1, providers_tried: this.providers.slice(0, index + 1).map(item => item.name) },
        });
        return {
          ok: true,
          provider: provider.name,
          latency_ms: Date.now() - totalStart,
          attempt_latency_ms: attemptLatency,
          ...result,
        };
      } catch (error) {
        const normalized = normalizeProviderError(error, provider.name);
        const retryable = isRetriable(normalized);
        if (retryable && normalized.code !== 'unsupported_operation') this.breaker.recordFailure(provider.name);
        errors.push(normalized.public);
        this._recordCall({
          ts: totalStart,
          app_id: appId,
          provider: provider.name,
          model: payload?.model || null,
          operation,
          status: normalized.status,
          latency_ms: Date.now() - attemptStart,
          request_id: requestId,
          error_code: normalized.code,
          error_message: normalized.internalMessage,
          meta: { attempt: index + 1, providers_tried: this.providers.slice(0, index + 1).map(item => item.name) },
        });
        if (!retryable) break;
      }
    }

    return { ok: false, errors, latency_ms: Date.now() - totalStart };
  }

  _recordCall(call) {
    if (!this.store) return;
    try {
      this.store.recordCall(call);
    } catch (error) {
      console.error(JSON.stringify({
        t: new Date().toISOString(),
        level: 'error',
        msg: 'call log write failed',
        error: error.message,
        request_id: call.request_id,
      }));
    }
  }
}

export function isRetriable(error) {
  if (error.code === 'unsupported_operation') return true;
  if (!error.status) return true;
  if ([408, 409, 425, 429].includes(error.status)) return true;
  return error.status >= 500;
}

function normalizeProviderError(error, provider) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const code = typeof error?.code === 'string' ? error.code : 'provider_error';
  const internalMessage = String(error?.message || error || 'provider error').slice(0, MAX_UPSTREAM_ERROR_CHARS);
  return {
    code,
    status,
    internalMessage,
    public: { provider, code, status },
  };
}

function providerError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    throw providerError(`http_${response.status}`, text.slice(0, MAX_UPSTREAM_ERROR_CHARS) || response.statusText, response.status);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw providerError('invalid_upstream_json', 'Provider returned invalid JSON', 502);
  }
}

export class OpenAIProvider {
  constructor({ apiKey, baseUrl = 'https://api.openai.com/v1', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error('OpenAIProvider requires apiKey');
    this.name = 'openai';
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async invoke({ operation, payload = {}, rawBody, contentType, fetchImpl }) {
    const path = openaiPath(operation);
    if (!path) throw providerError('unsupported_operation', `OpenAI does not support ${operation}`, 400);
    const init = openaiInit({ operation, payload, rawBody, contentType, apiKey: this.apiKey });
    const response = await fetchWithTimeout(fetchImpl, `${this.baseUrl}${path}`, init, this.timeoutMs);
    return normalizeOpenAI(operation, await parseJsonResponse(response));
  }
}

function openaiPath(operation) {
  switch (operation) {
    case 'chat': return '/chat/completions';
    case 'image.generate': return '/images/generations';
    case 'image.edit': return '/images/edits';
    case 'video.create': return '/videos';
    default: return null;
  }
}

function openaiInit({ operation, payload, rawBody, contentType, apiKey }) {
  const headers = { authorization: `Bearer ${apiKey}` };

  if (rawBody) {
    if (!contentType) throw providerError('invalid_request', 'content-type is required for raw uploads', 400);
    headers['content-type'] = contentType;
    return { method: 'POST', headers, body: rawBody };
  }

  if (operation === 'image.edit' || operation === 'video.create') {
    const form = new FormData();
    for (const [key, value] of Object.entries(payload || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (key.endsWith('_b64')) {
        const field = key.replace(/_b64$/, '');
        const mimeType = payload[`${field}_mime_type`] || (field === 'input_reference' ? 'image/png' : 'image/png');
        form.append(field, new Blob([Buffer.from(String(value), 'base64')], { type: mimeType }), `${field}.png`);
      } else if (!key.endsWith('_mime_type')) {
        form.append(key, String(value));
      }
    }
    return { method: 'POST', headers, body: form };
  }

  headers['content-type'] = 'application/json';
  return { method: 'POST', headers, body: JSON.stringify(payload) };
}

function normalizeOpenAI(operation, json) {
  if (operation === 'chat') {
    const choice = json.choices?.[0];
    return {
      model: json.model,
      content: choice?.message?.content ?? null,
      finish_reason: choice?.finish_reason,
      usage: json.usage,
    };
  }
  if (operation === 'image.generate' || operation === 'image.edit') {
    return {
      model: json.model,
      images: (json.data || []).map(item => ({ url: item.url, b64: item.b64_json })),
      usage: json.usage,
    };
  }
  if (operation === 'video.create') {
    return { id: json.id, status: json.status, model: json.model, progress: json.progress };
  }
  return json;
}

export class A2EProvider {
  constructor({ apiKey, baseUrl = 'https://api.a2e.ai/v1', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error('A2EProvider requires apiKey');
    this.name = 'a2e';
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async invoke({ operation, payload = {}, rawBody, fetchImpl }) {
    if (rawBody) throw providerError('unsupported_operation', 'A2E raw multipart passthrough is unsupported', 400);
    const routes = {
      chat: '/chat/completions',
      'image.generate': '/text2image',
      'image.edit': '/image2image',
      'video.create': '/userImage2Video',
    };
    const path = routes[operation];
    if (!path) throw providerError('unsupported_operation', `A2E does not support ${operation}`, 400);
    const response = await fetchWithTimeout(fetchImpl, `${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, this.timeoutMs);
    return normalizeA2E(operation, await parseJsonResponse(response));
  }
}

function normalizeA2E(operation, json) {
  const body = json.data ?? json.result ?? json;
  if (operation === 'chat') {
    return {
      model: body.model,
      content: body.choices?.[0]?.message?.content ?? body.output ?? body.text ?? null,
      finish_reason: body.choices?.[0]?.finish_reason,
      usage: body.usage,
    };
  }
  if (operation === 'image.generate' || operation === 'image.edit') {
    const items = Array.isArray(body) ? body : (body.images || body.data || [body]);
    return {
      model: body.model,
      images: items.filter(Boolean).map(item => ({ url: item.url || item.image_url, b64: item.b64_json || item.b64 })),
      usage: body.usage,
    };
  }
  return { id: body.id || body.task_id, status: body.status || 'queued', model: body.model };
}

export class AnthropicProvider {
  constructor({ apiKey, baseUrl = 'https://api.anthropic.com/v1', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error('AnthropicProvider requires apiKey');
    this.name = 'anthropic';
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async invoke({ operation, payload = {}, rawBody, fetchImpl }) {
    if (rawBody || !['chat', 'anthropic.messages'].includes(operation)) {
      throw providerError('unsupported_operation', `Anthropic does not support ${operation}`, 400);
    }
    const request = operation === 'anthropic.messages' ? normalizeAnthropicNative(payload) : openAIToAnthropic(payload);
    const response = await fetchWithTimeout(fetchImpl, `${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    }, this.timeoutMs);
    const json = await parseJsonResponse(response);
    return {
      id: json.id,
      model: json.model,
      content: extractAnthropicText(json.content),
      content_blocks: json.content,
      finish_reason: json.stop_reason,
      usage: { input_tokens: json.usage?.input_tokens, output_tokens: json.usage?.output_tokens },
    };
  }
}

function normalizeAnthropicNative(payload) {
  return {
    ...payload,
    model: payload.model || 'claude-sonnet-4-5',
    max_tokens: payload.max_tokens || 1024,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
  };
}

function openAIToAnthropic(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const systemParts = messages.filter(item => item.role === 'system').map(item => contentToText(item.content));
  return {
    model: payload.model || 'claude-sonnet-4-5',
    max_tokens: payload.max_tokens || 1024,
    system: systemParts.join('\n') || undefined,
    messages: messages
      .filter(item => item.role !== 'system')
      .map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content })),
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : (part?.text || '')).filter(Boolean).join('\n');
}

function extractAnthropicText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text || '').join('');
}

const ECHO_IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=';

export class EchoProvider {
  constructor({ name = 'echo', latencyMs = 5 } = {}) {
    this.name = name;
    this.latencyMs = latencyMs;
  }

  async invoke({ operation, payload = {} }) {
    await new Promise(resolve => setTimeout(resolve, this.latencyMs));
    if (operation === 'chat') {
      return {
        model: payload.model || 'echo-chat',
        content: `[echo:chat] ${contentToText(payload.messages?.at?.(-1)?.content).slice(0, 200)}`,
        finish_reason: 'stop',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    if (operation === 'anthropic.messages') {
      return {
        id: 'msg_echo',
        model: payload.model || 'echo-anthropic',
        content: '[echo:anthropic.messages]',
        content_blocks: [{ type: 'text', text: '[echo:anthropic.messages]' }],
        finish_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
    if (operation === 'image.generate' || operation === 'image.edit') {
      return { model: payload.model || 'echo-image', images: [{ b64: ECHO_IMAGE_B64 }], usage: {} };
    }
    if (operation === 'video.create') {
      return { id: 'video_echo', status: 'queued', model: payload.model || 'echo-video', progress: 0 };
    }
    throw providerError('unsupported_operation', `Echo does not support ${operation}`, 400);
  }
}
