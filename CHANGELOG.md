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
