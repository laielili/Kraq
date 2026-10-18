"""两级路由（spec §0.6-C6/C7/C8）。判据是数据，不是散在 run_ask 里的 if 链。

L1 `select_pipeline` —— 选哪条管线。当前只有 rag 与 out_of_scope 两个出口；
  将来接 data / search 就是往 `PIPELINE_DECISIONS` 加一行，调用方零改动。
  刻意不预先写 data 管线判据：那条管线尚不存在，正则无消费者。
L2 `decide_rag_branch` —— RAG 内部走哪条线。分两张表：
  `BRANCHES_PRE`（只看档案库与向量证据，决定是否跳过 BM25/rerank）
  `BRANCHES_POST`（融合之后才知道的事实，例如 fused 为空）
  这个两阶段划分不是设计偏好，是现状语义：澄清分支必须在 BM25 之前判定。

本模块**不碰任何 IO**：取证由调用方完成后以 `Evidence` 传入，模型判定结果以
`llm_label` 传入。这样路由可单测，也不会把"检索时顺手写盘"这种副作用带进来。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from .envelope import PIPELINE_RAG

# ---------------- 出口名 ----------------
BRANCH_FULL_RAG = "full_rag"
BRANCH_CLARIFY = "clarify"
BRANCH_NO_DOCS = "no_docs"
BRANCH_NO_RELEVANT = "no_relevant"
BRANCH_OUT_OF_SCOPE_ANSWER = "out_of_scope_answer"

# ---------------- 判据来源，写进 trace 让用户看得见"为什么走这条路" ----------------
DECIDED_BY_PIN = "pin"
DECIDED_BY_LLM = "llm"
DECIDED_BY_RULE = "rule"

INTENT_FAQ = "FAQ"
INTENT_OUT_OF_SCOPE = "OUT_OF_SCOPE"
VALID_INTENTS: Tuple[str, ...] = (INTENT_FAQ, INTENT_OUT_OF_SCOPE)


@dataclass
class Route:
    """一次路由的结论。`reason` 会直接进 intent 帧的 data，前端无需二次翻译。"""

    pipeline: str
    branch: str
    decided_by: str
    reason: str
    evidence: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Evidence:
    """L2 的取证结果。由 pipeline 侧填好，路由本身不做任何查询。"""

    doc_count: int = 0
    vector_available: bool = False
    top1_score: float = 0.0
    fused_count: Optional[int] = None


# L1：意图标签 → (管线, 分支)
PIPELINE_DECISIONS: Dict[str, Tuple[str, str]] = {
    INTENT_FAQ: (PIPELINE_RAG, BRANCH_FULL_RAG),
    INTENT_OUT_OF_SCOPE: (PIPELINE_RAG, BRANCH_OUT_OF_SCOPE_ANSWER),
}


def select_pipeline(
    *,
    llm_label: Optional[str] = None,
    rule_label: Optional[str] = None,
    pin: Optional[str] = None,
) -> Route:
    """优先级：pin > 模型判定 > 规则兜底。

    模型返回非法标签时不落空——退到规则，与改造前的行为一致。
    """
    if pin:
        return Route(
            pipeline=PIPELINE_RAG,
            branch=BRANCH_FULL_RAG,
            decided_by=DECIDED_BY_PIN,
            reason=f"用户指定管线 {pin}",
        )
    label = llm_label or rule_label
    decided_by = DECIDED_BY_LLM if llm_label else DECIDED_BY_RULE
    branch = PIPELINE_DECISIONS.get(label, (PIPELINE_RAG, BRANCH_OUT_OF_SCOPE_ANSWER))[1]
    pipeline = PIPELINE_DECISIONS.get(label, (PIPELINE_RAG, BRANCH_OUT_OF_SCOPE_ANSWER))[0]
    return Route(
        pipeline=pipeline,
        branch=branch,
        decided_by=decided_by,
        reason=f"意图标签 {label}",
        evidence={"label": label, "llm": llm_label, "rule": rule_label},
    )


Predicate = Callable[[Evidence, Mapping[str, Any]], bool]


def _is_no_docs(ev: Evidence, cfg: Mapping[str, Any]) -> bool:
    return ev.doc_count == 0


def _is_clarify(ev: Evidence, cfg: Mapping[str, Any]) -> bool:
    threshold = float(cfg.get("clarifyThreshold") or 0.72)
    return ev.vector_available and ev.top1_score < threshold


def _is_degraded_clarify(ev: Evidence, cfg: Mapping[str, Any]) -> bool:
    """C8：向量不可用时，degradePolicy=clarify_first 才把它当"证据不足"。"""
    return (not ev.vector_available) and str(cfg.get("degradePolicy") or "bm25_only") == "clarify_first"


def _is_no_relevant(ev: Evidence, cfg: Mapping[str, Any]) -> bool:
    return ev.fused_count is not None and ev.fused_count == 0


# L2 阶段一：BM25/融合之前
BRANCHES_PRE: List[Tuple[str, str, Predicate]] = [
    (BRANCH_NO_DOCS, "档案库为空", _is_no_docs),
    (BRANCH_CLARIFY, "向量 top1 低于澄清阈值", _is_clarify),
    (BRANCH_CLARIFY, "向量不可用且降级策略为先澄清", _is_degraded_clarify),
]

# L2 阶段二：融合之后
BRANCHES_POST: List[Tuple[str, str, Predicate]] = [
    (BRANCH_NO_RELEVANT, "BM25 与向量融合后无候选", _is_no_relevant),
]


def decide_rag_branch(
    ev: Evidence,
    cfg: Mapping[str, Any],
    *,
    table: Optional[List[Tuple[str, str, Predicate]]] = None,
) -> Route:
    """按表顺序取首个命中；全不命中即完整 RAG。"""
    rows = BRANCHES_PRE if table is None else table
    threshold = float(cfg.get("clarifyThreshold") or 0.72)
    for branch, reason, pred in rows:
        if pred(ev, cfg):
            return Route(
                pipeline=PIPELINE_RAG,
                branch=branch,
                decided_by="evidence",
                reason=reason,
                evidence={
                    "docCount": ev.doc_count,
                    "vectorAvailable": ev.vector_available,
                    "top1Score": ev.top1_score,
                    "threshold": threshold,
                    "fusedCount": ev.fused_count,
                    "degradePolicy": str(cfg.get("degradePolicy") or "bm25_only"),
                },
            )
    return Route(
        pipeline=PIPELINE_RAG,
        branch=BRANCH_FULL_RAG,
        decided_by="evidence",
        reason="证据充分，走完整混合检索",
        evidence={
            "docCount": ev.doc_count,
            "vectorAvailable": ev.vector_available,
            "top1Score": ev.top1_score,
            "threshold": threshold,
            "fusedCount": ev.fused_count,
        },
    )
