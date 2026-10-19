"""跨管线统一事件信封（spec §0.6-C2）。

三种帧形状，全部由 `tests/ask_contract/baseline.json` 钉住：

  stage    {"type":"stage","pipeline":p,"stage":name,"data":{...},"kbId":str}
  delta    {"type":"delta","pipeline":p,"text":str}                      ← 无 kbId
  thinking {"type":"thinking","pipeline":p,"text":str}                   ← 无 kbId
  done     {"type":"done","pipeline":p,"answer":str,"sources":[...],"kbId":str}
  error    {"type":"error","pipeline":p,"message":str}                   ← 无 kbId

`pipeline` 是本轮唯一新增字段；其余键名与键序语义保持与 RAG 现有实现逐字一致，
所以同一批对拍夹具能直接验证"加了信封之后 payload 没漂"。
`kbId` 只在调用方传入时才出现——超出范围/生成失败的 error 帧历史上就不带它。
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Tuple

PIPELINE_RAG = "rag"
PIPELINE_DATA = "data"

#: 各管线的阶段名。前端先按 pipeline 分派、再按 stage 渲染。
DATA_STAGES: Tuple[str, ...] = (
    "scope",
    "parse",
    "needs_column",
    "compile",
    "execute",
    "present",
    "narrate",
    "validate",
)



class Frames:
    """绑定一条管线（及其作用域标识）的帧工厂。

    rag 用 kb_id 作 scope；data 管线的数据集列表放在 data 里，不占这个位置，
    所以构造时不传 kb_id 即可。
    """

    __slots__ = ("pipeline", "kb_id")

    def __init__(self, pipeline: str, kb_id: Optional[str] = None) -> None:
        self.pipeline = pipeline
        self.kb_id = kb_id

    def _base(self) -> Dict[str, Any]:
        frame: Dict[str, Any] = {"pipeline": self.pipeline}
        if self.kb_id is not None:
            frame["kbId"] = self.kb_id
        return frame

    def stage(self, stage: str, data: Mapping[str, Any]) -> Dict[str, Any]:
        frame = self._base()
        frame.update({"type": "stage", "stage": stage, "data": dict(data)})
        return frame

    def delta(self, text: str) -> Dict[str, Any]:
        frame = self._base()
        frame.pop("kbId", None)
        frame.update({"type": "delta", "text": text})
        return frame

    def thinking(self, text: str) -> Dict[str, Any]:
        frame = self._base()
        frame.pop("kbId", None)
        frame.update({"type": "thinking", "text": text})
        return frame

    def done(self, answer: str, sources: List[Mapping[str, Any]]) -> Dict[str, Any]:
        frame = self._base()
        frame.update({"type": "done", "answer": answer, "sources": [dict(s) for s in sources]})
        return frame

    def error(self, message: str) -> Dict[str, Any]:
        frame = self._base()
        frame.pop("kbId", None)
        frame.update({"type": "error", "message": message})
        return frame
