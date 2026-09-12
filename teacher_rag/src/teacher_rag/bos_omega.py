from __future__ import annotations

from pathlib import Path

from .models import SourceDocument

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DEFAULT_CORPUS = _REPO_ROOT / "knowledge" / "bos-omega"


def bos_omega_dir() -> Path:
    return _DEFAULT_CORPUS


def load_bos_omega_documents(corpus_dir: Path | None = None) -> list[SourceDocument]:
    root = corpus_dir or bos_omega_dir()
    if not root.is_dir():
        raise FileNotFoundError(f"bos_omega_corpus_missing:{root}")
    documents: list[SourceDocument] = []
    for path in sorted(root.glob("*.md")):
        if path.name.lower() == "readme.md":
            continue
        source_id = f"bos-omega-{path.stem}"
        title = path.stem.replace("-", " ")
        authority = "canon"
        if "patch" in path.stem or "pcos" in path.stem:
            authority = "patch"
        elif "continuity" in path.stem:
            authority = "continuity"
        documents.append(
            SourceDocument(
                source_id=source_id,
                title=title,
                content=path.read_text(encoding="utf-8"),
                metadata={"domain": "bos-omega", "authority": authority, "path": str(path)},
            )
        )
    if not documents:
        raise FileNotFoundError(f"bos_omega_corpus_empty:{root}")
    return documents


def seed_bos_omega(tutor, corpus_dir: Path | None = None) -> int:
    total = 0
    for document in load_bos_omega_documents(corpus_dir):
        total += tutor.ingest(document)
    return total
