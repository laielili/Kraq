"""Tokenizer ported 1:1 from src/lib/rag/tokenizer.ts."""

from __future__ import annotations

import re
from typing import List

# [a-z0-9]+ words (input is pre-lowercased, same as the TS version)
_WORD_RE = re.compile(r"[a-z0-9]+")
# Consecutive CJK runs (same range as /\u4e00-\u9fff/)
_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]+")


def tokenize(text: str) -> List[str]:
    lowered = text.lower()
    tokens: List[str] = []
    for m in _WORD_RE.finditer(lowered):
        tokens.append(m.group(0))
    for run in _CJK_RUN_RE.finditer(lowered):
        chars = list(run.group(0))
        tokens.extend(chars)
        for i in range(len(chars) - 1):
            tokens.append(chars[i] + chars[i + 1])
    return tokens
