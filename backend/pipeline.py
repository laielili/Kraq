"""RAG 问答链：阶段实现与链路语义。

**编排不在本模块**：`/api/ask` 走 `backend/orchestrator/rag_graph.py`（LangGraph 节点
+ 条件边）→ `runner.astream_frames` → SSE 帧。本模块只提供被节点调用的阶段函数
（意图取证、向量补算与取证、生成流、校验）和共享常量。

下面的链路语义同时就是那张图的语义，也是 `tests/ask_contract/baseline.json` 的判据来源。
每帧都带 `pipeline` 字段（`orchestrator/envelope.py`）；`kbId` 只出现在 stage 与 done 帧。

正常链路：intent -> retrieve -> rerank -> generate -> (delta* / thinking*) -> validate -> done。
四条早退分支各自不同，不是同一序的截断：
- 档案库为空：intent -> retrieve(空候选) -> done
- 融合无候选：intent -> retrieve -> done
- 澄清：intent -> intent(追加 clarify/top1Score/threshold) -> generate -> delta* -> done
  （不发 retrieve/rerank，也不校验）
- 超出范围：intent -> generate -> delta* -> done
任何阶段失败发 error 帧并终止，**error 之后不再有 done**。
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
    Sequence,
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
from .raw_store import read_raw
from .splitters import chunking_fingerprint, split_document
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
    new_doc_id,
    normalize_kb_id,
    replace_docs,
)

INTENT_SYSTEM = (
    "你是知识库问答系统的意图分类器。FAQ=用户想向知识库提问或查找资料，"
    "期望得到基于知识的回答或结果（问题含义模糊也算 FAQ，后续会通过澄清确认）；"
    "OUT_OF_SCOPE=与知识库问答无关的消息（如闲聊、天气、新闻、写代码）；"
    "CONTINUATION=本轮输入是在补充或回答上一轮助手提出的澄清追问"
    "（例如上一轮助手问「你想了解 A 还是 B」，本轮答「A」「第二个」「是关于 B 的」），"
    "而不是提出一个新的知识问题。没有上一轮助手的澄清追问时，不要判为 CONTINUATION。"
    "只输出 FAQ、OUT_OF_SCOPE 或 CONTINUATION 之一。"
)
INTENT_PARSE_RE = re.compile(r"(FAQ|OUT_OF_SCOPE|CONTINUATION)")
VALID_INTENTS = ("FAQ", "OUT_OF_SCOPE", "CONTINUATION")

REQUERY_SYSTEM = (
    "你是知识库问答系统的检索查询重写器。用户本轮是在补充或回答上一轮助手提出的澄清追问。"
    "请结合下面的会话历史，把用户真正想检索的信息写成一段独立、具体、适合知识库检索的中文查询。"
    "只输出查询本身，不要解释、不要加引号、不要输出标签。"
)

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


def _format_history(history: Optional[Sequence[Mapping[str, str]]]) -> str:
    """会话历史 → 意图提示里的纯文本块（只保留 user/assistant 非空内容）。"""
    lines: List[str] = []
    for m in history or ():
        role = str(m.get("role") or "")
        content = str(m.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        lines.append(f"{'用户' if role == 'user' else '助手'}：{content}")
    return "\n".join(lines)


async def _intent_llm_invoke(
    cfg: Mapping[str, Any],
    question: str,
    session_id: str = "",
    *,
    history: Optional[Sequence[Mapping[str, str]]] = None,
) -> Optional[str]:
    """意图阶段配置的端点模型做一次分类，返回合法标签或 None（未配置/失败）。

    CONTINUATION 必须依赖会话历史判断，所以这里把历史与当前输入一起送出；
    没有历史时不可能判为该标签。
    """
    ep_i, model_i = _resolve_stage(cfg, "intent")
    if ep_i is None or not model_i:
        return None
    history_text = _format_history(history)
    user_text = f"本轮用户输入：{question}\n请只输出意图标签。"
    if history_text:
        user_text = (
            "以下是同一会话的历史对话（按时间顺序）：\n"
            f"{history_text}\n\n本轮用户输入：{question}\n"
            "请判断本轮输入是新的知识问题（FAQ）、无关消息（OUT_OF_SCOPE），"
            "还是对上一轮助手澄清追问的补充（CONTINUATION）。只输出标签。"
        )
    try:
        text = await chat_invoke(
            ep_i,
            model_i,
            [
                {"role": "system", "content": INTENT_SYSTEM},
                {"role": "user", "content": user_text},
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

async def _requery_for_retrieval(
    cfg: Mapping[str, Any],
    question: str,
    session_id: str = "",
    *,
    history: Optional[Sequence[Mapping[str, str]]] = None,
) -> Tuple[str, bool]:
    """CONTINUATION 专用：用意图模型把“上一轮澄清 + 本轮补充”重写成独立检索查询。

    返回值 (query, fallback)：模型未配置/失败/输出为空时回落为
    “上一轮用户问题 + 本轮补充”，只影响检索/重排，不影响生成。
    """
    fallback = question
    for m in reversed(history or ()):
        if str(m.get("role") or "") == "user":
            prev = str(m.get("content") or "").strip()
            if prev and prev != question:
                fallback = f"{prev}\n{question}"
            break
    ep_i, model_i = _resolve_stage(cfg, "intent")
    if ep_i is None or not model_i:
        return fallback, True
    history_text = _format_history(history)
    user_text = (
        f"会话历史：\n{history_text}\n\n本轮用户补充：{question}\n\n"
        "请输出用于知识库检索的独立查询："
        if history_text
        else f"本轮用户输入：{question}\n\n请输出用于知识库检索的独立查询："
    )
    try:
        text = await chat_invoke(
            ep_i,
            model_i,
            [
                {"role": "system", "content": REQUERY_SYSTEM},
                {"role": "user", "content": user_text},
            ],
            0.0,
            256,
            think=False,
            session_id=session_id,
        )
    except Exception:
        return fallback, True
    query = (text or "").strip()
    for prefix in ("检索查询：", "独立查询：", "查询：", "Query:", "query:"):
        if query.startswith(prefix):
            query = query[len(prefix):].strip()
    query = query.strip("`'\"“”‘’ \n\t")
    query = query.splitlines()[0].strip() if query else ""
    if not query:
        return fallback, True
    return query[:500], False


RAG_USER_TEMPLATE = "编号资料：\n{contexts}\n\n用户问题：{question}\n\n请基于以上资料回答，并标注引用编号。"

NO_DOCS_ANSWER = "知识库暂无文档，请先在左侧「档案柜」中添加资料后再提问。"
GEN_NOT_CONFIGURED = "尚未配置生成模型，请点击右上角「检索与生成参数 → 配置模型」完成配置。"
NO_RELEVANT_ANSWER = "知识库中暂未检索到与该问题相关的资料，无法作答。"
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
            mark_embedding_meta(kb_id, ids, model, dim, chunk_fp=chunking_fingerprint_of(kb_id))
        if on_progress is not None:
            on_progress(len(vectors), total)
    return vectors


# --------------------------------------------------------------------------
# 「重新嵌入」后台任务：内存态进度表（进程重启即失效，届时由 sync_all_background 续算）
# --------------------------------------------------------------------------
_REEMBED_JOBS: Dict[str, Dict[str, Any]] = {}
_EMBED_JOBS: Dict[str, Dict[str, Any]] = {}


def get_reembed_job(kb_id: str) -> Optional[Dict[str, Any]]:
    job = _REEMBED_JOBS.get(normalize_kb_id(kb_id))
    return dict(job) if job else None


def get_embed_job(kb_id: str) -> Optional[Dict[str, Any]]:
    job = _EMBED_JOBS.get(normalize_kb_id(kb_id))
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
    """「重新嵌入」入口：清空本库向量集合，按**当前** chunking 策略与嵌入模型
    从留存的 Markdown 原文重走一遍切块 + 嵌入，立即返回 job 快照供前端轮询。

    改造前入库、没有留存原文的文档不会被重切（只重嵌），数量在 job.keptNoRaw 里如实报出。
    库不存在抛 KeyError，未配置嵌入端点/模型抛 ValueError。
    """
    want = normalize_kb_id(kb_id)
    cfg = get_config()
    ep, model = _resolve_kb_embedding(cfg, want)
    if ep is None or not model:
        raise ValueError("该知识库未配置向量嵌入端点/模型，请先在库配置中完成设置")
    running = _REEMBED_JOBS.get(want)
    if running and running.get("status") == "running":
        return dict(running)
    embedding = _EMBED_JOBS.get(want)
    if embedding and embedding.get("status") == "running":
        raise ValueError("该库正在嵌入，请稍后再试")
    docs = get_docs(want)
    job: Dict[str, Any] = {
        "kbId": want,
        "model": model,
        "status": "running",
        "total": len(docs),
        "done": 0,
        "rechunked": 0,
        "keptNoRaw": 0,
        "cleared": False,
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


def _pending_docs(docs: List[Mapping[str, Any]], model: str) -> List[Mapping[str, Any]]:
    """与 compute_missing_vectors 的 stale 判据保持一致：模型不符或未 upsert。"""
    out: List[Mapping[str, Any]] = []
    for d in docs:
        meta = d.get("embeddingMeta")
        ok = (
            isinstance(meta, Mapping)
            and bool(meta.get("upserted"))
            and str(meta.get("model") or "") == model
        )
        if not ok:
            out.append(d)
    return out


def start_embed_pending_kb(kb_id: str) -> Dict[str, Any]:
    """把本库所有待向量化的文档补算一遍（不重切、不清集合）。

    上传/手动录入后调用，让「首次上传」不再依赖下次提问或重启时的懒补算。
    """
    want = normalize_kb_id(kb_id)
    cfg = get_config()
    ep, model = _resolve_kb_embedding(cfg, want)
    if ep is None or not model:
        raise ValueError("该知识库未配置向量嵌入端点/模型，请先在库配置中完成设置")
    reembed = _REEMBED_JOBS.get(want)
    if reembed and reembed.get("status") == "running":
        raise ValueError("该库正在重新嵌入，请稍后再试")
    running = _EMBED_JOBS.get(want)
    if running and running.get("status") == "running":
        return dict(running)
    pending = _pending_docs(get_docs(want), model)
    job: Dict[str, Any] = {
        "kbId": want,
        "model": model,
        "status": "running",
        "total": len(pending),
        "done": 0,
        "error": None,
        "startedAt": now_iso(),
    }
    _EMBED_JOBS[want] = job
    if not pending:
        job["status"] = "completed"
        job["finishedAt"] = now_iso()
        return dict(job)
    asyncio.create_task(_run_embed_pending(want, ep, model, job))
    return dict(job)


async def _run_embed_pending(
    kb_id: str,
    ep: Mapping[str, Any],
    model: str,
    job: Dict[str, Any],
) -> None:
    def _progress(done: int, total: int) -> None:
        job["done"] = done
        job["total"] = total

    try:
        vectors = await compute_missing_vectors(
            kb_id, get_docs(kb_id), ep, model, on_progress=_progress
        )
        job["done"] = len(vectors)
        job["status"] = "completed"
    except Exception as e:
        job["status"] = "failed"
        job["error"] = _describe_embed_error(e, job["done"], job["total"])
    job["finishedAt"] = now_iso()


_CHUNK_TITLE_RE = re.compile(r"\s*·\s*第\d+块$")


async def _rechunk_from_raw(kb_id: str, docs: List[Mapping[str, Any]], job: Dict[str, Any]) -> List[Dict[str, Any]]:
    """按当前 chunking 策略，从留存的 Markdown 原文重切本库文档。

    没有原文的来源（本次改造之前入库的旧数据）原样保留并在任务里计数——
    宁可不切，也不要静默地把用户的库切空。
    """
    chunking = get_kb_settings(kb_id).get("chunking") or {}
    groups: Dict[str, List[Mapping[str, Any]]] = {}
    out: List[Dict[str, Any]] = []
    for d in docs:
        sid = str(d.get("sourceId") or "")
        if sid:
            groups.setdefault(sid, []).append(d)
        else:
            out.append(dict(d))

    rechunked = kept = 0
    for sid, group in groups.items():
        raw = read_raw(kb_id, sid)
        pieces = split_document(raw, chunking) if raw is not None else []
        if not pieces:
            out.extend(dict(d) for d in group)
            kept += 1
            continue
        first = group[0]
        title = str(first.get("title") or "")
        base = _CHUNK_TITLE_RE.sub("", title)
        meta = {
            k: v
            for k, v in (first.get("embeddingMeta") or {}).items()
            if k not in ("model", "dim", "upserted", "chunkFp")
        }
        rebuilt: List[Dict[str, Any]] = []
        for i, piece in enumerate(pieces):
            rebuilt.append({
                "id": group[i]["id"] if i < len(group) else new_doc_id(),
                "sourceId": sid,
                "title": f"{base} · 第{i + 1}块" if base else f"片段 {i + 1}",
                "content": str(piece["text"]),
                "embeddingMeta": {**meta, "upserted": False},
                "createdAt": first.get("createdAt") or now_iso(),
            })
        out.extend(rebuilt)
        rechunked += 1

    job["rechunked"] = rechunked
    job["keptNoRaw"] = kept
    if rechunked:
        async with DATA_FILE_LOCK:
            replace_docs(kb_id, out)
    return out


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
        # 1) 按当前策略重切（有原文才重切）
        docs = await _rechunk_from_raw(kb_id, docs, job)
        # 2) 清空本库向量集合，再全量重嵌：避免旧块 id 残留成孤儿向量
        chroma_store.drop_collection(kb_id)
        job["cleared"] = True
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
def chunking_fingerprint_of(kb_id: str) -> str | None:
    """本库当前切块口径的指纹；读不到配置时返回 None（不阻断补算）。"""
    try:
        return chunking_fingerprint(get_kb_settings(kb_id).get("chunking"))
    except Exception:
        return None


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
    history: Optional[Sequence[Mapping[str, str]]] = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    """Stream the generation stage. context_mode decides the whole assembly:

    - "full"  (FAQ-RAG)：system = agent 级全局提示词 (config.systemPrompt,
      else prompts/system_kb_default.md) + 本轮 goal；user = 编号资料全文 + 问题
    - "titles"(CLARIFY)：system = goal 本身（全局提示词里"必须依据编号资料作答
      并标注 [n]"会把澄清拽回答题，这里不拼）；user = 只给编号标题清单 + 问题
    - "none"  (OUT_OF_SCOPE)：system = goal；user 不附任何资料

    `history` 只在 CONTINUATION 路径传入：按
    [system] + 历史 user/assistant + 本轮 user（含编号资料）组装，
    让模型能接住上一轮澄清里的指代。

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
    history_msgs = [
        {"role": str(m.get("role")), "content": str(m.get("content"))}
        for m in (history or ())
        if str(m.get("role")) in ("user", "assistant")
        and str(m.get("content") or "").strip()
    ]
    if history_msgs and context_mode == "full":
        sys_prompt += (
            "\n\n补充说明：本轮是用户对上一轮澄清的补充。请结合历史对话理解用户所指，"
            "但最终回答仍必须基于本轮编号资料并标注 [n]。"
        )
    messages = [{"role": "system", "content": sys_prompt}]
    messages.extend(history_msgs)
    messages.append({"role": "user", "content": user_text})
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
