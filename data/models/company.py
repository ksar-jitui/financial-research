from __future__ import annotations

from pydantic import BaseModel, Field


class Company(BaseModel):
    stock_code: str = Field(description="股票代码, 如 000001")
    stock_name: str = Field(description="股票简称")
    market: str = Field(default="A股", description="市场")
    industry: str = Field(default="", description="行业分类")
