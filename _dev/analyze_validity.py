"""效度验证分析：百强 vs 同行业配对对照。

主检验量是**语调虚高指数**：它只来自模型读 MD&A 文本，不接触任何财务数据，
所以它是这套系统里唯一不会被「背离度公式」自我实现的量。
报警率一并报告，但它是部分循环的（百强本身财务分位高 → 背离度天然低），
只作为描述性事实，不作为验证结论。
"""
import json
import statistics
from pathlib import Path

import pandas as pd

YEAR = 2024
rows = [json.loads(l) for l in Path("_dev/validity_rows.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
by_code = {}
for rec in rows:
    by_code.setdefault(rec["code"], []).append(rec)

# 用与跑批完全相同的规则重算配对，再核对代码集合，确保两边配的是同一批
hi = json.load(open("_dev/hi_top20.json", encoding="utf-8"))
industry_map = json.load(open("_dev/ref_industry.json", encoding="utf-8"))
codes = sorted(hi.values())
directory = pd.read_csv("data/stock_list.csv", dtype=str, encoding="utf-8-sig")
directory.columns = [c.strip() for c in directory.columns]
all_codes = [c.strip().zfill(6) for c in directory[directory.columns[0]].tolist()]
by_board: dict[str, list[str]] = {}
for code in all_codes:
    entry = industry_map.get(code)
    if entry and entry.get("bk1Name"):
        by_board.setdefault(entry["bk1Name"], []).append(code)
pairs, used = [], set()
for code in codes:
    entry = industry_map.get(code)
    board = entry["bk1Name"] if entry else ""
    pool = [c for c in by_board.get(board, []) if c not in codes and c not in used]
    if not pool:
        continue
    control = min(pool, key=lambda c: (abs(int(c) - int(code)), c))
    used.add(control)
    pairs.append((code, control, board))

present = {c for c, r in by_code.items() if r and r[0].get("tone") is not None}
missing_hi = [c for c, _, _ in pairs if c not in present]
missing_ctl = [c for _, c, _ in pairs if c not in present]
print(f"配对 {len(pairs)} 组；有效语调 {len(present)} 家；缺 百强{len(missing_hi)} 对照{len(missing_ctl)}")

paired = []
for hi_code, ctl_code, board in pairs:
    a = by_code.get(hi_code, [{}])[0]
    b = by_code.get(ctl_code, [{}])[0]
    if a.get("tone") is None or b.get("tone") is None:
        continue
    paired.append({"board": board, "hi": a, "ctl": b})
print(f"成对可用 n={len(paired)}\n")

hi_tone = [p["hi"]["tone"] for p in paired]
ctl_tone = [p["ctl"]["tone"] for p in paired]
diffs = [p["hi"]["tone"] - p["ctl"]["tone"] for p in paired]
lower = sum(1 for d in diffs if d < 0)
higher = sum(1 for d in diffs if d > 0)
ties = len(diffs) - lower - higher

print(f"语调虚高指数：百强 均值 {statistics.mean(hi_tone):.2f} 中位 {statistics.median(hi_tone):.2f}")
print(f"              对照 均值 {statistics.mean(ctl_tone):.2f} 中位 {statistics.median(ctl_tone):.2f}")
print(f"              配对差(百强-对照) 均值 {statistics.mean(diffs):+.2f} 中位 {statistics.median(diffs):+.2f} "
      f"标准差 {statistics.stdev(diffs) if len(diffs) > 1 else 0:.2f}")
print(f"              百强更低 {lower} 对 / 更高 {higher} 对 / 相等 {ties} 对")
# 双侧符号检验（精确二项），不假设正态，n 小也能给诚实的 p
from math import comb  # noqa: E402
n_sign = lower + higher
k = min(lower, higher)
if n_sign:
    p_sign = min(1.0, 2 * sum(comb(n_sign, i) for i in range(0, k + 1)) / (2 ** n_sign))
    print(f"              符号检验 双侧 p = {p_sign:.4f}（n={n_sign}，排除相等对）")

print("\n【循环性披露用】财务侧与报警率（同一批公司）")
# 切点从线上 bands 接口取，不在分析脚本里重抄一遍数字：
# 重抄就意味着存在两个版本，而线上那个才是判定实际用的。
def live_cuts():
    import urllib.request
    host = "https://mda-tone-audit-mwsjkulrp4b.qoder.zone"
    req = urllib.request.Request(f"{host}/functions/v1/app?action=bands", headers={"Origin": host})
    return json.load(urllib.request.urlopen(req, timeout=60))["cuts"]


CUTS = live_cuts()


def rate(recs):
    cuts = CUTS
    out = {"red": 0, "amber": 0, "green": 0, "unknown": 0}
    for r in recs:
        if r.get("tone") is None or r.get("level_pct") is None:
            out["unknown"] += 1
            continue
        weakness = min(r["level_pct"], r["change_pct"]) if r.get("change_pct") is not None else r["level_pct"]
        gap = r["tone"] - weakness
        out["red" if gap >= cuts["red"] else "amber" if gap >= cuts["amber"] else "green"] += 1
    return out

hi_recs = [p["hi"] for p in paired]
ctl_recs = [p["ctl"] for p in paired]
print(f"  财务水平分位中位：百强 {statistics.median([p['hi']['level_pct'] for p in paired]):.1f} "
      f"vs 对照 {statistics.median([p['ctl']['level_pct'] for p in paired]):.1f}")
print(f"  档位分布 百强：{rate(hi_recs)}")
print(f"  档位分布 对照：{rate(ctl_recs)}")

print("\n逐对明细（语调：百强 vs 对照）")
for p in sorted(paired, key=lambda x: x["board"]):
    d = p["hi"]["tone"] - p["ctl"]["tone"]
    print(f"  {p['board']:8s} {p['hi']['code']} {p['hi']['tone']:6.2f}  vs  {p['ctl']['code']} {p['ctl']['tone']:6.2f}   Δ{d:+6.2f}")
