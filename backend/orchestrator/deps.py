"""问答链路的 IO 边界收拢成一个可注入容器（spec §0.6-C3，本轮 review 的"无测试缝隙"项）。

现状问题：`backend/pipeline.py` 在模块顶部直接 import 具体函数，测试只能 monkeypatch
模块属性；本层把这些调用点变成显式字段，生产实现与假实现同签名可互换。

**本层不改变任何行为**：`production()` 返回的就是 pipeline 现在调用的那批对象，
`tests/ask_contract/deps_check.py` 逐字段断言其身份一致；`check.py` 的对拍仍逐帧成立。

约定：所有方法都是异步或纯函数，不得在构造时做任何 IO；字段类型写成 Callable 而非
Protocol 实现类，是为了让假实现无需继承任何东西。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncGenerator, Awaitable, Callable, Dict, List, Mapping, Sequence

from .. import chroma_store
from ..models_client import chat_invoke, chat_stream, embed_texts, rerank
from ..search import bm25_search, classify_intent, heuristic_rerank, rrf_fuse
from ..store import (
    DATA_FILE_LOCK,
    default_system_prompt,
    get_config,
    get_docs,
    get_kb_settings,
    mark_embedding_meta,
    normalize_kb_id,
    replace_docs,
)

# 类型别名：把散落在 pipeline 里的调用签名钉在本处，改签名时只有一个地方要动。
EmbedFn = Callable[..., Awaitable[List[List[float]]]]
ChatInvokeFn = Callable[..., Awaitable[str]]
ChatStreamFn = Callable[..., AsyncGenerator[tuple, None]]
RerankFn = Callable[..., Awaitable[List[Dict[str, Any]]]]
ChromaQueryFn = Callable[[str, Sequence[float], int], List[Dict[str, Any]]]
ChromaUpsertFn = Callable[[str, Sequence[str], Sequence[Sequence[float]]], Any]
Bm25Fn = Callable[[str, Sequence[Mapping[str, Any]], int], List[Dict[str, Any]]]
RrfFn = Callable[..., List[Dict[str, Any]]]
HeuristicRerankFn = Callable[[str, Sequence[Mapping[str, Any]], Mapping[str, Mapping[str, Any]], int], List[Dict[str, Any]]]
IntentFn = Callable[[str], str]


@dataclass
class RagDeps:
    """run_ask 需要的全部外部能力。字段名即调用点，不做二次封装。"""

    # 配置与存储（store.py）
    get_config: Callable[[], Dict[str, Any]]
    get_docs: Callable[[str], List[Dict[str, Any]]]
    get_kb_settings: Callable[[str], Dict[str, Any]]
    normalize_kb_id: Callable[[str], str]
    default_system_prompt: Callable[[], str]
    mark_embedding_meta: Callable[..., None]
    replace_docs: Callable[..., None]
    data_file_lock: Any  # asyncio.Lock，补算向量落盘时持有

    # 模型能力（models_client.py）
    embed_texts: EmbedFn
    chat_invoke: ChatInvokeFn
    chat_stream: ChatStreamFn
    rerank: RerankFn

    # 向量库（chroma_store.py）
    chroma_query: ChromaQueryFn
    chroma_upsert: ChromaUpsertFn

    # 算法（search.py，纯函数，不需要注入但收在此处让"一条链的能力面"完整可见）
    bm25_search: Bm25Fn
    rrf_fuse: RrfFn
    classify_intent: IntentFn
    heuristic_rerank: HeuristicRerankFn

    @classmethod
    def production(cls) -> "RagDeps":
        return cls(
            get_config=get_config,
            get_docs=get_docs,
            get_kb_settings=get_kb_settings,
            normalize_kb_id=normalize_kb_id,
            default_system_prompt=default_system_prompt,
            mark_embedding_meta=mark_embedding_meta,
            replace_docs=replace_docs,
            data_file_lock=DATA_FILE_LOCK,
            embed_texts=embed_texts,
            chat_invoke=chat_invoke,
            chat_stream=chat_stream,
            rerank=rerank,
            chroma_query=chroma_store.query,
            chroma_upsert=chroma_store.upsert,
            bm25_search=bm25_search,
            rrf_fuse=rrf_fuse,
            classify_intent=classify_intent,
            heuristic_rerank=heuristic_rerank,
        )
