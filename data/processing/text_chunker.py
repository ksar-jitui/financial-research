"""文本分块器 — 将 MD&A 长文本切分为可送入 LLM 的块"""
from __future__ import annotations

from dataclasses import dataclass

from config import settings


@dataclass
class TextChunk:
    index: int
    text: str
    char_start: int
    char_end: int


class TextChunker:
    """按字符窗口分块，支持 overlap 以保持上下文连贯。"""

    def __init__(
        self,
        chunk_size: int = settings.pdf_chunk_size,
        overlap: int = settings.pdf_chunk_overlap,
    ) -> None:
        self._chunk_size = chunk_size
        self._overlap = overlap

    def chunk(self, text: str) -> list[TextChunk]:
        if not text or not text.strip():
            return []

        chunks: list[TextChunk] = []
        stride = self._chunk_size - self._overlap
        start = 0
        idx = 0

        while start < len(text):
            end = min(start + self._chunk_size, len(text))
            chunk_text = text[start:end].strip()
            if chunk_text:
                chunks.append(TextChunk(index=idx, text=chunk_text, char_start=start, char_end=end))
                idx += 1
            if end >= len(text):
                break
            start += stride

        return chunks
