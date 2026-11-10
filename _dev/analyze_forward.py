"""前瞻验证 · 预注册分析设计（先写死，再取数，防止事后挑口径）。

问题：t=2024 年的高背离，是否预示 t+1=2025 年的基本面变差？

结局变量（全部是原始会计事实，不用我们自己的分数，避免用同一把尺子量两次）
  Y1  2025 归母净利润同比   = np2025 / np2024 - 1
  Y2  2025 营业收入同比     = rev2025 / rev2024 - 1
  Y3  2025 净现比 < 1 的哑变量（利润有没有现金支撑）
  Y4  2025 经营现金流同比

自变量
  X1 背离度 = tone(2024) − weakness_pct(2024)
  X2 纯语调 tone(2024)

主检验（关键：必须有增量信息，不是重复财务侧）
  在**控制 2024 年财务状况**（水平分位、同比变化分位、2024 年净利润同比）之后，
  X1 / X2 是否仍与 Y1 显著负相关。
  做法：把 2024 财务分位做三分位分层，看每层内部「高背离 vs 低背离」的 Y1 差；
  分层内比较才不会被「财务差的公司本来明年也差」这种持续性解释掉。

次级描述
  按 2024 档位（红/黄/绿）分组报告 Y1、Y2 的均值与样本数——只作为描述，
  因为档位本身含财务分位，不能当因果或独立预测力的证据。

排除与披露
  缺 2025 年报数据者剔除并计数；语调分由 Python 抽取器得到（未移植句子合并），
  因此绝对值与线上不可比，但同一批内一致，不影响配对比较。
  样本量、区间和 p 值一律如实报告；n 不足以支持结论时直接说不支持。
"""
import json
import statistics
from pathlib import Path

rows = [json.loads(l) for l in Path("_dev/forward_rows.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
print(f"读入 {len(rows)} 条")

usable, dropped = [], []
for r in rows:
    if r.get("tone_2024") is None or r.get("np_2024") in (None, 0) or r.get("np_2025") is None:
        dropped.append(r.get("code"))
        continue
    r["y_np"] = r["np_2025"] / r["np_2024"] - 1
    r["y_rev"] = (r["rev_2025"] / r["rev_2024"] - 1) if r.get("rev_2024") and r.get("rev_2025") is not None else None
    r["y_cf"] = (r["cf_2025"] / r["cf_2024"] - 1) if r.get("cf_2024") and r.get("cf_2025") is not None else None
    usable.append(r)
print(f"可用 n={len(usable)}；剔除 {len(dropped)} 家（缺 2024 或 2025 数据）\n")

if len(usable) < 30:
    print("样本量不足以做任何结论，停止。")
    raise SystemExit(0)


def spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r
    a, b = rank(xs), rank(ys)
    ma, mb = statistics.mean(a), statistics.mean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = sum((x - ma) ** 2 for x in a) ** 0.5
    db = sum((y - mb) ** 2 for y in b) ** 0.5
    rho = num / (da * db) if da and db else float("nan")
    n = len(xs)
    # t 近似给出区间，n 小时它只是粗略参考，会一并标注
    se = 1 / (n - 3) ** 0.5
    z = atanh = 0.5 * __import__("math").log((1 + rho) / (1 - rho)) if 0 < abs(rho) < 1 else 0
    ci = (1 - 2.718281828 ** (1.96 * se)) / (1 + 2.718281828 ** (1.96 * se))
    return rho, n, z, ci


pairs = [(r["divergence"], r["y_np"]) for r in usable if r.get("divergence") is not None]
rho, n, z, ci = spearman([p[0] for p in pairs], [p[1] for p in pairs])
print(f"【主检验·未控制】背离度(2024) 与 净利润同比(2025)：Spearman ρ = {rho:+.3f} (n={n})，95% 区间约 ±{ci:.3f}")

pairs2 = [(r["tone_2024"], r["y_np"]) for r in usable]
rho2, n2, _, ci2 = spearman([p[0] for p in pairs2], [p[1] for p in pairs2])
print(f"              纯语调(2024) 与 净利润同比(2025)：ρ = {rho2:+.3f} (n={n2})，95% 区间约 ±{ci2:.3f}")

# 分层内比较：控制当年财务状况
print("\n【主检验·控制 2024 财务水平分位后的三分位分层】")
by_state = {}
for r in usable:
    if r.get("level_pct") is None or r.get("divergence") is None:
        continue
    by_state.setdefault(r["level_pct"], []).append(r)
ordered = sorted(by_state.items(), key=lambda kv: kv[0])
flat = [r for _, group in ordered for r in group]
third = len(flat) // 3
strata = {"财务较差(前1/3)": flat[:third], "财务居中": flat[third:2 * third], "财务较好(后1/3)": flat[2 * third:]}
for label, group in strata.items():
    if len(group) < 8:
        print(f"  {label}: n={len(group)} 太少，跳过")
        continue
    med = statistics.median([g["divergence"] for g in group])
    hi = [g["y_np"] for g in group if g["divergence"] >= med]
    lo = [g["y_np"] for g in group if g["divergence"] < med]
    if len(hi) < 4 or len(lo) < 4:
        print(f"  {label}: 分组太小，跳过")
        continue
    print(f"  {label}: n={len(group)}  高背离组 2025净利同比 {statistics.mean(hi):+.2%} (n={len(hi)})"
          f"  低背离组 {statistics.mean(lo):+.2%} (n={len(lo)})  差 {statistics.mean(hi) - statistics.mean(lo):+.2%}")

print("\n【描述性·按 2024 档位】（档位含财务分位，不能当独立预测力证据）")
buckets = {}
for r in usable:
    buckets.setdefault(r.get("grade_2024", "unknown"), []).append(r)
for grade in ("red", "amber", "green", "unknown"):
    group = buckets.get(grade) or []
    if not group:
        continue
    print(f"  {grade:8s} n={len(group):3d}  2025净利同比均值 {statistics.mean([g['y_np'] for g in group]):+.2%} "
          f"中位 {statistics.median([g['y_np'] for g in group]):+.2%}  2025营收同比均值 "
          f"{statistics.mean([g['y_rev'] for g in group if g['y_rev'] is not None]):+.2%}")

print("\n【描述性·净现比】2025 年净现比 < 1 的比例，按 2024 档位")
for grade, group in buckets.items():
    vals = [g.get("ncr_2025") for g in group if g.get("ncr_2025") is not None]
    if vals:
        print(f"  {grade:8s} n={len(vals):3d}  净现比<1 占比 {sum(1 for v in vals if v < 1) / len(vals):.1%}")
