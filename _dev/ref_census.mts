import { analyzeFinancial } from "../functions/lib/agents.ts";
import { fetchFinancials } from "../functions/lib/eastmoney.ts";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const at = (name: string) => fileURLToPath(new URL(name, import.meta.url));
// 打分口径一变，旧的分数缓存就不能用了：现金流恶化改成 Δ ÷ 上年营收之后，27708 个水平分全部重算，
// 所以这一轮写到 v2 文件，保留 v1 供对照，basis 标签则让下游脚本能拒绝读到口径不对的缓存。
const BASIS = "cash_rel_prev_revenue_v2";
const OUT = at("ref_rows_v2.jsonl");
const LIST_CSV = at("../data/stock_list.csv");
const MAP = at("ref_industry.json");
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://data.eastmoney.com/",
  "Accept": "application/json, text/plain, */*",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

// 行业映射走「整表分页」：RPT_F10_ORG_BASICINFO 不加 filter 即可翻页，
// 全市场十几次请求换掉 5579 次——这一批能不能在合理时间内跑完就看这里。
type Industry = { bk1: string; bk1Name: string; bk2Name: string; csrc: string };

async function fetchIndustryMap(): Promise<Record<string, Industry>> {
  if (fs.existsSync(MAP)) {
    const cached = JSON.parse(fs.readFileSync(MAP, "utf8"));
    if (Object.keys(cached).length > 4000) return cached;
  }
  const map: Record<string, Industry> = {};
  for (let pn = 1; pn <= 30; pn++) {
    let page: any[] | null = null;
    for (let attempt = 0; attempt < 5 && !page; attempt++) {
      try {
        const data = await getJson(
          "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO" +
            `&columns=ALL&pageNumber=${pn}&pageSize=500&source=HSF10&client=PC`,
        );
        page = data?.result?.data ?? [];
      } catch {
        await sleep(1500 * (attempt + 1));
      }
    }
    if (!page || page.length === 0) break;
    for (const r of page) {
      const code = String(r.SECURITY_CODE ?? "").padStart(6, "0");
      if (!/^\d{6}$/.test(code)) continue;
      map[code] = {
        bk1: String(r.BOARD_CODE_BK_1LEVEL ?? ""),
        bk1Name: String(r.BOARD_NAME_1LEVEL ?? ""),
        bk2Name: String(r.BOARD_NAME_2LEVEL ?? ""),
        csrc: String(r.INDUSTRYCSRC1 ?? r.CSRC_INDUSTRY_NAME ?? ""),
      };
    }
    process.stdout.write(`\rindustry ${Object.keys(map).length}`);
    if (page.length < 500) break;
    await sleep(300);
  }
  process.stdout.write(`\rindustry map: ${Object.keys(map).length} 家          \n`);
  if (Object.keys(map).length < 4000) throw new Error(`industry_map_incomplete_${Object.keys(map).length}`);
  fs.writeFileSync(MAP, JSON.stringify(map));
  return map;
}

type StockRec = { code: string; name: string };

function getList(): StockRec[] {
  const out: StockRec[] = [];
  for (const line of fs.readFileSync(LIST_CSV, "utf8").split("\n")) {
    const cells = line.trim().split(",");
    if (cells.length < 2 || !/^\d{6}$/.test(cells[0])) continue;
    out.push({ code: cells[0], name: cells[1].replace(/\s+/g, "") });
  }
  return out;
}

const map = await fetchIndustryMap();
const seen = new Set<string>();
const universe = getList().filter((s) => !seen.has(s.code) && seen.add(s.code));
universe.sort((a, b) => (a.code < b.code ? -1 : 1));

const done = new Set<string>();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      // 只有口径标签一致的记录才算完成：换一条打分规则就要整轮重取，不能混用旧行。
      if (rec.basis === BASIS) done.add(rec.code);
    } catch {}
  }
}
const queue = universe.filter((s) => !done.has(s.code));
console.log(`universe=${universe.length} 已带行业=${done.size} todo=${queue.length}`);

const fd = fs.openSync(OUT, "a");
const total = queue.length;
let processed = 0;
let failed = 0;
let noIndustry = 0;
const started = Date.now();

async function scoreOne(item: StockRec) {
  let rows: any[] | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      rows = await fetchFinancials(item.code);
      break;
    } catch {
      await sleep(800 * (attempt + 1));
    }
  }
  if (!rows) return null;
  const scores: any[] = [];
  for (let i = 1; i < rows.length; i++) {
    try {
      // 与线上完全一致的调用形状：滚动窗口截到第 i 行，取该窗口最后一年打分。
      const view = rows.slice(0, i + 1);
      const a = analyzeFinancial(view);
      scores.push({
        year: a.latest_year,
        raw: a.raw_health_score,
        change: a.change_score,
        f: a.f_score.total,
        fv: a.f_score.valid,
        abn: a.abnormalities.length,
        org: view[view.length - 1].orgType,
        // 优质档与规模过滤要靠行业内的毛利率/净利率/营收分布，这些必须在同一次普查里落盘，
        // 否则又要为一列再跑 13 分钟。
        gm: view[view.length - 1].grossMargin,
        nm: view[view.length - 1].netMargin,
        rev: view[view.length - 1].revenue,
        np: view[view.length - 1].netProfit,
        // 现金流绝对额也落盘：下一轮再调现金流口径，就不用为了一列重跑十几分钟接口。
        cf: view[view.length - 1].operatingCashflow,
        roe: view[view.length - 1].roa,
      });
    } catch {}
  }
  const ind = map[item.code];
  if (!ind) noIndustry++;
  return {
    code: item.code,
    name: item.name,
    basis: BASIS,
    industry: ind ? ind.bk1Name : "",
    industry2: ind ? ind.bk2Name : "",
    board: ind ? ind.bk1 : "",
    csrc: ind ? ind.csrc : "",
    org: rows.length ? rows[rows.length - 1].orgType : "",
    scores,
  };
}

// 并发 3、每轮 200ms：近六千家不能按最快节奏硬打接口，宁慢不封。
async function worker(id: number) {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    let record = null;
    try {
      record = await scoreOne(item);
    } catch {}
    if (record) {
      fs.writeSync(fd, JSON.stringify(record) + "\n");
      if (processed % 50 === 0) fs.fsyncSync(fd);
    } else failed++;
    processed++;
    if (processed % 500 === 0) {
      const rate = processed / ((Date.now() - started) / 1000);
      console.log(
        `  [w${id}] ${processed}/${total} failed=${failed} noIndustry=${noIndustry} ${rate.toFixed(2)}/s ` +
          `eta=${((total - processed) / rate / 60).toFixed(1)}min`,
      );
    }
    await sleep(200);
  }
}

await Promise.all([worker(1), worker(2), worker(3)]);
fs.fsyncSync(fd);
fs.closeSync(fd);
console.log(`DONE processed=${processed} failed=${failed} noIndustry=${noIndustry} elapsed=${((Date.now() - started) / 60000).toFixed(1)}min`);
