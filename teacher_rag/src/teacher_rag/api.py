from __future__ import annotations

from functools import lru_cache

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .curriculum import seed_curriculum
from .models import LearnerState, SourceDocument, TeachingPacket
from .tutor import TeacherRAG

app = FastAPI(title="TeacherRAG", version="0.2.0")


@lru_cache(maxsize=1)
def get_tutor() -> TeacherRAG:
    return TeacherRAG()


class TeachRequest(BaseModel):
    query: str = Field(min_length=1)
    learner: LearnerState = Field(default_factory=LearnerState)
    top_k: int | None = Field(default=None, ge=1, le=20)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)


@app.get("/health")
def health() -> dict[str, object]:
    tutor = get_tutor()
    return {"ok": True, "chunks": tutor.store.count()}


@app.post("/v1/ingest")
def ingest(document: SourceDocument) -> dict[str, int]:
    try:
        return {"chunks_written": get_tutor().ingest(document)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/v1/seed")
def seed() -> dict[str, int]:
    return {"chunks_written": seed_curriculum(get_tutor())}


@app.post("/v1/search")
def search(request: SearchRequest):
    try:
        return get_tutor().search(request.query, top_k=request.top_k)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/v1/teach", response_model=TeachingPacket)
def teach(request: TeachRequest) -> TeachingPacket:
    try:
        return get_tutor().teach(request.query, learner=request.learner, top_k=request.top_k)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
