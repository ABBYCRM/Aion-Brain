# llm-gateway changelog

All notable changes to this project will be documented in this file.

## 0.1.0 — 2026-08-04
- Initial release.

## 0.1.1 — fix: server.js
- `gracefulShutdown` handler added (SIGTERM/SIGINT).

## 0.1.2 — fix: server.js
- `requestId` propagation; x-request-id header on every response.

## 0.1.3 — fix: server.js
- `express.json` explicit body limit (`1mb`).

## 0.1.4 — fix: lib/router.js
- `fetchWithTimeout` helper; all provider `fetch` calls use `AbortSignal.timeout(30000)`.

## 0.1.5 — fix: hardened parse + rule noise
- All provider `JSON.parse` now try/catch → typed `invalid_json` error (OpenAI, A2E, Anthropic).
- `Store.lastAudit` guards corrupt report_json.
- `P1-process-exit` rule ignores `bin/`, `test/`, and graceful-shutdown contexts.

## 0.1.6 — feat: BOS-OMEGA Brain layer
- `lib/brain.js` — closed-loop audit → research → propose cycle.
- `POST /brain/audit-and-fix` — run full cycle (propose_only by default).
- `GET /brain/status` — brain capability + policy.
- Policy: never write unverified / hallucinated patches. Only re-apply already-verified local fixes.

## 0.1.7 — feat: AION API integration (port of AION v2.4.0 contract)
- `lib/aion_kernel.js` — 7-law kernel (REALITY / CONTINUITY / FIDELITY / LATTICE / EPISTEMIC / PERPETUITY / DECISION), MissionContext, resolveDecision, buildSystemPrompt, AION_CONTINUITY_PACK.
- `lib/aion_settings.js` — frozen Settings loaded from env. Mirrors AION v2 backend's `app/settings.py`. Validates startup (fail-closed: requires AION_API_KEYS + AION_ADMIN_KEYS in production).
- `lib/aion_chain.js` — AionChain async generator emitting the exact SSE event names AION v2 emits: decision, attempt, open, delta, done, error, [DONE]. Provider chain: OpenAI → NVIDIA NIM → Anthropic → Echo. AION_ECHO_ONLY=1 forces hermetic echo for tests.
- server.js: new AION API routes on top of the existing OpenAI-compatible /v1/* surface:
  - GET  /api/continuity-pack — 7 laws + 3 decision states (public)
  - GET  /api/models — chain + providers (requires AION key)
  - GET  /api/audit/recent — last audit (admin only)
  - POST /api/decision — 7-law kernel decision for a single user_input
  - POST /api/chat — full SSE chat with decision metadata + streaming deltas (max_tokens, role restriction, CORS-allowed)
- All AION API routes accept `X-AION-Key` header or `Authorization: Bearer ...`. Constant-time key compare via `safeEq` in `aion_settings.js`.
- 8 new contract tests (`test/contract-aion-modules.mjs`) + 10 new AION smoke tests (`test/smoke-aion.mjs`).
- The existing 14 smoke tests still pass (the new module is additive; the OpenAI-compatible /v1/* surface is unchanged).

