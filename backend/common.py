"""Shared helpers and types for the Kraq backend."""

from __future__ import annotations

import asyncio
import json
import os
import re
import datetime as _dt
from pathlib import Path
from typing import Any, Dict

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent  # .../Kraq
DATA_DIR = PROJECT_ROOT / "data"
CONFIG_FILE = DATA_DIR / "config.json"
KB_FILE = DATA_DIR / "kb.json"

# ---------------------------------------------------------------------------
# Defaults (mirrors data/config.json "new format" in the brief)
# ---------------------------------------------------------------------------
DEFAULT_ENDPOINT: Dict[str, Any] = {
    "id": "ep-default-ollama",
    "name": "Ollama",
    "protocol": "ollama",
    "baseUrl": "http://localhost:11434",
    "apiKey": "",
}

DEFAULT_STAGES: Dict[str, Dict[str, Any]] = {
    "intent": {"endpointId": None, "model": ""},
    "rerank": {"endpointId": None, "model": ""},
    "generate": {"endpointId": None, "model": ""},
    "validate": {"endpointId": None, "model": ""},
}

# 逐知识库默认（仅用于“重新嵌入/新建校验提示”说明，不作为运行时回退）
KB_DEFAULT_CHUNKING: Dict[str, Any] = {"maxChars": 600, "overlap": 50}

DEFAULT_CONFIG: Dict[str, Any] = {
    "endpoints": [DEFAULT_ENDPOINT],
    "stages": {name: dict(value) for name, value in DEFAULT_STAGES.items()},
    "temperature": 0.7,
    "topK": 5,
    "retrieveTopK": 10,
    "rerankTopN": 5,
    "bm25Weight": 0.4,
    "vectorWeight": 0.6,
    # CLARIFY 分支判定：最高向量余弦分数低于该阈值 → 不走 BM25/rerank，转澄清
    "clarifyThreshold": 0.72,
    "enableValidation": True,
}

STAGE_KEYS = ("intent", "rerank", "generate", "validate")


def now_iso() -> str:
    """UTC ISO timestamp, same style as the TS side (toISOString)."""
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class CancelledError(Exception):
    """后台任务被用户取消。放在 common 是因为 link_extractor 也要抛它，
    而 link_extractor 不能被 task_queue 反向 import（循环依赖）。"""


def utf8(value: Any) -> str:
    """json.dumps with the settings every SSE/data frame in this project needs."""
    return json.dumps(value, ensure_ascii=False)


_SNIFF_BYTES = 200_000


def decode_bytes(body: bytes) -> str:
    """按嗅探到的真实编码解码，回落 utf-8/ignore。

    中文站点仍大量使用 GBK/GB2312，无条件 utf-8 会得到乱码正文。
    """
    import charset_normalizer

    match = charset_normalizer.from_bytes(body[:_SNIFF_BYTES]).best()
    if match is not None and match.encoding:
        try:
            return body.decode(match.encoding)
        except (LookupError, UnicodeDecodeError):
            pass
    return body.decode("utf-8", "ignore")


def atomic_write_json(path: Path, value: Any) -> None:
    """Write JSON as UTF-8 through a tmp file + os.replace (Windows-safe)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(path) + ".tmp")
    payload = json.dumps(value, ensure_ascii=False, indent=2)
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(payload)
    os.replace(str(tmp), str(path))


def read_json_file(path: Path) -> Any:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def json_object_after(text: str, marker: str) -> Dict[str, Any] | None:
    """取 `window.__INITIAL_STATE__={…}` 这类嵌在 HTML 里的 JS 对象字面量。

    与 first_json_object 的区别：那个是在自由文本里找第一个平衡 `{…}`，
    这里必须以 marker 为锚点，并且要处理 JS 特有的两种非 JSON 写法。
    解析失败返回 None，由调用方给业务文案（平台改版是常态，不该抛裸异常）。
    """
    idx = text.find(marker)
    if idx < 0:
        return None
    start = text.find("{", idx)
    if start < 0:
        return None
    depth, i, in_str, esc = 0, start, False, False
    while i < len(text):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
        i += 1
    if depth != 0:
        return None
    chunk = text[start : i + 1]
    # undefined 只可能是值位置的裸标识符。裸替换会把正文/键名里的
    # "undefined" 也换掉（参考实现踩过这个坑），所以限定在 : , [ 之后。
    chunk = re.sub(r"([:,[])\s*undefined(?=[,}\]])", r"\1 null", chunk)
    chunk = re.sub(r",\s*([}\]])", r"\1", chunk)  # 尾逗号
    try:
        parsed = json.loads(chunk)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def first_json_object(text: str) -> Dict[str, Any] | None:
    """Extract the first {...} block from an LLM answer (tolerant parsing)."""
    if not isinstance(text, str):
        return None
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[start : i + 1]
                    try:
                        parsed = json.loads(candidate)
                    except Exception:
                        parsed = None
                    if isinstance(parsed, dict):
                        return parsed
                    break  # unbalanced at this start, try next '{'
        start = text.find("{", start + 1)
    return None


_KB_LOCK = asyncio.Lock()

__all__ = [
    "PROJECT_ROOT",
    "DATA_DIR",
    "CONFIG_FILE",
    "KB_FILE",
    "DEFAULT_ENDPOINT",
    "DEFAULT_STAGES",
    "STAGE_KEYS",
    "KB_DEFAULT_CHUNKING",
    "DEFAULT_CONFIG",
    "now_iso",
    "utf8",
    "atomic_write_json",
    "read_json_file",
    "first_json_object",
    "KB_LOCK",
    "KB_ASYNC_LOCK",
    "kb_lock",
    "kb_async_lock",
]

# Brief wording uses "asyncio.Lock": keep synonym exports for clarity.


KB_ASYNC_LOCK = None
KB_LOCK = _KB_LOCK


def kb_lock() -> asyncio.Lock:
    return _KB_LOCK


def kb_async_lock() -> asyncio.Lock:
    return _KB_LOCK
