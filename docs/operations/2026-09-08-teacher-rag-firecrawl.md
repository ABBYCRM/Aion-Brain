# AION operations note — 2026-09-08 UTC

This note records the implementation work performed on `feature/teacher-rag-executor` before merge to `main`.

## Work performed

- Added `teacher_rag/` as a bundled Python RAG subsystem for AION-Brain.
- Added deterministic repository chunking and vectorization with secret/vendor-directory exclusions.
- Added SQLite vector persistence and similarity retrieval.
- Added NVIDIA NIM chat and embeddings defaults; no OpenAI key is required or intended for this subsystem.
- Added a structured teacher API and CLI.
- Added constrained workspace execution and a coding-agent loop whose success is gated by a real passing test run.
- Added a Node-to-Python `teacher_rag_teach` bridge and wired it into the actual `AgentRuntime` tool catalog.
- Added Firecrawl v2 scrape-bound Interact support: scrape -> interact by `scrapeId` -> explicit stop.
- Added Firecrawl prompt/code validation, Node/Python/Bash language selection, timeout bounds, and session cleanup support.
- Added Firecrawl Interact knowledge to the TeacherRAG curriculum so the agent can retrieve the operational contract before using it.
- Added root CI coverage for Node and Python suites and removed the ineffective nested workflow.
- Added a production Dockerfile that installs both Node dependencies and the bundled TeacherRAG Python package.
- Added runtime environment-variable contracts without committing any secret values.

## Security / operations decisions

- Real API keys are not stored in Git.
- Repository vectorization excludes `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.git`, dependency/vendor directories, caches, build output, and the vector database directory.
- TeacherRAG defaults to NVIDIA NIM endpoints for both generation and embeddings when credentials are configured.
- Agent filesystem writes are constrained to the configured workspace root and reject path traversal.
- Agent success is invalidated after unverified writes and requires a subsequent passing test action.
- Firecrawl sessions are designed to be explicitly stopped after interaction to preserve writable profile state and avoid unnecessary browser-session billing.

## Verification status at note creation

The branch contains automated tests for chunking determinism, vector persistence/dimension checks, repository vectorization, secret exclusions, TeacherRAG retrieval, HTTP API behavior, workspace execution, path traversal rejection, coding-agent test gating, Firecrawl endpoint contracts, and AgentRuntime tool extension wiring.

A final repository audit and CI/runtime verification are required immediately before merge. Any failures found during that pass must be fixed and recorded in the final audit evidence rather than treated as successful by assumption.

No secret values are recorded in this note.
