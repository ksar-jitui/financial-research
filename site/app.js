"use strict";

const state = {
  stock: null,
  allRows: [],
  data: null,
  reportTitle: "",
  reportUrl: "",
  chatMessages: [],
  chatContext: "",
  running: false,
};

const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const node = $("run-status");
  node.textContent = text;
  node.classList.toggle("error", isError);
}

// 可重试的失败（网关截断、上游 5xx、模型偶发异常）直接给出重试入口，而不是让用户自己找按钮。
function setStatusRetryable(text, onRetry) {
  setStatus(text, true);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn-retry";
  button.textContent = "重试这一步";
  button.addEventListener("click", onRetry);
  $("run-status").appendChild(button);
}

function el(tag, attrs, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  return node;
}

const fmtYi = (v) => (v === null || v === undefined ? "缺失" : (v / 1e8).toFixed(2));
const fmtPct = (v) => (v === null || v === undefined ? "缺失" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);

// 同比增速的分母是基期绝对值：基期接近 0、或基期与本期异号时，它不再是「增长率」而是比值
// （-469.59% 的字面意思是本期负值 = 基期正值的 5.7 倍）。这两种退化情形一律退回绝对额表述，
// 百分比只做辅助，口径与 functions/lib/agents.ts 的 declineText / yoyNote 一致。
const signedYi = (v) => `${v < 0 ? "-" : "+"}${(Math.abs(v) / 1e8).toFixed(2)} 亿`;

// 表格用短格式：退化时给绝对额变动，正常时给百分比。
function yoyCell(yoy, prev, cur) {
  if (yoy === null || yoy === undefined) return "—";
  const hasBase = prev !== null && prev !== undefined && cur !== null && cur !== undefined;
  if (hasBase && prev * cur < 0) return prev > 0 ? "由正转负" : "由负转正";
  if (hasBase && Math.abs(yoy) > 1) return signedYi(cur - prev);
  return fmtPct(yoy);
}

// 正文与给模型看的年度行用长格式：保留百分比，但把绝对额放在主位并说明基期。
function yoyNote(yoy, prev, cur) {
  if (yoy === null || yoy === undefined) return "同比缺失";
  const hasBase = prev !== null && prev !== undefined && cur !== null && cur !== undefined;
  if (hasBase && prev * cur < 0)
    return `同比${prev > 0 ? "由正转负" : "由负转正"}（${signedYi(prev)} → ${signedYi(cur)}）`;
  if (hasBase && Math.abs(yoy) > 1)
    return `同比变动 ${signedYi(cur - prev)}（增速 ${fmtPct(yoy)}，基期仅 ${signedYi(prev)}）`;
  return `同比 ${fmtPct(yoy)}`;
}

// 增速的基期就是「上一行」，与后端 eastmoney.ts / data_processing.py 的 shift(1) 完全一致；
// 这里不再做相邻年度判断，否则展示用的基数和后端算出的百分比会对不上。
const prevRow = (arr, i) => (i > 0 ? arr[i - 1] : null);

// 后端只给审计年度的现金流增速，多年表格要自己按同一口径复算：分母取基期绝对值。
const yoyFrac = (arr, i) => {
  const prev = prevRow(arr, i);
  const cur = arr[i];
  if (prev === null || prev === undefined || cur === null || cur === undefined || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
};

/* ---------- 搜索与年度选择 ---------- */

let suggestTimer = null;
let suggestSeq = 0;

async function loadSuggest(query) {
  const seq = ++suggestSeq;
  const box = $("suggest");
  if (!query.trim()) {
    box.classList.remove("open");
    box.textContent = "";
    return;
  }
  try {
    const data = await apiJson("stocks", { params: { q: query.trim() } });
    if (seq !== suggestSeq) return;
    box.textContent = "";
    if (!data.stocks.length) {
      box.classList.remove("open");
      return;
    }
    for (const stock of data.stocks.slice(0, 10)) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      const name = document.createElement("span");
      name.textContent = stock.name;
      const code = document.createElement("span");
      code.className = "code";
      code.textContent = stock.code;
      button.append(name, code);
      button.addEventListener("click", () => selectStock(stock));
      box.appendChild(button);
    }
    box.classList.add("open");
  } catch {
    box.classList.remove("open");
  }
}

async function selectStock(stock) {
  state.stock = stock;
  $("stock-input").value = `${stock.name} ${stock.code}`;
  $("suggest").classList.remove("open");
  const yearSelect = $("year-select");
  yearSelect.disabled = true;
  yearSelect.innerHTML = "<option value=''>加载财务数据…</option>";
  $("run-audit").disabled = true;
  setStatus(`已选择 ${stock.name}（${stock.code}），正在获取年度财务数据…`);
  try {
    const data = await apiJson("financials", { params: { code: stock.code } });
    state.allRows = data.rows;
    yearSelect.textContent = "";
    for (const row of [...data.rows].reverse()) {
      const option = document.createElement("option");
      option.value = String(row.year);
      option.textContent = `${row.year} 年`;
      yearSelect.appendChild(option);
    }
    yearSelect.disabled = false;
    $("run-audit").disabled = false;
    setStatus(`已就绪：${stock.name} 可选年度 ${data.rows[0].year}–${data.rows[data.rows.length - 1].year}，点击“开始审计”。`);
  } catch (err) {
    yearSelect.innerHTML = "<option value=''>财务数据获取失败</option>";
    setStatus(errorText(err), true);
  }
}

/* ---------- 审计进度过场 ---------- */

const AUDIT_STAGES = [
  "获取财务数据",
  "下载年报 PDF",
  "解析 MD&A",
  "扫描整本年报",
  "词典法词频",
  "qwen-plus 打分与事实核对",
  "qwen-max 复核",
];

let stageIndex = 0;
let stageFraction = 0;
let elapsedTimer = null;
let elapsedStart = 0;
let hideTimer = null;

function paintProgress() {
  const nodes = $("run-steps").children;
  for (let i = 0; i < nodes.length; i += 1) {
    nodes[i].className = "step " + (i < stageIndex ? "done" : i === stageIndex ? "active" : "todo");
  }
  const pct = Math.min(99.5, ((stageIndex + stageFraction) / AUDIT_STAGES.length) * 100);
  $("run-bar-fill").style.width = `${pct.toFixed(1)}%`;
  $("run-bar").setAttribute("aria-valuenow", String(Math.round(pct)));
  $("run-count").textContent = `${Math.min(stageIndex + 1, AUDIT_STAGES.length)} / ${AUDIT_STAGES.length}`;
}

function tickElapsed() {
  const s = Math.floor((Date.now() - elapsedStart) / 1000);
  $("run-elapsed").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function beginProgress() {
  stageIndex = 0;
  stageFraction = 0;
  elapsedStart = Date.now();
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const list = $("run-steps");
  list.textContent = "";
  for (const label of AUDIT_STAGES) {
    const li = document.createElement("li");
    li.className = "step todo";
    const dot = document.createElement("span");
    dot.className = "step-dot";
    dot.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "step-label";
    text.textContent = label;
    li.append(dot, text);
    list.appendChild(li);
  }
  $("run-progress").classList.remove("hidden");
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(tickElapsed, 1000);
  tickElapsed();
  paintProgress();
}

function setStage(index, fraction = 0) {
  stageIndex = index;
  stageFraction = fraction;
  paintProgress();
}

// 解析 “解析年报 PDF：40 / 296 页” 这类回调文本，把长步骤细化成连续进度。
function stageProgress(detail) {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(detail);
  if (!match) return;
  const total = Number(match[2]);
  if (total > 0) setStage(stageIndex, Math.min(1, Number(match[1]) / total));
}

function endProgress(mode) {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  if (mode === "success") {
    stageIndex = AUDIT_STAGES.length;
    stageFraction = 0;
    $("run-bar-fill").style.width = "100%";
    $("run-bar").setAttribute("aria-valuenow", "100");
    $("run-count").textContent = `${AUDIT_STAGES.length} / ${AUDIT_STAGES.length}`;
    for (const node of $("run-steps").children) node.className = "step done";
    // 完成后收起过场，结果区本身就是反馈。
    hideTimer = setTimeout(() => {
      $("run-progress").classList.add("hidden");
      hideTimer = null;
    }, 900);
  } else if (mode === "failed") {
    // 失败时保留进度条，让人一眼看出卡在第几步而不是“网站挂了”。
    const nodes = $("run-steps").children;
    if (nodes[stageIndex]) nodes[stageIndex].className = "step failed";
    $("run-progress").classList.add("is-failed");
    $("run-progress").classList.remove("hidden");
  }
}

/* ---------- 审计流水线 ---------- */

async function runAudit() {
  if (state.running || !state.stock) return;
  const year = Number($("year-select").value);
  if (!year) return;
  state.running = true;
  $("run-audit").disabled = true;
  $("result").classList.add("hidden");
  $("run-progress").classList.remove("is-failed");
  beginProgress();
  try {
    setStage(0);
    setStatus(`① 获取 ${state.stock.name} ${year} 年及以前年度财务数据…`);
    const fin = await apiJson("financials", { params: { code: state.stock.code, year } });

    setStage(1);
    setStatus(`② 从巨潮资讯下载 ${year} 年年度报告 PDF（接口限速，请稍候）…`);
    const pdf = await apiPdf(state.stock.code, year);
    state.reportTitle = pdf.title;
    state.reportUrl = safeReportUrl(pdf.url);

    setStage(2);
    setStatus("③ 浏览器本地解析 PDF，提取 MD&A 章节…");
    const { mdaText, pageCount } = await extractMda(pdf.bytes, (d) => { setStatus(d); stageProgress(d); });

    setStage(3);
    setStatus("④ 扫描整份年报正面词密度，渲染 Top-3 整页高亮快照…");
    const densePages = await collectDensePages(pdf.bytes, (d) => { setStatus(d); stageProgress(d); });

    setStage(4);
    setStatus("⑤ 词典法全文词频统计…");
    const lexical = analyzeLexical(mdaText, 0);

    setStage(5);
    setStatus(`⑥ qwen-plus 并行执行：语调虚高打分 + 事实核对（${lexical.paragraphs.length} 段）…`);
    // 事实核对与语调打分各发一次请求：两者只依赖 mdaText，串行会白白多等 20 多秒。
    // 事实核对失败不能拖垮整次审计——它是补充证据，红线判定不依赖它，所以单独收错误。
    const [tone, factsSettled] = await Promise.all([
      // tone / facts / leader 必须带同一组 (code, year)，服务端靠它把三步认成一次审计。
      // 少带一个字段，一次审计就会扣三格，「每 IP 5 次」实际变成「每 IP 1.6 次」。
      apiJson("tone", { method: "POST", body: { mda: mdaText, code: state.stock.code, year } }),
      apiJson("facts", { method: "POST", body: { mda: mdaText, code: state.stock.code, year } })
        .then((value) => ({ ok: true, value }))
        .catch((error) => ({ ok: false, error })),
    ]);
    lexical.llmScore = tone.sentiment_score;
    window.LEXICAL = lexical;
    const facts = factsSettled.ok ? factsSettled.value : null;
    state.factsError = factsSettled.ok ? null : errorText(factsSettled.error);

    setStage(6);
    setStatus("⑦ qwen-max 主审复核：比对背离度、财务分位与事实核对…");
    const leader = await apiJson("leader", {
      method: "POST",
      body: {
        // 带上 (code, year) 让三步共用一个额度去重键；
        // 也要带上 paragraph_count：Leader 侧靠它校验证据引用的段号是否存在，
        // 少了这个字段，越界段号的剔除就成了空转。
        code: state.stock.code,
        year,
        sentiment: {
          sentiment_score: tone.sentiment_score,
          key_claims: tone.key_claims,
          paragraph_count: tone.paragraph_count || 0,
        },
        financial: fin.analysis,
        facts: facts ? { findings: facts.findings, conflicts: facts.conflicts } : null,
      },
    });

    state.data = buildData(fin, tone, leader, year, pageCount, facts);
    state.data.densePages = densePages;
    state.chatMessages = [];
    state.chatContext = buildChatContext();
    renderAll();
    $("result").classList.remove("hidden");
    endProgress("success");
    // 状态行同样只认分档规则给出的标题：这里 state.data 已经建好，不重复构造。
    setStatus(`审计完成：${state.stock.name} ${year} 年 · ${headlineFor(state.data).title}。可下载报告或在审讯室追问。`);
    refreshQuota();
    $("result").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    endProgress("failed");
    if (isRetryable(err)) {
      setStatusRetryable(errorText(err), () => runAudit());
    } else {
      setStatus(errorText(err), true);
    }
  } finally {
    state.running = false;
    $("run-audit").disabled = false;
  }
}

// 解析文本里的段号，支持「第5段」「第5-8段」「第3、7段」「第 12 段」。
// 与 functions/lib/agents.ts 的 citedParagraphs 同法：区间逐个展开并截断，
// 保留末端点；两处的写法一旦分叉，界面上的「能否跳转」就和后端的「是否越界」说的不是同一件事。
const PARAGRAPH_CITATION = /第\s*(\d+(?:\s*[-–—~至、,，]\s*\d+)*)\s*段/g;

function citedParagraphNumbers(text) {
  const out = [];
  for (const match of String(text).matchAll(PARAGRAPH_CITATION)) {
    for (const part of match[1].split(/[、,，]/)) {
      const nums = part.split(/[-–—~至]/).map((v) => Number(v.trim())).filter(Number.isFinite);
      if (nums.length === 1) out.push(nums[0]);
      else if (nums.length >= 2) {
        const low = Math.min(...nums);
        const high = Math.max(...nums);
        for (let v = low; v <= Math.min(high, low + 50); v++) out.push(v);
        if (high > low + 50) out.push(high);
      }
    }
  }
  return out;
}


function buildData(fin, tone, leader, year, pageCount, facts) {
  const rows = fin.rows;
  const analysis = fin.analysis;
  // 与后端 citedParagraphs 同一套写法识别：模型会写「第41–45段」「第3、7段」「第 12 段」。
  // 之前只认「第N段」，于是区间写法明明引用了真实段落，前端却把它算成「无段号、点不动」，
  // 既少了一半锚点，又让可核性说明报出一个错的原因。
  const toTarget = (text) => {
    const cited = citedParagraphNumbers(String(text));
    if (cited.length) return `mda-p-${cited[0]}`;
    if (/财务指标|财务数据|CSV|年报财务/.test(String(text))) return `fin-row-${year}`;
    return null;
  };
  return {
    company: state.stock.name,
    code: state.stock.code,
    year,
    pageCount,
    sentiment: tone.sentiment_score,
    toneMeta: {
      runs: tone.runs || 1,
      passScores: tone.pass_scores || [],
      spread: typeof tone.score_spread === "number" ? tone.score_spread : null,
      chunks: tone.chunks || 0,
      unstableChunks: tone.unstable_chunks || 0,
      claimsRejected: tone.claims_rejected ?? 0,
      claimsFolded: tone.claims_folded ?? 0,
      paragraphCount: tone.paragraph_count || 0,
    },
    health: analysis.health_score,
    healthLevel: analysis.health_level,
    rawHealth: analysis.raw_health_score,
    healthSaturated: analysis.health_saturated === true,
    changeScore: typeof analysis.change_score === "number" ? analysis.change_score : null,
    band: analysis.band || null,
    industry: fin.industry || (analysis.band && analysis.band.industry) || "",
    divergence: leader.divergence || null,
    anomaly: leader.anomaly,
    reason: leader.reason,
    years: rows.map((r) => r.year),
    revenue: rows.map((r) => r.revenue),
    netProfit: rows.map((r) => r.netProfit),
    cashflow: rows.map((r) => r.operatingCashflow),
    revenueYoY: rows.map((r) => r.revenueYoY),
    npYoY: rows.map((r) => r.netProfitYoY),
    cashToProfitApplicable: analysis.metrics.cash_to_profit_applicable !== false,
    orgType: analysis.metrics.org_type || "",
    quality: analysis.metrics,
    fScore: analysis.f_score,
    evidence: (leader.evidence_links || []).map((text) => ({ text: String(text), target: toTarget(text) })),
    evidenceAudit: {
      droppedShells: leader.evidence_dropped_shells ?? 0,
      filled: leader.evidence_filled || [],
    },
    claims: (tone.key_claims || []).map((text) => ({ text: String(text), target: toTarget(text) })),
    facts: facts
      ? {
          findings: facts.findings || [],
          conflicts: facts.conflicts || [],
          excerptCount: facts.excerptCount,
          candidateCount: facts.candidateCount,
          totalParagraphs: facts.totalParagraphs,
          excerptChars: facts.excerptChars,
          runs: facts.runs === 2 ? 2 : 1,
        }
      : null,
  };
}

/* ---------- 渲染 ---------- */

/* ---------- 分位带与背离度 ---------- */

// 参照分布的元数据从函数侧取，不写死在页面文案里：
// 阈值和样本量必须与后端判定时用的是同一份，否则界面上的解释就成了二手说法。
let BAND_META = null;

async function refreshQuota() {
  const el = $("quota-line");
  if (!el) return;
  try {
    const q = await apiJson("quota");
    // 额度没启用时这一行就不该出现：显示「剩余 5/5」会让人以为存在一个不存在的约束。
    if (!q.enforced) {
      el.textContent = "";
      el.classList.remove("quota-low");
      return;
    }
    el.textContent = q.identified
      ? `今日剩余额度：完整审计 ${q.remaining}/${q.limit}，审讯提问 ${q.chatRemaining}/${q.chatLimit}（按 IP 计数）`
      : `额度未能按 IP 计数（审计 ${q.limit} 次/天、提问 ${q.chatLimit} 条/天）`;
    el.classList.toggle("quota-low", q.remaining === 0 || q.chatRemaining === 0);
  } catch {
    // 额度读数拿不到不影响主流程，但必须留下痕迹，不能显示成「没有限制」。
    el.textContent = "额度读数暂时取不到。";
  }
}


async function loadBands() {
  try {
    const b = await apiJson("bands");
    BAND_META = b;
    const set = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text;
    };
    set("ref-universe", String(b.universe));
    set("ref-companies", String(b.companies));
    set("ref-observations", String(b.observations));
    set("ref-changes", String(b.change_observations));
    set("ref-years", b.main_years.join("、"));
    set("ref-date", b.generated_at);
    set("min-industry-n", String(b.min_industry_observations));
    set("industry-count", String((b.industries || []).length));
    set("industry-obs", String((b.industries || []).reduce((sum, g) => sum + g.n, 0)));
    set("cut-red", String(b.cuts.red));
    set("cut-red-echo", String(b.cuts.red));
    set("cut-amber", String(b.cuts.amber));
    const all = b.groups["全市场"];
    if (b.weakness) {
      set("basis-n", String(b.weakness.n));
      const pick = (list, q) => {
        const hit = (list || []).find(([p]) => p === q);
        return hit ? hit[1] : null;
      };
      set(
        "basis-quantiles",
        [10, 25, 50, 75, 90].map((q) => `p${q}=${pick(b.weakness.grid, q)}`).join("　"),
      );
      set(
        "basis-rates",
        (b.basis || [])
          .map((row) => `语调 ${row.tone} → ${row.red_rate === null ? "—" : row.red_rate.toFixed(1)}%`)
          .join("　"),
      );
    }
    if (all) {
      // 量纲跨度是「为什么用百分位相减」的那条算术依据，直接取实测值而不是写死在文案里。
      set("ref-spread", String(all.level.spread));
      set("ref-p50-all", String(all.level.p50));
    }
    const ent = b.groups["实体"];
    const fin = b.groups["金融"];
    set("ref-p25-entity", ent ? String(ent.level.p25) : "（样本不足，用全市场带）");
    set("ref-p25-financial", fin ? String(fin.level.p25) : "（样本不足，用全市场带）");
    set("ref-c25-entity", ent ? String(ent.change.p25) : "—");
    set("ref-c25-financial", fin ? String(fin.change.p25) : "—");
  } catch {
    // 方法论数字拉不到只影响说明区，不影响审计主流程；留一行明确提示而不是静默空白。
    const el = $("reference-note");
    if (el) el.textContent += "（本轮未能取到参照分布元数据，下方数字未刷新。）";
  }
}

const GRADE_META = {
  red: { cls: "grade-red", pill: "pill-red", label: "红线 · 背离" },
  amber: { cls: "grade-amber", pill: "pill-amber", label: "黄线 · 需核查" },
  green: { cls: "grade-green", pill: "pill-green", label: "绿线 · 未见缺口" },
  uncalibrated: { cls: "grade-unknown", pill: "pill-amber", label: "未标定" },
};

function fmtPct2(v) {
  return typeof v === "number" ? v.toFixed(2) : "—";
}


function pctText(v) {
  return typeof v === "number" ? `第 ${v.toFixed(1)} 百分位` : "未能定位";
}

// 参照带来源：把「用的是哪一组、组内多少观测」写在数字旁边，
// 让读者能当场判断这个分位是可用的还是退回全市场凑出来的。
function bandSourceText(D) {
  const b = D.band;
  if (!b) return "";
  const kind =
    b.group_kind === "industry"
      ? `一级板块「${b.industry || b.group_key}」`
      : b.group_kind === "org"
        ? "实体/金融分组"
        : b.group_kind === "market"
          ? "全市场"
          : "未标定";
  const quality = b.quality_tier
    ? `；毛利率 ${fmtPct2(b.quality && b.quality.gross_margin)}% 与净利率 ${fmtPct2(
        b.quality && b.quality.net_margin,
      )}% 同时处于行业前 5%（优质档）`
    : "";
  return `；分位带取自${kind}（${b.group_n} 个观测，生成于 ${b.reference_generated_at}）${quality}`;
}

function bandLine(D) {
  const b = D.band;
  if (!b) return "";
  return `，水平分位于${pctText(b.level_percentile)}`;
}

function reportBandLine(D) {
  const b = D.band;
  if (!b) return "";
  return `，位于${pctText(b.level_percentile)}${bandSourceText(D)}`;
}

function renderDivergenceCards(D) {
  const G = D.divergence;
  const gm = GRADE_META[(G && G.grade) || "uncalibrated"] || GRADE_META.uncalibrated;
  const card = $("m-div-card");
  card.classList.remove("grade-red", "grade-amber", "grade-green", "grade-unknown");
  card.classList.add(gm.cls);
  $("m-divergence").textContent = G && typeof G.divergence === "number" ? G.divergence.toFixed(2) : "—";
  const gradePill = $("m-div-grade");
  gradePill.className = `metric-pill ${gm.pill}`;
  gradePill.textContent =
    G && G.downgraded && G.raw_grade
      ? `${gm.label}（优质档降档，原 ${G.raw_grade}）`
      : gm.label;
  $("m-div-hint").textContent = G && G.divergence !== null && G.divergence !== undefined
    ? `${(G.reasons || []).join("；")}`
    : "本轮未取得可定位的财务分位，判定不作结论。";

  $("m-health").textContent = D.health.toFixed(2);
  $("m-health-link").href = `#fin-row-${D.year}`;
  const lp = D.band ? D.band.level_percentile : null;
  const levelPill = $("m-health-level");
  levelPill.className = `metric-pill ${lp === null ? "pill-red" : lp <= 25 ? "pill-red" : lp < 50 ? "pill-amber" : "pill-green"}`;
  levelPill.textContent = `${D.healthLevel} · ${pctText(lp)}`;
  $("m-health-hint").textContent = D.healthSaturated
    ? `规则引擎原始分 ${D.rawHealth.toFixed(2)}，已${D.health === 0 ? "触及 0 下限" : "触及 100 上限"}后截断显示为 ${D.health.toFixed(2)}；分位数按原始分算，不受截断影响${bandSourceText(D)}`
    : `规则引擎：营收/利润增速 + 经营现金流与净现比 + 扣非结构 + F-Score${bandSourceText(D)}`;

  const cs = D.changeScore;
  const cp = D.band ? D.band.change_percentile : null;
  $("m-change").textContent = cs === null ? "—" : `${cs > 0 ? "+" : ""}${cs.toFixed(2)}`;
  const changePill = $("m-change-level");
  changePill.className = `metric-pill ${cs === null ? "pill-amber" : cp === null ? "pill-amber" : cp <= 25 ? "pill-red" : cp >= 75 ? "pill-green" : "pill-amber"}`;
  changePill.textContent = cs === null ? "无可比上一年" : cp === null ? "未能定位" : cp <= 25 ? "同比恶化" : cp >= 75 ? "同比改善" : "基本持平";
  $("m-change-hint").textContent = cs === null
    ? "缺少相邻上一年的年报行，无法给出恶化幅度；不拿 0 冒充「持平」。"
    : `同规则在少一年的窗口上重算，差值 ${cs.toFixed(2)} 分，${pctText(cp)}`;
}

// 标题一律按分档规则给结论，不按模型自判：两者来源不同，同屏出现「绿灯 + 发现背离」就是自相矛盾。
// 不一致本身不藏，写在理由里。
function headlineFor(D) {
  const grade = (D.divergence && D.divergence.grade) || (D.anomaly ? "red" : "green");
  const map = {
    red: ["审计预警", "发现语调与财务背离"],
    amber: ["需核查", "表述与基本面存在缺口"],
    green: ["匹配正常", "未发现显著语调背离"],
    uncalibrated: ["未标定", "参照分布未能定位，本轮不给出分档结论"],
  };
  const [stamp, title] = map[grade] || map.green;
  return { stamp, title, grade };
}


function renderAll() {
  const D = state.data;
  document.title = `年报语调操纵审计 Agent · ${D.company} ${D.code} ${D.year} 审计档案`;
  $("case-title").innerHTML = "";
  $("case-title").append(document.createTextNode(`${D.company} `));
  const codeSpan = document.createElement("span");
  codeSpan.className = "mono";
  codeSpan.textContent = D.code;
  $("case-title").appendChild(codeSpan);
  $("case-meta").textContent =
    `审计年度 ${D.year} · 财务数据区间 ${D.years[0]}–${D.years[D.years.length - 1]} · ` +
    `年报《${state.reportTitle || `${D.year} 年年度报告`}》（${D.pageCount} 页） · 数据源 东方财富 / 巨潮资讯 · 模型 qwen-plus / qwen-max`;

  const head = headlineFor(D);
  $("verdict-stamp").textContent = head.stamp;
  $("verdict-title").textContent = head.title;
  $("verdict-reason").textContent = D.reason;
  $("verdict").classList.toggle("is-ok", head.grade === "green");

  $("m-sentiment").textContent = D.sentiment.toFixed(2);
  // 两遍独立打分的差就是这条分的可复现范围；档位边界附近这个数会直接影响结论，必须显示。
  const TM = D.toneMeta || {};
  const meta = $("m-sentiment-meta");
  if (meta) {
    meta.textContent = TM.spread === null || TM.spread === undefined
      ? "（两遍独立打分未全部成功，本轮分数未经复现）"
      : `（两遍独立打分 ${TM.passScores.map((v) => v.toFixed(2)).join(" / ")}，差 ${TM.spread.toFixed(2)}；` +
        `${TM.chunks} 块中 ${TM.unstableChunks} 块块内分歧 >5）`;
  }
  $("m-sentiment-bar").style.width = `${Math.min(100, D.sentiment)}%`;
  renderDivergenceCards(D);
  const L = window.LEXICAL;
  $("m-lexical").textContent = L.lexicalScore.toFixed(1);
  $("m-lexical-hint").textContent = L.lowSample
    ? `情绪词命中仅 ${L.toneTotal} 次，占比对单个词高度敏感，仅作参考`
    : "正面词 ÷（正面+不利词），情绪词构成比，非乐观程度";
  $("m-neghits").textContent = String(L.negativeHits);
  $("m-neghits-hint").textContent = `正面词 ${L.positiveHits} 次 · 风险披露词 ${L.riskHits} 次单列`;

  renderYoYChart();
  renderRevenueChart();
  renderTable();
  renderQuality();
  renderLists();
  renderFacts();
  renderDenseGallery();
  renderLexical();
  renderDensityStrip();
  initEvidenceLinks();
  renderChat();
  initReport();
}

function renderYoYChart() {
  const D = state.data;
  const svg = $("chart-yoy");
  svg.textContent = "";
  const values = D.npYoY.map((v) => (v === null ? null : v * 100));
  // 基期接近 0 时同比会算出 -1700% 这种量级，直接进坐标会把其余年份压成一条线；
  // 轴固定截到 ±200%，超出的柱子贴边画，具体数值改由绝对额变动说明。
  const CLAMP = 200;
  const shown = values.map((v) => (v === null ? null : Math.max(-CLAMP, Math.min(CLAMP, v))));
  const present = shown.filter((v) => v !== null);
  const max = Math.max(0, ...present) + 5;
  const min = Math.min(0, ...present) - 5;
  const top = 18, bottom = 34, left = 44, right = 12;
  const width = 520, height = 240;
  const plotH = height - top - bottom;
  const yOf = (v) => top + ((max - v) / (max - min)) * plotH;
  const zeroY = yOf(0);
  const band = (width - left - right) / D.years.length;
  svg.appendChild(el("line", { x1: left, y1: zeroY, x2: width - right, y2: zeroY, class: "zero-line" }));
  D.years.forEach((year, i) => {
    const raw = values[i];
    const cx = left + band * i + band / 2;
    if (raw !== null) {
      const v = shown[i];
      const clipped = Math.abs(raw) > CLAMP;
      const prevProfit = prevRow(D.netProfit, i);
      const barW = Math.min(46, band * 0.55);
      const y = v >= 0 ? yOf(v) : zeroY;
      const h = Math.abs(yOf(v) - zeroY);
      const bar = el("rect", { x: cx - barW / 2, y, width: barW, height: Math.max(h, 1), class: v >= 0 ? "bar-pos" : "bar-neg", rx: 3 });
      bar.appendChild(
        el(
          "title",
          {},
          clipped
            ? `${year} 年归母净利润${yoyNote(raw / 100, prevProfit, D.netProfit[i])}（基期过小，增速已截断显示）`
            : `${year} 年净利润同比 ${raw >= 0 ? "+" : ""}${raw.toFixed(2)}%`,
        ),
      );
      svg.appendChild(bar);
      svg.appendChild(
        el(
          "text",
          { x: cx, y: v >= 0 ? y - 6 : y + h + 14, "text-anchor": "middle", class: "bar-value", fill: v >= 0 ? "#16a34a" : "#dc2626" },
          clipped ? `${raw >= 0 ? ">" : "<"}${CLAMP}%` : `${raw >= 0 ? "+" : ""}${raw.toFixed(2)}`,
        ),
      );
    } else {
      svg.appendChild(el("text", { x: cx, y: zeroY - 8, "text-anchor": "middle", class: "bar-value", fill: "#94a3b8" }, "—"));
    }
    svg.appendChild(el("text", { x: cx, y: height - 10, "text-anchor": "middle", class: "bar-label" }, String(year)));
  });
  $("chart-yoy-sub").textContent = `区间 ${D.years[0]}–${D.years[D.years.length - 1]}；首年无上年基数记为缺失；超出 ±${CLAMP}% 的柱子截断贴边，鼠标悬停看绝对额变动`;
}

function renderRevenueChart() {
  const D = state.data;
  const svg = $("chart-rev");
  svg.textContent = "";
  const values = D.revenue.map((v) => (v === null ? null : v / 1e8));
  const present = values.filter((v) => v !== null);
  const max = Math.max(...present) * 1.06;
  const min = Math.min(...present) * 0.94;
  const top = 18, bottom = 34, left = 52, right = 16;
  const width = 520, height = 240;
  const plotH = height - top - bottom;
  const yOf = (v) => top + ((max - v) / (max - min)) * plotH;
  const step = (width - left - right) / Math.max(1, D.years.length - 1);
  svg.appendChild(el("line", { x1: left, y1: height - bottom, x2: width - right, y2: height - bottom, class: "axis-line" }));
  const pts = [];
  values.forEach((v, i) => { if (v !== null) pts.push([left + step * i, yOf(v), i]); });
  svg.appendChild(el("path", { d: "M" + pts.map((p) => `${p[0]},${p[1]}`).join(" L"), class: "rev-line" }));
  pts.forEach(([x, y, i]) => {
    const dot = el("circle", { cx: x, cy: y, r: 4.5, class: "rev-dot" });
    dot.appendChild(el("title", {}, `${D.years[i]} 年营业收入 ${values[i].toFixed(2)} 亿元`));
    svg.appendChild(dot);
    svg.appendChild(el("text", { x, y: y - 10, "text-anchor": "middle", class: "bar-value", fill: "#2563eb" }, values[i].toFixed(0)));
  });
  D.years.forEach((year, i) => {
    svg.appendChild(el("text", { x: left + step * i, y: height - 10, "text-anchor": "middle", class: "bar-label" }, String(year)));
  });
  const last = D.revenueYoY.length - 1;
  $("chart-rev-sub").textContent = `最新年度 ${fmtYi(D.revenue[last])} 亿元，${yoyNote(D.revenueYoY[last], prevRow(D.revenue, last), D.revenue[last])}`;
}

function renderTable() {
  const D = state.data;
  const tbody = document.querySelector("#fin-table tbody");
  tbody.textContent = "";
  D.years.forEach((year, i) => {
    const tr = document.createElement("tr");
    tr.id = `fin-row-${year}`;
    if (year === D.year) tr.classList.add("audit-row");
    const profit = D.netProfit[i];
    const cash = D.cashflow[i];
    const ratio = profit !== null && profit > 0 && cash !== null ? cash / profit : null;
    const cells = [
      ["num", String(year)],
      ["num", fmtYi(D.revenue[i])],
      ["num", fmtYi(profit)],
      ["num", fmtYi(cash)],
      [`num ${ratio !== null && ratio < 1 ? "neg" : "pos"}`, ratio === null ? "缺失" : ratio.toFixed(2)],
      [`num ${D.revenueYoY[i] !== null && D.revenueYoY[i] < 0 ? "neg" : "pos"}`, yoyCell(D.revenueYoY[i], prevRow(D.revenue, i), D.revenue[i])],
      [`num ${D.npYoY[i] !== null && D.npYoY[i] < 0 ? "neg" : "pos"}`, yoyCell(D.npYoY[i], prevRow(D.netProfit, i), D.netProfit[i])],
    ];
    for (const [cls, text] of cells) {
      const td = document.createElement("td");
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  $("table-note-year").textContent = `${D.year} 行为本次审计年度，`;
}

const FSCORE_LABEL = {
  "盈利（ROA 为正）": "当期 ROA 为正，基础盈利成立",
  "经营现金流为正": "经营活动现金流净额为正",
  "ROA 同比改善": "资产回报率较上年提升",
  "现金流不低于净利润": "经营现金流覆盖归母净利润（应计未扩张）",
  "负债率同比下降": "资产负债率较上年下降",
  "流动比率改善": "短期偿债能力改善",
  "股本未被摊薄": "股本未通过增发摊薄",
  "毛利率改善": "毛利率较上年提升",
  "总资产周转率改善": "资产使用效率提升",
};

function renderQuality() {
  const D = state.data;
  const Q = D.quality;
  const ratio = Q.cash_to_profit;
  const applicable = D.cashToProfitApplicable;
  $("quality-sub").textContent =
    `${D.company}（${D.orgType || "一般企业"}）${D.year} 年归母净利润 ${fmtYi(Q.net_profit)} 亿元，` +
    `经营活动现金流净额 ${fmtYi(Q.operating_cashflow)} 亿元，` +
    `净现比 ${ratio === null ? "无法计算" : `${ratio.toFixed(2)} 倍`}` +
    (ratio !== null && applicable
      ? ratio < 1
        ? `——每 1 元账面利润只有 ${ratio.toFixed(2)} 元现金流入，差额由应收、存货等应计项目构成，需核查收入确认与回款质量。`
        : "——账面利润已被经营现金流完整覆盖，盈利含金量较高。"
      : "。");

  const cards = [
    ["净现比（现金流÷净利润）", ratio === null ? "缺失" : ratio.toFixed(2), applicable ? "≥1 为现金充分覆盖" : "金融类不计分"],
    ["经营现金流同比", yoyCell(Q.cashflow_yoy, prevRow(D.cashflow, D.years.length - 1), Q.operating_cashflow), "收付实现制的现金变动"],
    ["扣非归母净利润", `${fmtYi(Q.deducted_net_profit)} 亿`, Q.net_profit ? `占归母 ${((Q.deducted_net_profit / Q.net_profit) * 100).toFixed(1)}%` : "剔除一次性损益"],
    ["Piotroski F-Score", `${D.fScore.total}/${D.fScore.valid}`, "有效项中通过的项数"],
  ];
  const wrap = $("quality-metrics");
  wrap.textContent = "";
  cards.forEach(([label, value, hint]) => {
    const card = document.createElement("div");
    card.className = "lex-metric";
    for (const [cls, text] of [["metric-label", label], ["metric-value mono", value], ["metric-hint", hint]]) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      card.appendChild(span);
    }
    wrap.appendChild(card);
  });

  const list = $("fscore-items");
  list.textContent = "";
  D.fScore.items.forEach((item) => {
    const li = document.createElement("li");
    const state = item.result === null ? "na" : item.result ? "pass" : "fail";
    li.className = `fscore-item fs-${state}`;
    const badge = document.createElement("span");
    badge.className = "fscore-badge mono";
    badge.textContent = item.result === null ? "不适用" : item.result ? "通过" : "未通过";
    const name = document.createElement("span");
    name.className = "fscore-name";
    name.textContent = item.name;
    const desc = document.createElement("span");
    desc.className = "fscore-desc";
    desc.textContent = FSCORE_LABEL[item.name] || "";
    li.append(badge, name, desc);
    list.appendChild(li);
  });
  $("fscore-note").textContent =
    `九项中 ${D.fScore.valid} 项有可比数据，通过 ${D.fScore.total} 项。` +
    `${D.fScore.total <= 2 ? "F-Score 处于 Piotroski 定义的薄弱区（0–2），基本面多项恶化。" : D.fScore.total >= 7 ? "F-Score 处于强劲区（7–9），支持管理层乐观表述。" : "F-Score 处于中间区，需结合现金流与扣非结构判断。"}` +
    (D.fScore.valid < 9 ? ` 银行/券商等业务不适用流动比率、毛利率等指标，已从有效项中剔除。` : "");
}

function appendEvidenceItem(list, item) {
  const li = document.createElement("li");
  if (item.target) {
    const a = document.createElement("a");
    a.href = `#${item.target}`;
    a.className = "ev-jump";
    a.textContent = item.text;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      gotoEvidence(item.target, a);
    });
    li.appendChild(a);
  } else {
    li.textContent = item.text;
  }
  list.appendChild(li);
}

const DIRECTION_CLASS = { 利好: "fd-good", 利空: "fd-bad", 中性: "fd-flat", 证据不足: "fd-weak", 分歧: "fd-split" };

// 报告与审讯室共用同一份事实核对摘要，避免两处口径写岔。
function factsContextLine(D) {
  const F = D.facts;
  if (!F) return "事实核对：未完成，本轮判定不依赖该栏。";
  const items = F.findings
    .map((f) => `${f.metric}（${f.period}）→ ${f.direction}${f.agreed === false ? "（未经两次复现，不作为结论）" : ""}；` +
      `事实「${f.fact}」，原因归属 ${f.causeType || "未披露"}，${f.inference}`)
    .join("　|　");
  return `事实核对（第三个 Agent，不打分不评语调，只判每项重要变化的事实方向；独立核对两次，方向一致才作为结论）：${items || "无可核对的量化变化"}。` +
    `${F.conflicts.length ? `证据冲突或不足：${F.conflicts.join("；")}。` : ""}` +
    `判定依据是指标、口径、原因与交叉一致性，明确不按「增长/下降/改善/减少」的词面正负面推方向。`;
}

function factsReportLines(D) {
  const F = D.facts;
  if (!F) return ["", "## 事实核对（第三个 Agent）", "", "本轮未完成事实核对，审计结论不依赖该栏。"];
  const lines = [
    "",
    "## 事实核对（第三个 Agent）",
    "",
    `确定性摘录 ${F.excerptCount} 段（候选 ${F.candidateCount} 段 / MD&A 共 ${F.totalParagraphs} 段，${F.excerptChars} 字符）。` +
      (F.runs === 2
        ? "qwen-plus 独立核对两次并交叉复核：两次方向一致才计入结论，不一致标为「分歧」。"
        : "两次独立核对只有一次返回，本轮全部方向未经复现，仅作待核查线索。") +
      "方向由指标、口径、原因归属与交叉一致性推出，不按情绪词词面判定。",
    "",
  ];
  if (!F.findings.length) lines.push("- 模型认为没有可核对的量化经营变化（返回空清单）。");
  for (const f of F.findings) {
    lines.push(
      `### ${f.metric} ｜ ${f.direction}${f.agreed === false ? "（未复现）" : ""}`,
      "",
      `- 复现情况：${f.agreed === true ? "两次独立核对方向一致" : f.direction === "分歧" ? "两次独立核对方向不一致，不作为结论" : "仅一次核对返回，未经复现"}`,
      `- 类别与口径：${f.category} ｜ ${f.period}`,
      `- 事实：${f.fact}`,
      `- 公司解释：${f.companyExplanation || "未披露"}（原因归属：${f.causeType || "未披露"}）`,
      `- 一致性核对：${f.consistency}`,
      `- 推断：${f.inference}`,
      `- 出处：${(f.paragraphs || []).map((n) => `第${n}段`).join("、") || "未标注段号"}`,
      "",
    );
  }
  if (F.conflicts.length) {
    lines.push("证据冲突或不足：", "");
    for (const c of F.conflicts) lines.push(`- ${c}`);
    lines.push("");
  }
  return lines;
}

function renderFacts() {
  const D = state.data;
  const box = $("facts");
  const F = D.facts;
  if (!F) {
    box.classList.remove("hidden");
    // errorText 的句子自带句末标点，再拼一个「。」会变成「。。」这种看得出的拼接痕迹。
    const reason = state.factsError || "上游未返回结果";
    $("facts-sub").textContent =
      `事实核对未完成：${reason.replace(/[。！？]$/, "")}。其余审计结论不受影响——红线判定不依赖这一栏。`;
    $("facts-list").textContent = "";
    $("facts-conflicts").textContent = "";
    return;
  }
  $("facts-sub").textContent =
    `确定性摘录 ${F.excerptCount} 段（候选 ${F.candidateCount} 段，MD&A 共 ${F.totalParagraphs} 段，` +
    `${F.excerptChars.toLocaleString()} 字符），qwen-plus ${F.runs === 2 ? "独立核对两次并交叉复核" : "单次核对（第二次未返回，方向未经复现）"}，` +
    `得出 ${F.findings.length} 条重要变化判定` +
    `${F.conflicts.length ? `，以及 ${F.conflicts.length} 条证据冲突或不足` : ""}。` +
    `方向由指标、口径、原因和交叉一致性推出，不由词面正负面推出；` +
    `两次判定不一致的条目一律标为「分歧」，不作为结论。`;

  const list = $("facts-list");
  list.textContent = "";
  F.findings.forEach((item) => {
    const li = document.createElement("li");
    li.className = "fact-item";
    const badge = document.createElement("span");
    badge.className = `fact-dir mono ${DIRECTION_CLASS[item.direction] || "fd-weak"}`;
    badge.textContent = item.direction || "证据不足";
    if (item.agreed === false && item.direction !== "分歧") {
      badge.title = "只有一次核对返回该条，方向未经复现，不作为结论";
    } else if (item.agreed === true) {
      badge.title = "两次独立核对给出相同方向";
    } else {
      badge.title = "两次独立核对给出不同方向，本条不作为结论";
    }
    li.appendChild(badge);

    const head = document.createElement("p");
    head.className = "fact-head";
    const metric = document.createElement("strong");
    metric.textContent = item.metric || "未命名指标";
    head.appendChild(metric);
    const meta = document.createElement("span");
    meta.className = "fact-meta mono";
    meta.textContent = [item.category, item.period].filter(Boolean).join(" · ");
    head.appendChild(meta);
    li.appendChild(head);

    for (const [label, text] of [
      ["事实", item.fact],
      ["公司解释", item.companyExplanation],
      ["原因归属", item.causeType],
      ["一致性核对", item.consistency],
      ["推断", item.inference],
    ]) {
      if (!text) continue;
      const row = document.createElement("p");
      row.className = "fact-row";
      const key = document.createElement("span");
      key.className = "fact-key";
      key.textContent = label;
      row.appendChild(key);
      row.appendChild(document.createTextNode(text));
      li.appendChild(row);
    }

    const chips = document.createElement("span");
    chips.className = "fact-paras";
    (item.paragraphs || []).slice(0, 6).forEach((n) => {
      const a = document.createElement("a");
      a.href = `#mda-p-${n}`;
      a.className = "para-chip mono";
      a.textContent = n;
      a.title = `跳转到 MD&A 第 ${n} 段`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        gotoEvidence(`mda-p-${n}`);
      });
      chips.appendChild(a);
    });
    li.appendChild(chips);
    list.appendChild(li);
  });
  if (!F.findings.length) {
    const li = document.createElement("li");
    li.className = "fact-empty";
    li.textContent = "模型认为该篇 MD&A 没有可核对的量化经营变化（返回空清单）。这本身是一条信息，不强行凑结论。";
    list.appendChild(li);
  }

  const conflicts = $("facts-conflicts");
  conflicts.textContent = "";
  F.conflicts.forEach((text) => {
    const p = document.createElement("p");
    p.className = "fact-conflict";
    p.textContent = `⚠ ${text}`;
    conflicts.appendChild(p);
  });
}

function renderDenseGallery() {
  const gallery = $("dense-gallery");
  gallery.textContent = "";
  const pages = state.data.densePages || [];
  pages.forEach((item) => {
    const figure = document.createElement("figure");
    figure.className = "dense-item";
    const caption = document.createElement("figcaption");
    caption.className = "mono";
    caption.textContent = `P.${item.page} · ${item.hits} 处高亮`;
    // 点开只看这一页的高亮大图；整份年报留在显式入口，避免一点就加载十几 MB。
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dense-link";
    button.setAttribute("aria-label", `放大查看年报第 ${item.page} 页高亮快照，命中 ${item.hits} 处正面语气词`);
    const img = document.createElement("img");
    img.src = item.dataUrl;
    img.alt = `年报第 ${item.page} 页整页高亮，命中 ${item.hits} 处正面语气词`;
    // 用后端返回的真实渲染尺寸声明比例：解码前就能定宽，避免 fit-content 框塌成 1px。
    if (item.width && item.height) img.style.aspectRatio = `${item.width} / ${item.height}`;
    const badge = document.createElement("span");
    badge.className = "dense-open";
    badge.textContent = "放大查看";
    button.append(img, badge);
    button.addEventListener("click", () => openLightbox(item));
    figure.append(button, caption);
    gallery.appendChild(figure);
  });
  const total = pages.reduce((sum, item) => sum + item.hits, 0);
  $("dense-caption").textContent =
    `浏览器端 pdf.js 对整份 ${state.data.year} 年报逐页统计正面语气词命中，取最密集的 ${pages.length} 页整页渲染并高亮` +
    `（合计 ${total} 处），直观呈现乐观措辞的分布密度；高亮位置来自 PDF 文字坐标，与词典法同一词表。` +
    "点击任一快照放大查看该页；需要核对整份原文请用上方“在巨潮资讯打开完整年报 PDF”。";
  const openLink = $("pdf-open");
  if (state.reportUrl) {
    openLink.href = state.reportUrl;
    openLink.classList.remove("hidden");
  } else {
    openLink.classList.add("hidden");
  }
}

/* ---------- 快照放大层（缩放 + 平移） ---------- */

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;

let lightboxReturnFocus = null;
let zoom = 1;
let panX = 0;
let panY = 0;
let dragState = null;

function applyTransform() {
  const stage = $("lightbox-stage");
  const img = $("lightbox-img");
  // 平移量限制在溢出范围内，避免把图片拖出可视区后“丢失”。
  const box = stage.getBoundingClientRect();
  const maxX = Math.max(0, (img.offsetWidth * zoom - box.width) / 2);
  const maxY = Math.max(0, (img.offsetHeight * zoom - box.height) / 2);
  panX = Math.max(-maxX, Math.min(maxX, panX));
  panY = Math.max(-maxY, Math.min(maxY, panY));
  img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  $("zoom-level").textContent = `${Math.round(zoom * 100)}%`;
  stage.classList.toggle("is-zoomed", zoom > ZOOM_MIN);
}

function resetView() {
  zoom = ZOOM_MIN;
  panX = 0;
  panY = 0;
  applyTransform();
}

// 以指针为锚点缩放：缩放前后该屏幕点对应的图像点保持不变，否则放大时内容会乱窜。
function setZoom(next, clientX, clientY) {
  const stage = $("lightbox-stage");
  const box = stage.getBoundingClientRect();
  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;
  const z1 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
  if (z1 === zoom) return;
  const cx = (clientX === undefined ? centerX : clientX) - centerX;
  const cy = (clientY === undefined ? centerY : clientY) - centerY;
  const px = (cx - panX) / zoom;
  const py = (cy - panY) / zoom;
  zoom = z1;
  panX = cx - px * zoom;
  panY = cy - py * zoom;
  applyTransform();
}

function openLightbox(item) {
  lightboxReturnFocus = document.activeElement;
  const img = $("lightbox-img");
  img.src = item.dataUrl;
  img.alt = `年报第 ${item.page} 页整页高亮放大图，命中 ${item.hits} 处正面语气词`;
  $("lightbox-caption").textContent =
    `${state.data.company} ${state.data.year} 年报 · 第 ${item.page} 页 · ${item.hits} 处正面语气词高亮` +
    (item.width ? `（原图 ${item.width}×${item.height}，100% 即逐像素）` : "");
  const source = $("lightbox-source");
  if (state.reportUrl) {
    // pdf.js 页码与 #page= 同为 1 基索引，可定位到同一页。
    source.href = `${state.reportUrl}#page=${item.page}`;
    source.classList.remove("hidden");
  } else {
    source.classList.add("hidden");
  }
  $("lightbox").classList.remove("hidden");
  document.body.classList.add("lightbox-open");
  resetView();
  $("lightbox-close").focus();
}

function closeLightbox() {
  $("lightbox").classList.add("hidden");
  document.body.classList.remove("lightbox-open");
  dragState = null;
  if (lightboxReturnFocus && document.contains(lightboxReturnFocus)) lightboxReturnFocus.focus();
  lightboxReturnFocus = null;
}

function initLightboxControls() {
  const stage = $("lightbox-stage");
  $("zoom-in").addEventListener("click", () => setZoom(zoom * ZOOM_STEP));
  $("zoom-out").addEventListener("click", () => setZoom(zoom / ZOOM_STEP));
  $("zoom-reset").addEventListener("click", resetView);
  // 触控板双指捏合在浏览器里就是 ctrl+wheel，与滚轮同一处理即可。
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    setZoom(event.deltaY < 0 ? zoom * 1.15 : zoom / 1.15, event.clientX, event.clientY);
  }, { passive: false });
  stage.addEventListener("dblclick", (event) => {
    setZoom(zoom > ZOOM_MIN ? ZOOM_MIN : 2.5, event.clientX, event.clientY);
  });
  stage.addEventListener("pointerdown", (event) => {
    if (zoom <= ZOOM_MIN) return;
    dragState = { x: event.clientX, y: event.clientY, panX, panY };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (event) => {
    if (!dragState) return;
    panX = dragState.panX + (event.clientX - dragState.x);
    panY = dragState.panY + (event.clientY - dragState.y);
    applyTransform();
  });
  const endDrag = () => {
    dragState = null;
    stage.classList.remove("is-dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", () => {
    if (!$("lightbox").classList.contains("hidden")) applyTransform();
  });
}

function renderLists() {
  const evidence = $("evidence-list");
  const claims = $("claims-list");
  const TM = state.data.toneMeta || {};
  const audit = $("claims-audit");
  if (audit) {
    // 可核性说明一律数屏幕上这一批，不取服务端的中间计数。
    // 之前有一版取的是截断前的计数，而列表只 slice 前 12 条，
    // 于是「N 条无法跳转」数的是根本没显示在屏幕上的条目。现在全显示，两处必然同源。
    const shown = state.data.claims;
    const unanchored = shown.filter((item) => !item.target).length;
    // 全显示，所以列出的就是全部；顺序、合并、剔除各有多少都要能被读者复算。
    const parts = [
      `共 ${shown.length} 条，按 MD&A 原文位置排列，段号已按本次抽取的 ${TM.paragraphCount || 0} 段校验`,
    ];
    if (unanchored) parts.push(`其中 ${unanchored} 条无段号、点不动原文`);
    if (TM.claimsFolded) parts.push(`两遍打分合并 ${TM.claimsFolded} 条同段落重复`);
    if (TM.claimsRejected) parts.push(`剔除 ${TM.claimsRejected} 条（引用了不存在的段号）`);
    audit.textContent = "（" + parts.join("；") + "）";
  }
  evidence.textContent = "";
  claims.textContent = "";
  state.data.evidence.forEach((item) => appendEvidenceItem(evidence, item));
  state.data.claims.forEach((item) => appendEvidenceItem(claims, item));
  // 证据链被清洗过就要留痕：否则「删掉空壳后剩下的」看起来就像模型原本给的全部内容。
  const ea = state.data.evidenceAudit || {};
  const bits = [];
  if (ea.droppedShells) bits.push(`剔除 ${ea.droppedShells} 条空壳引用（模型回吐了提示词里的示例格式）`);
  if (ea.filled && ea.filled.length) bits.push(ea.filled.join("；"));
  if (bits.length) {
    let note = $("evidence-audit");
    if (!note) {
      note = document.createElement("p");
      note.id = "evidence-audit";
      note.className = "claims-audit";
      evidence.parentElement.insertBefore(note, evidence.nextSibling);
    }
    note.textContent = "证据链处理记录：" + bits.join("；") + "。";
  } else {
    const stale = $("evidence-audit");
    if (stale) stale.remove();
  }
}

/* ---------- 词典法阅读器 ---------- */

const CATEGORY_LABEL = { pos: "正面语气词", neg: "不利结果词", risk: "风险披露词" };

function gotoEvidence(id, trigger) {
  const target = $(id);
  if (!target) {
    // 段号锚点找不到时必须在原地说明原因：静默返回会被读成「页面卡了」，
    // 而真实原因是模型引用了一个本次抽取里没有的段落。
    if (trigger && trigger.parentElement) {
      let note = trigger.parentElement.querySelector(".ev-miss");
      if (!note) {
        note = document.createElement("span");
        note.className = "ev-miss";
        trigger.parentElement.appendChild(note);
      }
      note.textContent = "（未找到该段：模型引用的段号不在本次抽取结果内）";
    }
    return;
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("flash");
  void target.offsetWidth;
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1600);
}

function renderWordBars(id, words, cat) {
  const ul = $(id);
  ul.textContent = "";
  const max = words.length ? words[0].c : 1;
  words.slice(0, 10).forEach((w) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "word-name";
    name.textContent = w.w;
    const bar = document.createElement("span");
    bar.className = `word-bar ${cat === "pos" ? "wb-pos" : "wb-neg"}`;
    bar.style.width = `${Math.max(6, Math.round((w.c / max) * 100))}%`;
    const count = document.createElement("span");
    count.className = "word-count mono";
    count.textContent = `×${w.c}`;
    const chips = document.createElement("span");
    chips.className = "word-paras";
    w.p.slice(0, 5).forEach((p) => {
      const a = document.createElement("a");
      a.href = `#mda-p-${p}`;
      a.className = "para-chip mono";
      a.textContent = p;
      a.title = `跳转到 MD&A 第 ${p} 段`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        gotoEvidence(`mda-p-${p}`);
      });
      chips.appendChild(a);
    });
    li.append(name, bar, count, chips);
    ul.appendChild(li);
  });
}

function renderReader() {
  const L = window.LEXICAL;
  const reader = $("mda-reader");
  const enabled = {};
  document.querySelectorAll(".reader-toggles input").forEach((cb) => {
    enabled[cb.dataset.cat] = cb.checked;
  });
  reader.textContent = "";
  const frag = document.createDocumentFragment();
  L.paragraphs.forEach((p) => {
    const para = document.createElement("p");
    para.className = p.tableish ? "mda-p mda-tableish" : "mda-p";
    para.id = `mda-p-${p.n}`;
    const no = document.createElement("span");
    no.className = "pno mono";
    no.textContent = p.n;
    para.appendChild(no);
    if (p.tableish) {
      const tag = document.createElement("span");
      tag.className = "tableish-tag mono";
      tag.textContent = "表格片段·不计入占比";
      para.appendChild(tag);
    }
    let cursor = 0;
    p.m.forEach(([s, e, w, c]) => {
      if (!enabled[c]) return;
      if (s > cursor) para.appendChild(document.createTextNode(p.t.slice(cursor, s)));
      const mk = document.createElement("mark");
      mk.className = `mk-${c}`;
      mk.textContent = w;
      mk.title = `${w}（${CATEGORY_LABEL[c]}）· 第 ${p.n} 段`;
      para.appendChild(mk);
      cursor = e;
    });
    if (cursor < p.t.length) para.appendChild(document.createTextNode(p.t.slice(cursor)));
    frag.appendChild(para);
  });
  reader.appendChild(frag);
}

function renderLexical() {
  const L = window.LEXICAL;
  const gap = Math.abs(L.llmScore - L.lexicalScore).toFixed(1);
  $("lexical-sub").textContent =
    `词典法在整篇 ${L.charCount.toLocaleString()} 字 MD&A 中独立统计：正面语气词 ${L.positiveHits} 次、` +
    `不利结果词 ${L.negativeHits} 次，正面占比 ${L.lexicalScore.toFixed(1)}%；` +
    `qwen-plus 对同一文本给出的语调虚高指数是 ${L.llmScore.toFixed(1)}。两者量纲不同——占比只看情绪词构成，` +
    `LLM 分还包含对行文自信程度与前瞻表述的整体判断——因此相差 ${gap} 个刻度不等于某一方出错，` +
    `而是提示乐观措辞主要以事实陈述的方式承载。` +
    (L.lowSample
      ? `本次情绪词命中合计仅 ${L.toneTotal} 次（低于 100 次），单个词即可移动占比约 1 个刻度，词典法结果稳定性不足，仅作辅助参考。`
      : `情绪词命中合计 ${L.toneTotal} 次，样本量足以支撑该占比。`) +
    (L.excludedHits
      ? `另有 ${L.excludedHits} 处命中位于 ${L.tableishParagraphs} 个表格/数字片段段落中，已从占比统计剔除但仍保留高亮。`
      : "");
  const metrics = [
    ["正面词命中", `${L.positiveHits} 次`, `${L.positiveDensity.toFixed(2)}/千字（正文）`],
    ["不利词命中", `${L.negativeHits} 次`, `${L.negativeDensity.toFixed(2)}/千字（正文）`],
    ["风险披露词", `${L.riskHits} 次`, "单列不计情绪"],
    ["正面词占比", `${L.lexicalScore.toFixed(1)}%`, `情绪词共 ${L.toneTotal} 次 · 非乐观程度`],
  ];
  const wrap = $("lexical-metrics");
  wrap.textContent = "";
  metrics.forEach(([label, value, hint]) => {
    const card = document.createElement("div");
    card.className = "lex-metric";
    for (const [cls, text] of [["metric-label", label], ["metric-value mono", value], ["metric-hint", hint]]) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      card.appendChild(span);
    }
    wrap.appendChild(card);
  });
  renderWordBars("lex-pos", L.positiveWords, "pos");
  renderWordBars("lex-neg", L.negativeWords, "neg");
  renderReader();
}

function renderDensityStrip() {
  const L = window.LEXICAL;
  const strip = $("density-strip");
  strip.textContent = "";
  const frag = document.createDocumentFragment();
  L.paragraphs.forEach((p) => {
    let pos = 0;
    let neg = 0;
    p.m.forEach((mark) => {
      if (mark[3] === "pos") pos += 1;
      else if (mark[3] === "neg") neg += 1;
    });
    if (pos === 0 && neg === 0) return;
    const net = pos - neg;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = `density-cell ${net >= 0 ? "dc-pos" : "dc-neg"}`;
    cell.style.opacity = (0.35 + 0.65 * Math.min(1, Math.abs(net) / 4)).toFixed(2);
    cell.title = `第 ${p.n} 段：正面 ${pos} / 不利 ${neg}`;
    cell.addEventListener("click", () => gotoEvidence(`mda-p-${p.n}`));
    frag.appendChild(cell);
  });
  strip.appendChild(frag);
}

function initEvidenceLinks() {
  document.querySelectorAll("#result a.ev-link").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      gotoEvidence(a.getAttribute("href").slice(1));
    };
  });
}

/* ---------- AI 审讯室 ---------- */

function buildChatContext() {
  const D = state.data;
  const L = window.LEXICAL;
  const Q = D.quality;
  const finLines = D.years.map((year, i) => {
    const cash = D.cashflow[i];
    const profit = D.netProfit[i];
    const r = profit !== null && profit > 0 && cash !== null ? (cash / profit).toFixed(2) : "—";
    const cashYoY = yoyFrac(D.cashflow, i);
    return `${year}：营收 ${fmtYi(D.revenue[i])} 亿元（${yoyNote(D.revenueYoY[i], prevRow(D.revenue, i), D.revenue[i])}），净利润 ${fmtYi(profit)} 亿元（${yoyNote(D.npYoY[i], prevRow(D.netProfit, i), profit)}），经营现金流 ${fmtYi(cash)} 亿元（${yoyNote(cashYoY, prevRow(D.cashflow, i), cash)}，净现比 ${r}）`;
  }).join("；");
  return [
    `你是年报语调操纵审计的主审分析师。审计对象：${D.company}（${D.code}），审计年度 ${D.year}。`,
    `语调虚高指数 ${D.sentiment.toFixed(2)}/100（qwen-plus 评估表述相对其数据支撑的膨胀程度，越高越可疑，不代表公司好坏）；词典法正面词占比 ${L.lexicalScore.toFixed(1)}%（正面词 ${L.positiveHits} 次、不利词 ${L.negativeHits} 次，合计 ${L.toneTotal} 次情绪词）${L.lowSample ? "，样本偏少、占比不稳定" : ""}。词典法按构造只数「表述立场」，不含「是否有数据支撑」这一维，因此它<b>只能交叉验证、不能作为语调虚高指数的证据</b>；两者不一致时以事实核对与财务分位为准。`,
    `财务基本面：水平分 ${D.rawHealth.toFixed(2)}（显示分 ${D.health.toFixed(2)}/100，${D.healthLevel}${bandLine(D)}）；同比变化分 ${D.changeScore === null ? "无可比上一年" : `${D.changeScore.toFixed(2)} 分`}${D.band && D.band.change_percentile !== null ? `，位于第 ${D.band.change_percentile.toFixed(1)} 百分位` : ""}。财务摘要：${finLines}。`,
    `主判据背离度 = 语调虚高指数 − 财务基本面最差一侧（水平分位与同比变化分位取较小者）的百分位；本轮 ${D.divergence && D.divergence.divergence !== null ? D.divergence.divergence.toFixed(2) : "未取得"}，档位 ${D.divergence ? D.divergence.grade : "未标定"}。依据：${D.divergence ? (D.divergence.reasons || []).join("；") : "本轮无判定结果"}。`,
    `盈余质量：审计年度经营现金流 ${fmtYi(Q.operating_cashflow)} 亿元、${yoyNote(Q.cashflow_yoy, prevRow(D.cashflow, D.years.length - 1), Q.operating_cashflow)}，净现比 ${Q.cash_to_profit === null ? "缺失" : Q.cash_to_profit.toFixed(2)}（${D.cashToProfitApplicable ? "计入评分" : "金融类企业不计分"}），扣非归母净利润 ${fmtYi(Q.deducted_net_profit)} 亿元，Piotroski F-Score ${D.fScore.total}/${D.fScore.valid}。`,
    factsContextLine(D),
    `Leader 判定：${headlineFor(D).title}。理由：${D.reason}`,
    `证据链：${D.evidence.map((e) => e.text).join("；")}`,
    "回答追问时仅依据以上审计上下文与提供的对话历史，引用具体数字与段号，不得编造证据；结论是风险预警而非违法认定。",
    "公式与数值一律用纯文本写（如「背离度 = 语调虚高指数 − 最差一侧百分位」），不要使用 LaTeX 记号。",
  ].join("\n");
}

function appendBubble(role, text) {
  const log = $("chat-log");
  const bubble = document.createElement("div");
  bubble.className = role === "user" ? "bubble bubble-user" : "bubble bubble-ai";
  const roleSpan = document.createElement("span");
  roleSpan.className = "role";
  roleSpan.textContent = role === "user" ? "提问 · 审计人员" : "回答 · qwen-max 主审分析师";
  bubble.appendChild(roleSpan);
  bubble.appendChild(document.createTextNode(role === "ai" ? plainMath(text) : text));
  log.appendChild(bubble);
  bubble.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return bubble;
}

// qwen-max 有时把公式写成 LaTeX（实测：\[ \text{背离度} = \text{语调虚高指数} - ... \]），
// 而审讯室是纯文本渲染，用户看到的就是满屏反斜杠。这里做有限还原——
// 只处理真实出现过的常见记号，不是 LaTeX 引擎；认不出的命令只去掉反斜杠保留词形，
// 绝不整段吞掉：宁可看到 "alpha"，也不要丢数字。
function plainMath(text) {
  const s = String(text ?? "");
  if (s.indexOf("\\") < 0 && s.indexOf("$") < 0) return s;
  return s
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => ` ${body.trim()} `)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => ` ${body.trim()} `)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_m, body) => ` ${body.trim()} `)
    .replace(/\$([^$\n]{1,200})\$/g, (_m, body) => ` ${body.trim()} `)
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·")
    .replace(/\\div/g, "÷")
    .replace(/\\approx/g, "≈")
    .replace(/\\ge(?:q)?/g, "≥")
    .replace(/\\le(?:q)?/g, "≤")
    .replace(/\\pm/g, "±")
    .replace(/\\%/g, "%")
    .replace(/\\[,;!:]/g, " ")
    .replace(/\\([a-zA-Z]+)/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function renderChat() {
  $("chat-log").textContent = "";
  state.chatMessages.forEach((message) => appendBubble(message.role, message.content));
}

async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || !state.data) return;
  input.value = "";
  $("chat-send").disabled = true;
  state.chatMessages.push({ role: "user", content: text });
  appendBubble("user", text);
  const pending = appendBubble("ai", "思考中…");
  try {
    const data = await apiJson("chat", {
      method: "POST",
      body: { messages: state.chatMessages.slice(-12), context: state.chatContext },
    });
    state.chatMessages.push({ role: "assistant", content: data.reply });
    pending.textContent = "";
    const roleSpan = document.createElement("span");
    roleSpan.className = "role";
    roleSpan.textContent = "回答 · qwen-max 主审分析师";
    pending.appendChild(roleSpan);
    pending.appendChild(document.createTextNode(data.reply));
  } catch (err) {
    pending.textContent = "";
    const roleSpan = document.createElement("span");
    roleSpan.className = "role";
    roleSpan.textContent = "回答 · 失败";
    pending.appendChild(roleSpan);
    pending.appendChild(document.createTextNode(errorText(err)));
    state.chatMessages.pop();
  } finally {
    $("chat-send").disabled = false;
    input.focus();
    // 提问单独计数之后，这行读数不刷新就会一直停在提问前的数字——
    // 界面写出的每个额度数都必须是当下的，不能是上一次审计时的。
    refreshQuota();
  }
}

/* ---------- 尽调报告 ---------- */

function localTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function head_light(D) {
  const head = headlineFor(D);
  const icons = { red: "🚨", amber: "⚠️", green: "✅", uncalibrated: "❔" };
  return { icon: icons[head.grade] || "✅", title: `${head.stamp}：${head.title}`, detail: D.reason };
}


function buildReport() {
  const D = state.data;
  const L = window.LEXICAL;
  const Q = D.quality;
  const light = D.anomaly
    ? { icon: "🚨", title: "审计预警：发现语调与财务背离", detail: D.reason }
    : head_light(D);
  const lines = [
    "# 年报语调操纵尽调报告",
    "",
    `- 公司名称：${D.company}`,
    `- 股票代码：${D.code}`,
    `- 审计年度：${D.year}`,
    `- 年报来源：巨潮资讯《${state.reportTitle || `${D.year} 年年度报告`}》（${D.pageCount} 页）`,
    `- 生成时间：${localTimestamp()}`,
    "",
    "## 一、红绿灯结论",
    "",
    `${light.icon} **${light.title}**`,
    "",
    light.detail,
    "",
    `- 主判据·背离度：${D.divergence && D.divergence.divergence !== null ? D.divergence.divergence.toFixed(2) : "未取得"}（= 语调虚高指数 − 财务最差一侧百分位），档位 ${D.divergence ? D.divergence.grade : "未标定"}`,
    `- 档位依据：${D.divergence ? (D.divergence.reasons || []).join("；") : "本轮没有可引用的分位定位"}`,
    `- 语调虚高指数：${D.sentiment.toFixed(1)} / 100（越高表示表述越缺乏数据支撑，不代表公司好坏；不单独触发报警）`,
    `- 财务基本面·水平分：${D.rawHealth.toFixed(1)}（显示分 ${D.health.toFixed(1)} / 100，${D.healthLevel}${reportBandLine(D)}）`,
    `- 定位池：${D.band ? D.band.group_label : "—"}（${D.band ? D.band.group_n : 0} 个观测）` +
      (D.industry ? `｜一级板块：${D.industry}` : ""),
    ...(D.divergence && D.divergence.downgraded
      ? [
          `- 优质档降档：毛利率与净利率同时处于行业前 5%，预警级别由 ${D.divergence.raw_grade} 下调为 ${D.divergence.grade}。`,
          "  降档只改级别不改分数；核查重点相应从「是否掩盖恶化」转为「是否把周期性失速表述为稳健增长」。",
        ]
      : []),
    `- 财务基本面·同比变化分：${D.changeScore === null ? "无可比上一年" : `${D.changeScore.toFixed(2)} 分`}${D.band && D.band.change_percentile !== null ? `（第 ${D.band.change_percentile.toFixed(1)} 百分位）` : ""}`,
    ...(D.healthSaturated
      ? [`- 注：规则引擎原始分为 ${D.rawHealth.toFixed(2)}，超出 0–100 区间后按 ${D.health.toFixed(2)} 显示；原始分保留以维持两端区分度。`]
      : []),
    "",
    "## 二、财务明细（东方财富）",
    "",
    "| 年度 | 营业收入（亿元） | 归母净利润（亿元） | 经营现金流（亿元） | 净现比 | 营收同比/变动 | 净利润同比/变动 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...D.years.map((year, i) => {
      const profit = D.netProfit[i];
      const cash = D.cashflow[i];
      const r = profit !== null && profit > 0 && cash !== null ? (cash / profit).toFixed(2) : "—";
      return `| ${year} | ${fmtYi(D.revenue[i])} | ${fmtYi(profit)} | ${fmtYi(cash)} | ${r} | ${yoyCell(D.revenueYoY[i], prevRow(D.revenue, i), D.revenue[i])} | ${yoyCell(D.npYoY[i], prevRow(D.netProfit, i), profit)} |`;
    }),
    "",
    "> 同比列口径：增速的分母是基期绝对值。基期接近 0 或基期与本期异号时该比值不再是增长率（基期 +0.03 亿、本期 −0.51 亿会算出 −1706%），此时列内改显示绝对额变动（亿元）或「由正转负／由负转正」。",
    "",
    "## 三、现金流与盈余质量",
    "",
    `- 经营活动现金流净额：${fmtYi(Q.operating_cashflow)} 亿元（${yoyNote(Q.cashflow_yoy, prevRow(D.cashflow, D.years.length - 1), Q.operating_cashflow)}）`,
    `- 净现比（经营现金流 ÷ 归母净利润）：${Q.cash_to_profit === null ? "缺失" : `${Q.cash_to_profit.toFixed(2)} 倍`}${D.cashToProfitApplicable ? "" : "（金融类企业不计入评分）"}`,
    `- 扣非归母净利润：${fmtYi(Q.deducted_net_profit)} 亿元${Q.net_profit ? `（占归母 ${((Q.deducted_net_profit / Q.net_profit) * 100).toFixed(1)}%）` : ""}`,
    `- Piotroski F-Score：${D.fScore.total}/${D.fScore.valid}（九项中 ${D.fScore.valid} 项有可比数据）`,
    "",
    "F-Score 分项：",
    "",
    ...D.fScore.items.map((item) => `- ${item.name}：${item.result === null ? "不适用" : item.result ? "通过" : "未通过"}`),
    "",
    "## 四、Agent 审计结论",
    "",
    `- Leader 判定：${headlineFor(D).title}`,
    `- 判定理由：${D.reason}`,
    "",
    "证据链：",
    "",
    ...D.evidence.map((item) => `- ${item.text}`),
    "",
    "管理层关键论点：",
    "",
    ...D.claims.map((item) => `- ${item.text}`),
    "",
    "## 五、PDF 语调证据",
    "",
    ...(D.densePages || []).map((item) => `- 整页密集高亮快照：第 ${item.page} 页，命中正面语气词 ${item.hits} 处（网页证据区查看）`),
    "",
    "## 六、词典法词频构成（交叉验证用，不是语调虚高指数的证据）",
    "",
    `- MD&A 全文字数：${L.charCount.toLocaleString()}（正文 ${L.proseCharCount.toLocaleString()}，另有 ${L.tableishParagraphs} 个表格/数字片段段落）`,
    `- 正面语气词命中：${L.positiveHits} 次（密度 ${L.positiveDensity.toFixed(2)}/千字）`,
    `- 不利结果词命中：${L.negativeHits} 次（密度 ${L.negativeDensity.toFixed(2)}/千字）`,
    `- 风险披露词命中：${L.riskHits} 次（单列，不计入正/负面情绪比）`,
    `- 表格片段中剔除的命中：${L.excludedHits} 次（仍保留原文高亮）`,
    `- 正面词占比（词典法）：${L.lexicalScore.toFixed(1)}%（情绪词合计 ${L.toneTotal} 次${L.lowSample ? "，样本偏少，占比不稳定" : ""}）`,
    `- 语调虚高指数（qwen-plus）：${L.llmScore.toFixed(1)} / 100`,
    `  注：占比衡量情绪词构成比例，虚高指数衡量表述相对数据支撑的膨胀程度，量纲不同，差异大时不代表任一方有误。`,
    `- 高频正面词：${L.positiveWords.slice(0, 8).map((w) => `${w.w}×${w.c}`).join("、")}`,
    `- 高频不利结果词：${L.negativeWords.slice(0, 8).map((w) => `${w.w}×${w.c}`).join("、")}`,
    ...factsReportLines(state.data),
    "",
    "> 在线版已接入经营现金流、净现比、扣非净利润与 Piotroski F-Score；暂不含 FOG 文本迷雾指数（见 Streamlit 完整版）。审计结论仅为风险预警，不构成投资建议。",
    "",
  ];
  return lines.join("\n");
}

function initReport() {
  const report = buildReport();
  $("report-preview").textContent = report;
  $("download-report").onclick = () => {
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${state.data.code}_${state.data.year}_尽调报告.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };
}

/* ---------- 事件绑定 ---------- */

$("stock-input").addEventListener("input", (e) => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => loadSuggest(e.target.value), 300);
});
$("stock-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = $("suggest").querySelector("button");
    if (first) first.click();
  } else if (e.key === "Escape") {
    $("suggest").classList.remove("open");
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box")) $("suggest").classList.remove("open");
});
$("run-audit").addEventListener("click", runAudit);
$("lightbox-close").addEventListener("click", closeLightbox);
$("lightbox-backdrop").addEventListener("click", closeLightbox);
initLightboxControls();
document.addEventListener("keydown", (e) => {
  if ($("lightbox").classList.contains("hidden")) return;
  if (e.key === "Escape") { closeLightbox(); return; }
  // 焦点在输入框时不劫持 +,-,0，否则审讯室打字会被当成缩放指令。
  const tag = (document.activeElement || {}).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(zoom * ZOOM_STEP); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(zoom / ZOOM_STEP); }
  else if (e.key === "0") { e.preventDefault(); resetView(); }
});
$("chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
document.querySelectorAll(".reader-toggles input").forEach((cb) => {
  cb.addEventListener("change", () => { if (window.LEXICAL) renderReader(); });
});
// 方法论默认收起，但结果区有个 href="#method" 的锚点链过去——跳到一块收起的文字上等于没跳。
// 所以凡是走锚点进来的（点链接、带 #method 的 URL、后续 hash 变化），都先展开再让浏览器滚动。
function openMethodFold() {
  const fold = document.querySelector(".method-fold");
  if (fold) fold.open = true;
}
document.querySelectorAll('a[href="#method"]').forEach((a) => a.addEventListener("click", openMethodFold));
if (window.location.hash === "#method") openMethodFold();
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#method") openMethodFold();
});
loadBands();
refreshQuota();
