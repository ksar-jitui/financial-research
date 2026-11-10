import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { bandGroupFor, percentileIn } from "../functions/lib/reference_bands.ts";

const at = (name: string) => fileURLToPath(new URL(name, import.meta.url));
// 与 _dev/ref_census.mts / ref_stats.mts 同一份普查：现金流口径改过之后，旧行的分数不能再用来定切点。
const BASIS = "cash_rel_prev_revenue_v2";
const rows: any[] = [];
let stale = 0;
for (const line of fs.readFileSync(at("ref_rows_v2.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const rec = JSON.parse(line);
    if (rec.basis !== BASIS) {
      stale++;
      continue;
    }
    rows.push(rec);
  } catch {}
}
if (rows.length === 0) throw new Error(`no_rows_with_basis_${BASIS}`);
if (stale > 0) console.log(`丢弃口径不符的旧行 ${stale} 条`);

const weakness: number[] = [];
const weaknessLevelOnly: number[] = [];
const both: number[] = [];
for (const rec of rows) {
  const scores = rec.scores ?? [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    const group = bandGroupFor(s.org ?? "");
    const lp = percentileIn(s.raw, group.level);
    if (lp === null) continue;
    weaknessLevelOnly.push(lp);
    let cp: number | null = null;
    if (i >= 1 && s.year - scores[i - 1].year === 1) {
      cp = percentileIn(Math.round((s.raw - scores[i - 1].raw) * 100) / 100, group.change);
    }
    if (cp === null) {
      weakness.push(lp);
    } else {
      const w = Math.min(lp, cp);
      weakness.push(w);
      both.push(w);
    }
  }
}

const sorted = [...weakness].sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
console.log(`weakness n=${sorted.length}  p10=${q(10)} p25=${q(25)} p50=${q(50)} p75=${q(75)} p90=${q(90)} mean=${(weakness.reduce((a, b) => a + b, 0) / weakness.length).toFixed(1)}`);

// 命中率反推：给定「语调虚高指数 = t」，红线缺口 C 对应的基础命中率
// = P(weakness ≤ t − C)。用实测 weakness 分布直接数出来，不假设独立性。
const rate = (t: number, c: number) => {
  const cut = t - c;
  let lo = 0;
  while (lo < sorted.length && sorted[lo] <= cut) lo++;
  return (lo / sorted.length) * 100;
};
for (const t of [65, 70, 75, 80, 85, 90]) {
  const cells = [40, 45, 50, 55, 60, 65, 70].map((c) => `C=${c}:${rate(t, c).toFixed(1)}%`);
  console.log(`tone ${t}  ->  ` + cells.join("  "));
}
console.log("仅用水平分位时：mean =", (weaknessLevelOnly.reduce((a, b) => a + b, 0) / weaknessLevelOnly.length).toFixed(1));
