# BOS-OMEGA Continuity

Authority rank: **Continuity**. Outranked by Canon and Patch. Outranks Logs, Conversation, and Inference.

## Brain ↔ AI architecture map (this repository)

Aion-Brain is the backend brain for VIDEO-Engine-CCFL. The live process is Node (`server.js`). Python TeacherRAG is the bundled coding-tutor vector store.

| Surface | Path | Role |
|---------|------|------|
| Process entry | `server.js` | Express: OpenAI-shaped `/v1/*`, AION `/api/*`, claw execute, brain audit |
| 7-law kernel | `lib/aion_kernel.js` | COMMIT / DEFER / REJECT + system prompt |
| Settings / auth | `lib/aion_settings.js` | `AION_API_KEYS`, `AION_ADMIN_KEYS`; fail-closed in production |
| LLM chain | `lib/aion_chain.js` | Bitdeer-only chat/stream (`BITDEER_*` / `NVIDIA_*` aliases) |
| Edge providers | `lib/nvidia_only_providers.js` | BITDEER-PRIMARY `/v1/*` chain (fail-closed). `lib/nvidia_only_guard.js` snapshots then strips OpenAI/Anthropic/xAI/A2E from env. Optional GEMINI/XAI/KIMI/OPENAI tools use `lib/secrets.js` (vault + snapshot) and never join this chain. |
| Agent loop | `lib/control_loop.js`, `lib/self_state.js`, `lib/agent_runtime.js` | 8-phase SELF_STATE; COMPLETE only with tool evidence |
| Tools | `lib/brain_tools.js`, `lib/agent_tool_extensions.js`, `lib/external_tools.js` | Search, browser, GDY, n8n, Firecrawl, TeacherRAG, BOS retrieve |
| Episodic memory | `lib/memory.js` | SQLite episodes / facts / goals; `/api/chat` `contextPack` |
| Call/audit store | `lib/store.js` | SQLite call log + audits |
| BOS vector memory | `lib/bos_omega_rag.js` | Ingests `knowledge/bos-omega/*`; `GET/POST /api/memory/bos`; retrieve-before-answer |
| Trinity gate HTTP | `lib/aion_kernel.js` `resolveBosGate` | `POST /api/decision` → GO/HOLD/ABORT + 7-law `decision` |
| Routines | `lib/routines.js` | `GET/POST /api/routines*`; pause/resume/delete/run |
| Connectors / MCP | `lib/connectors.js` | `GET /api/connectors`, `GET /api/mcp/status` (names only) |
| TeacherRAG | `teacher_rag/` + `lib/teacher_rag.js` | Python SQLite vectors; `teacher_rag_teach` |
| CCFL contract | `docs/claw-contract.md` | `POST /api/claw/execute`, `GET /api/claw/contract` |
| Secrets | `lib/secrets.js`, `lib/vault.js` | Vault hydrates at boot; tools use loaded keys. `lib/tools.js` remains the unused alternate registry. |

Auth for `/api/*`: header `X-AION-Key` or `Authorization: Bearer`, matching `AION_API_KEYS` (admin: `AION_ADMIN_KEYS`). `/api/continuity-pack` is public. CORS allows `x-aion-key`.

VIDEO-Engine-CCFL talks to this brain with `AION_BASE_URL` + `AION_API_KEY` on `/api/state`, `/api/chat`, `/api/tools/:name`, `/api/claw/execute`, and now also proxies `/api/decision`, `/api/memory/bos`, `/api/routines*`, `/api/connectors`, `/api/mcp/status`. Do not change the existing claw execute response shape. Do not add a second RAG/routines/MCP stub on CCFL.

## Weldon Angelos — public-record facts

Use these facts. Do not repeat the common error that President Obama commuted this sentence.

- **Case:** *United States v. Angelos*, 345 F. Supp. 2d 1227 (D. Utah 2004), Judge Paul G. Cassell.
- **Stacking:** three 18 U.S.C. § 924(c) firearm-possession counts on marijuana distribution produced a **55-year mandatory consecutive term** (5 + 25 + 25) even though the guns were possessed, not brandished or fired. Cassell called the sentence "unjust and cruel and even irrational" and asked the President to commute toward ~18 years.
- **2016 release:** Weldon Angelos was released **31 May 2016** after a **judicial sentence reduction**. Contemporary reporting (AP, Salt Lake Tribune, KSL, Reason) states President Obama **did not** commute the sentence; a prosecutor-supported sealed court action did. Cassell and others had petitioned Obama; the petition did not become a commutation.
- **2020 pardon:** President Donald J. Trump granted a **full pardon on 22 December 2020** (White House clemency statement; The Weldon Project).
- **Weldon Project:** after release, Angelos founded **The Weldon Project** (theweldonproject.org) to advocate cannabis-related clemency and 924(c) stacking reform. The case is cited in First Step Act / sentencing-reform discussion.

If a conversation claims "Obama commute 2016", tag that claim **CONTRADICTED** by Continuity and state the 2016 judicial release + 2020 Trump pardon.

## Ontonomic Recursion (BOS-OMEGA Continuity definition)

No separate Luis Lacerda publication was retrieved for this implant. The Continuity definition used by this brain is:

**Ontonomic Recursion** is the lawful loop in which a system (1) states its ontology — what it is, what it may do, what it has verified — (2) retrieves Canon/Patch/Continuity before answering, (3) takes Praxis (tools / patches / tests), (4) writes the outcome back into memory, and (5) re-enters Alpha. Recursion is invalid if Inference overwrites Canon, if explanation replaces execution, or if a stub is recorded as success.

Equation form: `next_state = Omega(Praxis(Alpha(retrieve(Canon>Patch>Continuity))))`.

## Grok-Bot-like runtime behavior

This brain must behave like a tool-using verifier, not a chatbot:

1. **Retrieve before answer** on BOS topics (Trinity, GO/HOLD/ABORT, PCOS ANS, Weldon Angelos, Ontonomic Recursion, memory authority, methodical-notes).
2. **Use tools** (`bos_omega_retrieve`, search, browser, TeacherRAG, `cursor_launch` for non-trivial repo/PR work, tests). Intended calls are not completed calls. Cursor cloud agents are spawned dynamically via Brain (`CURSOR_API_KEY`); they are not prefabricated roles.
3. **Verify** — Omega gate: cite chunk authority or tool evidence. COMPLETE is refused without evidence (`lib/control_loop.js`).
4. **Trinity gate language** — say Alpha / Praxis / Omega and GO / HOLD / ABORT when deciding.
5. **Self-fix-first** and **evidence-only**. No stubs. No attack playbooks.

Computer/browser tools already on this runtime: `steel_browser`, Firecrawl scrape/interact/stop, ScreenshotOne, E2B, DuckDuckGo/Tavily/Exa search, GDY RAG, n8n, ECC skills.
