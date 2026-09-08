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
    nvidia_model: str = "meta/llama-3.1-70b-instruct"
    embeddings_api_key: str | None = None
    embeddings_base_url: str = "https://api.openai.com/v1"
    embeddings_model: str = "text-embedding-3-small"
    request_timeout_seconds: float = 45.0
