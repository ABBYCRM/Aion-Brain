from __future__ import annotations

import hashlib
import math
import re
from abc import ABC, abstractmethod

import httpx


class Embeddings(ABC):
    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError


class DeterministicHashEmbeddings(Embeddings):
    def __init__(self, dimensions: int = 256) -> None:
        if dimensions <= 0:
            raise ValueError("dimensions must be positive")
        self.dimensions = dimensions

    def embed(self, texts: list[str]) -> list[list[float]]:
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
    """NVIDIA NIM embeddings client using the OpenAI-shaped `/embeddings` API."""

    def __init__(self, *, api_key: str, base_url: str, model: str, timeout: float = 45.0) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.base_url}/embeddings",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={"model": self.model, "input": texts},
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
        return vectors
