#!/usr/bin/env python3
"""
One-click starter for Kraq:
- Starts Next.js dev server (frontend) on port 3000
- Starts Python API backend on port 8000
- Proxies non-API requests to the frontend server
"""

import os
import shutil
import sys
import subprocess
import time
import signal
import threading
from pathlib import Path

import uvicorn
import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

# Import the backend app from backend.main
sys.path.append(str(Path(__file__).parent))
from backend.main import app as api_app  # noqa: F401

# Configuration
FRONTEND_PORT = int(os.getenv("FRONTEND_PORT", 3000))
BACKEND_PORT = int(os.getenv("BACKEND_PORT", 8000))
FRONTEND_URL = f"http://localhost:{FRONTEND_PORT}"
# 项目根目录（main.py 所在目录），作为子进程的工作目录
PROJECT_ROOT = str(Path(__file__).resolve().parent)
# 直接调用本地 next 二进制，绕开 scripts/dev.sh（其在 Windows Git Bash 下有 POSIX 路径兼容问题）
if os.name == "nt":
    # Windows: pnpm 是 pnpm.cmd 垫片，必须通过 cmd /c 启动，否则 CreateProcess 报 FileNotFoundError
    NEXTJS_CMD = ["cmd", "/c", "pnpm", "exec", "next", "dev",
                  "--hostname", "0.0.0.0", "--port", str(FRONTEND_PORT)]
else:
    NEXTJS_CMD = ["pnpm", "exec", "next", "dev",
                  "--hostname", "0.0.0.0", "--port", str(FRONTEND_PORT)]

# Global subprocess reference
frontend_proc = None

def start_frontend():
    global frontend_proc
    frontend_dir = Path(PROJECT_ROOT) / "frontend"
    # 开发调试检查：确保 frontend/node_modules 存在（若缺失则先执行 pnpm install，使用完整路径避免 .venv 问题）
    next_bin = frontend_dir / "node_modules" / ".bin" / "next"
    if not next_bin.exists():
        print("[kraq] 前端依赖缺失（frontend/node_modules 不存在），正在执行 pnpm install ...")
        pnpm_executable = shutil.which('pnpm') or 'pnpm'
        install_result = subprocess.run(
            [pnpm_executable, "install", "--prefer-frozen-lockfile", "--prefer-offline", "--loglevel", "debug", "--reporter=append-only"],
            cwd=str(frontend_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        print(f"[kraq] pnpm install 完成（退出码: {install_result.returncode}）")
        if install_result.returncode != 0:
            print(f"[kraq] 警告：pnpm install 失败，退出码 {install_result.returncode}，可能无法启动前端服务器")
    print("Starting Next.js dev server...")
    frontend_proc = subprocess.Popen(
        NEXTJS_CMD,
        cwd=str(Path(PROJECT_ROOT) / "frontend"),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    def log_output():
        for line in frontend_proc.stdout:
            print(f"[kraq] {line.rstrip()}")
    threading.Thread(target=log_output, daemon=True).start()
    # Wait for server to be ready
    for _ in range(30):
        try:
            with httpx.Client(timeout=2.0) as client:
                resp = client.get(f"{FRONTEND_URL}/")
                if resp.status_code < 500:
                    print(f"Frontend ready at {FRONTEND_URL}")
                    return
        except Exception:
            pass
        time.sleep(0.5)
    print("Warning: Frontend may not be ready yet")



def open_browser():
    """前端就绪后用系统默认浏览器打开 UI 页面。"""
    try:
        if os.name == "nt":
            os.startfile(f"{FRONTEND_URL}/")  # Windows 默认浏览器
        else:
            subprocess.Popen(["xdg-open", FRONTEND_URL])
    except Exception as e:
        print(f"Warning: 打开浏览器失败（{e}），请手动访问 {FRONTEND_URL}")

def stop_frontend():
    global frontend_proc
    if frontend_proc:
        print("Stopping Next.js dev server...")
        if os.name == "nt":
            # Windows: 直接终止的只是 cmd.exe 壳，node 子进程会残留，用 taskkill 杀整棵树
            subprocess.run(["taskkill", "/PID", str(frontend_proc.pid), "/T", "/F"],
                           capture_output=True)
        else:
            frontend_proc.terminate()
        try:
            frontend_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            frontend_proc.kill()
        frontend_proc = None

def signal_handler(sig, frame):
    print("Shutting down...")
    stop_frontend()
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

app = FastAPI()
# 自包含方案：把 API 前缀挂到 api_app 外层（子应用的路由都带 /api 前缀定义），
# 并把代理 catch-all 请求排除在 /api 之外。
app.include_router(api_app.router)

@app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def proxy_to_frontend(request: Request, full_path: str):
    if full_path.startswith("api/"):
        return Response(status_code=404)
    url = f"{FRONTEND_URL}/{full_path}"
    method = request.method
    headers = dict(request.headers)
    headers.pop("host", None)
    body = await request.body()
    params = request.query_params
    async def _proxy():
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=60.0)) as client:
            resp = await client.request(
                method,
                url,
                headers=headers,
                content=body,
                params=params,
                timeout=None,
                follow_redirects=True,
            )
            # Return status, headers, and async iterable of chunks
            async def chunk_gen():
                async for chunk in resp.aiter_bytes():
                    yield chunk
            return StreamingResponse(chunk_gen(), status_code=resp.status_code, headers=dict(resp.headers))
    # Actually we need to return the StreamingResponse directly; we can't return a coroutine.
    # So we restructure: do the request and then return StreamingResponse.
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=60.0)) as client:
        resp = await client.request(
            method,
            url,
            headers=headers,
            content=body,
            params=params,
            follow_redirects=True,
        )
        # Prepare headers to forward
        resp_headers = dict(resp.headers)
        # Remove hop-by-hop headers
        for h in ["content-encoding", "transfer-encoding", "connection", "keep-alive"]:
            resp_headers.pop(h, None)
        # Return streaming response
        return StreamingResponse(
            resp.aiter_bytes(),
            status_code=resp.status_code,
            headers=resp_headers,
        )

if __name__ == "__main__":
    try:
        start_frontend()
        open_browser()
        print(f"Starting Python API backend on http://127.0.0.1:{BACKEND_PORT} (internal only, UI at :{FRONTEND_PORT})")
        uvicorn.run("main:app", host="127.0.0.1", port=BACKEND_PORT, log_level="info")
    finally:
        stop_frontend()