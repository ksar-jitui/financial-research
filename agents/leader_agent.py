"""Leader Agent — 审计判定引擎，比对文本情绪与财务健康度"""
from __future__ import annotations

from typing import Any

from agents.base_agent import BaseAgent
from config.prompts.leader_audit import LEADER_AUDIT_SYSTEM, LEADER_AUDIT_USER
from data.models.audit_result import AuditResult, DivergenceSignal, RiskLevel


class LeaderAgent(BaseAgent):
    agent_name = "LeaderAgent"

    async def analyze(
        self,
        sentiment_result: dict,
        financial_result: dict,
        company_code: str,
        year: int,
        **kwargs: Any,
    ) -> AuditResult:
        """汇总 A/B Agent 结果，调用 LLM 做最终审计判定。"""
        sentiment_score = sentiment_result.get("sentiment_score", 50)
        health_score = financial_result.get("health_score", 50)

        prompt = LEADER_AUDIT_USER.format(
            sentiment_score=sentiment_score,
            key_arguments=str(sentiment_result.get("key_arguments", [])),
            positive_keywords=str(sentiment_result.get("positive_keywords", [])),
            negative_keywords=str(sentiment_result.get("negative_keywords", [])),
            health_score=health_score,
            revenue_yoy=financial_result.get("revenue_yoy", 0),
            net_profit_yoy=financial_result.get("net_profit_yoy", 0),
            cashflow_yoy=financial_result.get("cashflow_yoy", 0),
            company_code=company_code,
            year=year,
        )

        llm_result = await self._call_llm(LEADER_AUDIT_SYSTEM, prompt)
        return self._build_audit_result(
            llm_result, sentiment_score, health_score, company_code, year
        )

    def _build_audit_result(
        self,
        llm_result: dict,
        sentiment_score: float,
        health_score: float,
        company_code: str,
        year: int,
    ) -> AuditResult:
        signals = []
        for s in llm_result.get("divergence_signals", []):
            signals.append(
                DivergenceSignal(
                    signal_type=s.get("signal_type", ""),
                    severity=float(s.get("severity", 0)),
                    description=s.get("description", ""),
                    evidence_texts=s.get("evidence_texts", []),
                    evidence_metrics=s.get("evidence_metrics", []),
                )
            )

        risk_str = llm_result.get("overall_risk", "低风险")
        try:
            risk = RiskLevel(risk_str)
        except ValueError:
            risk = self._infer_risk(sentiment_score, health_score)

        return AuditResult(
            company_code=company_code,
            year=year,
            sentiment_score=sentiment_score,
            financial_health_score=health_score,
            divergence_signals=signals,
            overall_risk=risk,
            conclusion=llm_result.get("conclusion", ""),
            key_arguments=llm_result.get("recommendations", []),
        )

    @staticmethod
    def _infer_risk(sentiment: float, health: float) -> RiskLevel:
        gap = sentiment - health
        if sentiment > 70 and health < 40:
            return RiskLevel.CRITICAL
        if sentiment > 60 and health < 50:
            return RiskLevel.HIGH
        if sentiment > 50 and health < 50:
            return RiskLevel.MEDIUM
        return RiskLevel.LOW
