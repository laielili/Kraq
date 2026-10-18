"""平台提取器注册表。

契约（每个平台模块都要满足）：
    MATCHERS: 命中该平台域名的正则（字符串，交给 re.search）
    extract(url, on_progress, should_cancel) -> dict
      返回体字段与网页分支一致：title/content/author/date/images/source_url/platform/format
      —— 下游的切块、入库、进度展示因此不需要知道平台差异。
      抓不到就抛 RuntimeError，**绝不返回占位文本**（占位会被切块入库、
      进向量、被检索命中当答案源，见 plan/link-clip-platforms.md §2.2）。

加平台 = 加一个文件 + 在 REGISTRY 里登记一行；分派顺序即优先级，
web 分支不在这里注册，它是 link_extractor 的最后兜底。
"""
from __future__ import annotations

import re
from typing import Callable, Dict, List, Optional

from . import xiaohongshu

Extractor = Callable[[str, Optional[Callable[[str, int, str], None]], Optional[Callable[[], bool]]], Dict]

# 平台 → 还缺什么才能接入。命中这里就直接失败并说明原因，不去做无谓的通用抓取
# （这些站点的 og 标签也是空的，通用链路只会给出误导性的"JS 渲染或需登录"）。
KNOWN_UNSUPPORTED: Dict[str, str] = {
    "douyin": "抖音需要复用浏览器登录 cookie（会触发系统钥匙串/凭据弹窗），本轮未接入",
    "bilibili": "B站视频需要 yt-dlp 下载 + 字幕转写，本轮未接入（图文 /opus/ 属下一轮）",
    "youtube": "YouTube 需要 yt-dlp 下载 + 字幕转写，本轮未接入",
}

REGISTRY: List[tuple[List[str], Extractor]] = [
    (xiaohongshu.MATCHERS, xiaohongshu.extract),
]


def find_extractor(url: str):
    for patterns, fn in REGISTRY:
        if any(re.search(p, url) for p in patterns):
            return fn
    return None
