#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""链接转存探针：只跑到"提取"，不切块、不入库、不写任何运行时文件。

用途：平台提取本质是蹭对方页面的 SSR 数据，站点一改版就断。出问题时先用它判断
"是链路死了，还是任务队列/入库环节死了"。

    python scripts/probe_clip.py "整段小红书分享文案或链接"
    python scripts/probe_clip.py <url> --json      # 机器可读输出
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Windows 控制台默认 GBK，中文正文与 ▶/· 会 UnicodeEncodeError
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf-8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from backend.link_extractor import extract_content, normalize_clip_url  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="链接，或直接从 App 复制的整段分享文案")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--chars", type=int, default=400, help="正文预览字符数")
    args = ap.parse_args()

    try:
        url = normalize_clip_url(args.url)
        print(f"归一化 → {url}")
        result = extract_content(url)
    except Exception as e:
        print(f"✗ 提取失败：{type(e).__name__}: {e}")
        return 1

    content = result.get("content") or ""
    if args.json:
        print(json.dumps({**result, "content": content[: args.chars]}, ensure_ascii=False, indent=2))
    else:
        print(f"平台 {result.get('platform')} · 格式 {result.get('format')} · "
              f"{len(content)} 字 · 图 {len(result.get('images') or [])} 张")
        print(f"标题：{result.get('title')}")
        print(f"作者：{result.get('author') or '—'}")
        print("—— 正文预览 ——")
        print(content[: args.chars])
    # 探针只读：到这里结束，不调用 chunk_text / add_docs_batch，档案柜与 tasks.json 不变
    return 0


if __name__ == "__main__":
    sys.exit(main())
