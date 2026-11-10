"""Agent 基类 — 所有分析 Agent 的抽象基类"""
from __future__ import annotations

import abc
import logging
from typing import Any

from utils.llm_client import LLMClient

logger = logging.getLogger(__name__)


class BaseAgent(abc.ABC):
    """所有分析 Agent 的基类，封装 LLM 调用和日志。"""

    agent_name: str = "BaseAgent"

    def __init__(self, llm_client: LLMClient | None = None) -> None:
        self._llm = llm_client or LLMClient()

    @abc.abstractmethod
    async def analyze(self, **kwargs: Any) -> dict:
        """执行分析，返回结构化结果字典。"""
        ...

    async def _call_llm(self, system_prompt: str, user_prompt: str) -> dict:
        logger.info("[%s] 调用 LLM ...", self.agent_name)
        try:
            result = await self._llm.chat_json(system_prompt, user_prompt)
            logger.info("[%s] LLM 返回成功", self.agent_name)
            return result
        except Exception as exc:
            logger.error("[%s] LLM 调用失败: %s", self.agent_name, exc)
            raise
