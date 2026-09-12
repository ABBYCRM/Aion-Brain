from pathlib import Path

from teacher_rag.bos_omega import seed_bos_omega
from teacher_rag.config import Settings
from teacher_rag.tutor import TeacherRAG


def test_teacher_rag_bos_omega_trinity_and_weldon(tmp_path: Path):
    tutor = TeacherRAG(Settings(db_path=tmp_path / "rag.sqlite3", top_k=6))
    written = seed_bos_omega(tutor)
    assert written > 0

    trinity = tutor.search("Trinity")
    trinity_text = "\n".join(chunk.text for chunk in trinity)
    assert trinity, "Trinity must retrieve at least one TeacherRAG chunk"
    assert "Trinity" in trinity_text
    assert any(token in trinity_text for token in ("Alpha", "Omega", "Praxis"))

    weldon = tutor.search("Weldon Angelos")
    weldon_text = "\n".join(chunk.text for chunk in weldon)
    assert weldon, "Weldon Angelos must retrieve at least one TeacherRAG chunk"
    assert "Weldon Angelos" in weldon_text
    assert any(token in weldon_text for token in ("924", "Weldon Project", "pardon", "commute"))
