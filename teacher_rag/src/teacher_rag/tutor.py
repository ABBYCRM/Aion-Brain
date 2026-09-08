from __future__ import annotations

import json
from typing import Protocol

import httpx

from .chunking import chunk_document
from .config import Settings
from .embeddings import DeterministicHashEmbeddings, Embeddings, NVIDIAEmbeddings
from .models import Citation, LearnerState, SourceDocument, TeachingPacket
from .prompts import SYSTEM_PROMPT, build_teacher_prompt
from .store import SQLiteVectorStore


class TeacherModel(Protocol):
    def generate(self, *, system: str, user: str) -> dict[str, object]: ...


class NVIDIAChatModel:
    def __init__(self, *, api_key: str, base_url: str, model: str, timeout: float = 45.0) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def generate(self, *, system: str, user: str) -> dict[str, object]:
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0.2,
                    "response_format": {"type": "json_object"},
                },
            )
            response.raise_for_status()
            payload = response.json()
        try:
            content = payload["choices"][0]["message"]["content"]
            parsed = json.loads(content)
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise ValueError("teacher model returned an invalid response") from exc
        if not isinstance(parsed, dict):
            raise ValueError("teacher model must return a JSON object")
        return parsed


class ExtractiveTeacherModel:
    """Deterministic offline teacher for local development and tests."""

    def generate(self, *, system: str, user: str) -> dict[str, object]:
        del system
        marker = "Retrieved teaching context:\n"
        context = user.split(marker, 1)[-1].strip() if marker in user else user.strip()
        excerpt = context[:1800]
        return {
            "answer": "Grounded teaching context:\n\n" + excerpt,
            "learning_objectives": [
                "Explain the tool's role in the larger engineering system",
                "Distinguish learning a library from shipping a complete application",
                "Identify the production dependencies needed to use the capability safely",
            ],
            "next_actions": [
                "Build the smallest runnable example",
                "Run it and inspect real output",
                "Add tests, error handling, and one realistic edge case",
            ],
            "quick_check": [
                "What problem does this tool solve?",
                "What does it not solve by itself?",
                "What must be verified before production use?",
            ],
        }


class TeacherRAG:
    def __init__(
        self,
        settings: Settings | None = None,
        *,
        embeddings: Embeddings | None = None,
        model: TeacherModel | None = None,
        store: SQLiteVectorStore | None = None,
    ) -> None:
        self.settings = settings or Settings()
        self.embeddings = embeddings or self._default_embeddings()
        self.model = model or self._default_model()
        self.store = store or SQLiteVectorStore(self.settings.db_path)

    def _default_embeddings(self) -> Embeddings:
        api_key = self.settings.embeddings_api_key or self.settings.nvidia_api_key
        if api_key:
            return NVIDIAEmbeddings(
                api_key=api_key,
                base_url=self.settings.embeddings_base_url,
                model=self.settings.embeddings_model,
                timeout=self.settings.request_timeout_seconds,
            )
        return DeterministicHashEmbeddings()

    def _default_model(self) -> TeacherModel:
        if self.settings.nvidia_api_key:
            return NVIDIAChatModel(
                api_key=self.settings.nvidia_api_key,
                base_url=self.settings.nvidia_base_url,
                model=self.settings.nvidia_model,
                timeout=self.settings.request_timeout_seconds,
            )
        return ExtractiveTeacherModel()

    def ingest(self, document: SourceDocument, *, replace_source: bool = True) -> int:
        chunks = chunk_document(
            document,
            chunk_size=self.settings.chunk_size,
            overlap=self.settings.chunk_overlap,
        )
        vectors = self.embeddings.embed([chunk.text for chunk in chunks])
        if len(vectors) != len(chunks):
            raise ValueError("embedding count does not match chunk count")
        if replace_source:
            self.store.delete_source(document.source_id)
        return self.store.upsert(chunks, vectors)

    def search(self, query: str, *, top_k: int | None = None):
        if not query.strip():
            raise ValueError("query must not be blank")
        query_vectors = self.embeddings.embed([query])
        if len(query_vectors) != 1:
            raise ValueError("embedding provider did not return exactly one query vector")
        return self.store.search(query_vectors[0], top_k or self.settings.top_k)

    def teach(
        self,
        query: str,
        *,
        learner: LearnerState | None = None,
        top_k: int | None = None,
    ) -> TeachingPacket:
        if not query.strip():
            raise ValueError("query must not be blank")
        learner = learner or LearnerState()
        context = self.search(query, top_k=top_k)
        payload = self.model.generate(
            system=SYSTEM_PROMPT,
            user=build_teacher_prompt(query, learner, context),
        )
        citations = [
            Citation(source_id=c.source_id, title=c.title, chunk_id=c.chunk_id) for c in context
        ]
        return TeachingPacket(
            query=query,
            level=learner.level,
            answer=str(payload.get("answer", "")),
            learning_objectives=_string_list(payload.get("learning_objectives")),
            next_actions=_string_list(payload.get("next_actions")),
            quick_check=_string_list(payload.get("quick_check")),
            citations=citations,
            context=context,
        )


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]
