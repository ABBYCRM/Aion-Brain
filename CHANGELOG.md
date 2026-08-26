# llm-gateway changelog

All notable changes to this project will be documented in this file.

## 0.1.13 — feat: NVIDIA-first LLM, ECC skill auto-router, DuckDuckGo + Reddit + Steel.dev tools
- Primary model now `meta/llama-3.1-8b-instruct` (NVIDIA NIM). Fallbacks: `nvidia/nemotron-3-nano-30b-a3b`, `grok-4-fast-reasoning`, `gpt-4.1-mini`, `claude-3-5-haiku-latest`.
- New `lib/skill_catalog.js` — parses the ECC Complete AI Skill Pack (286 skills) into an in-memory index. Lazy-loads full bodies on demand.
- New `lib/skill_router.js` — uses NVIDIA `nvidia/nemotron-mini-4b-instruct` as a fast JSON reranker to pick the top-K most relevant skills for a user message. Falls back to lexical search if the reranker fails.
- New `lib/duckduckgo.js` — DuckDuckGo HTML searcher (no API key). Wires into the kernel-level `web_search` tool so direct callers (curl, scripts) get a working search out of the box.
- New `lib/steel_browser.js` — Steel.dev thin client. `createSession`, `getContent`, `runActions`, `fetchUrl(url)` convenience.
- New `lib/brain_tools.js` tools: `reddit_search` (public Reddit JSON), `steel_browser`, `pick_skill`, `load_skill`. Existing `web_search` now backed by DDG.
- New HTTP routes:
  - `GET  /api/skills`              — full catalog (name, title, description, path)
  - `GET  /api/skills/:name`        — full skill body
  - `POST /api/skills/pick`         — reranker (or lexical) for a query
  - `POST /api/skills/context`      — load N skill bodies for prompt injection
- `/api/chat` now auto-picks skills per message and prepends their bodies to the system prompt. A new `type: "skills"` SSE event reports the source (reranker / lexical / empty), the included skill names, and the raw model output.
- `/api/chat` also exposes `X-AION-Skills-Source` and `X-AION-Skills-Count` response headers for non-streaming clients.

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


## 0.1.9 — feat: true token streaming
- `OpenAIProvider.streamChat()` — real SSE token stream from OpenAI-compatible endpoints (OpenAI, NVIDIA NIM, etc.).
- `AionChain.stream()` prefers true streaming when `provider.streamChat` exists; falls back to simulated chunking for providers that lack it (Echo, Anthropic until added).
- `done` and `open` SSE events now carry `"streaming": "true"` or `"streaming": "simulated"`.
- SSE event contract unchanged: attempt → open → delta* → done → [DONE].

## 0.1.10 — fix: provider name collision + research + safeEq
- `OpenAIProvider` accepts optional `name` (default `openai`) so NVIDIA NIM registers as `nvidia` and does not overwrite the openai entry in AionChain's byName Map.
- `AionChain.fromEnv` sets `name: 'nvidia'` for the NVIDIA provider.
- `safeEq` is null-safe (non-string tokens never match; no throw).
- `brain.js` default research is now a real keyless DuckDuckGo HTML search (no stub). Callers may supply a richer researchFn when available.

## 0.1.11 — feat: full runtime layers + AION-facing contract surface
- `lib/vault.js` — AES-256-GCM encrypted secret store in Node; hydrate env at boot; admin rotate/reveal/delete.
  **Implemented but not yet wired to any route** — `server.js` does not import
  `lib/vault.js`, so there is no `/api/vault*` surface yet. Wiring it up is
  real new admin-auth-gated secret-reveal/rotate attack surface and is
  planned as its own reviewed change, not bundled into this entry.
- `lib/memory.js` — durable SQLite episodic memory, facts, goals; contextPack for prompt injection. Exposed read-only via `GET /api/memory/episodes` (admin only).
- `lib/state.js` — active free-energy state (energy/uncertainty/stress); decisionBias prefers DEFER when F high.
- `lib/tools.js` — brain-owned tools: web_search (DDG), github_repo/file/search (token from vault/env). Not currently imported by `server.js` (see `lib/brain_tools.js` below for the tool registry that actually backs `/api/tools*`).
- `lib/lattice.js` — multi-agent lattice (researcher/critic/executor) with majority consensus + critic veto.
- `lib/brain.js` — closed research→evidence-backed proposals with citations; memory episode logging.
- `lib/brain_tools.js` — `ToolRegistry` with deterministic + side-effect-free tools (echo, datetime, free_energy, web_search) for lattice demos and AION tool-injection; backs the `/api/tools*` routes below.
- `/api/chat` integrates tools, memory, lattice, active state into decision + SSE.
- New routes, all requiring `AION_API_KEYS` (auth same shape as `/api/decision`):
  - `GET  /api/state` — primary_model, fallback_models, providers, laws, states, uptime. Used by the AION Python backend on boot to verify the Brain it will talk to is the right version with the right providers.
  - `GET  /api/tools` — catalog of kernel-level tools (echo, datetime, free_energy, web_search)
  - `POST /api/tools/:name` — run a tool, return `{ok, evidence}`
  - `GET  /api/memory/episodes` — admin only
- 5 new contract tests (`test/contract-aion-modules.mjs`); 37/37 tests green on this version.

