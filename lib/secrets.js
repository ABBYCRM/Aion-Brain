// lib/secrets.js
// Resolve operator-loaded keys from vault, then a boot snapshot, then env.
// Chat-provider keys are stripped from process.env so /v1 stays Bitdeer-only;
// tools still read the snapshot. Secret values are never logged.

import { createVault } from './vault.js';

export const CHAT_STRIP_KEYS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'A2E_API_KEY',
  'XAI_API_KEY',
]);

export const PROVIDER_SECRET_NAMES = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'A2E_API_KEY',
  'XAI_API_KEY',
  'XAI_BASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'KIMI_MODEL',
  'YOUTUBE_API_KEY',
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_MODEL',
  'PINECONE_API_KEY',
  'PINECONE_INDEX',
  'PINECONE_INDEX_HOST',
  'PINECONE_ENVIRONMENT',
  'PINECONE_NAMESPACE',
  'HEDRA_API_KEY',
  'HEDRA_DEFAULT_MODEL',
  'COMPOSIO_API_KEY',
  'BITDEER_API_KEY',
  'BITDEER_API_KEYS',
  'NVIDIA_API_KEY',
  'NVIDIA_API_KEYS',
  'CURSOR_API_KEY',
]);

const SNAPSHOT = Object.create(null);
let vaultRef = null;

export function snapshotSecrets(names = PROVIDER_SECRET_NAMES) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() && SNAPSHOT[name] == null) {
      SNAPSHOT[name] = String(v).trim();
    }
  }
  return Object.keys(SNAPSHOT).length;
}

export function stripChatProviderEnv() {
  snapshotSecrets(CHAT_STRIP_KEYS);
  for (const key of CHAT_STRIP_KEYS) delete process.env[key];
}

export function attachVault(vault) {
  vaultRef = vault && vault.enabled ? vault : null;
  return Boolean(vaultRef);
}

export function bootVault() {
  const vault = createVault();
  if (vault.enabled) vault.hydrateEnv();
  attachVault(vault);
  snapshotSecrets();
  stripChatProviderEnv();
  return vault;
}

export function loadedSecret(name) {
  const env = process.env[name];
  if (env != null && String(env).trim()) return String(env).trim();
  if (SNAPSHOT[name]) return SNAPSHOT[name];
  if (vaultRef) {
    try {
      const v = vaultRef.get(name);
      if (v != null && String(v).trim()) return String(v).trim();
    } catch { /* vault disabled or corrupt entry */ }
  }
  return '';
}

export function hasLoadedSecret(name) {
  return Boolean(loadedSecret(name));
}

export function forgetSecretForTests(name) {
  delete SNAPSHOT[name];
  delete process.env[name];
}

export function rememberSecretForTests(name, value) {
  if (value == null || value === '') {
    forgetSecretForTests(name);
    return;
  }
  SNAPSHOT[name] = String(value).trim();
  process.env[name] = String(value).trim();
}

/** Booleans only — never key material. */
export function loadedSecretFlags(names = PROVIDER_SECRET_NAMES) {
  const out = {};
  for (const name of names) out[name] = hasLoadedSecret(name);
  return out;
}
