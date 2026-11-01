"""切块策略层（plan/chunking-strategies-spec.md M-C1）。

四类策略全部走 `langchain-text-splitters`，自研 `chunker.py` 已删除。对外只有一个入口：

    split_document(text, chunking) -> [{"text": str, "length": int}, ...]

`chunking` 就是 kb.json 里那份 per-KB 配置：`{strategy, maxChars, overlap, params}`。
返回形状与旧 `chunk_text` 一致，调用点只换函数名。

两条不变量（spec C5，`tests/chunk_eval/invariants.py` 逐策略守住）：
1. 不丢非空白内容 —— 分块拼回后，去掉空白必须等于原文去空白；
2. 不产出纯空白块。
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Sequence

from langchain_text_splitters import (
    CharacterTextSplitter,
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
    RecursiveJsonSplitter,
)

STRATEGY_RECURSIVE = "recursive"
STRATEGY_CHARACTER = "character"
STRATEGY_MARKDOWN = "markdown_header"
STRATEGY_JSON = "json"

STRATEGIES: tuple[str, ...] = (STRATEGY_RECURSIVE, STRATEGY_CHARACTER, STRATEGY_MARKDOWN, STRATEGY_JSON)
DEFAULT_STRATEGY = STRATEGY_RECURSIVE

# 中文正文没有空格分词，库默认阶梯（\n\n、\n、空格、""）会直接退化成定长硬切；
# zh 预设把句末标点插进阶梯，是四种策略里唯一能改善中文切块质量的一档。
SEPARATOR_PRESETS: Dict[str, List[str]] = {
    "default": ["\n\n", "\n", " ", ""],
    "zh": ["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""],
    "code": ["\n\n", "\nclass ", "\ndef ", "\n\n", "\n", " ", ""],
}

DEFAULT_HEADERS: tuple[str, ...] = ("#", "##", "###")

# 每个策略认识的专属参数键。store 归一化按它过滤，脏键不会写进 kb.json，
# 前端也就能确定"选中某策略后该渲染哪些控件"。
STRATEGY_PARAMS: Dict[str, tuple[str, ...]] = {
    STRATEGY_RECURSIVE: ("preset",),
    STRATEGY_CHARACTER: ("separator",),
    STRATEGY_MARKDOWN: ("headers", "stripHeaders"),
    STRATEGY_JSON: ("convertLists",),
}


def strategy_params(strategy: str | None) -> tuple[str, ...]:
    return STRATEGY_PARAMS.get(str(strategy or DEFAULT_STRATEGY), ())


# 前端控件的单一事实源：策略标签 + 每个策略认识的参数怎么渲染。
# 加策略只改这里，前端不用动。
UI_SCHEMA: List[Dict[str, Any]] = [
    {
        "id": STRATEGY_RECURSIVE,
        "label": "分隔符递归",
        "hint": "按分隔符阶梯逐级下切，通用默认",
        "fields": [
            {
                "key": "preset",
                "label": "分隔符阶梯",
                "type": "select",
                "default": "zh",
                "options": [
                    {"value": "zh", "label": "中文（句末标点）"},
                    {"value": "default", "label": "通用（空行/换行/空格）"},
                    {"value": "code", "label": "代码（class/def 优先）"},
                ],
            }
        ],
    },
    {
        "id": STRATEGY_CHARACTER,
        "label": "单分隔符",
        "hint": "只按一个分隔符切；分隔符缺失时自动退化为定长切",
        "fields": [
            {
                "key": "separator",
                "label": "分隔符",
                "type": "text",
                "default": "\\n\\n",
                "placeholder": "支持 \\n \\t 转义，如 \\n\\n",
            }
        ],
    },
    {
        "id": STRATEGY_MARKDOWN,
        "label": "Markdown 标题",
        "hint": "先按标题层级切，超长节再递归收拢",
        "fields": [
            {
                "key": "headers",
                "label": "切分标题层级",
                "type": "multiselect",
                "default": list(DEFAULT_HEADERS),
                "options": [
                    {"value": "#", "label": "#"},
                    {"value": "##", "label": "##"},
                    {"value": "###", "label": "###"},
                    {"value": "####", "label": "####"},
                ],
            },
            {
                "key": "stripHeaders",
                "label": "从正文剥离标题（默认保留）",
                "type": "bool",
                "default": False,
            },
        ],
    },
    {
        "id": STRATEGY_JSON,
        "label": "JSON 结构",
        "hint": "按 JSON 路径切；顶层须为对象。块长按结构尺寸计",
        "fields": [
            {
                "key": "convertLists",
                "label": "数组拆成独立块",
                "type": "bool",
                "default": True,
            }
        ],
    },
]


def default_params(strategy: str) -> Dict[str, Any]:
    """按 schema 取默认参数，供 store/前端共用。"""
    for item in UI_SCHEMA:
        if item["id"] == strategy:
            return {f["key"]: f["default"] for f in item["fields"]}
    return {}


def _pack(chunks: Sequence[str]) -> List[Dict[str, Any]]:
    return [{"text": c, "length": len(c)} for c in chunks if c and c.strip()]


def _int(cfg: Mapping[str, Any], key: str, default: int) -> int:
    try:
        return max(int(cfg.get(key) or default), 1)
    except (TypeError, ValueError):
        return default


def _collapse(texts: Sequence[str], max_chars: int, overlap: int) -> List[str]:
    """二级收拢：标题切分不切超长块，长段落必须再过一次递归切分。"""
    need = [t for t in texts if len(t) > max_chars]
    if not need:
        return list(texts)
    out: List[str] = []
    inner = RecursiveCharacterTextSplitter(
        chunk_size=max_chars, chunk_overlap=overlap, keep_separator=True
    )
    for t in texts:
        if len(t) > max_chars:
            out.extend(inner.split_text(t))
        else:
            out.append(t)
    return out


def _split_recursive(text: str, max_chars: int, overlap: int, params: Mapping[str, Any]) -> List[str]:
    preset = str(params.get("preset") or "zh")
    separators = SEPARATOR_PRESETS.get(preset) or SEPARATOR_PRESETS["zh"]
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=max_chars, chunk_overlap=overlap, separators=separators, keep_separator=True
    )
    return splitter.split_text(text)


def _unescape(value: str) -> str:
    """文本框里打不出真换行，约定支持 \n / \t 两种转义。"""
    return str(value).replace("\\n", "\n").replace("\\t", "\t")


def _split_character(text: str, max_chars: int, overlap: int, params: Mapping[str, Any]) -> List[str]:
    splitter = CharacterTextSplitter(
        separator=_unescape(str(params.get("separator") or "\n\n")),
        chunk_size=max_chars,
        chunk_overlap=overlap,
        keep_separator=True,
    )
    # CharacterTextSplitter 只在"分隔符存在"时切；分隔符缺失会整篇返回一块，
    # 直接撑爆嵌入模型的上下文。这里补一道与 recursive 同源的收拢兜底。
    return _collapse(splitter.split_text(text), max_chars, overlap)


def _split_markdown(text: str, max_chars: int, overlap: int, params: Mapping[str, Any]) -> List[str]:
    headers = [h for h in (params.get("headers") or list(DEFAULT_HEADERS)) if isinstance(h, str)]
    strip = bool(params.get("stripHeaders", False))
    splitter = MarkdownHeaderTextSplitter(
        headers_to_split_on=[(h, h) for h in headers] or [(h, h) for h in DEFAULT_HEADERS],
        strip_headers=strip,
    )
    sections: List[str] = []
    for doc in splitter.split_text(text):
        body = str(doc.page_content).strip()
        if strip:
            # 标题被切分器剥掉了，这里按层级拼回块首：块一旦丢掉"属于哪一节"，
            # 检索命中后前端无法溯源，引用也就没意义了。
            meta = doc.metadata or {}
            head = "\n".join(f"{h} {meta[h]}" for h in headers if meta.get(h))
            body = f"{head}\n\n{body}".strip() if head else body
        if body:
            sections.append(body)
    return _collapse(sections, max_chars, overlap)


def _split_json(text: str, max_chars: int, overlap: int, params: Mapping[str, Any]) -> List[str]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"JSON 切块策略要求合法 JSON 文本：{e}") from e
    if not isinstance(data, dict):
        raise ValueError("JSON 切块策略只接受对象顶层；行数组请用其他策略入库")
    splitter = RecursiveJsonSplitter(max_chunk_size=max(200, max_chars))
    # split_text 返回的已经是 JSON 字符串（默认 ensure_ascii=True 会把中文转成 \uXXXX，
    # 切块一旦落盘就检索不到中文了），这里显式要 ensure_ascii=False 且不再二次 dumps。
    # convert_lists=False 会把整个数组留在一个块里（实测 40 个元素 → 2086 字不切），
    # 默认打开才能让数组元素各自成块。
    return splitter.split_text(
        json_data=data,
        convert_lists=bool(params.get("convertLists", True)),
        ensure_ascii=False,
    )


_SPLITTERS = {
    STRATEGY_RECURSIVE: _split_recursive,
    STRATEGY_CHARACTER: _split_character,
    STRATEGY_MARKDOWN: _split_markdown,
    STRATEGY_JSON: _split_json,
}


def split_document(text: str, chunking: Mapping[str, Any] | None = None) -> List[Dict[str, Any]]:
    """按 per-KB 配置切块。未知策略回落到默认策略，不抛错——入库不能因为一个脏字段失败。"""
    cfg = chunking or {}
    strategy = str(cfg.get("strategy") or DEFAULT_STRATEGY)
    fn = _SPLITTERS.get(strategy) or _SPLITTERS[DEFAULT_STRATEGY]
    max_chars = _int(cfg, "maxChars", 600)
    overlap = _int(cfg, "overlap", 50)
    if overlap >= max_chars:
        overlap = max_chars - 1
    params = cfg.get("params") if isinstance(cfg.get("params"), Mapping) else {}
    return _pack(fn(str(text or ""), max_chars, max(overlap, 0), params or {}))


def chunking_fingerprint(cfg: Mapping[str, Any] | None) -> str:
    """切块口径指纹（spec C6）：策略或参数一变，旧向量即视为失效。"""
    import hashlib

    cfg = cfg or {}
    canonical = json.dumps(
        {
            "strategy": str(cfg.get("strategy") or DEFAULT_STRATEGY),
            "maxChars": _int(cfg, "maxChars", 600),
            "overlap": _int(cfg, "overlap", 50),
            "params": dict(cfg.get("params") or {}) if isinstance(cfg.get("params"), Mapping) else {},
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
