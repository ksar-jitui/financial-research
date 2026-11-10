"use strict";

// 与 data_processing.py 同源的非重叠词典法：长词优先，consumed 数组防止重复计数。
const POSITIVE_TONE_WORDS = [
  "创历史新高", "历史新高", "再创新高", "大幅增长", "强劲增长", "稳步增长",
  "快速增长", "持续增长", "高速增长", "显著增长", "显著提升", "大幅提升",
  "跨越式发展", "重大突破", "全面向好", "稳中向好", "成效显著", "卓有成效",
  "向好", "新高", "增长", "提升", "突破", "优化", "改善", "领先", "领跑",
  "强劲", "稳健", "优异", "优秀", "卓越", "出色", "亮眼", "翻倍", "倍增",
  "丰收", "佳绩", "提速", "加速", "扩大", "回暖", "好转", "攀升", "上扬",
  "盈利", "增收", "增利", "利好",
];
const NEGATIVE_TONE_WORDS = [
  "下降", "下滑", "下跌", "减少", "缩减", "收缩", "降低", "回落", "承压",
  "亏损", "赤字", "恶化", "疲软", "低迷", "萎缩", "违约", "逾期", "减值",
  "负增长", "缩水", "下行", "走弱", "拖累", "流失", "短缺", "计提", "亏空",
];
const RISK_DISCLOSURE_WORDS = [
  "风险", "挑战", "困难", "压力", "隐患", "困境", "严峻", "棘手", "整改",
  "诉讼", "处罚", "违规", "债务", "不确定性", "波动",
];

function countToneHits(paragraph, wordsByLength) {
  const consumed = new Array(paragraph.length).fill(false);
  const hits = [];
  for (const word of wordsByLength) {
    let start = paragraph.indexOf(word);
    while (start !== -1) {
      const end = start + word.length;
      let free = true;
      for (let i = start; i < end; i += 1) {
        if (consumed[i]) { free = false; break; }
      }
      if (free) {
        for (let i = start; i < end; i += 1) consumed[i] = true;
        hits.push([word, start]);
      }
      start = paragraph.indexOf(word, start + 1);
    }
  }
  return hits;
}

function byLength(words) {
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

function analyzeLexical(mdaText, llmScore) {
  const buckets = [
    ["pos", byLength(POSITIVE_TONE_WORDS)],
    ["neg", byLength(NEGATIVE_TONE_WORDS)],
    ["risk", byLength(RISK_DISCLOSURE_WORDS)],
  ];
  const paragraphs = mdaText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const charCount = paragraphs.reduce((sum, p) => sum + p.length, 0) || 1;
  // 年报 MD&A 里混有大量表格行与数字片段（列名“报告期内减少数量”、“减少 0.1”这类），
  // 其中的“减少/增长”是算术方向而非情绪表述，计入会污染占比。仍保留高亮以维持证据完整。
  const isTableishLine = (line) =>
    !line || line.length <= 12 || (/[0-9][0-9.,]{2,}/.test(line) && !/[。！？]/.test(line));

  const stats = {
    pos: { hits: 0, counter: new Map(), paras: new Map() },
    neg: { hits: 0, counter: new Map(), paras: new Map() },
    risk: { hits: 0, counter: new Map(), paras: new Map() },
  };
  const excluded = { pos: 0, neg: 0, risk: 0 };
  const readerParagraphs = [];
  let proseCharCount = 0;
  let tableishParagraphs = 0;

  paragraphs.forEach((text, index) => {
    const number = index + 1;
    const tableish = isTableishLine(text);
    if (tableish) tableishParagraphs += 1;
    else proseCharCount += text.length;
    const allMarks = [];
    for (const [cat, words] of buckets) {
      const bucket = stats[cat];
      for (const [word, start] of countToneHits(text, words)) {
        if (tableish) {
          excluded[cat] += 1;
        } else {
          bucket.hits += 1;
          bucket.counter.set(word, (bucket.counter.get(word) || 0) + 1);
          if (!bucket.paras.has(word)) bucket.paras.set(word, []);
          bucket.paras.get(word).push(number);
        }
        allMarks.push([start, start + word.length, word, cat]);
      }
    }
    allMarks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const marks = [];
    let cursor = 0;
    for (const mark of allMarks) {
      if (mark[0] >= cursor) {
        marks.push(mark);
        cursor = mark[1];
      }
    }
    readerParagraphs.push({ n: number, t: text, m: marks, tableish });
  });

  function wordRows(bucket) {
    return [...bucket.counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word, count]) => ({
        w: word,
        c: count,
        p: [...new Set(bucket.paras.get(word))].slice(0, 8),
      }));
  }

  const positiveHits = stats.pos.hits;
  const negativeHits = stats.neg.hits;
  const toneTotal = positiveHits + negativeHits;
  const densityBase = proseCharCount || 1;
  return {
    llmScore,
    charCount,
    proseCharCount,
    positiveHits,
    negativeHits,
    toneTotal,
    riskHits: stats.risk.hits,
    // 正面词占比：情绪 token 中正面所占比例，与 LLM 的“整体乐观度”不是同一量纲。
    lexicalScore: toneTotal ? Math.round((100 * positiveHits / toneTotal) * 100) / 100 : 0,
    positiveDensity: Math.round((positiveHits / densityBase) * 1000 * 1000) / 1000,
    negativeDensity: Math.round((negativeHits / densityBase) * 1000 * 1000) / 1000,
    excludedHits: excluded.pos + excluded.neg + excluded.risk,
    tableishParagraphs,
    lowSample: toneTotal < 100,
    positiveWords: wordRows(stats.pos),
    negativeWords: wordRows(stats.neg),
    riskWords: wordRows(stats.risk),
    paragraphs: readerParagraphs,
  };
}