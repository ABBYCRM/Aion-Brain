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
    bitdeer_api_key: str | None = None
    nvidia_base_url: str = "https://api-inference.bitdeer.ai/v1"
    nvidia_model: str = "mistralai/Mistral-Large-3-675B-Instruct-2512"

    # Bitdeer embeddings. EMBEDDINGS_API_KEY may be dedicated;
    # if omitted, TeacherRAG reuses BITDEER_API_KEY / NVIDIA_API_KEY.
    embeddings_api_key: str | None = None
    embeddings_base_url: str = "https://api-inference.bitdeer.ai/v1"
    embeddings_model: str = "nvidia/Nemotron-3-Embed-1B-BF16"

    request_timeout_seconds: float = 45.0
