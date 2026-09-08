// lib/nvidia_only_guard.js
// Side-effect import: strip non-NVIDIA provider keys before server.js
// builds the /v1 chain. /api/chat already uses AionChain.fromEnv (NVIDIA-only).
// This keeps OpenAI / xAI / A2E / Anthropic from being constructed even if
// those env vars exist on the host.
for (const key of [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'A2E_API_KEY',
  'XAI_API_KEY',
]) {
  delete process.env[key];
}
