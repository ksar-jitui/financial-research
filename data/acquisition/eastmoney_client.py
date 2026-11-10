"""东方财富数据客户端 — 获取核心财务指标"""
from __future__ import annotations

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings
from data.models.financial_metrics import FinancialMetrics, FinancialSnapshot


class EastmoneyClient:
    """从东方财富获取上市公司三年核心财务数据。"""

    FINANCE_API = "https://datacenter.eastmoney.com/api/data/v1/get"

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=15))
    async def fetch_financial_data(self, stock_code: str, years: int = 3) -> FinancialMetrics:
        """获取近 N 年核心财务数据并返回结构化指标。"""
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                self.FINANCE_API,
                params={
                    "reportName": "RPT_LICO_FN_CPD",
                    "columns": "SECURITY_CODE,REPORT_DATE,OPERATE_INCOME,PARENT_NETPROFIT,NETCASH_OPERATE",
                    "filter": f'(SECURITY_CODE="{stock_code}")',
                    "pageNumber": 1,
                    "pageSize": years,
                    "sortTypes": "-1",
                    "sortColumns": "REPORT_DATE",
                },
            )
            resp.raise_for_status()
            raw = resp.json().get("result", {}).get("data", [])

        snapshots: list[FinancialSnapshot] = []
        for row in raw:
            snapshots.append(
                FinancialSnapshot(
                    year=int(str(row.get("REPORT_DATE", ""))[:4]),
                    revenue=float(row.get("OPERATE_INCOME", 0) or 0),
                    net_profit=float(row.get("PARENT_NETPROFIT", 0) or 0),
                    operating_cashflow=float(row.get("NETCASH_OPERATE", 0) or 0),
                )
            )

        snapshots.sort(key=lambda s: s.year)
        return FinancialMetrics(company_code=stock_code, snapshots=snapshots)
