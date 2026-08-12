# Notes

## 2026-08-12 — memory, streaming, model upgrade (Claude)

Operator report: "it can't even remember the last thing I asked" + "I need a
stronger model than chat gpt mini" + wants nvidia/xai as alternatives to
OpenAI. Root-caused three separate, independent bugs in `/api/chat`
(`server.js`), all in the "durable memory / lattice / continuity" pipeline
that the README already advertises but wasn't actually wired up correctly:

1. **Session ID was never stable.** `memory.contextPack({ sessionId: req.id, ... })`
   and the matching `memory.rememberEpisode({ sessionId: req.id, ... })` both
   used `req.id`, which is `req.header('x-request-id') || randomUUID()` — a
   fresh random UUID on *every single HTTP request*, since no caller was
   sending a stable `x-request-id`. Every chat turn was recorded under a
   session ID that had never existed before and would never be looked up
   again. The `AgentMemory` SQLite store (`lib/memory.js`) works fine; it was
   just being asked to remember 30,000 one-message "sessions" instead of a
   handful of real conversations.
   Fix: `sessionId = req.body?.session_id || req.header('x-aion-session-id') || principal.subject || req.id`.
   The backend now forwards the frontend's stable per-conversation ID as
   `session_id`; falls back to the caller's subject, then to the old
   per-request behavior only as a last resort. Echoed back via
   `X-AION-Session-Id` so a caller with no ID of its own can still discover
   what got used.

2. **Memory pack was silently discarded even when found.** `contextPack()`
   returns `{ episodes, facts, goals }`. The code that built the system
   prompt read `memoryPack?.notes` — a field that has never existed on that
   object — so `notesContext` was always `''` regardless of bug #1. Fixed to
   actually read `episodes`/`facts`/`goals` and format them into the prompt.

3. **The remembered content was a placeholder.** `memory.rememberEpisode`
   was called once per turn with `content: 'aion.chat'` — a literal string,
   not the real reply — and the user's own message was never remembered at
   all. So even with #1 and #2 fixed, recall would have surfaced nothing
   useful. Fixed: the SSE stream loop now accumulates the real `delta` text
   as it's forwarded to the client, and both the user's message and the
   actual assistant reply are persisted as separate episodes after the
   stream ends.

**Model selection was also silently broken**, independent of the above:
`aionChain.stream({ messages, temperature, maxTokens })` was called without
a `chain` argument, and `AionChain.stream()`'s only fallback when `chain` is
empty was a hardcoded literal `'gpt-4o-mini'` in `aion_chain.js` — three
separate occurrences of it. `aionSettings.primaryModel`/`fallbackModels`
were loaded from env but never actually consulted for the live `/api/chat`
endpoint. This is why production was serving gpt-4o-mini regardless of what
`PRIMARY_MODEL` said.

- Added `AionChain.modelChainFromSettings()` — builds a real
  provider+model chain from `aionSettings.primaryModel`/`fallbackModels`,
  restricted to providers actually configured (has API key). `stream()` now
  uses this as its default instead of the hardcoded literal.
- `aionSettings.primaryModel` default: `gpt-4o-mini` → `gpt-5`.
  `fallbackModels` default: `gpt-4o,nvidia/nemotron-3-super-120b-a12b,deepseek/deepseek-chat`
  → `gpt-4.1,nvidia/nemotron-3-super-120b-a12b,grok-4` (deepseek dropped —
  no deepseek provider exists in this gateway; grok added since xAI is now
  supported).
- Added full xAI (Grok) provider support in `AionChain.fromEnv()` —
  `XAI_API_KEY`/`XAI_BASE_URL`, OpenAI-compatible at `api.x.ai/v1`, same
  pattern as the existing NVIDIA NIM wiring. Gets true token streaming for
  free since it reuses `OpenAIProvider`.
- **Cost heads-up:** gpt-5 costs substantially more per token than
  gpt-4o-mini. Worth confirming that's the intended tradeoff before this
  reaches production traffic.

**Streaming** itself was already real (not simulated) for OpenAI/NVIDIA/xAI
— `OpenAIProvider.streamChat()` does true SSE token streaming, and
`AionChain.stream()` prefers it over the chunked-fake-out fallback. No
changes needed there; the "answers don't feel live" complaint was almost
certainly the model-chain bug above (gpt-4o-mini's default provider still
streams, so the mechanism itself wasn't broken).

Verified: `npm test` — 13/13 unit + 14/14 gateway smoke + 10/10 AION smoke,
all pass, no regressions. Added the safety fallback so
`modelChainFromSettings()` degrades to the old single-provider default
when none of the configured model IDs match a known provider prefix
(e.g. EchoProvider-only test setups) — confirmed via the existing
`AionChain.stream falls back to simulated when no streamChat` test.
