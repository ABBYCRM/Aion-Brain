# llm-gateway

An authenticated Node.js gateway for OpenAI-, Anthropic-, and A2E-backed LLM operations. It provides provider failover, bounded request handling, SQLite telemetry, operational endpoints, and a deliberately limited static/health auditor.

## What is verified

The repository CI performs a clean locked install on Node 22 and Node 24, syntax-checks every executable file, runs unit tests, starts the real Express/SQLite process, exercises the HTTP routes with the hermetic echo provider, and runs a production dependency audit.

The HTTP/CLI auditor is narrower. Its strongest status is `STATIC_HEALTH_VERIFIED`, which means only:

- the configured process answered every health sample;
- the static rules reported no P0/P1 finding;
- exact changelog path/token claims were present.

It does **not** claim dependency, provider, deployment, load, penetration, or end-to-end verification. CI and deployment checks remain authoritative.

## Runtime requirements

- Node.js 22 or 24
- npm with the committed lockfile
- writable SQLite data directory
- at least one provider credential in production
- separate gateway and administrator credentials in production

Install and verify:

```bash
npm ci
npm run verify
```

Start locally:

```bash
cp .env.example .env
# Load the environment with your preferred tool, then:
npm start
```

The server listens on `PORT`, defaulting to `10000`.

## Authentication model

Inference endpoints require `x-gateway-key`. Operational endpoints require the separate `x-admin-token` credential.

```text
x-gateway-key: <one value from LLM_GATEWAY_API_KEYS>
x-admin-token: <LLM_GATEWAY_ADMIN_TOKEN>
x-app-id: crm-production
x-request-id: caller-generated-id
```

`LLM_GATEWAY_API_KEYS` accepts comma-separated keys to support rotation. In production, startup fails when gateway keys, the administrator token, allowed CORS origins, or all real provider credentials are missing.

Provider credentials supplied by clients are disabled by default. Set `LLM_GATEWAY_ALLOW_CLIENT_PROVIDER_KEYS=true` only when that trust model is intentional. When enabled, the supported headers are `x-openai-key`, `x-anthropic-key`, and `x-a2e-key`.

## Endpoints

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| GET | `/healthz` | public | Liveness/readiness, including SQLite ping |
| GET | `/` | public | Minimal service metadata |
| POST | `/v1/chat/completions` | gateway | OpenAI-style non-streaming chat |
| POST | `/v1/images/generations` | gateway | OpenAI-style image generation |
| POST | `/v1/images/edits` | gateway | JSON base64 or multipart image edit |
| POST | `/v1/videos` | gateway | JSON or multipart video creation |
| POST | `/v1/messages` | gateway | Anthropic-style messages response |
| GET | `/audit` | admin | Most recently persisted full audit |
| GET | `/audit/quick` | admin | Current process health-only audit |
| POST | `/audit/run` | admin | Static and process-health audit |
| GET | `/calls/recent?n=50` | admin | Recent bounded call telemetry |
| GET | `/stats?since_ms=86400000` | admin | Aggregated bounded telemetry |

The gateway intentionally exposes non-streaming chat only. Requests with `stream: true` receive a typed `400 streaming_not_supported` response instead of a misleading buffered response.

## Client usage

```js
import { GatewayClient } from 'llm-gateway/client';

const gateway = new GatewayClient({
  baseUrl: 'https://gateway.example.com',
  gatewayKey: process.env.LLM_GATEWAY_API_KEY,
  appId: 'abby-crm',
});

const response = await gateway.chat({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

The client applies a 30-second deadline by default, propagates request IDs, returns typed `GatewayError` failures, and keeps gateway authentication separate from provider credentials.

## Provider behavior

The environment-defined default order is OpenAI, A2E, Anthropic. Echo is available only when `LLM_GATEWAY_ALLOW_ECHO=true` and no real provider is configured.

The circuit breaker opens after three retryable provider failures and closes after the cooldown. Unsupported operations fall through without damaging provider health. Authentication and validation failures do not fail over because another provider cannot correct the request.

OpenAI image edits and video creation use multipart form requests. Incoming multipart bodies can be forwarded without decoding; JSON callers can supply `image_b64` or `input_reference_b64` fields.

## Data handling

SQLite stores call metadata and audit reports. Raw prompts, responses, provider keys, and gateway keys are not stored. Upstream error text is truncated before persistence and not returned to gateway clients.

Default retention caps are 100,000 call rows and 1,000 audit rows. Configure them with `LLM_GATEWAY_MAX_CALL_ROWS` and `LLM_GATEWAY_MAX_AUDIT_ROWS`.

Runtime databases, WAL files, smoke directories, and generated reports are ignored by Git. They must never be committed.

## Operations

Use `npm ci`, not `npm install`, in CI and deployment. The Render Blueprint waits for checks to pass before deploying and uses a persistent disk for SQLite.

Rotate gateway keys by temporarily placing old and new values in `LLM_GATEWAY_API_KEYS`, deploy, update clients, then remove the old value. Rotate the administrator token independently.

Monitor:

- `/healthz` status and latency;
- HTTP 429/5xx rates;
- provider circuit-open events;
- SQLite disk use and WAL growth;
- `/stats` error ratio and latency;
- CI clean-install, test, and dependency-audit results.

## Audit CLI

```bash
node bin/audit.mjs --base-url=http://127.0.0.1:10000
node bin/audit.mjs --quick --base-url=http://127.0.0.1:10000
node bin/audit.mjs --json --base-url=http://127.0.0.1:10000
```

Without `--base-url` or `LLM_GATEWAY_SELF_URL`, runtime health is not tested and the CLI exits nonzero with `PARTIAL`.
