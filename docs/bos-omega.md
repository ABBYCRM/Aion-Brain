# BOS-OMEGA + Grok-Bot parity (Aion-Brain)

Values for every key below belong in DigitalOcean / the host secret store. This file lists **names only**.

## Prove BOS retrieval (no paid APIs)

```bash
node --test test/bos_omega_rag.test.mjs
node bin/bos-omega.mjs retrieve "Trinity"
node bin/bos-omega.mjs retrieve "Weldon Angelos"
```

Or against a running brain:

```bash
curl -s -H "X-AION-Key: $AION_API_KEY" "$AION_BASE_URL/api/memory/bos?q=Trinity"
```

## Dynamic spawn (CCFL / frontend)

```http
POST /api/agents/spawn
{ "goal": "...", "tools": ["datetime","bos_omega_retrieve"], "acceptance": [{"id":"dt","tool":"datetime"}] }
GET  /api/agents/:id
GET  /api/agents/:id/result
POST /api/agents/:id/steer   { "message": "..." }
POST /api/agents/:id/stop
POST /api/agents/:id/cleanup
```

Jobs persist in `$LLM_GATEWAY_DATA_DIR/agent-jobs.sqlite`. The in-process worker claims them. If `INNGEST_EVENT_KEY` is set, `aion/agent.spawned` and `aion/agent.finished` are also POSTed to Inngest (`INNGEST_EVENT_URL`, default `https://inn.gs/e`). Inngest is optional fan-out; SQLite is the source of truth so a restart does not drop queued work.

## Env names the runtime reads

Auth / process: `ENVIRONMENT`, `AION_API_KEYS`, `AION_ADMIN_KEYS`, `ALLOW_UNAUTHENTICATED_DEV`, `AION_ECHO_ONLY`, `PORT`, `LLM_GATEWAY_DATA_DIR`, `LLM_GATEWAY_REPORTS_DIR`, `APP_VERSION`, `CORS_ORIGINS`

Bitdeer / embeddings: `BITDEER_API_KEY`, `BITDEER_API_KEYS`, `BITDEER_BASE_URL`, `BITDEER_TEXT_MODEL`, `BITDEER_IMAGE_MODEL`, `BITDEER_RERANK_MODEL`, `BITDEER_EMBED_MODEL`, `NVIDIA_API_KEY`, `NVIDIA_API_KEYS`, `NVIDIA_BASE_URL`, `PRIMARY_MODEL`, `AGENT_MODEL`, `FALLBACK_MODELS`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`, `RERANKER_MODEL`, `RERANKER_PROVIDER`, `HELICONE_API_KEY`, `HELICONE_ENABLED`

Documented but stripped at boot by `lib/nvidia_only_guard.js`: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `A2E_API_KEY`, `XAI_API_KEY` (`XAI_BASE_URL`). Also listed for DO: `GEMINI_API_KEY`, `KIMI_API_KEY`.

Tools: `STEEL_API_KEY`, `STEEL_BASE_URL`, `FIRECRAWL_API_KEY`, `FIRECRAWL_BASE_URL`, `TAVILY_API_KEY`, `EXA_API_KEY`, `SCRAPINGBEE_API_KEY`, `SCRAPFLY_API_KEY`, `SCREENSHOTONE_ACCESS_KEY`, `SCREENSHOTONE_SECRET_KEY`, `COMPOSIO_API_KEY`, `E2B_API_KEY`, `HEDRA_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITHUB_TOKEN`, `GDY_API_KEY`, `GDY_API_KEY_ALT`, `GDY_API_BASE`, `GDY_BASE_URL`

RAG / jobs: `PINECONE_API_KEY`, `PINECONE_INDEX`, `PINECONE_INDEX_HOST`, `PINECONE_ENVIRONMENT`, `PINECONE_NAMESPACE`, `INNGEST_EVENT_KEY`, `INNGEST_EVENT_URL`, `TEACHER_RAG_PYTHON`, `TEACHER_RAG_TIMEOUT_MS`

n8n: `N8N_MCP_URL`, `N8N_MCP_TOKEN`, `N8N_API_URL`, `N8N_API_KEY`, `N8N_BASE_URL`, `N8N_WEBHOOK_TOKEN`, `N8N_EXECUTABLE_WORKFLOW_IDS`
