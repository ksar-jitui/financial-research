"""年报语调操纵审计 Agent 的 Streamlit 前端。"""
from __future__ import annotations

import html
import math
import re
from collections.abc import Callable
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from audit_agents import (
    BAND_BOTTOM,
    DIVERGENCE_AMBER,
    DIVERGENCE_RED,
    FactReviewAgent,
    cited_paragraphs,
    classify_divergence,
    FinancialHealthAgent,
    LeaderAgent,
    QwenJSONClient,
    TextSentimentAgent,
)
from data_fetching import (
    fetch_annual_report_pdf,
    fetch_financial_data,
    fetch_industry,
    fetch_stock_list,
)
from reference_bands import REFERENCE
from data_processing import (
    POSITIVE_TONE_WORDS,
    analyze_lexical_tone,
    calculate_fog_index,
    clean_financials,
    extract_dense_highlight_pages,
    extract_highlight_image,
    extract_mda_text,
)

ProgressCallback = Callable[[int, str], None]
TREND_YEAR_COUNT = 5
GRADE_HEADLINE = {
    "red": ("发现语调与财务背离", "#fee2e2", "#dc2626", "#991b1b"),
    "amber": ("表述与基本面存在缺口 · 需核查", "#fef3c7", "#d97706", "#b45309"),
    "green": ("未发现显著语调背离", "#dcfce7", "#16a34a", "#166534"),
    "uncalibrated": ("参照分布未能定位，本轮不给出分档结论", "#f1f5f9", "#94a3b8", "#475569"),
}


_ALERT_RENDERERS = {"error": st.error, "warning": st.warning, "success": st.success}
_ALERT_ICONS = {"error": "🚨", "warning": "⚠️", "success": "✅"}
OPTIMISM_KEYWORDS = (
    "创历史新高",
    "历史新高",
    "大幅增长",
    "显著提升",
    "强劲增长",
    "跨越式发展",
    "全面向好",
    "重大突破",
    "成效显著",
    "稳步增长",
    "向好",
)
INTERROGATION_HISTORY_KEY = "interrogation_messages"
DD_REPORT_KEY = "dd_report_markdown"
MDA_EXCERPT_CHARS = 1500
INTERROGATION_SYSTEM_PROMPT = (
    "你是年报语调操纵审计 Agent 的主审分析师。仅依据下方【审计上下文】回答用户提问，"
    "引用其中的具体数字、段号或证据链，不得编造上下文之外的信息；上下文不足时明确说明缺口。"
    "回答使用中文，先给结论再给依据。\n\n"
)


def run_audit(
    stock_code: str,
    year: int | None = None,
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    code = stock_code.strip()
    if not re.fullmatch(r"\d{6}", code):
        raise ValueError("股票代码必须是 6 位数字，例如 000001")

    report_year = year or date.today().year - 1

    def report_progress(percent: int, message: str) -> None:
        if progress_callback:
            progress_callback(percent, message)

    report_progress(5, "初始化审计任务")
    text_agent = TextSentimentAgent()
    financial_agent = FinancialHealthAgent()
    fact_agent = FactReviewAgent()
    leader_agent = LeaderAgent()

    trend_years = list(range(report_year - TREND_YEAR_COUNT + 1, report_year + 1))

    report_progress(10, "正在抓取五年财务数据及同比基期")
    financial_df = fetch_financial_data(
        code,
        years=TREND_YEAR_COUNT + 1,
        end_year=report_year,
    )

    report_progress(15, "正在清洗财务数据并计算同比增速")
    cleaned_with_baseline = clean_financials(Path("data") / code / "financial_data.csv")
    cleaned_df = cleaned_with_baseline[
        cleaned_with_baseline["年度"].isin(trend_years)
    ].copy().reset_index(drop=True)
    missing_years = sorted(set(trend_years).difference(cleaned_df["年度"]))
    if missing_years:
        raise ValueError(f"财务数据缺少年度: {', '.join(map(str, missing_years))}")

    annual_paths: dict[int, Path] = {}
    mda_texts: dict[int, str] = {}
    sentiment_results: dict[int, dict[str, Any]] = {}
    lexical_results: dict[int, dict[str, Any]] = {}
    for index, trend_year in enumerate(trend_years):
        progress = 20 + index * 12
        report_progress(progress, f"正在下载 {trend_year} 年年度报告")
        annual_paths[trend_year] = fetch_annual_report_pdf(code, trend_year)

        report_progress(progress + 3, f"正在提取 {trend_year} 年 MD&A 文本")
        mda_texts[trend_year] = extract_mda_text(annual_paths[trend_year])

        report_progress(progress + 6, f"正在分析 {trend_year} 年管理层语调")
        sentiment_results[trend_year] = text_agent.analyze(mda_texts[trend_year])
        lexical_results[trend_year] = analyze_lexical_tone(mda_texts[trend_year])

    trend_df = cleaned_df[["年度", "净利润_YoY"]].copy()
    trend_df["语调虚高指数"] = trend_df["年度"].map(
        {year: result["sentiment_score"] for year, result in sentiment_results.items()}
    )
    trend_df["净利润同比增速"] = trend_df["净利润_YoY"] * 100
    trend_df = trend_df[["年度", "语调虚高指数", "净利润同比增速"]]

    sentiment_result = sentiment_results[report_year]
    sentiment_result["fog_index"] = calculate_fog_index(mda_texts[report_year])
    report_progress(85, "FinancialHealthAgent 正在执行财务规则")
    # 判定要在行业池里定位：板块普跌时的「居中」和行业独跌时的「居中」不是一回事。
    industry = fetch_industry(code)
    financial_result = financial_agent.analyze(cleaned_df, industry=industry)

    # 事实核对失败不能拖垮整次审计：它是补充证据，红线判定不依赖它。
    report_progress(89, "FactReviewAgent 正在独立核对两次重要经营变化")
    fact_result: dict[str, Any] | None = None
    fact_error: str | None = None
    try:
        fact_result = fact_agent.analyze(mda_texts[report_year], cleaned_df)
    except Exception as error:
        fact_error = f"事实核对未完成：{error}。其余审计结论不受影响——红线判定不依赖这一栏。"

    report_progress(95, "LeaderAgent 正在比对语调、事实核对与财务表现")
    audit_result = leader_agent.analyze(sentiment_result, financial_result, fact_result)

    report_progress(100, "审计分析完成")
    return {
        "stock_code": code,
        "industry": industry,
        "year": report_year,
        "financial_df": financial_df,
        "cleaned_df": cleaned_df,
        "trend_df": trend_df,
        "pdf_path": annual_paths[report_year],
        "pdf_paths": annual_paths,
        "sentiment_scores": {
            year: item["sentiment_score"] for year, item in sentiment_results.items()
        },
        "mda_text": mda_texts[report_year],
        "mda_texts": mda_texts,
        "lexical_tone": lexical_results,
        "sentiment": sentiment_result,
        "financial": financial_result,
        "fact_check": fact_result,
        "fact_error": fact_error,
        "audit": audit_result,
    }


@st.cache_data(ttl=86400, show_spinner=False)
def _load_stock_directory():
    return fetch_stock_list()


def main() -> None:
    st.set_page_config(page_title="年报语调操纵审计 Agent", layout="wide")
    _apply_styles()

    st.title("年报语调操纵审计 Agent")
    st.caption(
        "比对管理层讨论与分析语调与企业财务基本面（水平与同比变化），用背离度输出带证据链的审计风险预警。"
    )

    try:
        with st.spinner("正在加载 A 股股票名录"):
            stock_directory = _load_stock_directory()
    except Exception as exc:
        st.error(f"股票名录加载失败：{exc}")
        st.stop()

    stock_codes = stock_directory["股票代码"].tolist()
    name_by_code = dict(zip(stock_directory["股票代码"], stock_directory["股票名称"]))

    report_year = date.today().year - 1
    with st.container(border=True):
        input_column, button_column = st.columns([4, 1], vertical_alignment="bottom")
        with input_column:
            stock_code = st.selectbox(
                "股票代码或中文名称",
                options=stock_codes,
                index=None,
                placeholder="输入中文名称或股票代码，例如 平安银行 或 000001",
                format_func=lambda code: f"{name_by_code[code]}（{code}）",
            )
        with button_column:
            start_audit = st.button("开始审计", type="primary", use_container_width=True)
        st.caption(
            f"趋势分析覆盖 {report_year - TREND_YEAR_COUNT + 1}—{report_year} 年，"
            "需读取 5 份年报，并另取一年财务数据作为同比基期。"
        )

    if start_audit:
        st.session_state.pop("audit_result", None)
        st.session_state.pop(INTERROGATION_HISTORY_KEY, None)
        st.session_state.pop(DD_REPORT_KEY, None)
        if not stock_code:
            st.error("请先输入并选择一只股票。")
        elif not _llm_is_configured():
            st.error("通义千问服务尚未配置，请在 .streamlit/secrets.toml 中配置 DASHSCOPE_API_KEY 后重启应用。")
        else:
            progress_bar = st.progress(0, text="准备开始审计")
            try:
                result = run_audit(
                    stock_code,
                    report_year,
                    lambda percent, message: progress_bar.progress(percent, text=message),
                )
            except Exception as exc:
                progress_bar.empty()
                st.error(f"审计失败：{exc}")
            else:
                result["stock_name"] = name_by_code.get(stock_code, stock_code)
                st.session_state["audit_result"] = result
                st.success("审计分析完成，结果已更新。")

    result = st.session_state.get("audit_result")
    if result:
        _render_results(result)
    else:
        st.info("输入中文股票名称或代码，选择股票后点击“开始审计”，分析结果将在此处展示。")


def _render_results(result: dict[str, Any]) -> None:
    sentiment = result["sentiment"]
    financial = result["financial"]
    audit = result["audit"]

    st.divider()
    st.subheader(f"{result['stock_code']} · {result['year']} 年度审计结果")

    chart_column, gauge_column = st.columns([3, 2], gap="large")
    with chart_column:
        st.plotly_chart(_build_financial_chart(result["cleaned_df"]), use_container_width=True)
    with gauge_column:
        st.plotly_chart(_build_sentiment_gauge(sentiment["sentiment_score"]), use_container_width=True)
        st.caption(_tone_reliability_line(sentiment))

    latest_financials = result["cleaned_df"].sort_values("年度").iloc[-1]
    audit_divergence = classify_divergence(sentiment["sentiment_score"], financial)
    health_column, change_column, divergence_column, f_score_column, fog_column = st.columns(5)
    with health_column:
        st.metric(
            "财务基本面 · 水平分",
            f"{financial['health_score']:.2f} / 100",
            financial["health_level"],
            help="规则引擎对本年度基本面的打分，回答「现在站不站得住」。",
        )
    with change_column:
        change_score = financial.get("change_score")
        st.metric(
            "财务基本面 · 同比变化",
            "—" if change_score is None else f"{change_score:+.2f} 分",
            "无可比上一年" if change_score is None else _change_label(financial),
            help="同一套规则在「少最后一年」的窗口上重算后的差值，回答「正在变好还是变坏」。",
        )
    with divergence_column:
        st.metric(
            "背离度（主判据）",
            "—" if audit_divergence["divergence"] is None else f"{audit_divergence['divergence']:+.2f}",
            _grade_label(audit_divergence),
            help="= 语调虚高指数 − 财务基本面最差一侧的百分位。两侧同为 0–100，缺口才有意义。",
        )
    with f_score_column:
        st.metric(
            "Piotroski F-Score",
            f"{int(latest_financials['Piotroski_F_Score'])} / 9",
            help="经典九项财务评分；缺失或无法跨期比较的项目计 0 分。",
        )
        st.caption(f"有效评分项：{int(latest_financials['F_Score_有效项数'])} / 9")
    with fog_column:
        st.metric(
            "MD&A FOG 指数",
            f"{sentiment['fog_index']:.2f}",
            help="数值越高，表示平均句长和复杂词占比越高，文本越难阅读。",
        )
    st.caption(
        "F-Score 同时展示有效评分项数，避免将字段缺失误判为完整九项低分；"
        "FOG 为适配中文 MD&A 的文本复杂度指标，不直接等同于英文阅读年级。"
    )

    _render_divergence_alert(financial, audit_divergence)
    _render_methodology_note()

    st.subheader("五年语调与利润增速分化轨迹")
    st.plotly_chart(_build_divergence_chart(result["trend_df"]), use_container_width=True)
    st.caption(
        "红线为各年语调虚高指数（越高表示表述越缺乏数据支撑），蓝线为财报归母净利润同比增速；"
        "点击播放可按年份展开，也可拖动滑块比较。"
    )

    _render_evidence_panel(result)
    _render_fact_review(result)

    if financial["abnormalities"]:
        with st.expander("财务异常与结构差异", expanded=True):
            for item in financial["abnormalities"]:
                st.markdown(f"- {item}")

    _render_audit_conclusion(audit)

    shells = audit.get("evidence_dropped_shells", 0)
    filled = audit.get("evidence_filled", [])
    if shells or filled:
        bits = []
        if shells:
            bits.append(f"剔除 {shells} 条空壳引用（模型回吐了提示词里的示例格式）")
        if filled:
            bits.extend(filled)
        st.caption("证据链处理记录：" + "；".join(bits) + "。")

    with st.expander("管理层关键论点"):
        claims = sentiment.get("key_claims", [])
        rejected = sentiment.get("claims_rejected", 0)
        # 与线上同一口径：可核性说明数的是屏幕上这一批，不取服务端截断前的计数，
        # 否则「N 条无法定位」可能描述的是根本没显示的条目。
        unanchored = sum(1 for claim in claims if not cited_paragraphs(claim))
        notes = [
            f"共 {len(claims)} 条，按 MD&A 原文位置排列，"
            f"段号已按本次抽取的 {sentiment.get('paragraph_count', 0)} 段校验"
        ]
        if unanchored:
            notes.append(f"其中 {unanchored} 条无段号、无法定位原文")
        if sentiment.get("claims_folded"):
            notes.append(f"两遍打分合并 {sentiment['claims_folded']} 条同段落重复")
        if rejected:
            notes.append(f"剔除 {rejected} 条（引用了不存在的段号）")
        st.caption("；".join(notes) + "。")
        if claims:
            for claim in claims:
                st.markdown(f"- {claim}")
        else:
            st.write("未提取到管理层声称业绩改善的关键论点。")

    with st.expander("查看清洗后的财务数据"):
        st.dataframe(result["cleaned_df"], use_container_width=True, hide_index=True)

    _render_report_export(result)
    _render_interrogation(result)


def _tone_reliability_line(sentiment: dict[str, Any]) -> str:
    """两遍独立打分的差就是语调分的可复现范围。

    判定用的是缺口阈值，档位边界附近这个范围会直接翻转结论，所以不能只给一个数。
    """
    spread = sentiment.get("score_spread")
    passes = sentiment.get("pass_scores") or []
    if spread is None or len(passes) < 2:
        return "两遍独立打分未全部成功，本轮语调分未经复现。"
    unstable = sentiment.get("unstable_chunks") or 0
    return (
        f"语调分两遍独立打分 {' / '.join(f'{v:.2f}' for v in passes)}，"
        f"差 {spread:.2f}（取中位为本轮分）；{sentiment.get('chunks', 0)} 块中 {unstable} 块块内分歧 >5。"
    )


def _verdict_label(audit: dict[str, Any]) -> str:
    """结论措辞跟随分档规则，不跟随模型的 anomaly——两处来源不同，同屏就会自相矛盾。"""
    grade = audit.get("alert_grade") or ("red" if audit["anomaly"] else "green")
    return GRADE_HEADLINE.get(grade, GRADE_HEADLINE["green"])[0]


def _classify_divergence(audit_divergence: dict[str, Any]) -> tuple[str, str, str]:
    """把背离度档位翻成告警灯状态，返回 (状态, 标题, 说明)。"""
    if audit_divergence["grade"] == "red":
        return (
            "error",
            "严重背离：疑似语调操纵",
            "表述明显跑在基本面前面，且财务面处于「水平偏弱」或「同比恶化」之一，"
            "建议重点核查收入确认、减值计提与披露措辞。",
        )
    if audit_divergence["grade"] == "amber":
        return (
            "warning",
            "需核查：表述与基本面存在缺口",
            "背离度已进入黄线区间，但财务面尚未落到最差一档，"
            "建议结合后续披露、现金流趋势与同业表述交叉验证。",
        )
    return (
        "success",
        "正常匹配",
        "表述强度与财务基本面之间未见明显缺口，未触发语调背离预警信号。",
    )


def _weakness_summary() -> str:
    """把「最差一侧」的经验分位数压成一行，供方法论说明直接引用实测值。"""
    grid = REFERENCE["weakness"]["grid"]
    wanted = {10: None, 25: None, 50: None, 75: None, 90: None}
    for percentile, value in grid:
        if percentile in wanted and wanted[percentile] is None:
            wanted[percentile] = value
    return "　".join(f"p{k}={v}" for k, v in wanted.items())


def _base_rate(tone: float, cut: float) -> str:
    from reference_bands import percentile_in

    value = percentile_in(tone - cut, REFERENCE["weakness"]["grid"])
    return "未知" if value is None else f"{value:.1f}"


GRADE_LABELS = {"red": "红线 · 背离", "amber": "黄线 · 需核查", "green": "绿线 · 未见缺口"}
GRADE_LABELS["uncalibrated"] = "未标定"


def _grade_label(audit_divergence: dict[str, Any]) -> str:
    """档位标签：降过档就写明原级别，让规则的作用可见。"""
    label = GRADE_LABELS.get(audit_divergence["grade"], audit_divergence["grade"])
    if audit_divergence.get("downgraded"):
        return f"{label}（优质档降档，原 {audit_divergence['raw_grade']}）"
    return label


def _change_label(financial: dict[str, Any]) -> str:
    """同比变化的档位只看分位，不看原始差值：差值大小依赖基期，分位才可跨公司比较。"""
    pct = (financial.get("band") or {}).get("change_percentile")
    if pct is None:
        return "无可比同比"
    if pct <= BAND_BOTTOM:
        return "同比恶化"
    if pct >= 100 - BAND_BOTTOM:
        return "同比改善"
    return "基本持平"


def _band_source_line(financial: dict[str, Any]) -> str:
    """把分位带的组别与样本量写进说明：读者要能看出这个百分位来自哪一批观测。"""
    band = financial.get("band") or {}
    if band.get("level_percentile") is None:
        return "- 分位带：参照分布未能定位该分数，本轮不给百分位。"
    kind = {
        "industry": "一级板块",
        "org": "实体/金融分组",
        "market": "全市场",
    }.get(band.get("group_kind"), "未标定")
    return (
        f"- 分位带来源：{kind}｜{band.get('group_label', '未标定')}，组内 {band.get('group_n', 0)} 个观测，"
        f"普查生成于 {band.get('reference_generated_at', '未知')}"
    )


def _render_divergence_alert(
    financial: dict[str, Any],
    audit_divergence: dict[str, Any],
) -> None:
    """渲染红/黄/绿告警灯，并把缺口是怎么算出来的当场写出来。"""
    status, title, detail = _classify_divergence(audit_divergence)
    change_score = financial.get("change_score")
    if audit_divergence.get("downgraded"):
        title = f"{title}（优质档降档，原 {audit_divergence['raw_grade']}）"
    message = (
        f"**{title}**　{detail}\n\n"
        f"{audit_divergence['reasons'][0]}　|　"
        f"同比变化 {'无可比上一年' if change_score is None else f'{change_score:+.2f} 分'}"
    )
    _ALERT_RENDERERS[status](message, icon=_ALERT_ICONS[status])
    st.caption(
        f"告警灯规则：背离度 = 语调虚高指数 − 财务最差一侧百分位；≥ {DIVERGENCE_RED:.0f} 红灯，"
        f"≥ {DIVERGENCE_AMBER:.0f} 黄灯，其余绿灯。「后四分之一」（百分位 ≤ {BAND_BOTTOM}）只用于解释结论，"
        "不另设条件——缺口达到 50 本身就意味着财务侧不高于 50。"
        "红灯条件与 LeaderAgent 强制复核规则一致；语调虚高指数单点不再触发任何灯。"
    )


def _render_methodology_note() -> None:
    """判据、标定来源与外部体系对照——被问「凭什么这么判」时的同一份答案。"""
    with st.expander("方法论 · 判据来源、参照样本与外部体系对照", expanded=False):
        st.markdown(
            f"""
**主判据**：背离度 = 语调虚高指数 − 财务基本面「最差一侧」的百分位（水平分位与同比变化分位取较小者）。
旧版红线「语调 &gt; 80 且健康分 &lt; 50」的两个数都没有实测依据，且在真实公司上从未触发过。
不用原始分相减：全市场普查测出水平原始分 p1–p99 跨 {REFERENCE['groups']['全市场']['level'][-1][1] - REFERENCE['groups']['全市场']['level'][0][1]:.1f} 分，而语调指数只在中高段走动，
两个量纲相差一个数量级的数相减，差值方差几乎全来自财务侧，「背离度」会退化成财务分的负数镜像；
换成百分位后两侧同为 0–100，缺口才真的表示「表述相对基本面的超出量」。
取最差一侧，是因为被掩饰的既可能是「本来就差」，也可能是「水平仍高但正在下滑」，后者是年报操纵里最常见的一种。

**现金流恶化的计量口径**：增速的分母是基期绝对值，而基期正是那个正在塌的数——基期 +0.03 亿、本期 −0.51 亿会报出 −1706%，
绝对缺口其实只有 0.54 亿。因此计分改用 <b>Δ ÷ 上年营业收入</b>（≤ −15% 扣 20 分、≤ −5% 扣 10 分），
绝对缺口不足 0.2 亿的既不扣分也不进异常列表；异常条目里直接写出「缺口相当于上年营收的 X%」。
分母用上年而非本年营收，是为了不把同一次下滑计两次。阈值来自 200 家真实公司的下降样本分布（p10 −19.2%、p25 −13.1%、p50 −6.2%）。

**参照分布**：由本仓库同一套规则对全市场 A 股年报行逐条打分算出，非抽样；
名录 {REFERENCE['universe']} 家全部取到可比年报，共 {REFERENCE['observations']} 个年度观测、{REFERENCE['change_observations']} 个同比变化观测，覆盖 {'、'.join(str(y) for y in REFERENCE['main_years'])} 年，生成于 {REFERENCE['generated_at']}。
线上版按实体/金融分组建带；「偏弱 / 恶化」= 参照分布后四分之一（百分位 ≤ 25）。

**切点的实测依据**：把 min(水平分位, 同比变化分位) 记作「最差一侧」，其经验分布为 {_weakness_summary()}。红线缺口 {DIVERGENCE_RED:.0f} 在语调 88 时对应全市场约 {_base_rate(88, DIVERGENCE_RED)}% 的基础命中率——即语调再高，也要财务最差一侧落到约第 23 百分位以内才亮红。

**判定用哪个池子**：同一个降幅，在板块普跌与板块独跌两种语境下性质完全不同——对常年增长、眼下遭遇行业周期底部的公司它叫增长失速，对本来就站在边缘的公司它叫生死存亡。
所以分位定位按「一级板块 → 实体/金融 → 全市场」依次退回，并如实写出最终用的是哪一层。
行业归属来自东方财富 RPT_F10_ORG_BASICINFO 的官方一级板块（免 Key、单公司一次请求）；取不到就退回上一层，绝不猜一个行业把公司塞进错误的池子。

**优质档自动降档**：毛利率与净利率**同时**处于行业前 5% 时，预警级别下调一档（红 → 黄，黄 → 绿）。
两个都要满足是为了避开单季波动；必须同池比较是因为银行的高净利率和白酒的高净利率不是同一件事。
降档只改级别不改分数，原始级别与降档理由都保留在结论里。降档后核查重点相应从「是否掩盖恶化」
转为「是否把周期性失速表述为稳健增长」——盈利质量仍在行业头部，不等于当期增速可以被讲成增长。

**这条规则的代价（一并写明）**：按行业定位会在板块系统性下行时给出更宽松的档位——整个行业一起恶化时，
「相对同行不差」会掩盖「相对自己的历史表述过满」。这里选择接受该代价，理由是组内横向可比性更强
（共同的会计与现金流口径冲击在组内部分抵消），代价是结论应理解为「与同行相比的表述缺口」，
而不是「与公司历史相比的表述缺口」。

**本地版的差别**：Streamlit 侧的财务规则是线上规则的子集（数据层缺「扣非归母净利润」字段，
净现比与扣非背离两项不参与打分）。两套引擎喂同一组数字实测 48 个配对观测：
本地分相对线上分中位 −6.3、范围 −17 ~ +18，其中 22.9% 的观测差值绝对值 ≥ 10，
所以本页百分位是**近似定位**，且误差是十位数级别而非个位数级别。又因缺少企业类型字段，一律用全市场带，
金融类没有单独分组。这两点影响分位读数的精度，不影响判定结构。

**外部体系对照与使用边界**

- 中国上市公司健康指数（HI），《中国上市公司健康指数报告（2025）》2025-10-16 发布，
  中国上市公司协会学术指导、中关村国睿金融与产业发展研究会编制，数据源同花顺；
  诊断 2024 年度 5363 家，剔除银行 42 / 非银 83 / 房地产 95 共 220 家后 N=5143，
  均值 67.17（2023 年 65.93）；高于均值 2676 家占 52.03%，80 分以上仅 23 家，
  全市场第一贵州茅台 82.61；体系为九大系统 / 39 个二级 / 400 余个底层指标。
- 本工具只借它的 0–100 刻度惯例与公开人群分布作外部参照，**不进入任何判定阈值**；
  HI 逐家公司得分不公开，界面不显示也不换算任何单公司 HI 分数。
- 构造不同：HI 测「健康水平」，含治理、外部监督、内部控制、企业文化等非财务维度；
  本工具测「基本面变化」与「表述与基本面的缺口」。
- 效度层级不同：HI 编制方自述的实证结论未见公开同行评审检验，按行业报告引用；
  本工具作为判据依据的是 Piotroski (2000, Journal of Accounting Research)、
  Li (2008, The Accounting Review)、Sloan (1996, The Accounting Review)。
- 不用「低于均值」当判据：HI 自身 52.03% 的样本高于均值，说明均值落在约第 48 百分位、
  分布左偏，是被下行长尾拉低而非被头部拉高，且均值逐年漂移（65.93→67.17），不是固定标尺。
            """
        )


DIRECTION_ICONS = {"利好": "🟢", "利空": "🔴", "中性": "⚪", "分歧": "🟣", "证据不足": "🟡"}


def _fact_check_report_lines(result: dict[str, Any]) -> list[str]:
    """导出报告里的事实核对小节；审讯室上下文用 _fact_check_context_line，同一口径两处复用。"""
    fact = result.get("fact_check")
    if not fact:
        return [
            "",
            "### 事实核对（第三个 Agent）",
            "",
            result.get("fact_error") or "本轮未完成事实核对，审计结论不依赖该栏。",
        ]
    lines = [
        "",
        "### 事实核对（第三个 Agent）",
        "",
        f"确定性摘录 {fact['excerpt_count']} 段（候选 {fact['candidate_count']} 段 / MD&A 共 "
        f"{fact['total_paragraphs']} 段，{fact['excerpt_chars']} 字符）。"
        + ("qwen-plus 独立核对两次并交叉复核：两次方向一致才计入结论，不一致标为「分歧」。"
           if fact.get("runs", 1) == 2
           else "两次独立核对只有一次返回，本轮方向未经复现，仅作待核查线索。")
        + "方向由指标、口径、原因归属与交叉一致性推出，不按情绪词词面判定。",
        "",
    ]
    if not fact["findings"]:
        lines.append("- 模型认为没有可核对的量化经营变化（返回空清单）。")
    for item in fact["findings"]:
        if item.get("agreed"):
            reproduced = "两次独立核对方向一致"
        elif item["direction"] == "分歧":
            reproduced = "两次独立核对方向不一致，不作为结论"
        else:
            reproduced = "仅一次核对返回，未经复现"
        lines += [
            f"- **{item['metric']} ｜ {item['direction']}**（{item['category']} ｜ {item['period']}）",
            f"  - 复现情况：{reproduced}",
            f"  - 事实：{item['fact']}",
            f"  - 公司解释：{item['company_explanation'] or '未披露'}（原因归属：{item['cause_type'] or '未披露'}）",
            f"  - 一致性核对：{item['consistency']}",
            f"  - 推断：{item['inference']}",
            f"  - 出处：{'、'.join(f'第{n}段' for n in item['paragraphs']) or '未标注段号'}",
        ]
    if fact["conflicts"]:
        lines += ["", "证据冲突或不足：", ""]
        lines += [f"- {text}" for text in fact["conflicts"]]
    return lines


def _fact_check_context_line(result: dict[str, Any]) -> str:
    fact = result.get("fact_check")
    if not fact:
        return f"【事实核对】{result.get('fact_error') or '本轮未完成，判定不依赖该栏。'}"
    items = "　|　".join(
        f"{item['metric']}（{item['period']}）→ {item['direction']}"
        f"{'' if item.get('agreed') else '（未经两次复现，不作为结论）'}；"
        f"事实「{item['fact']}」，原因归属 {item['cause_type'] or '未披露'}，{item['inference']}"
        for item in fact["findings"]
    )
    return (
        "【事实核对（第三个 Agent，不打分不评语调，只判事实方向；独立核对两次，方向一致才作为结论）】"
        f"{items or '无可核对的量化变化'}。"
        + (f"证据冲突或不足：{'；'.join(fact['conflicts'])}。" if fact["conflicts"] else "")
        + "判定依据是指标、口径、原因与交叉一致性，明确不按「增长/下降/改善/减少」的词面正负面推方向。"
    )


def _render_fact_review(result: dict[str, Any]) -> None:
    """事实核对（第三个 Agent）：只判每项重要变化的事实方向，不打分、不评语调。"""
    fact = result.get("fact_check")
    st.subheader("事实核对 · 第三个 Agent 判「这件事到底是好是坏」")
    if not fact:
        st.caption(result.get("fact_error") or "本轮未完成事实核对，审计结论不依赖该栏。")
        return

    runs = fact.get("runs", 1)
    st.caption(
        f"确定性摘录 {fact['excerpt_count']} 段（候选 {fact['candidate_count']} 段，MD&A 共 "
        f"{fact['total_paragraphs']} 段，{fact['excerpt_chars']} 字符），qwen-plus "
        f"{'独立核对两次并交叉复核' if runs == 2 else '单次核对（第二次未返回，方向未经复现）'}，"
        f"得出 {len(fact['findings'])} 条重要变化判定。方向由指标、口径、原因和交叉一致性推出，"
        "不由词面正负面推出；两次判定不一致的条目一律标为「分歧」，不作为结论。"
    )

    if not fact["findings"]:
        st.info("模型认为该篇 MD&A 没有可核对的量化经营变化（返回空清单）。这本身是一条信息，不强行凑结论。")
    else:
        rows = []
        for item in fact["findings"]:
            direction = item["direction"]
            rows.append({
                "方向": f"{DIRECTION_ICONS.get(direction, '🟡')} {direction}",
                "复现": "两次一致" if item.get("agreed") else ("两次不一致" if direction == "分歧" else "未复现"),
                "指标": item["metric"],
                "类别": item["category"],
                "口径期间": item["period"],
                "事实": item["fact"],
                "公司解释": item["company_explanation"] or "未披露",
                "原因归属": item["cause_type"] or "未披露",
                "一致性核对": item["consistency"],
                "推断": item["inference"],
                "出处": "、".join(f"第{n}段" for n in item["paragraphs"]) or "未标注",
            })
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)
        st.caption(
            "「方向」列是这一栏唯一的结论性字段；「复现」列为「两次不一致」或「未复现」的行不作为结论，"
            "只作为下一步人工核查的线索。成本下降只有经营规模稳定或效率、利润率改善时才偏利好。"
        )

    if fact["conflicts"]:
        with st.expander(f"证据冲突或不足（{len(fact['conflicts'])} 条）", expanded=True):
            for text in fact["conflicts"]:
                st.markdown(f"- {text}")

    st.caption(
        "这一栏与词典法各管一半：词典法数「表述立场」，这一栏给「事实方向」，两者的差才是语调操纵。"
        "红线判定只看背离度与财务面档位，本栏不参与阈值。"
    )


def _render_evidence_panel(result: dict[str, Any]) -> None:
    """PDF 语调证据与 CSV 财务证据双栏联动，切换年份时两侧同步刷新。"""
    st.subheader("证据联动：语调快照 vs 财务现实")
    years = sorted(result["pdf_paths"])
    default_index = years.index(result["year"]) if result["year"] in years else len(years) - 1
    evidence_year = st.radio(
        "选择证据年份（左右两栏同步刷新）",
        years,
        index=default_index,
        horizontal=True,
    )

    pdf_column, data_column = st.columns(2, gap="large")
    with pdf_column:
        st.markdown("**PDF 证据 · 极度乐观词汇高亮**")
        with st.spinner(f"正在定位 {evidence_year} 年年报中的极度乐观词汇…"):
            image_path = extract_highlight_image(
                result["pdf_paths"][evidence_year], OPTIMISM_KEYWORDS
            )
        if image_path:
            st.image(
                str(image_path),
                use_container_width=True,
                caption=f"{evidence_year} 年年报 MD&A 极度乐观词汇高亮截图",
            )
        else:
            st.info(f"{evidence_year} 年年报未命中极度乐观词汇：{'、'.join(OPTIMISM_KEYWORDS)}。")
        st.caption(
            f"该年语调虚高指数：{result['sentiment_scores'][evidence_year]:.1f} / 100；"
            "切换上方年份时，左侧截图与右侧指标同步刷新。截图已吸附到命中关键词所在段落，便于阅读上下文。"
            "注意：截图只标注最高级的极端乐观词，全文量化词频证据见下方“词典法语调证据”。"
        )
        dense_pages = extract_dense_highlight_pages(
            result["pdf_paths"][evidence_year], POSITIVE_TONE_WORDS, top_k=3
        )
        if dense_pages:
            st.markdown("**正面语气词整页密集高亮（Top-3 命中页）**")
            dense_cols = st.columns(len(dense_pages), gap="small")
            total_hits = 0
            for column, item in zip(dense_cols, dense_pages):
                total_hits += item["hits"]
                with column:
                    st.image(
                        str(item["path"]),
                        use_container_width=True,
                        caption=f"P.{item['page']} · {item['hits']} 处高亮",
                    )
            st.caption(
                f"PyMuDF 逐页统计正面语气词命中，取最密集的 {len(dense_pages)} 页整页高亮"
                f"（合计 {total_hits} 处），直观呈现乐观措辞的分布密度。"
            )
        _render_mda_reader(result["pdf_paths"][evidence_year], evidence_year)
    with data_column:
        st.markdown("**CSV 数据 · 核心指标同比**")
        frame = result["cleaned_df"].sort_values("年度").reset_index(drop=True)
        positions = frame.index[frame["年度"] == evidence_year]
        row_index = int(positions[-1])
        row = frame.iloc[row_index]
        previous = frame.iloc[row_index - 1] if row_index > 0 else None
        for label, amount_column, yoy_column in (
            ("营业收入", "营业收入", "营业收入_YoY"),
            ("归母净利润", "净利润", "净利润_YoY"),
            ("经营现金流", "经营现金流", "经营现金流_YoY"),
        ):
            amount = float(row[amount_column])
            yoy = float(row[yoy_column])
            prev_amount = None if previous is None else float(previous[amount_column])
            # 增速的分母是基期绝对值：基期接近 0 或与本期异号时它不再是增长率，
            # 与线上 site/app.js 的 yoyCell 同一口径退回绝对额表述。
            delta = None
            if not math.isnan(yoy):
                if prev_amount is not None and not math.isnan(prev_amount) and prev_amount * amount < 0:
                    delta = "由正转负" if prev_amount > 0 else "由负转正"
                elif prev_amount is not None and not math.isnan(prev_amount) and abs(yoy) > 1:
                    delta = f"{(amount - prev_amount) / 1e8:+,.2f} 亿"
                else:
                    delta = f"{yoy:+.2%}"
            st.metric(
                f"{label}（{evidence_year}）",
                f"{amount / 1e8:,.2f} 亿元",
                delta=delta,
                delta_color="normal",
                help="同比增速；基期接近 0 或基期与本期异号时增速失去增长率含义，改显示绝对额变动。",
            )

    _render_lexical_evidence(result, evidence_year)

    audit = result["audit"]
    verdict = _verdict_label(audit)
    icon = "🚨" if audit["anomaly"] else "✅"
    st.markdown(
        f"> {icon} **LEADER AGENT 最终定罪 · {verdict}**\n"
        ">\n"
        f"> {audit['reason']}"
    )


def _render_mda_reader(pdf_path: Path, year: int) -> None:
    """提供该年 MD&A 全文的滚动阅读器与年报 PDF 原文下载，便于核对高亮上下文。"""
    with st.expander(f"阅读 {year} 年 MD&A 全文 / 年报原文"):
        mda_file = pdf_path.with_name(f"{pdf_path.stem}_mda.txt")
        if mda_file.is_file():
            full_text = mda_file.read_text(encoding="utf-8")
            st.markdown(
                "<div style=\"max-height:440px;overflow:auto;background:#ffffff;"
                "border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;"
                "font-size:13px;line-height:1.9;white-space:pre-wrap;\">"
                f"{html.escape(full_text)}</div>",
                unsafe_allow_html=True,
            )
            st.caption(f"MD&A 全文共 {len(full_text)} 字，摘自年报“管理层讨论与分析”章节。")
        else:
            st.info(f"未找到 {year} 年 MD&A 文本缓存：{mda_file.name}。")
        with open(pdf_path, "rb") as handle:
            st.download_button(
                f"下载 {year} 年年报 PDF 原文",
                data=handle,
                file_name=pdf_path.name,
                mime="application/pdf",
            )


def _render_lexical_evidence(result: dict[str, Any], evidence_year: int) -> None:
    """词典法交叉验证：全文正/负面词计数、密度、段落定位。

    它只数「表述立场」，按定义不含「是否有数据支撑」，所以用来对照 LLM 语调虚高指数，
    不写成它的证据——两者构造不同，不一致时应回到事实核对与财务分位去判。
    """
    profile = result["lexical_tone"].get(evidence_year)
    if not profile:
        return

    llm_score = result["sentiment_scores"][evidence_year]
    lexical_score = profile["lexical_optimism_score"]
    st.markdown("**词典法交叉验证 · 全文词频与段落定位（不作虚高指数的证据）**")
    st.caption(
        f"LLM 语调虚高指数（{llm_score:.1f}）是对全文的主观打分，容易被质疑“凭几处词就下结论”。"
        f"这里用客观词典法在整篇 {profile['char_count']:,} 字 MD&A 中独立统计："
        f"正面语气词命中 {profile['positive_hits']} 次、不利结果词命中 {profile['negative_hits']} 次，"
        f"正面占比 {lexical_score:.1f}%；与 LLM 语调虚高指数相差 "
        f"{abs(llm_score - lexical_score):.1f}，两者量纲不同，差异不代表任一方有误。"
    )

    metric_columns = st.columns(4)
    metric_columns[0].metric("正面词命中", f"{profile['positive_hits']} 次",
                             delta=f"{profile['positive_density']:.2f}/千字", delta_color="off")
    metric_columns[1].metric("负面词命中", f"{profile['negative_hits']} 次",
                             delta=f"{profile['negative_density']:.2f}/千字", delta_color="off")
    metric_columns[2].metric("风险披露词", f"{profile['risk_hits']} 次",
                             delta="单列不计情绪", delta_color="off")
    metric_columns[3].metric("词典法乐观分", f"{lexical_score:.1f}",
                             delta=f"LLM {llm_score:.1f}", delta_color="off")

    with st.expander("展开逐词命中明细（含段落号，可回溯原文核对）"):
        positive_df = pd.DataFrame(profile["positive_words"])
        negative_df = pd.DataFrame(profile["negative_words"])
        positive_column, negative_column = st.columns(2, gap="large")
        with positive_column:
            st.markdown(f"正面语气词 · 共 {len(positive_df)} 种")
            if positive_df.empty:
                st.info("未命中正面语气词。")
            else:
                st.dataframe(positive_df, use_container_width=True, hide_index=True, height=320)
        with negative_column:
            st.markdown(f"不利结果词 · 共 {len(negative_df)} 种")
            if negative_df.empty:
                st.info("未命中不利结果词。")
            else:
                st.dataframe(negative_df, use_container_width=True, hide_index=True, height=320)
        st.caption(
            "“段落”为命中词所在的 MD&A 段落序号（每词最多列出前 8 个），可对照上方全文阅读器逐段核对；"
            "风险披露词（如“风险”“诉讼”）反映披露强度而非悲观情绪，已单列不计入正/负面比。"
        )

    _render_lexical_trend(result)


def _render_lexical_trend(result: dict[str, Any]) -> None:
    """按年对比 LLM 语调虚高指数与词典法正面占比、正/负命中，展示语调证据的时间序列一致性。"""
    years = sorted(result["lexical_tone"])
    if len(years) < 2:
        return
    rows = []
    for year in years:
        profile = result["lexical_tone"][year]
        rows.append({
            "年度": year,
            "语调虚高指数": round(result["sentiment_scores"][year], 1),
            "正面词占比": profile["lexical_optimism_score"],
            "正面词命中": profile["positive_hits"],
            "不利词命中": profile["negative_hits"],
            "风险披露词": profile["risk_hits"],
        })
    with st.expander("展开五年语调词频对比（LLM 分 vs 词典法分）"):
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)
        st.caption(
            "两套方法逐年对照：LLM 主观打分与词典法客观计数若长期同向，说明乐观判定稳健、可复现，"
            "而非依赖个别词汇。"
        )


def _build_due_diligence_report(result: dict[str, Any], highlight_path: Path | None) -> str:
    """把公司名称/代码、红绿灯结论、F-Score、FOG、审计结论与高亮截图路径拼成 Markdown 尽调报告。"""
    sentiment = result["sentiment"]
    financial = result["financial"]
    audit = result["audit"]
    latest = result["cleaned_df"].sort_values("年度").iloc[-1]
    audit_divergence = classify_divergence(sentiment["sentiment_score"], financial)
    status, title, detail = _classify_divergence(audit_divergence)
    verdict = _verdict_label(audit)

    lines = [
        "# 年报语调操纵尽调报告",
        "",
        f"- 公司名称：{result.get('stock_name', result['stock_code'])}",
        f"- 股票代码：{result['stock_code']}",
        f"- 审计年度：{result['year']}",
        f"- 生成时间：{datetime.now():%Y-%m-%d %H:%M:%S}",
        "",
        "## 一、红绿灯结论",
        "",
        f"{_ALERT_ICONS[status]} **{title}**",
        "",
        detail,
        "",
        f"- 主判据·背离度：{audit_divergence['divergence']}，档位 {audit_divergence['grade']}",
        _band_source_line(financial),
        f"- 档位依据：{"；".join(audit_divergence["reasons"])}",
        f"- 语调虚高指数：{sentiment['sentiment_score']:.1f} / 100（不单独触发报警）",
        f"- {_tone_reliability_line(sentiment)}",
        f"- 财务基本面·水平分：{financial['raw_health_score']:.1f}"
        f"（显示分 {financial['health_score']:.1f} / 100，{financial['health_level']}）",
        "- 财务基本面·同比变化分："
        + ("无可比上一年" if financial.get("change_score") is None
           else f"{financial['change_score']:+.2f} 分"),
        "",
        "## 二、量化指标",
        "",
        f"- Piotroski F-Score：{int(latest['Piotroski_F_Score'])} / 9"
        f"（有效项 {int(latest['F_Score_有效项数'])} / 9）",
        f"- MD&A FOG 指数：{sentiment['fog_index']:.2f}",
        *_fact_check_report_lines(result),
        "",
        "## 三、Agent 审计结论",
        "",
        f"- Leader 判定：{verdict}",
        f"- 判定理由：{audit['reason']}",
        "",
        "证据链：",
        "",
    ]
    lines += [f"- {item}" for item in audit.get("evidence_links", [])] or ["- 无"]
    lines += ["", "管理层关键论点：", ""]
    lines += [f"- {item}" for item in sentiment.get("key_claims", [])] or ["- 无"]
    audit_notes = []
    if sentiment.get("claims_rejected"):
        audit_notes.append(f"另有 {sentiment['claims_rejected']} 条论点因引用不存在的段号被剔除")
    if sentiment.get("claims_unanchored"):
        audit_notes.append(f"{sentiment['claims_unanchored']} 条未标注段号、无法定位原文")
    if audit_notes:
        lines += ["", "论点可核性：" + "；".join(audit_notes) + "。"]
    lines += ["", "## 四、PDF 语调证据", ""]
    if highlight_path:
        lines += [
            f"- 高亮截图路径：{highlight_path}",
            "",
            f"![MD&A 极度乐观词汇高亮]({highlight_path.as_posix()})",
        ]
    else:
        lines += ["- 高亮截图路径：无（年报未命中极度乐观词汇）"]

    profile = result.get("lexical_tone", {}).get(result["year"])
    if profile:
        top_positive = "、".join(
            f"{row['词']}×{row['命中次数']}" for row in profile["positive_words"][:8]
        ) or "无"
        top_negative = "、".join(
            f"{row['词']}×{row['命中次数']}" for row in profile["negative_words"][:8]
        ) or "无"
        lines += [
            "",
            "### 词典法词频交叉验证",
            "",
            f"- MD&A 全文字数：{profile['char_count']:,}",
            f"- 正面语气词命中：{profile['positive_hits']} 次（密度 {profile['positive_density']:.2f}/千字）",
            f"- 不利结果词命中：{profile['negative_hits']} 次（密度 {profile['negative_density']:.2f}/千字）",
            f"- 风险披露词命中：{profile['risk_hits']} 次（单列，不计入正/负面情绪比）",
            f"- 正面词占比：{profile['lexical_optimism_score']:.1f}%"
            f"（对照 LLM 语调虚高指数 {sentiment['sentiment_score']:.1f}，两者量纲不同，"
            f"相差 {abs(sentiment['sentiment_score'] - profile['lexical_optimism_score']):.1f} 不代表任一方有误）",
            f"- 高频正面语气词：{top_positive}",
            f"- 高频不利结果词：{top_negative}",
            "",
            "词典法是客观计数得到的正面词占比，LLM 打的是表述相对其数据支撑的膨胀程度，两者量纲不同；"
            "并非依赖截图中的个别词汇。",
        ]
    lines.append("")
    return "\n".join(lines)


def _render_report_export(result: dict[str, Any]) -> None:
    """生成 Markdown 尽调报告并提供 st.download_button 下载。"""
    st.divider()
    st.subheader("导出尽调报告")

    if st.button("生成尽调报告", key="generate_dd_report"):
        with st.spinner("正在汇总审计结论并定位高亮截图…"):
            highlight_path = extract_highlight_image(
                result["pdf_paths"][result["year"]], OPTIMISM_KEYWORDS
            )
        st.session_state[DD_REPORT_KEY] = _build_due_diligence_report(result, highlight_path)

    report_markdown = st.session_state.get(DD_REPORT_KEY)
    if not report_markdown:
        st.caption(
            "点击“生成尽调报告”汇总公司名称与代码、红绿灯结论、F-Score、FOG 指数、"
            "Agent 审计结论与高亮截图路径，生成后即可下载 Markdown 文件。"
        )
        return

    st.download_button(
        "下载尽调报告（.md）",
        data=report_markdown.encode("utf-8"),
        file_name=f"{result['stock_code']}_{result['year']}_尽调报告.md",
        mime="text/markdown",
        type="primary",
        use_container_width=True,
    )
    with st.expander("预览报告内容"):
        st.code(report_markdown, language="markdown")


def _build_interrogation_context(result: dict[str, Any]) -> str:
    """汇总年报摘要、清洗后核心财务 CSV 与审计结论，作为审讯室的 System Context。"""
    sentiment = result["sentiment"]
    audit = result["audit"]

    financial_columns = [
        "年度",
        "营业收入",
        "净利润",
        "经营现金流",
        "净利润_YoY",
        "Piotroski_F_Score",
        "F_Score_有效项数",
    ]
    available_columns = [
        column for column in financial_columns if column in result["cleaned_df"].columns
    ]
    financial_text = result["cleaned_df"][available_columns].to_csv(index=False)

    claims = sentiment.get("key_claims", [])
    claims_text = "\n".join(f"- {claim}" for claim in claims) or "- 无"
    verdict = _verdict_label(audit)
    evidence_links = audit.get("evidence_links", [])
    evidence_text = "\n".join(f"- {evidence}" for evidence in evidence_links) or "- 无"

    profile = result.get("lexical_tone", {}).get(result["year"])
    if profile:
        top_positive = "、".join(
            f"{row['词']}×{row['命中次数']}(段落{','.join(map(str, row['段落'][:3]))})"
            for row in profile["positive_words"][:8]
        ) or "无"
        top_negative = "、".join(
            f"{row['词']}×{row['命中次数']}" for row in profile["negative_words"][:8]
        ) or "无"
        lexical_text = (
            f"【词典法词频（客观计数，交叉验证用，不是虚高指数的证据）】全文 {profile['char_count']:,} 字，"
            f"正面语气词 {profile['positive_hits']} 次（密度 {profile['positive_density']:.2f}/千字）、"
            f"不利结果词 {profile['negative_hits']} 次（密度 {profile['negative_density']:.2f}/千字），"
            f"正面词占比 {profile['lexical_optimism_score']:.1f}%；"
            f"风险披露词 {profile['risk_hits']} 次（单列不计情绪）。"
            f"对照 LLM 语调虚高指数 {sentiment['sentiment_score']:.1f}"
            f"（词占比是客观计数，虚高指数是模型整体判断，量纲不同，差异不代表任一方有误）。\n"
            f"高频正面语气词（含段落号）：{top_positive}\n"
            f"高频不利结果词：{top_negative}"
        )
    else:
        lexical_text = "【词典法词频（交叉验证）】暂无。"

    return (
        f"【被审计公司】股票代码 {result['stock_code']}，审计年度 {result['year']}。\n\n"
        f"【年报 MD&A 摘要】语调虚高指数 {sentiment['sentiment_score']:.1f} / 100，"
        f"FOG 指数 {sentiment['fog_index']:.2f}。管理层关键论点：\n{claims_text}\n"
        f"MD&A 正文摘录（前 {MDA_EXCERPT_CHARS} 字）：\n{result['mda_text'][:MDA_EXCERPT_CHARS]}\n\n"
        f"{lexical_text}\n\n"
        f"{_fact_check_context_line(result)}\n\n"
        f"【核心财务数据（清洗后 CSV，金额单位为元）】\n{financial_text}\n"
        f"【审计结论】告警判定：{verdict}；背离度 "
        f"{classify_divergence(sentiment['sentiment_score'], financial)['divergence']:+.2f}"
        f" = 语调虚高指数 − 财务基本面原始分。Leader 理由：{audit['reason']}\n"
        f"证据链：\n{evidence_text}"
    )


def _render_interrogation(result: dict[str, Any]) -> None:
    """页面底部的交互式 AI 审讯室，基于审计上下文用 qwen-max 回答用户追问。"""
    st.divider()
    st.subheader("AI 审讯室")
    st.caption("就本次审计结论向主审分析师追问，回答仅依据上方年报摘要、财务数据与证据链。")

    history = st.session_state.setdefault(INTERROGATION_HISTORY_KEY, [])
    for message in history:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])

    question = st.chat_input("向审计 Agent 提问，例如：为什么你觉得这家公司在粉饰太平？")
    if not question:
        return

    history.append({"role": "user", "content": question})
    with st.chat_message("user"):
        st.markdown(question)

    model_messages = [
        {"role": "system", "content": INTERROGATION_SYSTEM_PROMPT + _build_interrogation_context(result)},
        *[{"role": item["role"], "content": item["content"]} for item in history],
    ]

    with st.chat_message("assistant"):
        with st.spinner("AI 审讯中，正在核对证据…"):
            try:
                answer = QwenJSONClient(model="qwen-max").chat(model_messages)
            except Exception as exc:
                answer = f"审讯失败：{exc}"
        st.markdown(answer)
    history.append({"role": "assistant", "content": answer})


def _build_financial_chart(financial_df) -> go.Figure:
    frame = financial_df.sort_values("年度")
    figure = go.Figure()
    series = (
        ("营业收入", "#2563eb"),
        ("净利润", "#16a34a"),
        ("经营现金流", "#ea580c"),
    )
    for column, color in series:
        figure.add_trace(
            go.Scatter(
                x=frame["年度"],
                y=frame[column] / 1e8,
                mode="lines+markers",
                name=column,
                line={"color": color, "width": 3},
                marker={"size": 8},
                hovertemplate="%{y:,.2f} 亿元<extra>" + column + "</extra>",
            )
        )
    figure.update_layout(
        title="近五年核心财务指标",
        height=410,
        margin={"l": 20, "r": 20, "t": 60, "b": 20},
        legend={"orientation": "h", "y": 1.12, "x": 0},
        hovermode="x unified",
        xaxis={"title": "年度", "dtick": 1, "fixedrange": True},
        yaxis={"title": "金额（亿元）", "gridcolor": "#e5e7eb", "fixedrange": True},
        plot_bgcolor="white",
    )
    return figure


def _build_divergence_chart(trend_df) -> go.Figure:
    frame = trend_df.sort_values("年度").reset_index(drop=True)
    years = frame["年度"].astype(int).tolist()

    def traces(end: int) -> tuple[go.Scatter, go.Scatter]:
        current = frame.iloc[:end]
        return (
            go.Scatter(
                x=current["年度"],
                y=current["语调虚高指数"],
                mode="lines+markers",
                name="语调虚高指数",
                line={"color": "#dc2626", "width": 4},
                marker={"size": 10},
                hovertemplate="%{x}年<br>%{y:.2f} 分<extra>语调虚高指数</extra>",
            ),
            go.Scatter(
                x=current["年度"],
                y=current["净利润同比增速"],
                mode="lines+markers",
                name="净利润同比增速",
                yaxis="y2",
                line={"color": "#2563eb", "width": 4},
                marker={"size": 10, "symbol": "diamond"},
                hovertemplate="%{x}年<br>%{y:.2f}%<extra>净利润同比增速</extra>",
            ),
        )

    figure = go.Figure(data=traces(len(frame)))
    figure.frames = [
        go.Frame(name=str(year), data=traces(end), traces=[0, 1])
        for end, year in enumerate(years, start=1)
    ]
    figure.update_layout(
        title={"text": "管理层语调 vs 财报净利润增速", "x": 0.02},
        height=510,
        margin={"l": 30, "r": 30, "t": 95, "b": 135},
        legend={"orientation": "h", "y": 1.12, "x": 0},
        hovermode="x unified",
        xaxis={
            "title": "年度",
            "tickmode": "array",
            "tickvals": years,
            "range": [min(years) - 0.2, max(years) + 0.2],
            "fixedrange": True,
        },
        yaxis={
            "title": "语调虚高指数（0–100，越高越可疑）",
            "range": [0, 105],
            "gridcolor": "#e5e7eb",
            "fixedrange": True,
        },
        yaxis2={
            "title": "净利润同比增速（%）",
            "overlaying": "y",
            "side": "right",
            "ticksuffix": "%",
            "showgrid": False,
            "zeroline": True,
            "zerolinecolor": "#94a3b8",
            "zerolinewidth": 2,
            "fixedrange": True,
        },
        plot_bgcolor="white",
        updatemenus=[
            {
                "type": "buttons",
                "direction": "left",
                "showactive": False,
                "x": 0,
                "y": -0.27,
                "buttons": [
                    {
                        "label": "播放",
                        "method": "animate",
                        "args": [
                            None,
                            {
                                "frame": {"duration": 850, "redraw": True},
                                "transition": {"duration": 250},
                                "fromcurrent": False,
                            },
                        ],
                    },
                    {
                        "label": "暂停",
                        "method": "animate",
                        "args": [
                            [None],
                            {
                                "frame": {"duration": 0, "redraw": False},
                                "mode": "immediate",
                            },
                        ],
                    },
                ],
            }
        ],
        sliders=[
            {
                "active": len(years) - 1,
                "x": 0.17,
                "y": -0.27,
                "len": 0.83,
                "currentvalue": {"prefix": "年份："},
                "steps": [
                    {
                        "label": str(year),
                        "method": "animate",
                        "args": [
                            str(year),
                            {
                                "frame": {"duration": 0, "redraw": True},
                                "mode": "immediate",
                            },
                        ],
                    }
                    for year in years
                ],
            }
        ],
    )
    return figure


def _build_sentiment_gauge(score: float) -> go.Figure:
    bar_color = "#dc2626" if score > 80 else "#f59e0b" if score > 60 else "#16a34a"
    figure = go.Figure(
        go.Indicator(
            mode="gauge+number",
            value=score,
            number={"suffix": "", "font": {"size": 44}},
            title={"text": "MD&A 文本乐观度", "font": {"size": 20}},
            gauge={
                "axis": {"range": [0, 100], "tickwidth": 1},
                "bar": {"color": bar_color, "thickness": 0.28},
                "bgcolor": "white",
                "steps": [
                    {"range": [0, 50], "color": "#dcfce7"},
                    {"range": [50, 80], "color": "#fef3c7"},
                    {"range": [80, 100], "color": "#fee2e2"},
                ],
                "threshold": {
                    "line": {"color": "#991b1b", "width": 3},
                    "thickness": 0.75,
                    "value": 80,
                },
            },
        )
    )
    figure.update_layout(height=320, margin={"l": 30, "r": 30, "t": 60, "b": 20})
    return figure


def _render_audit_conclusion(audit: dict[str, Any]) -> None:
    # 标题与配色一律跟随分档规则，不再跟随模型的 anomaly：
    # 否则降档生效时会出现「绿灯 + 发现背离」这种同屏自相矛盾。
    grade = audit.get("alert_grade") or ("red" if audit["anomaly"] else "green")
    title, background, border, title_color = GRADE_HEADLINE.get(grade, GRADE_HEADLINE["green"])
    reason = html.escape(audit["reason"])

    st.markdown(
        f"""
        <div style="background:{background};border-left:8px solid {border};border-radius:8px;padding:22px;margin:18px 0;">
            <div style="font-size:13px;font-weight:600;color:{title_color};">LEADER AGENT 审计结论</div>
            <div style="font-size:25px;font-weight:700;color:{title_color};margin:8px 0;">{title}</div>
            <div style="font-size:16px;line-height:1.8;color:#1f2937;">{reason}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    evidence_links = audit.get("evidence_links", [])
    if evidence_links:
        st.markdown("**审计证据链**")
        for evidence in evidence_links:
            st.markdown(f"- {evidence}")


def _llm_is_configured() -> bool:
    try:
        return bool(st.secrets["DASHSCOPE_API_KEY"])
    except Exception:
        return False


def _apply_styles() -> None:
    st.markdown(
        """
        <style>
        .stApp {background: #f8fafc;}
        .block-container {max-width: 1280px; padding-top: 2rem;}
        h1 {color: #0f172a; letter-spacing: -0.03em;}
        div[data-testid="stMetric"] {
            background: white; border: 1px solid #e2e8f0;
            border-radius: 8px; padding: 12px 18px;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


if __name__ == "__main__":
    main()
