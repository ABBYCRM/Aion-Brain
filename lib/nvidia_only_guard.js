// lib/nvidia_only_guard.js
// Strip non-Bitdeer provider keys before server.js builds the /v1 chain.
// Chat/embeddings/images/rerank go through api-inference.bitdeer.ai.
for (const key of [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'A2E_API_KEY',
  'XAI_API_KEY',
]) {
  delete process.env[key];
}
