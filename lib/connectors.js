// lib/connectors.js
// Configured-integration inventory for HTTP + CCFL. Names and booleans only.
// Secret values are never copied into the returned objects.
// Uses loadedSecret (vault / snapshot / env) — not env-only.

import { envSecret } from './external_tools.js';

const CONNECTORS = Object.freeze([
  { name: 'bitdeer', kind: 'inference', env: ['BITDEER_API_KEY', 'BITDEER_API_KEYS'], when: 'BITDEER-PRIMARY production chat / rerank / images. primaryModel and agentModel stay on the Bitdeer nvidia catalog.' },
  { name: 'nvidia', kind: 'inference', env: ['NVIDIA_API_KEY', 'NVIDIA_API_KEYS'], when: 'Bitdeer alias keys. Same fail-closed /v1 + /api/chat chain as bitdeer.' },
  { name: 'openai', kind: 'inference', env: ['OPENAI_API_KEY'], when: 'Optional side tool only: openai_chat / openai_embed when the operator names OpenAI. Never a production chat default. Fail-soft if missing.' },
  { name: 'embeddings', kind: 'inference', env: ['EMBEDDINGS_API_KEY'], when: 'Use embeddings_embed for hosted vectors (Bitdeer/OpenAI-compatible). Fallback for TeacherRAG and pinecone text queries.' },
  { name: 'gemini', kind: 'inference', env: ['GEMINI_API_KEY'], when: 'Optional side tool only: gemini_chat when the operator names Gemini. Never a production chat default. Fail-soft if missing.' },
  { name: 'xai', kind: 'inference', env: ['XAI_API_KEY'], when: 'Optional side tool only: xai_chat when the operator names Grok/xAI. Never a production chat default. Key is snapshotted before the Bitdeer /v1 guard.' },
  { name: 'kimi', kind: 'inference', env: ['KIMI_API_KEY'], when: 'Optional side tool only: kimi_chat when the operator names Kimi. Never a production chat default. Fail-soft if missing.' },
  { name: 'youtube', kind: 'search', env: ['YOUTUBE_API_KEY'], when: 'Use youtube_search / youtube_video for YouTube Data API v3. Not a scrape; official search + video lookup.' },
  { name: 'steel', kind: 'browser', env: ['STEEL_API_KEY'], when: 'One-shot public-web scrape (steel_browser). Interactive browsing uses steel_actions.' },
  { name: 'firecrawl', kind: 'scrape', env: ['FIRECRAWL_API_KEY'], when: 'Scrape fallback when Steel fails; structured markdown (firecrawl_scrape).' },
  { name: 'tavily', kind: 'search', env: ['TAVILY_API_KEY'], when: 'Preferred live web_search / tavily_search when set.' },
  { name: 'exa', kind: 'search', env: ['EXA_API_KEY'], when: 'web_search fallback (exa_search).' },
  { name: 'scrapingbee', kind: 'scrape', env: ['SCRAPINGBEE_API_KEY'], when: 'HTML scrape fallback; JS-rendered pages.' },
  { name: 'scrapfly', kind: 'scrape', env: ['SCRAPFLY_API_KEY'], when: 'Last scrape fallback; anti-bot pages.' },
  { name: 'screenshotone', kind: 'scrape', env: ['SCREENSHOTONE_ACCESS_KEY'], when: 'Signed page screenshots (screenshotone).' },
  { name: 'composio', kind: 'actions', env: ['COMPOSIO_API_KEY'], when: 'ak_ live actions: composio_list_tools → composio_tool_schema → composio_action. ck_/oak_ fail soft.' },
  { name: 'e2b', kind: 'sandbox', env: ['E2B_API_KEY'], when: 'Run untrusted code in a hosted sandbox (e2b_run).' },
  { name: 'hedra', kind: 'media', env: ['HEDRA_API_KEY'], when: 'hedra_status lists models. hedra_generate submits a v3 job; hedra_job polls it. Operator-requested generate only.' },
  { name: 'resend', kind: 'email', env: ['RESEND_API_KEY'], when: 'Transactional email (resend_send). Operator-requested only.' },
  { name: 'github', kind: 'scm', env: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN'], when: 'GitHub REST (github_repo).' },
  { name: 'gdy', kind: 'osint', env: ['GDY_API_KEY', 'GDY_API_KEY_ALT'], when: 'OSINT RAG (gdy_search, gdy_rag_context, gdy_categories, gdy_tools).' },
  { name: 'cursor', kind: 'agents', env: ['CURSOR_API_KEY'], when: 'cursor_launch / cursor_status / cursor_reply / cursor_cancel. Brain owns the client; CCFL proxies the same names.' },
  { name: 'pinecone', kind: 'rag', env: ['PINECONE_API_KEY'], when: 'pinecone_query / pinecone_upsert. Merged into bos_omega_retrieve and memory_write_fact when PINECONE_INDEX_HOST is set.' },
  { name: 'inngest', kind: 'jobs', env: ['INNGEST_EVENT_KEY'], when: 'Optional fan-out for spawned agent jobs.' },
  { name: 'n8n_mcp', kind: 'mcp', env: ['N8N_MCP_TOKEN'], when: 'n8n MCP handshake (n8n_status / n8n_tools / n8n_call).' },
  { name: 'n8n_api', kind: 'automation', env: ['N8N_API_KEY'], when: 'n8n public API workflow list (n8n_workflows).' },
]);

const MCP_SERVERS = Object.freeze([
  {
    name: 'n8n',
    url_env: 'N8N_MCP_URL',
    token_env: 'N8N_MCP_TOKEN',
  },
]);

function configuredFrom(envNames) {
  return envNames.some((name) => Boolean(envSecret(name)));
}

export function listConnectors() {
  return CONNECTORS.map((c) => ({
    name: c.name,
    kind: c.kind,
    configured: configuredFrom(c.env),
    env_names: [...c.env],
    when: c.when,
  }));
}

export function mcpStatus() {
  return {
    ok: true,
    servers: MCP_SERVERS.map((s) => ({
      name: s.name,
      kind: 'mcp',
      configured: Boolean(envSecret(s.token_env)),
      url_configured: Boolean(envSecret(s.url_env)),
      token_configured: Boolean(envSecret(s.token_env)),
      env_names: [s.url_env, s.token_env],
    })),
  };
}

/** JSON-safe snapshot used by GET /api/connectors and GET /api/mcp/status. */
export function connectorsSnapshot() {
  const connectors = listConnectors();
  const mcp = mcpStatus();
  return {
    ok: true,
    connectors,
    mcp: mcp.servers,
    configured: connectors.filter((c) => c.configured).map((c) => c.name),
    count: connectors.length,
    configured_count: connectors.filter((c) => c.configured).length,
  };
}
