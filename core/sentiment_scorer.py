"""情绪评分引擎 — 编排文本分块和 LLM 打分的完整流程"""
from __future__ import annotations

from data.models.annual_report import AnnualReport
from data.processing.text_chunker import TextChunker
from agents.text_sentiment_agent import TextSentimentAgent
from utils.llm_client import LLMClient


class SentimentScorer:
    """端到端的 MD&A 文本情绪评分流水线。"""

    def __init__(self, llm_client: LLMClient | None = None) -> None:
        self._agent = TextSentimentAgent(llm_client)
        self._chunker = TextChunker()

    async def score(self, report: AnnualReport) -> dict:
        mda_text = "\n\n".join(s.content for s in report.mda_sections)
        if not mda_text.strip():
            mda_text = report.full_text

        chunks = self._chunker.chunk(mda_text)
        return await self._agent.analyze(chunks=chunks)
