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
from .orchestrator.runner import astream_frames
from .pipeline import get_reembed_job, start_reembed_kb, sync_all_background
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
from .common import now_iso, decode_bytes
from .document_converter import convert_bytes

app = FastAPI(title="Kraq Backend", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_UPLOAD_CHARS = 2_000_000
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# 直解文本，不经 markitdown
PASSTHROUGH_EXTS = (".txt", ".md")
# 存档网页走 trafilatura 正文链（markitdown 的 HTML 转换是整页结构转换，实测会把
# <nav> 一类页面外壳一起入库）
HTML_EXTS = (".html", ".htm")
# 其余走 document_converter。刻意排除 .zip（markitdown 会展开包内每个文件，
# 输出体量无上限）与 .ppt/.doc/.xls 旧格式（无对应转换器，收下只会解析失败）。
ALLOWED_EXTS = PASSTHROUGH_EXTS + HTML_EXTS + (
    ".pdf", ".docx", ".pptx", ".xlsx", ".epub", ".csv", ".json", ".xml",
)

_sync_task: asyncio.Task | None = None


def _err(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def _resolve_kb(kb_id: str | None) -> str:
    """kbId 缺省或不存在 → 回落 default 库，不报 500。"""
    want = normalize_kb_id(kb_id)
    if any(kb["kbId"] == want for kb in get_kbs()):
        return want
    return DEFAULT_KB_ID


async def _to_markdown(raw: bytes, ext: str, filename: str, mimetype: str | None) -> str:
    # 转换是 CPU 活（PDF 尤其重），挪出事件循环，别卡住 SSE 问答
    converted = await asyncio.to_thread(
        convert_bytes, raw, extension=ext, mimetype=mimetype or None, filename=filename
    )
    return converted["markdown"]


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
    """per-KB 嵌入端点/模型、切块参数、简介、示例问题的局部更新（改名走 PUT /api/kbs/{kb_id}）。"""
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    if not isinstance(body, Mapping) or not (
        {"embedding", "chunking", "description", "suggestions"} & set(body)
    ):
        return _err(400, "至少提供 embedding、chunking、description 或 suggestions 之一")
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
            if "suggestions" in body:
                settings_patch["suggestions"] = body.get("suggestions")
            updated = update_kb_settings(kb_id, settings_patch)
        return JSONResponse({
            "kbId": updated["kbId"],
            "name": updated["name"],
            "embedding": updated["embedding"],
            "chunking": updated["chunking"],
            "description": updated.get("description") or "",
            "suggestions": list(updated.get("suggestions") or []),
        })
    except Exception as e:
        return _err(500, f"保存知识库配置失败：{e}")


@app.post("/api/kbs/{kb_id}/reembed")
async def kb_reembed(kb_id: str):
    """「重新嵌入」：强制对本库全部文档重算向量并 upsert。后台分批执行，
    立即返回任务快照（{status,total,done,error}），进度由 GET 同路径轮询。"""
    want = normalize_kb_id(kb_id)
    if not any(kb["kbId"] == want for kb in get_kbs()):
        return _err(404, f"知识库不存在：{kb_id}")
    try:
        job = start_reembed_kb(want)
    except Exception as e:
        return _err(400, str(e) or "重新嵌入启动失败")
    return JSONResponse(job)


@app.get("/api/kbs/{kb_id}/reembed")
async def kb_reembed_status(kb_id: str):
    """最近一次「重新嵌入」任务的进度/终态；无记录时返回 idle 快照。"""
    want = normalize_kb_id(kb_id)
    job = get_reembed_job(want)
    if job is None:
        return JSONResponse({
            "kbId": want,
            "status": "idle",
            "total": 0,
            "done": 0,
            "error": None,
        })
    return JSONResponse(job)


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
    """上传档案（multipart/form-data：file 必填，kbId / title 可选）。

    txt/md 直解，其余格式经 document_converter 转 Markdown 后切块入库。
    """
    try:
        form = await request.form()
    except Exception:
        return _err(400, "上传请求格式错误：需 multipart/form-data 且包含 file 字段")

    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        return _err(400, "上传请求格式错误：需 multipart/form-data 且包含 file 字段")

    filename = str(upload.filename or "").strip()
    title_base = str(form.get("title") or "").strip() or filename.rsplit(".", 1)[0]
    kb_id = _resolve_kb(str(form.get("kbId") or "").strip())

    ext = "." + filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext not in ALLOWED_EXTS:
        return _err(
            400,
            f"不支持该文件类型：{ext or '未知'}；支持 " + "、".join(e[1:] for e in ALLOWED_EXTS),
        )

    raw = await upload.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        return _err(400, "文件超出 20MB 上限")
    if not raw.strip():
        return _err(400, "文件内容为空")

    try:
        if ext in PASSTHROUGH_EXTS:
            content = decode_bytes(raw)
            if len(content) > MAX_UPLOAD_CHARS:
                return _err(400, "文件内容超出 2M 字符限制")
        elif ext in HTML_EXTS:
            from .link_extractor import extract_html_article

            try:
                content = (await asyncio.to_thread(extract_html_article, raw, ""))["content"]
            except Exception:
                # 正文识别不出来的存档页（全是 div 之类）回落整页转换
                content = await _to_markdown(raw, ext, filename, None)
        else:
            content = await _to_markdown(
                raw, ext, filename, getattr(upload, "content_type", None)
            )
    except Exception as e:
        return _err(400, str(e) or "文件解析失败")

    try:
        async with DATA_FILE_LOCK:
            # per-KB 切块参数：读本库 chunking（不再用全局）
            settings = get_kb_settings(kb_id)
            chunking = settings.get("chunking") or {}
            max_chars = int(chunking.get("maxChars") or 600)
            overlap = int(chunking.get("overlap") or 50)
            pieces = chunk_text(content, max_chars, overlap)
            now = now_iso()
            meta = {"source": "upload", "filename": filename, "format": ext[1:]}
            new_docs = [
                {
                    "id": new_doc_id(),
                    "title": f"{title_base} · 第{i + 1}块",
                    "content": str(p["text"]),
                    "embeddingMeta": {"upserted": False, **meta},
                    "createdAt": now,
                }
                for i, p in enumerate(pieces)
            ]
            created = add_docs_batch(kb_id, new_docs)
        return JSONResponse({"docs": [_doc_meta(d) for d in created], "kbId": kb_id})
    except Exception as e:
        return _err(500, f"文件切块入库失败：{e}")


@app.post("/api/link-clip")
async def link_clip(request: Request):
    """链接剪藏端点：接收 URL → 调用内嵌提取器 → 直接入库（无需写 .md 文件）"""
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    url = str(body.get("url") or "").strip()
    kb_id = _resolve_kb(str(body.get("kbId") or "").strip() or "default")
    if not url:
        return _err(400, "缺少 url 字段")
    from .link_extractor import extract_content, normalize_clip_url
    try:
        url = normalize_clip_url(url)
    except Exception as e:
        return _err(400, str(e))

    # 调用内嵌提取器（直接返回结构化内容，无需写 .md 文件）
    # 必须进线程池：抓取 + 解析是阻塞活，留在事件循环里会卡住整个后端（SSE 问答一起挂）
    try:
        extracted = await asyncio.to_thread(extract_content, url)
    except Exception as e:
        return _err(500, f"链接内容提取失败：{e}")

    title = extracted.get("title") or url[:50]
    content_text = extracted.get("content") or ""
    if not content_text:
        return _err(500, "提取内容为空")

    # 入库：使用与 upload 相同的 chunking 逻辑
    # 统一入库格式：仅存内容，标题留待后续 LLM 生成；提取的元数据存入 embeddingMeta 供后续使用
    async with DATA_FILE_LOCK:
        settings = get_kb_settings(kb_id)
        chunking = settings.get("chunking") or {}
        max_chars = int(chunking.get("maxChars") or 600)
        overlap = int(chunking.get("overlap") or 50)
        pieces = chunk_text(str(content_text), max_chars, overlap)
        now = now_iso()
        # 提取的元数据，供后续 LLM 生成标题或其他用途
        extracted_meta = {
            "source_url": url,
            "extracted_title": extracted.get("title"),
            "author": extracted.get("author"),
            "date": extracted.get("date"),
            "images": extracted.get("images", []),
            "platform": extracted.get("platform", "web"),
            "format": extracted.get("format", ""),
        }
        new_docs = [
            {
                "id": new_doc_id(),
                "title": f"片段 {i + 1}",  # 占位标题，后续由 LLM 生成
                "content": str(p["text"]),
                "embeddingMeta": {"upserted": False, "source": "link-clip", **extracted_meta},
                "createdAt": now,
            }
            for i, p in enumerate(pieces)
        ]
        created = add_docs_batch(kb_id, new_docs)
    return JSONResponse({
        "docs": [_doc_meta(d) for d in created],
        "kbId": kb_id,
        "url": url,
        "title": extracted.get("title"),
        "platform": extracted.get("platform", "web"),
    })


# ---------------------------------------------------------------------------
# link-clip async (异步任务模式)
# ---------------------------------------------------------------------------
from .task_queue import get_task_queue
from .store import (
    create_link_clip_task,
    get_link_clip_task,
    list_link_clip_tasks,
    update_link_clip_task,
    request_cancel_link_clip_task,
    reclaim_interrupted_tasks,
    TERMINAL_STATUSES,
)

@app.on_event("startup")
async def _startup_task_queue():
    """启动时回收上个进程遗留的任务，再拉起 Worker。

    执行状态（队列/协程/线程）不跨进程，遗留的 pending/running 若不标掉，
    前端会一直轮询那些永远不会推进的记录。
    """
    reclaimed = await reclaim_interrupted_tasks()
    if reclaimed:
        print(f"  · 回收上个进程遗留的转存任务：{reclaimed} 条")
    await get_task_queue().start()


@app.post("/api/link-clip/async")
async def link_clip_async(request: Request):
    """异步提交链接剪藏任务：即时返回 task_id。"""
    try:
        body = await request.json()
    except Exception:
        return _err(400, "请求体不是合法 JSON")
    url = str(body.get("url") or "").strip()
    kb_id = _resolve_kb(str(body.get("kbId") or "").strip() or "default")
    if not url:
        return _err(400, "缺少 url 字段")
    # 归一化后再建任务：tasks.json 里存过整串分享文案，队列弹窗的 host 会显示成垃圾
    from .link_extractor import normalize_clip_url
    try:
        url = normalize_clip_url(url)
    except Exception as e:
        return _err(400, str(e))

    queue = get_task_queue()
    task_id = await queue.submit(kb_id, url)
    return JSONResponse({"task_id": task_id, "status": "pending", "url": url})


@app.get("/api/link-clip/tasks/{task_id}")
async def link_clip_task_status(task_id: str):
    """查询任务状态/进度。"""
    task = await get_link_clip_task(task_id)
    if task is None:
        return _err(404, "任务不存在")
    return JSONResponse(task.to_dict())


@app.get("/api/link-clip/tasks")
async def link_clip_tasks_list(request: Request):
    """列出任务（可按 kb_id 过滤；activeOnly=true 时只给 pending/running）。"""
    kb_id = request.query_params.get("kbId")
    active_only = (request.query_params.get("activeOnly") or "").lower() in ("1", "true", "yes")
    tasks = await list_link_clip_tasks(kb_id)
    if active_only:
        tasks = [t for t in tasks if t.status not in TERMINAL_STATUSES]
    return JSONResponse({"tasks": [t.to_dict() for t in tasks]})


@app.post("/api/link-clip/tasks/{task_id}/cancel")
async def link_clip_task_cancel(task_id: str):
    """请求取消任务（终态任务不可取消）。"""
    task = await get_link_clip_task(task_id)
    if task is None:
        return _err(404, "任务不存在")
    if task.status in TERMINAL_STATUSES:
        return _err(409, "任务已结束")
    await request_cancel_link_clip_task(task_id)
    return JSONResponse({"ok": True})


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
            async for ev in astream_frames(question, kb_id, session_id=session_id):
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
