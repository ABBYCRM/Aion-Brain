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

## 0.1.8 — fix: production defects from 0.1.7 audit
- CORS: added `x-aion-key` to `access-control-allow-headers` so browser preflight succeeds when the AION auth header is sent.
- Startup: fail-closed on missing `AION_API_KEYS` / `AION_ADMIN_KEYS` in production (was a soft warning, now `process.exit(1)`). Dev escape hatch `ALLOW_UNAUTHENTICATED_DEV=true` in non-production preserved.
- AionChain: documented simulated streaming in a top-of-method NOTE; added `"streaming": "simulated"` to the `done` SSE event payload.
- AionChain: provider selection is now name-based. `stream({ chain })` walks the requested `order` and resolves each entry via a `byName` Map; unknown providers emit `error` and continue. The previous index-based selection silently ignored requested provider names.
- README: file map includes the AION modules; AION section notes the simulated-streaming limitation and the CORS header.

## 0.1.9 — feat: Brain default research (DuckDuckGo HTML)
- `lib/research.js` — new module. `defaultResearch(query, opts)` fetches the public DuckDuckGo HTML endpoint (no API key), parses organic result blocks, unwraps `/l/?uddg=…` redirects, and strips HTML entities. Hard 12s timeout via `AbortSignal.timeout`. Returns up to 5 hits, never throws.
- `parseDdgHtml`, `unwrapDdgUrl`, `stripHtml` are exported and unit-tested in isolation.
- `lib/brain.js` — Brain constructor now defaults to `defaultResearch` (was a no-op stub). `enableResearch: false` opt-out for tests. Cleaner query: strips `P0-foo-bar:` prefixes and uses the natural-language message instead of `site:github.com` operators (DDG's HTML endpoint returns nothing for those).
- The Brain cycle now records `research_provider: "duckduckgo-html"` (or `"custom"`) in its result. Verified with a real brain cycle: 3/12 proposals received real Stack Overflow / GitHub / MDN hits in this run; the rest returned honest `no_results`. None of them flipped `safe_to_apply` (still false without a verified local patch).
- `test/test-research.mjs` — 11 tests: 10 offline unit + 1 live DDG smoke (accepts real hits or honest-empty markers; never throws).
- User-Agent defaults to a real Chrome UA to reduce DDG bot-challenge likelihood; overridable via `DDG_USER_AGENT` env var.
- All 11 + 8 + 10 + 6 + 14 = 49 tests pass; self-audit `VERIFIED_COMPLETE` (P0=0, 18 verified fixes, 0 unverified).

