from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    db_path: Path = Path(".teacher_rag/teacher_rag.sqlite3")
    top_k: int = 5
    chunk_size: int = 900
    chunk_overlap: int = 120

    nvidia_api_key: str | None = None
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_model: str = "nvidia/nemotron-3.5-lightning-30b-a3b"

    # NVIDIA NIM embeddings. EMBEDDINGS_API_KEY may be a dedicated nvapi key;
    # if omitted, TeacherRAG reuses NVIDIA_API_KEY.
    embeddings_api_key: str | None = None
    embeddings_base_url: str = "https://integrate.api.nvidia.com/v1"
    embeddings_model: str = "nvidia/nemotron-3-embed-1b"

    request_timeout_seconds: float = 45.0
