import fs from "node:fs";
import { fileURLToPath } from "node:url";

const at = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const MAP = at("ref_industry.json");
const ROWS = at("ref_rows.jsonl");
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://data.eastmoney.com/",
  "Accept": "application/json, text/plain, */*",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 上一版把分页写死成 pageSize=500 × 最多 30 页，正好停在 15000 条：
// 表里还有更多记录，于是 355 家北交所公司从来没进过映射，
// 而运行时按代码单查却能拿到它们的行业 —— 带是缺样本算的，判定却把它们放进了池子。
async function fetchPage(pn: number, size: number) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(
        "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO" +
          `&columns=ALL&pageNumber=${pn}&pageSize=${size}&source=HSF10&client=PC`,
        { headers: HEADERS, signal: AbortSignal.timeout(30000) },
      );
      if (!res.ok) throw new Error(`http_${res.status}`);
      const data: any = await res.json();
      return { rows: data?.result?.data ?? [], total: Number(data?.result?.total ?? 0) };
    } catch (err) {
      await sleep(1200 * (attempt + 1));
    }
  }
  throw new Error(`page_${pn}_failed`);
}

// 上游会把 pageSize 悄悄截到 500：按请求值当「最后一页」判据会在第 1 页就退出，
// 结果把整张映射覆盖成 500 条。所以步长要取「上游实际给的页长」，不是我以为的页长。
const SIZE = 500;
const map: Record<string, any> = {};
let total = 0;
let stride = 0;
for (let pn = 1; pn <= 120; pn++) {
  const page = await fetchPage(pn, SIZE);
  total = page.total || total;
  if (!page.rows.length) break;
  stride = stride || page.rows.length;
  for (const r of page.rows) {
    const code = String(r.SECURITY_CODE ?? "").padStart(6, "0");
    if (!/^\d{6}$/.test(code)) continue;
    map[code] = {
      bk1: String(r.BOARD_CODE_BK_1LEVEL ?? ""),
      bk1Name: String(r.BOARD_NAME_1LEVEL ?? ""),
      bk2Name: String(r.BOARD_NAME_2LEVEL ?? ""),
      csrc: String(r.INDUSTRYCSRC1 ?? r.CSRC_INDUSTRY_NAME ?? ""),
    };
  }
  process.stdout.write(`\r行业映射 ${Object.keys(map).length}（页 ${pn}，步长 ${stride}，total ${total}）`);
  if (page.rows.length < stride) break;
  await sleep(250);
}
process.stdout.write(`\n`);
console.log(`映射条数=${Object.keys(map).length}（上游 total=${total}）`);
fs.writeFileSync(MAP, JSON.stringify(map));

// 重新贴标签：财务行本身不动，只补 industry 字段，省掉 13 分钟重复取数。
const lines = fs.readFileSync(ROWS, "utf8").split("\n").filter((l) => l.trim());
let tagged = 0;
let untagged = 0;
const out = lines.map((line) => {
  const rec = JSON.parse(line);
  const ind = map[rec.code];
  if (ind && ind.bk1Name) {
    rec.industry = ind.bk1Name;
    rec.industry2 = ind.bk2Name;
    rec.board = ind.bk1;
    rec.csrc = ind.csrc;
    tagged++;
  } else {
    untagged++;
  }
  return JSON.stringify(rec);
});
fs.writeFileSync(ROWS, out.join("\n") + "\n");
console.log(`重贴标签：有行业 ${tagged} 家，仍无行业 ${untagged} 家`);

// 抽查几个原先落在映射之外的代码
for (const code of ["920001", "920982", "688981", "600519", "000001"]) {
  const rec = out.map((l) => JSON.parse(l)).find((r) => r.code === code);
  console.log(`  ${code}: ${rec ? `${rec.industry || "（空）"} / ${rec.industry2 || "（空）"}` : "不在普查中"}`);
}
