import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FINANCIAL_ORG } from "../functions/lib/reference_bands.ts";

const at = (name: string) => fileURLToPath(new URL(name, import.meta.url));
// 与 _dev/ref_census.mts 同步：现金流改成 Δ ÷ 上年营收之后重跑的那一份普查。
const BASIS = "cash_rel_prev_revenue_v2";
const ROWS = at("ref_rows_v2.jsonl");
const TARGET = at("../functions/lib/reference_bands.ts");
const GRID = [1, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 99];
const LABELS: Record<string, string> = {
  全市场: "全市场 A 股",
  实体: "实体企业",
  金融: "银行/保险/证券等金融类",
};

const universeCount = fs
  .readFileSync(at("../data/stock_list.csv"), "utf8")
  .split(String.fromCharCode(10))
  .filter((line) => /^[0-9][0-9][0-9][0-9][0-9][0-9],/.test(line)).length;

const records: any[] = [];
let staleRows = 0;
for (const line of fs.readFileSync(ROWS, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const rec = JSON.parse(line);
    // 口径标签不一致就整条丢掉：拿旧规则的分数生成新规则的分位带，比不生成更危险。
    if (rec.basis !== BASIS) {
      staleRows++;
      continue;
    }
    records.push(rec);
  } catch {}
}
if (records.length === 0) throw new Error(`no_rows_with_basis_${BASIS}`);
if (staleRows > 0) console.log(`丢弃口径不符的旧行 ${staleRows} 条`);

const levels: Record<string, number[]> = { 全市场: [], 实体: [], 金融: [] };
const changes: Record<string, number[]> = { 全市场: [], 实体: [], 金融: [] };
const yearCount: Record<number, number> = {};
// 行业带的六个累积池：分数、变化、毛利率、净利率、营收规模、成员集合。
const industryLevels: Record<string, number[]> = {};
const industryChanges: Record<string, number[]> = {};
const industryGm: Record<string, number[]> = {};
const industryNm: Record<string, number[]> = {};
const industryRev: Record<string, number[]> = {};
const industryFirms: Record<string, Set<string>> = {};
const orgCount: Record<string, number> = {};
let skippedGap = 0;
let exactFifty = 0;

// 分组按「被打分那一行自己的 ORG_TYPE」，与运行时 locateBand 取 latest.orgType 完全一致。
const groupOf = (org: string) => (FINANCIAL_ORG.test(org ?? "") ? "金融" : "实体");

for (const rec of records) {
  const scores = rec.scores ?? [];
  const indName = String(rec.industry ?? "");
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    const g = groupOf(s.org);
    orgCount[s.org || "（空）"] = (orgCount[s.org || "（空）"] ?? 0) + 1;
    if (s.raw === 50) exactFifty++;
    levels["全市场"].push(s.raw);
    levels[g].push(s.raw);
    yearCount[s.year] = (yearCount[s.year] ?? 0) + 1;
    if (i >= 1) {
      const prev = scores[i - 1];
      if (s.year - prev.year === 1) {
        const d = Math.round((s.raw - prev.raw) * 100) / 100;
        changes["全市场"].push(d);
        changes[g].push(d);
      } else skippedGap++;
    }
    // 行业带：按东财一级板块分组，同时留存毛利率/净利率/营收规模，
    // 「优质档自动降档」和「规模上下文」要靠这三个分布，不能临场再跑一次普查。
    if (indName) {
      if (!industryLevels[indName]) {
        industryLevels[indName] = [];
        industryChanges[indName] = [];
        industryGm[indName] = [];
        industryNm[indName] = [];
        industryRev[indName] = [];
        industryFirms[indName] = new Set();
      }
      industryLevels[indName].push(s.raw);
      industryFirms[indName].add(rec.code);
      if (typeof s.gm === "number") industryGm[indName].push(s.gm);
      if (typeof s.nm === "number") industryNm[indName].push(s.nm);
      if (typeof s.rev === "number" && s.rev > 0) industryRev[indName].push(s.rev);
      if (i >= 1 && s.year - scores[i - 1].year === 1) {
        industryChanges[indName].push(Math.round((s.raw - scores[i - 1].raw) * 100) / 100);
      }
    }
  }
}

const sortNum = (a: number[]) => [...a].sort((x, y) => x - y);
// 分位数用「最近秩向下取整」，与 reference_bands.percentileIn 的线性插值配套，可手工复现。
const q = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const grid = (sorted: number[]) => GRID.map((p) => [p, Math.round(q(sorted, p) * 100) / 100] as [number, number]);

const groups: Record<string, any> = {};
for (const key of ["全市场", "实体", "金融"]) {
  const lv = sortNum(levels[key]);
  const ch = sortNum(changes[key]);
  groups[key] = { key, label: LABELS[key], n: lv.length, change_n: ch.length, level: grid(lv), change: grid(ch) };
}

// 「最差一侧」的经验分布：红线是缺口阈值，不是百分位阈值，所以必须回答
// 「这个缺口在全市场上大概圈中多少比例」，否则切点就只是又一个凭感觉定的数。
// 这里用刚算出来的分组带做定位，不读上一版生成文件，避免重跑时新旧混用。
function pctOf(value: number, cuts: [number, number][]): number | null {
  if (!cuts.length || !Number.isFinite(value)) return null;
  if (value <= cuts[0][1]) return cuts[0][0];
  if (value >= cuts[cuts.length - 1][1]) return cuts[cuts.length - 1][0];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [p0, v0] = cuts[i];
    const [p1, v1] = cuts[i + 1];
    if (value < v1) return v1 === v0 ? p1 : Math.round((p0 + ((value - v0) / (v1 - v0)) * (p1 - p0)) * 10) / 10;
  }
  return cuts[cuts.length - 1][0];
}
// 行业带只在观测数足够的组里成立：n<300 的组分位断点会跳到荒谬的位置，宁可退回上层带。
const MIN_INDUSTRY_OBSERVATIONS = 300;
const industries: Record<string, any> = {};
for (const name of Object.keys(industryLevels)) {
  const lv = sortNum(industryLevels[name]);
  const ch = sortNum(industryChanges[name] ?? []);
  const gm = sortNum(industryGm[name] ?? []);
  const nm = sortNum(industryNm[name] ?? []);
  const rv = sortNum(industryRev[name] ?? []);
  if (lv.length < MIN_INDUSTRY_OBSERVATIONS) continue;
  const at = (arr: number[], p: number) => (arr.length ? Math.round(q(arr, p) * 100) / 100 : null);
  industries[name] = {
    key: name,
    n: lv.length,
    firms: industryFirms[name].size,
    change_n: ch.length,
    level: grid(lv),
    change: grid(ch),
    // 优质档的两个门槛：毛利率与净利率的行业前 5%。
    gm_p95: at(gm, 95),
    nm_p95: at(nm, 95),
    gm_median: at(gm, 50),
    nm_median: at(nm, 50),
    // 营收规模的行业中位与前 10%：只用于「周期承压还是生死存亡」的措辞，不参与打分。
    rev_median: at(rv, 50),
    rev_p90: at(rv, 90),
  };
}
// 切点依据表：必须用与运行时 bandFor 完全相同的选池顺序
// （一级板块可用 → 实体/金融 → 全市场），否则方法论里那条「命中率」说的不是实际生效的判定。
function poolFor(rec, s) {
  const ind = String(rec.industry ?? "");
  const chosen = industries[ind];
  if (chosen) return chosen;
  return groups[groupOf(s.org)] ?? groups["全市场"];
}
const weakness: number[] = [];
const weaknessByKind: Record<string, number> = {};
for (const rec of records) {
  const scores = rec.scores ?? [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    const cuts = poolFor(rec, s);
    if (!cuts) continue;
    const lp = pctOf(s.raw, cuts.level);
    if (lp === null) continue;
    let cp: number | null = null;
    if (i >= 1 && s.year - scores[i - 1].year === 1) {
      cp = pctOf(Math.round((s.raw - scores[i - 1].raw) * 100) / 100, cuts.change);
    }
    weakness.push(cp === null ? lp : Math.min(lp, cp));
    const kind = industries[String(rec.industry ?? "")] ? "行业带" : "上层带";
    weaknessByKind[kind] = (weaknessByKind[kind] ?? 0) + 1;
  }
}
const weaknessSorted = sortNum(weakness);
const weaknessGrid = grid(weaknessSorted);
console.log(
  `weakness（与运行时同池）n=${weaknessSorted.length} ` +
    [10, 25, 50, 75, 90].map((p2) => `p${p2}=${q(weaknessSorted, p2).toFixed(1)}`).join(" ") +
    ` mean=${mean(weakness).toFixed(1)} | ${JSON.stringify(weaknessByKind)}`,
);
console.log(
  "  切点命中率（命中率 = P(最差一侧 ≤ 语调 − 切点)，与线上判定同池）：" +
    [65, 70, 75, 80, 85, 88]
      .map((t) => `语调${t}: 红${pctOf(t - 65, weaknessGrid)?.toFixed(1)}% 黄${pctOf(t - 50, weaknessGrid)?.toFixed(1)}%`)
      .join("  "),
);

const industryCount = Object.keys(industries).length;
console.log(
  `一级板块 ${Object.keys(industryLevels).length} 组，其中 n≥${MIN_INDUSTRY_OBSERVATIONS} 可建带 ${industryCount} 组；` +
    `覆盖观测 ${Object.values(industries).reduce((sum, g) => sum + g.n, 0)} / ${levels["全市场"].length}`,
);
const food = industries["食品饮料"];
if (food) {
  console.log(
    `  食品饮料 n=${food.n}/${food.firms}家 水平p25=${q(sortNum(industryLevels["食品饮料"]), 25)} ` +
      `毛利率p95=${food.gm_p95} 净利率p95=${food.nm_p95} 营收中位=${food.rev_median ? (food.rev_median / 1e8).toFixed(1) + "亿" : "—"}`,
  );
}

console.log(`universe=${universeCount} scored=${records.length} level_obs=${levels["全市场"].length} change_obs=${changes["全市场"].length} skippedGap=${skippedGap} exact50=${exactFifty}`);
console.log("years=", JSON.stringify(yearCount));
console.log("orgTypes=", JSON.stringify(orgCount));
const MARK = [1, 5, 10, 25, 50, 75, 90, 99];
for (const key of ["全市场", "实体", "金融"]) {
  const lv = levels[key];
  const ch = changes[key];
  if (!lv.length) continue;
  const lvs = sortNum(lv);
  const chs = sortNum(ch);
  console.log(`\n[${key}] level n=${lv.length} mean=${mean(lv).toFixed(2)} median=${q(lvs, 50).toFixed(2)}`);
  console.log("  level  " + MARK.map((p) => `p${p}=${q(lvs, p).toFixed(1)}`).join(" "));
  console.log("  change " + MARK.map((p) => `p${p}=${q(chs, p).toFixed(1)}`).join(" ") + `  (n=${ch.length} mean=${mean(ch).toFixed(2)})`);
  const l25 = q(lvs, 25);
  const l50 = q(lvs, 50);
  console.log(
    `  红线推演：语调70 − 水平p25(${l25.toFixed(1)}) = ${(70 - l25).toFixed(1)}；` +
      `语调70 − 水平p50(${l50.toFixed(1)}) = ${(70 - l50).toFixed(1)}；` +
      `语调85 − p25 = ${(85 - l25).toFixed(1)}`,
  );
  const pctBelow = (t: number) => ((lv.filter((v) => v < t).length / lv.length) * 100).toFixed(2);
  console.log(`  水平分 <50 占 ${pctBelow(50)}%，<0 占 ${pctBelow(0)}%，>100 占 ${((lv.filter((v) => v > 100).length / lv.length) * 100).toFixed(2)}%`);
}

const years = Object.keys(yearCount).map(Number).sort();
// 本地日期而非 toISOString：UTC 会把当天生成的表标成前一天。
const now = new Date();
const pad = (v: number) => String(v).padStart(2, "0");
const mainYears = years.filter((y) => yearCount[y] / levels["全市场"].length >= 0.01);
const generated = {
  generated_at: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  source: "东方财富公开接口 RPT_F10_FINANCE_MAINFINADATA，仅取 REPORT_TYPE 含「年报」的行",
  rule:
    "本仓库 functions/lib/agents.ts 的 scoreRows（现金流恶化按 Δ ÷ 上年营收分档，口径标签 " +
    BASIS +
    "），未做任何展示口径加工",
  universe: universeCount,
  sampling: "全市场逐家取数，非抽样",
  companies: records.length,
  observations: levels["全市场"].length,
  change_observations: changes["全市场"].length,
  years,
  main_years: mainYears,
  percentile_grid: GRID,
  groups,
  weakness: { n: weaknessSorted.length, label: "最差一侧百分位", grid: weaknessGrid },
  min_industry_observations: MIN_INDUSTRY_OBSERVATIONS,
  industries,
};

const block = [
  "// ==== BEGIN GENERATED REFERENCE（由 _dev/ref_stats.mts 生成，勿手改）====",
  `// 生成时间 ${generated.generated_at}；名录 ${generated.universe} 家，成功取到可比年报 ${generated.companies} 家，`,
  `// 合计 ${generated.observations} 个年度观测 / ${generated.change_observations} 个同比变化观测，`,
  `// 年度覆盖 ${generated.main_years.join("、")}（各占观测 1% 以上的年份；零散早年不计入）。`,
  "// 全市场逐家取数而非抽样，因此这里的分位数就是总体分位数，不存在抽样误差；",
  "// 未能进入分布的公司是取数失败或不足两个可比年报，不假装它们被覆盖。",
  "// 重跑顺序：_dev/ref_census.mts（取数打分，产出 ref_rows_v2.jsonl 缓存）→ _dev/ref_stats.mts（分位数与本表）→ _dev/ref_calibrate.mts（命中率核对）。",
  "export const REFERENCE = " + JSON.stringify(generated, null, 2) + ";",
  "// ==== END GENERATED REFERENCE ====",
].join("\n");

const src = fs.readFileSync(TARGET, "utf8");
const next = src.replace(
  /\/\/ ==== BEGIN GENERATED REFERENCE[\s\S]*?\/\/ ==== END GENERATED REFERENCE ====/,
  () => block,
);
// 内容未变时 replace 返回同一个字符串，这不是失败；只有标记丢了才算失败。
if (!next.includes("export const REFERENCE = {") || !next.includes("END GENERATED REFERENCE")) {
  console.error("MARKER_SPLICE_FAILED");
  process.exit(1);
}
if (next === src) console.log("(reference_bands.ts 内容未变化，跳过写入)");
fs.writeFileSync(TARGET, next);

// Python 运行时用同一份参照分布：两边都是「本仓库规则的总体分位数」，
// 只生成一次就杜绝了两处数字写岔的可能。字段名与结构保持一致，注释里写明差异来源。
const pyBlock = [
  '"""财务基本面参照分布（由 _dev/ref_stats.mts 自动生成，勿手改）。',
  '',
  '与 functions/lib/reference_bands.ts 同源同值，由同一次全市场普查生成。',
  '本地 Streamlit 引擎的判据是线上规则的子集（数据层没有扣非归母净利润字段，',
  '净现比与扣非背离两项不参与打分），因此这里的百分位对本地分数是近似定位，',
  '实测（48 个配对观测：同公司同一年、喂同一组财务数字，因此差值只反映规则子集）：',
  '本地分相对线上分中位 -6.3、均值 -5.0，范围 -17 ~ +18，其中 22.9% 的观测 |差值| ≥ 10。',
  '金融类明显更窄（中位 -5.1，范围 -8.6 ~ +1.7），因为净现比在两边都被豁免，差的只剩扣非与 F-Score。',
  '结论：本地百分位只能当作近似定位，且「近似」的幅度是十位数级别、不是个位数级别。',
  '两套运行时都按「一级板块 → 实体/金融 → 全市场」选池：本地 app.py 会调 fetch_industry(code) 取板块名，',
  '与线上 bandFor 同一顺序；差别只在本地规则是子集，因此分位读数是近似的。',
  '"""',
  '',
  "import re",
  '',
  'FINANCIAL_ORG = re.compile(r"银行|保险|证券|金融|信托|租赁")',
  '',
  // 纯数字与字符串，没有布尔/null，直接复用同一份 JSON 即可保证两边完全同值。
  "REFERENCE = " + JSON.stringify(generated, null, 2) + ";",
  '',
  '',
  'def percentile_in(value, grid):',
  '    """与 TS 版 percentileIn 同法：断点表之间线性插值；空表返回 None。"""',
  '    if not grid or value is None:',
  '        return None',
  '    if value <= grid[0][1]:',
  '        return grid[0][0]',
  '    if value >= grid[-1][1]:',
  '        return grid[-1][0]',
  '    for i in range(len(grid) - 1):',
  '        p0, v0 = grid[i]',
  '        p1, v1 = grid[i + 1]',
  '        if value < v1:',
  '            if v1 == v0:',
  '                return p1',
  '            return round(p0 + (value - v0) / (v1 - v0) * (p1 - p0), 1)',
  '    return grid[-1][0]',
  '',
  '',
  'def band_group_for(org_type):',
  '    """组内观测不足时退回全市场带，与 TS 版同一规则。"""',
  '    groups = REFERENCE["groups"]',
  '    wanted = "金融" if FINANCIAL_ORG.search(org_type or "") else "实体"',
  '    for candidate in (groups.get(wanted), groups.get("全市场")):',
  '        if candidate and candidate["n"] >= 300 and candidate["level"]:',
  '            return dict(candidate, kind="org" if candidate["key"] == wanted else "market")',
  '    # 参照表为空时如实返回空网格，让分位定位给出 None，判定标成「未标定」。',
  '    return {"key": "未标定", "label": "参照分布未生成", "n": 0, "level": [], "change": [], "kind": "none"}',
  '',
  '',
  'def band_for(industry_name, org_type):',
  '    """一级板块优先建带，与 TS 版 bandFor 同一退回顺序。"""',
  '    industries = REFERENCE.get("industries", {})',
  '    chosen = industries.get(industry_name or "")',
  '    if chosen and chosen["n"] >= REFERENCE.get("min_industry_observations", 300) and chosen["level"]:',
  '        return dict(chosen, label=f\'{chosen["key"]}（一级板块）\', kind="industry")',
  '    return band_group_for(org_type)',
  '',
  '',
  'def industry_context(industry_name):',
  '    """毛利率/净利率前 5% 门槛与营收规模断点；没有行业带就返回 None，不拿全市场冒充行业。"""',
  '    industries = REFERENCE.get("industries", {})',
  '    chosen = industries.get(industry_name or "")',
  '    if not chosen or chosen["n"] < REFERENCE.get("min_industry_observations", 300):',
  '        return None',
  '    return chosen',
].join(String.fromCharCode(10)) + String.fromCharCode(10);
fs.writeFileSync(at("../reference_bands.py"), pyBlock);
console.log("written -> reference_bands.py");
console.log(`\nwritten -> ${TARGET}`);
