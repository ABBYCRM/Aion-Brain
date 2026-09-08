from pathlib import Path
from teacher_rag.config import Settings
from teacher_rag.tutor import TeacherRAG
from teacher_rag.vectorize import iter_repository_documents, vectorize_repository


def test_repository_vectorization_chunks_and_indexes_files(tmp_path: Path):
    repo = tmp_path / 'repo'; repo.mkdir()
    (repo / 'app.py').write_text('def add(a, b):\n    return a + b\n', encoding='utf-8')
    (repo / 'README.md').write_text('# Demo\nFastAPI service and testing notes.\n', encoding='utf-8')
    (repo / '.env').write_text('SECRET=do-not-index\n', encoding='utf-8')
    (repo / 'node_modules').mkdir(); (repo / 'node_modules' / 'ignored.js').write_text('ignore me', encoding='utf-8')
    tutor = TeacherRAG(Settings(db_path=tmp_path / 'rag.sqlite3', chunk_size=24, chunk_overlap=4))
    result = vectorize_repository(tutor, repo)
    assert result['files'] == 2
    assert result['chunks'] >= 2
    assert tutor.store.count() == result['chunks']
    assert any(hit.metadata.get('path') == 'README.md' for hit in tutor.search('FastAPI testing', top_k=3))


def test_iter_repository_documents_skips_secrets_and_vendor_dirs(tmp_path: Path):
    (tmp_path / 'main.py').write_text("print('ok')", encoding='utf-8')
    (tmp_path / '.env').write_text('TOKEN=x', encoding='utf-8')
    (tmp_path / '.git').mkdir(); (tmp_path / '.git' / 'config').write_text('secret-ish', encoding='utf-8')
    docs = list(iter_repository_documents(tmp_path))
    assert [doc.metadata['path'] for doc in docs] == ['main.py']
