"""效度验证：同行业配对对照的语调分布比较。

不循环的设计要点：百强名单本身含盈利/资本结构维度，所以「百强报警率低」部分是
背离度公式的必然，不能当验证。真正不循环的量是**语调虚高分数**——它只来自模型读文本，
不接触财务数据。若百强与该批公司同行业的对照公司在语调分上没有差异，
就证明我们的轴不是健康水平的复述；若显著更低，就必须承认语调分里带了质量信息。

对照选取规则（确定性、可复算）：对每家百强，在其**同一东财一级板块**的成员里，
取代码最接近、且不属于百强名单的公司作为对照。同行业配对是为了把「板块写作风格」
这个替代解释排除掉；代码最近又倾向于规模/地域相近。
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
import pandas as pd  # noqa: E402
from data_fetching import fetch_annual_report_pdf  # noqa: E402
from data_processing import extract_mda_text  # noqa: E402

HOST = "https://mda-tone-audit-mwsjkulrp4b.qoder.zone"
YEAR = 2024
OUT = Path("_dev/validity_rows.jsonl")
LOCK = threading.Lock()

hi = json.load(open("_dev/hi_top20.json", encoding="utf-8"))
industry_map = json.load(open("_dev/ref_industry.json", encoding="utf-8"))
codes = sorted(hi.values())
name_by_code = {v: k for k, v in hi.items()}

directory = pd.read_csv("data/stock_list.csv", dtype=str, encoding="utf-8-sig")
directory.columns = [c.strip() for c in directory.columns]
all_codes = [c.strip().zfill(6) for c in directory[directory.columns[0]].tolist()]
by_board: dict[str, list[str]] = {}
for code in all_codes:
    entry = industry_map.get(code)
    if not entry or not entry.get("bk1Name"):
        continue
    by_board.setdefault(entry["bk1Name"], []).append(code)

pairs = []
used_controls: set[str] = set()
for code in codes:
    entry = industry_map.get(code)
    board = entry["bk1Name"] if entry else ""
    pool = [c for c in by_board.get(board, []) if c not in codes and c not in used_controls]
    if not pool:
        print(f"  跳过 {code}（{board}）：同板块没有可用对照")
        continue
    control = min(pool, key=lambda c: (abs(int(c) - int(code)), c))
    used_controls.add(control)
    pairs.append((code, control, board))

print(f"配对 {len(pairs)} 组 = {len(pairs) * 2} 家公司，报告年度 {YEAR}")
for hi_code, ctl, board in pairs:
    print(f"  {board:8s} 百强 {hi_code} {name_by_code[hi_code]:6s} ←对照→ {ctl}")


def get_json(url: str):
    req = urllib.request.Request(url, headers={"Origin": HOST})
    return json.load(urllib.request.urlopen(req, timeout=120))


def post_tone(mda: str):
    body = json.dumps({"mda": mda}).encode("utf-8")
    req = urllib.request.Request(
        f"{HOST}/functions/v1/app?action=tone",
        data=body,
        headers={"Content-Type": "application/json", "Origin": HOST},
    )
    return json.load(urllib.request.urlopen(req, timeout=150))


def run_one(pair):
    hi_code, ctl_code, board = pair
    out = []
    for role, code in (("百强", hi_code), ("对照", ctl_code)):
        rec = {"role": role, "code": code, "board": board, "year": YEAR}
        for attempt in range(2):
            try:
                pdf = fetch_annual_report_pdf(code, YEAR)
                mda = extract_mda_text(pdf)
                rec["mda_chars"] = len(mda)
                rec["paragraphs"] = len([l for l in mda.splitlines() if l.strip()])
                tone = post_tone(mda)
                rec["tone"] = tone.get("sentiment_score")
                rec["tone_chunks"] = tone.get("chunks")
                fin = get_json(f"{HOST}/functions/v1/app?action=financials&code={code}&year={YEAR}")
                a = fin["analysis"]
                rec["raw"] = a["raw_health_score"]
                rec["change"] = a["change_score"]
                rec["level_pct"] = a["band"]["level_percentile"]
                rec["change_pct"] = a["band"]["change_percentile"]
                rec["group"] = a["band"]["group_label"]
                rec["quality_tier"] = a["band"]["quality_tier"]
                out.append(rec)
                break
            except Exception as error:
                rec["error"] = f"{type(error).__name__}: {str(error)[:160]}"
                if attempt == 1:
                    out.append(rec)
                else:
                    time.sleep(2)
        with LOCK:
            print(f"  {rec['role']} {code} tone={rec.get('tone')} raw={rec.get('raw')} "
                  f"level%={rec.get('level_pct')} err={rec.get('error', '')[:60]}")
    return out


results = []
with ThreadPoolExecutor(max_workers=3) as pool:
    for chunk in pool.map(run_one, pairs):
        results.extend(chunk)

with open(OUT, "w", encoding="utf-8") as handle:
    for rec in results:
        handle.write(json.dumps(rec, ensure_ascii=False) + "\n")
print(f"\n写入 {len(results)} 条 → {OUT}")
bad = [r for r in results if r.get("error")]
print(f"失败 {len(bad)} 条")
