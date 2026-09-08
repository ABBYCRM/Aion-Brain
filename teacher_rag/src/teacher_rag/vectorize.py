from __future__ import annotations

from pathlib import Path
from typing import Iterable

from .models import SourceDocument

_TEXT_SUFFIXES = {
    ".py", ".pyi", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json",
    ".md", ".mdx", ".txt", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".sh", ".bash", ".zsh", ".css", ".scss", ".html", ".htm", ".sql", ".graphql",
    ".gql", ".xml", ".csv",
}
_SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".ruff_cache",
    "dist", "build", ".next", "coverage", ".teacher_rag",
}
_SECRET_FILENAMES = {
    ".env", ".env.local", ".env.production", ".env.development", ".npmrc", ".pypirc",
}


def iter_repository_documents(root: Path) -> Iterable[SourceDocument]:
    root = root.resolve()
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in _SKIP_DIRS for part in relative.parts):
            continue
        lowered_name = path.name.lower()
        if lowered_name in _SECRET_FILENAMES or lowered_name.startswith(".env."):
            continue
        if path.suffix.lower() not in _TEXT_SUFFIXES:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if not content.strip():
            continue
        rel = relative.as_posix()
        yield SourceDocument(
            source_id=f"repo:{rel}",
            title=rel,
            content=content,
            metadata={"kind": "repository_file", "path": rel, "suffix": path.suffix.lower()},
        )


def vectorize_repository(tutor, root: Path) -> dict[str, int]:
    files = 0
    chunks = 0
    for document in iter_repository_documents(root):
        files += 1
        chunks += tutor.ingest(document, replace_source=True)
    return {"files": files, "chunks": chunks}
