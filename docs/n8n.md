# n8n: useful read and write capabilities

All functionality lives in Aion-Brain. Claw reaches the authenticated `/api/tools/:name` API; credentials remain on Aion.

- `n8n_status` / `n8n_tools`: connectivity and exact supported schemas.
- `n8n_workflows`: public API workflow metadata (first 100, with hasMore flag).
- `n8n_call`: workflow discovery, BOS-OMEGA execution and execution status.
- `n8n_aura`: memory search/write, skills/vault, scheduling/cancellation and self/spawn/render status. Selected IDs are in `lib/n8n_aura.js`.

These complement Claw without duplicating its web, GitHub or Composio tools. Run a write only for an operator-requested action. No workflow executes during setup or connectivity checks.

## Server configuration

- `N8N_MCP_URL`: defaults to `https://paisabrazil.app.n8n.cloud/mcp-server/http`.
- `N8N_MCP_TOKEN`: raw MCP access token, without Bearer or Markdown escaping.
- `N8N_API_KEY`: separate public API key for AURA identity/path verification.
- `N8N_API_URL`: defaults to `https://paisabrazil.app.n8n.cloud/api/v1/`.
- `N8N_BASE_URL`: AURA origin, defaults to `https://paisabrazil.app.n8n.cloud`.
- `N8N_WEBHOOK_TOKEN`: optional separate webhook Bearer token.
- `N8N_EXECUTABLE_WORKFLOW_IDS`: defaults to `eEElzMUUnW8DTt4S` (BOS-OMEGA Multi-Agent System).

The local installer in VIDEO-Engine-CCFL prompts privately. DigitalOcean needs its own environment configuration.

## Verified live state, 2026-09-05

The public API lists 115 workflows, including 58 active AURA wrappers. BOS-OMEGA Multi-Agent System is active, MCP-enabled and has 93 nodes. The seven inspected AURA status/memory/catalog webhooks accept POST and forward to the AURA service on Render. The adapter verifies the active workflow identity and actual webhook method before calling; it never guesses URLs or retries writes automatically. Live MCP discovery succeeded without executing a workflow.

No static Execute Sub-workflow references to AURA were found across the 115 definitions. That does not exclude external HTTP callers. Three sampled wrappers had no retained executions; this does not prove all are unused.

## BOS execution

Use `get_workflow_details` with `workflowId: eEElzMUUnW8DTt4S` and `detailLevel: execution` first. Follow the returned trigger/input schema for `execute_workflow`, including explicit `executionMode` (manual or production). Both modes can affect real services. Check execution status before claiming completion or retrying a timed-out request.

The bridge preserves structured results, redacts common credential fields, supports JSON/SSE, pagination, bounded MCP responses and session cleanup. Production writes are not executed by tests.

See [n8n MCP documentation](https://docs.n8n.io/connect/connect-to-n8n-mcp-server/).
