#!/usr/bin/env python3
"""Kraq backend — routes assembled on the implemented modules.

Run via ../main.py (mounts this app under /api) or standalone:
    python -m backend.main
"""

import asyncio
import os
from pathlib import Path
from typing import Mapping

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from . import chroma_store
from .chunker import chunk_text
from .models_client import list_models
from .pipeline import force_reembed_kb, run_ask, sync_all_background
from .store import (
    DATA_FILE_LOCK,
    DEFAULT_KB_ID,
    add_doc,
    add_docs_batch,
    create_kb,
    delete_doc,
    delete_kb,
    get_agent_system_prompt,
    get_config,
    get_docs,
    get_kb,
    get_kbs,
    get_kb_settings,
    migrate_kb_prompts_to_config,
    migrate_plaintext_keys,
    new_doc_id,
    normalize_kb_id,
    public_config,
    rename_kb,
    set_agent_system_prompt,
    update_config,
    update_kb_settings,
)
from .common import now_iso

app = FastAPI(title="Kraq Backend", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_UPLOAD_CHARS = 2_000_000

_sync_task: asyncio.Task | None = None


def _err(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def _resolve_kb(kb_id: str | None) -> str:
    """kbId 缺省或不存在 → 回落 default 库，不报 500。"""
    want = normalize_kb_id(kb_id)
    if any(kb["kbId"] == want for kb in get_kbs()):
        return want
    return DEFAULT_KB_ID


@app.on_event("startup")
async def _startup_sync() -> None:
    """首次启动/换版本后自检：迁移旧逐库提示词 + 后台补算缺失向量（不阻塞启动）。"""
    global _sync_task
    async with DATA_FILE_LOCK:
        migrate_kb_prompts_to_config()
        migrate_plaintext_keys()
    _sync_task = asyncio.create_task(sync_all_background())


@app.get("/api/health")
async def health():
    try:
        async with DATA_FILE_LOCK:
            kbs = get_kbs()
        return JSONResponse({"ok": True, "docs": sum(len(kb["docs"]) for kb in kbs), "kbs": len(kbs)})
    except Exception as e:
        return _err(500, f"服务健康检查失败：{e}")


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------
@app.get("/api/config")
async def config_get():
    try:
        async with DATA_FILE_LOCK:
            return JSONResponse(public_config())
    except Exception as e:
        return _err(500, f"读取配置失败：{e}")


@app.put("/api/config")
async def config_put(request: Request):
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    try:
        async with DATA_FILE_LOCK:
            updated = update_config(body)
    except ValueError as e:
        return _err(400, str(e))
    except Exception as e:
        return _err(500, f"保存配置失败：{e}")
    # return the public shape (apiKey stripped, hasKey added)
    return JSONResponse(public_config())


# ---------------------------------------------------------------------------
# models (per-endpoint listing for the dialog's datalists + test button)
# ---------------------------------------------------------------------------
@app.get("/api/models")
async def models_get():
    from .store import get_config as _gc

    try:
        async with DATA_FILE_LOCK:
            cfg = _gc()
        endpoints = cfg.get("endpoints") or []
        results = []

        async def probe(ep):
            try:
                models = await list_models(ep)
                results.append(
                    {
                        "endpointId": ep.get("id"),
                        "endpoint": ep.get("name") or ep.get("id"),
                        "protocol": ep.get("protocol"),
                        "models": models,
                    }
                )
            except Exception as e:
                results.append(
                    {
                        "endpointId": ep.get("id"),
                        "endpoint": ep.get("name") or ep.get("id"),
                        "protocol": ep.get("protocol"),
                        "error": f"端点 {ep.get('name') or ep.get('id')} 不可达：{e}",
                    }
                )

        await asyncio.gather(*(probe(ep) for ep in endpoints if isinstance(ep, dict)))
        return JSONResponse(results)
    except Exception as e:
        return _err(500, f"获取模型列表失败：{e}")


# ---------------------------------------------------------------------------
# kbs (multi-KB registry; 每 kb 自带 per-KB 嵌入选型 + 切块参数)
# ---------------------------------------------------------------------------
def _kb_summary(kb: dict) -> dict:
    return {
        "kbId": kb["kbId"],
        "name": kb["name"],
        "docCount": len(kb["docs"]),
        "description": kb.get("description") or "",
    }


def _validate_kb_embed_patch(cfg: Mapping[str, object], embedding: Mapping[str, object],
                             chunking: Mapping[str, object]) -> str | None:
    """per-KB 嵌入/切块校验，返回错误文案或 None。"""
    ep_id = str(embedding.get("endpointId") or "")
    model = str(embedding.get("model") or "").strip()
    if not ep_id:
        return "必须选择向量嵌入端点"
    if not model:
        return "必须填写向量嵌入模型名"
    if not any(str(ep.get("id")).strip() == ep_id for ep in (cfg.get("endpoints") or []) if isinstance(ep, Mapping)):
        return "向量嵌入端点不存在，请先在「配置模型」中添加服务端点"
    try:
        max_chars = int(chunking.get("maxChars"))  # type: ignore[union-attr]
        overlap = int(chunking.get("overlap"))  # type: ignore[union-attr]
    except (TypeError, ValueError):
        return "切块参数必须是整数"
    if not (200 <= max_chars <= 2000):
        return "块最大字符须在 200–2000 之间"
    if not (0 <= overlap <= 200):
        return "相邻重叠须在 0–200 之间"
    if overlap >= max_chars:
        return "相邻重叠必须小于块最大字符"
    return None


@app.get("/api/kbs")
async def kbs_list():
    try:
        async with DATA_FILE_LOCK:
            kbs = get_kbs()
        return JSONResponse([_kb_summary(kb) for kb in kbs])
    except Exception as e:
        return _err(500, f"读取知识库列表失败：{e}")


@app.post("/api/kbs")
async def kbs_create(request: Request):
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    name = str(body.get("name") or "").strip()
    if not name:
        return _err(400, "知识库名称不能为空")
    embedding = body.get("embedding") if isinstance(body.get("embedding"), Mapping) else {}
    chunking = body.get("chunking") if isinstance(body.get("chunking"), Mapping) else {}
    try:
        async with DATA_FILE_LOCK:
            cfg = get_config()
            err = _validate_kb_embed_patch(cfg, embedding, chunking)
            if err:
                return _err(400, err)
            kb = create_kb(name, embedding, chunking)
        return JSONResponse({"kbId": kb["kbId"], "name": kb["name"], "docCount": len(kb["docs"])})
    except Exception as e:
        return _err(500, f"新建知识库失败：{e}")


@app.get("/api/kbs/{kb_id}/settings")
async def kb_settings_get(kb_id: str):
    try:
        async with DATA_FILE_LOCK:
            settings = get_kb_settings(kb_id)
        return JSONResponse(settings)
    except KeyError as e:
        return _err(404, str(e))
    except Exception as e:
        return _err(500, f"读取知识库配置失败：{e}")


@app.put("/api/kbs/{kb_id}/settings")
async def kb_settings_put(kb_id: str, request: Request):
    """per-KB 嵌入端点/模型、切块参数的局部更新（改名走 PUT /api/kbs/{kb_id}）。"""
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    if not isinstance(body, Mapping) or (
        "embedding" not in body
        and "chunking" not in body
        and "description" not in body
    ):
        return _err(400, "至少提供 embedding、chunking 或 description 之一")
    embedding = body.get("embedding") if isinstance(body.get("embedding"), Mapping) else {}
    chunking = body.get("chunking") if isinstance(body.get("chunking"), Mapping) else {}
    try:
        async with DATA_FILE_LOCK:
            kb = get_kb(kb_id)
            if kb is None:
                return _err(404, f"知识库不存在：{kb_id}")
            cfg = get_config()
            # 部分更新：缺失一侧沿用库内现值（另一侧不需要重填）
            current = {
                "embedding": kb.get("embedding") or {},
                "chunking": kb.get("chunking") or {},
            }
            merged_embedding = {**current["embedding"], **embedding}
            merged_chunking = {**current["chunking"], **chunking}
            err = _validate_kb_embed_patch(cfg, merged_embedding, merged_chunking)
            if err:
                return _err(400, err)
            # 只传 body 里出现的键，避免缺失一侧时把另一侧重置为空
            settings_patch: dict = {}
            if "embedding" in body:
                settings_patch["embedding"] = embedding
            if "chunking" in body:
                settings_patch["chunking"] = chunking
            if "description" in body:
                settings_patch["description"] = body.get("description")
            updated = update_kb_settings(kb_id, settings_patch)
        return JSONResponse({
            "kbId": updated["kbId"],
            "name": updated["name"],
            "embedding": updated["embedding"],
            "chunking": updated["chunking"],
            "description": updated.get("description") or "",
        })
    except Exception as e:
        return _err(500, f"保存知识库配置失败：{e}")


@app.post("/api/kbs/{kb_id}/reembed")
async def kb_reembed(kb_id: str):
    """「重新嵌入」：强制对本库全部文档重算向量并 upsert。后台执行，立即返回。"""
    want = normalize_kb_id(kb_id)
    if not any(kb["kbId"] == want for kb in get_kbs()):
        return _err(404, f"知识库不存在：{kb_id}")

    async def _run() -> None:
        try:
            report = await force_reembed_kb(want)
            print(f"[reembed] kb={want} 完成：{report}", flush=True)
        except Exception as e:
            print(f"[reembed] kb={want} 失败：{e}", flush=True)

    asyncio.create_task(_run())
    return JSONResponse({"ok": True, "accepted": True, "kbId": want})


@app.get("/api/agent/prompt")
async def agent_prompt_get():
    """知识问答 Agent 的全局系统提示词（不再下辖于知识库）。"""
    try:
        return JSONResponse(get_agent_system_prompt())
    except Exception as e:
        return _err(500, f"读取提示词失败：{e}")


@app.put("/api/agent/prompt")
async def agent_prompt_put(request: Request):
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    if not isinstance(body, Mapping) or "prompt" not in body:
        return _err(400, "缺少 prompt 字段")
    try:
        async with DATA_FILE_LOCK:
            payload = set_agent_system_prompt(body.get("prompt"))
        return JSONResponse(payload)
    except Exception as e:
        return _err(500, f"保存提示词失败：{e}")


@app.put("/api/kbs/{kb_id}")
async def kbs_rename(kb_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    name = str(body.get("name") or "").strip()
    if not name:
        return _err(400, "知识库名称不能为空")
    try:
        async with DATA_FILE_LOCK:
            kb = rename_kb(kb_id, name)
        if kb is None:
            return _err(404, "知识库不存在")
        return JSONResponse({"kbId": kb["kbId"], "name": kb["name"], "docCount": len(kb["docs"])})
    except Exception as e:
        return _err(500, f"重命名知识库失败：{e}")


@app.delete("/api/kbs")
async def kbs_delete(request: Request):
    kb_id = request.query_params.get("kbId") or ""
    if not kb_id:
        return _err(400, "缺少 kbId 参数")
    try:
        async with DATA_FILE_LOCK:
            ok = delete_kb(kb_id)
        if not ok:
            return _err(404, "知识库不存在（default 库不可删除）")
        # kbs cleanup sticks → drop the Chroma collection too
        chroma_store.drop_collection(kb_id)
        return JSONResponse({"ok": True})
    except Exception as e:
        return _err(500, f"删除知识库失败：{e}")


# ---------------------------------------------------------------------------
# kb (docs of one KB; all routes take kbId, default fallback)
# ---------------------------------------------------------------------------
def _doc_meta(d: dict) -> dict:
    meta = d.get("embeddingMeta") if isinstance(d.get("embeddingMeta"), dict) else None
    return {
        "id": d["id"],
        "title": d["title"],
        "content": d["content"],
        "createdAt": d.get("createdAt") or now_iso(),
        "embedded": bool(meta and meta.get("upserted")),
    }


@app.get("/api/kb")
async def kb_get(request: Request):
    kb_id = _resolve_kb(request.query_params.get("kbId"))
    try:
        async with DATA_FILE_LOCK:
            docs = get_docs(kb_id)
        return JSONResponse({"docs": [_doc_meta(d) for d in docs], "kbId": kb_id})
    except Exception as e:
        return _err(500, f"读取知识库失败：{e}")


@app.post("/api/kb")
async def kb_post(request: Request):
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    content = str(body.get("content") or "").strip()
    title = str(body.get("title") or "").strip() or "未命名资料"
    if not content:
        return _err(400, "内容不能为空")
    kb_id = _resolve_kb(body.get("kbId"))
    try:
        async with DATA_FILE_LOCK:
            doc = add_doc(kb_id, title, content)
        return JSONResponse({"docs": [_doc_meta(doc)], "kbId": kb_id})
    except Exception as e:
        return _err(500, f"添加资料失败：{e}")


@app.delete("/api/kb")
async def kb_delete(request: Request):
    doc_id = request.query_params.get("id") or ""
    if not doc_id:
        return _err(400, "缺少 id 参数")
    kb_id = _resolve_kb(request.query_params.get("kbId"))
    try:
        async with DATA_FILE_LOCK:
            ok = delete_doc(kb_id, doc_id)
        if not ok:
            return _err(404, "文档不存在")
        # kb.json cleanup done under lock → sync Chroma right after (no lock needed)
        chroma_store.delete(kb_id, [doc_id])
        return JSONResponse({"ok": True})
    except Exception as e:
        return _err(500, f"删除文档失败：{e}")


@app.post("/api/kb/upload")
async def kb_upload(request: Request):
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    filename = str(body.get("filename") or "")
    content = str(body.get("content") or "")
    title_base = str(body.get("title") or "").strip() or filename

    allow_exts = (".txt", ".md")
    ext = "." + filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext not in allow_exts:
        return _err(400, "仅支持 txt / md 文件")
    if not content.strip():
        return _err(400, "文件内容为空")
    if len(content) > MAX_UPLOAD_CHARS:
        return _err(400, "文件内容超出 2MB 限制")
    kb_id = _resolve_kb(body.get("kbId"))

    try:
        async with DATA_FILE_LOCK:
            cfg = get_config()
            # per-KB 切块参数：读本库 chunking（不再用全局）
            settings = get_kb_settings(kb_id)
            chunking = settings.get("chunking") or {}
            max_chars = int(chunking.get("maxChars") or 600)
            overlap = int(chunking.get("overlap") or 50)
            pieces = chunk_text(content, max_chars, overlap)
            now = now_iso()
            new_docs = [
                {
                    "id": new_doc_id(),
                    "title": f"{title_base} · 第{i + 1}块",
                    "content": str(p["text"]),
                    "embeddingMeta": None,
                    "createdAt": now,
                }
                for i, p in enumerate(pieces)
            ]
            created = add_docs_batch(kb_id, new_docs)
        return JSONResponse({"docs": [_doc_meta(d) for d in created], "kbId": kb_id})
    except Exception as e:
        return _err(500, f"文件切块入库失败：{e}")


# ---------------------------------------------------------------------------
# ask (SSE)
# ---------------------------------------------------------------------------
def _sse_frame(payload: dict) -> str:
    import json

    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.post("/api/ask")
async def ask(request: Request):
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    question = str(body.get("question") or "").strip()
    if not question:
        return _err(400, "question is required")
    kb_id = _resolve_kb(body.get("kbId"))
    # 页面生命周期会话 ID（前端生成）：同页多次提问共用，刷新即新。
    # 供 openai 网关会话头（opencode go x-opencode-session）稳定命中 prompt 缓存。
    session_id = str(body.get("sessionId") or "").strip()[:64]

    async def event_stream():
        try:
            async for ev in run_ask(question, kb_id, session_id=session_id):
                yield _sse_frame(ev)
        except Exception as e:
            yield _sse_frame({"type": "error", "message": f"服务异常：{e}"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
