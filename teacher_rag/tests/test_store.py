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


def test_store_rejects_dimension_mismatch():
    with pytest.raises(ValueError):
        cosine_similarity([1.0, 0.0], [1.0])
