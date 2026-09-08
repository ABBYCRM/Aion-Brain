from __future__ import annotations

import json
from importlib.resources import files
from .models import SourceDocument


def load_python_ecosystem_curriculum() -> list[SourceDocument]:
    resource = files("teacher_rag.data").joinpath("python_ecosystem.json")
    payload = json.loads(resource.read_text(encoding="utf-8"))
    return [SourceDocument.model_validate(item) for item in payload]


def seed_curriculum(tutor) -> int:
    total = 0
    for document in load_python_ecosystem_curriculum():
        total += tutor.ingest(document)
    return total
