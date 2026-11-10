from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class ReportSection(BaseModel):
    title: str = Field(description="章节标题")
    content: str = Field(description="章节正文")
    page_start: int = Field(default=0, description="起始页码")
    page_end: int = Field(default=0, description="结束页码")


class AnnualReport(BaseModel):
    company_code: str
    year: int
    fiscal_year_end: date
    pdf_path: str = Field(default="", description="本地 PDF 路径")
    mda_sections: list[ReportSection] = Field(default_factory=list, description="MD&A 章节列表")
    full_text: str = Field(default="", description="提取的全文")
    extracted_at: date = Field(default_factory=date.today)
