"""RAG ask pipeline (SSE event generator), ported from the brief + src contracts.

run_ask(question, kb_id) yields AskEvent dicts EXACTLY matching the applyEvent
contract in src/app/page.tsx (types pinned in src/lib/rag/types.ts), plus a
kb_id field on the first intent stage + done event so the frontend can pin
which KB produced the answer.

Event order: intent -> retrieve -> rerank -> generate -> delta* -> validate -> done.
Intent stage uses the configured LLM (INTENT_SYSTEM classification prompt) ->
Vectors live in Chroma (chroma_store.query); kb.json stores no embeddings —
embeddingMeta is a {model, dim, upserted} marker only.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, AsyncGenerator, Dict, List, Mapping, Optional, Tuple

from . import chroma_store
from .common import first_json_object
from .models_client import (
    chat_invoke,
    chat_stream,
    embed_texts,
    rerank,
)
from .search import (
    bm25_search,
    classify_intent,
    heuristic_rerank,
    rrf_fuse,
)
from .store import (
    DATA_FILE_LOCK,
    DEFAULT_KB_ID,
    default_system_prompt,
    get_config,
    get_docs,
    mark_embedding_meta,
    normalize_kb_id,
    replace_docs,
)

INTENT_SYSTEM = (
    "你是知识库问答系统的意图分类器。FAQ=询问知识库资料内容的问题（如公司制度、流程、条款）；"
    "SEARCH=想查找、定位或列出知识库中的资料；CLARIFY=表达不完整或指代不明，需要先澄清；"
    "OUT_OF_SCOPE=与知识库无关的消息（如闲聊、天气、新闻、写代码）。"
    "只输出 FAQ、SEARCH、CLARIFY、OUT_OF_SCOPE 之一。"
)
INTENT_PARSE_RE = re.compile(r"(FAQ|SEARCH|CLARIFY|OUT_OF_SCOPE)")
VALID_INTENTS = ("FAQ", "SEARCH", "CLARIFY", "OUT_OF_SCOPE")


async def _intent_llm_invoke(cfg: Mapping[str, Any], question: str, session_id: str = "") -> Optional[str]:
    """意图阶段配置的端点模型做一次分类，返回合法标签或 None（未配置/失败）。"""
    ep_i, model_i = _resolve_stage(cfg, "intent")
    if ep_i is None or not model_i:
        return None
    try:
        text = await chat_invoke(
            ep_i,
            model_i,
            [
                {"role": "system", "content": INTENT_SYSTEM},
                {"role": "user", "content": question},
            ],
            0.0,
            # qwen3 等思考模型会先输出思考内容，8 tokens 会在标签出现前截断
            256,
            # 分类调用不需要思考链；qwen3 默认思考会把预算烧光导致 content 为空
            think=False,
            session_id=session_id,
        )
    except Exception:
        return None
    m = INTENT_PARSE_RE.search(text or "")
    if not m:
        return None
    label = m.group(1)
    return label if label in VALID_INTENTS else None

SYSTEM_PROMPT = (
    "你是知识库问答助手，必须只依据给出的编号资料回答问题，"
    "在答案中用 [n] 标注所引用资料的编号（如 [1]、[2]）。"
    "如果资料不足以回答问题，就直接明确说明资料不足，不要编造内容。"
)
RAG_USER_TEMPLATE = "编号资料：\n{contexts}\n\n用户问题：{question}\n\n请基于以上资料回答，并标注引用编号。"

OUT_OF_SCOPE_ANSWER = "抱歉，该问题超出了本知识库的服务范围，我无法回答。"
NO_DOCS_ANSWER = "知识库暂无文档，请先在左侧「档案柜」中添加资料后再提问。"
GEN_NOT_CONFIGURED = "尚未配置生成模型，请点击右上角「检索与生成参数 → 配置模型」完成配置。"
NO_RELEVANT_ANSWER = "知识库中暂未检索到与该问题相关的资料，无法作答。"
NO_RELEVANT_ANSWER_NOTE = NO_RELEVANT_ANSWER
CITATION_RE = re.compile(r"\[(\d+)\]")


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def _stage(cfg: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    stages = cfg.get("stages") or {}
    s = stages.get(key)
    return s if isinstance(s, Mapping) else {}


def _resolve_stage(cfg: Mapping[str, Any], key: str) -> Tuple[Optional[Mapping[str, Any]], str]:
    """stage cfg -> (endpoint map, model); (None, "") = unconfigured/dead ref."""
    stage = _stage(cfg, key)
    ep_id = stage.get("endpointId")
    model = str(stage.get("model") or "").strip()
    if not ep_id or not model:
        return None, ""
    for ep in cfg.get("endpoints") or []:
        if str(ep.get("id")) == str(ep_id):
            if not str(ep.get("baseUrl") or "").strip():
                return None, ""
            return ep, model
    return None, ""  # dangling endpointId -> treat as unconfigured at ask time


def _round4(x: float) -> float:
    return round(float(x), 4)


def _int_cfg(cfg: Mapping[str, Any], key: str, default: int) -> int:
    try:
        v = int(cfg.get(key) or default)
    except Exception:
        v = default
    return max(v, 1)


def _retrieve_top_k(cfg: Mapping[str, Any]) -> int:
    """召回候选数：retrieveTopK 优先；老配置回落到旧 topK。"""
    if cfg.get("retrieveTopK") is not None:
        return _int_cfg(cfg, "retrieveTopK", 10)
    return _int_cfg(cfg, "topK", 5)


def _rerank_top_n(cfg: Mapping[str, Any]) -> int:
    """重排后保留数（业界 top_n）：rerankTopN 优先；老配置回落到旧 topK。"""
    if cfg.get("rerankTopN") is not None:
        return _int_cfg(cfg, "rerankTopN", 5)
    return _int_cfg(cfg, "topK", 5)


def _titles_map(docs: List[Mapping[str, Any]]) -> Dict[str, str]:
    return {str(d["id"]): str(d["title"]) for d in docs}


# --------------------------------------------------------------------------
# embedding via Chroma
# --------------------------------------------------------------------------
def _meta_matches_current(doc: Mapping[str, Any], model: str, dim: int) -> bool:
    meta = doc.get("embeddingMeta")
    if not isinstance(meta, Mapping):
        return False
    if str(meta.get("model") or "") != model or int(meta.get("dim") or 0) != dim:
        return False
    return bool(meta.get("upserted"))


def _doc_text(doc: Mapping[str, Any]) -> str:
    return str(doc.get("title") or "") + "\n" + str(doc.get("content") or "")



async def compute_missing_vectors(
    kb_id: str,
    docs: List[Mapping[str, Any]],
    ep: Mapping[str, Any],
    model: str,
    force: bool = False,
) -> Dict[str, List[float]]:
    """ensureEmbeddings for one KB: load docs from kb.json, find those whose
    embeddingMeta is missing/mismatched, re-embed them, upsert vectors into
    Chroma, mark embeddingMeta {model, dim, upserted} in kb.json (no arrays
    written back). Returns doc_id -> vector for the just-computed subset.
    Caller thread must NOT hold DATA_FILE_LOCK while we await embed_texts —
    this fn is called outside the lock and only takes it for the writeback.
    """
    missing: List[Mapping[str, Any]] = []
    for d in docs:
        meta = d.get("embeddingMeta")
        ok = (
            isinstance(meta, Mapping)
            and bool(meta.get("upserted"))
            and str(meta.get("model") or "") == model
        )
        if force or not ok:
            missing.append(d)
    vectors: Dict[str, List[float]] = {}
    if not missing:
        return vectors
    # dim known only after first successful response — rely on response len
    texts = [_doc_text(d) for d in missing]
    ids = [str(d["id"]) for d in missing]
    resp = await embed_texts(ep, model, texts)
    if not resp or len(resp) != len(texts):
        raise ValueError("embedding 批量接口返回数量不匹配")
    it = iter(resp)
    dim = len(resp[0])
    for did in ids:
        vec = [float(x) for x in next(it)]
        vectors[did] = vec
    chroma_store.upsert(kb_id, ids, [vectors[did] for did in ids])
    async with DATA_FILE_LOCK:
        mark_embedding_meta(kb_id, ids, model, dim)
    return vectors


async def sync_all_background() -> None:
    """Startup backfill: walk all KBs, embed + upsert docs missing vectors.
    Never raises; logs progress. Doc-level failures are logged, others skipped.
    """
    cfg = get_config()
    ep, model = _resolve_stage(cfg, "embedding")
    if ep is None or not model:
        print("[sync_all] embedding 端点未配置，跳过向量补算")
        return
    from .store import get_kbs

    try:
        kbs = get_kbs()
    except Exception as e:
        print(f"[sync_all] 读取知识库失败：{e}")
        return
    for kb in kbs:
        kb_id = kb["kbId"]
        docs = kb["docs"]
        missing = [
            d
            for d in docs
            if not (
                isinstance(d.get("embeddingMeta"), Mapping)
                and d["embeddingMeta"].get("model") == model
                and d["embeddingMeta"].get("upserted")
            )
        ]
        if not missing:
            print(f"[sync_all] kb={kb_id} 共 {len(docs)} 篇，向量齐备")
            continue
        print(f"[sync_all] kb={kb_id} 缺向量 {len(missing)}/{len(docs)} 篇，开始补算…")
        try:
            vectors = await compute_missing_vectors(kb_id, missing, ep, model)
            print(f"[sync_all] kb={kb_id} 已补算并 upsert {len(vectors)} 条向量")
        except Exception as e:
            print(f"[sync_all] kb={kb_id} 补算失败（不影响启动）：{e}")


# --------------------------------------------------------------------------
# vector retrieve via Chroma
# --------------------------------------------------------------------------
async def _vector_candidates(
    kb_id: str,
    cfg: Mapping[str, Any],
    docs: List[Mapping[str, Any]],
    question: str,
    top_n: int,
) -> Tuple[List[Dict[str, Any]], bool]:
    """Returns (scored, vectorAvailable). Any embedding failure -> ([], False).
    Missing-vector docs are lazily embedded here (same rules as sync_all)."""
    try:
        ep, model = _resolve_stage(cfg, "embedding")
        if ep is None or not model:
            return [], False
        doc_ids = {str(d["id"]) for d in docs}
        stale = [
            d
            for d in docs
            if not (
                isinstance(d.get("embeddingMeta"), Mapping)
                and d["embeddingMeta"].get("model") == model
                and d["embeddingMeta"].get("upserted")
            )
        ]
        if stale:
            await compute_missing_vectors(kb_id, stale, ep, model)
            docs = get_docs(kb_id)
            doc_ids = {str(d["id"]) for d in docs}
        q_resp = await embed_texts(ep, model, [question])
        if not q_resp or not q_resp[0]:
            return [], False
        q_vec = [float(x) for x in q_resp[0]]
        hits = chroma_store.query(kb_id, q_vec, top_n)
        scored = [h for h in hits if h["id"] in doc_ids and h["score"] > 0]
        scored.sort(key=lambda r: float(r["score"]), reverse=True)
        return scored[:top_n], True
    except Exception:
        return [], False


# --------------------------------------------------------------------------
# generation prompt helpers
# --------------------------------------------------------------------------
def build_contexts_block(reranked: List[Mapping[str, Any]], docs_by_id: Mapping[str, Mapping[str, Any]]) -> str:
    lines: List[str] = []
    for i, r in enumerate(reranked):
        doc = docs_by_id.get(str(r["id"])) or {}
        title = str(doc.get("title") or "")
        content = str(doc.get("content") or "")
        lines.append(f"[{i + 1}] {title}\n{content}")
    return "\n".join(lines)


def _validate_payload(answer: str, contexts: List[Tuple[str, str]]) -> str:
    sources = [
        {"编号": i + 1, "标题": t, "内容": c[:400]}
        for i, (t, c) in enumerate(contexts)
    ]
    return json.dumps({"answer": answer, "sources": sources}, ensure_ascii=False)


def rule_fallback_validate(answer: str, source_count: int, citations: List[int]) -> Dict[str, Any]:
    """validator.ts port: any [n] fully inside 1..source_count -> valid."""
    if not citations:
        return {"valid": False, "citations": [], "reason": "回答缺少引用标注 [n]，请重新生成后再试"}
    out_of_range = [n for n in citations if n <= 0 or n > source_count]
    if out_of_range:
        uniq = sorted(set(out_of_range))
        refs = "], [".join(str(n) for n in uniq)
        return {"valid": False, "citations": citations, "reason": f"引用编号越界: [{refs}]，资料共 {source_count} 条"}
    dedup = list(dict.fromkeys(citations))
    return {"valid": True, "citations": dedup, "reason": f"引用编号均在资料范围内，已去重为 {len(dedup)} 位编号"}


# --------------------------------------------------------------------------
# run_ask
# --------------------------------------------------------------------------
async def run_ask(
    question: str,
    kb_id: str = DEFAULT_KB_ID,
    session_id: str = "",
) -> AsyncGenerator[Dict[str, Any], None]:
    kb_id = normalize_kb_id(kb_id)
    cfg = get_config()
    try:
        docs = get_docs(kb_id)
    except KeyError:
        docs = get_docs(DEFAULT_KB_ID)
        kb_id = DEFAULT_KB_ID

    try:
        # ------- intent (configured LLM -> rule fallback) --------------------
        intent: Optional[str] = None
        detail: Dict[str, Any] = {}

        llm_label = await _intent_llm_invoke(cfg, question)
        if llm_label is not None:
            intent = llm_label
            detail["finalBy"] = "llm"

        if intent not in VALID_INTENTS:
            intent = classify_intent(question)
            detail["finalBy"] = "rule"
        detail["intent"] = intent
        yield {"type": "stage", "stage": "intent", "data": detail, "kbId": kb_id}

        if intent == "OUT_OF_SCOPE":
            yield {"type": "done", "answer": OUT_OF_SCOPE_ANSWER, "sources": [], "kbId": kb_id}
            return

        if not docs:
            yield {
                "type": "stage",
                "stage": "retrieve",
                "data": {
                    "vectorAvailable": False,
                    "bm25": [],
                    "vector": [],
                    "fused": [],
                    "titles": {},
                },
                "kbId": kb_id,
            }
            yield {"type": "done", "answer": NO_DOCS_ANSWER, "sources": [], "kbId": kb_id}
            return

        # ---------------- retrieve: BM25 + vector + RRF --------------------
        candidate_k = _retrieve_top_k(cfg)
        bm25_list = bm25_search(question, docs, candidate_k)
        vector_list, vector_available = await _vector_candidates(
            kb_id, cfg, docs, question, candidate_k
        )
        fused = rrf_fuse(
            bm25=bm25_list,
            vector=vector_list,
            bm25_weight=float(cfg.get("bm25Weight") or 0.4),
            vector_weight=float(cfg.get("vectorWeight") or 0.6),
        )
        yield {
            "type": "stage",
            "stage": "retrieve",
            "data": {
                "vectorAvailable": vector_available,
                "bm25": [{"id": str(r["id"]), "score": _round4(r["score"])} for r in bm25_list],
                "vector": [{"id": str(r["id"]), "score": _round4(r["score"])} for r in vector_list],
                "fused": [{"id": str(r["id"]), "score": _round4(r["score"])} for r in fused],
                "titles": _titles_map(docs),
            },
            "kbId": kb_id,
        }

        if not fused:
            yield {"type": "done", "answer": NO_RELEVANT_ANSWER, "sources": [], "kbId": kb_id}
            return

        # ---------------- rerank -------------------------------------------
        docs_by_id = {str(d["id"]): d for d in docs}
        rerank_ep, rerank_model = _resolve_stage(cfg, "rerank")
        reranked: List[Dict[str, Any]] = []
        if rerank_ep is not None and rerank_model:
            payload = [
                {
                    "id": str(r["id"]),
                    "text": (
                        str(docs_by_id.get(str(r["id"]), {}).get("title", ""))
                        + "\n"
                        + str(docs_by_id.get(str(r["id"]), {}).get("content", ""))
                    ),
                }
                for r in fused
            ]
            try:
                resp = await rerank(rerank_ep, rerank_model, question, payload)
                scored_by_id = {str(x["id"]): float(x["score"]) for x in resp}
                for idx, r in enumerate(fused):
                    rid = str(r["id"])
                    if rid in scored_by_id:
                        reranked.append({"id": rid, "score": scored_by_id[rid], "matches": 0})
                reranked.sort(key=lambda r: float(r["score"]), reverse=True)
                # reorder metric: fused 序位 - rerank 序位 绝对值 作为 matches
                fused_pos = {str(r["id"]): i for i, r in enumerate(fused)}
                for out_i, r in enumerate(reranked):
                    pre = fused_pos.get(str(r["id"]), out_i + 1)
                    r["matches"] = abs(pre - out_i)
            except Exception:
                reranked = []
        if not reranked:
            reranked = heuristic_rerank(question, fused, docs_by_id, _rerank_top_n(cfg))
            reranked = [
                {"id": str(r["id"]), "score": _round4(r["score"]), "matches": int(r["matches"])}
                for r in reranked
            ]
        reranked = reranked[: _rerank_top_n(cfg)]
        yield {
            "type": "stage",
            "stage": "rerank",
            "data": {
                "reranked": reranked,
                "titles": _titles_map(docs),
            },
            "kbId": kb_id,
        }

        # ---------------- generate ------------------------------------------
        gen_ep, gen_model = _resolve_stage(cfg, "generate")
        if gen_ep is None:
            yield {"type": "error", "message": GEN_NOT_CONFIGURED}
            return
        yield {"type": "stage", "stage": "generate", "data": {"model": gen_model}, "kbId": kb_id}
        # 系统提示词：Agent 级全局定制（config.systemPrompt）优先，
        # 未定制时回落 prompts/system_kb_default.md——与知识库无关
        sys_prompt = cfg.get("systemPrompt") or default_system_prompt()
        messages = [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": RAG_USER_TEMPLATE.format(
                contexts=build_contexts_block(reranked, docs_by_id),
                question=question,
            )},
        ]
        # ... stream below passes session_id so opencode-style gateways keep
        # one stable x-opencode-session per conversation (prompt-cache hits)
        chunks: List[str] = []
        thinking_parts: List[str] = []
        try:
            async for content, thinking in chat_stream(gen_ep, gen_model, messages, float(cfg.get("temperature") or 0.7), session_id=session_id):
                if content:
                    chunks.append(content)
                    yield {"type": "delta", "text": content}
                if thinking:
                    thinking_parts.append(thinking)
                    yield {"type": "thinking", "text": thinking}
        except Exception as e:
            yield {"type": "error", "message": f"生成模型调用失败：{e}（请检查右上角「配置模型」与端点可达性）"}
            return
        answer = "".join(chunks)

        # ---------------- validate -------------------------------------------
        validation = None
        if cfg.get("enableValidation") and reranked:
            citations = [int(m.group(1)) for m in CITATION_RE.finditer(answer or "")]
            citations = [n for n in citations if n > 0]
            contexts = [
                (
                    str(docs_by_id.get(str(r["id"]), {}).get("title", "")),
                    str(docs_by_id.get(str(r["id"]), {}).get("content", "")),
                )
                for r in reranked
            ]
            val_ep, val_model = _resolve_stage(cfg, "validate")
            if val_ep is not None:
                payload = _validate_payload(answer, contexts)
                try:
                    llm_text = await chat_invoke(val_ep, val_model, [
                        {"role": "system", "content": "你是引用与幻觉校验器，只输出 JSON {\"valid\":bool,\"citations\":[int],\"reason\":str}"},
                        {"role": "user", "content": payload},
                    ], 0.0, 512)
                    parsed = first_json_object(llm_text or "")
                    if isinstance(parsed, Mapping):
                        validation = {
                            "valid": bool(parsed.get("valid")),
                            "citations": [int(x) for x in (parsed.get("citations") or []) if isinstance(x, int)],
                            "reason": str(parsed.get("reason") or ""),
                        }
                except Exception:
                    validation = None
            if validation is None:
                validation = rule_fallback_validate(answer, len(contexts), citations)
            yield {"type": "stage", "stage": "validate", "data": validation, "kbId": kb_id}

        # ---------------- done: sources from reranked ------------------------
        sources = [
            {
                "id": str(r["id"]),
                "title": str(docs_by_id.get(str(r["id"]), {}).get("title", "")),
                "content": str(docs_by_id.get(str(r["id"]), {}).get("content", "")),
                "score": _round4(r["score"]),
            }
            for r in reranked
        ]
        yield {"type": "done", "answer": answer, "sources": sources, "kbId": kb_id}

    except Exception as e:
        yield {"type": "error", "message": f"请求处理异常：{e}（请检查端点配置或稍后重试）"}
