// lib/nvidia_only_providers.js
// NVIDIA-only /v1 provider chain. No OpenAI, xAI, A2E, or Anthropic.
import { Router, OpenAIProvider, EchoProvider } from './router.js';

const NVIDIA_BASE = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';

export function buildDefaultChain() {
  if (process.env.AION_ECHO_ONLY === '1') {
    return [new EchoProvider({ name: 'echo', latencyMs: 5 })];
  }
  const chain = [];
  const nvidiaKey = process.env.NVIDIA_API_KEYS || process.env.NVIDIA_API_KEY;
  if (nvidiaKey) {
    chain.push(new OpenAIProvider({
      name: 'nvidia',
      apiKey: nvidiaKey,
      baseUrl: NVIDIA_BASE,
    }));
  }
  if (chain.length === 0) {
    chain.push(new EchoProvider({ name: 'echo', latencyMs: 5 }));
  }
  return chain;
}

export function resolveProviders(req, { breaker, store, router }) {
  const nvidiaHeader = req.header('x-nvidia-key');
  if (nvidiaHeader) {
    return new Router({
      providers: [new OpenAIProvider({
        name: 'nvidia',
        apiKey: nvidiaHeader.replace(/^Bearer\s+/i, ''),
        baseUrl: NVIDIA_BASE,
      })],
      breaker,
      store,
    });
  }
  return router;
}

export const NVIDIA_CORS_HEADERS = 'content-type,authorization,x-nvidia-key,x-aion-key,x-app-id,x-request-id';
export const DEFAULT_MESSAGES_MODEL = process.env.PRIMARY_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
