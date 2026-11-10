"""使用 AKShare 获取股票名录和财务数据，并从巨潮资讯下载年报 PDF。"""
from __future__ import annotations

import re
import threading
import time
from datetime import datetime
from pathlib import Path

import akshare as ak
import pandas as pd
import requests

DATA_ROOT = Path("./data")
CNINFO_DELAY_SECONDS = 2
CNINFO_SEARCH_URL = "https://www.cninfo.com.cn/new/information/topSearch/query"
CNINFO_ANNOUNCEMENT_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
CNINFO_STATIC_URL = "https://static.cninfo.com.cn"

_CNINFO_LOCK = threading.Lock()

EM_F10_URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
EM_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://data.eastmoney.com/",
    "Accept": "application/json, text/plain, */*",
}


def _em_secucode(code: str) -> str:
    code = str(code).strip().zfill(6)
    if code.startswith("6"):
        return f"{code}.SH"
    if code.startswith(("4", "8", "9")):
        return f"{code}.BJ"
    return f"{code}.SZ"


def fetch_industry(code: str) -> str:
    """取东方财富一级板块名，把公司放回它自己的行业池里定位。

    同一个分数在全市场和在白酒板块里不是同一句话，所以判定前必须知道池子。
    取失败一律返回空串，让分位定位退回全市场带，而不是猜一个行业把公司塞错池子。
    """
    try:
        response = requests.get(
            EM_F10_URL,
            params={
                "reportName": "RPT_F10_ORG_BASICINFO",
                "columns": "ALL",
                "filter": f'(SECUCODE="{_em_secucode(code)}")',
                "pageNumber": 1,
                "pageSize": 1,
                "source": "HSF10",
                "client": "PC",
            },
            headers=EM_HEADERS,
            timeout=20,
        )
        response.raise_for_status()
        rows = (response.json().get("result") or {}).get("data") or []
        return str(rows[0].get("BOARD_NAME_1LEVEL") or "") if rows else ""
    except Exception:
        return ""


def fetch_stock_list() -> pd.DataFrame:
    """获取 A 股代码和中文名称，网络失败时回退到本地名录缓存。"""
    output_path = DATA_ROOT / "stock_list.csv"
    try:
        raw = ak.stock_info_a_code_name()
        if raw is None or raw.empty:
            raise ValueError("AKShare 未返回 A 股名录")

        code_column = _find_column(raw, ("code", "股票代码", "证券代码"))
        name_column = _find_column(raw, ("name", "股票名称", "证券简称"))
        result = raw[[code_column, name_column]].rename(
            columns={code_column: "股票代码", name_column: "股票名称"}
        )
        result["股票代码"] = result["股票代码"].astype("string").str.strip().str.zfill(6)
        result["股票名称"] = result["股票名称"].astype("string").str.strip()
        result = result.dropna()
        result = result[
            result["股票代码"].str.fullmatch(r"\d{6}")
            & result["股票名称"].ne("")
        ]
        result = result.drop_duplicates("股票代码").sort_values("股票代码")
        if result.empty:
            raise ValueError("AKShare 返回的 A 股名录没有有效记录")

        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        result = result.reset_index(drop=True)
        result.to_csv(output_path, index=False, encoding="utf-8-sig")
        return result
    except Exception:
        if not output_path.exists():
            raise
        result = pd.read_csv(output_path, dtype=str)
        if not {"股票代码", "股票名称"}.issubset(result.columns):
            raise ValueError("本地股票名录缓存缺少股票代码或股票名称")
        result = result[["股票代码", "股票名称"]].dropna()
        result["股票代码"] = result["股票代码"].str.strip().str.zfill(6)
        result["股票名称"] = result["股票名称"].str.strip()
        return result.reset_index(drop=True)


def fetch_financial_data(
    stock_code: str,
    years: int = 3,
    end_year: int | None = None,
) -> pd.DataFrame:
    """获取年度核心财务数据及 Piotroski 评分所需比率并保存 CSV。"""
    code = _validate_stock_code(stock_code)
    year_count = int(years)
    if year_count < 1:
        raise ValueError("财务数据年度数量必须大于等于 1")
    symbol = _to_em_symbol(code)

    profit_raw = ak.stock_profit_sheet_by_report_em(symbol=symbol)
    cashflow_raw = ak.stock_cash_flow_sheet_by_report_em(symbol=symbol)
    balance_raw = ak.stock_balance_sheet_by_report_em(symbol=symbol)

    profit = _prepare_annual_statement(profit_raw, "利润表")
    cashflow = _prepare_annual_statement(cashflow_raw, "现金流量表")
    balance = _prepare_annual_statement(balance_raw, "资产负债表")

    revenue_column = _find_column(
        profit,
        ("OPERATE_INCOME", "TOTAL_OPERATE_INCOME", "营业收入", "营业总收入"),
    )
    profit_column = _find_column(
        profit,
        ("PARENT_NETPROFIT", "NETPROFIT", "归属于母公司所有者的净利润", "净利润"),
    )
    cashflow_column = _find_column(
        cashflow,
        ("NETCASH_OPERATE", "经营活动产生的现金流量净额"),
    )
    cost_column = _find_optional_column(profit, ("OPERATE_COST", "营业成本"))
    assets_column = _find_column(balance, ("TOTAL_ASSETS", "资产总计"))
    liabilities_column = _find_column(balance, ("TOTAL_LIABILITIES", "负债合计"))
    current_assets_column = _find_optional_column(
        balance, ("TOTAL_CURRENT_ASSETS", "流动资产合计")
    )
    current_liabilities_column = _find_optional_column(
        balance, ("TOTAL_CURRENT_LIAB", "TOTAL_CURRENT_LIABILITIES", "流动负债合计")
    )
    share_capital_column = _find_optional_column(balance, ("SHARE_CAPITAL", "股本"))

    profit_core = profit[["年度", "报告期", revenue_column, profit_column]].rename(
        columns={revenue_column: "营业收入", profit_column: "净利润"}
    )
    profit_core["营业成本"] = profit[cost_column] if cost_column else pd.NA
    cashflow_core = cashflow[["年度", cashflow_column]].rename(
        columns={cashflow_column: "经营现金流"}
    )
    balance_core = balance[["年度", assets_column, liabilities_column]].rename(
        columns={assets_column: "总资产", liabilities_column: "总负债"}
    )
    for target, source in (
        ("流动资产", current_assets_column),
        ("流动负债", current_liabilities_column),
        ("股本", share_capital_column),
    ):
        balance_core[target] = balance[source] if source else pd.NA

    numeric_balance_columns = ["总资产", "总负债", "流动资产", "流动负债", "股本"]
    for column in numeric_balance_columns:
        balance_core[column] = pd.to_numeric(balance_core[column], errors="coerce")
    balance_core = balance_core.sort_values("年度")
    previous_assets = balance_core["总资产"].shift(1)
    balance_core["平均总资产"] = (balance_core["总资产"] + previous_assets) / 2

    result = profit_core.merge(cashflow_core, on="年度", how="left")
    result = result.merge(balance_core, on="年度", how="left")
    result = result.sort_values("年度").drop_duplicates("年度", keep="last")
    numeric_columns = [
        "营业收入",
        "净利润",
        "经营现金流",
        "营业成本",
        *numeric_balance_columns,
        "平均总资产",
    ]
    for column in numeric_columns:
        result[column] = pd.to_numeric(result[column], errors="coerce")

    result["ROA"] = _divide_finite(result["净利润"], result["平均总资产"])
    result["负债率"] = _divide_finite(result["总负债"], result["总资产"])
    result["流动比率"] = _divide_finite(result["流动资产"], result["流动负债"])
    result["毛利率"] = _divide_finite(
        result["营业收入"] - result["营业成本"], result["营业收入"]
    )
    result["总资产周转率"] = _divide_finite(result["营业收入"], result["平均总资产"])

    if end_year is not None:
        result = result[result["年度"] <= _validate_year(end_year)]
    result = result.tail(year_count)
    result.insert(0, "股票代码", code)
    result["报告期"] = pd.to_datetime(result["报告期"]).dt.strftime("%Y-%m-%d")
    result = result[
        [
            "股票代码",
            "年度",
            "报告期",
            "营业收入",
            "净利润",
            "经营现金流",
            "总资产",
            "总负债",
            "流动资产",
            "流动负债",
            "营业成本",
            "股本",
            "平均总资产",
            "ROA",
            "负债率",
            "流动比率",
            "毛利率",
            "总资产周转率",
        ]
    ]
    result = result.reset_index(drop=True)

    output_dir = _get_output_dir(code)
    result.to_csv(output_dir / "financial_data.csv", index=False, encoding="utf-8-sig")
    return result


def fetch_annual_report_pdf(stock_code: str, year: int) -> Path:
    """查询并下载指定年度年报全文，返回本地 PDF 路径。"""
    code = _validate_stock_code(stock_code)
    report_year = _validate_year(year)
    output_dir = _get_output_dir(code)
    output_path = output_dir / f"annual_report_{report_year}.pdf"

    with _CNINFO_LOCK:
        if _is_valid_pdf(output_path):
            return output_path

        session = _create_cninfo_session()
        try:
            org_id = _fetch_org_id(session, code)
            announcement = _find_annual_announcement(session, code, org_id, report_year)
            adjunct_url = announcement.get("adjunctUrl", "")
            if not adjunct_url:
                raise RuntimeError("巨潮年报记录缺少 PDF 下载地址")

            download_url = f"{CNINFO_STATIC_URL}/{adjunct_url.lstrip('/')}"
            _download_pdf(session, download_url, output_path)
        finally:
            session.close()

    return output_path


def _validate_stock_code(stock_code: str) -> str:
    code = str(stock_code).strip()
    if not re.fullmatch(r"\d{6}", code):
        raise ValueError("股票代码必须是 6 位数字，例如 000001")
    return code


def _validate_year(year: int) -> int:
    try:
        report_year = int(year)
    except (TypeError, ValueError) as exc:
        raise ValueError("年报年度必须是四位整数") from exc

    if not 1990 <= report_year <= datetime.now().year:
        raise ValueError(f"年报年度应在 1990 至 {datetime.now().year} 之间")
    return report_year


def _to_em_symbol(code: str) -> str:
    if code.startswith("6"):
        return f"SH{code}"
    if code.startswith(("0", "3")):
        return f"SZ{code}"
    if code.startswith(("4", "8", "9")):
        return f"BJ{code}"
    raise ValueError(f"暂不支持该股票代码所属市场: {code}")


def _get_output_dir(code: str) -> Path:
    output_dir = DATA_ROOT / code
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def _prepare_annual_statement(df: pd.DataFrame, statement_name: str) -> pd.DataFrame:
    if df is None or df.empty:
        raise ValueError(f"AKShare 未返回{statement_name}数据")

    result = df.copy()
    date_column = _find_column(result, ("REPORT_DATE", "报告期", "报告日期"))
    result["报告期"] = pd.to_datetime(result[date_column], errors="coerce")
    result = result.dropna(subset=["报告期"])
    result = result[result["报告期"].dt.strftime("%m-%d") == "12-31"].copy()
    result["年度"] = result["报告期"].dt.year
    result = result.sort_values("报告期").drop_duplicates("年度", keep="last")

    if result.empty:
        raise ValueError(f"{statement_name}中没有年度报告数据")
    return result


def _find_column(df: pd.DataFrame, candidates: tuple[str, ...]) -> str:
    for column in candidates:
        if column in df.columns and df[column].notna().any():
            return column
    raise KeyError(f"返回数据中缺少所需字段，候选字段: {', '.join(candidates)}")


def _find_optional_column(df: pd.DataFrame, candidates: tuple[str, ...]) -> str | None:
    for column in candidates:
        if column in df.columns and df[column].notna().any():
            return column
    return None


def _divide_finite(numerator: pd.Series, denominator: pd.Series) -> pd.Series:
    result = numerator.div(denominator.where(denominator.ne(0)))
    return result.replace([float("inf"), float("-inf")], pd.NA)


def _create_cninfo_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Referer": "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search",
            "Accept": "application/json, text/plain, */*",
        }
    )
    return session


def _post_cninfo(session: requests.Session, url: str, data: dict) -> requests.Response:
    time.sleep(CNINFO_DELAY_SECONDS)
    response = session.post(url, data=data, timeout=(10, 45))
    response.raise_for_status()
    return response


def _fetch_org_id(session: requests.Session, code: str) -> str:
    response = _post_cninfo(
        session,
        CNINFO_SEARCH_URL,
        {"keyWord": code, "maxNum": "10"},
    )
    companies = response.json()
    if not isinstance(companies, list) or not companies:
        raise LookupError(f"巨潮资讯未找到股票代码 {code}")

    company = next(
        (item for item in companies if str(item.get("code", "")) == code),
        companies[0],
    )
    org_id = company.get("orgId", "")
    if not org_id:
        raise LookupError(f"巨潮资讯未返回股票代码 {code} 的 orgId")
    return org_id


def _query_cninfo_annual(
    session: requests.Session,
    code: str,
    org_id: str,
    se_date: str,
    category: str,
    searchkey: str,
) -> list[dict]:
    response = _post_cninfo(
        session,
        CNINFO_ANNOUNCEMENT_URL,
        {
            "pageNum": "1",
            "pageSize": "30",
            "column": _cninfo_column(code),
            "tabName": "fulltext",
            "plate": "",
            "stock": f"{code},{org_id}",
            "searchkey": searchkey,
            "secid": "",
            "category": category,
            "trade": "",
            "seDate": se_date,
            "sortName": "",
            "sortType": "",
            "isHLtitle": "false",
        },
    )
    return response.json().get("announcements") or []


def _find_annual_announcement(
    session: requests.Session,
    code: str,
    org_id: str,
    year: int,
) -> dict:
    se_date = f"{year + 1}-01-01~{year + 1}-12-31"
    seen: list[dict] = []
    # 巨潮的年报类别标签对个别公司不一致：实测 600958 东方证券 2025 年年度报告全文在巨潮存在且可下载，
    # 却不出现在 category_ndbg_szsh 类别结果里，只用类别查询会误报“找不到”。
    # 因此类别查询拿不到可接受全文时，退回“不限类别 + 关键词”再查一次，套用同一套标题过滤。
    for category, searchkey in (("category_ndbg_szsh;", ""), ("", f"{year}年年度报告")):
        announcements = _query_cninfo_annual(
            session, code, org_id, se_date, category, searchkey,
        )
        seen.extend(announcements)
        matches = [
            item
            for item in announcements
            if _is_target_annual_report(item.get("announcementTitle", ""), year)
            and str(item.get("adjunctUrl", "")).lower().endswith(".pdf")
        ]
        if matches:
            return max(matches, key=lambda item: item.get("announcementTime") or 0)

    titles = [
        re.sub(r"<[^>]+>", "", str(item.get("announcementTitle", ""))).replace(" ", "")
        for item in seen
    ]
    # 区分“只披露了摘要”和“什么都没检索到”：摘要不含 MD&A，不能退化成拿摘要做语调审计。
    if any(re.search(rf"{year}年?年度报告摘要", title) for title in titles):
        raise FileNotFoundError(
            f"{code} 的 {year} 年只检索到年度报告摘要，未检索到全文；摘要不含管理层讨论与分析章节，无法做语调审计"
        )
    raise FileNotFoundError(f"未检索到 {code} 的 {year} 年年度报告（全文与摘要均未命中）")


def _cninfo_column(code: str) -> str:
    if code.startswith("6"):
        return "sse"
    if code.startswith(("4", "8", "9")):
        return "bjse"
    return "szse"


def _is_target_annual_report(title: str, year: int) -> bool:
    clean_title = re.sub(r"<[^>]+>", "", title).replace(" ", "")
    if not re.search(rf"{year}年?年度报告", clean_title):
        return False

    excluded_keywords = (
        "摘要",
        "英文",
        "已取消",
        "更正公告",
        "补充公告",
        "问询",
        "回复",
        "提示性公告",
    )
    if any(keyword in clean_title for keyword in excluded_keywords):
        return False

    return not _is_cross_entity_announcement(clean_title)


def _is_cross_entity_announcement(title: str) -> bool:
    """识别挂在母公司条目下的子公司公告。

    巨潮会返回形如「中国平安：平安银行股份有限公司2025年年度报告」的条目，
    若被选中就会拿子公司的报告去审计母公司，而且不会报错。
    冒号后出现另一个明确主体且与冒号前缀互不包含时判为串档；
    「港股公告：2025年年度报告」这类后缀没有主体名的正常公告放行，避免过度排除。
    """
    index = title.find("：")
    if index < 0:
        return False
    prefix = title[:index]
    suffix = title[index + 1:]
    match = re.search(r"[\u4e00-\u9fffA-Za-z()（）]{2,24}?(?:股份有限公司|有限公司)", suffix)
    if not match:
        return False
    entity = match.group(0)
    return entity not in prefix and prefix not in entity


def _download_pdf(session: requests.Session, url: str, output_path: Path) -> None:
    temporary_path = output_path.with_suffix(".pdf.part")
    time.sleep(CNINFO_DELAY_SECONDS)

    try:
        with session.get(url, stream=True, timeout=(10, 120)) as response:
            response.raise_for_status()
            with temporary_path.open("wb") as file:
                for chunk in response.iter_content(chunk_size=256 * 1024):
                    if chunk:
                        file.write(chunk)

        if not _is_valid_pdf(temporary_path):
            raise ValueError("下载内容不是有效的 PDF 文件")
        temporary_path.replace(output_path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _is_valid_pdf(path: Path) -> bool:
    if not path.exists() or path.stat().st_size < 5:
        return False
    with path.open("rb") as file:
        return file.read(4) == b"%PDF"
