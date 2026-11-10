"""Agent A — 文本情绪分析 Agent，对 MD&A 文本进行乐观度打分"""
from __future__ import annotations

import asyncio
from typing import Any

from agents.base_agent import BaseAgent
from config.prompts.text_sentiment import TEXT_SENTIMENT_SYSTEM, TEXT_SENTIMENT_USER
from data.processing.text_chunker import TextChunk


class TextSentimentAgent(BaseAgent):
    agent_name = "TextSentimentAgent"

    async def analyze(self, chunks: list[TextChunk], **kwargs: Any) -> dict:
        """对多个文本分块分别打分，然后汇总。"""
        tasks = [self._analyze_chunk(chunk) for chunk in chunks]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        valid = [r for r in results if not isinstance(r, Exception)]
        if not valid:
            return {"sentiment_score": 50.0, "key_arguments": [], "error": "所有分块分析失败"}

        return self._aggregate(valid)

    async def _analyze_chunk(self, chunk: TextChunk) -> dict:
        prompt = TEXT_SENTIMENT_USER.format(text_chunk=chunk.text)
        result = await self._call_llm(TEXT_SENTIMENT_SYSTEM, prompt)
        result["_chunk_index"] = chunk.index
        result["_char_range"] = (chunk.char_start, chunk.char_end)
        return result

    def _aggregate(self, results: list[dict]) -> dict:
        scores = [r.get("sentiment_score", 50) for r in results]
        all_arguments: list[str] = []
        all_positive: list[str] = []
        all_negative: list[str] = []
        all_quotes: list[str] = []

        for r in results:
            all_arguments.extend(r.get("key_arguments", []))
            all_positive.extend(r.get("positive_keywords", []))
            all_negative.extend(r.get("negative_keywords", []))
            all_quotes.extend(r.get("notable_quotes", []))

        return {
            "sentiment_score": sum(scores) / len(scores),
            "chunk_scores": scores,
            "key_arguments": list(dict.fromkeys(all_arguments))[:10],
            "positive_keywords": list(dict.fromkeys(all_positive))[:15],
            "negative_keywords": list(dict.fromkeys(all_negative))[:15],
            "notable_quotes": list(dict.fromkeys(all_quotes))[:5],
            "chunk_count": len(results),
        }
