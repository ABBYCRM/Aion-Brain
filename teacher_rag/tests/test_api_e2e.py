from pathlib import Path

from fastapi.testclient import TestClient

import teacher_rag.api as api_module
from teacher_rag.api import app
from teacher_rag.config import Settings
from teacher_rag.tutor import TeacherRAG


def test_api_seed_search_and_teach_e2e(tmp_path: Path, monkeypatch):
    tutor = TeacherRAG(Settings(db_path=tmp_path / "api.sqlite3", top_k=4))
    monkeypatch.setattr(api_module, "get_tutor", lambda: tutor)

    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["ok"] is True

        seed = client.post("/v1/seed")
        assert seed.status_code == 200
        assert seed.json()["chunks_written"] >= 20

        search = client.post("/v1/search", json={"query": "FastAPI HTTP API", "top_k": 3})
        assert search.status_code == 200
        assert any(item["source_id"] == "fastapi" for item in search.json())

        teach = client.post(
            "/v1/teach",
            json={"query": "Teach me FastAPI", "learner": {"level": "beginner"}},
        )
        assert teach.status_code == 200
        body = teach.json()
        assert body["answer"]
        assert body["quick_check"]
        assert body["citations"]
