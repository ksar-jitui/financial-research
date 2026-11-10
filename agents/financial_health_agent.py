"""Agent B — 财务健康度评估 Agent"""
from __future__ import annotations

from typing import Any

from agents.base_agent import BaseAgent
from config.prompts.financial_health import FINANCIAL_HEALTH_SYSTEM, FINANCIAL_HEALTH_USER
from data.models.financial_metrics import FinancialMetrics


class FinancialHealthAgent(BaseAgent):
    agent_name = "FinancialHealthAgent"

    async def analyze(self, metrics: FinancialMetrics, **kwargs: Any) -> dict:
        """基于计算后的财务指标，调用 LLM 进行综合评估。"""
        snapshots_table = self._format_snapshots(metrics)
        prompt = FINANCIAL_HEALTH_USER.format(
            company_code=metrics.company_code,
            revenue_yoy=metrics.revenue_yoy,
            net_profit_yoy=metrics.net_profit_yoy,
            cashflow_yoy=metrics.cashflow_yoy,
            snapshots_table=snapshots_table,
        )
        result = await self._call_llm(FINANCIAL_HEALTH_SYSTEM, prompt)
        result["_computed_health_score"] = metrics.health_score
        return result

    @staticmethod
    def _format_snapshots(metrics: FinancialMetrics) -> str:
        lines = ["年度 | 营收(亿) | 净利润(亿) | 经营现金流(亿)"]
        lines.append("-" * 50)
        for s in metrics.snapshots:
            lines.append(
                f"{s.year} | {s.revenue / 1e8:.2f} | {s.net_profit / 1e8:.2f} | "
                f"{s.operating_cashflow / 1e8:.2f}"
            )
        return "\n".join(lines)
