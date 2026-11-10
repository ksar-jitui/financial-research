from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class RiskLevel(str, Enum):
    LOW = "低风险"
    MEDIUM = "中风险"
    HIGH = "高风险"
    CRITICAL = "极高风险"


class DivergenceSignal(BaseModel):
    signal_type: str = Field(description="背离信号类型, 如 '乐观语调-利润下滑'")
    severity: float = Field(ge=0, le=1, description="严重程度 0-1")
    description: str = Field(description="信号描述")
    evidence_texts: list[str] = Field(default_factory=list, description="支撑该信号的年报原文段落")
    evidence_metrics: list[str] = Field(default_factory=list, description="支撑该信号的财务指标")


class AuditResult(BaseModel):
    company_code: str
    year: int
    sentiment_score: float = Field(ge=0, le=100, description="文本乐观度评分")
    financial_health_score: float = Field(ge=0, le=100, description="财务健康度评分")
    divergence_signals: list[DivergenceSignal] = Field(default_factory=list)
    overall_risk: RiskLevel = Field(default=RiskLevel.LOW)
    conclusion: str = Field(default="", description="审计结论摘要")
    key_arguments: list[str] = Field(default_factory=list, description="管理层核心论点")
