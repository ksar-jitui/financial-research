from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager


class RateLimiter:
    """简易并发限流器，控制同时运行的协程数量。"""

    def __init__(self, max_concurrent: int = 3) -> None:
        self._semaphore = asyncio.Semaphore(max_concurrent)

    @asynccontextmanager
    async def __call__(self) -> AsyncIterator[None]:
        async with self._semaphore:
            yield
