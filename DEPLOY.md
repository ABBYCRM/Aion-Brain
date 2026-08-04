# Deployment runbook

## Required secrets and settings

Before production startup, configure:

- `LLM_GATEWAY_API_KEYS`: one or more long random gateway credentials, comma-separated during rotation;
- `LLM_GATEWAY_ADMIN_TOKEN`: a distinct long random operational credential;
- `LLM_GATEWAY_CORS_ORIGINS`: explicit comma-separated browser origins;
- at least one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `A2E_API_KEY`;
- `NODE_ENV=production`;
- `LLM_GATEWAY_ALLOW_ECHO=false`.

Never expose provider or administrator credentials to browser code.

## Render Blueprint

1. Connect this repository as a Render Blueprint.
2. Enter every `sync: false` value from `render.yaml`.
3. Confirm the persistent disk is mounted at `/var/data/llm-gateway`.
4. Confirm automatic deploys use `checksPass`.
5. Deploy only after the GitHub `ci` workflow succeeds.
6. Verify `/healthz` returns HTTP 200.
7. Run an authenticated `POST /audit/run` and confirm its bounded assurance and limitations.
8. Send an authenticated hermetic or low-cost inference request.
9. Confirm `/calls/recent` and `/stats` require the administrator token.

The Blueprint uses `npm ci`, `npm start`, Node 22, a 30-second shutdown delay, and persistent SQLite storage.

## Generic Node deployment

```bash
npm ci --omit=dev
NODE_ENV=production npm start
```

Place the service behind TLS. Preserve `x-request-id`, enforce an upstream request-size limit at least as strict as the application limit, and allow enough shutdown time for HTTP draining and SQLite checkpointing.

## Rollback

1. Stop new traffic or switch the deployment to the prior known-good commit.
2. Keep the persistent SQLite disk attached; do not copy live WAL files independently.
3. Start the prior version and verify `/healthz`.
4. Re-run the authenticated smoke request.
5. Record the failed commit, CI evidence, deployment logs, and rollback result.

## Backup and restore

Use a SQLite-aware backup or stop the process before copying `gateway.db`. Copying only the main database while WAL mode is active can produce an incomplete backup.
