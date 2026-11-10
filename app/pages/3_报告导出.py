"""报告导出页面"""
import streamlit as st
from pathlib import Path

from config import settings

st.set_page_config(page_title="报告导出", page_icon="📋", layout="wide")
st.title("📋 历史报告")

export_dir = settings.data_storage_dir / "exports"
if not export_dir.exists():
    st.info("暂无历史报告。")
else:
    reports = sorted(export_dir.glob("*.md"), reverse=True)
    if not reports:
        st.info("暂无历史报告。")
    else:
        for report_path in reports:
            with st.expander(report_path.stem):
                st.markdown(report_path.read_text(encoding="utf-8"))
