#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
任务队列 + Worker：异步执行链接转存任务。

- TaskQueue：排队、并发控制、取消信号分发、Worker 生命周期
- run_link_clip_task：单个任务的完整流程（进度合并落盘 + 取消检查）
- _ProgressEmitter：把工作线程里的进度合并成"最新值 + 周期落盘"

两条不变式（实施依据 plan/link-clip-progress.md §2）：
1. 只有 _run_with_tracking 写 status，进度写永不带 status；
2. 终态写入之前必须先 emitter.aclose() 把最后一槽落盘，之后再无进度写。
"""
import asyncio
import logging
import threading
from dataclasses import dataclass
from typing import Optional
from contextlib import suppress

from .store import (
    TaskStatus,
    add_docs_batch,
    create_link_clip_task,
    get_kb_settings,
    get_link_clip_task,
    new_doc_id,
    update_link_clip_task,
)
from .link_extractor import extract_content
from .chunker import chunk_text
from .common import CancelledError, now_iso

logger = logging.getLogger(__name__)

# 线程回调 → 落盘的合并周期。取 250ms：比前端 1.5s 轮询细一个数量级，
# 又不会让 tasks.json 的原子写频率变成负担。
_FLUSH_INTERVAL = 0.25


@dataclass
class TaskContext:
    """提交时创建、Worker 里执行。cancel_event 由线程安全地读，故可直接交给工作线程。"""
    task_id: str
    kb_id: str
    url: str
    cancel_event: threading.Event


class _ProgressEmitter:
    """进度落盘的合并器。

    extract_content 在 asyncio.to_thread 里跑，不能 await，也就不能直接写库；
    而 create_task 发射即忘会带来"终态之后的迟到写"（把 completed 改回 running）。
    覆盖式最新值 + 单一 flush 协程，两个问题一起解决：中间态可丢，最新态必留。
    """

    def __init__(self, task_id: str):
        self._task_id = task_id
        self._loop = asyncio.get_running_loop()
        self._slot: Optional[tuple[str, int, str]] = None
        self._pump: Optional[asyncio.Task] = None
        self._closed = False

    def start(self) -> None:
        self._pump = asyncio.create_task(self._flush_loop())

    def thread_cb(self, stage: str, pct: int, detail: str) -> None:
        """工作线程里调用：只把最新值送进事件循环，不等待。"""
        if self._closed:
            return
        self._loop.call_soon_threadsafe(self._set_slot, stage, pct, detail)

    def _set_slot(self, stage: str, pct: int, detail: str) -> None:
        self._slot = (stage, pct, detail)

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(_FLUSH_INTERVAL)
            await self._flush_once()

    async def _flush_once(self) -> None:
        slot, self._slot = self._slot, None
        if slot is None:
            return
        stage, pct, detail = slot
        # 不带 status：终态守卫之外还有这条规矩，两者共同保证不会"复活"
        await update_link_clip_task(
            self._task_id,
            progress=pct,
            stage=stage,  # type: ignore[arg-type]
            detail=detail,
        )

    async def aclose(self) -> None:
        """停 pump 并把最后一槽写下去。幂等，可多处调用。"""
        if self._closed:
            return
        self._closed = True
        if self._pump is not None:
            self._pump.cancel()
            # update_link_clip_task 拿到锁之后全程无 await，
            # 所以 await 返回时不会有"写了一半"的落盘悬在终态之后。
            with suppress(asyncio.CancelledError):
                await self._pump
            self._pump = None
        with suppress(Exception):
            await self._flush_once()


async def run_link_clip_task(ctx: TaskContext, emitter: _ProgressEmitter) -> dict:
    """抓取 → 解析 → 切块 → 入库。

    阶段内子进度由 extract_content 经 emitter 报；这里只写阶段边界（直接 await，
    保证前端每次轮询至少能看到一次 stage 变化）。终态由 _run_with_tracking 统一写。
    """
    cancel_event = ctx.cancel_event

    def alive() -> None:
        if cancel_event.is_set():
            raise CancelledError()

    # 提取（网络 + 解析）在线程里跑，进度走 emitter
    alive()
    try:
        extracted = await asyncio.to_thread(
            extract_content,
            ctx.url,
            emitter.thread_cb,
            cancel_event.is_set,
        )
    except CancelledError:
        raise
    except Exception as e:
        raise RuntimeError(f"内容提取失败：{e}") from e

    # 标题一旦拿到就落盘：队列弹窗要用它当行名，只有 host 时并发任务无法区分
    await update_link_clip_task(ctx.task_id, page_title=extracted.get("title"))

    alive()
    content_text = extracted.get("content") or ""
    if not content_text:
        raise RuntimeError("提取内容为空")

    settings = get_kb_settings(ctx.kb_id)
    chunking = settings.get("chunking") or {}
    max_chars = int(chunking.get("maxChars") or 600)
    overlap = int(chunking.get("overlap") or 50)
    pieces = chunk_text(str(content_text), max_chars, overlap)

    await update_link_clip_task(
        ctx.task_id, stage="chunking", progress=60, detail=f"切成 {len(pieces)} 块"
    )

    alive()
    now = now_iso()
    extracted_meta = {
        "source_url": ctx.url,
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
            "title": f"片段 {i + 1}",
            "content": str(p["text"]),
            "embeddingMeta": {"upserted": False, "source": "link-clip", **extracted_meta},
            "createdAt": now,
        }
        for i, p in enumerate(pieces)
    ]

    await update_link_clip_task(
        ctx.task_id, stage="indexing", progress=80, detail="写入档案柜…"
    )
    created = await asyncio.to_thread(add_docs_batch, ctx.kb_id, new_docs)

    alive()
    # result 不存 extracted 全文：那会让 tasks.json 随正文规模膨胀
    return {
        "doc_ids": [d["id"] for d in created],
        "title": extracted.get("title"),
        "content_chars": len(str(content_text)),
        "image_count": len(extracted.get("images", [])),
        "platform": extracted.get("platform", "web"),
    }


class TaskQueue:
    """任务队列：限制并发、后台消费、支持提交/取消/查询。"""

    def __init__(self, max_concurrent: int = 2):
        self._queue: asyncio.Queue[TaskContext] = asyncio.Queue()
        self._sem = asyncio.Semaphore(max_concurrent)
        self._running: dict[str, asyncio.Task] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._worker_task: Optional[asyncio.Task] = None
        self._watch_task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._worker_loop())
        if self._watch_task is None or self._watch_task.done():
            self._watch_task = asyncio.create_task(self._watch_cancellation())

    async def stop(self) -> None:
        for t in (self._worker_task, self._watch_task):
            if t is not None:
                t.cancel()
                with suppress(asyncio.CancelledError):
                    await t
        self._worker_task = None
        self._watch_task = None

    async def submit(self, kb_id: str, url: str) -> str:
        task = await create_link_clip_task(kb_id, url)
        event = threading.Event()
        self._cancel_events[task.task_id] = event
        await self._queue.put(
            TaskContext(task_id=task.task_id, kb_id=task.kb_id, url=task.url,
                        cancel_event=event)
        )
        return task.task_id

    async def _worker_loop(self) -> None:
        while True:
            ctx = await self._queue.get()
            if ctx.cancel_event.is_set():
                self._drop(ctx.task_id)
                continue
            # 不在这里等槽位：阻塞式 acquire 会让整个循环停在第三条上，
            # 于是"排队中取消"要等前面 30s 超时任务让位才可能被处理。
            asyncio.create_task(self._start_when_free(ctx))

    async def _start_when_free(self, ctx: TaskContext) -> None:
        await self._sem.acquire()
        if ctx.cancel_event.is_set():
            # 等槽位期间被取消：不占槽位、不执行（终态由 _watch_cancellation 落）
            self._sem.release()
            self._drop(ctx.task_id)
            return
        task = asyncio.create_task(self._run_with_tracking(ctx))
        self._running[ctx.task_id] = task
        task.add_done_callback(lambda _t, tid=ctx.task_id: self._finish(tid))

    def _drop(self, task_id: str) -> None:
        self._cancel_events.pop(task_id, None)

    def _finish(self, task_id: str) -> None:
        self._running.pop(task_id, None)
        self._cancel_events.pop(task_id, None)
        self._sem.release()

    async def _watch_cancellation(self) -> None:
        """把 cancel_requested 翻成内存 Event。

        工作线程读不到 asyncio 侧的状态，而"发射一个 future 再问它 done 了没"
        恒为 False（旧实现的问题）；每 1s 一次读库换来确定性。
        """
        while True:
            await asyncio.sleep(1.0)
            for task_id, event in list(self._cancel_events.items()):
                if event.is_set():
                    continue
                try:
                    task = await get_link_clip_task(task_id)
                except Exception:
                    continue
                if task is None:
                    event.set()
                    continue
                if not task.cancel_requested:
                    continue
                event.set()
                if task.status == "pending":
                    # 还没开跑的任务不必等槽位，这里直接落终态
                    await update_link_clip_task(
                        task_id, status="cancelled", stage="cancelled", error="用户取消"
                    )

    async def _run_with_tracking(self, ctx: TaskContext) -> None:
        task_id = ctx.task_id
        emitter = _ProgressEmitter(task_id)
        emitter.start()

        status: TaskStatus
        fields: dict
        try:
            # 唯一一处写 running
            await update_link_clip_task(
                task_id, status="running", stage="queued", progress=0, detail="排队中"
            )
            result = await run_link_clip_task(ctx, emitter)
            status, fields = "completed", {
                "progress": 100, "detail": "转存完成", "result": result,
            }
        except CancelledError:
            status, fields = "cancelled", {"error": "用户取消"}
        except Exception as e:
            status, fields = "failed", {"error": str(e)}
            logger.exception("转存任务失败：%s", ctx.url)

        # 先 drain，再写终态：这个顺序保证终态是最后一笔写，之后不可能再有进度
        await emitter.aclose()
        await update_link_clip_task(task_id, status=status, stage=status, **fields)


# 全局单例队列（main.py 启动时初始化）
_task_queue: Optional[TaskQueue] = None


def get_task_queue() -> TaskQueue:
    global _task_queue
    if _task_queue is None:
        _task_queue = TaskQueue(max_concurrent=2)
    return _task_queue
