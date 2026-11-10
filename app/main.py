"""年报语调操纵审计 Agent — Streamlit 主入口"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import streamlit as st

from app.components.metric_card import render_metric_card
from app.components.sentiment_gauge import render_sentiment_gauge
from app.components.divergence_alert import render_divergence_alert

st.set_page_config(
    page_title="年报语调操纵审计 Agent",
    page_icon="🔍",
    layout="wide",
    initial_sidebar_state="expanded",
)


def main():
    st.title("🔍 年报语调操纵审计 Agent")
    st.caption("2026 Qoder 高校创造力大赛 — 学术/StudyHack 赛道")

    with st.sidebar:
        st.header("分析参数")
        company_code = st.text_input("公司代码 (股票代码)", value="000001", max_chars=6)
        year = st.number_input("审计年度", min_value=2015, max_value=2026, value=2024, step=1)
        st.divider()
        st.markdown("**数据源**")
        st.markdown("- 📄 巨潮资讯 (年报PDF)")
        st.markdown("- 📊 东方财富 (财务数据)")
        st.divider()
        run_btn = st.button("🚀 开始审计分析", type="primary", use_container_width=True)

    if run_btn:
        _run_analysis(company_code, year)
    else:
        _render_welcome()


def _render_welcome():
    st.markdown(
        """
        ### 使用说明

        本工具通过多 Agent 协同，自动完成年报语调操纵的审计分析：

        1. **输入公司代码和年度** — 左侧面板中输入目标股票代码（如 000001）和审计年度
        2. **启动分析** — 点击「开始审计分析」按钮
        3. **查看结果** — 系统自动完成数据获取、文本分析、财务评估和背离检测

        #### 分析流程
        ```
        数据获取 → PDF解析 → 文本情绪打分 → 财务健康度评估 → 背离检测 → 审计报告
        ```

        > ⚠️ 本工具仅供学术研究使用，审计结论不构成任何投资建议。
        """
    )

    col1, col2, col3 = st.columns(3)
    with col1:
        st.metric("文本情绪 Agent", "乐观度打分", help="对 MD&A 文本进行分块分析")
    with col2:
        st.metric("财务健康度 Agent", "多维指标评估", help="基于三年财务数据综合评分")
    with col3:
        st.metric("Leader 审计 Agent", "背离检测判定", help="比对语调与财务，识别异常")


async def _async_analysis(company_code: str, year: int):
    from data.acquisition.cninfo_client import CninfoClient
    from data.acquisition.eastmoney_client import EastmoneyClient
    from data.processing.pdf_parser import PDFParser
    from data.processing.financial_calculator import FinancialCalculator
    from core.sentiment_scorer import SentimentScorer
    from core.health_scorer import HealthScorer
    from agents.leader_agent import LeaderAgent
    from core.report_generator import ReportGenerator

    progress = st.progress(0, text="正在初始化...")

    progress.progress(10, text="正在下载年报 PDF...")
    cninfo = CninfoClient()
    try:
        pdf_path = await cninfo.download_annual_report(company_code, year)
    except Exception as e:
        st.error(f"年报下载失败: {e}")
        return None

    progress.progress(25, text="正在解析 PDF 提取 MD&A...")
    parser = PDFParser()
    report = parser.parse(pdf_path)

    progress.progress(40, text="正在获取财务数据...")
    eastmoney = EastmoneyClient()
    financial_metrics = await eastmoney.fetch_financial_data(company_code)
    calculator = FinancialCalculator()
    financial_metrics = calculator.calculate(financial_metrics)

    progress.progress(55, text="Agent A: 分析文本情绪...")
    sentiment_scorer = SentimentScorer()
    sentiment_result = await sentiment_scorer.score(report)

    progress.progress(70, text="Agent B: 评估财务健康度...")
    health_scorer = HealthScorer()
    financial_result = await health_scorer.score(company_code)
    financial_result["revenue_yoy"] = financial_metrics.revenue_yoy
    financial_result["net_profit_yoy"] = financial_metrics.net_profit_yoy
    financial_result["cashflow_yoy"] = financial_metrics.cashflow_yoy
    financial_result["health_score"] = financial_metrics.health_score

    progress.progress(85, text="Leader Agent: 审计判定...")
    leader = LeaderAgent()
    audit_result = await leader.analyze(
        sentiment_result=sentiment_result,
        financial_result=financial_result,
        company_code=company_code,
        year=year,
    )

    progress.progress(95, text="生成审计报告...")
    generator = ReportGenerator()
    paths = generator.generate(audit_result)

    progress.progress(100, text="分析完成!")
    return {
        "audit_result": audit_result,
        "sentiment": sentiment_result,
        "financial": financial_result,
        "report": report,
        "export_paths": paths,
    }


def _run_analysis(company_code: str, year: int):
    with st.spinner("正在执行多 Agent 协同分析..."):
        try:
            loop = asyncio.new_event_loop()
            result = loop.run_until_complete(_async_analysis(company_code, year))
            loop.close()
        except Exception as e:
            st.error(f"分析过程出错: {e}")
            return

    if result is None:
        return

    _render_results(result)


def _render_results(result: dict):
    audit = result["audit_result"]
    sentiment = result["sentiment"]
    financial = result["financial"]

    st.divider()
    st.subheader(f"📊 审计结果 — {audit.company_code} ({audit.year}年度)")

    col1, col2, col3 = st.columns(3)
    with col1:
        render_metric_card("文本乐观度", f"{audit.sentiment_score:.1f}", "/ 100")
    with col2:
        render_metric_card("财务健康度", f"{audit.financial_health_score:.1f}", "/ 100")
    with col3:
        risk_color = {
            "低风险": "green",
            "中风险": "orange",
            "高风险": "red",
            "极高风险": "darkred",
        }
        color = risk_color.get(audit.overall_risk.value, "gray")
        st.markdown(
            f"""<div style="text-align:center; padding:1rem;">
            <div style="font-size:0.9rem; color:gray;">综合风险等级</div>
            <div style="font-size:2rem; font-weight:bold; color:{color};">{audit.overall_risk.value}</div>
            </div>""",
            unsafe_allow_html=True,
        )

    st.divider()

    col_left, col_right = st.columns(2)
    with col_left:
        render_sentiment_gauge(audit.sentiment_score, audit.financial_health_score)
    with col_right:
        render_divergence_alert(audit.divergence_signals)

    with st.expander("📝 审计结论", expanded=True):
        st.markdown(audit.conclusion)

    with st.expander("💬 管理层核心论点"):
        for arg in audit.key_arguments:
            st.markdown(f"- {arg}")

    with st.expander("📄 年报原文追溯"):
        report = result["report"]
        for section in report.mda_sections:
            st.markdown(f"**{section.title}** (第 {section.page_start}-{section.page_end} 页)")
            st.text_area("", value=section.content[:500], height=150, disabled=True, key=f"sec_{section.page_start}")

    export = result.get("export_paths", {})
    if export:
        st.divider()
        st.subheader("📥 导出报告")
        col1, col2 = st.columns(2)
        with col1:
            if "json" in export:
                st.download_button(
                    "下载 JSON 报告",
                    data=export["json"].read_bytes(),
                    file_name=export["json"].name,
                    mime="application/json",
                )
        with col2:
            if "markdown" in export:
                st.download_button(
                    "下载 Markdown 报告",
                    data=export["markdown"].read_bytes(),
                    file_name=export["markdown"].name,
                    mime="text/markdown",
                )


if __name__ == "__main__":
    main()
