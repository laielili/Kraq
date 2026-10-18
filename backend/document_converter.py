#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""非 HTML 输入 → Markdown（markitdown 薄封装）。

铁律：只喂 bytes，永远不要把 URL 字符串或本地路径交给 MarkItDown.convert()。
抓取权必须留在 link_extractor（浏览器 UA + 登录态兜底靠它），同时避免
markitdown 自行把传入的字符串当 file:// 路径解析。
"""
from __future__ import annotations

import io
import re
from typing import Any, Dict, Optional

from markitdown import MarkItDown, StreamInfo

MAX_CONVERTED_CHARS = 2_000_000

_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(\s*<?(https?://[^)\s>]+)>?\s*\)")


def image_urls(markdown: str) -> list[str]:
    """回收 Markdown 里的图片地址（绝对 URL），供 embeddingMeta.images 使用。"""
    return _IMAGE_RE.findall(markdown)


def convert_bytes(
    data: bytes,
    *,
    extension: Optional[str] = None,
    mimetype: Optional[str] = None,
    filename: Optional[str] = None,
) -> Dict[str, Any]:
    """bytes → {"markdown", "title", "images"}。

    extension / mimetype 可缺省，缺省时由 magika 嗅探真实类型（实测：扩展名写
    .pdf 但内容是纯文本时，嗅探会覆盖扩展名并按文本转换成功）。
    失败一律抛带中文文案的 RuntimeError，不返回空串冒充成功。
    """
    if not data:
        raise RuntimeError("文件内容为空")

    label = (extension or filename or mimetype or "未知格式").lstrip(".")
    try:
        result = MarkItDown().convert(
            io.BytesIO(data),
            stream_info=StreamInfo(extension=extension, mimetype=mimetype, filename=filename),
        )
    except Exception as e:
        raise RuntimeError(
            f"该格式无法解析（{label}）：文件可能损坏、加密或为扫描件"
        ) from e

    markdown = (getattr(result, "markdown", None) or "").strip()
    if not markdown:
        raise RuntimeError(
            f"未能提取到文本（{label}）：可能是扫描件或纯图 PDF，需 OCR"
        )
    if len(markdown) > MAX_CONVERTED_CHARS:
        raise RuntimeError("解析结果超出 2M 字符上限，请拆分文件")

    return {
        "markdown": markdown,
        # 实测 markitdown 对含 <h1>/<title> 的 HTML 也返回 None，调用方需自备回落
        "title": getattr(result, "title", None),
        "images": image_urls(markdown),
    }
