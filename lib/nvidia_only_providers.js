// lib/nvidia_only_providers.js
// Bitdeer-only /v1 provider chain. No OpenAI, xAI, A2E, or Anthropic.
import { Router, OpenAIProvider, EchoProvider, parseNvidiaApiKeys } from './router.js';

const BITDEER_BASE = process.env.BITDEER_BASE_URL || process.env.NVIDIA_BASE_URL || 'https://api-inference.bitdeer.ai/v1';

export function bitdeerApiKeyRaw() {
  return process.env.BITDEER_API_KEYS
    || process.env.BITDEER_API_KEY
    || process.env.NVIDIA_API_KEYS
    || process.env.NVIDIA_API_KEY
    || '';
}

export function buildDefaultChain() {
  if (process.env.AION_ECHO_ONLY === '1') {
    return [new EchoProvider({ name: 'echo', latencyMs: 5 })];
  }
  const chain = [];
  const apiKey = parseNvidiaApiKeys(bitdeerApiKeyRaw()).join(',');
  if (apiKey) {
    chain.push(new OpenAIProvider({
      name: 'bitdeer',
      apiKey,
      baseUrl: BITDEER_BASE,
    }));
  }
  if (chain.length === 0) {
    chain.push(new EchoProvider({ name: 'echo', latencyMs: 5 }));
  }
  return chain;
}

export function resolveProviders(req, { breaker, store, router }) {
  const headerKey = req.header('x-bitdeer-key') || req.header('x-nvidia-key');
  if (headerKey) {
    return new Router({
      providers: [new OpenAIProvider({
        name: 'bitdeer',
        apiKey: headerKey.replace(/^Bearer\s+/i, ''),
        baseUrl: BITDEER_BASE,
      })],
      breaker,
      store,
    });
  }
  return router;
}

export const NVIDIA_CORS_HEADERS = 'content-type,authorization,x-bitdeer-key,x-nvidia-key,x-aion-key,x-app-id,x-request-id';
export const DEFAULT_MESSAGES_MODEL = process.env.PRIMARY_MODEL || process.env.BITDEER_TEXT_MODEL || 'zai-org/GLM-5';
export const DEFAULT_IMAGE_MODEL = process.env.BITDEER_IMAGE_MODEL || 'black-forest-labs/FLUX-2-pro';
