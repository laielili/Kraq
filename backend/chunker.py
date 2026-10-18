"""Chunker: header/paragraph-aware text splitting for /api/kb/upload.

Rules (from the brief):
- cut big sections at markdown headings (^#{1,6}), then split on blank lines
  into natural paragraphs;
- pack paragraphs in order, a block holds up to maxChars; a paragraph that
  would overflow starts a new block;
- a single paragraph longer than maxChars is hard-cut by characters, with
  `overlap` characters carried between neighbouring pieces;
- consecutive blank lines never produce empty blocks; the final leftover that
  is much smaller than a block merges into the previous block when it still
  fits within maxChars;
- rejoining always restores separators (blank line between paragraphs, newline
  between lines) — a markdown heading only stays a heading if it still starts
  its own line after packing.

Returns [{'text': str, 'length': int}, ...] in document order.
"""

from __future__ import annotations

import re
from typing import Dict, List

_HEADING_RE = re.compile(r"^#{1,6}")

# A tail shorter than this fraction of maxChars merges into the previous block
# instead of standing alone (unless that would exceed maxChars).
_MERGE_FRACTION = 0.25


def chunk_text(text: str, max_chars: int, overlap: int) -> List[Dict[str, object]]:
    max_chars = max(int(max_chars), 1)
    overlap = max(int(overlap), 0)
    if overlap >= max_chars:
        overlap = max_chars - 1

    blocks: List[Dict[str, object]] = []
    current: List[str] = []  # paragraphs accumulated into the current block

    for section in _iter_sections(text):
        for para in _split_paragraphs(section):
            para = para.strip("\n")  # section joins leave stray blank lines
            if not para.strip():
                continue
            if len(para) > max_chars:
                # flush everything before the oversized paragraph
                if current:
                    blocks.append({"text": "\n\n".join(current), "hardCut": False})
                    current = []
                pieces_and_flags = _hard_split(para, max_chars, overlap)
                for i, p in enumerate(pieces_and_flags):
                    if i == len(pieces_and_flags) - 1:
                        # last piece keeps accumulating room for further paragraphs
                        current = [p]
                    else:
                        blocks.append({"text": p, "hardCut": i > 0 or bool(current)})
                continue
            joined_len = (
                sum(len(p) for p in current)
                + len(para)
                + (2 * len(current) if current else 0)
            )
            if current and joined_len <= max_chars:
                current.append(para)
            elif not current:
                current = [para]
            else:
                blocks.append({"text": "\n\n".join(current), "hardCut": False})
                current = [para]
        # section boundary: keep the current block open across sections unless
        # it is already over the limit — blocks pack paragraphs in order.

    if current:
        blocks.append({"text": "\n\n".join(current), "hardCut": False})

    # merge a small final tail into the previous block when it fits
    merged: List[Dict[str, object]] = []
    for idx, b in enumerate(blocks):
        txt = str(b["text"])
        if (
            merged
            and idx == len(blocks) - 1
            and len(txt) < int(max_chars * _MERGE_FRACTION)
            and len(str(merged[-1]["text"])) + 2 + len(txt) <= max_chars
        ):
            merged[-1] = {"text": str(merged[-1]["text"]) + "\n\n" + txt, "hardCut": False}
        else:
            merged.append(b)

    return [
        {"text": b["text"], "length": len(str(b["text"]))}
        for b in merged
        if str(b["text"]).strip()
    ]


def _hard_split(para: str, max_chars: int, overlap: int) -> List[str]:
    """Hard-cut by characters with `overlap` carried between pieces."""
    pieces: List[str] = []
    step = max_chars - overlap
    if step <= 0:
        step = max_chars
    start = 0
    n = len(para)
    while start < n:
        end = start + max_chars
        if end >= n:
            pieces.append(para[start:])
            break
        pieces.append(para[start:end])
        start += step
    return pieces or [para]


def _iter_sections(text: str):
    """Yield sections split at markdown heading lines (^#{1,6})."""
    lines = text.split("\n")
    if not lines:
        return
    section: List[str] = [lines[0]]
    for line in lines[1:]:
        if _HEADING_RE.match(line.strip()):
            yield "\n".join(section)
            section = [line]
        else:
            section.append(line)
    if section:
        yield "\n".join(section)


def _split_paragraphs(section: str) -> List[str]:
    return [p for p in re.split(r"\n\s*\n", section) if p.strip()]


# Example (kept for manual sanity checks):
#   chunk_text("a\n\nb", 600, 50)  -> 1 block  "a\n\nb"
#   chunk_text("X" * 1500, 600, 50)-> [600, 550, 350] via overlap stepping
