import { completeJson } from "./dashscope.ts";
import {
  TEXT_SENTIMENT_SYSTEM_PROMPT,
  TEXT_SENTIMENT_USER_PROMPT,
  LEADER_SYSTEM_PROMPT,
  LEADER_USER_PROMPT,
  FACT_REVIEW_SYSTEM_PROMPT,
  FACT_REVIEW_USER_PROMPT,
} from "./prompts.ts";
import type { FinancialRow } from "./eastmoney.ts";
import { bandFor, industryContext, percentileIn, REFERENCE } from "./reference_bands.ts";

const pct = (v: number | null) => (v === null ? "缺失" : `${(v * 100).toFixed(2)}%`);
const amount = (v: number | null) => (v === null ? "缺失" : `${(v / 1e8).toFixed(2)} 亿元`);

const ratio = (v: number | null) => (v === null ? "缺失" : `${v.toFixed(2)} 倍`);

// 现金流恶化计分的绝对额下限（元）：变动不足 0.2 亿既不扣分也不进异常列表。
export const CASH_DEDUCTION_FLOOR = 0.2e8;

// 带符号的绝对额，用于展示「基期 → 本期」。
const signed = (v: number) => `${v < 0 ? "-" : "+"}${(Math.abs(v) / 1e8).toFixed(2)} 亿元`;
const magnitude = (v: number) => `${(Math.abs(v) / 1e8).toFixed(2)} 亿元`;

// 同比增速的分母是基期绝对值：基期接近 0 或基期与本期异号时，它不是「增长率」而是比值
// （-469.59% 的字面意思是本期负值 = 基期正值 × 5.7），读的人会当成跌幅理解，方向都是错的。
// 所以这两种情况一律退回绝对额表述，百分比只放在括号里做辅助。
function declineText(metric: string, prev: number | null, current: number | null, yoy: number | null) {
  if (prev === null || current === null || yoy === null) return `${metric}同比下降（基期绝对额缺失）`;
  if (prev > 0 && current < 0)
    return `${metric}由正转负：${signed(prev)} → ${signed(current)}（变动 ${signed(current - prev)}）`;
  if (Math.abs(yoy) > 1)
    return `${metric}减少 ${magnitude(current - prev)}（同比 ${pct(yoy)}，基期 ${signed(prev)} → 本期 ${signed(current)}）`;
  return `${metric}同比下降 ${pct(yoy)}`;
}

// 证据行与给模型看的年度表用的短格式同比，同样避开溢出与异号两种退化情形。
function yoyNote(prev: number | null, current: number | null, yoy: number | null) {
  if (yoy === null) return "同比 缺失";
  if (prev !== null && current !== null && prev * current < 0)
    return `同比${prev > 0 ? "由正转负" : "由负转正"}（${signed(prev)} → ${signed(current)}）`;
  if (Math.abs(yoy) > 1 && prev !== null && current !== null)
    return `同比变动 ${signed(current - prev)}（增速 ${pct(yoy)}，基期仅 ${signed(prev)}）`;
  return `同比 ${pct(yoy)}`;
}

// Piotroski F-Score 九项：与 data_processing.calculate_piotroski_f_score 同一判据，
// 缺数据或无法同比比较的项记为“不适用”，不计入有效项，避免银行/券商被强制项拖低。
function computeFScore(latest: FinancialRow, previous: FinancialRow | null) {
  const items: { name: string; result: boolean | null }[] = [];
  const add = (name: string, ok: boolean | null) => items.push({ name, result: ok });
  const cmp = (
    a: number | null,
    b: number | null,
    fn: (x: number, y: number) => boolean,
  ): boolean | null => (a === null || b === null ? null : fn(a, b));

  add("盈利（ROA 为正）", cmp(latest.roa, 0, (a, b) => a > b));
  add("经营现金流为正", latest.operatingCashflow === null ? null : latest.operatingCashflow > 0);
  add("ROA 同比改善", previous ? cmp(latest.roa, previous.roa, (a, b) => a > b) : null);
  add(
    "现金流不低于净利润",
    cmp(latest.operatingCashflow, latest.netProfit, (a, b) => a > b),
  );
  add("负债率同比下降", previous ? cmp(latest.debtRatio, previous.debtRatio, (a, b) => a < b) : null);
  add("流动比率改善", previous ? cmp(latest.currentRatio, previous.currentRatio, (a, b) => a > b) : null);
  add("股本未被摊薄", previous ? cmp(latest.shareCapital, previous.shareCapital, (a, b) => a <= b) : null);
  add("毛利率改善", previous ? cmp(latest.grossMargin, previous.grossMargin, (a, b) => a > b) : null);
  add(
    "总资产周转率改善",
    previous ? cmp(latest.assetTurnover, previous.assetTurnover, (a, b) => a > b) : null,
  );

  const validItems = items.filter((item) => item.result !== null);
  const fScore = validItems.filter((item) => item.result).length;
  return { items, validCount: validItems.length, fScore };
}

// 打分内核：只做「这一组年度行对应的财务水平原始分」这一件事，不做任何展示口径。
// analyzeFinancial 与「上一年同口径分」都走这里，保证同比变化项两端可比。
function scoreRows(rows: FinancialRow[]) {
  const latest = rows[rows.length - 1];
  const previous = rows.length >= 2 ? rows[rows.length - 2] : null;
  const revenueYoY = latest.revenueYoY;
  const profitYoY = latest.netProfitYoY;
  const cashflowYoY = latest.cashflowYoY ?? null;
  const cashflow = latest.operatingCashflow ?? null;
  const profit = latest.netProfit;

  let score = 80;
  const abnormalities: string[] = [];
  if (revenueYoY !== null) {
    if (revenueYoY < 0) {
      score -= revenueYoY <= -0.2 ? 35 : revenueYoY <= -0.1 ? 25 : 10;
      abnormalities.push(declineText("营业收入", previous?.revenue ?? null, latest.revenue, revenueYoY));
    } else score += 5;
  }
  if (profitYoY !== null) {
    if (profitYoY < 0) {
      score -= profitYoY <= -0.3 ? 40 : profitYoY <= -0.1 ? 25 : 15;
      abnormalities.push(declineText("归母净利润", previous?.netProfit ?? null, profit, profitYoY));
    } else score += 5;
  }
  if (revenueYoY !== null && revenueYoY > 0 && profitYoY !== null && profitYoY < 0) {
    score -= 10;
    abnormalities.push("营业收入增长但净利润下降，存在增收不增利");
  }

  // 现金流维度（与 Streamlit 版 audit_agents.FinancialHealthAgent 同一套判据）。
  //
  // 恶化幅度用 Δ ÷ 营业收入，而不是 Δ ÷ 基期现金流：后者的分母自己就是那个正在塌的数，
  // 基期 +0.03 亿 → 本期 −0.51 亿会报出 −1706%，可它相对 4.25 亿营收只是 12.8% 的缺口。
  // 换成营收做分母后有界、基期为 0 也不发散；0.2 亿的绝对额下限再滤掉「比例大、金额可忽略」的
  // 小基数噪声（200 家实测样本里只挡住 1 家 mild 档，0.5 亿则会吞掉两家真实的前 15% 缺口）。
  const prevCash = previous?.operatingCashflow ?? null;
  const cashDelta = cashflow !== null && prevCash !== null ? cashflow - prevCash : null;
  // 分母用「产生这笔基期现金的那年营收」，不是本期营收：营收自己也在塌的时候，
  // 用本期营收会把同一次下滑计两次（晶升 2025 营收 −72.8%，同样 −0.54 亿的现金缺口
  // 会被读成营收的 47% 而不是 12.7%）。−5% / −15% 两档也是在基期营收口径上实测出来的。
  const cashRelBase = previous?.revenue ?? latest.revenue ?? null;
  const cashRel = cashDelta !== null && cashRelBase !== null && cashRelBase > 0 ? cashDelta / cashRelBase : null;
  // 「下滑了」看方向，「下滑得算数」看绝对额：两者分开，噪声才不会既进分数又进证据列表。
  const cashMaterial = cashDelta !== null && cashDelta <= -CASH_DEDUCTION_FLOOR;
  if (cashflowYoY !== null) {
    if (cashflowYoY < 0) {
      let deduction = 0;
      if (cashMaterial) {
        // 营收基数取不到时退回旧口径，不留一个无声的「不扣分」。
        deduction =
          cashRel !== null
            ? cashRel <= -0.15
              ? 20
              : cashRel <= -0.05
                ? 10
                : 0
            : cashflowYoY <= -0.2
              ? 20
              : 10;
      }
      score -= deduction;
      if (deduction > 0) {
        // 把新的分母（Δ ÷ 上年营收）直接写进异常条目，判分依据在界面上就可核对，不用回去读代码。
        const share =
          cashRel !== null && cashRel < 0 ? `；缺口相当于上年营收的 ${(-cashRel * 100).toFixed(1)}%` : "";
        abnormalities.push(declineText("经营现金流", prevCash, cashflow, cashflowYoY) + share);
      }
    } else if (cashflow !== null && cashflow > 0) {
      score += 5;
    }
  }
  if (cashflow !== null && cashflow < 0) {
    score -= 25;
    abnormalities.push("经营活动现金流净额为负");
  }
  if (profit !== null && profit > 0 && cashflow !== null && cashflow < 0) {
    score -= 15;
    abnormalities.push(
      profitYoY !== null && profitYoY > 0
        ? "净利润同比上升，但经营现金流为负，利润与现金流背离"
        : "净利润为正，但经营现金流为负，利润含金量需核查",
    );
  }
  if (
    profitYoY !== null && profitYoY > 0 &&
    cashflowYoY !== null && cashflowYoY < 0 && cashMaterial &&
    (cashflow === null || cashflow >= 0)
  ) {
    score -= 10;
    abnormalities.push("净利润同比上升，但经营现金流同比下降");
  }
  if (revenueYoY !== null && revenueYoY < 0 && cashflowYoY !== null && cashflowYoY > 0) {
    abnormalities.push("营业收入下降但经营现金流上升，需核查回款和营运资本变化");
  }

  // 净现比：经营现金流 / 归母净利润，衡量账面利润的现金支撑强度。
  // 银行/保险/证券的经营现金流被客户存贷款与同业往来主导，该比率无经济含义，不做加减分。
  const isFinancial = /银行|保险|证券/.test(latest.orgType ?? "");
  const cashToProfit =
    profit !== null && profit > 0 && cashflow !== null ? cashflow / profit : null;
  if (!isFinancial && cashToProfit !== null) {
    if (cashToProfit < 1) {
      score -= cashToProfit < 0.5 ? 12 : cashToProfit < 0.8 ? 6 : 3;
      abnormalities.push(
        `经营现金流仅为归母净利润的 ${pct(cashToProfit)}（净现比 ${cashToProfit.toFixed(2)} 倍），账面利润尚未转化为等额现金`,
      );
    } else {
      score += 5;
    }
  }

  // 扣非背离：非经常性损益撑起利润时，主营盈利的可持续性需要核查。
  const deducted = latest.deductedNetProfit ?? null;
  if (profit !== null && profit > 0 && deducted !== null && deducted < profit * 0.7) {
    score -= 8;
    abnormalities.push(
      `归母净利润 ${amount(profit)} 而扣非归母净利润仅 ${amount(deducted)}，非经常性损益贡献 ${(
        ((profit - deducted) / profit) *
        100
      ).toFixed(1)}%`,
    );
  }

  const fscore = computeFScore(latest, previous);
  if (fscore.validCount >= 5) {
    const delta = Math.max(-12, Math.min(12, ((fscore.fScore - fscore.validCount / 2) * 24) / fscore.validCount));
    score += delta;
    if (fscore.fScore <= 2) {
      abnormalities.push(
        `Piotroski F-Score 仅 ${fscore.fScore}/${fscore.validCount}，盈利、杠杆与周转多项恶化`,
      );
    } else if (fscore.fScore >= 7) {
      abnormalities.push(`Piotroski F-Score ${fscore.fScore}/${fscore.validCount}，财务基本面指标普遍改善`);
    }
  }

  if (revenueYoY === null && profitYoY === null && cashflowYoY === null) {
    score = 50;
    abnormalities.push("缺少可计算同比增速的上一年度数据");
  }

  const raw = Math.round(score * 100) / 100;
  return {
    raw,
    abnormalities,
    latest,
    previous,
    fscore,
    cashToProfit,
    isFinancial,
    deducted,
    revenueYoY,
    profitYoY,
    cashflowYoY,
    cashflow,
    profit,
  };
}

// 分位定位：把「今年算出多少分」翻译成「在同类公司里排第几」，把「比去年多了几分」
// 翻译成「这个变化幅度在同类样本里算不算异常」。这一步是分位带唯一的量化来源，
// 判定不引用任何外部指数的绝对分。
// 池子按「一级板块 → 实体/金融 → 全市场」依次退回，并如实记录最终用的是哪一层。
export function locateBand(level: number, change: number | null, orgType: string, industry = "") {
  const group = bandFor(industry, orgType);
  const ctx = industryContext(industry);
  return {
    level_percentile: percentileIn(level, group.level),
    change_percentile: change === null ? null : percentileIn(change, group.change),
    group_key: group.key,
    group_label: group.label,
    group_kind: group.kind,
    group_n: group.n,
    industry: industry || "",
    reference_generated_at: REFERENCE.generated_at,
    // 行业和规模上下文只在真有行业带时给出；取不到就一律 null，不拿全市场分布冒充「行业前 5%」。
    context: ctx
      ? {
          gm_p95: ctx.gm_p95,
          nm_p95: ctx.nm_p95,
          gm_median: ctx.gm_median,
          nm_median: ctx.nm_median,
          rev_median: ctx.rev_median,
          rev_p90: ctx.rev_p90,
          firms: ctx.firms,
        }
      : null,
  };
}

// 优质档：毛利率与净利率「同时」处于行业前 5%。
// 两个都要满足，是因为只看一个会被单季波动带偏；且必须同池比较——
// 银行的高净利率和白酒的高净利率不是同一件事。
function qualityTier(band: any, grossMargin: number | null, netMargin: number | null) {
  const ctx = band?.context;
  if (!ctx || grossMargin === null || netMargin === null) return false;
  if (ctx.gm_p95 === null || ctx.nm_p95 === null) return false;
  return grossMargin >= ctx.gm_p95 && netMargin >= ctx.nm_p95;
}

// 背离度 = 语调虚高指数 − 财务基本面「最差一侧」的百分位。
//
// 为什么减百分位而不是原始分：全市场普查测出水平原始分的 p1–p99 跨 163.7 分（−51.7 ~ 112.0），
// 而语调指数实际只在中高段走动。两个量纲相差一个数量级的数相减，差值的方差几乎全来自财务侧，
// 「背离度」会退化成财务分的负数镜像，语调高不高已经无所谓——那就不是背离判定，只是换了个符号的财务分。
// 换成百分位后两侧同为 0–100，差值才真的表示「表述相对基本面的超出量」。
//
// 为什么取 min(水平, 变化)：被掩饰的既可能是「本来就差」，也可能是「水平仍高但正在下滑」；
// 只看水平会漏掉后者，而后者正是年报语调操纵里最常见的一种。
export const DIVERGENCE_RED = 65;
export const DIVERGENCE_AMBER = 50;
// 「偏弱 / 恶化」是参照分布后四分位的描述性标签，用于解释结论，不再单独充当判定条件。
export const BAND_BOTTOM = 25;

export function classifyDivergence(sentimentScore: number, financial: any) {
  const band = financial?.band ?? null;
  const levelPct = band && typeof band.level_percentile === "number" ? band.level_percentile : null;
  const changePct = band && typeof band.change_percentile === "number" ? band.change_percentile : null;

  if (levelPct === null) {
    return {
      divergence: null,
      grade: "uncalibrated",
      weak: false,
      deteriorating: false,
      level_percentile: null,
      change_percentile: null,
      weakness_percentile: null,
      reasons: ["参照分布未能定位该分数，本轮不给出分档结论，避免用未标定的阈值冒充判定。"],
    };
  }

  const weaknessPct = changePct === null ? levelPct : Math.min(levelPct, changePct);
  const divergence = Math.round((sentimentScore - weaknessPct) * 100) / 100;
  const weak = levelPct <= BAND_BOTTOM;
  const deteriorating = changePct !== null && changePct <= BAND_BOTTOM;
  const reasons: string[] = [
    `背离度 ${divergence.toFixed(2)} = 语调虚高指数 ${sentimentScore.toFixed(2)} − 财务最差一侧第 ${weaknessPct.toFixed(1)} 百分位` +
      `（水平第 ${levelPct.toFixed(1)}${changePct === null ? "，无可比同比" : ` / 同比变化第 ${changePct.toFixed(1)}`}），` +
      `定位池：${band.group_label}（组内 ${band.group_n} 个观测）`,
  ];
  if (weak) reasons.push(`水平分落在参照分布后四分之一（第 ${levelPct.toFixed(1)} 百分位）`);
  if (deteriorating) reasons.push(`同比变化落在后四分之一（第 ${changePct!.toFixed(1)} 百分位），基本面正在恶化`);

  // divergence ≥ 65 本身已隐含「最差一侧 ≤ 35」（语调上限 100），所以判定只需要这一个缺口条件。
  let grade: string = divergence >= DIVERGENCE_RED ? "red" : divergence >= DIVERGENCE_AMBER ? "amber" : "green";

  // 优质档降档：毛利率与净利率同时处于行业前 5% 时，预警级别下调一档。
  // 这条规则改的是「级别」而不是「分数」——分数照旧，降档动作与理由都留痕，
  // 否则读者看到的只是一个被悄悄调柔的结论。
  const qualityTier = band.quality_tier === true;
  const quality = band.quality ?? null;
  let downgraded = false;
  if (qualityTier && grade !== "green") {
    const next = grade === "red" ? "amber" : "green";
    reasons.push(
      `优质档降档：毛利率 ${quality?.gross_margin?.toFixed?.(2) ?? "—"}% 与净利率 ` +
        `${quality?.net_margin?.toFixed?.(2) ?? "—"}% 同时处于行业前 5%` +
        `（门槛 ${band.context?.gm_p95 ?? "—"}% / ${band.context?.nm_p95 ?? "—"}%），` +
        `${grade} → ${next}。表述仍需核查的是「把周期性失速讲成稳健增长」，而非盈利质量本身。`,
    );
    if (quality?.scale_band) reasons.push(`营收规模：${quality.scale_band}`);
    grade = next;
    downgraded = true;
  }
  return {
    divergence,
    grade,
    raw_grade: downgraded ? (divergence >= DIVERGENCE_RED ? "red" : "amber") : grade,
    downgraded,
    weak,
    deteriorating,
    quality_tier: qualityTier,
    level_percentile: levelPct,
    change_percentile: changePct,
    weakness_percentile: weaknessPct,
    band_group: band.group_label,
    band_kind: band.group_kind,
    reasons,
  };
}

export function analyzeFinancial(rows: FinancialRow[], industry = "") {
  if (rows.length === 0) throw new Error("no_financial_rows");
  const cur = scoreRows(rows);
  const {
    latest, previous, abnormalities, fscore, cashToProfit, isFinancial, deducted,
    revenueYoY, profitYoY, cashflowYoY, cashflow, profit,
  } = cur;

  // 原始分保留负值与超 100 的部分，截断只用于显示；分位数一律在原始分上算，
  // 否则「最该出信号」的两端会并成同一个点，参照分布失去区分度。
  const raw_health_score = cur.raw;
  const health_score = Math.round(Math.max(0, Math.min(100, raw_health_score)) * 100) / 100;
  const saturation =
    raw_health_score < 0
      ? `原始分 ${raw_health_score.toFixed(2)}，已触及 0 下限`
      : raw_health_score > 100
        ? `原始分 ${raw_health_score.toFixed(2)}，已触及 100 上限`
        : "";

  // 同比变化分：同一套规则、同一个滚动窗口，只把最后一年换成上一年。
  // 少于三行就没有「上一年的同口径分」可算，宁缺毋滥，不用 50 分兜底冒充中性。
  // 「同比」还必须真的是相邻年度：中间缺年报时两行之差可能是两年的累计变化，
  // 拿它当恶化信号会把两年慢跌读成一年急跌。
  const prevRow = rows.length >= 3 ? rows[rows.length - 2] : null;
  const previousLevel =
    prevRow && latest.year - prevRow.year === 1 ? scoreRows(rows.slice(0, rows.length - 1)).raw : null;
  const change_score = previousLevel === null ? null : Math.round((raw_health_score - previousLevel) * 100) / 100;

  const band = locateBand(raw_health_score, change_score, latest.orgType ?? "", industry);
  band.quality_tier = qualityTier(band, latest.grossMargin ?? null, latest.netMargin ?? null);
  // 规模只进上下文，不进分数：营收在行业里的位置决定「周期承压」还是「生死存亡」的说法，
  // 但不改变扣分——否则等于给大公司加分，那已经不是背离检测了。
  // 只报「行业前 10% / 中位以上 / 中位以下」三档实测位置：手上有的是两个断点，
  // 拿两点拼一条伪分位曲线算出来的百分位数没有依据，不如不写。
  band.quality = {
    gross_margin: latest.grossMargin ?? null,
    net_margin: latest.netMargin ?? null,
    revenue: latest.revenue ?? null,
    scale_band:
      band.context == null || latest.revenue == null
        ? null
        : latest.revenue >= (band.context.rev_p90 ?? Infinity)
          ? "行业前10%"
          : latest.revenue >= (band.context.rev_median ?? Infinity)
            ? "行业中位以上"
            : "行业中位以下",
  };
  // 水平分档改由参照分布的分位数决定，不再用「50 以下算较差」这种没有实测依据的切点。
  // 分位数取不到时必须明说「未标定」：null >= 75 与 null >= 25 都是 false，
  // 不加这一分支就会把所有拿不到参照的样本一律读成「偏弱」，等于凭空造出一个结论。
  const levelPct = band.level_percentile;
  const health_level =
    levelPct === null ? "未标定" : levelPct >= 75 ? "优于多数" : levelPct >= 25 ? "居中" : "偏弱";
  const is_poor = levelPct !== null && levelPct <= 25;

  const evidence =
    `财务指标第${rows.length}行（${latest.year}年度）：` +
    `营业收入 ${amount(latest.revenue)}，${yoyNote(previous?.revenue ?? null, latest.revenue, revenueYoY)}；` +
    `归母净利润 ${amount(profit)}，${yoyNote(previous?.netProfit ?? null, profit, profitYoY)}；` +
    `经营现金流 ${amount(cashflow)}，${yoyNote(previous?.operatingCashflow ?? null, cashflow, cashflowYoY)}，净现比 ${ratio(cashToProfit)}${
      isFinancial ? "（金融类企业仅供参考，不计入评分）" : ""
    }；` +
    `扣非归母净利润 ${amount(deducted)}；Piotroski F-Score ${fscore.fScore}/${fscore.validCount}` +
    (saturation ? `；财务基本面水平分 ${health_score.toFixed(2)}（${saturation}）` : "");
  return {
    health_score,
    raw_health_score,
    health_saturated: saturation !== "",
    health_level,
    is_poor,
    change_score,
    band,
    latest_year: latest.year,
    abnormalities,
    evidence_links: [evidence],
    metrics: {
      revenue: latest.revenue,
      net_profit: profit,
      operating_cashflow: cashflow,
      deducted_net_profit: deducted,
      revenue_yoy: revenueYoY,
      net_profit_yoy: profitYoY,
      cashflow_yoy: cashflowYoY,
      cash_to_profit: cashToProfit,
      cash_to_profit_applicable: !isFinancial,
      org_type: latest.orgType ?? "",
      roa: latest.roa,
      debt_ratio: latest.debtRatio,
      current_ratio: latest.currentRatio,
      gross_margin: latest.grossMargin,
      asset_turnover: latest.assetTurnover,
    },
    f_score: { total: fscore.fScore, valid: fscore.validCount, items: fscore.items },
  };
}

// 论点引用的段号解析：模型会写「第5段」「第5-8段」「第5、7段」，一律拆成逐个段号。
// 段号本身是连续的，所以「第8段至第25段」这种两个独立引用的写法验端点就够；
// 需要把区间逐个展开的是「第1-99999段」这种把整段范围塞进一个引用的写法——
// 展开时截到 50 个并保留末端点，保证它一定越界暴露，而不是靠只验端点蒙混过关。
const PARAGRAPH_CITATION = /第\s*(\d+(?:\s*[-–—~至、,，]\s*\d+)*)\s*段/g;

export function citedParagraphs(text: string): number[] {
  const out: number[] = [];
  for (const match of String(text ?? "").matchAll(PARAGRAPH_CITATION)) {
    for (const part of match[1].split(/[、,，]/)) {
      const nums = part.split(/[-–—~至]/).map((v) => Number(v.trim()));
      if (nums.length === 1 && Number.isFinite(nums[0])) out.push(nums[0]);
      else if (nums.length === 2 && nums.every(Number.isFinite)) {
        const [from, to] = [Math.min(...nums), Math.max(...nums)];
        // 区间上限截断：防止「第1-99999段」这类写法把校验变成形式。
        for (let value = from; value <= Math.min(to, from + 50); value++) out.push(value);
        if (to > from + 50) out.push(to);
      }
    }
  }
  return out;
}

export async function analyzeSentiment(mda: string) {
  const paragraphs = mda.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (paragraphs.length === 0) throw new Error("empty_mda");
  const numbered = paragraphs.map((t, i) => `第${i + 1}段：${t}`);
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const p of numbered) {
    const ps = p.length + 1;
    if (current.length && size + ps > 12000) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += ps;
  }
  if (current.length) chunks.push(current);

  // 语调分必须可复现：同一份 MD&A 单跑实测会抖 ±1.9，而判定用的是缺口阈值，
  // 长安 2024 正好压在档位边界上（语调 70→amber、78→red），抖动会直接翻转结论。
  // 所以每块独立跑两遍，分别加权成「整篇分 A / B」，取中位数作为最终分，
  // 并把 A、B 之差如实带出去——分数不可复现时，读者有权知道差多少。
  // 并发从 4 提到 8：两遍 × 通常 3 块 = 6 路，一波就能打完，墙钟时间与单跑同量级。
  const PASSES = 2;
  const UNSTABLE_CHUNK_GAP = 5;
  const jobs: { text: string; weight: number }[] = [];
  for (const chunk of chunks) {
    const text = chunk.join("\n");
    for (let pass = 0; pass < PASSES; pass++) jobs.push({ text, weight: Math.max(1, text.length) });
  }

  const scored: { score: number; weight: number; claims: string[] }[] = [];
  const concurrency = 8;
  for (let start = 0; start < jobs.length; start += concurrency) {
    const batch = jobs.slice(start, start + concurrency);
    const settled = await Promise.all(
      batch.map(async (job) => {
        const resp = await completeJson(
          "qwen-plus",
          TEXT_SENTIMENT_SYSTEM_PROMPT,
          TEXT_SENTIMENT_USER_PROMPT(job.text),
        );
        const score = Number(resp.sentiment_score);
        if (!Number.isFinite(score)) throw new Error("llm_invalid_score");
        return { score, weight: job.weight, claims: (resp.key_claims ?? []).map(String) };
      }),
    );
    // Promise.all 保序，逐批追加后 scored 仍是「块1两遍、块2两遍…」的文档顺序，
    // 两遍的加权与论点合并都可复现。
    scored.push(...settled);
  }

  let weightSum = 0;
  let passA = 0;
  let passB = 0;
  let pairedChunks = 0;
  let unstableChunks = 0;
  const paragraphCount = paragraphs.length;
  // 论点带上它来自第几块、第几遍、块内名次。提示词只承诺「块内按重要性排序」，
  // 跨块的名次不可比——所以只能按名次轮转取，不能假装存在一个全局重要性刻度。
  const candidates: { text: string; chunk: number; pass: number; rank: number; cited: number[] }[] = [];
  let rejected = 0;
  for (let i = 0; i < chunks.length; i++) {
    const first = scored[i * PASSES];
    const second = scored[i * PASSES + 1];
    if (!first || !second) continue;
    weightSum += first.weight;
    passA += first.score * first.weight;
    passB += second.score * second.weight;
    pairedChunks++;
    if (Math.abs(first.score - second.score) > UNSTABLE_CHUNK_GAP) unstableChunks++;
    [first, second].forEach((item, passIndex) => {
      item.claims.forEach((raw, rank) => {
        const text = raw.trim();
        if (!text) return;
        const cited = citedParagraphs(text);
        if (cited.length && !cited.every((n) => n >= 1 && n <= paragraphCount)) {
          // 引用了不存在的段号即为编造：剔除，而不是留下点不动的死链接。
          rejected++;
          return;
        }
        candidates.push({ text, chunk: i, pass: passIndex, rank, cited });
      });
    });
  }
  if (weightSum === 0) throw new Error("llm_no_scored_chunks");

  // 全部显示，不再截断：既然不删条目，「按名次轮转入围」就没有存在的理由了。
  // 顺序改为按 MD&A 原文位置分组排列（同一文本块内保持模型给的名次），
  // 这样读者可以顺着年报往下逐条核对，而不是对着一个凭空构造的全局重要性序列。
  // 去重规则保留：引用段号有交集即视为同一条变化——两遍独立打分常把同一段落换个说法报两次，
  // 不去重的话列表会成倍变长而信息量不变。保留先出现的那条（即第一遍的表述）。
  const picked: typeof candidates = [];
  const seenText = new Set<string>();
  let folded = 0;
  for (const cand of candidates) {
    if (seenText.has(cand.text)) {
      folded++;
      continue;
    }
    if (cand.cited.length && picked.some((p) => p.cited.some((n) => cand.cited.includes(n)))) {
      folded++;
      continue;
    }
    seenText.add(cand.text);
    picked.push(cand);
  }
  const claims = picked.map((c) => c.text);

  const scores = [Math.round((passA / weightSum) * 100) / 100, Math.round((passB / weightSum) * 100) / 100];
  // 两遍都成功才算共识分；只有一遍的块不参与配对，直接如实报 runs=1。
  const runs = pairedChunks === chunks.length ? PASSES : 1;
  const sentiment_score =
    runs === PASSES ? Math.round(((scores[0] + scores[1]) / 2) * 100) / 100 : scores[0];
  return {
    sentiment_score,
    key_claims: claims,
    runs,
    chunks: chunks.length,
    pass_scores: runs === PASSES ? scores : [scores[0]],
    score_spread: runs === PASSES ? Math.round(Math.abs(scores[0] - scores[1]) * 100) / 100 : null,
    unstable_chunks: unstableChunks,
    // 三个计数都必须交给前端：证据栏悄悄合并了几条、剔除几条、几条跳不动，
    // 读者看到的「证据」就是残缺的，而且看不出来残缺。
    claims_rejected: rejected,
    claims_folded: folded,
    paragraph_count: paragraphCount,
  };
}

export async function analyzeLeader(sentiment: any, financial: any, facts: any = null) {
  // 主轴是「表述与基本面的缺口」，不是语调单点是否过某个固定阈值。
  const audit = classifyDivergence(Number(sentiment.sentiment_score), financial);
  const mandatory = audit.grade === "red";
  const agentResults = JSON.stringify({
    text_agent: sentiment,
    financial_agent: financial,
    // 第三个 Agent 的结论只校准措辞与证据引用；红线判定仍以背离度 + 财务分位为准。
    fact_check_agent: facts ?? { findings: [], conflicts: [], note: "事实核对未完成或不可用" },
    divergence_audit: audit,
    mandatory_anomaly: mandatory,
  });
  const resp = await completeJson("qwen-max", LEADER_SYSTEM_PROMPT, LEADER_USER_PROMPT(agentResults));
  const modelAnomaly = resp.anomaly === true;
  const anomaly = modelAnomaly || mandatory;
  let reason = String(resp.reason ?? "").trim();
  let links: string[] = Array.isArray(resp.evidence_links) ? resp.evidence_links.map(String) : [];
  // 实测发现模型有时把提示词里的 JSON 示例原样回吐（只把 X/Y 换成数字），
  // 产出「MD&A中第108段：对应论点」这种空壳证据。它对可追溯性的伤害比没有证据更大——
  // 看起来有引用，实际一个字的内容都没有。所以先按示例模式剔除，再校验段号是否真的存在。
  // 只认示例尾巴：前缀里的量词不可靠（文本侧写「段」，财务侧写「行」），
  // 按「段」写死就会放过「财务指标第5行：对应异常指标」这种空壳。
  const exampleShell = /[:：]\s*(对应论点|对应异常指标|对应指标)\s*$/;
  const paragraphCount = Number(sentiment?.paragraph_count ?? 0);
  const kept = links.filter((raw) => {
    const text = raw.trim();
    if (!text || exampleShell.test(text)) return false;
    if (paragraphCount > 0) {
      const cited = citedParagraphs(text);
      if (cited.length && !cited.every((n) => n >= 1 && n <= paragraphCount)) return false;
    }
    return true;
  });
  const droppedShells = links.length - kept.length;
  links = kept.map((t) => t.trim());
  if (mandatory && !modelAnomaly) {
    // 直接复用判定环节算出来的依据句，避免两处各写一遍公式而算出不同的数。
    reason = `${audit.reasons.join("；")}，超过红线 ${DIVERGENCE_RED}，触发强制背离规则。`;
  }
  if (anomaly && !reason) reason = "语调过度乐观，存在掩盖财务恶化的嫌疑，需要进一步核查。";
  if (!anomaly && !reason) reason = "文本语调与财务表现未发现显著背离，建议持续跟踪。";
  if (anomaly && links.length === 0) {
    links = [...(sentiment.key_claims ?? []).slice(0, 1), ...(financial.evidence_links ?? []).slice(0, 1)];
  }
  // 证据不足两条时不写空壳，改从已经过校验的材料里补：文本侧用语调 Agent 的论点（已过滤段号），
  // 财务侧用规则引擎那一行。补的内容来源明确，比留一个「（模型未提供）」更像证据、也更不像证据。
  let filledFrom: string[] = [];
  if (links.length === 0) {
    const textClaim = (sentiment.key_claims ?? [])[0];
    const finLine = (financial.evidence_links ?? [])[0];
    if (textClaim) {
      links.push(String(textClaim));
      filledFrom.push("文本侧由 TextSentimentAgent 论点补足");
    }
    if (finLine) {
      links.push(String(finLine));
      filledFrom.push("财务侧由规则引擎年度行补足");
    }
  }
  // 标题以 grade（产品策略结论）为准，模型自判与策略不一致时不掩盖：
  // 之前出现过「灯是绿的、标题写着发现背离」的同屏矛盾，根因就是两者各有来源。
  const disagreement =
    anomaly === (audit.grade === "red") ? null
      : anomaly
        ? `模型判为异常，但按分档规则级别为 ${audit.grade}${audit.downgraded ? `（原 ${audit.raw_grade}，优质档降档）` : ""}，标题以规则档位为准。`
        : `规则档位为 ${audit.grade}，模型未判异常。`;
  return {
    anomaly,
    reason: disagreement ? `${reason}（${disagreement}）` : reason,
    evidence_links: links,
    // 证据链被动过手脚这件事也必须可见，否则「清洗过的证据」看起来就像模型原本给的。
    evidence_dropped_shells: droppedShells,
    evidence_filled: filledFrom,
    divergence: audit,
    alert_grade: audit.grade,
    disagreement,
  };
}

// 确定性结构化摘录：只做「这条披露可不可量化」的筛选，不做任何价性判断。
// 选段规则必须能被人工复现，否则事实核对 Agent 的输入本身就成了不可核对的黑箱。
// 「项/个」这类通用量词会把「审议通过 16 项议案」这类治理套话拉进摘录，
// 所以单位只保留真正承载经营计量的那些。
const QUANT_PATTERN =
  /[0-9][0-9,.]*\s*(?:%|％|亿元|万元|元|吨|台|套|辆|家|倍|个百分点|平方米|公里|万人次|万人|MW|GWh|kWh)/;

// 纯指标名词，不带褒贬：「成本」「销量」本身既不利好也不利空。
const INDICATOR_NOUNS = [
  "营业收入", "收入", "成本", "费用", "毛利率", "净利率", "净利润", "归母", "利润",
  "现金流", "销量", "产量", "产能", "订单", "负债", "资产", "存货", "应收", "应付",
  "研发", "门店", "市占率", "份额", "周转", "投资", "筹资", "营业外", "减值", "补助",
  "客户", "用户", "价格", "单价", "面积", "回款", "合同", "产能利用率",
  "股利", "分红", "净资产", "利率", "余额", "规模",
];

// 与 site/assets/mda.js 判定章节边界的写法保持一致，摘录按小节分组后才对得上「注明章节」。
// (?![0-9]) 是关键：没有它，「23.0%,主要是…」里的句点会被当成「23.」这种编号分隔符，
// 正文被误判为小节标题后，整段之后的摘录都会挂上错误章节名。
const SECTION_HEADING =
  /^(?:第[一二三四五六七八九十百零〇0-9]+[章节部分]|[0-9]{1,3}(?:\.[0-9]{1,3})*[、.．](?![0-9])|[一二三四五六七八九十]+、|（[一二三四五六七八九十0-9]+）|\([0-9]+\))/;

// 数字开头的小节标题容易和正文里的百分比撞车：「23.0%,主要是…」会被 [0-9]+[.] 判成编号标题。
// 真正的标题不带句末标点，也不会出现「数字+单位」这类计量表述。
function isSectionHeading(compact: string) {
  if (!SECTION_HEADING.test(compact)) return false;
  if (compact.length > 30) return false;
  if (/[。！？；，,]$/.test(compact)) return false;
  return !/[0-9][0-9,.]*\s*(?:%|％|亿元|万元|倍|个百分点)/.test(compact);
}

// 「XX 指 XX 公司/科目」是年报释义段的写法，与经营变化无关。
// 释义混进摘录会让模型把定义当成披露，白占预算。
const DEFINITION_LINE = /^“[^”]{1,30}”\s*指/;

// 表格碎片行没有叙述，回答不了提示词要求的「口径」和「原因」，只能判证据不足。
// 复用词典法那份判定，让「什么算表格行」在全站只有一种定义。
function isTableFragment(text: string) {
  return (/[0-9][0-9,.]{2,}/.test(text) && !/[。！？]/.test(text)) || text.length <= 12;
}

// 前瞻性陈述免责、审计意见套话之类属于法律模板，不是经营披露。
const BOILERPLATE = /前瞻性陈述|不构成.*承诺|敬请.*注意|审计意见.*标准无保留/;

export function extractExcerpts(mda: string, budget = 7000) {
  const paragraphs = mda.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates: { n: number; section: string; text: string; score: number }[] = [];
  let section = "（章节标题未识别）";
  paragraphs.forEach((text, index) => {
    const compact = text.replace(/\s+/g, "");
    if (isSectionHeading(compact)) {
      section = compact;
      return;
    }
    const quantHits = (text.match(new RegExp(QUANT_PATTERN.source, "g")) ?? []).length;
    const nounHits = INDICATOR_NOUNS.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
    // 必须「有计量 且 有指标名词」，或出现两个以上指标名词：
    // 只靠数字会漏掉口径，只靠名词会把宏观背景句和治理套话当成经营披露。
    if (!((quantHits > 0 && nounHits > 0) || nounHits >= 2)) return;
    if (DEFINITION_LINE.test(compact) || BOILERPLATE.test(text)) return;
    // 表头行（「项目/本报告期/上年同期」）先剔除；但表内金额行保留，
    // 因为「营业收入 170,899,152,276.34 147,693,604,994.14 15.71」正是可核对的事实。
    if (isTableFragment(text) && !/[0-9][0-9,.]{5,}/.test(text.replace(/%/g, ""))) return;
    candidates.push({ n: index + 1, section, text, score: quantHits * 2 + nounHits });
  });

  // 先按可量化程度排序取用，再还原成文档顺序：模型读乱序文本会漏掉跨段矛盾。
  candidates.sort((a, b) => b.score - a.score || a.n - b.n);
  const picked: typeof candidates = [];
  let size = 0;
  for (const item of candidates) {
    const cost = item.text.length + 12;
    // 跳过而非中断：排序后段落长度不单调，中断会把预算尾部整段浪费掉。
    if (picked.length && size + cost > budget) continue;
    picked.push(item);
    size += cost;
  }
  picked.sort((a, b) => a.n - b.n);
  return {
    excerpts: picked,
    excerptCount: picked.length,
    totalParagraphs: paragraphs.length,
    candidateCount: candidates.length,
    charCount: size,
  };
}

const DIRECTION_LABELS = new Set(["利好", "利空", "中性", "证据不足"]);
const CAUSE_LABELS = new Set(["主营", "一次性", "外部", "未披露"]);

// 两次核对里同一个指标常被写成不同别名（「经营活动产生的现金流量净额」/「经营现金流」）。
// 不用字符相似度：实测「利息净收入」与「非利息净收入」字符重合度 0.83、「经营现金流」与
// 「投资现金流」重合度 0.77，都是互斥科目，配上对就会把两条不同指标的方向当成同一条来比，
// 产出一眼看不出来的假「一致」或假「分歧」。所以改成确定性别名表：命中即同一指标，否则只认全名相同。
// 别名表只收「同一行项目的不同写法」，不收相关但不同的行项目：
// 营业总收入≠营业收入、归母净利润≠净利润、研发投入≠研发费用、利息收入≠利息净收入。
// 把它们当同义词，正好会掩盖「换口径」这种操纵手法——两次核对各用一个口径时，
// 宁可不配对（标为未复现）也不能悄悄并成同一条。
// 表内顺序同样重要：命中用的是 includes，短名先出现就会抢走长名。
const METRIC_ALIASES: [string, string[]][] = [
  ["经营现金流", ["经营活动产生的现金流量净额", "经营活动现金流量净额", "经营活动现金流", "经营现金流量净额", "经营现金流", "经营现金流量"]],
  ["投资现金流", ["投资活动产生的现金流量净额", "投资活动现金流", "投资现金流", "投资现金流量"]],
  ["筹资现金流", ["筹资活动产生的现金流量净额", "筹资活动现金流", "筹资现金流", "筹资现金流量"]],
  ["非利息净收入", ["非利息净收入", "非息收入"]],
  ["手续费及佣金净收入", ["手续费及佣金净收入"]],
  ["利息净收入", ["利息净收入"]],
  ["扣非净利润", ["扣除非经常性损益后的净利润", "扣除非经常性损益的净利润", "扣非归母净利润", "扣非净利润"]],
  ["归母净利润", ["归属于母公司股东的净利润", "归属于母公司所有者的净利润", "归属母公司净利润", "归母净利润"]],
  ["净利润", ["净利润"]],
  ["营业总收入", ["营业总收入", "营业收入总额"]],
  ["营业收入", ["营业收入"]],
  ["业务及管理费", ["业务及管理费"]],
  ["管理费用", ["管理费用", "管理费用率"]],
  ["销售费用", ["销售费用"]],
  ["研发费用", ["研发费用"]],
  ["研发投入", ["研发投入"]],
  ["信用减值损失", ["信用减值损失"]],
  ["资产减值损失", ["信用及其他资产减值损失", "资产减值损失"]],
  ["不良贷款率", ["不良贷款率", "不良率"]],
  ["拨备覆盖率", ["拨备覆盖率"]],
  ["毛利率", ["毛利率"]],
  ["净利率", ["销售净利率", "净利率"]],
  ["资产负债率", ["资产负债率"]],
  ["产销量", ["产量与销量", "产销量"]],
  ["销量", ["销量"]],
  ["门店数量", ["门店数量", "开业门店"]],
  ["合同负债", ["合同负债"]],
  ["存货", ["存货"]],
  ["库存量", ["库存量"]],
  ["应收账款", ["应收账款"]],
  ["应收款项", ["应收款项"]],
];

function normalizeMetric(name: string) {
  return String(name ?? "").replace(/[\s（）()、，,。．.%％]/g, "");
}

function metricCanonical(name: string) {
  const compact = normalizeMetric(name);
  if (!compact) return "";
  for (const [canonical, aliases] of METRIC_ALIASES) {
    for (const alias of aliases) {
      if (compact.includes(normalizeMetric(alias))) return canonical;
    }
  }
  // 表外指标不猜：返回空串，配对时退化为「全名必须一致」。
  return "";
}

function metricSame(a: string, b: string) {
  const ca = metricCanonical(a);
  const cb = metricCanonical(b);
  if (ca && cb) return ca === cb;
  if (ca || cb) return false;
  return normalizeMetric(a) === normalizeMetric(b);
}

function bestMatch(finding: any, pool: any[], used: Set<number>) {
  return pool.findIndex((candidate, i) => !used.has(i) && metricSame(finding.metric, candidate.metric));
}

async function factReviewOnce(excerpts: string, financials: string, known: Set<number>) {
  const resp = await completeJson("qwen-plus", FACT_REVIEW_SYSTEM_PROMPT,
    FACT_REVIEW_USER_PROMPT(excerpts, financials));
  const rawFindings = Array.isArray(resp.findings) ? resp.findings : [];
  const findings = rawFindings.slice(0, 6).map((item: any) => {
    // 段号白名单过滤：模型引用未选入摘录的段号即为编造，直接丢弃而不是保留可疑引用。
    const paragraphs = (Array.isArray(item?.paragraphs) ? item.paragraphs : [])
      .map((p: unknown) => Number(p))
      .filter((p: number) => Number.isInteger(p) && known.has(p));
    const direction = String(item?.direction ?? "").trim();
    return {
      metric: String(item?.metric ?? "").trim(),
      category: String(item?.category ?? "").trim(),
      period: String(item?.period ?? "").trim(),
      fact: String(item?.fact ?? "").trim(),
      companyExplanation: String(item?.company_explanation ?? "").trim(),
      causeType: String(item?.cause_type ?? "").trim(),
      consistency: String(item?.consistency ?? "").trim(),
      inference: String(item?.inference ?? "").trim(),
      direction: DIRECTION_LABELS.has(direction) ? direction : "证据不足",
      paragraphs,
    };
  }).filter((f: any) => f.metric || f.fact);
  const conflicts = (Array.isArray(resp.conflicts) ? resp.conflicts : [])
    .map((c: unknown) => String(c).trim())
    .filter(Boolean)
    .slice(0, 3);
  return { findings, conflicts };
}

export async function analyzeFacts(mda: string, financial: any) {
  const picked = extractExcerpts(mda);
  if (picked.excerpts.length === 0) throw new Error("no_quantitative_excerpts");

  const excerpts = picked.excerpts.map((e) => `第${e.n}段（${e.section}）：${e.text}`).join("\n");
  const years = Array.isArray(financial.rows) ? financial.rows : [];
  const financials = years.length
    ? years
        .map((r: any, i: number) => {
          const p = i > 0 ? years[i - 1] : null;
          return (
            `${r.year}年度：营业总收入 ${amount(r.revenue)}（${yoyNote(p?.revenue ?? null, r.revenue, r.revenueYoY)}）、` +
            `归母净利润 ${amount(r.netProfit)}（${yoyNote(p?.netProfit ?? null, r.netProfit, r.netProfitYoY)}）、` +
            `经营现金流 ${amount(r.operatingCashflow)}（${yoyNote(p?.operatingCashflow ?? null, r.operatingCashflow, r.cashflowYoY)}）、` +
            `扣非归母净利润 ${amount(r.deductedNetProfit)}`
          );
        })
        .join("\n")
    : "（未取到外部财务指标）";

  const known = new Set(picked.excerpts.map((e) => e.n));
  // 同一段 MD&A 连跑两次，qwen-plus 给出的 direction 会抖（实测「经营活动现金流」
  // 一次中性、一次利空）。方向既然是结论，就必须先证明它可复现：并行跑两次，
  // 只有一致的才作为结论呈现，不一致的标成「分歧」而不是挑一个。
  // 并行而不是串行，墙钟时间不翻倍；一路失败也不能拖垮另一路。
  const settled = await Promise.allSettled([
    factReviewOnce(excerpts, financials, known),
    factReviewOnce(excerpts, financials, known),
  ]);
  const runs = settled.filter((s) => s.status === "fulfilled").map((s: any) => s.value as any);
  if (runs.length === 0) {
    const reason = settled.find((s) => s.status === "rejected") as any;
    throw reason?.reason instanceof Error ? reason.reason : new Error("llm_invalid_json");
  }

  const merged: any[] = [];
  const unstable: string[] = [];
  const conflicts: string[] = [];
  if (runs.length === 1) {
    merged.push(...runs[0].findings.map((f: any) => ({ ...f, agreed: false })));
    conflicts.push("两次独立核对只有一次成功返回，本栏方向判定未经复现，仅作为待核查线索。");
  } else {
    const used = new Set<number>();
    for (const primary of runs[0].findings) {
      const index = bestMatch(primary, runs[1].findings, used);
      if (index < 0) {
        // 只有一路出现该指标：保留事实与口径（这部分本身有用），但方向标为未复现。
        // 丢弃会让界面里「未复现」那一栏永远空着，等于假装这个问题不存在。
        merged.push({ ...primary, agreed: false });
        unstable.push(primary.metric || "未命名指标");
        continue;
      }
      used.add(index);
      const witness = runs[1].findings[index];
      if (witness.direction === primary.direction) {
        merged.push({ ...primary, agreed: true });
      } else {
        merged.push({ ...primary, direction: "分歧", agreed: false });
        unstable.push(`${primary.metric}（${primary.direction} / ${witness.direction}）`);
      }
    }
    if (unstable.length) {
      conflicts.push(`两次独立核对方向判定不一致或只出现一次：${unstable.slice(0, 4).join("；")}。此类条目不作为结论。`);
    }
  }
  for (const run of runs) for (const c of run.conflicts) if (!conflicts.includes(c)) conflicts.push(c);

  return {
    findings: merged.slice(0, 6),
    conflicts: conflicts.slice(0, 4),
    runs: runs.length,
    excerptCount: picked.excerpts.length,
    candidateCount: picked.candidateCount,
    totalParagraphs: picked.totalParagraphs,
    excerptChars: picked.charCount,
  };
}