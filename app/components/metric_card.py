"""指标卡片组件"""
import streamlit as st


def render_metric_card(title: str, value: str, suffix: str = "") -> None:
    st.markdown(
        f"""<div style="text-align:center; padding:1rem; border:1px solid #e0e0e0; border-radius:8px;">
        <div style="font-size:0.85rem; color:gray;">{title}</div>
        <div style="font-size:2rem; font-weight:bold;">{value}<span style="font-size:1rem; color:gray;">{suffix}</span></div>
        </div>""",
        unsafe_allow_html=True,
    )
