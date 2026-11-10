"""前瞻验证取数：t=2024 的语调与财务状况 → t+1=2025 的原始会计结果。

抽样：从 data/stock_list.csv 按代码顺序等距抽样（步长 28，约 200 家），
等距而非随机是为了可复现；它天然按行业比例覆盖，因为名录本身按代码排序、行业分布交错。
结局侧全部走线上 financials 接口（产品用的就是这些数），不另立一套口径。
"""
import json
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, ".")
from data_fetching import fetch_annual_report_pdf  # noqa: E402
from data_processing import extract_mda_text  # noqa: E402

HOST = "https://mda-tone-audit-mwsjkulrp4b.qoder.zone"
OUT = Path("_dev/forward_rows.jsonl")
STRIDE = 28
PRINT_LOCK = threading.Lock()

cuts = json.load(urllib.request.urlopen(
    urllib.request.Request(f"{HOST}/functions/v1/app?action=bands", headers={"Origin": HOST}), timeout=60))["cuts"]

directory = pd_codes = None
lines = Path("data/stock_list.csv").read_text(encoding="utf-8-sig").splitlines()
codes = []
for line in lines[1:]:
    cells = line.strip().split(",")
    if len(cells) >= 2 and len(cells[0]) == 6 and cells[0].isdigit():
        codes.append((cells[0], cells[1].replace(" ", "")))
sample = codes[::STRIDE]
print(f"总体 {len(codes)} 家，等距步长 {STRIDE} → 抽样 {len(sample)} 家")


def get_json(path: str):
    req = urllib.request.Request(f"{HOST}{path}", headers={"Origin": HOST})
    return json.load(urllib.request.urlopen(req, timeout=90))


def post_tone(mda: str):
    req = urllib.request.Request(
        f"{HOST}/functions/v1/app?action=tone",
        data=json.dumps({"mda": mda}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Origin": HOST},
    )
    return json.load(urllib.request.urlopen(req, timeout=170))


def levels_by_year(rows):
    return {int(r["year"]): r for r in rows}


def run_one(item):
    code, name = item
    rec = {"code": code, "name": name}
    for attempt in range(2):
        try:
            fin24 = get_json(f"/functions/v1/app?action=financials&code={code}&year=2024")
            l24 = levels_by_year(fin24["rows"]).get(2024)
            a24 = fin24["analysis"]
            band = a24["band"]
            rec["raw_2024"] = a24["raw_health_score"]
            rec["level_pct"] = band["level_percentile"]
            rec["change_pct"] = band["change_percentile"]
            rec["group"] = band["group_label"]
            rec["industry"] = fin24.get("industry") or ""

            fin25 = get_json(f"/functions/v1/app?action=financials&code={code}&year=2025")
            l25 = levels_by_year(fin25["rows"]).get(2025)
            if l24 is None or l25 is None:
                rec["error"] = "missing_year_row"
                break
            for key, src in (("np", "netProfit"), ("rev", "revenue"), ("cf", "operatingCashflow"),
                              ("ded", "deductedNetProfit")):
                rec[f"{key}_2024"] = l24.get(src)
                rec[f"{key}_2025"] = l25.get(src)
            rec["ncr_2025"] = (l25["operatingCashflow"] / l25["netProfit"]
                               if l25.get("netProfit") and l25.get("operatingCashflow") is not None
                               and l25["netProfit"] > 0 else None)

            mda = extract_mda_text(fetch_annual_report_pdf(code, 2024))
            rec["mda_chars"] = len(mda)
            tone = post_tone(mda)
            rec["tone_2024"] = tone.get("sentiment_score")
            rec["tone_spread"] = tone.get("score_spread")
            weakness = rec["level_pct"]
            if rec.get("change_pct") is not None:
                weakness = min(weakness, rec["change_pct"])
            rec["divergence"] = round(rec["tone_2024"] - weakness, 2)
            rec["grade_2024"] = ("red" if rec["divergence"] >= cuts["red"]
                                 else "amber" if rec["divergence"] >= cuts["amber"] else "green")
            break
        except Exception as error:
            rec["error"] = f"{type(error).__name__}: {str(error)[:140]}"
            if attempt == 0:
                time.sleep(2)
    with PRINT_LOCK:
        COUNT[0] += 1
        if COUNT[0] % 10 == 0 or rec.get("error"):
            print(f"  [{COUNT[0]}/{len(sample)}] {code} {name} tone={rec.get('tone_2024')} "
                  f"div={rec.get('divergence')} {rec.get('grade_2024', '')} {rec.get('error', '')[:70]}", flush=True)
    return rec


COUNT = [0]
results = []
with ThreadPoolExecutor(max_workers=4) as pool:
    for rec in pool.map(run_one, sample):
        results.append(rec)
        with open(OUT, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(rec, ensure_ascii=False) + "\n")

ok = [r for r in results if r.get("tone_2024") is not None]
print(f"\n完成：有语调 {len(ok)} / {len(results)}；失败 {len(results) - len(ok)}")
