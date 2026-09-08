from pathlib import Path

from teacher_rag.config import Settings
from teacher_rag.curriculum import seed_curriculum
from teacher_rag.models import LearnerState
from teacher_rag.tutor import TeacherRAG


def test_teacher_rag_end_to_end_without_external_keys(tmp_path: Path):
    tutor = TeacherRAG(Settings(db_path=tmp_path / "rag.sqlite3", top_k=3))
    written = seed_curriculum(tutor)
    assert written >= 20

    packet = tutor.teach(
        "What does FastAPI give me, and what do I still need for production?",
        learner=LearnerState(level="beginner", goals=["build APIs"]),
    )
    assert packet.answer
    assert packet.learning_objectives
    assert packet.citations
    assert any(c.source_id == "fastapi" for c in packet.citations)


def test_firecrawl_curriculum_is_retrievable(tmp_path: Path):
    tutor = TeacherRAG(Settings(db_path=tmp_path / "rag.sqlite3", top_k=3))
    seed_curriculum(tutor)
    hits = tutor.search("scrapeId interact playwright stop session", top_k=3)
    assert any(hit.source_id == "firecrawl-interact" for hit in hits)
