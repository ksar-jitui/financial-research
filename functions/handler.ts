import { fetchIndustry, fetchStocks, fetchFinancials } from "./lib/eastmoney.ts";
import { fetchAnnualPdf } from "./lib/cninfo.ts";
import { percentileIn, REFERENCE } from "./lib/reference_bands.ts";
import {
  analyzeFinancial,
  analyzeFacts,
  analyzeSentiment,
  analyzeLeader,
  BAND_BOTTOM,
  DIVERGENCE_AMBER,
  DIVERGENCE_RED,
} from "./lib/agents.ts";
import { chat, ServiceNotConfigured } from "./lib/dashscope.ts";
import { AUDITS_PER_WINDOW, clientIp, QUOTA_ENFORCED, quotaSnapshot, quotaState } from "./lib/quota.ts";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function quotaDenied(state: { resetInMs: number }): Response {
  return json(
    {
      ok: false,
      error: "quota_exceeded",
      remaining: 0,
      limit: AUDITS_PER_WINDOW,
      retry_after_seconds: Math.ceil(state.resetInMs / 1000),
    },
    429,
  );
}


function fail(code: string, status = 400): Response {
  return json({ ok: false, error: code }, status);
}

const CODE_RE = /^\d{6}$/;

async function readBody(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > 2_000_000) throw new Error("body_too_large");
  return JSON.parse(text || "{}");
}

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";
  // tone / facts / leader 属于同一次审计，用 (代码, 年度) 作 dedupe key，
  // 否则走完一次就扣三格，「每 IP 5 次」会变成「每 IP 1.6 次」。
  const { ip } = clientIp(req);
  const charge = (body: any): Response | null => {
    const code = String(body?.code ?? url.searchParams.get("code") ?? "");
    const year = String(body?.year ?? url.searchParams.get("year") ?? "");
    const state = quotaState(ip, code && year ? `${code}:${year}` : `${action}:${Date.now()}`);
    if (state.limited) return quotaDenied(state);
    return null;
  };
  try {
    if (req.method === "GET" && action === "stocks") {
      const q = url.searchParams.get("q") ?? "";
      return json({ ok: true, stocks: await fetchStocks(q) });
    }
    if (req.method === "GET" && action === "financials") {
      const code = url.searchParams.get("code") ?? "";
      if (!CODE_RE.test(code)) return fail("invalid_code");
      let rows = await fetchFinancials(code);
      const yearParam = url.searchParams.get("year");
      if (yearParam !== null) {
        const year = Number(yearParam);
        if (!Number.isInteger(year)) return fail("invalid_input");
        rows = rows.filter((row) => row.year <= year);
      }
      if (rows.length === 0) return fail("no_financial_rows", 404);
      // 判定要在行业池里定位，所以每家公司多取一次板块归属。取失败就退回实体/金融→全市场带：
      // 这是可见的降级（band.group_label 会写明最终用的是哪一层），不是悄悄换个池子。
      let industry = "";
      try {
        industry = await fetchIndustry(code);
      } catch {
        industry = "";
      }
      return json({ ok: true, rows, industry, analysis: analyzeFinancial(rows, industry) });
    }
    // 分位带的元数据：把样本量、年度覆盖与阈值来源原样交给前端展示，
    // 界面上的每个数字都能回溯到这份普查，而不是写死在文案里。
    if (req.method === "GET" && action === "bands") {
      const pick = (grid: [number, number][], p: number) => {
        const hit = grid.find(([q]) => q === p);
        return hit ? hit[1] : null;
      };
      const groups: Record<string, any> = {};
      for (const [key, g] of Object.entries(REFERENCE.groups as Record<string, any>)) {
        groups[key] = {
          label: g.label,
          n: g.n,
          change_n: g.change_n,
          level: {
            p10: pick(g.level, 10), p25: pick(g.level, 25), p50: pick(g.level, 50),
            p75: pick(g.level, 75), p90: pick(g.level, 90),
            // 方法论里「两个轴量纲差一个数量级」那句话要靠这个跨度支撑，必须取文案引用的 p1–p99，
            // 不能填成 p90–p10，否则界面上的数字和它自己的说明就不是同一个东西。
            spread: Math.round((pick(g.level, 99) - pick(g.level, 1)) * 10) / 10,
          },
          change: { p10: pick(g.change, 10), p25: pick(g.change, 25), p50: pick(g.change, 50), p75: pick(g.change, 75), p90: pick(g.change, 90) },
        };
      }
      return json({
        ok: true,
        generated_at: REFERENCE.generated_at,
        universe: REFERENCE.universe,
        main_years: REFERENCE.main_years,
        min_industry_observations: REFERENCE.min_industry_observations,
        industries: Object.keys(REFERENCE.industries ?? {}).map((key) => ({
          key,
          n: REFERENCE.industries[key].n,
          firms: REFERENCE.industries[key].firms,
          level_p25: REFERENCE.industries[key].level.find(([q]) => q === 25)?.[1] ?? null,
        })).sort((a, b) => b.n - a.n),
        sampling: REFERENCE.sampling,
        source: REFERENCE.source,
        companies: REFERENCE.companies,
        observations: REFERENCE.observations,
        change_observations: REFERENCE.change_observations,
        years: REFERENCE.years,
        cuts: { red: DIVERGENCE_RED, amber: DIVERGENCE_AMBER, bottom: BAND_BOTTOM },
        // 切点不是拍出来的：给出「在最差一侧经验分布上，这个缺口圈中多少比例」，
        // 让读者能当场验证红线的选择性，而不是接受一个没有依据的数。
        weakness: REFERENCE.weakness,
        basis: [75, 80, 85, 88].map((tone) => ({
          tone,
          red_rate: percentileIn(tone - DIVERGENCE_RED, REFERENCE.weakness.grid),
          amber_rate: percentileIn(tone - DIVERGENCE_AMBER, REFERENCE.weakness.grid),
        })),
        groups,
      });
    }
    if (req.method === "GET" && action === "pdf") {
      const code = url.searchParams.get("code") ?? "";
      const year = Number(url.searchParams.get("year"));
      if (!CODE_RE.test(code) || !Number.isInteger(year)) return fail("invalid_input");
      const pdf = await fetchAnnualPdf(code, year);
      return new Response(pdf.bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "X-Report-Title": encodeURIComponent(pdf.title),
          // 浏览器点开原文时直链巨潮 CDN，避免十几 MB 文件再走一次函数中转。
          "X-Report-Url": pdf.url,
          "Cache-Control": "no-store",
        },
      });
    }
    if (req.method === "POST" && action === "tone") {
      const body = await readBody(req);
      const denied = charge(body);
      if (denied) return denied;
      const mda = String(body.mda ?? "");
      if (!mda.trim()) return fail("empty_mda");
      return json({ ok: true, ...(await analyzeSentiment(mda)) });
    }
    // 事实核对：外部指标由服务端自己取，不接受客户端传入，
    // 否则提示词里「以外部数据为准」的那半句话就成了可被操纵的前提。
    if (req.method === "POST" && action === "facts") {
      const body = await readBody(req);
      const mda = String(body.mda ?? "");
      if (!mda.trim()) return fail("empty_mda");
      const code = String(body.code ?? "");
      if (!CODE_RE.test(code)) return fail("invalid_code");
      const denied = charge(body);
      if (denied) return denied;
      let rows = await fetchFinancials(code);
      const year = Number(body.year);
      if (Number.isInteger(year)) rows = rows.filter((row) => row.year <= year);
      return json({ ok: true, ...(await analyzeFacts(mda, { rows })) });
    }
    if (req.method === "POST" && action === "leader") {
      const body = await readBody(req);
      const denied = charge(body);
      if (denied) return denied;
      if (!body.sentiment || !body.financial) return fail("invalid_input");
      return json({ ok: true, ...(await analyzeLeader(body.sentiment, body.financial, body.facts ?? null)) });
    }
    if (req.method === "POST" && action === "chat") {
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      // 审讯室每问一次就是一次独立 qwen-max 调用，所以每次提问扣一格；
      // 用消息条数做 key，同一条提问的重试不会重复扣。
      const chatQuota = quotaState(ip, `chat:${messages.length}`);
      if (chatQuota.limited) return quotaDenied(chatQuota);
      if (messages.length === 0) return fail("empty_messages");
      const system = String(body.context ?? "");
      const full = system ? [{ role: "system", content: system }, ...messages] : messages;
      return json({ ok: true, reply: await chat("qwen-max", full) });
    }
    if (req.method === "GET" && action === "quota") {
      return json({ ok: true, ...quotaSnapshot(ip), limit: AUDITS_PER_WINDOW, enforced: QUOTA_ENFORCED, identified: ip !== "" });
    }
    return fail("unknown_action", 404);
  } catch (err) {
    if (err instanceof ServiceNotConfigured) return fail("service_not_configured", 503);
    const message = err instanceof Error ? err.message : "internal_error";
    return fail(message, 502);
  }
}