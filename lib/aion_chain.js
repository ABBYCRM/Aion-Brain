// lib/aion_chain.js
// NVIDIA-only streaming/non-streaming model chain for AION.
// The edge remains OpenAI-shaped for compatibility, but every production LLM
// request is sent to NVIDIA NIM at NVIDIA_BASE_URL. Echo is available only
// when AION_ECHO_ONLY=1 for hermetic tests/offline development.

import { OpenAIProvider, EchoProvider, CircuitBreaker } from './router.js';
import { aionSettings, isNvidiaCatalogModel } from './aion_settings.js';
import { heliconeHeaders } from './external_tools.js';

export class AionChain {
  constructor({ providers, breaker, store, appId = 'aion', requestId = null } = {}) {
    this.providers = providers || [];
    this.breaker = breaker || new CircuitBreaker();
    this.store = store;
    this.appId = appId;
    this.requestId = requestId;
  }

  static fromEnv({ breaker, store, appId, requestId } = {}) {
    if (process.env.AION_ECHO_ONLY === '1') {
      return new AionChain({
        providers: [new EchoProvider({ name: 'echo', latencyMs: 5 })],
        breaker,
        store,
        appId,
        requestId,
      });
    }

    const apiKey = process.env.NVIDIA_API_KEYS || process.env.NVIDIA_API_KEY;
    const providers = apiKey ? [new OpenAIProvider({
      name: 'nvidia',
      apiKey,
      baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      extraHeaders: heliconeHeaders(),
    })] : [];

    return new AionChain({ providers, breaker, store, appId, requestId });
  }

  modelChainFromSettings() {
    const known = new Set(this.providers.map(provider => provider.name));
    const chain = [];
    for (const entry of [aionSettings.agentModel, aionSettings.primaryModel, ...aionSettings.fallbackModels]) {
      if (!entry) continue;
      const ref = resolveModelRef(entry, known);
      if (!ref) continue;
      if (!chain.some(item => item.provider === ref.provider && item.model === ref.model)) {
        chain.push(ref);
      }
    }
    if (chain.length === 0 && this.providers[0]?.name === 'echo') {
      chain.push({ provider: 'echo', model: aionSettings.agentModel || aionSettings.primaryModel });
    }
    return chain;
  }

  async *stream({ chain = [], messages, temperature = 0.7, maxTokens = 1024, tools = null, toolChoice = null }) {
    const requestedOrder = chain.length > 0 ? chain : this.modelChainFromSettings();
    const byName = new Map(this.providers.map(provider => [provider.name, provider]));
    let emittedOutput = false;
    let lastError = 'no_attempt';

    if (requestedOrder.length === 0) {
      yield sseEvent('error', { kind: 'nvidia_not_configured', message: 'NVIDIA provider is not configured' });
      return;
    }

    for (let i = 0; i < requestedOrder.length; i++) {
      const want = requestedOrder[i] || {};
      const provider = byName.get(want.provider) || (want.provider ? null : this.providers[0]);
      if (!provider) {
        yield sseEvent('error', {
          kind: 'unknown_provider',
          requested: want.provider,
          index: i + 1,
          message: `provider '${want.provider}' is not configured`,
        });
        continue;
      }

      const ref = { provider: provider.name, model: want.model || aionSettings.agentModel };
      if (provider.name === 'nvidia' && !isNvidiaCatalogModel(ref.model)) {
        yield sseEvent('error', {
          kind: 'model_policy_rejected',
          provider: ref.provider,
          model: ref.model,
          message: 'model is outside the NVIDIA-only catalog policy',
        });
        continue;
      }

      yield sseEvent('attempt', { provider: ref.provider, model: ref.model, index: i + 1 });
      this._record({ kind: 'attempt_start', provider: ref.provider, model: ref.model });

      if (this.breaker.isOpen(provider.name)) {
        yield sseEvent('error', {
          kind: 'circuit_open',
          provider: ref.provider,
          model: ref.model,
          message: 'circuit breaker open',
        });
        continue;
      }

      const started = Date.now();
      const payload = { model: ref.model, messages, temperature, max_tokens: maxTokens };
      if (tools) payload.tools = tools;
      if (toolChoice) payload.tool_choice = toolChoice;

      try {
        if (typeof provider.streamChat === 'function') {
          let opened = false;
          let completionChars = 0;
          let finishReason = 'stop';
          let model = ref.model;

          for await (const event of provider.streamChat({ payload })) {
            if (event.type === 'delta' && event.text) {
              if (!opened) {
                opened = true;
                yield sseEvent('open', { provider: ref.provider, model: ref.model, streaming: 'true' });
              }
              completionChars += event.text.length;
              emittedOutput = true;
              yield sseEvent('delta', { text: event.text });
            } else if (event.type === 'reasoning' && event.text) {
              yield sseEvent('reasoning', { text: event.text });
            } else if (event.type === 'tool_call_delta') {
              yield sseEvent('tool_call_delta', { tool_calls: event.tool_calls });
            } else if (event.type === 'done') {
              finishReason = event.finish_reason || finishReason;
              model = event.model || model;
              const latency = Date.now() - started;
              if (!opened) {
                yield sseEvent('open', { provider: ref.provider, model: ref.model, streaming: 'true' });
              }
              yield sseEvent('done', {
                streaming: 'true',
                provider: ref.provider,
                model,
                latency_ms: latency,
                completion_chars: completionChars,
                finish_reason: finishReason,
                usage: event.usage || null,
                reasoning_content: event.reasoning_content || null,
                tool_calls: event.tool_calls || null,
              });
              this.breaker.recordSuccess(provider.name);
              this._record({ kind: 'attempt_ok', provider: ref.provider, model, latency_ms: latency, completion_chars: completionChars });
              return;
            }
          }

          const latency = Date.now() - started;
          if (!opened) yield sseEvent('open', { provider: ref.provider, model: ref.model, streaming: 'true' });
          yield sseEvent('done', {
            streaming: 'true',
            provider: ref.provider,
            model: ref.model,
            latency_ms: latency,
            completion_chars: completionChars,
            finish_reason: finishReason,
          });
          this.breaker.recordSuccess(provider.name);
          return;
        }

        const result = await provider.invoke({ operation: 'chat', payload });
        const content = result.content || '';
        const latency = Date.now() - started;
        yield sseEvent('open', { provider: ref.provider, model: ref.model, streaming: 'simulated' });
        for (let cursor = 0; cursor < content.length; cursor += 12) {
          const text = content.slice(cursor, cursor + 12);
          emittedOutput = true;
          yield sseEvent('delta', { text });
        }
        yield sseEvent('done', {
          streaming: 'simulated',
          provider: ref.provider,
          model: result.model || ref.model,
          latency_ms: latency,
          completion_chars: content.length,
          finish_reason: result.finish_reason || 'stop',
          reasoning_content: result.reasoning_content || null,
          tool_calls: result.tool_calls || null,
        });
        this.breaker.recordSuccess(provider.name);
        return;
      } catch (error) {
        const latency = Date.now() - started;
        this.breaker.recordFailure(provider.name);
        lastError = error?.message || 'provider_error';
        this._record({
          kind: 'attempt_failed',
          provider: ref.provider,
          model: ref.model,
          error_code: error?.code,
          error_message: lastError,
          latency_ms: latency,
        });
        yield sseEvent('error', {
          kind: error?.code || 'provider_error',
          provider: ref.provider,
          model: ref.model,
          message: lastError,
        });
        if (emittedOutput) {
          yield sseEvent('error', { kind: 'partial_stream_failure', message: 'partial response preserved' });
          return;
        }
        if ([400, 401, 403].includes(error?.status)) return;
      }
    }

    yield sseEvent('error', { kind: 'all_models_failed', message: lastError });
  }

  async chat({ chain = [], messages, temperature = 0.2, maxTokens = 1024, tools = null, toolChoice = null, model = null } = {}) {
    const requestedOrder = [...(chain.length > 0 ? chain : this.modelChainFromSettings())];
    if (model) {
      if (!isNvidiaCatalogModel(model) && this.providers[0]?.name !== 'echo') {
        throw new Error(`model_policy_rejected:${model}`);
      }
      if (requestedOrder[0]) requestedOrder[0] = { ...requestedOrder[0], model };
      else if (this.providers[0]) requestedOrder.push({ provider: this.providers[0].name, model });
    }

    const byName = new Map(this.providers.map(provider => [provider.name, provider]));
    let lastError = 'no_attempt';
    for (let i = 0; i < requestedOrder.length; i++) {
      const want = requestedOrder[i] || {};
      const provider = byName.get(want.provider) || (want.provider ? null : this.providers[0]);
      if (!provider || this.breaker.isOpen(provider.name)) continue;
      const ref = { provider: provider.name, model: want.model || aionSettings.agentModel };
      if (provider.name === 'nvidia' && !isNvidiaCatalogModel(ref.model)) continue;

      const payload = { model: ref.model, messages, temperature, max_tokens: maxTokens };
      if (tools) payload.tools = tools;
      if (toolChoice) payload.tool_choice = toolChoice;
      const started = Date.now();
      try {
        const result = await provider.invoke({ operation: 'chat', payload });
        this.breaker.recordSuccess(provider.name);
        this._record({ kind: 'agent_chat_ok', provider: ref.provider, model: result.model || ref.model, latency_ms: Date.now() - started });
        return {
          provider: ref.provider,
          model: result.model || ref.model,
          content: result.content || '',
          tool_calls: result.tool_calls || null,
          reasoning_content: result.reasoning_content || null,
          finish_reason: result.finish_reason || 'stop',
          usage: result.usage || null,
        };
      } catch (error) {
        this.breaker.recordFailure(provider.name);
        lastError = error?.message || 'provider_error';
        this._record({
          kind: 'agent_chat_failed',
          provider: ref.provider,
          model: ref.model,
          error_code: error?.code,
          error_message: lastError,
          latency_ms: Date.now() - started,
        });
        if ([400, 401, 403].includes(error?.status)) break;
      }
    }
    throw new Error(lastError);
  }

  _record({ kind, ...rest }) {
    if (!this.store?.recordCall) return;
    try {
      this.store.recordCall({
        ts: Date.now(),
        app_id: this.appId,
        provider: rest.provider || 'unknown',
        model: rest.model || null,
        operation: `aion.${kind}`,
        status: rest.kind?.endsWith?.('_failed') ? null : (rest.latency_ms ? 200 : null),
        latency_ms: rest.latency_ms || null,
        request_id: this.requestId,
        error_code: rest.error_code || null,
        error_message: rest.error_message || null,
        meta: rest,
      });
    } catch {
      // Observability must not take down the runtime.
    }
  }
}

function sseEvent(type, payload) {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function resolveModelRef(entry, known) {
  if (!isNvidiaCatalogModel(entry)) return null;
  return known.has('nvidia') ? { provider: 'nvidia', model: entry } : null;
}
