# Aion-Brain repository audit evidence

Audit date: 2026-08-04  
Repository: `ABBYCRM/Aion-Brain`  
Pinned baseline: `02e3353b332962435259257140d02392129f3946`  
Audit branch: `agent/exhaustive-runtime-audit`

## Scope and interpretation

The repository contains no `.ts` or `.tsx` source files. The executable application is Node.js ESM JavaScript. Every executable JavaScript/MJS file, runtime/deployment configuration, package manifest, test, and operational document listed below was reviewed against its callers and runtime behavior. Generated SQLite databases, WAL/SHM files, and generated reports were treated as runtime artifacts and removed from source control.

This report does not use the repository's HTTP/CLI auditor as proof of completeness. The authoritative evidence is clean installation, syntax checking, behavioral unit tests, a real Express/SQLite smoke process, dependency audit, and final diff review.

## Baseline failures reproduced

- Baseline clean installation failed on both tested Node versions because `package-lock.json` was machine-bound and inconsistent with `package.json`.
- Existing smoke tests counted provider `502` responses as passes and accepted non-success audit statuses.
- The original auditor could emit `VERIFIED_COMPLETE` without dependency installation, tests, live provider verification, deployment verification, or elimination of P1 findings.
- Authentication boundaries were absent for inference and operational telemetry/audit routes.
- The circuit breaker erased failure state before reaching its threshold.
- Multipart image-edit handling and OpenAI video request encoding did not match runtime/provider contracts.
- Generated SQLite databases and reports were committed.

Baseline workflow evidence: run `30950947863`, including Node 20 job `92132565085`, failed at `npm ci` before tests could run.

## Corrective changes and behavioral proof

| Area | Corrective result | Verification |
|---|---|---|
| Authentication | Separate gateway and administrator credentials; production startup fails closed when required security configuration is absent | Smoke verifies unauthenticated inference and audit rejection |
| Request safety | JSON and multipart limits, request IDs, CORS allow-list, bounded in-memory rate limiter, security headers, sanitized errors | 18-route smoke suite |
| Provider routing | Circuit failures persist to threshold, cooldown works, unsupported capabilities fall through without poisoning provider health | Unit tests 1 and 2 |
| OpenAI requests | Image-edit/video multipart requests use `FormData`; incoming multipart can be forwarded without lossy parsing | Unit test 3 plus route smoke |
| Client | Deadline, abort propagation, gateway/provider credential separation, typed errors, request-ID propagation | Unit test 4 |
| Persistence | Prepared statements, WAL/busy timeout, bounded query inputs, row-retention caps, health ping, checkpoint/close | Real SQLite smoke process |
| Auditor | Generated directories excluded; no unconditional completeness status; missing claimed symbols fail verification | Unit tests 5 and 6 plus authenticated audit smoke |
| Tests | Failure responses no longer count as success; server startup, auth, CORS, limits, telemetry and audit behavior are asserted | 6 unit tests and 18 smoke checks |
| Runtime lifecycle | Async rejection forwarding, graceful HTTP drain, SQLite checkpoint/close, fatal process handling | Syntax/runtime smoke and shutdown cleanup |
| Supply chain | Portable lockfile regenerated on a clean GitHub runner; maintained Node 22/24 targets; current supported dependency lines | Clean `npm ci` and production `npm audit` |

Exact audited source transfer SHA-256: `f3005fc7e6a48e4d60edb6db7ddc3e4c6b57f371393d9c184db54a7d0c3fd53b`. GitHub runner job `92137421405` verified this hash before extraction, then completed 6/6 unit tests, 18/18 runtime smoke checks, and a zero-vulnerability production audit. The resulting verified source/lock publication commit was `47336789ed6427968a2720ac5eb90d9d7d63a17c`.

Supported-runtime refresh workflow run `30952995959`, job `92139377328`, regenerated the lockfile on Node 24, completed a clean install, ran the complete verification suite, completed the production dependency audit, and committed the verified lockfile. The one-time workflow was removed afterward.

## File-by-file audit ledger

| File | Review focus | Result |
|---|---|---|
| `.env.example` | Required security, provider, storage, rate and retention settings | Complete example contract; no real secret values |
| `.github/workflows/ci.yml` | Reproducible install, maintained runtimes, tests, audit, least privilege | Node 22/24 matrix; read-only contents permission; clean lock install |
| `.gitignore` | Runtime data, WAL/SHM, reports, smoke artifacts, local secrets | Generated and secret-bearing paths excluded |
| `CHANGELOG.md` | Exact claims versus source and test evidence | Claims narrowed to evidence-backed changes |
| `DEPLOY.md` | Secrets, deployment gate, rollback, backup/restore | Production runbook aligned with Node 24 and SQLite WAL behavior |
| `LICENSE` | Package metadata consistency | MIT text added to match package metadata |
| `README.md` | Compatibility claims, auth, endpoints, limitations, operations | False claims removed; assurance boundaries and non-streaming scope explicit |
| `SECURITY.md` | Vulnerability reporting and secret handling | Operational security policy added |
| `bin/audit.mjs` | Argument parsing, output modes, exit status | Non-verified outcomes exit nonzero; no unconditional success |
| `lib/auditor.js` | Inventory boundaries, status semantics, health sampling, changelog verification | Bounded assurance; generated data excluded; no `VERIFIED_COMPLETE` path |
| `lib/client.js` | Timeouts, aborts, typed failures, credentials, request IDs | Deadline and error contract implemented and tested |
| `lib/router.js` | Failover, circuit state, retry classification, provider encoding/normalization | Threshold bug fixed; sanitized failure records; provider contracts normalized |
| `lib/rules.js` | Rule usefulness, false positives, broad suppressions, no-op rules | Rules made targeted; no no-op magic-number rule; auditor implementation excluded explicitly |
| `lib/store.js` | Schema, prepared statements, lifecycle, bounds, retention | Prepared and bounded persistence with WAL health/lifecycle controls |
| `package.json` | Scripts, exports, engines, dependencies, license | Maintained Node 22/24 engine contract and complete verification script |
| `package-lock.json` | Portability, manifest consistency, integrity graph | Lockfile v3, project-relative `node_modules/...` entries; clean-install verified |
| `render.yaml` | Immutable build, deployment gating, secrets, health, persistence, runtime | `npm ci`, checks-pass deploy, Node 24, health path and persistent disk |
| `server.js` | Middleware order, auth, limits, validation, route contracts, error handling, lifecycle | Runtime/security defects corrected; real process covered by smoke |
| `test/smoke-real.mjs` | External-provider opt-in, cleanup, awaited I/O | Cleanup and awaited report writes corrected; remains credential-gated |
| `test/smoke.mjs` | Real server/SQLite behavior and negative assertions | 18 checks; failure status cannot be counted as pass |
| `test/unit.mjs` | Regression coverage for core defects | 6 focused behavioral tests |

## Repository-wide negative scans

- No `.ts` or `.tsx` files exist.
- No application TODO/FIXME/XXX markers, placeholder functions, fake success branches, or "do it later" code were found. The only TODO/FIXME text is the auditor rule that detects those markers.
- No temporary audit payload or bootstrap workflow remains.
- Generated database/report artifacts are deleted and ignored.
- Chat streaming is intentionally outside this MVP contract and is rejected explicitly; it is not represented as working and is not buffered or faked.

## Assurance boundary and remaining operational work

The branch is a production-hardened **single-instance MVP**, not an enterprise certification. The following require deployment-specific evidence and are not claimed as complete here:

1. Live OpenAI, Anthropic, and A2E calls require owner-supplied provider credentials. Provider adapters are unit/contract tested and the real gateway process is hermetically tested, but no private credential was available for live external calls.
2. No deployed Render instance, TLS edge, DNS, load test, penetration test, disaster-recovery exercise, or provider outage exercise was available in this audit environment.
3. SQLite persistence and the in-memory rate limiter are appropriate for the documented single-instance deployment. Horizontal scale-out requires shared persistence/rate-limit infrastructure or deliberate request affinity.
4. Non-streaming chat is the documented MVP boundary. `stream: true` is rejected with a typed error rather than falsely emulated.

A merge or production deployment should remain gated on the final PR-head Node 22/24 CI matrix, deployment secret configuration, `/healthz`, one authenticated low-cost request for each configured live provider, and the deployment runbook checks.
