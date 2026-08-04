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
