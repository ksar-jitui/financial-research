"""财务指标计算器 — 基于 Pandas 清洗、对齐、计算"""
from __future__ import annotations

import pandas as pd
import numpy as np

from data.models.financial_metrics import FinancialMetrics, FinancialSnapshot


class FinancialCalculator:
    """清洗财务数据、计算同比增速、Z-Score 标准化、综合健康度评分。"""

    def calculate(self, metrics: FinancialMetrics) -> FinancialMetrics:
        if len(metrics.snapshots) < 2:
            return metrics

        df = self._to_dataframe(metrics.snapshots)
        df = self._clean(df)
        df = self._compute_yoy(df)

        metrics.revenue_yoy = self._safe_float(df["revenue_yoy"].iloc[-1])
        metrics.net_profit_yoy = self._safe_float(df["net_profit_yoy"].iloc[-1])
        metrics.cashflow_yoy = self._safe_float(df["cashflow_yoy"].iloc[-1])
        metrics.health_score = self._compute_health_score(df)

        return metrics

    def _to_dataframe(self, snapshots: list[FinancialSnapshot]) -> pd.DataFrame:
        records = [s.model_dump() for s in snapshots]
        df = pd.DataFrame(records)
        df = df.sort_values("year").reset_index(drop=True)
        return df

    def _clean(self, df: pd.DataFrame) -> pd.DataFrame:
        numeric_cols = ["revenue", "net_profit", "operating_cashflow"]
        for col in numeric_cols:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
        return df

    def _compute_yoy(self, df: pd.DataFrame) -> pd.DataFrame:
        columns = {
            "revenue": "revenue_yoy",
            "net_profit": "net_profit_yoy",
            "operating_cashflow": "cashflow_yoy",
        }
        for col, yoy_col in columns.items():
            prev = df[col].shift(1)
            df[yoy_col] = np.where(prev != 0, (df[col] - prev) / prev.abs(), 0.0)
        return df

    def _compute_health_score(self, df: pd.DataFrame) -> float:
        yoy_cols = ["revenue_yoy", "net_profit_yoy", "cashflow_yoy"]
        available = [c for c in yoy_cols if c in df.columns]
        if not available:
            return 50.0

        latest = df[available].iloc[-1]
        z_scores = (latest - latest.mean()) / (latest.std() + 1e-9)
        raw_score = 50 - (z_scores.sum() / len(z_scores)) * 20
        return float(np.clip(raw_score, 0, 100))

    @staticmethod
    def _safe_float(val) -> float:
        try:
            return float(val)
        except (TypeError, ValueError):
            return 0.0
