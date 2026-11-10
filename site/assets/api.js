"use strict";

const API_BASE = "/functions/v1/app";

async function apiJson(action, { method = "GET", params = null, body = null } = {}) {
  const url = new URL(API_BASE, location.origin);
  url.searchParams.set("action", action);
  if (params) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok === false) {
    const code = data && data.error ? data.error : `http_${response.status}`;
    // 额度类错误带 remaining / retry_after_seconds，只留 code 就把「什么时候能再来」丢了。
    const err = new Error(code);
    err.detail = data && data.ok === false ? data : null;
    throw err;
  }
  return data;
}

async function apiPdf(code, year) {
  const url = new URL(API_BASE, location.origin);
  url.searchParams.set("action", "pdf");
  url.searchParams.set("code", code);
  url.searchParams.set("year", String(year));
  const response = await fetch(url);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data && data.error ? data.error : `http_${response.status}`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    title: decodeURIComponent(response.headers.get("X-Report-Title") || ""),
    url: response.headers.get("X-Report-Url") || "",
  };
}

// 只允许巨潮静态域名，避免把响应头里的任意地址变成可点链接。
function safeReportUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "static.cninfo.com.cn" ? parsed.href : "";
  } catch {
    return "";
  }
}

const ERROR_LABEL = {
  service_not_configured: "服务端尚未配置千问密钥（DASHSCOPE_API_KEY），请在 Sites Settings 中录入后重试。",
  no_financial_rows: "未获取到该股票的年度财务数据。",
  empty_mda: "MD&A 文本为空，无法分析。",
  invalid_code: "股票代码格式不正确。",
  unknown_action: "接口不存在。",
  llm_invalid_score: "模型返回的乐观分无法解析，请重试。",
  llm_invalid_json: "模型返回内容不是合法 JSON，请重试。",
  http_504: "后端单次处理超时（网关 504）：这份年报正文过长或上游接口响应偏慢，函数未在一次请求内跑完。可重试一次；若反复出现，请改选较早年度或稍后再试。",
  http_502: "后端处理失败（网关 502），请稍后重试。",
  http_503: "后端暂时不可用（网关 503），请稍后重试。",
};

const PREFIX_LABEL = {
  annual_summary_only: "该年度巨潮只检索到年度报告摘要，没有全文。摘要不含管理层讨论与分析章节，无法做语调审计——请改选上一年度，或确认该公司该年度是否已披露年报全文。",
  annual_pdf_not_found: "未检索到该股该年度的年度报告（全文与摘要均未命中）。请确认年度是否已过披露期，或改选其他年份。",
  cninfo_not_found: "未在巨潮资讯检索到该股票的披露记录。",
  cninfo_no_orgid: "未取到该股票的巨潮机构编码。",
};

// 上游与网关的数字状态码统一转成中文，避免把 http_504 / pdf_http_500 这类内部串直接丢给用户。
const STATUS_LABEL = {
  http: "接口调用失败",
  upstream_http: "东方财富数据接口返回异常",
  cninfo_http: "巨潮资讯接口返回异常",
  pdf_http: "年报 PDF 下载失败",
  dashscope_http: "通义千问服务返回异常",
};

function statusLabel(message) {
  const match = message.match(/^(upstream_http|cninfo_http|pdf_http|dashscope_http|http)_(\d{3})$/);
  if (!match) return null;
  const status = Number(match[2]);
  const suffix = status === 504 || status === 502 || status === 503 ? "（服务端超时或暂不可用）" : "";
  return `${STATUS_LABEL[match[1]]}：HTTP ${match[2]}${suffix}`;
}

// 值得再试一次的错误：网关截断、上游 5xx、模型侧偶发失败，以及并发可能触发的 429 限流。
function isRetryable(err) {
  const message = err && err.message ? err.message : String(err);
  return /_(50[0-9]|429)$/.test(message) || /^(llm_invalid_score|llm_invalid_json|TimeoutError)$/.test(message) ||
    /timeout|abort|network|fetch/i.test(message);
}

function errorText(err) {
  const message = err && err.message ? err.message : String(err);
  if (message === "quota_exceeded") {
    const detail = (err && err.detail) || {};
    const mins = Math.max(1, Math.round(Number(detail.retry_after_seconds || 0) / 60));
    return `今日审计额度已用完（每 IP ${detail.limit || 5} 次/天）。约 ${mins} 分钟后重置。`
      + "此限制按 edge 实例计数，实际重置时间可能更早。";
  }
  if (ERROR_LABEL[message]) return ERROR_LABEL[message];
  const labeled = statusLabel(message);
  if (labeled) return labeled;
  const prefix = Object.keys(PREFIX_LABEL).find((key) => message.startsWith(key));
  if (prefix) return PREFIX_LABEL[prefix];
  if (/未找到|MD&A|no_financial|LookupError/.test(message)) return message;
  if (/timeout|abort|network|fetch/i.test(message)) return "网络请求失败或超时，请稍后重试。";
  return `请求失败：${message}`;
}