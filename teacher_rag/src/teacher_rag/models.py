from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class SourceDocument(BaseModel):
    source_id: str
    title: str
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class Chunk(BaseModel):
    chunk_id: str
    source_id: str
    title: str
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class RetrievedChunk(Chunk):
    score: float


class LearnerState(BaseModel):
    level: Literal["beginner", "intermediate", "advanced"] = "beginner"
    known_topics: list[str] = Field(default_factory=list)
    goals: list[str] = Field(default_factory=list)
    misconceptions: list[str] = Field(default_factory=list)


class Citation(BaseModel):
    source_id: str
    title: str
    chunk_id: str


class TeachingPacket(BaseModel):
    query: str
    level: str
    answer: str
    learning_objectives: list[str]
    next_actions: list[str]
    quick_check: list[str]
    citations: list[Citation]
    context: list[RetrievedChunk]
