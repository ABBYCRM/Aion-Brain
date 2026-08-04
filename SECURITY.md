# Security policy

Report security issues privately to the repository owner. Do not include live API keys, gateway keys, administrator tokens, customer prompts, provider responses, or database files in an issue or pull request.

## Supported release

Only the latest commit on the default branch is supported until formal versioned releases are published.

## Operational security requirements

- Terminate TLS before traffic reaches the gateway.
- Require distinct gateway and administrator credentials.
- Keep client-supplied provider credentials disabled unless the tenancy model explicitly requires them.
- Use explicit CORS origins.
- Restrict administrator endpoints at the network layer when possible.
- Rotate secrets after any suspected exposure.
- Never commit SQLite databases, WAL files, generated reports, or `.env` files.
- Review call telemetry retention against applicable privacy obligations.
