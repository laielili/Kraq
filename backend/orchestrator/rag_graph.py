"""RAG 问答链的 LangGraph 编排（spec §0.6-C3/C6/C7）。

设计约束，按重要性排：

1. **事件逐帧必须与 `pipeline.run_ask` 一致**，由 `tests/ask_contract/` 的对拍兜底。
   本模块不是重写算法：检索/融合/重排/校验仍调用 pipeline 与 search 里的同一批函数，
   换掉的只有"谁决定下一步走哪条线"。
2. 节点不能 `yield`。事件一律经 `get_stream_writer()` 发 `Frames` 产出的信封帧，
   由 `runner.astream_frames()` 翻成 SSE 字典。
3. 分支用条件边表达（`routing.select_pipeline` / `decide_rag_branch` 的表），
   不在节点里写 if 链。
4. `halt` 标记 = 改造前的 `return`：任何短路（未配置端点 / 无文档 / 澄清 / 融合为空 /
   生成失败）都走到 END，不再执行后续节点。
"""

from __future__ import annotations

from typing import Any, AsyncGenerator, Dict, List, Mapping, TypedDict

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from .envelope import PIPELINE_RAG, Frames
from .routing import (
    BRANCH_CLARIFY,
    BRANCH_FULL_RAG,
    BRANCH_NO_DOCS,
    BRANCH_NO_RELEVANT,
    BRANCH_OUT_OF_SCOPE_ANSWER,
    INTENT_FAQ,
    INTENT_OUT_OF_SCOPE,
    Evidence,
    decide_rag_branch,
    select_pipeline,
)

from .. import pipeline as P  # 复用同一批阶段函数，避免第二套实现


class AskState(TypedDict, total=False):
    question: str
    kb_id: str
    session_id: str
    cfg: Dict[str, Any]
    docs: List[Mapping[str, Any]]
    docs_by_id: Dict[str, Mapping[str, Any]]
    detail: Dict[str, Any]              # intent 帧的 data，澄清分支要二次携带
    intent: str
    gen_ep: Mapping[str, Any]
    gen_model: str
    vector: List[Dict[str, Any]]
    vector_available: bool
    top1_score: float
    threshold: float
    bm25: List[Dict[str, Any]]
    fused: List[Dict[str, Any]]
    reranked: List[Dict[str, Any]]
    answer: str
    validation: Dict[str, Any]
    sources: List[Dict[str, Any]]
    branch: str
    halt: bool


def _frames(state: Mapping[str, Any]) -> Frames:
    return Frames(PIPELINE_RAG, state.get("kb_id"))


# ---------------------------------------------------------------- 节点


async def n_load(state: AskState) -> Dict[str, Any]:
    kb_id = P.normalize_kb_id(state.get("kb_id") or "")
    cfg = P.get_config()
    try:
        docs = P.get_docs(kb_id)
    except KeyError:
        docs = P.get_docs(P.DEFAULT_KB_ID)
        kb_id = P.DEFAULT_KB_ID
    return {"kb_id": kb_id, "cfg": cfg, "docs": docs}


async def n_intent(state: AskState) -> Dict[str, Any]:
    w = get_stream_writer()
    cfg = state["cfg"]
    llm_label = await P._intent_llm_invoke(cfg, state["question"])
    rule_label = None if llm_label else P.classify_intent(state["question"])
    route = select_pipeline(llm_label=llm_label, rule_label=rule_label)
    intent = INTENT_OUT_OF_SCOPE if route.branch == BRANCH_OUT_OF_SCOPE_ANSWER else INTENT_FAQ
    detail = {"finalBy": route.decided_by, "intent": intent}
    w(_frames(state).stage("intent", detail))
    gen_ep, gen_model = P._resolve_stage(cfg, "generate")
    return {"intent": intent, "detail": detail, "gen_ep": gen_ep, "gen_model": gen_model,
            "branch": route.branch, "halt": gen_ep is None}


async def n_answer_out_of_scope(state: AskState) -> Dict[str, Any]:
    w = get_stream_writer()
    fr = _frames(state)
    cfg = state["cfg"]
    w(fr.stage("generate", {"model": state["gen_model"]}))
    answer = ""
    async for ev in P._generate_stream(
        cfg, state["question"], state["gen_ep"], state["gen_model"], state.get("session_id", ""),
        contexts_docs=[], docs_by_id={}, goal=P.intent_goal(cfg, "OUT_OF_SCOPE"),
        cite=False, context_mode="none",
    ):
        if ev.get("type") == "done_answer":
            answer = ev.get("answer") or ""
            break
        w(ev)
    if not answer.strip():
        return {"halt": True}
    return {"answer": answer.strip(), "sources": [], "branch": BRANCH_OUT_OF_SCOPE_ANSWER}


async def n_retrieve(state: AskState) -> Dict[str, Any]:
    w = get_stream_writer()
    fr = _frames(state)
    cfg = state["cfg"]
    docs = state["docs"]
    candidate_k = P._retrieve_top_k(cfg)
    vector_list, vector_available = await P.vector_evidence(
        state["kb_id"], cfg, docs, state["question"], candidate_k
    )
    top1_score = float(vector_list[0]["score"]) if vector_list else 0.0
    threshold = float(cfg.get("clarifyThreshold") or 0.72)
    ev = Evidence(doc_count=len(docs), vector_available=vector_available,
                  top1_score=top1_score, fused_count=None)
    route = decide_rag_branch(ev, cfg)
    docs_by_id = {str(d["id"]): d for d in docs}
    out: Dict[str, Any] = {
        "vector": vector_list, "vector_available": vector_available,
        "top1_score": top1_score, "threshold": threshold,
        "docs_by_id": docs_by_id, "branch": route.branch,
    }
    if route.branch == BRANCH_CLARIFY:
        detail = dict(state["detail"])
        detail["clarify"] = True
        detail["top1Score"] = P._round4(top1_score)
        detail["threshold"] = P._round4(threshold)
        w(fr.stage("intent", detail))
        out["detail"] = detail
    else:
        bm25_list = P.bm25_search(state["question"], docs, candidate_k)
        fused = P.rrf_fuse(
            bm25=bm25_list,
            vector=vector_list,
            bm25_weight=float(cfg.get("bm25Weight") or 0.4),
            vector_weight=float(cfg.get("vectorWeight") or 0.6),
        )
        w(fr.stage("retrieve", {
            "vectorAvailable": vector_available,
            "top1Score": P._round4(top1_score),
            "threshold": P._round4(threshold),
            "bm25": [{"id": str(r["id"]), "score": P._round4(r["score"])} for r in bm25_list],
            "vector": [{"id": str(r["id"]), "score": P._round4(r["score"])} for r in vector_list],
            "fused": [{"id": str(r["id"]), "score": P._round4(r["score"])} for r in fused],
            "titles": P._titles_map(docs),
        }))
        out.update({"bm25": bm25_list, "fused": fused, "halt": not fused})
    return out


async def n_answer_no_docs(state: AskState) -> Dict[str, Any]:
    w = get_stream_writer()
    fr = _frames(state)
    w(fr.stage("retrieve", {
        "vectorAvailable": False, "bm25": [], "vector": [], "fused": [], "titles": {},
    }))
    return {"answer": P.NO_DOCS_ANSWER, "sources": []}


async def n_answer_no_relevant(state: AskState) -> Dict[str, Any]:
    return {"answer": P.NO_RELEVANT_ANSWER, "sources": []}


async def n_rerank(state: AskState) -> Dict[str, Any]:
    w = get_stream_writer()
    fr = _frames(state)
    cfg = state["cfg"]
    docs = state["docs"]
    docs_by_id = state["docs_by_id"]
    fused = state["fused"]
    rerank_ep, rerank_model = P._resolve_stage(cfg, "rerank")
    reranked: List[Dict[str, Any]] = []
    if rerank_ep is not None and rerank_model:
        payload = [
            {"id": str(r["id"]), "text": (
                str(docs_by_id.get(str(r["id"]), {}).get("title", "")) + "\n"
                + str(docs_by_id.get(str(r["id"]), {}).get("content", "")))}
            for r in fused
        ]
        try:
            resp = await P.rerank(rerank_ep, rerank_model, state["question"], payload)
            scored_by_id = {str(x["id"]): float(x["score"]) for x in resp}
            for r in fused:
                rid = str(r["id"])
                if rid in scored_by_id:
                    reranked.append({"id": rid, "score": scored_by_id[rid], "matches": 0})
            reranked.sort(key=lambda r: float(r["score"]), reverse=True)
            fused_pos = {str(r["id"]): i for i, r in enumerate(fused)}
            for out_i, r in enumerate(reranked):
                pre = fused_pos.get(str(r["id"]), out_i + 1)
                r["matches"] = abs(pre - out_i)
        except Exception:
            reranked = []
    if not reranked:
        heuristic = P.heuristic_rerank(state["question"], fused, docs_by_id, P._rerank_top_n(cfg))
        reranked = [
            {"id": str(r["id"]), "score": P._round4(r["score"]), "matches": int(r["matches"])}
            for r in heuristic
        ]
    reranked = reranked[: P._rerank_top_n(cfg)]
    w(fr.stage("rerank", {"reranked": reranked, "titles": P._titles_map(docs)}))
    return {"reranked": reranked}


async def _generate_into(state: AskState, contexts_docs: List[Mapping[str, Any]], *, cite: bool,
                         mode: str, route_key: str) -> Dict[str, Any]:
    """澄清与完整 RAG 共用的生成段：发 generate 帧 + 转发 delta/thinking/error。"""
    w = get_stream_writer()
    fr = _frames(state)
    cfg = state["cfg"]
    w(fr.stage("generate", {"model": state["gen_model"]}))
    answer = ""
    async for ev in P._generate_stream(
        cfg, state["question"], state["gen_ep"], state["gen_model"], state.get("session_id", ""),
        contexts_docs=contexts_docs, docs_by_id=state["docs_by_id"],
        goal=P.intent_goal(cfg, route_key), cite=cite, context_mode=mode,
    ):
        if ev.get("type") == "done_answer":
            answer = ev.get("answer") or ""
            break
        w(ev)
    if not answer:
        return {"halt": True}
    return {"answer": answer}


async def n_generate_clarify(state: AskState) -> Dict[str, Any]:
    """澄清分支：跳过 BM25/rerank，也跳过校验（现状语义——校验器要求 [n] 引用，
    会把"只追问不作答"判成失败）。"""
    out = await _generate_into(state, state["vector"], cite=False, mode="titles", route_key="CLARIFY")
    if out.get("halt"):
        return out
    out["sources"] = _sources(state, state["vector"])
    return out


async def n_generate_rag(state: AskState) -> Dict[str, Any]:
    out = await _generate_into(state, state["reranked"], cite=True, mode="full", route_key="FAQ")
    if out.get("halt"):
        return out
    validation = await P._run_validation(state["cfg"], out["answer"], state["reranked"], state["docs_by_id"])
    if validation is not None:
        get_stream_writer()(_frames(state).stage("validate", validation))
        out["validation"] = validation
    out["sources"] = _sources(state, state["reranked"])
    return out


def _sources(state: AskState, ranked: List[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    docs_by_id = state["docs_by_id"]
    return [
        {
            "id": str(r["id"]),
            "title": str(docs_by_id.get(str(r["id"]), {}).get("title", "")),
            "content": str(docs_by_id.get(str(r["id"]), {}).get("content", "")),
            "score": P._round4(r["score"]),
        }
        for r in ranked
    ]


async def n_finish(state: AskState) -> Dict[str, Any]:
    get_stream_writer()(_frames(state).done(state.get("answer", ""), state.get("sources", [])))
    return {}


async def n_error_not_configured(state: AskState) -> Dict[str, Any]:
    get_stream_writer()(_frames(state).error(P.GEN_NOT_CONFIGURED))
    return {"halt": True}


# ---------------------------------------------------------------- 路由

def _after_intent(state: AskState) -> str:
    """四条出口按优先级：未配置端点 > 超出范围 > 空档案库 > 正常检索。"""
    if state.get("halt"):
        return "error_not_configured"
    if state["branch"] == BRANCH_OUT_OF_SCOPE_ANSWER:
        return "answer_out_of_scope"
    if not state["docs"]:
        return "answer_no_docs"
    return "retrieve"


def _after_retrieve(state: AskState) -> str:
    if state["branch"] == BRANCH_CLARIFY:
        return "generate_clarify"
    return "answer_no_relevant" if state.get("halt") else "rerank"


def _after_generate(state: AskState) -> str:
    return "done" if not state.get("halt") else END


def _after_short_answer(state: AskState) -> str:
    return "done" if state.get("answer") else END


def build_graph() -> StateGraph:
    g = StateGraph(AskState)
    g.add_node("load", n_load)
    g.add_node("intent", n_intent)
    g.add_node("error_not_configured", n_error_not_configured)
    g.add_node("answer_out_of_scope", n_answer_out_of_scope)
    g.add_node("answer_no_docs", n_answer_no_docs)
    g.add_node("answer_no_relevant", n_answer_no_relevant)
    g.add_node("retrieve", n_retrieve)
    g.add_node("rerank", n_rerank)
    g.add_node("generate_clarify", n_generate_clarify)
    g.add_node("generate_rag", n_generate_rag)
    g.add_node("done", n_finish)

    g.add_edge(START, "load")
    g.add_edge("load", "intent")
    g.add_conditional_edges("intent", _after_intent, {
        "error_not_configured": "error_not_configured",
        "answer_out_of_scope": "answer_out_of_scope",
        "answer_no_docs": "answer_no_docs",
        "retrieve": "retrieve",
    })
    g.add_conditional_edges("retrieve", _after_retrieve, {
        "generate_clarify": "generate_clarify",
        "answer_no_relevant": "answer_no_relevant",
        "rerank": "rerank",
    })
    g.add_edge("rerank", "generate_rag")
    g.add_conditional_edges("generate_clarify", _after_generate, {"done": "done", END: END})
    g.add_conditional_edges("generate_rag", _after_generate, {"done": "done", END: END})
    g.add_conditional_edges("answer_out_of_scope", _after_short_answer, {"done": "done", END: END})
    g.add_edge("answer_no_docs", "done")
    g.add_edge("answer_no_relevant", "done")
    g.add_edge("error_not_configured", END)
    g.add_edge("done", END)
    return g
