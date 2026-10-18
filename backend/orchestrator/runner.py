"""图 → SSE 帧的出口层（spec §0.6-C3 里"state→SSE 唯一翻译层"的那一半）。

异常语义对齐 `pipeline.run_ask` 的外层 try：图里任何节点抛错都翻成一条 error 帧
后正常收尾，不让流以裸异常结束。文案与改造前逐字一致。
"""

from __future__ import annotations

from typing import Any, AsyncGenerator, Dict, Optional

from .envelope import PIPELINE_RAG
from .rag_graph import build_graph

_app = None


def get_app():
    """编译一次并缓存。配置变更不需要重建：cfg 是每次提问作为状态传入的，
    图结构本身与配置无关。"""
    global _app
    if _app is None:
        _app = build_graph().compile()
    return _app


def reset_app() -> None:
    global _app
    _app = None


async def astream_frames(
    question: str,
    kb_id: str = "",
    session_id: str = "",
) -> AsyncGenerator[Dict[str, Any], None]:
    try:
        async for frame in get_app().astream(
            {"question": question, "kb_id": kb_id, "session_id": session_id},
            stream_mode="custom",
        ):
            yield frame
    except Exception as e:
        yield {
            "type": "error",
            "pipeline": PIPELINE_RAG,
            "message": f"请求处理异常：{e}（请检查端点配置或稍后重试）",
        }
