"""审计报告生成器 — 汇总所有分析结果，输出结构化报告"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from config import settings
from data.models.audit_result import AuditResult


class ReportGenerator:
    """将审计结果导出为 JSON 和 Markdown 格式报告。"""

    def generate(self, result: AuditResult) -> dict[str, Path]:
        output_dir = settings.data_storage_dir / "exports"
        output_dir.mkdir(parents=True, exist_ok=True)

        base_name = f"{result.company_code}_{result.year}_{datetime.now():%Y%m%d_%H%M%S}"

        json_path = output_dir / f"{base_name}.json"
        json_path.write_text(
            json.dumps(result.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        md_path = output_dir / f"{base_name}.md"
        md_path.write_text(self._render_markdown(result), encoding="utf-8")

        return {"json": json_path, "markdown": md_path}

    def _render_markdown(self, result: AuditResult) -> str:
        lines = [
            f"# 年报语调操纵审计报告",
            f"",
            f"**公司代码**: {result.company_code}  ",
            f"**审计年度**: {result.year}  ",
            f"**生成时间**: {datetime.now():%Y-%m-%d %H:%M}  ",
            f"",
            f"---",
            f"",
            f"## 一、评分概览",
            f"",
            f"| 指标 | 评分 |",
            f"|------|------|",
            f"| 文本乐观度 | {result.sentiment_score:.1f} / 100 |",
            f"| 财务健康度 | {result.financial_health_score:.1f} / 100 |",
            f"| 综合风险等级 | **{result.overall_risk.value}** |",
            f"",
            f"## 二、背离信号",
            f"",
        ]

        if result.divergence_signals:
            for i, sig in enumerate(result.divergence_signals, 1):
                lines.extend([
                    f"### 信号 {i}: {sig.signal_type}",
                    f"- 严重程度: {sig.severity:.2f}",
                    f"- 描述: {sig.description}",
                ])
                if sig.evidence_texts:
                    lines.append(f"- 原文证据:")
                    for e in sig.evidence_texts:
                        lines.append(f"  > {e}")
                if sig.evidence_metrics:
                    lines.append(f"- 指标证据: {', '.join(sig.evidence_metrics)}")
                lines.append("")
        else:
            lines.append("未发现显著背离信号。\n")

        lines.extend([
            f"## 三、审计结论",
            f"",
            result.conclusion,
            f"",
            f"## 四、管理层核心论点",
            f"",
        ])
        for arg in result.key_arguments:
            lines.append(f"- {arg}")

        lines.extend(["", "---", f"*本报告由「年报语调操纵审计 Agent」自动生成，仅供学术研究参考。*"])

        return "\n".join(lines)
