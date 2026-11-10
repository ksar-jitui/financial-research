"""财务健康度评分引擎 — 编排数据获取、计算和 LLM 评估"""
from __future__ import annotations

from data.models.financial_metrics import FinancialMetrics
from data.processing.financial_calculator import FinancialCalculator
from data.acquisition.eastmoney_client import EastmoneyClient
from agents.financial_health_agent import FinancialHealthAgent
from utils.llm_client import LLMClient


class HealthScorer:
    """端到端的财务健康度评估流水线。"""

    def __init__(self, llm_client: LLMClient | None = None) -> None:
        self._agent = FinancialHealthAgent(llm_client)
        self._calculator = FinancialCalculator()
        self._client = EastmoneyClient()

    async def score(self, company_code: str) -> dict:
        metrics = await self._client.fetch_financial_data(company_code)
        metrics = self._calculator.calculate(metrics)
        return await self._agent.analyze(metrics)
