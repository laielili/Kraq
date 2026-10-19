"""跨管线编排公共层：事件信封 + 可注入依赖。

用途见 `plan/data-agent-v1-spec.md` §0.6-C2/C3。LangGraph 相关的 writer/runner
在图接入时再加，本包当前只有与框架无关的两件。
"""

from .deps import RagDeps
from .envelope import (
    DATA_STAGES,
    PIPELINE_DATA,
    PIPELINE_RAG,
    Frames,
)

__all__ = [
    "Frames",
    "RagDeps",
    "PIPELINE_RAG",
    "PIPELINE_DATA",
    "DATA_STAGES",
]
