"""PDF 解析器 — 提取 MD&A 章节文本"""
from __future__ import annotations

import re
from pathlib import Path

import fitz  # pymupdf

from data.models.annual_report import AnnualReport, ReportSection


_MDA_KEYWORDS = [
    "管理层讨论与分析",
    "董事会报告",
    "经营情况讨论与分析",
    "报告期内公司经营情况",
]

_SECTION_END_KEYWORDS = [
    "重要事项",
    "股份变动",
    "公司治理",
    "财务报表",
    "审计报告",
]


class PDFParser:
    """从年报 PDF 中定位并提取 MD&A 章节文本。"""

    def parse(self, pdf_path: str | Path) -> AnnualReport:
        path = Path(pdf_path)
        doc = fitz.open(str(path))

        full_text_parts: list[str] = []
        page_texts: list[tuple[int, str]] = []

        for page_num, page in enumerate(doc):
            text = page.get_text("text")
            page_texts.append((page_num, text))
            full_text_parts.append(text)

        full_text = "\n".join(full_text_parts)
        mda_sections = self._extract_mda_sections(page_texts)

        company_code = self._infer_company_code(path.stem)
        year = self._infer_year(path.stem)

        return AnnualReport(
            company_code=company_code,
            year=year,
            pdf_path=str(path),
            mda_sections=mda_sections,
            full_text=full_text,
        )

    def _extract_mda_sections(
        self, page_texts: list[tuple[int, str]]
    ) -> list[ReportSection]:
        sections: list[ReportSection] = []
        in_mda = False
        current_title = ""
        current_lines: list[str] = []
        start_page = 0

        for page_num, text in page_texts:
            for line in text.split("\n"):
                stripped = line.strip()
                if not stripped:
                    continue

                if not in_mda and self._is_mda_start(stripped):
                    in_mda = True
                    current_title = stripped
                    start_page = page_num
                    continue

                if in_mda and self._is_section_end(stripped):
                    sections.append(
                        ReportSection(
                            title=current_title,
                            content="\n".join(current_lines),
                            page_start=start_page,
                            page_end=page_num,
                        )
                    )
                    in_mda = False
                    current_lines = []
                    break

                if in_mda:
                    if self._is_sub_heading(stripped):
                        if current_lines:
                            sections.append(
                                ReportSection(
                                    title=current_title,
                                    content="\n".join(current_lines),
                                    page_start=start_page,
                                    page_end=page_num,
                                )
                            )
                        current_title = stripped
                        current_lines = []
                        start_page = page_num
                    else:
                        current_lines.append(stripped)

        if in_mda and current_lines:
            sections.append(
                ReportSection(
                    title=current_title,
                    content="\n".join(current_lines),
                    page_start=start_page,
                    page_end=page_texts[-1][0] if page_texts else 0,
                )
            )

        return sections

    def _is_mda_start(self, line: str) -> bool:
        return any(kw in line for kw in _MDA_KEYWORDS)

    def _is_section_end(self, line: str) -> bool:
        return any(kw in line for kw in _SECTION_END_KEYWORDS)

    def _is_sub_heading(self, line: str) -> bool:
        return bool(re.match(r"^[（(][一二三四五六七八九十\d]+[）)]", line)) or (
            len(line) < 40 and line.endswith(("：", ":"))
        )

    @staticmethod
    def _infer_company_code(stem: str) -> str:
        match = re.search(r"(\d{6})", stem)
        return match.group(1) if match else "unknown"

    @staticmethod
    def _infer_year(stem: str) -> int:
        match = re.search(r"(20\d{2})", stem)
        return int(match.group(1)) if match else 0
