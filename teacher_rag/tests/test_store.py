from pathlib import Path

import pytest

from teacher_rag.models import Chunk
from teacher_rag.store import SQLiteVectorStore, cosine_similarity


def test_store_upsert_search_replace_and_persist(tmp_path: Path):
    db = tmp_path / "vectors.sqlite3"
    store = SQLiteVectorStore(db)
    chunks = [
        Chunk(chunk_id="a", source_id="s1", title="A", text="fastapi api"),
        Chunk(chunk_id="b", source_id="s2", title="B", text="pandas dataframe"),
    ]
    store.upsert(chunks, [[1.0, 0.0], [0.0, 1.0]])
    assert store.count() == 2
    assert store.search([1.0, 0.0], top_k=1)[0].chunk_id == "a"

    reopened = SQLiteVectorStore(db)
    assert reopened.count() == 2
    assert reopened.delete_source("s1") == 1
    assert reopened.count() == 1


def test_replace_source_is_atomic_and_removes_stale_chunks(tmp_path: Path):
    store = SQLiteVectorStore(tmp_path / "vectors.sqlite3")
    old = [
        Chunk(chunk_id="old-1", source_id="source", title="Old", text="one"),
        Chunk(chunk_id="old-2", source_id="source", title="Old", text="two"),
    ]
    store.upsert(old, [[1.0, 0.0], [0.9, 0.1]])

    replacement = [Chunk(chunk_id="new-1", source_id="source", title="New", text="new")]
    assert store.replace_source("source", replacement, [[0.0, 1.0]]) == 1
    assert store.count() == 1
    assert store.search([0.0, 1.0], top_k=5)[0].chunk_id == "new-1"


def test_search_skips_vectors_from_a_different_embedding_dimension(tmp_path: Path):
    store = SQLiteVectorStore(tmp_path / "vectors.sqlite3")
    store.upsert(
        [Chunk(chunk_id="short", source_id="s", title="S", text="short")],
        [[1.0, 0.0]],
    )
    assert store.search([1.0, 0.0, 0.0], top_k=5) == []


def test_store_rejects_dimension_mismatch():
    with pytest.raises(ValueError):
        cosine_similarity([1.0, 0.0], [1.0])
