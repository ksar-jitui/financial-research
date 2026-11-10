const SEARCH_URL = "https://www.cninfo.com.cn/new/information/topSearch/query";
const ANNOUNCEMENT_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query";
const STATIC_URL = "https://static.cninfo.com.cn";
const DELAY_MS = 2000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search",
  "Accept": "application/json, text/plain, */*",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postForm(url: string, data: Record<string, string>): Promise<any> {
  await sleep(DELAY_MS);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data).toString(),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`cninfo_http_${res.status}`);
  return res.json();
}

function column(code: string): string {
  if (code.startsWith("6")) return "sse";
  if (code.startsWith("4") || code.startsWith("8") || code.startsWith("9")) return "bjse";
  return "szse";
}

function isCrossEntity(title: string): boolean {
  // 巨潮会把子公司公告挂在母公司条目下，形如「中国平安：平安银行股份有限公司2025年年度报告」，
  // 选中它就会拿子公司的报告去审计母公司，而且不会报错。
  // 冒号后出现另一个明确主体且与冒号前缀互不包含时判为串档；
  // 「港股公告：2025年年度报告」这类后缀没有主体名的正常公告放行，避免过度排除。
  const index = title.indexOf("：");
  if (index < 0) return false;
  const prefix = title.slice(0, index);
  const suffix = title.slice(index + 1);
  const match = suffix.match(/[\u4e00-\u9fffA-Za-z()（）]{2,24}?(?:股份有限公司|有限公司)/);
  if (!match) return false;
  const entity = match[0];
  return !entity.includes(prefix) && !prefix.includes(entity);
}

function isTargetAnnual(title: string, year: number): boolean {
  const clean = title.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
  if (!new RegExp(`${year}年?年度报告`).test(clean)) return false;
  const excluded = ["摘要", "英文", "已取消", "更正公告", "补充公告", "问询", "回复", "提示性公告"];
  if (excluded.some((k) => clean.includes(k))) return false;
  return !isCrossEntity(clean);
}

export interface AnnualPdf {
  title: string;
  url: string;
  bytes: ArrayBuffer;
}

export async function fetchAnnualPdf(code: string, year: number): Promise<AnnualPdf> {
  const companies = await postForm(SEARCH_URL, { keyWord: code, maxNum: "10" });
  if (!Array.isArray(companies) || companies.length === 0) {
    throw new Error(`cninfo_not_found_${code}`);
  }
  const company = companies.find((c: any) => String(c.code) === code) ?? companies[0];
  const orgId = String(company.orgId ?? "");
  if (!orgId) throw new Error(`cninfo_no_orgid_${code}`);

  const seDate = `${year + 1}-01-01~${year + 1}-12-31`;
  const seen: any[] = [];
  let best: any = null;
  // 巨潮的年报类别标签对个别公司不一致：实测 600958 东方证券 2025 年年度报告全文在巨潮存在且可下载，
  // 却不出现在 category_ndbg_szsh 类别结果里，只用类别查询会误报“找不到”。
  // 因此类别查询拿不到可接受全文时，退回“不限类别 + 关键词”再查一次，套用同一套标题过滤。
  const queries = [
    { category: "category_ndbg_szsh;", searchkey: "" },
    { category: "", searchkey: `${year}年年度报告` },
  ];
  for (const attempt of queries) {
    const result = await postForm(ANNOUNCEMENT_URL, {
      pageNum: "1",
      pageSize: "30",
      column: column(code),
      tabName: "fulltext",
      plate: "",
      stock: `${code},${orgId}`,
      searchkey: attempt.searchkey,
      secid: "",
      category: attempt.category,
      trade: "",
      seDate,
      sortName: "",
      sortType: "",
      isHLtitle: "false",
    });
    const announcements: any[] = result?.announcements ?? [];
    seen.push(...announcements);
    const matches = announcements.filter(
      (a) =>
        isTargetAnnual(String(a.announcementTitle ?? ""), year) &&
        String(a.adjunctUrl ?? "").toLowerCase().endsWith(".pdf"),
    );
    if (matches.length > 0) {
      best = matches.reduce((a, b) =>
        (Number(b.announcementTime) || 0) > (Number(a.announcementTime) || 0) ? b : a,
      );
      break;
    }
  }
  if (!best) {
    // 区分“只披露了摘要”和“什么都没检索到”：摘要不含 MD&A，不能退化成拿摘要做语调审计。
    const titles = seen.map((a) => String(a.announcementTitle ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, ""));
    const summaryOnly = titles.some((t) => new RegExp(`${year}年?年度报告摘要`).test(t));
    throw new Error(summaryOnly ? `annual_summary_only_${code}_${year}` : `annual_pdf_not_found_${code}_${year}`);
  }
  const url = `${STATIC_URL}/${String(best.adjunctUrl).replace(/^\//, "")}`;

  await sleep(DELAY_MS);
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`pdf_http_${res.status}`);
  const bytes = await res.arrayBuffer();
  return { title: String(best.announcementTitle ?? ""), url, bytes };
}