"use strict";

// 浏览器端 pdf.js 提取 + 与 data_processing.py 同源的 MD&A 切片/页眉页脚剔除。
const START_KEYWORDS = ["管理层讨论与分析", "经营情况讨论与分析", "董事会报告"];
const END_KEYWORDS = [
  "重要事项", "公司治理", "股份变动", "股东情况", "财务报告",
  "财务报表", "审计报告", "环境与社会责任", "环境和社会责任",
];

function cleanLine(text) {
  let out = text.normalize("NFKC");
  out = out.replace(/[\x00-\x1f\x7f-\x9f\ufeff\u200b-\u200d]/g, "");
  out = out.replace(/\ufffd/g, "");
  out = out.replace(/[\ue000-\uf8ff]/g, "");
  out = out.replace(/\s+/g, " ").trim();
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(out)) return "";
  return out;
}

function isPageNumber(text) {
  const compact = text.replace(/\s+/g, "");
  return /^[-—–]?\d{1,4}[-—–]?$/.test(compact) || /^第\d{1,4}页(?:共\d{1,4}页)?$/.test(compact);
}

function repetitionKey(text) {
  const key = text.replace(/[\s\d]/g, "");
  return key.length >= 2 ? key : "";
}

// “重要提示”里常用“本报告第X节“管理层讨论与分析”中描述了…”这类交叉引用，
// 带引号或指引动词的行不是章节标题，否则 MD&A 会被切成前面的目录/释义片段。
const START_REFERENCE_MARKERS = ["详见", "参见", "请投资者", "认真阅读", "中描述", "中披露", "中存在", "的情况"];

function isStartHeading(line) {
  const compact = line.replace(/\s+/g, "");
  if (compact.length > 45 || /(?:\.{3,}|…{2,})\d*$/.test(compact)) return false;
  if (/\d{1,4}$/.test(compact)) return false;
  if (/[\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f]/.test(compact)) return false;
  if (START_REFERENCE_MARKERS.some((marker) => compact.includes(marker))) return false;
  return START_KEYWORDS.some((keyword) => compact.includes(keyword));
}

function isEndHeading(line) {
  const compact = line.replace(/\s+/g, "");
  if (compact.length > 50 || isStartHeading(compact)) return false;
  const majorHeading = /^(?:[一-鿿A-Za-z0-9()（）]{0,30}20\d{2}年年度报告(?:全文)?)?第[一二三四五六七八九十百零〇0-9]+[章节](?![\d.])/;
  if (majorHeading.test(compact)) return true;
  if (!END_KEYWORDS.some((keyword) => compact.includes(keyword))) return false;
  return /^[一二三四五六七八九十]+、/.test(compact) || END_KEYWORDS.includes(compact);
}

async function extractPageLines(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const yMin = viewport.height * 0.06;
  const yMax = viewport.height * 0.94;
  const items = content.items.filter((item) => {
    if (!item.str || !item.transform) return false;
    const y = item.transform[5];
    return y >= yMin && y <= yMax;
  });
  items.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  const rawLines = [];
  let currentY = null;
  let current = [];
  for (const item of items) {
    const y = item.transform[5];
    if (currentY === null || Math.abs(y - currentY) <= 3) {
      current.push(item);
      currentY = currentY === null ? y : currentY;
    } else {
      rawLines.push(current.map((i) => i.str).join(""));
      current = [item];
      currentY = y;
    }
  }
  if (current.length) rawLines.push(current.map((i) => i.str).join(""));

  const lines = rawLines.map(cleanLine).filter((line) => line && !isPageNumber(line));
  return lines.map((text, index) => ({
    text,
    zone: index < 2 ? "header" : index >= lines.length - 2 ? "footer" : "body",
  }));
}

function removeRepeatedHeadersFooters(pages) {
  const counts = new Map();
  for (const lines of pages) {
    const candidates = new Set();
    for (const line of lines) {
      if (line.zone === "body") continue;
      const key = repetitionKey(line.text);
      if (key) candidates.add(key);
    }
    for (const key of candidates) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const threshold = Math.max(3, Math.floor(pages.length * 0.1));
  const repeated = new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key));
  return pages.map((lines) =>
    lines
      .filter((line) => line.zone === "body" || !repeated.has(repetitionKey(line.text)))
      .map((line) => line.text)
  );
}

function sliceMda(pages) {
  let start = null;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const candidates = [];
    pages[pageIndex].forEach((line, lineIndex) => {
      if (isStartHeading(line.text)) candidates.push(lineIndex);
    });
    if (candidates.length) {
      start = [pageIndex, candidates[candidates.length - 1]];
      break;
    }
  }
  if (!start) throw new Error("未找到管理层讨论与分析（MD&A）起始章节");

  let end = null;
  for (let pageIndex = start[0]; pageIndex < pages.length; pageIndex += 1) {
    const first = pageIndex === start[0] ? start[1] + 1 : 0;
    for (let lineIndex = first; lineIndex < pages[pageIndex].length; lineIndex += 1) {
      if (isEndHeading(pages[pageIndex][lineIndex].text)) {
        end = [pageIndex, lineIndex];
        break;
      }
    }
    if (end) break;
  }

  const endPage = end ? end[0] : pages.length - 1;
  const section = [];
  for (let pageIndex = start[0]; pageIndex <= endPage; pageIndex += 1) {
    const lineStart = pageIndex === start[0] ? start[1] + 1 : 0;
    const lineEnd = end && pageIndex === end[0] ? end[1] : pages[pageIndex].length;
    section.push(pages[pageIndex].slice(lineStart, lineEnd));
  }
  return section;
}

function isTabularLine(line) {
  if (/[。！？；]["'」』）)]?$/.test(line)) return false;
  const compact = line.replace(/\s+/g, "");
  if (!compact) return true;
  const cjk = (compact.match(/[一-鿿]/g) || []).length;
  return cjk / compact.length < 0.3;
}

function looksLikeParagraphStart(line) {
  const compact = line.replace(/\s+/g, "");
  if (/^(?:第[一二三四五六七八九十百零〇0-9]+[章节]|[0-9]+(?:\.[0-9]+)*[、.．]|[一二三四五六七八九十]+、|（[一二三四五六七八九十0-9]+）|\([0-9]+\))/.test(compact)) return true;
  return compact.length <= 25 && !/[。！？；，、,：:]$/.test(compact) && !/\d{3,}/.test(compact);
}

function mergeParagraphLines(lines) {
  const paragraphs = [];
  let current = "";
  const flush = () => {
    if (current) paragraphs.push(current);
    current = "";
  };
  for (const line of lines) {
    const tabular = isTabularLine(line);
    if (!current) {
      current = line;
      if (tabular) flush();
      continue;
    }
    const prevComplete = /[。！？；：:]["'」』）)]?$/.test(current);
    if (tabular || looksLikeParagraphStart(line) || prevComplete || isTabularLine(current)) {
      flush();
      current = line;
      if (tabular) flush();
    } else {
      const last = current[current.length - 1];
      const first = line[0];
      current += (/[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(first) ? " " : "") + line;
    }
  }
  flush();
  return paragraphs;
}

async function extractMda(pdfBytes, onProgress) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/pdf.worker.min.js";
  const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    pages.push(await extractPageLines(page));
    if (onProgress && pageNumber % 20 === 0) {
      onProgress(`解析年报 PDF：${pageNumber} / ${doc.numPages} 页`);
    }
  }
  const numPages = doc.numPages;
  await doc.destroy();
  const section = sliceMda(pages);
  const cleaned = removeRepeatedHeadersFooters(section);
  const mdaText = mergeParagraphLines(cleaned.flat()).join("\n");
  if (!mdaText) throw new Error("MD&A 章节为空");
  return { mdaText, pageCount: numPages };
}