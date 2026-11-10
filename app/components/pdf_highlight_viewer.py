"""PDF 高亮查看器组件 — 点击跳回年报原文段落"""
import streamlit as st


def render_pdf_highlight_viewer(pdf_path: str, highlight_ranges: list[tuple[int, int]] | None = None) -> None:
    st.markdown("**年报原文查看器**")

    if not pdf_path:
        st.info("暂无可显示的 PDF 文件。")
        return

    try:
        with open(pdf_path, "rb") as f:
            st.download_button(
                "📥 下载年报 PDF",
                data=f.read(),
                file_name=pdf_path.split("/")[-1],
                mime="application/pdf",
            )
    except FileNotFoundError:
        st.warning(f"PDF 文件未找到: {pdf_path}")

    if highlight_ranges:
        st.markdown("**高亮段落:**")
        for start, end in highlight_ranges:
            st.markdown(f"- 字符范围 {start}-{end}")
