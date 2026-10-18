"""小红书图文笔记提取器。

零依赖做法（与参考实现 obsidian-zerocloud-notes/python/xhs_clip.py 同源）：
移动端 UA 直接 GET 分享页 → 页面里 `window.__INITIAL_STATE__` 是服务端注水的笔记数据
→ 取 `noteData.data.noteData`。不需要 cookie，也不需要 `x-s`/`x-t` 签名头
（分享链接自带的 `xsec_token` 就是准入凭证）。

反过来也说明两件事：带 token 的**完整分享链接**是必需的（从浏览器地址栏抠出来的
裸 /explore/<id> 会被风控）；站点一改版这条路就断，所以失败文案要指向
"回 App 重新复制链接"，而不是含糊的"提取失败"。
"""
from __future__ import annotations

import re
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

from ..common import CancelledError, decode_bytes, json_object_after
from ..link_extractor import _alive, _host_of, _report, fetch_with_ua

MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")

MATCHERS = [r"xiaohongshu\.com", r"xhslink\.cn", r"xhslink\.com"]

_NOTE_ID_RE = re.compile(r"/(?:explore|discovery/item)/([0-9a-f]{16,})")


def _resolve_note_url(url: str, headers: Dict[str, str]) -> str:
    """分享链接里已带笔记 id 就直接用；短链（xhslink）靠 302 展开后取最终地址。"""
    if _NOTE_ID_RE.search(url):
        return url
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        final = r.geturl()
    if not _NOTE_ID_RE.search(final):
        raise RuntimeError(
            "小红书短链展开后不是笔记页（缺 /explore/ 或 /discovery/item/ 段），"
            "请在小红书 App 里用「复制链接」重新粘贴"
        )
    return final


def _pick_image_url(img: Dict[str, Any]) -> str:
    for key in ("urlDefault", "url"):
        u = img.get(key) or ""
        if u:
            break
    info = (img.get("infoList") or [{}])[0].get("url") or ""
    u = info or u
    return "https:" + u if u.startswith("//") else u


def _note_title(note: Dict[str, Any]) -> str:
    title = (note.get("title") or "").strip()
    if title:
        return title[:60]
    desc = _clean_desc(note.get("desc") or "")
    first = re.split(r"[。！？!?\n]", desc)[0].strip()
    return (first or desc[:40])[:60] or "小红书笔记"


def _clean_desc(desc: str) -> str:
    desc = re.sub(r"#[^#\s]+\[话题\]#", "", desc or "")
    desc = re.sub(r"@[^\s#]+", "", desc)
    return re.sub(r"\n{3,}", "\n\n", desc).strip()


def extract(url: str,
            on_progress: Optional[Callable[[str, int, str], None]] = None,
            should_cancel: Optional[Callable[[], bool]] = None) -> Dict[str, Any]:
    headers = {
        "User-Agent": MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    _alive(should_cancel)
    _report(on_progress, "fetching", 10, f"正在请求 {_host_of(url)}（小红书图文）")
    try:
        note_url = _resolve_note_url(url, headers)
        body, _mimetype = fetch_with_ua(note_url, headers)
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"小红书页面访问失败（HTTP {e.code}）：链接多半已过期或缺 xsec_token，"
            "请在 App 里重新「复制链接」再粘贴"
        ) from e
    _report(on_progress, "fetching", 22, "已收到笔记页")

    _alive(should_cancel)
    _report(on_progress, "parsing", 35, "正在读取笔记数据…")
    html = decode_bytes(body)
    state = json_object_after(html, "window.__INITIAL_STATE__")
    note = ((((state or {}).get("noteData") or {}).get("data") or {}).get("noteData")) or {}
    if not note:
        raise RuntimeError(
            "没取到笔记正文：页面可能已被风控或小红书改版（缺 __INITIAL_STATE__.noteData），"
            "未存入档案"
        )

    kind = note.get("type")
    if kind and kind != "normal":
        raise RuntimeError(
            f"小红书「{kind}」类型笔记需要音视频下载与转写能力，本轮未实现（未存入档案）"
        )

    title = _note_title(note)
    desc = _clean_desc(note.get("desc") or "")
    if not desc:
        raise RuntimeError("这条小红书笔记没有文字正文（纯图笔记），本轮未做图片 OCR（未存入档案）")
    tags = [t.get("name") for t in (note.get("tagList") or []) if t.get("name")]
    user = note.get("user") or {}
    nickname = user.get("nickname") or user.get("nickName") or ""
    interact = note.get("interactInfo") or {}
    images = [u for u in (_pick_image_url(i) for i in (note.get("imageList") or [])) if u]

    lines = [f"# {title}", ""]
    meta = " · ".join(x for x in (
        "小红书",
        nickname and f"@{nickname}",
        interact.get("likedCount") and f"❤️{interact['likedCount']}",
        interact.get("collectedCount") and f"⭐{interact['collectedCount']}",
        interact.get("commentCount") and f"💬{interact['commentCount']}",
    ) if x)
    lines += [f"> {meta}", "", desc, ""]
    if tags:
        lines += ["标签：" + " ".join(f"#{t}" for t in tags), ""]
    if images:
        lines += ["图片："] + [f"- {u}" for u in images] + [""]
    lines.append(f"原文：{note_url}")
    content = "\n".join(lines)

    _report(on_progress, "parsing", 45, f"正文 {len(desc)} 字 · 图 {len(images)} 张")
    return {
        "title": title,
        "content": content,
        "author": nickname,
        "date": "",
        "images": images,
        "source_url": note_url,
        "platform": "xiaohongshu",
        "format": "note",
    }
