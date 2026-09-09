// lib/aion_settings.js
// Frozen AION runtime settings built from environment variables at startup.
// Production is fail-closed: auth keys and at least one Bitdeer key must
// be present. The model chain is Bitdeer-only.

import { createHash } from 'node:crypto';
import './nvidia_only_guard.js';

function csv(v) { return (v || '').split(',').map(s => s.trim()).filter(Boolean); }

function fromEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === null) return def;
  return String(v).trim();
}

function num(name, def, min, max) {
  const raw = process.env[name];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

class AionSettings {
  constructor() {
    this.appName = 'AION';
    this.appVersion = fromEnv('APP_VERSION', '2.5.0');
    this.environment = fromEnv('ENVIRONMENT', 'production');
    this.apiKeys = csv(fromEnv('AION_API_KEYS', ''));
    this.adminKeys = csv(fromEnv('AION_ADMIN_KEYS', ''));
    this.corsOrigins = csv(fromEnv('CORS_ORIGINS', '*'));

    this.primaryModel = fromEnv('PRIMARY_MODEL', fromEnv('BITDEER_TEXT_MODEL', 'zai-org/GLM-5'));
    this.agentModel = fromEnv('AGENT_MODEL', 'mistralai/Mistral-Large-3-675B-Instruct-2512');
    this.fallbackModels = csv(fromEnv(
      'FALLBACK_MODELS',
      'zai-org/GLM-5,mistralai/Mistral-Large-3-675B-Instruct-2512'
    ));
    this.imageModel = fromEnv('BITDEER_IMAGE_MODEL', 'black-forest-labs/FLUX-2-pro');
    this.rerankModel = fromEnv('RERANKER_MODEL', fromEnv('BITDEER_RERANK_MODEL', 'BAAI/bge-reranker-v2-m3'));

    this.maxContextMessages = num('MAX_CONTEXT_MESSAGES', 40, 2, 200);
    this.maxMessageChars = num('MAX_MESSAGE_CHARS', 100_000, 1000, 1_000_000);
    this.minCompletionTokens = num('MIN_COMPLETION_TOKENS', 32, 1, 4096);
    this.maxCompletionTokens = num('MAX_COMPLETION_TOKENS', 4096, 64, 32768);
    this.requestTimeoutSeconds = num('REQUEST_TIMEOUT_SECONDS', 60, 5, 600);
  }

  isAdminKey(token) {
    return this.adminKeys.some(k => safeEq(k, token));
  }

  isUserKey(token) {
    return this.apiKeys.some(k => safeEq(k, token));
  }

  authRequired() {
    if (this.environment !== 'production') {
      return process.env.ALLOW_UNAUTHENTICATED_DEV !== 'true';
    }
    return true;
  }

  subjectFor(token) {
    if (!token) return 'anonymous';
    return 'key_' + createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  validateStartup() {
    if (this.authRequired() && this.apiKeys.length === 0) {
      throw new Error('AION_API_KEYS must be configured in production');
    }
    if (this.authRequired() && this.adminKeys.length === 0) {
      throw new Error('AION_ADMIN_KEYS must be configured in production');
    }
    const overlap = this.apiKeys.filter(k => this.adminKeys.includes(k));
    if (overlap.length > 0) {
      throw new Error('User and admin API keys must be distinct');
    }

    if (this.environment === 'production') {
      const keys = csv(
        process.env.BITDEER_API_KEYS
        || process.env.BITDEER_API_KEY
        || process.env.NVIDIA_API_KEYS
        || process.env.NVIDIA_API_KEY
        || ''
      );
      if (keys.length === 0) {
        throw new Error('BITDEER_API_KEY must be configured in production');
      }
      const models = [this.primaryModel, this.agentModel, ...this.fallbackModels];
      const invalid = models.filter(model => !isNvidiaCatalogModel(model));
      if (invalid.length > 0) {
        throw new Error(`Bitdeer-only policy rejected model(s): ${invalid.join(', ')}`);
      }
    }
  }
}

function isNvidiaCatalogModel(model) {
  if (typeof model !== 'string' || !model.trim()) return false;
  return [
    'zai-org/',
    'mistralai/',
    'black-forest-labs/',
    'BAAI/',
    'nvidia/',
    'moonshotai/',
    'deepseek-ai/',
    'meta/',
    'google/',
    'Qwen/',
    'MiniMaxAI/',
  ].some(prefix => model.startsWith(prefix));
}

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const aionSettings = new AionSettings();
export { isNvidiaCatalogModel };
