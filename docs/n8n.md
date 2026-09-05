# n8n connection

Aion now exposes `n8n_status`, `n8n_tools`, `n8n_call`, and `n8n_workflows`
through its authenticated `/api/tools/:name` API. Claw uses `aion_n8n` to reach
these tools. No credentials are passed in model arguments.

Set server-only environment variables:

- `N8N_MCP_URL`: defaults to `https://paisabrazil.app.n8n.cloud/mcp-server/http`.
- `N8N_MCP_TOKEN`: the raw MCP access token, without `Bearer`, quotes or Markdown escaping.
- `N8N_API_KEY`: optional separate public API key for workflow metadata listing.
- `N8N_API_URL`: defaults to `https://paisabrazil.app.n8n.cloud/api/v1/`.
- `N8N_ALLOWED_TOOLS`: comma-separated tool names; defaults to
  `search_workflows,get_workflow_details`. Workflow execution/writes are disabled
  unless the operator explicitly adds the exact tool name. Discover schemas first.

The MCP client handles initialization, session headers, JSON/SSE responses,
pagination, timeouts, size limits and session cleanup. It does not retry calls
that could already have performed an action. Structured results are preserved.
Public API listing returns metadata for the first 100 workflows and a `hasMore`
flag, excluding nodes and credential references.

Enable instance MCP access and make the relevant workflows available in MCP in
n8n settings. See [n8n's documentation](https://docs.n8n.io/connect/connect-to-n8n-mcp-server/).
Only tools exposed by the actual server are available; catalog discovery does
not execute workflows. Tests use a mock server; live token validity is checked
after local setup by asking Claw: `Check my n8n connection through Aion-Brain`.

For local Claw installation, `scripts/setup-aion-local.sh` in VIDEO-Engine-CCFL
prompts privately and passes the tokens only to the Aion container. The hosted
DigitalOcean deployment needs its own server environment configuration.
