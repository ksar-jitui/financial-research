from __future__ import annotations

from pydantic import BaseModel, Field


class FinancialSnapshot(BaseModel):
    year: int
    revenue: float = Field(description="营业收入 (元)")
    net_profit: float = Field(description="归母净利润 (元)")
    operating_cashflow: float = Field(description="经营活动现金流净额 (元)")


class FinancialMetrics(BaseModel):
    company_code: str
    snapshots: list[FinancialSnapshot] = Field(default_factory=list)
    revenue_yoy: float = Field(default=0.0, description="营收同比增速")
    net_profit_yoy: float = Field(default=0.0, description="净利润同比增速")
    cashflow_yoy: float = Field(default=0.0, description="经营现金流同比增速")
    health_score: float = Field(default=0.0, ge=0, le=100, description="财务健康度综合评分 0-100")
