# llm-gateway changelog

All notable changes are recorded here. Backtick claims are checked for exact path or source-token presence by the bounded static auditor; they are not behavioral proof.

## 0.2.0 — security and runtime hardening — 2026-08-04

- Fixed `CircuitBreaker` failure accounting and cooldown behavior in `lib/router.js`.
- Added separate `x-gateway-key` and `x-admin-token` authentication boundaries.
- Added `asyncRoute` rejection forwarding for Express 4 handlers.
- Added multipart forwarding for image edits and video creation in `server.js`.
- Added truthful bounded assurance status `STATIC_HEALTH_VERIFIED`.
- Added clean-install CI in `.github/workflows/ci.yml`.
- Added behavioral unit coverage in `test/unit.mjs`.

## 0.1.4 — fix: lib/router.js

- `fetchWithTimeout` applies an abort deadline to provider requests.

## 0.1.3 — fix: server.js

- `express.json` has an explicit body limit.

## 0.1.2 — fix: server.js

- `requestId` propagation is supported with an `x-request-id` response header.

## 0.1.1 — fix: server.js

- `shutdown` drains the HTTP server and closes SQLite.

## 0.1.0 — 2026-08-04

- Initial release.
