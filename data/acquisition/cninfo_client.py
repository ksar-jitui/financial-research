"""巨潮资讯 (cninfo) MCP 客户端 — 获取年报 PDF"""
from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings
from utils.rate_limiter import RateLimiter


class CninfoClient:
    """通过 cninfo-mcp 服务下载年报 PDF，内置并发限流。"""

    def __init__(self) -> None:
        self._base_url = settings.cninfo_mcp_url
        self._limiter = RateLimiter(max_concurrent=settings.max_concurrent_pdf_downloads)
        self._storage_dir = settings.data_storage_dir / "pdfs"
        self._storage_dir.mkdir(parents=True, exist_ok=True)

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=30))
    async def download_annual_report(self, stock_code: str, year: int) -> Path:
        """下载指定公司指定年度的年报 PDF，返回本地路径。"""
        output_path = self._storage_dir / f"{stock_code}_{year}.pdf"
        if output_path.exists():
            return output_path

        async with self._limiter():
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    f"{self._base_url}/api/report/download",
                    json={"stock_code": stock_code, "year": year},
                )
                resp.raise_for_status()
                data = resp.json()
                pdf_url = data.get("pdf_url", "")

                pdf_resp = await client.get(pdf_url)
                pdf_resp.raise_for_status()
                output_path.write_bytes(pdf_resp.content)

        return output_path

    async def search_reports(self, stock_code: str, limit: int = 5) -> list[dict]:
        """搜索指定公司的年报列表。"""
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{self._base_url}/api/report/search",
                params={"stock_code": stock_code, "category": "年报", "limit": limit},
            )
            resp.raise_for_status()
            return resp.json().get("results", [])
