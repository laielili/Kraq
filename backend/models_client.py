"""Model client for Ollama-native and OpenAI-compatible endpoints.

Per-endpoint dispatch by ep["protocol"]; tolerant about /v1 suffix variants:
whether an openai-protocol baseUrl already carries /v1 is decided by probing
{base}/models first and retrying {base}/v1/models on 404 (brief rule).

Timeouts (brief): embedding 20s, chat invoke 30s, rerank 15s.
Connection/timeout errors raise; the pipeline catches and degrades.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import os
import re
import subprocess
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Mapping, Optional, Sequence

import httpx

EMBED_TIMEOUT = 20.0
CHAT_INVOKE_TIMEOUT = 30.0
RERANK_TIMEOUT = 15.0

RERANK_SCORE_KEYS = ("relevance.score", "relevance_score", "score")
_SCORE_RE = re.compile(r"(?:^|(?<![0-9]))(10|[0-9])(?![0-9])")

_client: httpx.AsyncClient | None = None


def get_shared_client() -> httpx.AsyncClient:
    """Module-level reusable httpx.AsyncClient (brief requirement)."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=10.0)
    return _client


def normalize_base_url(base_url: str) -> str:
    return (base_url or "").strip().rstrip("/")


def _headers(ep: Mapping[str, Any]) -> Dict[str, str]:
    key = resolve_api_key(ep.get("apiKey"))
    return {"Authorization": f"Bearer {key}"} if key else {}


def _session_header(ep: Mapping[str, Any], session_id: str = "") -> Dict[str, str]:
    """OpenAI-protocol gateways may require a session id for routing/prompt
    caching (opencode go: MissingSessionID 400 without x-opencode-session).

    session_id comes from the frontend page lifecycle (stable across the
    conversation's requests — refresh/close starts a new one), so repeated
    questions in one session share a prefix and hit the gateway's prompt
    cache. Background jobs without a session fall back to a per-request UUID.
    Unknown headers are ignored by other OpenAI-compatible providers, so this
    is safe to send unconditionally on the openai protocol path."""
    if ep.get("protocol") != "openai":
        return {}
    sid = (session_id or "").strip() or uuid.uuid4().hex
    return {"x-opencode-session": sid[:64]}


def resolve_api_key(value: object) -> str:
    """Endpoint apiKey -> real secret.

    `env:NAME` pulls NAME from the process environment (loaded from the
    project-root .env at startup); anything else is used verbatim, so legacy
    configs with a plaintext key keep working. Missing/unset variable yields
    an empty string (request is sent without Authorization).
    """
    raw = str(value or "").strip()
    if raw.startswith("env:"):
        return os.environ.get(raw[4:].strip(), "")
    return raw


def ensure_base_url_scheme(base_url: str) -> str:
    if not (base_url.startswith("http://") or base_url.startswith("https://")):
        raise ValueError("baseUrl 必须以 http:// 或 https:// 开头")
    return base_url


def ensure_base_url(base_url: str) -> str:
    """Alias used by call sites; validates scheme and returns as-is."""
    return ensure_base_url_scheme(base_url)


# ---------------------------------------------------------------------------
# list_models
# ---------------------------------------------------------------------------
async def _list_models_openai(base: str, headers: Dict[str, str]) -> List[str]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{base}/models", headers=headers)
        if resp.status_code == 404:
            resp = await client.get(f"{base}/v1/models", headers=headers)
        resp.raise_for_status()
        data = resp.json()
        models = data.get("data") if isinstance(data, dict) else None
        if not isinstance(models, list):
            return []
        names: List[str] = []
        for m in models:
            if isinstance(m, dict):
                mid = m.get("id") or m.get("name") or m.get("model")
                if isinstance(mid, str) and mid:
                    names.append(mid)
            elif isinstance(m, str):
                names.append(m)
        return names


async def list_models(ep: Mapping[str, Any]) -> List[str]:
    base = normalize_base_url(ensure_base_url(str(ep.get("baseUrl") or "")))
    headers = _headers(ep)
    if ep.get("protocol") == "ollama":
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{base}/api/tags")
            resp.raise_for_status()
            data = resp.json()
        return [
            m["name"]
            for m in (data.get("models") or [])
            if isinstance(m, dict) and isinstance(m.get("name"), str)
        ]
    if ep.get("protocol") == "llamacpp":
        # llama-server /rerank 服务只挂一个 GGUF；/v1/models 返回该模型的 alias
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{base}/v1/models")
            if resp.status_code < 500:
                resp.raise_for_status()
                data = resp.json()
                models = data.get("data") if isinstance(data, dict) else None
                names = [
                    str(m.get("id"))
                    for m in (models or [])
                    if isinstance(m, dict) and m.get("id")
                ]
                if names:
                    return names
            # fallback：探测 /v1/rerank 是否可用
            probe = await client.post(
                f"{base}/v1/rerank",
                json={"query": "ping", "documents": ["pong"]},
            )
            if probe.status_code < 500:
                return ["<this llama.cpp service>"]
        raise ValueError("llama.cpp 服务不可达")
    return await _list_models_openai(base, headers)


# ---------------------------------------------------------------------------
# embed_texts
# ---------------------------------------------------------------------------
async def _post_embeddings(
    ep: Mapping[str, Any],
    base: str,
    model: str,
    texts: Sequence[str],
    path: str,
) -> List[List[float]]:
    headers = _headers(ep)
    headers.update(_session_header(ep))
    headers["Content-Type"] = "application/json"
    async with httpx.AsyncClient(timeout=EMBED_TIMEOUT) as client:
        resp = await client.post(
            f"{base}{path}",
            headers=headers,
            json={"model": model, "input": list(texts)},
        )
    resp.raise_for_status()
    data = resp.json()
    # ollama style {"embeddings": [[...], ...]}
    if isinstance(data, dict) and isinstance(data.get("embeddings"), list):
        return [list(e) for e in data["embeddings"]]
    # openai style {"data": [{"embedding": [...]}, ...]}
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        out: List[List[float]] = []
        for item in data["data"]:
            if isinstance(item, dict) and isinstance(item.get("embedding"), list):
                out.append([float(x) for x in item["embedding"]])
        return out
    raise ValueError("embedding 响应格式无法解析")


async def embed_texts(ep: Mapping[str, Any], model: str, texts: Sequence[str]) -> List[List[float]]:
    base = normalize_base_url(ensure_base_url(str(ep.get("baseUrl") or "")))
    if ep.get("protocol") == "ollama":
        try:
            return await _post_embeddings(ep, base, model, texts, "/api/embed")
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return await _post_embeddings(ep, base, model, texts, "/v1/embeddings")
            raise
    # openai protocol: main path first, /v1 fallback on 404
    try:
        return await _post_embeddings(ep, base, model, texts, "/embeddings")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return await _post_embeddings(ep, base, model, texts, "/v1/embeddings")
        raise


# ---------------------------------------------------------------------------
# chat
# ---------------------------------------------------------------------------
def _extract_openai_delta_content(payload: Mapping[str, Any]) -> tuple[str, str]:
    try:
        choices = payload.get("choices") or []
        choice = choices[0] if choices else None
        if not isinstance(choice, dict):
            return "", ""
        delta = choice.get("delta")
        if isinstance(delta, dict):
            reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
            return str(delta.get("content") or ""), str(reasoning or "")
        return "", ""
    except Exception:
        return "", ""


def _content_from_ndjson_line(line: str) -> tuple[str, str]:
    """Extract (content, thinking) from one ollama NDJSON chat chunk.

    Ollama streams reasoning models' deliberation in message.thinking alongside
    message.content; both arrive incrementally on the same NDJSON stream.
    """
    if not line.strip():
        return "", ""
    try:
        payload = json.loads(line)
    except Exception:
        return "", ""
    if not isinstance(payload, dict):
        return "", ""
    message = payload.get("message")
    if isinstance(message, dict):
        return (
            str(message.get("content") or ""),
            str(message.get("thinking") or ""),
        )
    # some ollama builds stream openai-style under /api/chat proxy? keep fallback
    choices = payload.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        delta = choices[0].get("delta")
        if isinstance(delta, dict):
            reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
            return str(delta.get("content") or ""), str(reasoning or "")
    return "", ""


async def chat_stream(
    ep: Mapping[str, Any],
    model: str,
    messages: Sequence[Mapping[str, str]],
    temperature: float,
    session_id: str = "",
) -> AsyncGenerator[tuple[str, str], None]:
    """Yield (content, thinking) chunks from a streaming chat completion.

    Reasoning models stream their deliberation in parallel with the answer;
    both channels arrive incrementally. Either channel may be empty per chunk.
    """
    base = normalize_base_url(ensure_base_url(str(ep.get("baseUrl") or "")))
    headers = _headers(ep)
    headers.update(_session_header(ep, session_id))
    headers["Content-Type"] = "application/json"
    body = {"model": model, "messages": list(messages), "temperature": temperature, "stream": True}
    if ep.get("protocol") == "openai":
        url = f"{base}/chat/completions"
    else:
        body.pop("temperature", None)
        body["options"] = {"temperature": temperature}
        url = f"{base}/api/chat"
    timeout = httpx.Timeout(CHAT_INVOKE_TIMEOUT, read=None)
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            resp.raise_for_status()
            if ep.get("protocol") == "openai":
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    payload = None
                    if line.startswith("data:"):
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            payload = json.loads(data)
                        except Exception:
                            payload = None
                    else:
                        try:
                            payload = json.loads(line)
                        except Exception:
                            payload = None
                    if isinstance(payload, Mapping):
                        chunk, reasoning = _extract_openai_delta_content(payload)
                        if chunk:
                            yield chunk, ""
                        if reasoning:
                            yield "", reasoning
            else:
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    if isinstance(line, bytes):
                        line = line.decode("utf-8", "ignore")
                    content, thinking = _content_from_ndjson_line(line)
                    try:
                        obj = json.loads(line)
                    except Exception:
                        obj = None
                    if isinstance(obj, Mapping) and obj.get("done") is True:
                        break
                    if content:
                        yield content, ""
                    if thinking:
                        yield "", thinking


async def chat_invoke(
    ep: Mapping[str, Any],
    model: str,
    messages: Sequence[Mapping[str, str]],
    temperature: float,
    max_tokens: int = 512,
    think: bool = True,
    session_id: str = "",
) -> str:
    base = normalize_base_url(ensure_base_url(str(ep.get("baseUrl") or "")))
    headers = _headers(ep)
    headers.update(_session_header(ep, session_id))
    headers["Content-Type"] = "application/json"
    if ep.get("protocol") == "openai":
        body = {
            "model": model,
            "messages": list(messages),
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        url = f"{base}/chat/completions"
    else:
        body = {
            "model": model,
            "messages": list(messages),
            "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        # think=False 供不需要思考链的小调用（如意图分类）显式关闭思考模式；
        # 默认不设置该字段，保持 generate/validate 的思考行为不变
        if not think:
            body["think"] = False
        url = f"{base}/api/chat"
    async with httpx.AsyncClient(timeout=CHAT_INVOKE_TIMEOUT) as client:
        resp = await client.post(url, headers=headers, json=body)
    resp.raise_for_status()
    data = resp.json()
    if ep.get("protocol") == "openai":
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") if isinstance(choice, dict) else None
        return str(msg.get("content") or "") if isinstance(msg, dict) else ""
    msg = data.get("message")
    if isinstance(msg, dict):
        return str(msg.get("content") or "")
    raise ValueError("模型响应缺少 message.content")


# ---------------------------------------------------------------------------
# rerank
# ---------------------------------------------------------------------------
def _rerank_score(item: Any) -> float:
    """Tolerant score extraction: relevance.score → relevance_score → score."""
    result = item.get("relevance") if isinstance(item, Mapping) else None
    if isinstance(result, dict):
        v = result.get("score")
        if isinstance(v, (int, float)):
            return float(v)
    for key in ("relevance_score", "score"):
        if isinstance(item, Mapping) and isinstance(item.get(key), (int, float)):
            return float(item[key])
    if isinstance(item, (int, float)):
        return float(item)
    return 0.0


async def _rerank_openai(
    base: str,
    headers: Dict[str, str],
    model: str,
    query: str,
    docs: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    payload = {
        "model": model,
        "query": query,
        "documents": [str(d["text"]) for d in docs],
    }
    async with httpx.AsyncClient(timeout=RERANK_TIMEOUT) as client:
        resp = await client.post(f"{base}/rerank", headers=headers, json=payload)
        if resp.status_code == 404:
            resp = await client.post(f"{base}/v1/rerank", headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
    results = data.get("results") if isinstance(data, dict) else None
    out: List[Dict[str, Any]] = []
    if isinstance(results, list):
        for item in results:
            if isinstance(item, dict) and isinstance(item.get("index"), int):
                idx = item["index"]
                if 0 <= idx < len(docs):
                    out.append({"id": str(docs[idx]["id"]), "score": _rerank_score(item)})
    return out


async def _rerank_llamacpp(
    base: str,
    model: str,
    query: str,
    docs: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """llama-server --reranking exposes /v1/rerank (also aliased /rerank).

    Response: {"results": [{"index": int, "relevance_score": float}, ...]}
    """
    payload = {
        "query": query,
        "documents": [str(d["text"]) for d in docs],
    }
    if model and not model.startswith("<"):
        payload["model"] = model
    async with httpx.AsyncClient(timeout=RERANK_TIMEOUT) as client:
        resp = await client.post(f"{base}/v1/rerank", json=payload)
        if resp.status_code == 404:
            resp = await client.post(f"{base}/rerank", json=payload)
        resp.raise_for_status()
        data = resp.json()
    results = data.get("results") if isinstance(data, dict) else None
    out: List[Dict[str, Any]] = []
    if isinstance(results, list):
        for item in results:
            if isinstance(item, dict) and isinstance(item.get("index"), int):
                idx = item["index"]
                if 0 <= idx < len(docs):
                    out.append({"id": str(docs[idx]["id"]), "score": _rerank_score(item)})
    return out


def _parse_score_0_10(text: str) -> float:
    m = _SCORE_RE.search(text or "")
    if not m:
        return 0.0
    return float(m.group(1))


_RERANK_SYSTEM = "你是检索相关性打分器，只输出一个 0-10 的整数"


async def _rerank_one_ollama(
    ep: Mapping[str, Any],
    model: str,
    query: str,
    d: Mapping[str, Any],
) -> Dict[str, Any]:
    user = f"查询：{query}\n\n候选文档：{d['text']}"
    messages = [
        {"role": "system", "content": _RERANK_SYSTEM},
        {"role": "user", "content": user},
    ]
    try:
        text = await asyncio.wait_for(
            chat_invoke(ep, model, messages, 0.0, 8),
            timeout=15.0,
        )
        score = _parse_score_0_10(text)
    except Exception:
        score = 0.0
    return {"id": str(d["id"]), "score": score}


# ---------------------------------------------------------------------------
# llama.cpp rerank service auto-start ("ensure running when needed")
# ---------------------------------------------------------------------------
_LLAMA_CPP_EXE = Path(os.environ.get("LLAMA_CPP_DIR", Path.home() / "llama.cpp")) / "llama-server.exe"
# Reuse the GGUF blob ollama already downloaded (single copy, no duplicate download).
_BGE_GGUF = (
    Path.home()
    / ".ollama/models/blobs/sha256-4bf51534d8d1aebced4de6eca4a8a39bd207170b42e3dcffa7718d194771a713"
)
_LLAMA_SERVER_PORT = 8082

_lcpp_proc: subprocess.Popen | None = None
_lcpp_lock = asyncio.Lock()


def _lcpp_alive() -> bool:
    return _lcpp_proc is not None and _lcpp_proc.poll() is None


async def ensure_llamacpp_service(ep: Mapping[str, Any]) -> None:
    """If the endpoint's HTTP service is up, do nothing. Otherwise spawn
    llama-server --reranking once, wait for readiness, then return.

    Raises RuntimeError with an actionable Chinese message on failure.
    """
    global _lcpp_proc
    async with _lcpp_lock:
        base = normalize_base_url(ensure_base_url(str(ep.get("baseUrl") or "")))
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"{base}/v1/models")
            if resp.status_code < 500:
                return  # already up (possibly started outside this process)
        except Exception:
            pass  # not reachable -> try to start it

        if _lcpp_alive():
            _terminate_lcpp()

        exe = str(_LLAMA_CPP_EXE)
        if not _LLAMA_CPP_EXE.is_file():
            raise ValueError(
                f"未找到 llama-server.exe（{_LLAMA_CPP_EXE}）。"
                "请安装 llama.cpp 或设置环境变量 LLAMA_CPP_DIR 指向其目录。"
            )
        if not _BGE_GGUF.is_file():
            raise ValueError(
                f"未找到 bge-reranker-v2-m3 的 GGUF 文件（{_BGE_GGUF}）。"
                "请先执行 ollama pull qllama/bge-reranker-v2-m3。"
            )
        port = base.rsplit(":", 1)[-1] if "://" in base else str(_LLAMA_SERVER_PORT)
        cmd = [
            exe,
            "-m", str(_BGE_GGUF),
            "--reranking",
            "--alias", "bge-reranker-v2-m3",
            "--port", port,
            "--ctx-size", "512",
        ]
        _lcpp_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        deadline = asyncio.get_event_loop().time() + 30.0
        port_num = int(port) if port.isdigit() else _LLAMA_SERVER_PORT
        probe_url = f"http://127.0.0.1:{port_num}/v1/models"
        while asyncio.get_event_loop().time() < deadline:
            if _lcpp_proc.poll() is not None:
                raise ValueError("llama-server 启动即退出（端口被占用或 GGUF 损坏），请检查 8082 端口")
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    r = await client.get(probe_url)
                if r.status_code < 500:
                    return
            except Exception:
                await asyncio.sleep(0.5)
        raise ValueError("llama-server 启动超过 30 秒未就绪，请手动检查")


def _terminate_lcpp() -> None:
    global _lcpp_proc
    if _lcpp_proc is not None and _lcpp_proc.poll() is None:
        try:
            _lcpp_proc.terminate()
            try:
                _lcpp_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _lcpp_proc.kill()
        except Exception:
            pass
    _lcpp_proc = None


# When the backend exits normally (uvicorn shutdown / Ctrl+C), take the spawned
# llama-server with it. (taskkill /T also sweeps it; this covers graceful path.)
atexit.register(_terminate_lcpp)


# ---------------------------------------------------------------------------
# rerank dispatch
# ---------------------------------------------------------------------------
async def rerank(
    ep: Mapping[str, Any],
    model: str,
    query: str,
    docs: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    if not docs:
        return []
    base = normalize_base_url(ensure_base_url(str(ep.get("baseUrl") or "")))
    headers = _headers(ep)
    if ep.get("protocol") == "openai":
        return await _rerank_openai(base, headers, model, query, docs)
    if ep.get("protocol") == "llamacpp":
        await ensure_llamacpp_service(ep)
        try:
            return await _rerank_llamacpp(base, model, query, docs)
        except httpx.HTTPError:
            # service may have died between calls; restart once and retry
            _terminate_lcpp()
            await ensure_llamacpp_service(ep)
            return await _rerank_llamacpp(base, model, query, docs)
    semaphore = asyncio.Semaphore(4)

    async def one(d: Mapping[str, Any]) -> Dict[str, Any]:
        async with semaphore:
            return await _rerank_one_ollama(ep, model, query, d)

    return list(await asyncio.gather(*(one(d) for d in docs)))
