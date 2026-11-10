"""情绪仪表盘组件 — 对比乐观度与健康度"""
import streamlit as st
import plotly.graph_objects as go


def render_sentiment_gauge(sentiment_score: float, health_score: float) -> None:
    st.markdown("**情绪 vs 财务对比**")

    fig = go.Figure()

    fig.add_trace(
        go.Indicator(
            mode="gauge+number+delta",
            value=sentiment_score,
            number={"suffix": ""},
            title={"text": "文本乐观度", "font": {"size": 16}},
            delta={"reference": health_score, "increasing": {"color": "red"}, "decreasing": {"color": "green"}},
            gauge={
                "axis": {"range": [0, 100]},
                "bar": {"color": "#f08080"},
                "steps": [
                    {"range": [0, 30], "color": "#e8f5e9"},
                    {"range": [30, 60], "color": "#fff9c4"},
                    {"range": [60, 100], "color": "#ffcdd2"},
                ],
            },
        )
    )

    fig.add_trace(
        go.Indicator(
            mode="gauge+number",
            value=health_score,
            number={"suffix": ""},
            title={"text": "财务健康度", "font": {"size": 16}},
            gauge={
                "axis": {"range": [0, 100]},
                "bar": {"color": "#4fc3f7"},
                "steps": [
                    {"range": [0, 30], "color": "#ffcdd2"},
                    {"range": [30, 60], "color": "#fff9c4"},
                    {"range": [60, 100], "color": "#e8f5e9"},
                ],
            },
        )
    )

    fig.update_layout(
        grid={"rows": 1, "columns": 2, "pattern": "independent"},
        height=250,
        margin=dict(l=10, r=10, t=40, b=10),
    )

    st.plotly_chart(fig, use_container_width=True)
