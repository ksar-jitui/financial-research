"use strict";

// 浏览器端整页快照：pdf.js 逐页统计正面语气词命中，Top-N 页 canvas 渲染并按文字坐标画高亮。
//
// 渲染比例一次性取高值（2.4，A4 约 1429x2022），让弹层放大后看到的是真实细节而不是插值糊块。
// 这一步完全在浏览器里跑，不占函数网关时限；代价是 3 张图约 3MB 内存、快照步骤多花 1-2 秒。
const SNAPSHOT_RENDER_SCALE = 2.4;

async function collectDensePages(pdfBytes, onProgress, topN = 3) {
  const words = [...new Set(POSITIVE_TONE_WORDS)].sort((a, b) => b.length - a.length);
  const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
  const numPages = doc.numPages;
  const candidates = [];
  for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.filter((item) => item.str && item.transform);
    items.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
    let text = "";
    const spans = [];
    for (const item of items) {
      spans.push({ start: text.length, end: text.length + item.str.length, item });
      text += item.str;
    }
    const marks = countToneHits(text, words);
    if (marks.length) candidates.push({ page: pageNumber, hits: marks.length, marks, spans, pageRef: page });
    if (onProgress && pageNumber % 40 === 0) {
      onProgress(`扫描 PDF 正面词密度：${pageNumber} / ${numPages} 页`);
    }
  }
  candidates.sort((a, b) => b.hits - a.hits || a.page - b.page);
  const top = candidates.slice(0, topN);
  const out = [];
  for (const entry of top) {
    const viewport = entry.pageRef.getViewport({ scale: SNAPSHOT_RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    // 后台标签页会暂停 requestAnimationFrame；改用定时器分块渲染，避免切换标签时快照卡死。
    await entry.pageRef.render({ canvasContext: ctx, viewport, useRequestAnimationFrame: false }).promise;
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgba(253, 224, 71, 0.6)";
    for (const [word, start] of entry.marks) {
      const end = start + word.length;
      for (const span of entry.spans) {
        if (span.end <= start || span.start >= end) continue;
        const item = span.item;
        const e = item.transform[4];
        const f = item.transform[5];
        const rect = viewport.convertToViewportRectangle([e, f, e + item.width, f + item.height]);
        const x = Math.min(rect[0], rect[2]);
        const y = Math.min(rect[1], rect[3]);
        ctx.fillRect(x, y, Math.abs(rect[2] - rect[0]), Math.abs(rect[3] - rect[1]));
      }
    }
    out.push({
      page: entry.page,
      hits: entry.hits,
      width: canvas.width,
      height: canvas.height,
      dataUrl: canvas.toDataURL("image/png"),
    });
  }
  await doc.destroy();
  return out;
}