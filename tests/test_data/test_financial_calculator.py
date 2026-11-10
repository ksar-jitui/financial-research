"""财务计算器单元测试"""
import pytest

from data.models.financial_metrics import FinancialMetrics, FinancialSnapshot
from data.processing.financial_calculator import FinancialCalculator


class TestFinancialCalculator:
    def setup_method(self):
        self.calc = FinancialCalculator()

    def test_insufficient_data(self):
        metrics = FinancialMetrics(
            company_code="000001",
            snapshots=[FinancialSnapshot(year=2024, revenue=100, net_profit=10, operating_cashflow=20)],
        )
        result = self.calc.calculate(metrics)
        assert result.revenue_yoy == 0.0

    def test_yoy_calculation(self):
        metrics = FinancialMetrics(
            company_code="000001",
            snapshots=[
                FinancialSnapshot(year=2023, revenue=100, net_profit=10, operating_cashflow=20),
                FinancialSnapshot(year=2024, revenue=120, net_profit=8, operating_cashflow=25),
            ],
        )
        result = self.calc.calculate(metrics)
        assert abs(result.revenue_yoy - 0.2) < 0.01
        assert abs(result.net_profit_yoy - (-0.2)) < 0.01

    def test_health_score_range(self):
        metrics = FinancialMetrics(
            company_code="000001",
            snapshots=[
                FinancialSnapshot(year=2022, revenue=100, net_profit=10, operating_cashflow=20),
                FinancialSnapshot(year=2023, revenue=110, net_profit=12, operating_cashflow=22),
                FinancialSnapshot(year=2024, revenue=120, net_profit=14, operating_cashflow=25),
            ],
        )
        result = self.calc.calculate(metrics)
        assert 0 <= result.health_score <= 100
