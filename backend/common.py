"""Shared helpers and types for the DataAgent backend."""

from __future__ import annotations

import asyncio
import json
import os
import datetime as _dt
from pathlib import Path
from typing import Any, Dict

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent  # .../DataAgent
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
    "embedding": {"endpointId": None, "model": ""},
    "rerank": {"endpointId": None, "model": ""},
    "generate": {"endpointId": None, "model": ""},
    "validate": {"endpointId": None, "model": ""},
}

DEFAULT_CHUNKING: Dict[str, Any] = {"maxChars": 600, "overlap": 50}

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
    "chunking": dict(DEFAULT_CHUNKING),
}

STAGE_KEYS = ("intent", "embedding", "rerank", "generate", "validate")


def now_iso() -> str:
    """UTC ISO timestamp, same style as the TS side (toISOString)."""
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def utf8(value: Any) -> str:
    """json.dumps with the settings every SSE/data frame in this project needs."""
    return json.dumps(value, ensure_ascii=False)


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
    "DEFAULT_CHUNKING",
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
