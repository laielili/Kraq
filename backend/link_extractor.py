#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
链接内容提取器（内嵌版本）
返回结构化内容供后端直接入库，不写入 .md 文件。
HTML 走 trafilatura + lxml；其余格式交给 document_converter（markitdown）。
"""
import argparse, json, re, sys, subprocess, urllib.request, urllib.error
from typing import Callable, Optional, Dict, Any, List, Tuple
from urllib.parse import urlparse

# 复用 trafilatura、lxml 等依赖（已在 requirements.txt 中）
import trafilatura
from lxml import html as lh

from .common import CancelledError, decode_bytes
from .document_converter import convert_bytes

# ============================================================
# 通用工具
# ============================================================

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

HDRS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
}

# 进度回调 (stage, percent, 人类可读子状态) -> None；取消查询 -> bool。
# 由 task_queue 传线程安全的实现进来，本模块只决定"何时报、报什么"，不管落盘。
OnProgress = Optional[Callable[[str, int, str], None]]
ShouldCancel = Optional[Callable[[], bool]]


def _report(on_progress: OnProgress, stage: str, pct: int, detail: str) -> None:
    if on_progress is not None:
        on_progress(stage, pct, detail)


def _alive(should_cancel: ShouldCancel) -> None:
    if should_cancel is not None and should_cancel():
        raise CancelledError()


def _host_of(url: str) -> str:
    return urlparse(url).netloc or url[:40]


def _size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1048576:.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


def _force_utf8():
    """Windows 子进程 stdout 默认 GBK，强制 UTF-8"""
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if sys.stderr.encoding and sys.stderr.encoding.lower() not in ("utf-8", "utf8"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


_force_utf8()


# ============================================================
# 资源抓取（返回 bytes + content-type，由调用方决定解码方式）
# ============================================================

# ============================================================
# 粘贴文本 → 可抓取的 URL
# ============================================================

_URL_RE = re.compile(r"https?://[^\s<>\"'，。；、】）]+", re.I)

# 已知平台的域名特征：分享文案里常混着假链接（例：开头就是 `https://75`），
# 所以优先挑"命中平台域名"的那一条，其次挑域名里有点的，最后才退回第一条。
_PLATFORM_HOSTS = (
    r"xiaohongshu\.com|xhslink\.(?:cn|com)",
    r"douyin\.com|iesdouyin\.com",
    r"bilibili\.com|b23\.tv",
    r"youtube\.com|youtu\.be",
)


def normalize_clip_url(raw: str) -> str:
    """从任意粘贴文本里取出一条真正能抓的 URL。

    用户粘的往往是 App 的分享文案（`https://75 【标题】 😆 短码 😆 https://…`），
    直接当 URL 用会 DNS 失败；反过来"没 scheme 就补 https://"对这种串也是错的。
    """
    text = (raw or "").strip()
    if not text:
        raise RuntimeError("没有可识别的链接")
    cands = [c.rstrip(".,;:!)）]》>'\"") for c in _URL_RE.findall(text)]
    if not cands:
        bare = text.split()[0]
        host = urlparse(f"https://{bare}").netloc
        if len(text.split()) == 1 and "." in host and not host.rstrip(".").isdigit():
            return f"https://{bare}"
        raise RuntimeError("粘贴的内容里没找到 http(s) 链接")
    platform_hit = next((u for u in cands if any(re.search(p, u, re.I) for p in _PLATFORM_HOSTS)), "")
    dotted = next((u for u in cands if "." in urlparse(u).netloc
                   and not urlparse(u).netloc.rstrip(".").isdigit()), "")
    return platform_hit or dotted or cands[0]


def fetch_with_ua(url: str, headers: Dict[str, str], timeout: int = 30) -> Tuple[bytes, str]:
    """按调用方给的 headers 抓一次，原样抛出 HTTPError（平台提取器要自己配文案）。"""
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get_content_type()


def fetch_resource(url: str, cookies_file: Optional[str] = None,
                   on_progress: OnProgress = None,
                   should_cancel: ShouldCancel = None) -> Tuple[bytes, str]:
    """抓取资源；cookies_file 存在时用 curl（带登录态）。"""
    _alive(should_cancel)
    _report(on_progress, "fetching", 10, f"正在请求 {_host_of(url)}")
    if cookies_file:
        cmd = ["curl", "-s", "-L", "-A", UA, "--cookie", cookies_file, url]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode == 0 and r.stdout:
            # curl 这条路拿不到响应头，content-type 留空由调用方按 URL 后缀嗅探
            return r.stdout, ""
    req = urllib.request.Request(url, headers=HDRS)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read(), r.headers.get_content_type()
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"网页访问失败（HTTP {e.code}）：该站点可能反爬或需登录。"
            "如浏览器可正常打开，可先在浏览器登录该站点后重试，"
            "或复制正文内容手动保存。", e.code) from e


def try_with_cookies(url: str, browser: str = "chrome",
                     on_progress: OnProgress = None) -> Tuple[bytes, str]:
    """403/反爬时：使用 browser_cookie3 提取浏览器 cookie 后重抓（知乎/CSDN/小红书/抖音 等登录态站点）"""
    try:
        import browser_cookie3
    except ImportError:
        raise RuntimeError("网页访问失败：需登录或反爬，缺少 browser_cookie3 库（pip install browser-cookie3）")

    domain = urlparse(url).netloc.split(":")[0]
    _report(on_progress, "fetching", 16, f"反爬拦截 · 改用 {browser} 登录态重试")

    # 提取该域名的 cookie
    try:
        if browser == "chrome":
            cj = browser_cookie3.chrome(domain_name=domain)
        elif browser == "edge":
            cj = browser_cookie3.edge(domain_name=domain)
        elif browser == "firefox":
            cj = browser_cookie3.firefox(domain_name=domain)
        elif browser == "safari":
            cj = browser_cookie3.safari(domain_name=domain)
        else:
            cj = browser_cookie3.chrome(domain_name=domain)
    except Exception as e:
        raise RuntimeError(f"提取浏览器 cookie 失败（{browser}）：{e}。请确认浏览器已完全关闭且已登录该站点。")
    
    # 构建 cookie 字符串供 urllib 使用
    cookie_header = "; ".join(f"{cookie.name}={cookie.value}" for cookie in cj)
    if not cookie_header:
        raise RuntimeError(f"未找到 {domain} 的 cookie（请确认已在 {browser} 登录对应网站）")
    
    # 使用 cookie 重新抓取
    req = urllib.request.Request(url, headers={**HDRS, "Cookie": cookie_header})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
            mimetype = r.headers.get_content_type()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"使用 cookie 访问仍失败（HTTP {e.code}）：{e}") from e

    _report(on_progress, "fetching", 18, f"已用浏览器登录态抓取（{domain}）")
    return body, mimetype


# ============================================================
# 解码与类型判定
# ============================================================

_DOC_SUFFIXES = {
    "pdf", "docx", "pptx", "xlsx", "xls", "epub", "csv", "json", "xml", "zip", "mhtml",
}


def _extension_from_url(url: str) -> str:
    """URL path 后缀（小写、无点）；无后缀返回空串"""
    path = urlparse(url).path
    if "." not in path.rsplit("/", 1)[-1]:
        return ""
    return path.rsplit(".", 1)[-1].lower()


def _is_html(body: bytes, url: str, mimetype: str) -> bool:
    """是否走 trafilatura 网页链。

    优先级：响应 content-type → URL 后缀 → 内容起始片段。
    content-type 缺失或为 octet-stream 时必须能判定，否则 PDF 直链会被当 HTML
    解码（实测：走 trafilatura 会得到误导性的“JS 渲染或需登录”报错）。
    """
    base = (mimetype or "").split(";")[0].strip().lower()
    if base in ("text/html", "application/xhtml+xml"):
        return True
    if base and base != "application/octet-stream":
        return False
    ext = _extension_from_url(url)
    if ext in ("html", "htm"):
        return True
    if ext in _DOC_SUFFIXES:
        return False
    return body[:256].lstrip().lower().startswith((b"<html", b"<!doctype"))


# ============================================================
# 正文提取（复用 web_clip.py 逻辑）
# ============================================================

def extract_article_blocks(html: str) -> List[Tuple[str, str]]:
    """按文档顺序提取 [("text", 段落) | ("img", url)] 列表（图文交错）"""
    root = lh.fromstring(html)
    # 正文容器优先级：CSDN/微信/通用
    container = None
    for xpath in (
        '//div[@id="content_views"]',
        '//div[@id="js_content"]',
        '//div[contains(@class,"article-content")]',
        '//article',
        '//main',
        '//div[@class="rich_media_content"]',
    ):
        nodes = root.xpath(xpath)
        if nodes:
            container = nodes[0]
            break
    if container is None:
        container = root

    blocks: List[Tuple[str, str]] = []
    skip_tags = {"script", "style", "nav", "aside", "header", "footer", "button"}
    for el in container.iter():
        tag = el.tag if isinstance(el.tag, str) else ""
        if tag in skip_tags:
            continue
        if tag == "img":
            src = el.get("src") or el.get("data-src") or ""
            if src.startswith("//"):
                src = "https:" + src
            if src.startswith("http"):
                blocks.append(("img", src))
            continue
        if tag in ("p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "blockquote", "td", "th"):
            text = (el.text_content() or "").strip()
            text = re.sub(r"\s+", " ", text)
            if text:
                # 去重：嵌套 p/li 导致父元素重复收集同一文本
                if blocks and blocks[-1] == ("text", text):
                    continue
                blocks.append(("text", text))
    return blocks


def extract_with_trafilatura(html: str, url: str) -> Dict[str, Any]:
    """使用 trafilatura 提取元数据和正文"""
    meta = trafilatura.extract_metadata(html, default_url=url)
    title = (getattr(meta, "title", None) or "网页笔记").strip()
    author = getattr(meta, "author", None) or ""
    date = getattr(meta, "date", None) or ""
    # 降级提取正文
    text = trafilatura.extract(html, include_comments=False, include_tables=True, no_fallback=False)
    return {
        "title": title,
        "author": author,
        "date": date,
        "text": text or "",
    }


# ============================================================
# 图片下载（可选，简化版：仅返回 URL 列表，不下载）
# ============================================================

def collect_image_urls(blocks: List[Tuple[str, str]]) -> List[str]:
    """从 blocks 中收集图片 URL"""
    return [url for kind, url in blocks if kind == "img"]


# ============================================================
# 主提取函数
# ============================================================

def _fetch_with_fallback(url: str, on_progress: OnProgress = None,
                         should_cancel: ShouldCancel = None) -> Tuple[bytes, str]:
    """抓取，仅反爬类错误（401/403/429）走浏览器登录态兜底。"""
    try:
        return fetch_resource(url, None, on_progress, should_cancel)
    except RuntimeError as e:
        # e.args[1] 是 HTTPError 的状态码，判定约定不可改，否则兜底静默失效
        if len(e.args) > 1 and e.args[1] in (401, 403, 429):
            return try_with_cookies(url, browser="chrome", on_progress=on_progress)
        raise


def extract_html_article(body: bytes, url: str,
                         on_progress: OnProgress = None,
                         should_cancel: ShouldCancel = None) -> Dict[str, Any]:
    """
    提取网页文章内容（trafilatura 正文 + lxml 图文块）。
    返回：{"title", "content", "author", "date", "images", "source_url", "platform", "format"}
    """
    _alive(should_cancel)
    _report(on_progress, "parsing", 35, "正在解析正文…")
    html = decode_bytes(body)

    # 1. trafilatura 提取元数据 + 正文
    trafilatura_result = extract_with_trafilatura(html, url)
    title = trafilatura_result["title"]
    author = trafilatura_result["author"]
    date = trafilatura_result["date"]
    trafilatura_text = trafilatura_result["text"]

    # 2. lxml 提取图文块（用于获取图片 URL 和更精确的结构）
    blocks = extract_article_blocks(html)
    image_urls = collect_image_urls(blocks)

    # 3. 组装正文：优先用 trafilatura 正文，如果为空则用 lxml blocks 的文本
    if trafilatura_text and len(trafilatura_text) > 50:
        content = trafilatura_text
    else:
        text_blocks = [b[1] for b in blocks if b[0] == "text"]
        content = "\n\n".join(text_blocks)

    if not content or len(content) < 20:
        # 最后降级：og:description
        m = re.search(r'<meta property="og:description" content="([^"]+)"', html)
        if m:
            content = m.group(1).replace("\\x0a", "\n").replace("\\u003c", "<")
        else:
            raise RuntimeError(f"正文提取失败（{url}）：页面可能是 JS 渲染或需登录")

    _report(on_progress, "parsing", 45, f"正文 {len(content)} 字 · 图 {len(image_urls)} 张")

    return {
        "title": title,
        "content": content,
        "author": author,
        "date": date,
        "images": image_urls,
        "source_url": url,
        "platform": "web",
        "format": "html",
    }


def extract_document(body: bytes, url: str, mimetype: str,
                     on_progress: OnProgress = None,
                     should_cancel: ShouldCancel = None) -> Dict[str, Any]:
    """非 HTML 资源（PDF / Office / EPUB / CSV…）→ Markdown 笔记。"""
    ext = _extension_from_url(url)
    _alive(should_cancel)
    _report(on_progress, "parsing", 35, f"正在转换格式（{ext or mimetype or '嗅探中'}）")
    converted = convert_bytes(
        body,
        extension=f".{ext}" if ext else None,
        mimetype=mimetype or None,
        filename=urlparse(url).path.rsplit("/", 1)[-1] or None,
    )
    content = converted["markdown"]
    title = converted["title"] or (urlparse(url).path.rsplit("/", 1)[-1] or url[:50])
    _report(on_progress, "parsing", 45, f"正文 {len(content)} 字 · 图 {len(converted['images'])} 张")
    return {
        "title": title,
        "content": content,
        "author": "",
        "date": "",
        "images": converted["images"],
        "source_url": url,
        "platform": "web",
        "format": ext or (mimetype.split("/")[-1] if mimetype else "unknown"),
    }


# ============================================================
# 平台识别（复用 clip.py 逻辑）
# ============================================================

def detect_platform(url: str) -> str:
    """URL → 平台标识"""
    if re.search(r"xhslink\.cn|xiaohongshu\.com", url):
        return "xiaohongshu"
    if re.search(r"douyin\.com", url):
        return "douyin"
    if re.search(r"bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}", url):
        return "bilibili"
    if re.search(r"youtube\.com|youtu\.be", url):
        return "youtube"
    return "web"


# ============================================================
# 统一入口
# ============================================================

def extract_content(url: str, on_progress: OnProgress = None,
                    should_cancel: ShouldCancel = None) -> Dict[str, Any]:
    """
    统一提取入口：归一化链接 → 校验协议 → 平台提取器 → 网页兜底。
    on_progress / should_cancel 由异步队列传入；同步端点可不传。
    """
    url = normalize_clip_url(url)
    # 单一收口：同步 /api/link-clip 与异步 task_queue 都经过这里。
    # urllib 支持 file://，不挡掉的话这条接口能读宿主机任意文本文件，
    # 内容还会进知识库并进入 LLM 上下文。校验对象是归一化**之后**的串——
    # 分享文案开头那种 `https://75` 也能过 netloc 非空，必须在解析后才能拦住。
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise RuntimeError("仅支持 http/https 链接")
    host = parsed.hostname or ""
    if "." not in host and host not in ("localhost", "127.0.0.1", "::1"):
        # 单标签主机名解析不到公网（分享文案里的 `https://75` 就是这么来的）；
        # 放过 localhost/回环，本地自托管的模型端点要用
        raise RuntimeError(f"链接的主机名无法解析：{host or url}")

    # 惰性 import：extractors 反过来要用本模块的抓取 helper，顶层互相 import 会成环
    from .extractors import KNOWN_UNSUPPORTED, find_extractor

    extractor = find_extractor(url)
    if extractor is not None:
        return extractor(url, on_progress, should_cancel)

    plat = detect_platform(url)
    if plat in KNOWN_UNSUPPORTED:
        # 以前这里返回一段占位文本并照常切块入库 —— 那段"（该平台提取器待接入）"
        # 会进向量、会被检索命中当成答案来源。现在一律失败，不污染档案柜。
        raise RuntimeError(f"{KNOWN_UNSUPPORTED[plat]}（未存入档案）")

    body, mimetype = _fetch_with_fallback(url, on_progress, should_cancel)
    _report(on_progress, "fetching", 22, f"已收到 {_size(len(body))}")
    if _is_html(body, url, mimetype):
        return extract_html_article(body, url, on_progress, should_cancel)
    return extract_document(body, url, mimetype, on_progress, should_cancel)


# ============================================================
# CLI 测试
# ============================================================

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="要提取的链接")
    args = ap.parse_args()
    result = extract_content(args.url)
    print(json.dumps(result, ensure_ascii=False, indent=2))