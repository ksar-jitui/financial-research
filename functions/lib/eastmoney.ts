const SUGGEST_URL = "https://searchapi.eastmoney.com/api/suggest/get";
// Eastmoney's public web autocomplete token (not a user credential).
const SUGGEST_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
const F10_URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://data.eastmoney.com/",
  "Accept": "application/json, text/plain, */*",
};

export interface Stock {
  code: string;
  name: string;
}

export interface FinancialRow {
  year: number;
  orgType: string;
  revenue: number | null;
  netProfit: number | null;
  operatingCashflow: number | null;
  deductedNetProfit: number | null;
  revenueYoY: number | null;
  netProfitYoY: number | null;
  cashflowYoY: number | null;
  roa: number | null;
  debtRatio: number | null;
  currentRatio: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  assetTurnover: number | null;
  shareCapital: number | null;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`upstream_http_${res.status}`);
  return res.json();
}

export function secucode(code: string): string {
  if (code.startsWith("6")) return `${code}.SH`;
  if (code.startsWith("4") || code.startsWith("8") || code.startsWith("9")) return `${code}.BJ`;
  return `${code}.SZ`;
}

// A 股代码段白名单。不用 Classify 判板块：实测上游对科创板返回 Classify='23'（板块号）、
// 北交所返回 'NEEQ'，只有主板/创业板才是 'AStock'——按 'AStock' 过滤会把科创板和北交所
// 整板块丢掉（约占全市场 15%）。而 800000 这类六位数指数带 Classify='BStock'，
// 所以也不能简化成「六位数就收」。
// 前缀集合直接对齐普查名录 data/stock_list.csv 的实际覆盖（00/30/60/68/92 共 5579 家），
// 这样不会出现「搜得到但后端没有财务数据」的空洞。
const A_SHARE_PREFIX = /^(00|30|60|68|92)\d{4}$/;

export async function fetchStocks(query: string): Promise<Stock[]> {
  const q = query.trim();
  if (!q) return [];
  const url =
    `${SUGGEST_URL}?input=${encodeURIComponent(q)}&type=14&token=${SUGGEST_TOKEN}&count=20`;
  const data = await getJson(url);
  const list: any[] = data?.QuotationCodeTable?.Data ?? [];
  return list
    .filter((d) => A_SHARE_PREFIX.test(String(d.Code ?? "")))
    .map((d) => ({ code: String(d.Code), name: String(d.Name) }));
}

export async function fetchIndustry(code: string): Promise<string> {
  const url =
    `${F10_URL}?reportName=RPT_F10_ORG_BASICINFO&columns=ALL` +
    `&filter=${encodeURIComponent(`(SECUCODE="${secucode(code)}")`)}` +
    `&pageNumber=1&pageSize=1&source=HSF10&client=PC`;
  const data = await getJson(url);
  const rec = data?.result?.data?.[0];
  // 判定要用的是东财一级板块名（与普查分组同源）。取不到就返回空串，
  // 让分位定位退回实体/金融→全市场，而不是猜一个行业把公司塞进错误的池子。
  return String(rec?.BOARD_NAME_1LEVEL ?? "");
}

export async function fetchFinancials(code: string): Promise<FinancialRow[]> {
  const filter = encodeURIComponent(`(SECUCODE="${secucode(code)}")`);
  const url =
    `${F10_URL}?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=${filter}` +
    `&pageNumber=1&pageSize=100&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`;
  const data = await getJson(url);
  const records: any[] = data?.result?.data ?? [];
  const byYear = new Map<number, Snapshot>();
  for (const r of records) {
    const type = String(r.REPORT_TYPE ?? "");
    if (!type.includes("年报")) continue;
    const year = Number(String(r.REPORT_DATE ?? "").slice(0, 4));
    if (!year || byYear.has(year)) continue;
    byYear.set(year, {
      orgType: String(r.ORG_TYPE ?? ""),
      revenue: num(r.TOTALOPERATEREVE),
      netProfit: num(r.PARENTNETPROFIT),
      operatingCashflow: num(r.NETCASH_OPERATE_PK),
      deductedNetProfit: num(r.KCFJCXSYJLR),
      roa: num(r.ZZCJLL),
      debtRatio: num(r.ZCFZL),
      currentRatio: num(r.LD),
      grossMargin: num(r.XSMLL),
      netMargin: num(r.XSJLL),
      assetTurnover: num(r.TOAZZL),
      shareCapital: num(r.TOTAL_SHARE),
    });
  }
  const years = [...byYear.keys()].sort((a, b) => a - b).slice(-6);
  const rows: FinancialRow[] = [];
  let prev: Snapshot | null = null;
  for (const year of years) {
    const v = byYear.get(year)!;
    rows.push({
      year,
      orgType: v.orgType,
      revenue: v.revenue,
      netProfit: v.netProfit,
      operatingCashflow: v.operatingCashflow,
      deductedNetProfit: v.deductedNetProfit,
      revenueYoY: yoy(v.revenue, prev?.revenue ?? null),
      netProfitYoY: yoy(v.netProfit, prev?.netProfit ?? null),
      cashflowYoY: yoy(v.operatingCashflow, prev?.operatingCashflow ?? null),
      roa: v.roa,
      debtRatio: v.debtRatio,
      currentRatio: v.currentRatio,
      grossMargin: v.grossMargin,
      netMargin: v.netMargin,
      assetTurnover: v.assetTurnover,
      shareCapital: v.shareCapital,
    });
    prev = v;
  }
  return rows;
}

interface Snapshot {
  orgType: string;
  revenue: number | null;
  netProfit: number | null;
  operatingCashflow: number | null;
  deductedNetProfit: number | null;
  roa: number | null;
  debtRatio: number | null;
  currentRatio: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  assetTurnover: number | null;
  shareCapital: number | null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function yoy(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}
