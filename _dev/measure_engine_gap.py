import json
import subprocess
import sys

CODES = ["000001", "600519", "000625", "002594", "600036", "601318", "300750", "002415",
         "601088", "000333", "001359", "600000"]

# 1) 用 TS 引擎取东财年度行与它的原始分（一次请求拿全部）
js = """
import { analyzeFinancial } from "../functions/lib/agents.ts";
import { fetchFinancials } from "../functions/lib/eastmoney.ts";
const CODES = %s;
const out = [];
for (const code of CODES) {
  try {
    const rows = await fetchFinancials(code);
    for (let i = 1; i < rows.length; i++) {
      const view = rows.slice(0, i + 1);
      const a = analyzeFinancial(view);
      const r = view[view.length - 1];
      out.push({ code, year: r.year, ts: a.raw_health_score,
                 rev: r.revenue, np: r.netProfit, cf: r.operatingCashflow });
    }
  } catch (e) { out.push({ code, error: String(e) }); }
}
console.log(JSON.stringify(out));
""" % json.dumps(CODES)
open("_dev/_ts_scores.mts", "w", encoding="utf-8").write(js)

# 用 Electron 自带的那份 Node 跑 TS：路径每台机器都不同，所以不写死。
# 优先级：命令行第一个参数 > 环境变量 QODER_ELECTRON > %LOCALAPPDATA% 下的默认安装位置。
import os
import shutil

candidates = [
    sys.argv[1] if len(sys.argv) > 1 else None,
    os.environ.get("QODER_ELECTRON"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Qoder CN\Qoder CN.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Qoder CN\Qoder CN.exe"),
    shutil.which("electron"),
]
electron = next((c for c in candidates if c and os.path.exists(c)), None)
if not electron:
    print("找不到可用的 Electron 来当 Node 跑：把路径作为参数传进来，或设置 QODER_ELECTRON。")
    raise SystemExit(2)

proc = subprocess.run(
    [electron, "_dev/_ts_scores.mts"],
    capture_output=True, text=True, encoding="utf-8",
    env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"}, cwd=".",
)
if proc.returncode:
    print("TS 侧失败:", proc.stderr[-800:])
    raise SystemExit(1)
rows = [r for r in json.loads(proc.stdout) if "ts" in r]

# 2) 同一组数喂给 Python 引擎：只给三张表 + 让它自己算同比，规则子集差异就是唯一变量
sys.path.insert(0, ".")
import pandas as pd
from audit_agents import FinancialHealthAgent

diffs = []
per_company = {}
by_org = {}
for code in CODES:
    recs = sorted([r for r in rows if r["code"] == code], key=lambda x: x["year"])
    if len(recs) < 2:
        continue
    frame = pd.DataFrame({
        "年度": [r["year"] for r in recs],
        "营业收入": [r["rev"] for r in recs],
        "净利润": [r["np"] for r in recs],
        "经营现金流": [r["cf"] for r in recs],
    })
    for i in range(1, len(recs)):
        py = FinancialHealthAgent().analyze(frame.iloc[: i + 1], _with_change=False)["raw_health_score"]
        d = py - recs[i]["ts"]
        diffs.append(d)
        per_company.setdefault(code, []).append(d)
        # 金融类被豁免净现比，规则差值应当更小，分组看才知道“约 5 分”能不能一概而论
        by_org.setdefault("金融" if code in ("000001", "600036", "601318", "600000") else "实体", []).append(d)

diffs.sort()
n = len(diffs)
print(f"配对观测 n={n}（同公司同年、同一组数字）")
print(f"  差值(本地 - 线上) 中位数 {diffs[n // 2]:+.2f}  均值 {sum(diffs) / n:+.2f}")
print(f"  最小 {diffs[0]:+.2f}  最大 {diffs[-1]:+.2f}  |差值|≥10 的比例 {sum(1 for d in diffs if abs(d) >= 10) / n * 100:.1f}%")
print(f"  |差值|≥20 的比例 {sum(1 for d in diffs if abs(d) >= 20) / n * 100:.1f}%")
for org, arr in sorted(by_org.items()):
    arr = sorted(arr)
    print(f"  [{org}] n={len(arr)} 中位 {arr[len(arr) // 2]:+.2f} 范围 {arr[0]:+.2f} ~ {arr[-1]:+.2f}")
print("按公司（每家取差值范围）:")
for code, arr in sorted(per_company.items()):
    print(f"  {code}: {min(arr):+.2f} ~ {max(arr):+.2f}")
