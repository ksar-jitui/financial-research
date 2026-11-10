"""背离检测器 — 比较情绪评分与财务评分，识别异常信号"""
from __future__ import annotations

from data.models.audit_result import AuditResult, DivergenceSignal, RiskLevel


class DivergenceDetector:
    """规则引擎：基于阈值检测语调与财务的背离。"""

    THRESHOLDS = [
        (80, 30, RiskLevel.CRITICAL, "极度乐观语调与严重财务恶化背离"),
        (70, 40, RiskLevel.HIGH, "显著乐观-财务下滑背离"),
        (60, 50, RiskLevel.MEDIUM, "轻度语调偏乐观-财务承压背离"),
    ]

    def detect(
        self, sentiment_score: float, health_score: float, evidence: dict | None = None
    ) -> list[DivergenceSignal]:
        signals: list[DivergenceSignal] = []

        for sent_threshold, health_threshold, risk, desc in self.THRESHOLDS:
            if sentiment_score >= sent_threshold and health_score <= health_threshold:
                severity = min(1.0, (sentiment_score - health_score) / 100)
                signals.append(
                    DivergenceSignal(
                        signal_type=desc,
                        severity=severity,
                        description=(
                            f"文本乐观度 {sentiment_score:.1f} 显著高于 "
                            f"财务健康度 {health_score:.1f}，差距 {sentiment_score - health_score:.1f} 分"
                        ),
                        evidence_texts=(evidence or {}).get("quotes", []),
                        evidence_metrics=(evidence or {}).get("metrics", []),
                    )
                )
                break

        return signals

    def infer_risk(self, sentiment: float, health: float) -> RiskLevel:
        for sent_t, health_t, risk, _ in self.THRESHOLDS:
            if sentiment >= sent_t and health <= health_t:
                return risk
        return RiskLevel.LOW
