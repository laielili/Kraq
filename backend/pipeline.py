"""RAG ask pipeline (SSE event generator), ported from the brief + src contracts.

run_ask(question, kb_id) yields AskEvent dicts EXACTLY matching the applyEvent
contract in src/app/page.tsx (types pinned in src/lib/rag/types.ts), plus a
kb_id field on the first intent stage + done event so the frontend can pin
which KB produced the answer.

Event order: intent -> retrieve -> rerank -> generate -> delta* -> validate -> done.
Intent is BINARY (FAQ | OUT_OF_SCOPE): the stage LLM classifies (INTENT_SYSTEM;
SEARCH merged into FAQ, CLARIFY is NOT an LLM label) -> rule fallback (search.
classify_intent, same label set). FAQ flow: vector search first — if the top-1
cosine score is below config clarifyThreshold, the CLARIFY branch runs (skip
BM25/rerank AND validation; generation is steered by the 澄清 goal alone as the
system prompt, with only the numbered doc titles offered as material — the
global answer-with-citations prompt and the [n]-requiring validator both pull a
clarification back into answering); otherwise the
full RAG chain runs (BM25 -> RRF -> rerank -> cited generation -> validation).
OOS flow: no RAG — an LLM answer steered purely by the OOS goal prompt
(先声明此类问题不在服务范围、再简短回应话题本身), streamed as delta* with a
generate stage frame, no sources; generation failure yields error and stops
(no canned refusal line is substituted). Per-intent generation goals are
agent-level templates: config.json goalPrompt*, defaults in prompts/goal_*_default.md
(mirror systemPrompt's null-follows-global convention).
Vectors live in Chroma (chroma_store.query); kb.json stores no embeddings —
embeddingMeta carries provenance (source/filename/images) plus the
{model, dim, upserted} marker written once a doc's vector is in Chroma.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import (
    Any,
    AsyncGenerator,
    Callable,
    Dict,
    List,
    Literal,
    Mapping,
    Optional,
    Tuple,
)

import httpx

from . import chroma_store
from .common import PROJECT_ROOT, first_json_object, now_iso
from .models_client import (
    EMBED_BATCH_SIZE,
    EMBED_TIMEOUT,
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
    get_kb_settings,
    get_config,
    get_docs,
    mark_embedding_meta,
    normalize_kb_id,
    replace_docs,
)

INTENT_SYSTEM = (
    "你是知识库问答系统的意图分类器。FAQ=用户想向知识库提问或查找资料，"
    "期望得到基于知识的回答或结果（问题含义模糊也算 FAQ，后续会通过澄清确认）；"
    "OUT_OF_SCOPE=与知识库问答无关的消息（如闲聊、天气、新闻、写代码）。"
    "只输出 FAQ 或 OUT_OF_SCOPE 之一。"
)
INTENT_PARSE_RE = re.compile(r"(FAQ|OUT_OF_SCOPE)")
VALID_INTENTS = ("FAQ", "OUT_OF_SCOPE")

# 意图生成目标：agent 级模板（config.goalPrompt*），未定制回落 prompts/goal_*_default.md
_GOAL_FILES: Dict[str, str] = {
    "FAQ": "goal_faq_default.md",
    "CLARIFY": "goal_clarify_default.md",
    "OUT_OF_SCOPE": "goal_oos_default.md",
}

_FALLBACK_GOALS: Dict[str, str] = {
    "FAQ": "根据编号资料回答用户问题；在答案中保持 [n] 引用标注；资料不足时明确说明，不要编造。",
    "CLARIFY": (
        "用户的问题不够明确，且检索结果置信度偏低。请根据下面的候选资料判断用户"
        "最可能想问什么，给出两三种可能的理解，并以一个具体的问题向用户澄清确认。"
        "不要给出答案本身，不要编造内容。"
    ),
    "OUT_OF_SCOPE": (
        "用户的问题与本知识库的资料范围无关。请先用一句话说明此类问题不在本知识库"
        "的服务范围内、建议咨询相关领域渠道；随后以知识库问答助手的身份，基于常识"
        "简短回应话题本身。不要说「我无法回答」（你确实会给出回应），不要编造知识库"
        "内容，不要使用 [n] 引用编号。"
    ),
}

_CONFIG_GOAL_KEYS: Dict[str, str] = {
    "FAQ": "goalPromptFaq",
    "CLARIFY": "goalPromptClarify",
    "OUT_OF_SCOPE": "goalPromptOos",
}


def intent_goal(cfg: Mapping[str, Any], route: str) -> str:
    """route ∈ FAQ / CLARIFY / OUT_OF_SCOPE: agent-level custom goal in config,
    else the prompts/goal_*_default.md sample, else the hardcoded fallback."""
    text = str(cfg.get(_CONFIG_GOAL_KEYS[route]) or "").strip()
    if text:
        return text
    path = PROJECT_ROOT / "prompts" / _GOAL_FILES[route]
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        text = ""
    if text:
        return text
    return _FALLBACK_GOALS[route]


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


def _resolve_kb_embedding(
    cfg: Mapping[str, Any], kb_id: str
) -> Tuple[Optional[Mapping[str, Any]], str]:
    """per-KB 嵌入选型：读本库 kb.json 的 embedding {endpointId, model}，
    在全局端点表里解析出端点 map。未配置/悬空引用 -> (None, "")。"""
    try:
        settings = get_kb_settings(kb_id)
    except KeyError:
        return None, ""
    emb = settings.get("embedding") or {}
    ep_id = emb.get("endpointId")
    model = str(emb.get("model") or "").strip()
    if not ep_id or not model:
        return None, ""
    for ep in cfg.get("endpoints") or []:
        if str(ep.get("id")) == str(ep_id):
            if not str(ep.get("baseUrl") or "").strip():
                return None, ""
            return ep, model
    return None, ""


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
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> Dict[str, List[float]]:
    """ensureEmbeddings for one KB: load docs from kb.json, find those whose
    embeddingMeta is missing/mismatched, re-embed them, upsert vectors into
    Chroma, mark embeddingMeta {model, dim, upserted} in kb.json (no arrays
    written back). Returns doc_id -> vector for the just-computed subset.
    Caller thread must NOT hold DATA_FILE_LOCK while we await embed_texts —
    this fn is called outside the lock and only takes it for the writeback.
    `ep`/`model` are the KB's own per-KB embedding settings resolved upstream.
    按 EMBED_BATCH_SIZE 分批：每批成功即 upsert + 落盘，进度对外可见，
    后续批次失败也只丢那一批（本地端点整批超时曾导致一篇都没存下）。
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
    total = len(missing)
    batch = max(1, int(EMBED_BATCH_SIZE))
    for start in range(0, total, batch):
        chunk = missing[start : start + batch]
        texts = [_doc_text(d) for d in chunk]
        ids = [str(d["id"]) for d in chunk]
        resp = await embed_texts(ep, model, texts)
        if not resp or len(resp) != len(texts):
            raise ValueError("embedding 批量接口返回数量不匹配")
        dim = len(resp[0])
        for did, raw in zip(ids, resp):
            vectors[did] = [float(x) for x in raw]
        chroma_store.upsert(kb_id, ids, [vectors[did] for did in ids])
        async with DATA_FILE_LOCK:
            mark_embedding_meta(kb_id, ids, model, dim)
        if on_progress is not None:
            on_progress(len(vectors), total)
    return vectors


# --------------------------------------------------------------------------
# 「重新嵌入」后台任务：内存态进度表（进程重启即失效，届时由 sync_all_background 续算）
# --------------------------------------------------------------------------
_REEMBED_JOBS: Dict[str, Dict[str, Any]] = {}


def get_reembed_job(kb_id: str) -> Optional[Dict[str, Any]]:
    job = _REEMBED_JOBS.get(normalize_kb_id(kb_id))
    return dict(job) if job else None


def _describe_embed_error(err: Exception, done: int, total: int) -> str:
    detail = str(err).strip() or type(err).__name__
    if isinstance(err, httpx.TimeoutException):
        return (
            f"向量端点响应超时（单批 {EMBED_TIMEOUT:.0f}s），已嵌入 {done}/{total} 篇；"
            "可在库配置中重试继续剩余部分"
        )
    if isinstance(err, httpx.HTTPStatusError):
        return f"向量端点返回 HTTP {err.response.status_code}：{detail}"
    return f"向量化失败（已嵌入 {done}/{total} 篇）：{detail}"


def start_reembed_kb(kb_id: str) -> Dict[str, Any]:
    """「重新嵌入」入口：登记任务并后台强制重嵌本库全部文档（无视
    embeddingMeta 旧标记），立即返回 job 快照供前端轮询。
    不重切块——切块只作用于之后上传的新文件。库不存在抛 KeyError，
    未配置嵌入端点/模型抛 ValueError。
    """
    want = normalize_kb_id(kb_id)
    cfg = get_config()
    ep, model = _resolve_kb_embedding(cfg, want)
    if ep is None or not model:
        raise ValueError("该知识库未配置向量嵌入端点/模型，请先在库配置中完成设置")
    running = _REEMBED_JOBS.get(want)
    if running and running.get("status") == "running":
        return dict(running)
    docs = get_docs(want)
    job: Dict[str, Any] = {
        "kbId": want,
        "model": model,
        "status": "running",
        "total": len(docs),
        "done": 0,
        "error": None,
        "startedAt": now_iso(),
    }
    _REEMBED_JOBS[want] = job
    if not docs:
        job["status"] = "completed"
        job["finishedAt"] = now_iso()
        return dict(job)
    asyncio.create_task(_run_reembed(want, docs, ep, model, job))
    return dict(job)


async def _run_reembed(
    kb_id: str,
    docs: List[Mapping[str, Any]],
    ep: Mapping[str, Any],
    model: str,
    job: Dict[str, Any],
) -> None:
    def _progress(done: int, total: int) -> None:
        job["done"] = done
        job["total"] = total

    try:
        vectors = await compute_missing_vectors(
            kb_id, docs, ep, model, force=True, on_progress=_progress
        )
        job["done"] = len(vectors)
        job["status"] = "completed"
        print(f"[reembed] kb={kb_id} 完成：重嵌 {len(vectors)}/{len(docs)} 篇", flush=True)
    except Exception as e:
        job["status"] = "failed"
        job["error"] = _describe_embed_error(e, job["done"], job["total"])
        print(f"[reembed] kb={kb_id} 失败：{e}", flush=True)
    job["finishedAt"] = now_iso()


async def sync_all_background() -> None:
    """Startup backfill: walk all KBs, embed + upsert docs missing vectors
    (matched against each KB's OWN per-KB embedding model, so a KB whose
    model changed gets fully re-embedded at next start). Never raises."""
    cfg = get_config()
    try:
        from .store import get_kbs

        kbs = get_kbs()
    except Exception as e:
        print(f"[sync_all] 读取知识库失败：{e}")
        return
    for kb in kbs:
        kb_id = kb["kbId"]
        docs = kb["docs"]
        if not docs:
            continue
        ep, model = _resolve_kb_embedding(cfg, kb_id)
        if ep is None or not model:
            print(f"[sync_all] kb={kb_id} 未配置 per-KB 嵌入端点/模型，跳过向量补算")
            continue
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
        print(f"[sync_all] kb={kb_id} 缺向量 {len(missing)}/{len(docs)} 篇（本库模型 {model}），开始补算…")
        try:
            vectors = await compute_missing_vectors(kb_id, missing, ep, model)
            print(f"[sync_all] kb={kb_id} 已补算并 upsert {len(vectors)} 条向量")
        except Exception as e:
            print(f"[sync_all] kb={kb_id} 补算失败（不影响启动）：{e}")


# --------------------------------------------------------------------------
# vector retrieve via Chroma
# --------------------------------------------------------------------------
def _stale_docs(
    docs: List[Mapping[str, Any]], model: str
) -> List[Mapping[str, Any]]:
    return [
        d
        for d in docs
        if not (
            isinstance(d.get("embeddingMeta"), Mapping)
            and d["embeddingMeta"].get("model") == model
            and d["embeddingMeta"].get("upserted")
        )
    ]


async def ensure_embeddings(
    kb_id: str,
    docs: List[Mapping[str, Any]],
    ep: Mapping[str, Any],
    model: str,
) -> List[Mapping[str, Any]]:
    """补算缺失/过期向量并落盘（Chroma upsert + kb.json 标记），返回补算后的 docs。

    这是问答链里唯一会写盘的检索步骤，所以从取证里拆出来由调用方显式执行——
    spec §0.6-C7。返回值只在本次提问内生效：改造前 run_ask 的 docs 也不会被
    补算结果替换，保持原语义以免动到 BM25 与 titles。
    """
    stale = _stale_docs(docs, model)
    if not stale:
        return docs
    await compute_missing_vectors(kb_id, stale, ep, model)
    return get_docs(kb_id)


async def vector_probe(
    kb_id: str,
    cfg: Mapping[str, Any],
    docs: List[Mapping[str, Any]],
    question: str,
    top_n: int,
) -> Tuple[List[Dict[str, Any]], bool]:
    """纯读取证：问题向量化 + Chroma 检索。任何失败 -> ([], False)，不 Mock。

    返回 (scored, vectorAvailable)，只读不写。
    """
    try:
        ep, model = _resolve_kb_embedding(cfg, kb_id)
        if ep is None or not model:
            return [], False
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


async def vector_evidence(
    kb_id: str,
    cfg: Mapping[str, Any],
    docs: List[Mapping[str, Any]],
    question: str,
    top_n: int,
) -> Tuple[List[Dict[str, Any]], bool]:
    """补算（写盘）+ 取证（只读）的组合点，语义与拆分前的 `_vector_candidates` 一致：
    补算失败等同于向量不可用（([], False)），不阻断 BM25 那条腿。"""
    ep, model = _resolve_kb_embedding(cfg, kb_id)
    if ep is None or not model:
        return [], False
    try:
        probe_docs = await ensure_embeddings(kb_id, docs, ep, model)
    except Exception:
        return [], False
    return await vector_probe(kb_id, cfg, probe_docs, question, top_n)


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


def build_titles_block(reranked: List[Mapping[str, Any]], docs_by_id: Mapping[str, Mapping[str, Any]]) -> str:
    """澄清用：只给编号 + 标题，不给正文——够模型列出「你可能想问 A/B/C」，
    不够把正文抄成答案。"""
    lines: List[str] = []
    for i, r in enumerate(reranked):
        doc = docs_by_id.get(str(r["id"])) or {}
        lines.append(f"[{i + 1}] {str(doc.get('title') or '')}")
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
# generation helpers (shared by FAQ-RAG / CLARIFY / OOS paths)
# --------------------------------------------------------------------------
ContextMode = Literal["full", "titles", "none"]


async def _generate_stream(
    cfg: Mapping[str, Any],
    question: str,
    gen_ep: Mapping[str, Any],
    gen_model: str,
    session_id: str,
    *,
    contexts_docs: List[Mapping[str, Any]],
    docs_by_id: Mapping[str, Mapping[str, Any]],
    goal: str,
    cite: bool,
    context_mode: ContextMode = "full",
) -> AsyncGenerator[Dict[str, Any], None]:
    """Stream the generation stage. context_mode decides the whole assembly:

    - "full"  (FAQ-RAG)：system = agent 级全局提示词 (config.systemPrompt,
      else prompts/system_kb_default.md) + 本轮 goal；user = 编号资料全文 + 问题
    - "titles"(CLARIFY)：system = goal 本身（全局提示词里"必须依据编号资料作答
      并标注 [n]"会把澄清拽回答题，这里不拼）；user = 只给编号标题清单 + 问题
    - "none"  (OUT_OF_SCOPE)：system = goal；user 不附任何资料

    Yields delta/thinking events and finally one internal
    {"type": "done_answer", "answer"} frame (consumed by the caller, never
    sent to the client). Emits {"type": "error"} and stops on failure."""
    if context_mode == "none":
        sys_prompt = goal
        user_text = f"用户消息：{question}"
    elif context_mode == "titles":
        sys_prompt = goal
        titles_block = build_titles_block(contexts_docs, docs_by_id)
        user_text = f"知识库中相关的资料标题：\n{titles_block}\n\n用户消息：{question}"
    else:
        contexts_block = build_contexts_block(contexts_docs, docs_by_id)
        sys_prompt = f"{cfg.get('systemPrompt') or default_system_prompt()}\n\n本轮生成目标：{goal}"
        user_text = (
            RAG_USER_TEMPLATE.format(contexts=contexts_block, question=question)
            if cite
            else f"候选资料（仅供判断，不要直接回答）：\n{contexts_block}\n\n用户消息：{question}"
        )
    messages = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user_text},
    ]
    chunks: List[str] = []
    try:
        async for content, thinking in chat_stream(
            gen_ep, gen_model, messages, float(cfg.get("temperature") or 0.7),
            session_id=session_id,
        ):
            if content:
                chunks.append(content)
                yield {"type": "delta", "text": content}
            if thinking:
                yield {"type": "thinking", "text": thinking}
    except Exception as e:
        yield {"type": "error", "message": f"生成模型调用失败：{e}（请检查右上角「配置模型」与端点可达性）"}
        return
    yield {"type": "done_answer", "answer": "".join(chunks)}


async def _run_validation(
    cfg: Mapping[str, Any],
    answer: str,
    cited_docs: List[Mapping[str, Any]],
    docs_by_id: Mapping[str, Mapping[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Shared hallucination validation: validate-stage LLM first, rule
    fallback. Returns None when validation is disabled or no cited docs —
    callers skip the validate event in that case. Used by both the FAQ-RAG
    path and the CLARIFY branch (clarify output may still carry [n])."""
    if not cfg.get("enableValidation") or not cited_docs:
        return None
    citations = [int(m.group(1)) for m in CITATION_RE.finditer(answer or "")]
    citations = [n for n in citations if n > 0]
    contexts = [
        (
            str(docs_by_id.get(str(r["id"]), {}).get("title", "")),
            str(docs_by_id.get(str(r["id"]), {}).get("content", "")),
        )
        for r in cited_docs
    ]
    validation: Optional[Dict[str, Any]] = None
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
    return validation


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
        # ------- intent (binary: FAQ | OUT_OF_SCOPE; LLM -> rule fallback) ----
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

        gen_ep, gen_model = _resolve_stage(cfg, "generate")
        if gen_ep is None:
            yield {"type": "error", "message": GEN_NOT_CONFIGURED}
            return

        # ---------------- 超出范围：提示词驱动，先声明范围外再简短回应 --------
        if intent == "OUT_OF_SCOPE":
            yield {"type": "stage", "stage": "generate", "data": {"model": gen_model}, "kbId": kb_id}
            answer = ""
            async for ev in _generate_stream(
                cfg,
                question,
                gen_ep,
                gen_model,
                session_id,
                contexts_docs=[],
                docs_by_id={},
                goal=intent_goal(cfg, "OUT_OF_SCOPE"),
                cite=False,
                context_mode="none",
            ):
                if ev.get("type") == "done_answer":
                    answer = ev.get("answer") or ""
                    break
                yield ev
            if not answer.strip():
                # 生成失败（已发 error）或空流：不再退回固定话术，诚实到此为止
                return
            yield {"type": "done", "answer": answer.strip(), "sources": [], "kbId": kb_id}
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

        # ---------------- retrieve: vector-first gate -> BM25+RRF -----------
        candidate_k = _retrieve_top_k(cfg)
        vector_list, vector_available = await vector_evidence(
            kb_id, cfg, docs, question, candidate_k
        )
        top1_score = float(vector_list[0]["score"]) if vector_list else 0.0
        threshold = float(cfg.get("clarifyThreshold") or 0.72)
        # CLARIFY 闸门：向量 top-1 余弦低于阈值 → 澄清。此时 BM25 还没跑，
        # 判据只有向量分。向量服务整体不可用（vector_available=False）时不澄清，
        # 那是服务问题不是用户问题含糊，照走 BM25 单路检索。
        clarify = vector_available and top1_score < threshold
        docs_by_id = {str(d["id"]): d for d in docs}

        if clarify:
            detail["clarify"] = True
            detail["top1Score"] = _round4(top1_score)
            detail["threshold"] = _round4(threshold)
            yield {"type": "stage", "stage": "intent", "data": detail, "kbId": kb_id}
            # 澄清分支：跳过 BM25/rerank（不发这两阶段事件），也跳过校验——
            # 校验器要求 [n] 引用，会把"只追问不作答"判成失败
            yield {"type": "stage", "stage": "generate", "data": {"model": gen_model}, "kbId": kb_id}
            answer = ""
            async for ev in _generate_stream(
                cfg,
                question,
                gen_ep,
                gen_model,
                session_id,
                contexts_docs=vector_list,
                docs_by_id=docs_by_id,
                goal=intent_goal(cfg, "CLARIFY"),
                cite=False,
                context_mode="titles",
            ):
                if ev.get("type") == "done_answer":
                    answer = ev.get("answer") or ""
                    break
                yield ev
            if answer == "":
                # done_answer 缺席说明生成已 yield error 并终止，直接结束
                return
            cited_docs = vector_list
            sources = [
                {
                    "id": str(r["id"]),
                    "title": str(docs_by_id.get(str(r["id"]), {}).get("title", "")),
                    "content": str(docs_by_id.get(str(r["id"]), {}).get("content", "")),
                    "score": _round4(r["score"]),
                }
                for r in cited_docs
            ]
            yield {"type": "done", "answer": answer, "sources": sources, "kbId": kb_id}
            return

        bm25_list = bm25_search(question, docs, candidate_k)
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
                "top1Score": _round4(top1_score),
                "threshold": _round4(threshold),
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

        # ---------------- generate (FAQ-RAG: intent goal + citations) --------
        yield {"type": "stage", "stage": "generate", "data": {"model": gen_model}, "kbId": kb_id}
        answer = ""
        async for ev in _generate_stream(
            cfg,
            question,
            gen_ep,
            gen_model,
            session_id,
            contexts_docs=reranked,
            docs_by_id=docs_by_id,
            goal=intent_goal(cfg, "FAQ"),
            cite=True,
        ):
            if ev.get("type") == "done_answer":
                answer = ev.get("answer") or ""
                break
            yield ev
        if not answer:
            # 生成已 yield error 并终止（或空流）：done_answer 缺席，直接返回
            return

        # ---------------- validate (shared LLM + rule fallback) --------------
        validation = await _run_validation(cfg, answer, reranked, docs_by_id)
        if validation is not None:
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
