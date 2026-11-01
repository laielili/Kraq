"""切块前原文（Markdown）留存层。

入库链路统一成：任意格式 → markitdown 转 Markdown → **存一份 Markdown 原文** → 切块 →
每块记录带 `sourceId`。这样"重新嵌入"才有东西可重切：清空向量库后按当前 chunking 策略
从原文重切、再重嵌。

原文只存转换后的 Markdown，不存原始二进制（PDF/DOCX 的原件不在本层职责内）。
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import List, Optional

from .common import DATA_DIR

_SAFE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

RAW_DIR = DATA_DIR / "raw"


def new_source_id() -> str:
    return "src_" + uuid.uuid4().hex[:12]


def _safe(part: str) -> str:
    """kbId / sourceId 会拼进路径，只允许安全字符——防止越权写到 data/ 之外。"""
    text = str(part or "")
    if not _SAFE.match(text) or text in (".", ".."):
        raise ValueError(f"非法标识符：{part!r}")
    return text


def raw_path(kb_id: str, source_id: str) -> Path:
    return RAW_DIR / _safe(kb_id) / f"{_safe(source_id)}.md"


def save_raw(kb_id: str, source_id: str, text: str) -> str:
    path = raw_path(kb_id, source_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(text or ""), encoding="utf-8")
    return source_id


def read_raw(kb_id: str, source_id: str) -> Optional[str]:
    try:
        return raw_path(kb_id, source_id).read_text(encoding="utf-8")
    except OSError:
        return None


def drop_raw(kb_id: str, source_id: Optional[str] = None) -> int:
    """删库时整目录删；删某个来源时只删它的文件。返回删除的文件数。"""
    if source_id is None:
        root = RAW_DIR / _safe(kb_id)
        if not root.exists():
            return 0
        removed = list(root.glob("*.md"))
        for f in removed:
            f.unlink(missing_ok=True)
        try:
            root.rmdir()
        except OSError:
            pass
        return len(removed)
    path = raw_path(kb_id, source_id)
    if path.exists():
        path.unlink(missing_ok=True)
        return 1
    return 0


def list_sources(kb_id: str) -> List[str]:
    root = RAW_DIR / _safe(kb_id)
    if not root.exists():
        return []
    return sorted(p.stem for p in root.glob("*.md"))
