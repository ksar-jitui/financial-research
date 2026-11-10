"""背离预警组件 — 高亮显示异常信号"""
import streamlit as st

from data.models.audit_result import DivergenceSignal


_RISK_COLORS = {
    (0, 0.3): "#4caf50",
    (0.3, 0.6): "#ff9800",
    (0.6, 0.8): "#f44336",
    (0.8, 1.1): "#b71c1c",
}


def render_divergence_alert(signals: list[DivergenceSignal]) -> None:
    st.markdown("**背离信号检测**")

    if not signals:
        st.success("✅ 未发现显著背离信号，语调与财务表现基本一致。")
        return

    for sig in signals:
        color = "#ff9800"
        for (lo, hi), c in _RISK_COLORS.items():
            if lo <= sig.severity < hi:
                color = c
                break

        st.markdown(
            f"""<div style="border-left:4px solid {color}; padding:0.8rem; margin:0.5rem 0; background:#fafafa; border-radius:0 4px 4px 0;">
            <div style="font-weight:bold; color:{color};">⚠️ {sig.signal_type}</div>
            <div style="margin-top:0.3rem;">{sig.description}</div>
            <div style="font-size:0.8rem; color:gray; margin-top:0.3rem;">严重程度: {sig.severity:.0%}</div>
            </div>""",
            unsafe_allow_html=True,
        )

        if sig.evidence_texts:
            with st.popover("查看原文证据"):
                for quote in sig.evidence_texts:
                    st.markdown(f"> {quote}")
