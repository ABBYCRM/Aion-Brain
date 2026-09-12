// lib/connectors.js
// Configured-integration inventory for HTTP + CCFL. Names and booleans only.
// Secret values are never copied into the returned objects.

import { envSecret } from './external_tools.js';

const CONNECTORS = Object.freeze([
  { name: 'bitdeer', kind: 'inference', env: ['BITDEER_API_KEY', 'BITDEER_API_KEYS'] },
  { name: 'nvidia', kind: 'inference', env: ['NVIDIA_API_KEY', 'NVIDIA_API_KEYS'] },
  { name: 'embeddings', kind: 'inference', env: ['EMBEDDINGS_API_KEY'] },
  { name: 'steel', kind: 'browser', env: ['STEEL_API_KEY'] },
  { name: 'firecrawl', kind: 'scrape', env: ['FIRECRAWL_API_KEY'] },
  { name: 'tavily', kind: 'search', env: ['TAVILY_API_KEY'] },
  { name: 'exa', kind: 'search', env: ['EXA_API_KEY'] },
  { name: 'scrapingbee', kind: 'scrape', env: ['SCRAPINGBEE_API_KEY'] },
  { name: 'scrapfly', kind: 'scrape', env: ['SCRAPFLY_API_KEY'] },
  { name: 'screenshotone', kind: 'scrape', env: ['SCREENSHOTONE_ACCESS_KEY'] },
  { name: 'composio', kind: 'actions', env: ['COMPOSIO_API_KEY'] },
  { name: 'e2b', kind: 'sandbox', env: ['E2B_API_KEY'] },
  { name: 'hedra', kind: 'media', env: ['HEDRA_API_KEY'] },
  { name: 'resend', kind: 'email', env: ['RESEND_API_KEY'] },
  { name: 'github', kind: 'scm', env: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN'] },
  { name: 'gdy', kind: 'osint', env: ['GDY_API_KEY', 'GDY_API_KEY_ALT'] },
  { name: 'cursor', kind: 'agents', env: ['CURSOR_API_KEY'] },
  { name: 'pinecone', kind: 'rag', env: ['PINECONE_API_KEY'] },
  { name: 'inngest', kind: 'jobs', env: ['INNGEST_EVENT_KEY'] },
  { name: 'n8n_mcp', kind: 'mcp', env: ['N8N_MCP_TOKEN'] },
  { name: 'n8n_api', kind: 'automation', env: ['N8N_API_KEY'] },
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
