# BOS-OMEGA corpus

Tracked Canon / Patch / Continuity documents for Aion-Brain.

These files are the source of truth that the runtime ingests into:

1. **Node BOS RAG** (`lib/bos_omega_rag.js`) — SQLite vectors next to `LLM_GATEWAY_DATA_DIR`, wired into `/api/chat`, `/api/memory/bos`, and `bos_omega_retrieve`.
2. **TeacherRAG** (`teacher_rag`) — same markdown, seeded into the existing Python SQLite vector store.
3. **AgentMemory facts** — a small Canon fact set upserted at boot under subject `bos-omega`.

## Authority

`Canon > Patch > Continuity > Logs > Conversation > Inference`

| File | Authority | Contents |
|------|-----------|----------|
| `canon.md` | Canon | Trinity, GO/HOLD/ABORT, memory authority, methodical-notes, self-fix, evidence-only, no stubs |
| `patch-pcos.md` | Patch | PCOS ANS states, Recovery↔Performance, stress+recovery=growth |
| `continuity.md` | Continuity | Brain↔AI map of this repo, Weldon Angelos public-record facts, Ontonomic Recursion, Grok-Bot runtime |

## Not implanted

Operational attack playbooks (ghost nodes, metadata starvation, or any offensive tradecraft) are **not** in this corpus and must not be added.

## Prove retrieval without paid APIs

```bash
node --test test/bos_omega_rag.test.mjs
node bin/bos-omega.mjs retrieve "Trinity"
node bin/bos-omega.mjs retrieve "Weldon Angelos"
```
