# TeacherRAG

Teacher-oriented RAG and constrained coding-agent execution layer for Aion-Brain.

## Core behavior

- chunks documents and repository source files
- embeds every chunk
- stores vectors locally in SQLite by default
- retrieves ranked chunks for an AI agent
- returns structured teaching packets
- can execute coding-agent actions in a constrained workspace
- runs tests and only reports successful builds after a passing test action

## Vectorize the repository

```bash
teacher-rag vectorize ..
```

This walks supported UTF-8 source/document files, excludes `.env`, `.git`, `node_modules`, virtual environments, build outputs, caches, and the vector DB itself, then chunks + embeds + indexes each file.

## Use from Aion

```python
from pathlib import Path
from teacher_rag import TeacherRAG
from teacher_rag.vectorize import vectorize_repository

rag = TeacherRAG()
vectorize_repository(rag, Path('.'))
packet = rag.teach('How does the agent runtime execute tools?')
print(packet.model_dump_json(indent=2))
```

## Offline and hosted embeddings

Without an API key the index uses deterministic 256-dimensional hash embeddings for local/e2e operation. Set `EMBEDDINGS_API_KEY`, `EMBEDDINGS_BASE_URL`, and `EMBEDDINGS_MODEL` to use an OpenAI-compatible embedding endpoint.

## Coding execution

`ExecutingCodingAgent` combines retrieved teaching context with `WorkspaceExecutor`. The executor reads/writes workspace files, runs subprocesses without a shell, executes Python/tests, observes failures, and supports repair loops. Path traversal outside the configured workspace is rejected. For hostile/untrusted autonomous workloads, place the executor inside a container or VM as an additional isolation boundary.
