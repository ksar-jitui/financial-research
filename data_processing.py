"""提取年报 MD&A 文本并清洗财务数据、计算同比增速。"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import jieba
import pandas as pd
import pdfplumber
import pymupdf

_START_KEYWORDS = ("管理层讨论与分析", "经营情况讨论与分析", "董事会报告")
# 交叉引用标记：“本报告第三节“管理层讨论与分析”中描述了…”不是章节标题。
_START_REFERENCE_MARKERS = ("详见", "参见", "请投资者", "认真阅读", "中描述", "中披露", "中存在", "的情况")
_END_KEYWORDS = (
    "重要事项",
    "公司治理",
    "股份变动",
    "股东情况",
    "财务报告",
    "财务报表",
    "审计报告",
    "环境与社会责任",
    "环境和社会责任",
)
_METRIC_COLUMNS = ("营业收入", "净利润", "经营现金流")
# 截图裁剪逻辑变更时递增，避免命中旧版缓存图片
_HIGHLIGHT_CLIP_VERSION = "v3"
# 词典法语调证据：正面/负面语气词表，用于全文非重叠计数，交叉验证 LLM 乐观分。
POSITIVE_TONE_WORDS = (
    "创历史新高", "历史新高", "再创新高", "大幅增长", "强劲增长", "稳步增长",
    "快速增长", "持续增长", "高速增长", "显著增长", "显著提升", "大幅提升",
    "跨越式发展", "重大突破", "全面向好", "稳中向好", "成效显著", "卓有成效",
    "向好", "新高", "增长", "提升", "突破", "优化", "改善", "领先", "领跑",
    "强劲", "稳健", "优异", "优秀", "卓越", "出色", "亮眼", "翻倍", "倍增",
    "丰收", "佳绩", "提速", "加速", "扩大", "回暖", "好转", "攀升", "上扬",
    "盈利", "增收", "增利", "利好",
)
# 负面仅收“不利结果”词；风险/诉讼等披露类单列，避免银行风险章节把负面计数刷高。
NEGATIVE_TONE_WORDS = (
    "下降", "下滑", "下跌", "减少", "缩减", "收缩", "降低", "回落", "承压",
    "亏损", "赤字", "恶化", "疲软", "低迷", "萎缩", "违约", "逾期", "减值",
    "负增长", "缩水", "下行", "走弱", "拖累", "流失", "短缺", "计提", "亏空",
)
# 风险/不确定性披露词：反映披露强度而非悲观情绪，单独统计。
RISK_DISCLOSURE_WORDS = (
    "风险", "挑战", "困难", "压力", "隐患", "困境", "严峻", "棘手", "整改",
    "诉讼", "处罚", "违规", "债务", "不确定性", "波动",
)
_F_SCORE_REQUIRED_COLUMNS = {
    "年度",
    "ROA",
    "经营现金流",
    "净利润",
    "负债率",
    "流动比率",
    "股本",
    "毛利率",
    "总资产周转率",
}


def extract_mda_text(pdf_path: str | Path) -> str:
    """提取 MD&A 正文，清理噪声并保存为同名 *_mda.txt。"""
    source_path = Path(pdf_path)
    if not source_path.is_file():
        raise FileNotFoundError(f"PDF 文件不存在: {source_path}")

    with pdfplumber.open(source_path) as document:
        pages = [_extract_page_lines(page) for page in document.pages]

    mda_pages = _slice_mda_pages(pages)
    cleaned_pages = _remove_repeated_headers_and_footers(mda_pages)
    mda_lines = []
    for page_lines in cleaned_pages:
        if page_lines:
            if mda_lines:
                mda_lines.append("")
            mda_lines.extend(page_lines)

    text = "\n".join(mda_lines)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    if not text:
        raise ValueError("未能从 PDF 中定位管理层讨论与分析（MD&A）正文")

    output_path = source_path.with_name(f"{source_path.stem}_mda.txt")
    output_path.write_text(text + "\n", encoding="utf-8")
    return text


def clean_financials(csv_path: str | Path) -> pd.DataFrame:
    """清洗第一阶段财务 CSV，计算三项指标 YoY 并另存为 *_cleaned.csv。"""
    source_path = Path(csv_path)
    if not source_path.is_file():
        raise FileNotFoundError(f"财务 CSV 文件不存在: {source_path}")

    result = pd.read_csv(source_path, dtype={"股票代码": str}, encoding="utf-8-sig")
    result.columns = [str(column).strip() for column in result.columns]

    required = {"年度", *_METRIC_COLUMNS}
    missing = required.difference(result.columns)
    if missing:
        raise ValueError(f"财务 CSV 缺少必要字段: {', '.join(sorted(missing))}")

    if "股票代码" in result.columns:
        result["股票代码"] = result["股票代码"].str.strip().str.zfill(6)

    result["年度"] = pd.to_numeric(result["年度"], errors="coerce")
    result = result.dropna(subset=["年度"]).copy()
    result["年度"] = result["年度"].astype(int)

    if "报告期" in result.columns:
        result["报告期"] = pd.to_datetime(result["报告期"], errors="coerce")

    for column in _METRIC_COLUMNS:
        result[column] = pd.to_numeric(result[column], errors="coerce")

    result = result.dropna(subset=list(_METRIC_COLUMNS), how="all")
    sort_columns = ["股票代码", "年度"] if "股票代码" in result.columns else ["年度"]
    dedupe_columns = sort_columns
    result = result.sort_values(sort_columns).drop_duplicates(dedupe_columns, keep="last")
    result = result.reset_index(drop=True)

    for column in _METRIC_COLUMNS:
        if "股票代码" in result.columns:
            previous = result.groupby("股票代码", sort=False)[column].shift(1)
        else:
            previous = result[column].shift(1)
        denominator = previous.abs().where(previous.ne(0))
        result[f"{column}_YoY"] = (result[column] - previous) / denominator

    if _F_SCORE_REQUIRED_COLUMNS.issubset(result.columns):
        result = calculate_piotroski_f_score(result)

    output_path = source_path.with_name(f"{source_path.stem}_cleaned.csv")
    result.to_csv(
        output_path,
        index=False,
        encoding="utf-8-sig",
        date_format="%Y-%m-%d",
        float_format="%.6f",
    )
    return result


def calculate_piotroski_f_score(financial_df: pd.DataFrame) -> pd.DataFrame:
    """按经典九项标准计算 F-Score，缺失或无法比较的项目计 0。"""
    missing = _F_SCORE_REQUIRED_COLUMNS.difference(financial_df.columns)
    if missing:
        raise ValueError(f"F-Score 缺少必要字段: {', '.join(sorted(missing))}")

    result = financial_df.copy()
    sort_columns = ["股票代码", "年度"] if "股票代码" in result.columns else ["年度"]
    result = result.sort_values(sort_columns).reset_index(drop=True)
    numeric_columns = sorted(_F_SCORE_REQUIRED_COLUMNS - {"年度"})
    for column in numeric_columns:
        result[column] = pd.to_numeric(result[column], errors="coerce")
    result["年度"] = pd.to_numeric(result["年度"], errors="coerce")

    comparison_columns = ["ROA", "负债率", "流动比率", "股本", "毛利率", "总资产周转率"]
    if "股票代码" in result.columns:
        previous = result.groupby("股票代码", sort=False)[comparison_columns].shift(1)
    else:
        previous = result[comparison_columns].shift(1)

    scores = pd.DataFrame(index=result.index)

    def add_score(name: str, condition: pd.Series, valid: pd.Series) -> None:
        scores[name] = condition.astype("Int64").where(valid, pd.NA)

    add_score("F_ROA为正", result["ROA"].gt(0), result["ROA"].notna())
    add_score("F_现金流为正", result["经营现金流"].gt(0), result["经营现金流"].notna())
    add_score(
        "F_ROA改善",
        result["ROA"].gt(previous["ROA"]),
        result["ROA"].notna() & previous["ROA"].notna(),
    )
    add_score(
        "F_现金流高于净利润",
        result["经营现金流"].gt(result["净利润"]),
        result["经营现金流"].notna() & result["净利润"].notna(),
    )
    add_score(
        "F_负债率下降",
        result["负债率"].lt(previous["负债率"]),
        result["负债率"].notna() & previous["负债率"].notna(),
    )
    add_score(
        "F_流动比率改善",
        result["流动比率"].gt(previous["流动比率"]),
        result["流动比率"].notna() & previous["流动比率"].notna(),
    )
    add_score(
        "F_股本未增加",
        result["股本"].le(previous["股本"]),
        result["股本"].notna() & previous["股本"].notna(),
    )
    add_score(
        "F_毛利率改善",
        result["毛利率"].gt(previous["毛利率"]),
        result["毛利率"].notna() & previous["毛利率"].notna(),
    )
    add_score(
        "F_资产周转率改善",
        result["总资产周转率"].gt(previous["总资产周转率"]),
        result["总资产周转率"].notna() & previous["总资产周转率"].notna(),
    )

    result["Piotroski_F_Score"] = scores.fillna(0).sum(axis=1).astype(int)
    result["F_Score_有效项数"] = scores.notna().sum(axis=1).astype(int)
    for column in scores.columns:
        result[column] = scores[column]
    return result


def calculate_fog_index(mda_text: str) -> float:
    """使用中文分词、平均句长和复杂词占比计算 FOG 迷雾指数。"""
    if not isinstance(mda_text, str) or not mda_text.strip():
        raise ValueError("FOG 指数输入文本不能为空")

    normalized = unicodedata.normalize("NFKC", mda_text)
    sentences = re.split(r"[。！？；!?;\n]+", normalized)
    tokenized_sentences = []
    for sentence in sentences:
        tokens = [
            token.strip()
            for token in jieba.lcut(sentence)
            if re.fullmatch(r"[\u4e00-\u9fff]+|[A-Za-z]+", token.strip())
        ]
        if tokens:
            tokenized_sentences.append(tokens)

    word_count = sum(len(tokens) for tokens in tokenized_sentences)
    if not word_count:
        raise ValueError("FOG 指数输入文本没有可统计的中文或英文词语")

    complex_word_count = sum(
        _is_complex_fog_word(token)
        for tokens in tokenized_sentences
        for token in tokens
    )
    average_sentence_length = word_count / len(tokenized_sentences)
    complex_word_percentage = 100 * complex_word_count / word_count
    return round(0.4 * (average_sentence_length + complex_word_percentage), 2)


def _is_complex_fog_word(token: str) -> bool:
    if re.fullmatch(r"[\u4e00-\u9fff]+", token):
        return len(token) >= 4
    return len(token) >= 12


def _count_tone_hits(paragraph: str, words_by_length: Sequence[str]) -> list[tuple[str, int]]:
    """在单段落内做非重叠匹配，长词优先，返回 (词, 起始位置) 列表。"""
    consumed = [False] * len(paragraph)
    hits: list[tuple[str, int]] = []
    for word in words_by_length:
        start = paragraph.find(word)
        while start != -1:
            end = start + len(word)
            if not any(consumed[start:end]):
                for index in range(start, end):
                    consumed[index] = True
                hits.append((word, start))
            start = paragraph.find(word, start + 1)
    return hits


def analyze_lexical_tone(
    mda_text: str,
    positive_words: Sequence[str] = POSITIVE_TONE_WORDS,
    negative_words: Sequence[str] = NEGATIVE_TONE_WORDS,
    risk_words: Sequence[str] = RISK_DISCLOSURE_WORDS,
) -> dict[str, Any]:
    """词典法量化 MD&A 语调：全文正/负面词非重叠计数、密度与段落定位。

    LLM 乐观分是对全文的主观打分，本函数给出可核查的客观词频证据，用于交叉验证。
    风险披露词单列，仅反映披露强度，不计入正/负面情绪比。
    """
    if not isinstance(mda_text, str) or not mda_text.strip():
        raise ValueError("词频分析输入文本不能为空")

    positive_by_length = sorted(set(positive_words), key=len, reverse=True)
    negative_by_length = sorted(set(negative_words), key=len, reverse=True)
    risk_by_length = sorted(set(risk_words), key=len, reverse=True)

    paragraphs = [line.strip() for line in mda_text.splitlines() if line.strip()]
    char_count = sum(len(paragraph) for paragraph in paragraphs) or 1

    positive_counter: Counter[str] = Counter()
    negative_counter: Counter[str] = Counter()
    risk_counter: Counter[str] = Counter()
    positive_paragraphs: dict[str, list[int]] = {}
    negative_paragraphs: dict[str, list[int]] = {}
    risk_paragraphs: dict[str, list[int]] = {}

    for number, paragraph in enumerate(paragraphs, start=1):
        for word, _ in _count_tone_hits(paragraph, positive_by_length):
            positive_counter[word] += 1
            positive_paragraphs.setdefault(word, []).append(number)
        for word, _ in _count_tone_hits(paragraph, negative_by_length):
            negative_counter[word] += 1
            negative_paragraphs.setdefault(word, []).append(number)
        for word, _ in _count_tone_hits(paragraph, risk_by_length):
            risk_counter[word] += 1
            risk_paragraphs.setdefault(word, []).append(number)

    positive_hits = sum(positive_counter.values())
    negative_hits = sum(negative_counter.values())
    risk_hits = sum(risk_counter.values())
    tone_total = positive_hits + negative_hits

    def _word_rows(counter: Counter[str], paragraph_map: dict[str, list[int]]) -> list[dict[str, Any]]:
        rows = []
        for word, count in counter.most_common():
            seen: list[int] = []
            for number in paragraph_map[word]:
                if number not in seen:
                    seen.append(number)
            rows.append({"词": word, "命中次数": count, "段落": seen[:8], "段落数": len(seen)})
        return rows

    return {
        "char_count": char_count,
        "positive_hits": positive_hits,
        "negative_hits": negative_hits,
        "risk_hits": risk_hits,
        "net_hits": positive_hits - negative_hits,
        "positive_density": round(positive_hits / char_count * 1000, 3),
        "negative_density": round(negative_hits / char_count * 1000, 3),
        "lexical_optimism_score": round(100 * positive_hits / tone_total, 2) if tone_total else 0.0,
        "positive_words": _word_rows(positive_counter, positive_paragraphs),
        "negative_words": _word_rows(negative_counter, negative_paragraphs),
        "risk_words": _word_rows(risk_counter, risk_paragraphs),
    }


def extract_highlight_image(
    pdf_path: str | Path,
    keywords: Sequence[str],
    output_path: str | Path | None = None,
) -> Path | None:
    """\u641c\u7d22\u5e74\u62a5 PDF \u4e2d\u7684\u4e50\u89c2\u5173\u952e\u8bcd\uff0c\u9ad8\u4eae\u547d\u4e2d\u5904\u5e76\u622a\u53d6\u6240\u5728\u6bb5\u843d\u7684\u53ef\u8bfb\u622a\u56fe\uff0c\u8fd4\u56de\u56fe\u7247\u8def\u5f84\u3002"""
    source_path = Path(pdf_path)
    if not source_path.is_file():
        raise FileNotFoundError(f"PDF \u6587\u4ef6\u4e0d\u5b58\u5728: {source_path}")
    if not keywords:
        raise ValueError("\u9ad8\u4eae\u5173\u952e\u8bcd\u5217\u8868\u4e0d\u80fd\u4e3a\u7a7a")

    cache_seed = f"{_HIGHLIGHT_CLIP_VERSION}\x00" + "\x00".join(keywords)
    keyword_tag = hashlib.sha256(cache_seed.encode("utf-8")).hexdigest()[:8]
    target = (
        Path(output_path)
        if output_path
        else source_path.with_name(f"{source_path.stem}_highlight_{keyword_tag}.png")
    )
    if target.is_file():
        return target

    with pymupdf.open(source_path) as document:
        best_page = None
        best_rects: list[pymupdf.Rect] = []
        for page_index in range(len(document)):
            page = document[page_index]
            rects = [rect for keyword in keywords for rect in page.search_for(keyword)]
            if rects and len(rects) > len(best_rects):
                best_page = page
                best_rects = rects
        if best_page is None:
            return None

        for rect in best_rects:
            best_page.add_highlight_annot(rect).update()

        clip = _readable_clip(best_page, best_rects)
        pixmap = best_page.get_pixmap(matrix=pymupdf.Matrix(3, 3), clip=clip)

    target.parent.mkdir(parents=True, exist_ok=True)
    pixmap.save(target)
    return target


def extract_dense_highlight_pages(
    pdf_path: str | Path,
    keywords: Sequence[str],
    top_k: int = 3,
    output_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """对正面语气词命中最密集的 top_k 个 PDF 整页做全文高亮截图，返回页号/命中数/图片路径。

    单页段落截图只能展示个别命中，整页密集高亮才能直观呈现乐观措辞的分布密度。
    """
    source_path = Path(pdf_path)
    if not source_path.is_file():
        raise FileNotFoundError(f"PDF 文件不存在: {source_path}")
    if not keywords:
        raise ValueError("高亮关键词列表不能为空")

    out_dir = Path(output_dir) if output_dir else source_path.parent
    cache_seed = f"{_HIGHLIGHT_CLIP_VERSION}\x00dense\x00" + "\x00".join(keywords)
    tag = hashlib.sha256(cache_seed.encode("utf-8")).hexdigest()[:8]

    with pymupdf.open(source_path) as document:
        page_hits: list[tuple[int, int]] = []
        for page_index in range(len(document)):
            count = sum(len(document[page_index].search_for(word)) for word in keywords)
            if count:
                page_hits.append((page_index, count))
        page_hits.sort(key=lambda item: (-item[1], item[0]))

        results: list[dict[str, Any]] = []
        for page_index, count in page_hits[:top_k]:
            page_no = page_index + 1
            target = out_dir / f"{source_path.stem}_dense_p{page_no}_{tag}.png"
            if not target.is_file():
                page = document[page_index]
                for word in keywords:
                    for rect in page.search_for(word):
                        page.add_highlight_annot(rect).update()
                out_dir.mkdir(parents=True, exist_ok=True)
                page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).save(target)
            results.append({"page": page_no, "hits": count, "path": target})
    return results


def _readable_clip(
    page,
    match_rects: list[pymupdf.Rect],
    min_height: float = 240,
    max_height: float = 460,
) -> pymupdf.Rect:
    """\u628a\u622a\u56fe\u8303\u56f4\u5438\u9644\u5230\u547d\u4e2d\u5173\u952e\u8bcd\u6240\u5728\u7684\u6587\u672c\u5757\uff0c\u5e76\u5411\u4e0a\u4e0b\u6269\u5c55\u5230\u6574\u6bb5\u53ef\u8bfb\u533a\u95f4\u3002"""
    blocks = [block for block in page.get_text("blocks") if block[6] == 0]
    if not blocks:
        clip = pymupdf.Rect(match_rects[0])
        for rect in match_rects[1:]:
            clip |= rect
        return (clip + pymupdf.Rect(-24, -60, 24, 60)) & page.rect

    block_rects = [pymupdf.Rect(block[:4]) for block in blocks]
    hits = [
        index
        for index, block_rect in enumerate(block_rects)
        if any(block_rect.intersects(rect) for rect in match_rects)
    ]
    if not hits:
        center = match_rects[0].y0
        hits = [min(range(len(block_rects)), key=lambda i: abs(block_rects[i].y0 - center))]

    start, end = min(hits), max(hits)

    def span_height(first: int, last: int) -> float:
        return block_rects[last].y1 - block_rects[first].y0

    def expand() -> bool:
        nonlocal start, end
        can_up, can_down = start > 0, end < len(block_rects) - 1
        if not can_up and not can_down:
            return False
        options = []
        if can_up:
            options.append(("up", span_height(start - 1, end)))
        if can_down:
            options.append(("down", span_height(start, end + 1)))
        options.sort(key=lambda item: item[1])
        side = options[0][0]
        if side == "up":
            start -= 1
        else:
            end += 1
        return True

    while span_height(start, end) < min_height and expand():
        pass
    while span_height(start, end) < max_height and expand():
        pass

    clip = pymupdf.Rect(block_rects[start])
    for index in range(start + 1, end + 1):
        clip |= block_rects[index]
    return (clip + pymupdf.Rect(-6, -6, 6, 6)) & page.rect


def _extract_page_lines(page) -> list[dict]:
    body = page.crop((0, page.height * 0.06, page.width, page.height * 0.94))
    text = body.extract_text(x_tolerance=2, y_tolerance=3) or ""
    lines = [
        cleaned
        for raw_line in text.splitlines()
        if (cleaned := _clean_line(raw_line)) and not _is_page_number(cleaned)
    ]

    extracted = []
    for index, line in enumerate(lines):
        zone = "body"
        if index < 2:
            zone = "header"
        elif index >= len(lines) - 2:
            zone = "footer"
        extracted.append({"text": line, "zone": zone})
    return extracted


def _remove_repeated_headers_and_footers(pages: list[list[dict]]) -> list[list[str]]:
    counts = Counter()
    for lines in pages:
        candidates = {
            _repetition_key(line["text"])
            for line in lines
            if line["zone"] != "body" and _repetition_key(line["text"])
        }
        counts.update(candidates)

    threshold = max(3, int(len(pages) * 0.1))
    repeated = {text for text, count in counts.items() if count >= threshold}

    cleaned_pages = []
    for lines in pages:
        cleaned_lines = []
        for line in lines:
            if line["zone"] != "body" and _repetition_key(line["text"]) in repeated:
                continue
            cleaned_lines.append(line["text"])
        cleaned_pages.append(cleaned_lines)
    return cleaned_pages


# MD&A 至少该有这么长。实测正常切片中位约 2.3 万字，而目录误切只有 130~1600 字，
# 两者差一个数量级，所以用长度自我证伪比继续给标题规则打补丁可靠。
MDA_MIN_CHARS = 2000


def _slice_from(start, pages: list[list[dict]]) -> list[list[dict]]:
    end = None
    for page_index in range(start[0], len(pages)):
        first_candidate = start[1] + 1 if page_index == start[0] else 0
        candidates = [
            line_index
            for line_index, line in enumerate(pages[page_index])
            if line_index >= first_candidate and _is_end_heading(line["text"])
        ]
        if candidates:
            end = (page_index, candidates[0])
            break

    end_page = end[0] if end else len(pages) - 1
    section_pages = []
    for page_index in range(start[0], end_page + 1):
        line_start = start[1] + 1 if page_index == start[0] else 0
        line_end = end[1] if end and page_index == end[0] else len(pages[page_index])
        section_pages.append(pages[page_index][line_start:line_end])
    return section_pages


def _slice_mda_pages(pages: list[list[dict]]) -> list[list[dict]]:
    """选 MD&A 起点。

    目录页会把「第三节 管理层讨论与分析」和其点线页码拆成两行，
    于是「结尾是数字 / 含点线」那两条防护看不到引导符，目录条目被误判成章节标题；
    这种起点只能切出一两千字。这里按文档顺序逐个候选真正切一遍，
    取第一个长度达标的；全都不达标时退回旧规则（第一个候选页的最后一个候选），
    因此本次改动只可能更好，不会比原来更坏。
    """
    candidates = [
        (page_index, line_index)
        for page_index, lines in enumerate(pages)
        for line_index, line in enumerate(lines)
        if _is_start_heading(line["text"])
    ]
    if not candidates:
        raise ValueError("未找到管理层讨论与分析（MD&A）起始章节")

    legacy_page = candidates[0][0]
    legacy_start = (legacy_page, [li for pi, li in candidates if pi == legacy_page][-1])

    for start in candidates:
        section = _slice_from(start, pages)
        if sum(len(line["text"]) for page in section for line in page) >= MDA_MIN_CHARS:
            return section
    return _slice_from(legacy_start, pages)


def _clean_line(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"[\x00-\x1f\x7f-\x9f\ufeff\u200b-\u200d]", "", text)
    text = text.replace("�", "")
    text = re.sub(r"[\ue000-\uf8ff]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not re.search(r"[\u4e00-\u9fffA-Za-z0-9]", text):
        return ""
    return text


def _repetition_key(text: str) -> str:
    key = re.sub(r"[\s\d]", "", text)
    return key if len(key) >= 2 else ""


def _is_page_number(text: str) -> bool:
    compact = re.sub(r"\s+", "", text)
    return bool(
        re.fullmatch(r"[-—–]?\d{1,4}[-—–]?", compact)
        or re.fullmatch(r"第\d{1,4}页(?:共\d{1,4}页)?", compact)
    )


def _is_start_heading(line: str) -> bool:
    """识别 MD&A 章节标题；排除“重要提示”中带引号或指引动词的交叉引用句。"""
    compact = re.sub(r"\s+", "", line)
    if len(compact) > 45 or re.search(r"(?:\.{3,}|…{2,})\d*$", compact):
        return False
    if re.search(r"\d{1,4}$", compact):
        return False
    if re.search(r"[\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f]", compact):
        return False
    if any(marker in compact for marker in _START_REFERENCE_MARKERS):
        return False
    return any(keyword in compact for keyword in _START_KEYWORDS)


def _is_end_heading(line: str) -> bool:
    compact = re.sub(r"\s+", "", line)
    if len(compact) > 50 or _is_start_heading(compact):
        return False

    major_heading_pattern = (
        r"^(?:[\u4e00-\u9fffA-Za-z0-9()（）]{0,30}20\d{2}年年度报告(?:全文)?)?"
        r"第[一二三四五六七八九十百零〇0-9]+[章节](?![\d.])"
    )
    if re.match(major_heading_pattern, compact):
        return True

    if not any(keyword in compact for keyword in _END_KEYWORDS):
        return False
    return bool(re.match(r"^[一二三四五六七八九十]+、", compact)) or compact in _END_KEYWORDS


# ---------------------------------------------------------------------------
# 事实核对用的确定性结构化摘录：与 functions/lib/agents.ts 的 extractExcerpts 同口径。
# 只做「这条披露可不可量化」的筛选，不做任何价性判断；选段规则必须能被人工复现，
# 否则事实核对 Agent 的输入本身就成了不可核对的黑箱。
# ---------------------------------------------------------------------------
_QUANT_UNITS = (
    "%", "％", "亿元", "万元", "元", "吨", "台", "套", "辆", "家", "倍", "个百分点",
    "平方米", "公里", "万人次", "万人", "MW", "GWh", "kWh",
)
_QUANT_PATTERN = re.compile(r"[0-9][0-9,.]*\s*(?:" + "|".join(map(re.escape, _QUANT_UNITS)) + r")")

# 纯指标名词，不带褒贬：「成本」「销量」本身既不利好也不利空。
INDICATOR_NOUNS = (
    "营业收入", "收入", "成本", "费用", "毛利率", "净利率", "净利润", "归母", "利润",
    "现金流", "销量", "产量", "产能", "订单", "负债", "资产", "存货", "应收", "应付",
    "研发", "门店", "市占率", "份额", "周转", "投资", "筹资", "营业外", "减值", "补助",
    "客户", "用户", "价格", "单价", "面积", "回款", "合同", "产能利用率",
    "股利", "分红", "净资产", "利率", "余额", "规模",
)

_SECTION_HEADING = re.compile(
    r"^(?:第[一二三四五六七八九十百零〇0-9]+[章节部分]"
    r"|[0-9]{1,3}(?:\.[0-9]{1,3})*[、.．](?![0-9])"
    r"|[一二三四五六七八九十]+、"
    r"|（[一二三四五六七八九十0-9]+）"
    r"|\([0-9]+\))"
)
# 「23.0%,主要是…」里的句点会被当成编号分隔符；带句末标点或计量单位的行不是小节标题。
_MEASURE_IN_HEADING = re.compile(r"[0-9][0-9,.]*\s*(?:%|％|亿元|万元|倍|个百分点)")
_DEFINITION_LINE = re.compile(r"^“[^”]{1,30}”\s*指")
_BOILERPLATE = re.compile(r"前瞻性陈述|不构成.*承诺|敬请.*注意|审计意见.*标准无保留")
_TABLE_AMOUNT = re.compile(r"[0-9][0-9,.]{5,}")


def _is_section_heading(compact: str) -> bool:
    if not _SECTION_HEADING.match(compact):
        return False
    if len(compact) > 30:
        return False
    if re.search(r"[。！？；，,]$", compact):
        return False
    return not _MEASURE_IN_HEADING.search(compact)


def _is_table_fragment(text: str) -> bool:
    """表头与短碎片行：没有叙述，回答不了口径与原因。表内金额行保留，那正是可核对的事实。"""
    numeric_fragment = bool(re.search(r"[0-9][0-9,.]{2,}", text)) and not re.search(r"[。！？]", text)
    return numeric_fragment or len(text) <= 12


def extract_excerpts(mda_text: str, budget: int = 7000) -> dict[str, Any]:
    """按「含计量数值 + 含财务指标名词」确定性选段，并标注所属小节。"""
    paragraphs = [line.strip() for line in mda_text.splitlines() if line.strip()]
    candidates: list[dict[str, Any]] = []
    section = "（章节标题未识别）"
    for index, text in enumerate(paragraphs, start=1):
        compact = re.sub(r"\s+", "", text)
        if _is_section_heading(compact):
            section = compact
            continue
        quant_hits = len(_QUANT_PATTERN.findall(text))
        noun_hits = sum(1 for word in INDICATOR_NOUNS if word in text)
        # 必须「有计量 且 有指标名词」，或出现两个以上指标名词：
        # 只靠数字会把宏观背景句当成公司披露，只靠名词会漏掉口径。
        if not ((quant_hits > 0 and noun_hits > 0) or noun_hits >= 2):
            continue
        if _DEFINITION_LINE.match(compact) or _BOILERPLATE.search(text):
            continue
        if _is_table_fragment(text) and not _TABLE_AMOUNT.search(text.replace("%", "")):
            continue
        candidates.append(
            {
                "n": index,
                "section": section,
                "text": text,
                "score": quant_hits * 2 + noun_hits,
            }
        )

    # 先按可量化程度排序取用，再还原文档顺序：模型读乱序文本会漏掉跨段矛盾。
    candidates.sort(key=lambda item: (-item["score"], item["n"]))
    picked: list[dict[str, Any]] = []
    size = 0
    for item in candidates:
        cost = len(item["text"]) + 12
        # 跳过而非中断：排序后段落长度不单调，中断会把预算尾部整段浪费掉。
        if picked and size + cost > budget:
            continue
        picked.append(item)
        size += cost
    picked.sort(key=lambda item: item["n"])
    return {
        "excerpts": picked,
        "excerpt_count": len(picked),
        "total_paragraphs": len(paragraphs),
        "candidate_count": len(candidates),
        "char_count": size,
    }
