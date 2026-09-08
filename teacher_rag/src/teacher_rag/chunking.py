from __future__ import annotations

import hashlib

from .models import Chunk, SourceDocument


def chunk_document(document: SourceDocument, chunk_size: int, overlap: int) -> list[Chunk]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be >= 0 and < chunk_size")

    # Title + source_id must be in the embedded text. Curriculum bodies
    # often describe a library without naming it ("Python ASGI API
    # framework..."), so hash embeddings otherwise cannot retrieve FastAPI
    # for a FastAPI query.
    titled = " ".join(f"{document.source_id} {document.title}. {document.content}".split())
    if not titled:
        return []

    chunks: list[Chunk] = []
    start = 0
    ordinal = 0
    while start < len(titled):
        end = min(start + chunk_size, len(titled))
        if end < len(titled):
            boundary = titled.rfind(" ", start, end)
            if boundary > start + chunk_size // 2:
                end = boundary
        chunk_text = titled[start:end].strip()
        digest = hashlib.sha256(
            f"{document.source_id}:{ordinal}:{chunk_text}".encode()
        ).hexdigest()[:20]
        chunks.append(
            Chunk(
                chunk_id=f"{document.source_id}:{digest}",
                source_id=document.source_id,
                title=document.title,
                text=chunk_text,
                metadata={**document.metadata, "ordinal": ordinal},
            )
        )
        ordinal += 1
        if end == len(titled):
            break
        start = max(end - overlap, start + 1)
    return chunks
