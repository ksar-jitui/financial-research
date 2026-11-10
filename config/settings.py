from __future__ import annotations

from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    llm_api_key: str = ""
    llm_api_base: str = "https://api.openai.com/v1"
    llm_model_name: str = "gpt-4o"

    cninfo_mcp_url: str = "http://localhost:8000"
    eastmoney_mcp_url: str = "http://localhost:8001"

    streamlit_port: int = 8501
    cache_ttl_seconds: int = 3600
    max_concurrent_pdf_downloads: int = 3

    pdf_chunk_size: int = 1500
    pdf_chunk_overlap: int = 200

    data_storage_dir: Path = Path(__file__).resolve().parent.parent / "data_storage"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}
