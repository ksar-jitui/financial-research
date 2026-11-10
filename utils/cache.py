"""简易内存缓存"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Any


class SimpleCache:
    """带 TTL 的内存缓存，用于避免重复调用外部 API。"""

    def __init__(self, default_ttl: int = 3600) -> None:
        self._store: dict[str, tuple[float, Any]] = {}
        self._default_ttl = default_ttl

    def get(self, key: str) -> Any | None:
        if key not in self._store:
            return None
        expires_at, value = self._store[key]
        if time.time() > expires_at:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        self._store[key] = (time.time() + (ttl or self._default_ttl), value)

    @staticmethod
    def make_key(*args: Any) -> str:
        raw = json.dumps(args, sort_keys=True, default=str)
        return hashlib.md5(raw.encode()).hexdigest()

    def clear(self) -> None:
        self._store.clear()
