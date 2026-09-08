from __future__ import annotations

from pathlib import Path
from typing import Iterable
from .models import SourceDocument

_TEXT_SUFFIXES = {'.py','.pyi','.js','.mjs','.cjs','.ts','.tsx','.jsx','.json','.md','.mdx','.txt','.yaml','.yml','.toml','.ini','.cfg','.conf','.env','.sh','.bash','.zsh','.css','.scss','.html','.htm','.sql','.graphql','.gql','.xml','.csv'}
_SKIP_DIRS = {'.git','node_modules','.venv','venv','__pycache__','.pytest_cache','.ruff_cache','dist','build','.next','coverage','.teacher_rag'}


def iter_repository_documents(root: Path) -> Iterable[SourceDocument]:
    root = root.resolve()
    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        if any(part in _SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        if path.name == '.env' or path.suffix.lower() not in _TEXT_SUFFIXES:
            continue
        try:
            content = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue
        if not content.strip():
            continue
        rel = path.relative_to(root).as_posix()
        yield SourceDocument(source_id=f'repo:{rel}', title=rel, content=content, metadata={'kind':'repository_file','path':rel,'suffix':path.suffix.lower()})


def vectorize_repository(tutor, root: Path) -> dict[str, int]:
    files = 0
    chunks = 0
    for document in iter_repository_documents(root):
        files += 1
        chunks += tutor.ingest(document, replace_source=True)
    return {'files': files, 'chunks': chunks}
