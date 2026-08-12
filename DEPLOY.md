# Deploy llm-gateway

The code is in `/workspace/llm-gateway/`. Pick the path that works for you.

> **Required in every option below:** `ENVIRONMENT` defaults to `production`,
> and in production the server fail-closes at startup (`process.exit(1)`)
> unless `AION_API_KEYS` and `AION_ADMIN_KEYS` (comma-separated key lists) are
> set — see `lib/aion_settings.js`. Without them, `node server.js` crashes
> immediately with `aion.startup.fatal: AION_API_KEYS must be configured in
> production` and never binds the port. `OPENAI_API_KEY` (or another provider
> key) is separate and optional — it only affects which LLM provider is used;
> without it the gateway falls back to the offline `EchoProvider`.

## Option A: One-click Render Blueprint (fastest)
1. Push this directory to a new GitHub repo (e.g. `ABBYCRM/llm-gateway`).
2. In Render dashboard: New → Blueprint → point at the repo.
3. Render reads `render.yaml` and creates the service. It will prompt you to
   fill in `AION_API_KEYS` and `AION_ADMIN_KEYS` (marked `sync: false` in the
   blueprint) — the service will not boot without them.
4. Once live, also set `OPENAI_API_KEY` (or another provider key) env var in
   the Render dashboard if you want real LLM calls instead of the echo
   fallback.
5. Hit `https://<service>.onrender.com/audit` to verify.

## Option B: Render web service from existing GitHub
1. Push to GitHub.
2. New → Web Service → pick the repo.
3. Build: `npm install`. Start: `node server.js`. Plan: Starter. Disk: 1GB at /var/data/llm-gateway.
4. Health check path: `/healthz`.
5. Set `AION_API_KEYS` and `AION_ADMIN_KEYS` env vars (required — see note
   above) plus `OPENAI_API_KEY` (optional, for real LLM calls).

## Option C: Run anywhere Node 18+
```bash
tar -xzf llm-gateway.tar.gz
cd llm-gateway
npm install
AION_API_KEYS=dev-user-key AION_ADMIN_KEYS=dev-admin-key OPENAI_API_KEY=sk-... node server.js
```
Then `curl http://localhost:10000/audit` returns the report.

For local-only use without provisioning key lists, you can instead run:
```bash
ENVIRONMENT=development ALLOW_UNAUTHENTICATED_DEV=true node server.js
```
This disables AION-API auth entirely — do not use it for a shared or public deployment.

## Option D: Plug into an existing app
Just import `lib/client.js` and set `baseURL` to your gateway. Or change your
existing OpenAI SDK's `baseURL` to `https://<your-gateway>/v1`.
