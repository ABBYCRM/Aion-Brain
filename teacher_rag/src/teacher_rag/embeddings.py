from __future__ import annotations

import hashlib
import math
import re
from abc import ABC, abstractmethod
from typing import Literal

import httpx

EmbeddingInputType = Literal["query", "passage"]


class Embeddings(ABC):
    @abstractmethod
    def embed(
        self,
        texts: list[str],
        *,
        input_type: EmbeddingInputType = "passage",
    ) -> list[list[float]]:
        raise NotImplementedError


class DeterministicHashEmbeddings(Embeddings):
    def __init__(self, dimensions: int = 256) -> None:
        if dimensions <= 0:
            raise ValueError("dimensions must be positive")
        self.dimensions = dimensions

    def embed(
        self,
        texts: list[str],
        *,
        input_type: EmbeddingInputType = "passage",
    ) -> list[list[float]]:
        del input_type
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        tokens = re.findall(r"[a-z0-9_+-]+", text.lower())
        for token in tokens:
            digest = hashlib.blake2b(token.encode(), digest_size=8).digest()
            idx = int.from_bytes(digest[:4], "big") % self.dimensions
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[idx] += sign
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]


class NVIDIAEmbeddings(Embeddings):
    """NVIDIA NIM embeddings client for query/passage retrieval embeddings."""

    def __init__(self, *, api_key: str, base_url: str, model: str, timeout: float = 45.0) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def embed(
        self,
        texts: list[str],
        *,
        input_type: EmbeddingInputType = "passage",
    ) -> list[list[float]]:
        if not texts:
            return []
        if input_type not in {"query", "passage"}:
            raise ValueError("input_type must be query or passage")
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.base_url}/embeddings",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "input": texts,
                    "input_type": input_type,
                    "modality": "text",
                    "embedding_type": "float",
                    "encoding_format": "float",
                },
            )
            response.raise_for_status()
            payload = response.json()
        data = payload.get("data")
        if not isinstance(data, list):
            raise ValueError("NVIDIA embeddings response is missing data")
        ordered = sorted(data, key=lambda item: item["index"])
        vectors = [item.get("embedding") for item in ordered]
        if len(vectors) != len(texts) or not all(isinstance(v, list) for v in vectors):
            raise ValueError("NVIDIA embeddings response shape does not match input")
        if vectors and not all(len(v) == len(vectors[0]) for v in vectors):
            raise ValueError("NVIDIA embeddings response contains inconsistent dimensions")
        return vectors
