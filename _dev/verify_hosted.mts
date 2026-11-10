import { analyzeFinancial, classifyDivergence } from "../functions/lib/agents.ts";
import { fetchFinancials, fetchIndustry } from "../functions/lib/eastmoney.ts";
import { bandGroupFor, percentileIn, REFERENCE } from "../functions/lib/reference_bands.ts";

const CODES = [
  ["600519", "贵州茅台"],
  ["000001", "平安银行"],
  ["000625", "长安汽车"],
  ["601318", "中国平安"],
  ["002594", "比亚迪"],
  ["600036", "招商银行"],
  ["300750", "宁德时代"],
  ["002415", "海康威视"],
  ["601088", "中国神华"],
  ["000333", "美的集团"],
  ["600030", "中信证券"],
  ["002230", "科大讯飞"],
];

console.log(
  `REFERENCE: companies=${REFERENCE.companies} obs=${REFERENCE.observations} ` +
    `change=${REFERENCE.change_observations} years=${REFERENCE.years?.join("-")} at=${REFERENCE.generated_at}`,
);
for (const [key, g] of Object.entries(REFERENCE.groups as Record<string, any>)) {
  console.log(`  group ${key} n=${g.n} change_n=${g.change_n} level p25=${g.level.find((p: any) => p[0] === 25)?.[1]}`);
}

// 分位表自检：值必须随百分位单调不减，否则 percentileIn 的插值会把高分读成低分位。
for (const [key, g] of Object.entries(REFERENCE.groups as Record<string, any>)) {
  for (const kind of ["level", "change"]) {
    const grid = g[kind] as [number, number][];
    for (let i = 1; i < grid.length; i++) {
      if (grid[i][1] < grid[i - 1][1]) {
        console.error(`MONOTONICITY FAIL ${key}.${kind} at ${i}: ${grid[i - 1][1]} -> ${grid[i][1]}`);
        process.exit(1);
      }
    }
  }
}
console.log("monotonicity: OK");

// 对照组：同一分数在「非行业」池（实体/金融→全市场）里的位置，用来看行业化到底改变了多少。
function locateMarketOnly(a: any) {
  const g = bandGroupFor(a.metrics.org_type);
  return {
    lp: percentileIn(a.raw_health_score, g.level),
    cp: a.change_score === null ? null : percentileIn(a.change_score, g.change),
  };
}

const industryCount = Object.keys((REFERENCE as any).industries ?? {}).length;
console.log(`行业带：${industryCount} 组可建带（门槛 n≥${(REFERENCE as any).min_industry_observations ?? "?"}）`);

for (const [code, name] of CODES) {
  const rows = await fetchFinancials(code);
  let industry = "";
  try {
    industry = await fetchIndustry(code);
  } catch {}
  const a = analyzeFinancial(rows, industry);
  // 同时给全市场带和行业带两个读数：降档动作必须看得见是从哪一级掉到哪一级。
  const marketBand = locateMarketOnly(a);
  const audit = classifyDivergence(70, a);
  const audit88 = classifyDivergence(88, a);
  console.log(
    `${code} ${name} 行业=${industry || "—"} year=${a.latest_year} raw=${a.raw_health_score.toFixed(2)} ` +
      `池=${a.band.group_label}(n=${a.band.group_n}) 水平${a.band.level_percentile} 变化${a.band.change_percentile} ` +
      `优质档=${a.band.quality_tier ? "是" : "否"} 毛利${a.band.quality?.gross_margin ?? "—"} 净利${a.band.quality?.net_margin ?? "—"} ` +
      `规模=${a.band.quality?.scale_band ?? "—"} | 70→${audit.grade}${audit.downgraded ? "(降档)" : ""} ` +
      `88→${audit88.grade}${audit88.downgraded ? "(降档)" : ""} | 全市场口径 水平${marketBand.lp} 变化${marketBand.cp}`,
  );
}

// 极端一致性：全市场最高分与最低分必须分别落在高/低百分位，不能因为组别回退而错位。
const sample = 0;
console.log("percentile spot checks:", [
  percentileIn(-999, bandGroupFor("通用").level),
  percentileIn(999, bandGroupFor("通用").level),
  percentileIn(-999, bandGroupFor("银行").level),
  percentileIn(999, bandGroupFor("保险").level),
]);
