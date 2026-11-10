"""背离检测器单元测试"""
import pytest

from core.divergence_detector import DivergenceDetector
from data.models.audit_result import RiskLevel


class TestDivergenceDetector:
    def setup_method(self):
        self.detector = DivergenceDetector()

    def test_no_divergence(self):
        signals = self.detector.detect(sentiment_score=50, health_score=55)
        assert len(signals) == 0

    def test_critical_divergence(self):
        signals = self.detector.detect(sentiment_score=85, health_score=25)
        assert len(signals) == 1
        assert signals[0].severity > 0.5

    def test_high_risk(self):
        risk = self.detector.infer_risk(sentiment=75, health=35)
        assert risk == RiskLevel.CRITICAL

    def test_low_risk(self):
        risk = self.detector.infer_risk(sentiment=45, health=50)
        assert risk == RiskLevel.LOW
