"""文本分块器单元测试"""
import pytest

from data.processing.text_chunker import TextChunker


class TestTextChunker:
    def setup_method(self):
        self.chunker = TextChunker(chunk_size=100, overlap=20)

    def test_empty_text(self):
        assert self.chunker.chunk("") == []
        assert self.chunker.chunk("   ") == []

    def test_short_text_single_chunk(self):
        text = "这是一段短文本"
        chunks = self.chunker.chunk(text)
        assert len(chunks) == 1
        assert chunks[0].text == text
        assert chunks[0].char_start == 0

    def test_long_text_multiple_chunks(self):
        text = "a" * 250
        chunks = self.chunker.chunk(text)
        assert len(chunks) >= 3
        assert chunks[0].char_start == 0
        assert chunks[-1].char_end == 250

    def test_overlap_continuity(self):
        text = "0123456789" * 20  # 200 chars
        chunks = self.chunker.chunk(text)
        for i in range(1, len(chunks)):
            assert chunks[i].char_start < chunks[i - 1].char_end
