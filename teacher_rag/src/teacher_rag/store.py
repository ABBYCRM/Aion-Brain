from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path
from .models import Chunk, RetrievedChunk


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        raise ValueError("vector dimensions must match")
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


class SQLiteVectorStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("""CREATE TABLE IF NOT EXISTS chunks (chunk_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, metadata_json TEXT NOT NULL, vector_json TEXT NOT NULL)""")
            connection.execute("CREATE INDEX IF NOT EXISTS idx_chunks_source_id ON chunks(source_id)")

    def upsert(self, chunks: list[Chunk], vectors: list[list[float]]) -> int:
        if len(chunks) != len(vectors):
            raise ValueError("chunks and vectors must have equal length")
        rows = [(c.chunk_id,c.source_id,c.title,c.text,json.dumps(c.metadata,sort_keys=True),json.dumps(v)) for c,v in zip(chunks,vectors,strict=True)]
        with self._connect() as connection:
            connection.executemany("""INSERT INTO chunks(chunk_id,source_id,title,text,metadata_json,vector_json) VALUES(?,?,?,?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET source_id=excluded.source_id,title=excluded.title,text=excluded.text,metadata_json=excluded.metadata_json,vector_json=excluded.vector_json""", rows)
        return len(rows)

    def delete_source(self, source_id: str) -> int:
        with self._connect() as connection:
            return connection.execute("DELETE FROM chunks WHERE source_id = ?", (source_id,)).rowcount

    def count(self) -> int:
        with self._connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS c FROM chunks").fetchone()
            return int(row["c"])

    def search(self, query_vector: list[float], top_k: int) -> list[RetrievedChunk]:
        if top_k <= 0:
            raise ValueError("top_k must be positive")
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM chunks").fetchall()
        scored = []
        for row in rows:
            score = cosine_similarity(query_vector, json.loads(row["vector_json"]))
            scored.append(RetrievedChunk(chunk_id=row["chunk_id"],source_id=row["source_id"],title=row["title"],text=row["text"],metadata=json.loads(row["metadata_json"]),score=score))
        scored.sort(key=lambda item: item.score, reverse=True)
        return scored[:top_k]
