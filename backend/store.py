"""Storage layer: data/config.json (endpoint book + stage refs + knobs),
data/kb.json (multi-KB index; each kb = {kbId, name, docs} with docs holding
title/content/createdAt/embeddingMeta — vectors live in Chroma only),
protected by one shared asyncio.Lock.

kb.json legacy format ({docs:[...]}) auto-migrates to a single
kbId="default" kb named "默认知识库" on read. All writes go tmp-file +
os.replace atomic-write.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .common import (
    CONFIG_FILE,
    KB_DEFAULT_CHUNKING,
    DEFAULT_CONFIG,
    DEFAULT_ENDPOINT,
    DEFAULT_STAGES,
    KB_FILE,
    PROJECT_ROOT,
    STAGE_KEYS,
    atomic_write_json,
    now_iso,
    read_json_file,
)
from .seed_docs import SEED_DOCS

DEFAULT_KB_ID = "default"
DEFAULT_KB_NAME = "默认知识库"

# One asyncio.Lock protects BOTH config.json and kb.json (per brief).
DATA_FILE_LOCK = asyncio.Lock()

KB_LOCK = DATA_FILE_LOCK  # synonym used by earlier scaffolds

HTTP_PROTOCOLS = ("http://", "https://")


def _clamp_counter_value(cfg: dict) -> dict:
    """Clamp numeric knobs into sane ranges (temperature 0-1, topK 1-10, weights 0-1)."""
    def clamp(v, lo, hi, default):
        try:
            v = float(v)
        except (TypeError, ValueError):
            return default
        return max(lo, min(hi, v))

    cfg["temperature"] = clamp(cfg.get("temperature"), 0.0, 1.0, 0.7)
    cfg["topK"] = int(clamp(cfg.get("topK"), 1, 10, 5))
    cfg["retrieveTopK"] = int(clamp(cfg.get("retrieveTopK"), 2, 20, 10))
    cfg["rerankTopN"] = int(clamp(cfg.get("rerankTopN"), 1, 10, 5))
    # 不变式：重排后保留数不得超过候选池大小
    if cfg["rerankTopN"] > cfg["retrieveTopK"]:
        cfg["rerankTopN"] = cfg["retrieveTopK"]
    cfg["bm25Weight"] = clamp(cfg.get("bm25Weight"), 0.0, 1.0, 0.4)
    cfg["vectorWeight"] = clamp(cfg.get("vectorWeight"), 0.0, 1.0, 0.6)
    cfg["clarifyThreshold"] = clamp(cfg.get("clarifyThreshold"), 0.0, 1.0, 0.72)
    if not isinstance(cfg.get("enableValidation"), bool):
        cfg["enableValidation"] = True
    # embedding/chunking 已下沉到 per-KB（kb.json）；config 中的残留键在下次写回时剥离
    cfg.pop("chunking", None)
    return cfg


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def _norm_base_url(url: str) -> str:
    return url.strip().rstrip("/")


def _normalize_endpoint(ep: Mapping[str, object]) -> Optional[dict]:
    if not isinstance(ep, Mapping):
        return None
    protocol = ep.get("protocol")
    base_url = ep.get("baseUrl")
    if not isinstance(base_url, str) or not base_url.strip():
        return None
    protocol = str(protocol or "").strip()
    if protocol not in ("ollama", "openai", "llamacpp"):
        protocol = "ollama"
    return {
        "id": str(ep.get("id") or f"ep-{uuid.uuid4().hex[:8]}"),
        "name": str(ep.get("name") or ""),
        "protocol": protocol,
        "baseUrl": _norm_base_url(base_url),
        "apiKey": ep.get("apiKey") if isinstance(ep.get("apiKey"), str) else "",
    }


def _deep_merge_endpoint_lists(
    existing: List[Mapping[str, object]] | None,
    provided: List[Mapping[str, object]] | None,
) -> Tuple[List[dict], bool]:
    """Merge: provided endpoints replace old ones by id, keeping apiKey for
    entries whose patch apiKey is null/missing; apiKey key present-but-"" clears."""
    merged: List[dict] = [dict(e) for e in (existing or [])]
    merged_by_id = {str(e["id"]): e for e in merged}

    result: List[dict] = []
    result_ids: set[str] = set()
    changed = False
    for ep in provided or []:
        if not isinstance(ep, Mapping):
            continue
        normalized = _normalize_endpoint(ep)
        if normalized is None:
            continue
        ep_id = normalized["id"]
        if ep_id in merged_by_id:
            old = merged_by_id[ep_id]
            # apiKey == "" in the patch clears; null/missing keeps old value
            if "apiKey" in ep and ep["apiKey"] is not None:
                pass  # use the patch's apiKey ("", or a new value)
            else:
                normalized["apiKey"] = old.get("apiKey", "")
        result.append(normalized)
        result_ids.add(ep_id)
        if normalized not in [dict(x) for x in (existing or [])]:
            changed = True

    # Endpoints absent from the patch list are preserved (shallow-merge intent:
    # "endpoints if provided replaces wholesale" vs merge-by-id — see brief:
    # "endpoints/ stages/ chunking 若提供则整体替换"; we keep ids not mentioned
    # only when the patch's first entry lacks an id, otherwise full replace).
    if provided is not None:
        first_has_id = bool(provided) and isinstance(provided[0], Mapping) and provided[0].get("id")
        if not first_has_id:
            for ep in merged:
                if str(ep.get("id")) not in result_ids:
                    result.append(dict(ep))
                    changed = True
    return result, changed


def _normalize_stages(existing: Mapping[str, object] | None, provided: Mapping[str, object] | None) -> dict:
    stages: dict = {}
    base = {name: dict(DEFAULT_STAGES[name]) for name in STAGE_KEYS}
    if isinstance(existing, Mapping):
        for name in STAGE_KEYS:
            if isinstance(existing.get(name), Mapping):
                base[name] = {
                    "endpointId": existing[name].get("endpointId"),
                    "model": existing[name].get("model", ""),
                }
    if isinstance(provided, Mapping):
        for name in STAGE_KEYS:
            if isinstance(provided.get(name), Mapping):
                stage = provided[name]
                entry = dict(base[name])
                if "endpointId" in stage:
                    entry["endpointId"] = stage["endpointId"] or None
                if "model" in stage:
                    entry["model"] = str(stage["model"] or "")
                base[name] = entry
    return base


def _load_config_raw() -> dict:
    raw = read_json_file(CONFIG_FILE)
    if isinstance(raw, dict):
        return dict(raw)
    return {}


def _migrate_config(raw: Mapping[str, object]) -> dict:
    """Old format {model, temperature, topK, ...} → new format; merges old keys."""
    cfg: dict = {
        "endpoints": [dict(DEFAULT_CONFIG["endpoints"][0])],
        "stages": {name: dict(DEFAULT_STAGES[name]) for name in STAGE_KEYS},
        "temperature": DEFAULT_CONFIG["temperature"],
        "topK": DEFAULT_CONFIG["topK"],
        "retrieveTopK": DEFAULT_CONFIG["retrieveTopK"],
        "rerankTopN": DEFAULT_CONFIG["rerankTopN"],
        "bm25Weight": DEFAULT_CONFIG["bm25Weight"],
        "vectorWeight": DEFAULT_CONFIG["vectorWeight"],
        "clarifyThreshold": DEFAULT_CONFIG["clarifyThreshold"],
        "enableValidation": DEFAULT_CONFIG["enableValidation"],
    }
    if isinstance(raw.get("endpoints"), list):
        eps, _ = _deep_merge_endpoint_lists(None, raw["endpoints"])
        cfg["endpoints"] = eps
    if isinstance(raw.get("stages"), Mapping):
        # 旧 stages 里可能残留 embedding 项：跳过（按 STAGE_KEYS 白名单取）
        cfg["stages"] = _normalize_stages(None, raw["stages"])
    for key in (
        "temperature",
        "topK",
        "retrieveTopK",
        "rerankTopN",
        "bm25Weight",
        "vectorWeight",
        "clarifyThreshold",
        "enableValidation",
    ):
        if key in raw and raw[key] is not None:
            cfg[key] = raw[key]
    # Preserve any legacy keys (e.g. "model") — brief says: 旧字段并入
    for key, value in raw.items():
        if key not in cfg:
            cfg[key] = value
    return cfg


def load_config() -> dict:
    """Load + migrate + clamp. File missing → default new-format config."""
    try:
        raw = _load_config_raw()
    except Exception:
        raw = {}
    if not raw:
        cfg = dict(DEFAULT_CONFIG)
        cfg["stages"] = {name: dict(DEFAULT_STAGES[name]) for name in STAGE_KEYS}
        return _clamp_counter_value(cfg)
    return _clamp_counter_value(_migrate_config(raw))


def save_config(cfg: Mapping[str, object]) -> dict:
    out = dict(cfg)
    atomic_write_json(CONFIG_FILE, out)
    return out


def get_config() -> dict:
    """Full config for pipeline use (apiKey included)."""
    return load_config()


def public_config() -> dict:
    """GET /api/config shape: apiKey never leaves the server in plaintext."""
    cfg = load_config()
    out = dict(cfg)
    endpoints = []
    for ep in cfg.get("endpoints") or []:
        ep_out = dict(ep)
        ep_out["hasKey"] = bool(str(ep.get("apiKey") or "").strip())
        ep_out.pop("apiKey", None)
        endpoints.append(ep_out)
    out["endpoints"] = endpoints
    return out


def update_config(patch: Mapping[str, object]) -> dict:
    """PUT /api/config: shallow merge; lists/maps wholesale-replace; apiKey rules.

    Plaintext API keys arriving from the config dialog are persisted to the
    gitignored .env (envstore) and replaced with `env:VAR` references before
    config.json is written — the plaintext never lands in config.json.
    """
    from . import envstore

    current = load_config()
    next_cfg = dict(current)

    for key in (
        "temperature",
        "topK",
        "retrieveTopK",
        "rerankTopN",
        "bm25Weight",
        "vectorWeight",
        "clarifyThreshold",
        "enableValidation",
    ):
        if key in patch and patch[key] is not None:
            next_cfg[key] = patch[key]

    endpoints_changed = False
    if isinstance(patch.get("endpoints"), list):
        merged, endpoints_changed = _deep_merge_endpoint_lists(
            current.get("endpoints"), patch["endpoints"]
        )
        next_cfg["endpoints"] = [dict(e) for e in merged]
    if isinstance(patch.get("stages"), Mapping):
        next_cfg["stages"] = _normalize_stages(current.get("stages"), patch["stages"])
    elif "stages" not in patch and isinstance(current.get("stages"), Mapping):
        next_cfg["stages"] = {
            name: dict(value) for name, value in current["stages"].items()
        }
    # embedding/chunking 不再是全局字段：显式上传即忽略（chunking 由 _clamp 剥离，
    # stages 的 embedding 项由 _normalize_stages 的 STAGE_KEYS 白名单丢弃）

    # Plaintext -> .env + env: reference. A key present-but-"" clears the
    # reference (endpoint without auth); null/missing kept the old reference
    # in _deep_merge_endpoint_lists, so only genuinely new plaintext lands here.
    for ep in next_cfg.get("endpoints") or []:
        raw = str(ep.get("apiKey") or "")
        if raw and not raw.startswith("env:"):
            ep["apiKey"] = envstore.store_secret(raw)

    # Protocol / baseUrl validation — invalid entries are rejected (400-ish handled upstream)
    for ep in next_cfg.get("endpoints") or []:
        if ep.get("protocol") not in ("ollama", "openai", "llamacpp"):
            raise ValueError(f"protocol 仅支持 ollama、openai 或 llamacpp（{ep.get('protocol')!r}）")
        base = str(ep.get("baseUrl", ""))
        if not (base.startswith("http://") or base.startswith("https://")):
            raise ValueError(f"baseUrl 必须以 http:// 或 https:// 开头（{ep.get('name') or ep.get('id')!r}）")

    _clamp_counter_value(next_cfg)

    # Secrets GC: drop .env vars no endpoint references anymore (after write so
    # a validation failure never destroys still-referenced values).
    referenced = {
        str(ep.get("apiKey")).strip()
        for ep in next_cfg.get("endpoints") or []
        if str(ep.get("apiKey") or "").startswith("env:")
    }
    envstore.gc_secrets(referenced)

    atomic_write_json(CONFIG_FILE, next_cfg)
    return next_cfg


# ---------------------------------------------------------------------------
# Knowledge base registry (multi-KB)
# ---------------------------------------------------------------------------
_KB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# 逐知识库系统提示词的长度上限（编辑框约 10 页文本，超出裁剪）
_SYSTEM_PROMPT_MAX_CHARS = 4000

# prompts/system_kb_default.md：全局默认提示词样本（重置目标、未定制库的生效值）
_DEFAULT_PROMPT_FILE = PROJECT_ROOT / "prompts" / "system_kb_default.md"
_DEFAULT_PROMPT_FALLBACK = (
    "你是知识库问答助手，必须只依据给出的编号资料回答问题，"
    "在答案中用 [n] 标注所引用资料的编号（如 [1]、[2]）。"
    "如果资料不足以回答问题，就直接明确说明资料不足，不要编造内容。"
)


def _norm_system_prompt(value: object) -> Optional[str]:
    """Custom prompt stored per KB; empty -> None (follows global default)."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:_SYSTEM_PROMPT_MAX_CHARS] or None


# ---------------------------------------------------------------------------
# per-KB embedding + chunking（向量嵌入模型与切块参数下沉到知识库维度）
# ---------------------------------------------------------------------------
def _norm_kb_chunking(value: object) -> dict:
    """chunking {maxChars, overlap}; 重叠 >= 块长时钳制到 maxChars-50（与旧全局规则一致）。"""
    raw = value if isinstance(value, Mapping) else {}
    try:
        max_chars = int(raw.get("maxChars") or KB_DEFAULT_CHUNKING["maxChars"])
    except (TypeError, ValueError):
        max_chars = int(KB_DEFAULT_CHUNKING["maxChars"])
    try:
        overlap = int(raw.get("overlap") or KB_DEFAULT_CHUNKING["overlap"])
    except (TypeError, ValueError):
        overlap = int(KB_DEFAULT_CHUNKING["overlap"])
    max_chars = max(200, min(2000, max_chars))
    overlap = max(0, min(200, overlap))
    if overlap >= max_chars:
        overlap = max(0, max_chars - 50)
    return {"maxChars": max_chars, "overlap": overlap}


def _norm_kb_embedding(value: object) -> dict:
    """嵌入模型选型 {endpointId, model}；model 为空 = 未配置（该库不可向量化）。"""
    raw = value if isinstance(value, Mapping) else {}
    return {
        "endpointId": str(raw.get("endpointId") or "") or None,
        "model": str(raw.get("model") or "").strip(),
    }


def get_kb_settings(kb_id: str) -> dict:
    """本库生效的 per-KB 配置：{embedding, chunking}。库不存在抛 KeyError。"""
    kb = get_kb(kb_id)
    if kb is None:
        raise KeyError(f"知识库不存在：{kb_id}")
    return {
        "embedding": kb.get("embedding") or {"endpointId": None, "model": ""},
        "chunking": kb.get("chunking") or dict(KB_DEFAULT_CHUNKING),
    }


def default_system_prompt() -> str:
    """Read prompts/system_kb_default.md at call time; fallback if missing."""
    try:
        text = _DEFAULT_PROMPT_FILE.read_text(encoding="utf-8").strip()
        if text:
            return text
    except OSError:
        pass
    return _DEFAULT_PROMPT_FALLBACK


def migrate_kb_prompts_to_config() -> None:
    """One-time migration: per-KB systemPrompt (kb.json metadata) -> global
    config.json systemPrompt (Agent-level). Lifts the default KB's custom
    prompt (else the first custom found) into config, then strips every
    systemPrompt key from kb.json. Idempotent: a stripped kb.json makes the
    next run a no-op. Caller must hold DATA_FILE_LOCK."""
    try:
        parsed = read_json_file(KB_FILE)
    except Exception:
        parsed = None
    raw_kbs: List[Mapping[str, object]] = []
    if isinstance(parsed, Mapping) and isinstance(parsed.get("kbs"), list):
        raw_kbs = [kb for kb in parsed["kbs"] if isinstance(kb, Mapping)]
    elif isinstance(parsed, Mapping) and isinstance(parsed.get("docs"), list):
        raw_kbs = [{"kbId": DEFAULT_KB_ID, "docs": parsed["docs"]}]

    cfg = load_config()
    lifted = False
    if not cfg.get("systemPrompt"):
        candidates = {
            normalize_kb_id(kb.get("kbId")): _norm_system_prompt(kb.get("systemPrompt"))
            for kb in raw_kbs
        }
        pick = candidates.get(DEFAULT_KB_ID) or next(
            (v for v in candidates.values() if v), None
        )
        if pick:
            cfg["systemPrompt"] = pick
            atomic_write_json(CONFIG_FILE, cfg)
            lifted = True

    stripped = False
    for kb in raw_kbs:
        if "systemPrompt" in kb:
            kb.pop("systemPrompt", None)
            stripped = True
    if stripped:
        # entries go through the same shape load_or_seed_kbs writes back
        kbs_out = [
            {
                "kbId": normalize_kb_id(kb.get("kbId")),
                "name": str(kb.get("name") or ""),
                "docs": [d for d in (kb.get("docs") or []) if isinstance(d, Mapping)],
            }
            for kb in raw_kbs
        ]
        atomic_write_json(KB_FILE, {"kbs": kbs_out})
    if lifted or stripped:
        print("[migrate] per-KB systemPrompt -> config.json (agent-level)", flush=True)


def migrate_plaintext_keys() -> None:
    """One-time startup migration: plaintext keys already stored in config.json
    (legacy) move into the .env store as env: references. Idempotent."""
    from . import envstore

    cfg = load_config()
    changed = False
    for ep in cfg.get("endpoints") or []:
        raw = str(ep.get("apiKey") or "")
        if raw and not raw.startswith("env:"):
            ep["apiKey"] = envstore.store_secret(raw)
            changed = True
    if changed:
        atomic_write_json(CONFIG_FILE, cfg)
        print("[migrate] plaintext endpoint keys -> .env (env: references)", flush=True)


def get_agent_system_prompt() -> dict:
    """GET /api/agent/prompt payload: custom value + global default."""
    cfg = load_config()
    return {"prompt": _norm_system_prompt(cfg.get("systemPrompt")), "defaultPrompt": default_system_prompt()}


def set_agent_system_prompt(prompt: object) -> dict:
    """PUT /api/agent/prompt. Empty/blank string resets to default (None).
    The prompt is Agent-level: shared by every knowledge base."""
    cfg = load_config()
    cfg["systemPrompt"] = _norm_system_prompt(prompt)
    atomic_write_json(CONFIG_FILE, cfg)
    return get_agent_system_prompt()


def normalize_kb_id(kb_id: object) -> str:
    """Arbitrary client kbId -> safe namespace id; invalid/missing -> default."""
    raw = str(kb_id or "").strip()
    if raw and _KB_ID_RE.match(raw):
        return raw
    return DEFAULT_KB_ID


def _doc_record(
    doc_id: str,
    title: str,
    content: str,
    embedding_meta: Optional[dict],
    created_at: str,
) -> dict:
    """Docs never carry an embedding array (vectors live in Chroma)."""
    return {
        "id": doc_id,
        "title": title,
        "content": content,
        "embeddingMeta": embedding_meta,
        "createdAt": created_at,
    }


def new_doc_id() -> str:
    return str(uuid.uuid4())


def _kb_entry(kb_id: str, name: str, docs: list, embedding: object = None, chunking: object = None) -> dict:
    """Standard kb entry shape with per-KB embedding/chunking fields."""
    return {
        "kbId": kb_id,
        "name": name,
        "docs": docs,
        "embedding": _norm_kb_embedding(embedding),
        "chunking": _norm_kb_chunking(chunking),
    }


def _legacy_global_settings() -> Tuple[dict, dict]:
    """Snapshot of the legacy global embedding/chunking from config.json (read
    only, no normalization side effects) — used to seed pre-migration kb entries."""
    try:
        raw = _load_config_raw()
    except Exception:
        raw = {}
    stages = raw.get("stages") if isinstance(raw.get("stages"), Mapping) else {}
    emb_raw = stages.get("embedding") if isinstance(stages, Mapping) else None
    embedding = {"endpointId": None, "model": ""}
    if isinstance(emb_raw, Mapping):
        embedding = {
            "endpointId": str(emb_raw.get("endpointId") or "") or None,
            "model": str(emb_raw.get("model") or "").strip(),
        }
    chunking = raw.get("chunking")
    return embedding, _norm_kb_chunking(chunking)


def load_or_seed_kbs() -> List[dict]:
    """Read kb.json into [{kbId, name, docs, embedding, chunking}].
    Legacy {docs:[...]} → default KB. A kb entry missing embedding/chunking
    (pre-migration file) is seeded from the legacy config snapshot:
    old global stages.embedding + chunking."""
    try:
        parsed = read_json_file(KB_FILE)
    except Exception:
        parsed = None
    kbs: List[dict] = []
    if isinstance(parsed, Mapping) and isinstance(parsed.get("docs"), list):
        # old single-KB format
        kbs = [{"kbId": DEFAULT_KB_ID, "name": DEFAULT_KB_NAME, "docs": list(parsed["docs"])}]
    elif isinstance(parsed, Mapping) and isinstance(parsed.get("kbs"), list):
        for kb in parsed["kbs"]:
            if not isinstance(kb, Mapping):
                continue
            kbs.append(
                {
                    "kbId": normalize_kb_id(kb.get("kbId")),
                    "name": str(kb.get("name") or ""),
                    "docs": [d for d in (kb.get("docs") or []) if isinstance(d, Mapping)],
                    "embedding": kb.get("embedding"),
                    "chunking": kb.get("chunking"),
                }
            )
    if not kbs:
        created = now_iso()
        docs = [
            _doc_record(f"seed-{i + 1:02d}", d["title"], d["content"], None, created)
            for i, d in enumerate(SEED_DOCS)
        ]
        kbs = [{
            "kbId": DEFAULT_KB_ID,
            "name": DEFAULT_KB_NAME,
            "docs": docs,
        }]
        atomic_write_json(KB_FILE, {"kbs": kbs})
    # fallback for pre-migration entries: snapshot of the legacy global config
    fallback_embedding, fallback_chunking = _legacy_global_settings()
    # sanitize each doc + dedupe/normalize kbIds
    seen: Dict[str, dict] = {}
    out: List[dict] = []
    for kb in kbs:
        kb_id = normalize_kb_id(kb["kbId"])
        if kb_id in seen:
            seen[kb_id]["docs"].extend(kb["docs"])
            continue
        docs = []
        for d in kb["docs"]:
            if not all(isinstance(d.get(k), str) for k in ("id", "title", "content")):
                continue
            meta = d.get("embeddingMeta")
            docs.append(
                {
                    "id": d["id"],
                    "title": d["title"],
                    "content": d["content"],
                    "embeddingMeta": meta if isinstance(meta, Mapping) else None,
                    "createdAt": str(d.get("createdAt") or now_iso()),
                }
            )
        embedding_raw = kb.get("embedding") if kb.get("embedding") is not None else fallback_embedding
        chunking_raw = kb.get("chunking") if kb.get("chunking") is not None else fallback_chunking
        entry = {
            "kbId": kb_id,
            "name": str(kb.get("name") or kb_id),
            "docs": docs,
            "embedding": _norm_kb_embedding(embedding_raw),
            "chunking": _norm_kb_chunking(chunking_raw),
        }
        seen[kb_id] = entry
        out.append(entry)
    if not out:
        out = [_kb_entry(DEFAULT_KB_ID, DEFAULT_KB_NAME, [], fallback_embedding, fallback_chunking)]
    return out


def write_kbs(kbs: List[dict]) -> None:
    atomic_write_json(KB_FILE, {"kbs": kbs})


def get_kbs() -> List[dict]:
    return load_or_seed_kbs()


def get_kb(kb_id: str) -> Optional[dict]:
    want = normalize_kb_id(kb_id)
    for kb in load_or_seed_kbs():
        if kb["kbId"] == want:
            return kb
    return None


def get_docs(kb_id: str = DEFAULT_KB_ID) -> List[dict]:
    kb = get_kb(kb_id)
    if kb is None:
        raise KeyError(f"知识库不存在：{kb_id}")
    return list(kb["docs"])


def create_kb(name: str, embedding: object = None, chunking: object = None) -> dict:
    """POST /api/kbs. Caller must hold DATA_FILE_LOCK. embedding/chunking are
    REQUIRED per-KB settings (main.py validates before calling)."""
    kbs = load_or_seed_kbs()
    name = str(name or "").strip() or DEFAULT_KB_NAME
    # kbId: ascii slug derived from name, unique suffix; UI-facing name is the
    # human string. Unique kbId matters because Chroma collection maps 1:1.
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", name.encode("ascii", "ignore").decode("ascii")).strip("-_") or "kb"
    while True:
        candidate = normalize_kb_id(f"{slug[:24]}-{uuid.uuid4().hex[:6]}")
        if candidate not in {kb["kbId"] for kb in kbs}:
            break
    entry = {
        "kbId": candidate,
        "name": name,
        "docs": [],
        "embedding": _norm_kb_embedding(embedding),
        "chunking": _norm_kb_chunking(chunking),
    }
    kbs.append(entry)
    atomic_write_json(KB_FILE, {"kbs": kbs})
    return entry


def rename_kb(kb_id: str, name: str) -> Optional[dict]:
    """PUT /api/kbs/{old_kbId}. Id is immutable; collection untouched."""
    kbs = load_or_seed_kbs()
    want = normalize_kb_id(kb_id)
    for kb in kbs:
        if kb["kbId"] == want:
            kb["name"] = str(name or "").strip() or kb["name"]
            atomic_write_json(KB_FILE, {"kbs": kbs})
            return kb
    return None


def update_kb_settings(kb_id: str, patch: Mapping[str, object]) -> Optional[dict]:
    """PUT /api/kbs/{kbId} extension: partial update of per-KB embedding/chunking.
    Only the provided keys change; unknown keys are ignored. Caller must hold
    DATA_FILE_LOCK. Returns the updated entry or None when the kb is missing."""
    kbs = load_or_seed_kbs()
    want = normalize_kb_id(kb_id)
    for kb in kbs:
        if kb["kbId"] == want:
            if isinstance(patch.get("embedding"), Mapping):
                kb["embedding"] = _norm_kb_embedding(patch["embedding"])
            if isinstance(patch.get("chunking"), Mapping):
                kb["chunking"] = _norm_kb_chunking(patch["chunking"])
            if isinstance(patch.get("name"), str) and str(patch["name"]).strip():
                kb["name"] = str(patch["name"]).strip()
            atomic_write_json(KB_FILE, {"kbs": kbs})
            return kb
    return None


def delete_kb(kb_id: str) -> bool:
    """DELETE /api/kbs?kbId=. Caller must hold DATA_FILE_LOCK. Also drops the
    Chroma collection for this kb (caller handles that alongside)."""
    kbs = load_or_seed_kbs()
    want = normalize_kb_id(kb_id)
    kept = [kb for kb in kbs if kb["kbId"] != want]
    if len(kept) == len(kbs):
        return False
    # default KB cannot be deleted (fallback target); rename or empty only
    if want == DEFAULT_KB_ID and len(kbs) == 1:
        return False
    atomic_write_json(KB_FILE, {"kbs": kept})
    return True


def add_doc(kb_id: str, title: str, content: str) -> dict:
    """Caller must hold DATA_FILE_LOCK (or be in a single-user context)."""
    kbs = load_or_seed_kbs()
    want = normalize_kb_id(kb_id)
    target = next((kb for kb in kbs if kb["kbId"] == want), None)
    if target is None:
        target = {"kbId": want, "name": want, "docs": []}
        kbs.append(target)
    doc = _doc_record(new_doc_id(), title, content, None, now_iso())
    target["docs"].append(doc)
    atomic_write_json(KB_FILE, {"kbs": kbs})
    return doc


def delete_doc(kb_id: str, doc_id: str) -> bool:
    kbs = load_or_seed_kbs()
    want = normalize_kb_id(kb_id)
    target = next((kb for kb in kbs if kb["kbId"] == want), None)
    if target is None:
        return False
    kept = [d for d in target["docs"] if d["id"] != doc_id]
    if len(kept) == len(target["docs"]):
        return False
    target["docs"] = kept
    atomic_write_json(KB_FILE, {"kbs": kbs})
    return True


def add_docs_batch(kb_id: str, new_docs: List[dict]) -> List[dict]:
    kbs = load_or_seed_kbs()
    want = normalize_kb_id(kb_id)
    target = next((kb for kb in kbs if kb["kbId"] == want), None)
    if target is None:
        target = {"kbId": want, "name": want, "docs": []}
        kbs.append(target)
    target["docs"].extend(new_docs)
    atomic_write_json(KB_FILE, {"kbs": kbs})
    return new_docs


def replace_docs(kb_id: str, docs: List[dict]) -> None:
    """Whole-docs-array writeback for embeddingMeta marking (caller passes
    the kb's own doc list). Also removes any stale 'embedding' array keys."""
    kbs = load_or_seed_kbs()
    want = normalize_kb_id(kb_id)
    target = next((kb for kb in kbs if kb["kbId"] == want), None)
    if target is None:
        target = {"kbId": want, "name": want, "docs": []}
        kbs.append(target)
    target["docs"] = [d for d in docs if isinstance(d, Mapping) and isinstance(d.get("id"), str)]
    atomic_write_json(KB_FILE, {"kbs": kbs})


def save_docs(kb_id: str, docs: List[dict]) -> None:
    """Alias kept for pipeline use."""
    replace_docs(kb_id, docs)


def mark_embedding_meta(kb_id: str, doc_ids: List[str], model: str, dim: int) -> None:
    """Write back embeddingMeta = {model, dim, upserted: true} for the given
    docs of one kb (no vector data)."""
    kbs = load_or_seed_kbs()
    want = normalize_kb_id(kb_id)
    wanted = set(str(i) for i in doc_ids)
    for kb in kbs:
        if kb["kbId"] != want:
            continue
        for d in kb["docs"]:
            if d["id"] in wanted:
                d.pop("embedding", None)
                d["embeddingMeta"] = {"model": model, "dim": int(dim), "upserted": True}
    atomic_write_json(KB_FILE, {"kbs": kbs})
