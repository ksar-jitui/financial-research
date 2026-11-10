// 客户端 IP 的取法与调用额度。
//
// 实测结论（部署后用 whoami 探针验过）：网关写的 x-real-ip 伪造不了
// （客户端自送 X-Real-IP 会被覆盖），而 x-forwarded-for 最左元素可以由客户端任意前置。
// 所以只认 x-real-ip 这一类网关字段，XFF 只作为缺省兜底并写在诊断里。
export const IP_HEADER_CANDIDATES = [
  "cf-connecting-ip",
  "x-real-ip",
  "x-true-ip",
  "x-client-ip",
  "remote-addr",
  "x-forwarded-for",
];

export function clientIp(req: Request): { ip: string; source: string } {
  for (const name of IP_HEADER_CANDIDATES) {
    const raw = req.headers.get(name);
    if (!raw) continue;
    const value = (name === "x-forwarded-for" ? raw.split(",")[0] : raw).trim();
    if (value) return { ip: value, source: name };
  }
  return { ip: "", source: "none" };
}

// 额度强度必须说清楚它是什么：这是一个 edge 实例内的进程级桶，
// 不跨实例共享、冷启动即清零。它能挡住「打开页面挂脚本循环刷」这一类实际风险，
// 但它不是、也不能被描述成「每个 IP 全局只有 N 次」。
// 真正持久的每 IP 台账需要共享状态（Sites 的 Database 能力），
// 那要改函数形态、建表并配置访问策略，属于需要项目所有者点头的云端变更。
// 总开关。2026-11-10 起启用：站点公开访问后 7 天已有 35 个独立访客，
// 完全不限流等于把模型额度敞开着挂在网上。
// 已知弱点照实记录：实测同一 IP 的连续请求曾读到 used 0 与 used 1 两种结果，
// 所以这是尽力而为的节流，不是硬保证；额度取 20 而不是 5，是为了让认真试用的人撞不到墙。
export const QUOTA_ENFORCED = true;

export const AUDITS_PER_WINDOW = 20;
export const WINDOW_MS = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY = 256;

type Bucket = { windowStart: number; audits: Set<string>; used: number };

const buckets = new Map<string, Bucket>();
let operations = 0;

function bucketFor(ip: string): Bucket {
  const now = Date.now();
  const existing = buckets.get(ip);
  if (existing && now - existing.windowStart < WINDOW_MS) return existing;
  const fresh: Bucket = { windowStart: now, audits: new Set(), used: 0 };
  buckets.set(ip, fresh);
  if (++operations % CLEANUP_EVERY === 0) {
    for (const [key, value] of buckets) {
      if (now - value.windowStart >= WINDOW_MS) buckets.delete(key);
    }
  }
  return fresh;
}

// 一次「完整审计」= 同一 (ip, 股票, 年度) 的一组付费调用。
// tone / facts / leader 是同一个审计的三步，按 3 次扣就等于把额度说成 5/3 次，
// 所以用 dedupe key 去重：同一个审计无论调几步都只扣 1，失败后重试同一步也不重复扣。
export function quotaState(
  ip: string,
  dedupeKey: string,
): { limited: boolean; used: number; remaining: number; resetInMs: number } {
  if (!QUOTA_ENFORCED) return { limited: false, used: 0, remaining: AUDITS_PER_WINDOW, resetInMs: WINDOW_MS };
  // 取不到 IP 时不做限流也不谎称额度已用尽：报「未计数」，让日志与界面都能看出是没识别到来源。
  if (!ip) return { limited: false, used: 0, remaining: AUDITS_PER_WINDOW, resetInMs: WINDOW_MS };
  const bucket = bucketFor(ip);
  const resetInMs = Math.max(0, WINDOW_MS - (Date.now() - bucket.windowStart));
  if (bucket.audits.has(dedupeKey)) {
    return {
      limited: false,
      used: Math.min(bucket.used, AUDITS_PER_WINDOW),
      remaining: Math.max(0, AUDITS_PER_WINDOW - bucket.used),
      resetInMs,
    };
  }
  if (bucket.used >= AUDITS_PER_WINDOW) {
    // 不记入 bucket.used 之外的人数，否则拒绝一次就把额度往下推一格。
    return { limited: true, used: AUDITS_PER_WINDOW, remaining: 0, resetInMs };
  }
  bucket.audits.add(dedupeKey);
  bucket.used += 1;
  return {
    limited: false,
    used: bucket.used,
    remaining: AUDITS_PER_WINDOW - bucket.used,
    resetInMs,
  };
}

export function quotaSnapshot(ip: string) {
  if (!QUOTA_ENFORCED || !ip) return { used: 0, remaining: AUDITS_PER_WINDOW, resetInMs: WINDOW_MS };
  const bucket = bucketFor(ip);
  return {
    used: Math.min(bucket.used, AUDITS_PER_WINDOW),
    remaining: Math.max(0, AUDITS_PER_WINDOW - bucket.used),
    resetInMs: Math.max(0, WINDOW_MS - (Date.now() - bucket.windowStart)),
  };
}
