"""Search helpers ported 1:1 from src/lib/rag/{bm25,pipeline,intent,reranker,validator}.ts."""

from __future__ import annotations

import math
import re
from typing import Dict, Iterable, List, Mapping, Sequence, Tuple

from .tokenizer import tokenize

K1 = 1.5
B = 0.75

ScoredDoc = Dict[str, object]  # {"id": str, "score": float}


def bm25_search(
    query: str,
    docs: Sequence[Mapping[str, object]],
    top_k: int,
) -> List[ScoredDoc]:
    """Ported from bm25.ts — per-char-idf BM25 over tokenized title+content."""
    q_tokens = tokenize(query)
    if not q_tokens or not docs:
        return []

    doc_tokens = [tokenize(f"{d['title']} {d['content']}") for d in docs]

    df: Dict[str, int] = {}
    for tokens in doc_tokens:
        for t in set(tokens):
            df[t] = df.get(t, 0) + 1

    n = len(docs)
    total = sum(len(tokens) for tokens in doc_tokens)
    avgdl = (total / n) if n else 0 or 1

    scored: List[ScoredDoc] = []
    for i, tokens in enumerate(doc_tokens):
        tf: Dict[str, int] = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1
        dl = len(tokens) or 1
        score = 0.0
        for t in q_tokens:
            f = tf.get(t)
            if not f:
                continue
            df_t = df.get(t, 0)
            idf = math.log(1 + (n - df_t + 0.5) / (df_t + 0.5))
            score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (dl / avgdl)))
        if score > 0:
            scored.append({"id": docs[i]["id"], "score": score})
    scored.sort(key=lambda r: r["score"], reverse=True)
    return scored[:top_k]


def rrf_fuse(
    bm25: Sequence[ScoredDoc],
    vector: Sequence[ScoredDoc],
    bm25_weight: float,
    vector_weight: float,
) -> List[ScoredDoc]:
    """Ported from pipeline.ts (k = 60, weighted reciprocal rank fusion)."""
    k = 60
    scores: Dict[str, float] = {}
    for i, r in enumerate(bm25):
        rid = str(r["id"])
        scores[rid] = scores.get(rid, 0.0) + bm25_weight / (k + i + 1)
    for i, r in enumerate(vector):
        rid = str(r["id"])
        scores[rid] = scores.get(rid, 0.0) + vector_weight / (k + i + 1)
    out = [{"id": rid, "score": s} for rid, s in scores.items()]
    out.sort(key=lambda r: r["score"], reverse=True)
    return out


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    denom = na * nb
    if denom <= 0:
        return 0.0
    return dot / denom ** 0.5


# Supported reorder metric: stable sort by (matches desc, fused score desc),
# matching reranker.ts: scored.sort((a, b) => b.matches - a.matches || b.score - a.score).


def heuristic_rerank(
    query: str,
    candidates: Sequence[ScoredDoc],
    docs_by_id: Mapping[str, Mapping[str, object]],
    top_n: int,
) -> List[Dict[str, object]]:
    """Ported from reranker.ts — query-token overlap then original score."""
    q_tokens = set(tokenize(query))
    scored: List[Dict[str, object]] = []
    for c in candidates:
        cid = str(c["id"])
        doc = docs_by_id.get(cid)
        tokens = set(tokenize(f"{doc['title']} {doc['content']}")) if doc else set()
        matches = sum(1 for t in q_tokens if t in tokens)
        scored.append({"id": cid, "score": c["score"], "matches": matches})
    scored.sort(key=lambda r: (float(r["matches"]), float(r["score"])), reverse=True)
    return scored[:top_n]


INTENT_LABELS = ("FAQ", "SEARCH", "CLARIFY", "OUT_OF_SCOPE")

_CLARIFY_PATTERNS: Tuple[re.Pattern[str], ...] = tuple(
    re.compile(p)
    for p in (
        r"\btell me about it\b",
        r"\bwhat about (?:that|this|it|those|these|them)\b",
        r"\bthat thing\b",
        r"\bthis thing\b",
        r"\babout (?:it|that|this|them)\s*[?!.]*\s*$",
        r"\byou know (?:what|which one)\b",
        r"^(那|这)(个|件|些)?(东西|事情|事)?(呢|怎么样|如何)?[?？。！!]*$",
    )
)

_SEARCH_PATTERNS: Tuple[re.Pattern[str], ...] = tuple(
    re.compile(p)
    for p in (
        r"\b(?:find|show|get|fetch|search|look up|list)\b[^.?!]*\b(?:articles?|tutorials?|posts?|videos?|results?|resources?|papers?|guides?|docs?|documentation)\b",
        r"\b(?:find|show|get|fetch|search|list)\s+me\b",
        r"\b(?:latest|newest|recent|top\s+\d+)\b[^.?!]*(?:articles?|tutorials?|posts?|videos?|results?|resources?|papers?|guides?|news)\b",
        r"\bsearch (?:the )?(?:web|internet|docs?)\b",
        r"(?:找|搜|检索|搜索).{0,12}(?:文章|资料|文档|论文|新闻|教程|结果|资源|视频)",
        r"(?:帮我)?(?:找一下|搜一下|查一下)",
    )
)

FAQ_PATTERNS: Tuple[re.Pattern[str], ...] = tuple(
    re.compile(p)
    for p in (
        r"\bwhat(?:'s| is| are) your\b",
        r"\bhow (?:do|can|should|would)\s+(?:i|you|we)\b",
        r"\bwhere (?:is|are|do|can)\b[^.?!]*\byour\b",
        r"\bwhen (?:is|are|do|can)\b[^.?!]*\byour\b",
        r"\bdo you (?:support|have|offer|accept|provide)\b",
        r"\bcan i (?:cancel|upgrade|downgrade|return|refund|change|reset|delete)\b",
        r"\breset (?:my|the)\s+\w+\b",
        r"\bmy (?:account|order|password|subscription|invoice|profile|billing)\b",
        r"\bwhat is\b",
        r"\bwhat are\b",
        r"\bhow to\b",
        r"什么是|是什么",
        r"怎么|如何",
        r"为什么|为啥",
        r"是否",
        r"谁是|是谁",
        r"什么时候|何时",
        r"哪里|哪儿|何处",
        r"介绍(?:一下)?",
    )
)

INTENT_GROUP_ORDER = ("CLARIFY", "SEARCH", "FAQ")

INTENT_PATTERN_GROUPS: Dict[str, Iterable[re.Pattern[str]]] = {
    "CLARIFY": list(_CLARIFY_PATTERNS),
    "SEARCH": list(_SEARCH_PATTERNS),
    "FAQ": list(FAQ_PATTERNS),
}


def classify_intent(text: str) -> str:
    """Ported from intent.ts — rule-based fallback classifier."""
    normalized = text.strip().lower()
    if not normalized:
        return "OUT_OF_SCOPE"
    for label in INTENT_GROUP_ORDER:
        for pattern in INTENT_PATTERN_GROUPS[label]:
            if pattern.search(normalized):
                return label
    return "OUT_OF_SCOPE"


_CITATION_RE = re.compile(r"\[(\d+)\]")


def validate_answer(answer: str, contexts: Sequence[str]) -> Dict[str, object]:
    """Ported from validator.ts — citation + naive hallucination checks."""
    citations: List[int] = []
    for m in _CITATION_RE.finditer(answer):
        try:
            n = int(m.group(1))
        except ValueError:
            continue
        if n > 0:
            citations.append(n)
    if not citations:
        return {"valid": False, "citations": [], "reason": "回答缺少引用标注 [n]"}
    out_of_range = [n for n in citations if n > len(contexts)]
    if out_of_range:
        uniq = list(dict.fromkeys(out_of_range))
        refs = "], [".join(str(n) for n in uniq)
        return {
            "valid": False,
            "citations": citations,
            "reason": f"引用编号越界: [{refs}]，资料共 {len(contexts)} 条",
        }
    total_len = sum(len(c) for c in contexts)
    if len(answer) > total_len * 2:
        return {"valid": False, "citations": citations, "reason": "回答长度远超资料长度，疑似幻觉"}
    return {
        "valid": True,
        "citations": citations,
        "reason": f"引用编号均在资料范围内（共 {len(citations)} 处）",
    }
