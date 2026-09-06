# VIDEO-Engine-CCFL ↔ Aion-Brain contract

Claw (`lib/claw/*`, `/api/claw/*` in VIDEO-Engine-CCFL) already talks to
Aion-Brain. This document is the **execution** contract so Claw can run
brain tools without a dead loop (think-forever, pretend-COMPLETE, identical
retries).

## Why the old path looped

`POST /api/chat` was a single-shot consult: kernel + lattice + stream.
`toolEvidence` was hard-coded `null`. Provider streaming dropped
`tool_calls` and `reasoning_content`. The model could reason indefinitely
and never take an ACTION. Claw's `aionConsult` only collected `delta` text.

## What Aion-Brain now enforces (code, not prompts)

Every `/api/claw/execute` (and `/api/agent/run`, and `/api/chat` with
`agentic: true`) runs the SELF_STATE control loop:

1. **SELF-OBSERVATION** — snapshot the required SELF_STATE fields
2. **SELF-MONITORING** — `HEALTHY | DEGRADED | LOOP_DETECTED | BLOCKED | UNSTABLE`
3. **INTROSPECTION** — issue taxonomy (no-progress, repeated failure, think-without-action, unverified assumption, missing evidence, false completion)
4. **METACOGNITION** — force strategy change / require ACTION
5. **SELF-REFLECTION** — expected vs observed; confidence is not proof
6. **METACONTROL** — anti-duplicate + anti-unverified-assumption gates
7. **ACTION** — execute a real tool, respond, or halt. Intended calls are not treated as done.
8. **TERMINATION CHECK** — `COMPLETE` only when acceptance criteria are verified by tool evidence

Anti-loop: the same strategy failing **≥ 2** times with no new evidence
marks `LOOP_DETECTED`, forbids that strategy, and rejects an identical
tool+args fingerprint.

Epistemic tags on facts and tool results: `KNOWN / INFERRED / ASSUMED / UNKNOWN / CONTRADICTED`.
Assumptions never become `known_facts`.

## Endpoints

Auth on all of these: `X-AION-Key` or `Authorization: Bearer` matching
`AION_API_KEYS`. Same keys Claw already uses (`AION_BASE_URL` + `AION_API_KEY`).

| Claw should call | Method | Purpose |
|---|---|---|
| `/api/state` | GET | Health. Now includes `agent_model`, `control_loop.phases`, `control_loop.tools_configured` (booleans only), `control_loop.composio_key_type` |
| `/api/claw/contract` | GET | Machine-readable copy of this contract |
| `/api/claw/execute` | POST | **Preferred execution path.** Runs the loop and returns SELF_STATE + tool results |
| `/api/agent/run` | POST | Alias of `/api/claw/execute` |
| `/api/claw/tools` | GET | Tool catalog (same as `/api/tools`) |
| `/api/claw/tools/:name` | POST | Run one tool (same as `/api/tools/:name`) |
| `/api/chat` | POST | Consult. Add `"agentic": true` to run the loop inside the existing SSE stream (`decision` / `delta` / `done` preserved for `aionConsult`) |

### `POST /api/claw/execute` body

```json
{
  "goal": "operator task",
  "acceptance": [
    { "id": "search", "description": "live search ran", "tool": "web_search" }
  ],
  "session_id": "claw:<conversationId>",
  "max_cycles": 8,
  "stream": false
}
```

`prompt` or OpenAI-shaped `messages` are accepted if `goal` is omitted
(Claw can keep sending the same shape as `aionConsult`).

JSON response (default):

```json
{
  "ok": true,
  "source": "aion-brain",
  "status": "COMPLETE | INCOMPLETE | BLOCKED",
  "complete": false,
  "verified": false,
  "answer": "operator-facing text",
  "session_id": "claw:…",
  "self_state": { "previous_tool_results": [], "health": "…", "progress": 0 },
  "cycles": [{ "health": "LOOP_DETECTED", "issues": [], "action": { "kind": "tool", "tool": "datetime", "ok": true } }],
  "previous_tool_results": []
}
```

`status` is `COMPLETE` only when every acceptance check has `verified: true`
and an `evidence_id` pointing at a successful tool result. A model saying
COMPLETE, or a high confidence score, is not enough.

SSE (`Accept: text/event-stream` or `"stream": true`) emits
`self_state`, `phase`, `delta`, `done`, `[DONE]` so Claw can reuse its
existing stream parser.

## Tools Claw can invoke on the brain

Existing: `n8n_*`, `web_search`, `reddit_search`, `steel_browser`,
`pick_skill`, `load_skill`, `echo`, `datetime`, `free_energy`.

New (env-backed, fail-soft if the key is missing — **no fabricated success**):

| Tool | Env | Notes |
|---|---|---|
| `tavily_search` | `TAVILY_API_KEY` | Preferred live search when set |
| `exa_search` | `EXA_API_KEY` | |
| `firecrawl_scrape` | `FIRECRAWL_API_KEY` | Public URLs only |
| `scrapingbee_scrape` | `SCRAPINGBEE_API_KEY` | |
| `scrapfly_scrape` | `SCRAPFLY_API_KEY` | |
| `screenshotone` | `SCREENSHOTONE_ACCESS_KEY` + `SCREENSHOTONE_SECRET_KEY` | HMAC-SHA256 over the canonical query; secret never sent as a query param (CaseClosedFL / VIDEO-Engine pattern) |
| `composio_health` / `composio_action` | `COMPOSIO_API_KEY` | **`ak_` only** (project REST). `ck_` consumer MCP and `oak_` keys fail soft with a typed error |
| `e2b_run` | `E2B_API_KEY` | Reports the real sandbox create result |
| `hedra_status` | `HEDRA_API_KEY` | Read-only model list; does not start a video job |
| `resend_send` | `RESEND_API_KEY` | Side-effecting; operator-requested only |
| `github_repo` | `GITHUB_PERSONAL_ACCESS_TOKEN` (or `GITHUB_TOKEN`) | |
| `gdy_search` / `gdy_rag_context` / `gdy_categories` / `gdy_tools` | `GDY_API_KEY` (optional `GDY_API_KEY_ALT` on 401) | Luis GDY OSINT tool directory. Base: `GDY_API_BASE` or `GDY_BASE_URL` + `/v1` |
| `arxiv_search` | none | Official arXiv Atom API (`export.arxiv.org`). No GDY key |

`web_search` uses Tavily, then Exa, then DuckDuckGo.

`STEEL_API_KEY` already backs `steel_browser`. `NVIDIA_API_KEY` /
`NVIDIA_API_KEYS` / `NVIDIA_BASE_URL` already back the NIM chain.
`HELICONE_API_KEY`, when set, is attached as `Helicone-*` headers on NIM
calls; a bad Helicone key does not invent results.

## NVIDIA models

Defaults (overridable):

- `PRIMARY_MODEL` = `nvidia/nemotron-3-super-120b-a12b` (confirmed on integrate.api.nvidia.com in VIDEO-Engine)
- `AGENT_MODEL` = `nvidia/nemotron-3-ultra-550b-a55b` (stronger agentic NIM; falls back if the key cannot reach it)
- `FALLBACK_MODELS` = `moonshotai/kimi-k2.6,nvidia/nemotron-3-super-120b-a12b,nvidia/nemotron-3-nano-30b-a3b,…`

The runtime preserves `reasoning_content` and `tool_calls` across turns.
A reasoning-only turn is **not** progress; METACONTROL forces an ACTION
(native `tool_calls` or Claw `<tool_call name="…">{…}</tool_call>`).

## Recommended Claw change

Keep `aion_status` / `aion_consult` as-is for advice.

For work that must use tools, call `POST {AION_BASE_URL}/api/claw/execute`
with the operator goal and acceptance checks, then treat
`previous_tool_results` as the only evidence. Do not mark the Claw
execution verified from Aion prose.

`aionConsult` can also send `"agentic": true` on `/api/chat` without a
Claw code change to the SSE parser.
