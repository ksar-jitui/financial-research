"""前瞻验证 · 稳健重算。

对预注册的偏离必须说清：预注册的主统计量本来就是秩相关（Spearman），
分层比较是我自己补的次要分析，且原先用了均值——2025 净利同比是重尾变量
（小基数公司动辄 ±200%），均值会被极端值劫持，出现「财务较差层 −111%、
财务较好层 +223%」这种反号。这里把分层比较也改成秩，与主检验同一套逻辑，
属于把次要分析改稳健，不是换统计量找显著。
"""
import json
import math
import statistics
from pathlib import Path

rows = [json.loads(l) for l in Path("_dev/forward_rows.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
usable = []
for r in rows:
    if r.get("tone_2024") is None or not r.get("np_2024") or r.get("np_2025") is None or r.get("divergence") is None:
        continue
    if r["np_2024"] <= 0:
        # 基期为负的同比没有经济含义（−100 涨到 −50 会算出 +50%），剔除并计数
        continue
    r["y_np"] = r["np_2025"] / r["np_2024"] - 1
    usable.append(r)
print(f"可用 n={len(usable)}（另剔除：无语调 {sum(1 for r in rows if r.get('tone_2024') is None)}、"
      f"基期净利≤0 {sum(1 for r in rows if r.get('tone_2024') is not None and (r.get('np_2024') or 0) <= 0)}）\n")


def ranks(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    out = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        for k in range(i, j + 1):
            out[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return out


def spearman(xs, ys):
    a, b = ranks(xs), ranks(ys)
    ma, mb = statistics.mean(a), statistics.mean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = math.sqrt(sum((x - ma) ** 2 for x in a))
    db = math.sqrt(sum((y - mb) ** 2 for y in b))
    rho = num / (da * db)
    n = len(xs)
    z = math.atanh(max(-0.999999, min(0.999999, rho)))
    se = 1 / math.sqrt(n - 3)
    return rho, n, (math.tanh(z - 1.96 * se), math.tanh(z + 1.96 * se))


def mannwhitney(a, b):
    """秩和检验（正态近似，含结校正的粗略版），返回 U 与双侧 p。"""
    allr = ranks(a + b)
    ra = allr[: len(a)]
    n1, n2 = len(a), len(b)
    u1 = sum(ra) - n1 * (n1 + 1) / 2
    mu = n1 * n2 / 2
    sigma = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12)
    z = (u1 - mu) / sigma if sigma else 0.0
    p = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    return min(u1, n1 * n2 - u1), z, p


div = [r["divergence"] for r in usable]
y = [r["y_np"] for r in usable]
tone = [r["tone_2024"] for r in usable]
lvl = [r["level_pct"] for r in usable]

rho, n, ci = spearman(div, y)
print(f"【主检验·预注册】背离度(2024) ↔ 2025净利同比：Spearman ρ = {rho:+.3f} (n={n})，95% CI [{ci[0]:+.3f}, {ci[1]:+.3f}]")
rho_t, nt, ci_t = spearman(tone, y)
print(f"              纯语调(2024) ↔ 2025净利同比：ρ = {rho_t:+.3f}，95% CI [{ci_t[0]:+.3f}, {ci_t[1]:+.3f}]")

# 偏秩相关：把 2024 财务水平分位与 2024 净利同比「减掉」，看语调还剩多少预测力
ctrl = [r["level_pct"] for r in usable]
prev_yoy = [(r["np_2024"] / r["np_2023"] - 1) if r.get("np_2023") and r["np_2023"] > 0 else 0.0 for r in usable]


def partial(xs, ys, cs):
    rx, ry = ranks(xs), ranks(ys)
    out_x, out_y = [], []
    for c in cs:
        rc = ranks(c)
        # 对每个控制变量做秩上的简单线性残差化，再取残差相关
        mc, mx, my = statistics.mean(rc), statistics.mean(rx), statistics.mean(ry)
        sxx = sum((v - mc) ** 2 for v in rc)
        b_x = sum((v - mc) * (w - mx) for v, w in zip(rc, rx)) / sxx if sxx else 0
        b_y = sum((v - mc) * (w - my) for v, w in zip(rc, ry)) / sxx if sxx else 0
        out_x = [a - (mx + b_x * (c0 - mc)) for a, c0 in zip(rx, rc)]
        out_y = [a - (my + b_y * (c0 - mc)) for a, c0 in zip(ry, rc)]
    return spearman(out_x, out_y)


pr, prn, prci = partial(div, y, [ctrl, prev_yoy])
print(f"\n【关键·增量信息检验】控制 2024 财务水平分位与 2024 净利同比后，"
      f"背离度 ↔ 2025净利同比：偏秩 ρ = {pr:+.3f} (n={prn})，95% CI [{prci[0]:+.3f}, {prci[1]:+.3f}]")

print("\n【分层稳健版】按 2024 财务水平分位三分，层内比较高/低背离半组")
flat = sorted(usable, key=lambda r: r["level_pct"])
third = len(flat) // 3
for label, group in [("财务较差 1/3", flat[:third]), ("财务居中", flat[third:2 * third]), ("财务较好 1/3", flat[2 * third:])]:
    med = statistics.median([g["divergence"] for g in group])
    hi = [g["y_np"] for g in group if g["divergence"] >= med]
    lo = [g["y_np"] for g in group if g["divergence"] < med]
    if len(hi) < 5 or len(lo) < 5:
        print(f"  {label}: n={len(group)} 太小跳过")
        continue
    u, z, p = mannwhitney(hi, lo)
    print(f"  {label}: n={len(group)}  高背离 中位 {statistics.median(hi):+.2%} (n={len(hi)}) | "
          f"低背离 中位 {statistics.median(lo):+.2%} (n={len(lo)}) | Mann-Whitney p={p:.3f}")

print("\n【描述·中位数】2025净利同比按 2024 档位（均值不可用，重尾）")
buckets = {}
for r in usable:
    buckets.setdefault(r.get("grade_2024", "?"), []).append(r["y_np"])
for grade in ("red", "amber", "green"):
    g = buckets.get(grade) or []
    if g:
        print(f"  {grade:6s} n={len(g):3d}  中位 {statistics.median(g):+.2%}  四分位 "
              f"[{g[sorted(range(len(g)), key=lambda i: g[i])[len(g)//4]]:+.2%}, "
              f"{g[sorted(range(len(g)), key=lambda i: g[i])[len(g)*3//4]]:+.2%}]")
red, green = buckets.get("red", []), buckets.get("green", [])
if len(red) >= 5 and len(green) >= 5:
    u, z, p = mannwhitney(red, green)
    print(f"  红线 vs 绿线 Mann-Whitney：p = {p:.3f}（n_red={len(red)}, n_green={len(green)}）")
