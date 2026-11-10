"""大模型调用客户端 — 统一封装 LLM API"""
from __future__ import annotations

import json
from dataclasses import dataclass

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings


@dataclass
class LLMResponse:
    content: str
    model: str
    usage: dict | None = None


class LLMClient:
    """统一的大模型调用入口，支持 OpenAI 兼容接口。"""

    def __init__(
        self,
        api_key: str = settings.llm_api_key,
        api_base: str = settings.llm_api_base,
        model: str = settings.llm_model_name,
    ) -> None:
        self._api_key = api_key
        self._api_base = api_base.rstrip("/")
        self._model = model

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=20))
    async def chat(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.3,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{self._api_base}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self._model,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                },
            )
            resp.raise_for_status()
            data = resp.json()

        choice = data["choices"][0]
        return LLMResponse(
            content=choice["message"]["content"],
            model=data.get("model", self._model),
            usage=data.get("usage"),
        )

    async def chat_json(self, system_prompt: str, user_prompt: str) -> dict:
        """调用 LLM 并期望返回 JSON 格式结果。"""
        resp = await self.chat(system_prompt, user_prompt, temperature=0.1)
        try:
            return json.loads(resp.content)
        except json.JSONDecodeError:
            cleaned = resp.content.strip()
            if cleaned.startswith("```"):
                lines = cleaned.split("\n")
                lines = [l for l in lines if not l.startswith("```")]
                cleaned = "\n".join(lines)
            return json.loads(cleaned)
