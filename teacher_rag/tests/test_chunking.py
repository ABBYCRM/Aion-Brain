import pytest

from teacher_rag.chunking import chunk_document
from teacher_rag.models import SourceDocument


def test_chunk_document_preserves_source_metadata():
    doc = SourceDocument(source_id="x", title="X", content="word " * 300, metadata={"tag": "demo"})
    chunks = chunk_document(doc, chunk_size=120, overlap=20)
    assert len(chunks) > 1
    assert all(chunk.source_id == "x" for chunk in chunks)
    assert all(chunk.metadata["tag"] == "demo" for chunk in chunks)
    assert [chunk.metadata["ordinal"] for chunk in chunks] == list(range(len(chunks)))


def test_chunk_document_is_deterministic():
    doc = SourceDocument(source_id="x", title="X", content="alpha beta gamma " * 80)
    first = chunk_document(doc, chunk_size=90, overlap=15)
    second = chunk_document(doc, chunk_size=90, overlap=15)
    assert [c.chunk_id for c in first] == [c.chunk_id for c in second]


def test_chunk_document_rejects_invalid_overlap():
    doc = SourceDocument(source_id="x", title="X", content="hello")
    with pytest.raises(ValueError):
        chunk_document(doc, chunk_size=10, overlap=10)


def test_chunk_document_prefixes_title_and_source_id():
    doc = SourceDocument(
        source_id="fastapi",
        title="FastAPI",
        content="Python ASGI API framework with routing and OpenAPI generation.",
    )
    chunks = chunk_document(doc, chunk_size=900, overlap=120)
    assert chunks
    assert chunks[0].text.lower().startswith("fastapi fastapi.")
    assert "asgi" in chunks[0].text.lower()
