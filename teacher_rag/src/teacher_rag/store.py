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
        connection = sqlite3.connect(self.path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS chunks (
                    chunk_id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    text TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    vector_json TEXT NOT NULL,
                    vector_dim INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(chunks)").fetchall()
            }
            if "vector_dim" not in columns:
                connection.execute(
                    "ALTER TABLE chunks ADD COLUMN vector_dim INTEGER NOT NULL DEFAULT 0"
                )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_chunks_source_id ON chunks(source_id)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_chunks_vector_dim ON chunks(vector_dim)"
            )

    @staticmethod
    def _rows(chunks: list[Chunk], vectors: list[list[float]]) -> list[tuple[object, ...]]:
        if len(chunks) != len(vectors):
            raise ValueError("chunks and vectors must have equal length")
        rows: list[tuple[object, ...]] = []
        for chunk, vector in zip(chunks, vectors, strict=True):
            if not isinstance(vector, list) or not vector:
                raise ValueError("vectors must be non-empty lists")
            rows.append(
                (
                    chunk.chunk_id,
                    chunk.source_id,
                    chunk.title,
                    chunk.text,
                    json.dumps(chunk.metadata, sort_keys=True),
                    json.dumps(vector),
                    len(vector),
                )
            )
        return rows

    @staticmethod
    def _upsert_rows(connection: sqlite3.Connection, rows: list[tuple[object, ...]]) -> None:
        connection.executemany(
            """
            INSERT INTO chunks(
                chunk_id, source_id, title, text, metadata_json, vector_json, vector_dim
            ) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(chunk_id) DO UPDATE SET
                source_id=excluded.source_id,
                title=excluded.title,
                text=excluded.text,
                metadata_json=excluded.metadata_json,
                vector_json=excluded.vector_json,
                vector_dim=excluded.vector_dim
            """,
            rows,
        )

    def upsert(self, chunks: list[Chunk], vectors: list[list[float]]) -> int:
        rows = self._rows(chunks, vectors)
        if not rows:
            return 0
        with self._connect() as connection:
            self._upsert_rows(connection, rows)
        return len(rows)

    def replace_source(
        self,
        source_id: str,
        chunks: list[Chunk],
        vectors: list[list[float]],
    ) -> int:
        if any(chunk.source_id != source_id for chunk in chunks):
            raise ValueError("all chunks must match source_id")
        rows = self._rows(chunks, vectors) if chunks or vectors else []
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM chunks WHERE source_id = ?", (source_id,))
            if rows:
                self._upsert_rows(connection, rows)
        return len(rows)

    def delete_source(self, source_id: str) -> int:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM chunks WHERE source_id = ?", (source_id,))
            return cursor.rowcount

    def count(self) -> int:
        with self._connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS c FROM chunks").fetchone()
            return int(row["c"])

    def search(self, query_vector: list[float], top_k: int) -> list[RetrievedChunk]:
        if top_k <= 0:
            raise ValueError("top_k must be positive")
        if not query_vector:
            raise ValueError("query_vector must not be empty")
        query_dim = len(query_vector)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM chunks WHERE vector_dim = ? OR vector_dim = 0",
                (query_dim,),
            ).fetchall()
        scored: list[RetrievedChunk] = []
        for row in rows:
            vector = json.loads(row["vector_json"])
            if not isinstance(vector, list) or len(vector) != query_dim:
                continue
            score = cosine_similarity(query_vector, vector)
            scored.append(
                RetrievedChunk(
                    chunk_id=row["chunk_id"],
                    source_id=row["source_id"],
                    title=row["title"],
                    text=row["text"],
                    metadata=json.loads(row["metadata_json"]),
                    score=score,
                )
            )
        scored.sort(key=lambda item: item.score, reverse=True)
        return scored[:top_k]
