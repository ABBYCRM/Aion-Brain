from __future__ import annotations

import hashlib

from .models import Chunk, SourceDocument


def chunk_document(document: SourceDocument, chunk_size: int, overlap: int) -> list[Chunk]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be >= 0 and < chunk_size")

    text = " ".join(document.content.split())
    if not text:
        return []

    chunks: list[Chunk] = []
    start = 0
    ordinal = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        if end < len(text):
            boundary = text.rfind(" ", start, end)
            if boundary > start + chunk_size // 2:
                end = boundary
        chunk_text = text[start:end].strip()
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
        if end == len(text):
            break
        start = max(end - overlap, start + 1)
    return chunks
