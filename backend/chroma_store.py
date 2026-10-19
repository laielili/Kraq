"""Chroma vector store — the ONLY vector storage (kb.json never holds embeddings).

PersistentClient under data/chroma; one collection per knowledge base.
Collection naming: sanitized ASCII from kbId (Chroma allows [a-zA-Z0-9._-],
3-512 chars, must start/end alphanumeric). The raw kbId lives in collection
metadata["kbId"] so callers can map back.

kb.json keeps title/content/createdAt/embeddingMeta; Chroma stores only the
doc vector, addressed by doc id. query() returns cosine similarity scores as
score = 1 - distance (hnsw:space cosine).
"""

from __future__ import annotations

import re
import threading
from typing import Any, Dict, List, Optional, Sequence

import chromadb
from chromadb.config import Settings as ChromaSettings

from .common import DATA_DIR

PERSIST_DIR = DATA_DIR / "chroma"
_SPACE = "cosine"
_MAX_COMPLETE_BATCH = 5000

_client: Optional["chromadb.api.ClientAPI"] = None
_client_lock = threading.Lock()


def _get_client():
    global _client
    with _client_lock:
        if _client is None:
            PERSIST_DIR.mkdir(parents=True, exist_ok=True)
            _client = chromadb.PersistentClient(
                path=str(PERSIST_DIR),
                settings=ChromaSettings(anonymized_telemetry=False, allow_reset=True),
            )
        return _client


def sanitize_collection_name(kb_id: str) -> str:
    """kbId -> valid Chroma collection name (ASCII [a-zA-Z0-9._-])."""
    raw = str(kb_id or "").strip() or "default"
    ascii_part = raw.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "-", ascii_part).strip(".-_")
    if not cleaned:
        cleaned = "kb"
    body = re.sub(r"-+", "-", cleaned).strip("-_") or "kb"
    if not re.match(r"[A-Za-z0-9]", body[0]):
        body = "kb-" + body
    if not re.match(r"[A-Za-z0-9]", body[-1]):
        body = body + "-kb"
    name = body[:200]
    while len(name) < 3:
        name = name + "-kb"
    return name[:512]


def _get_collection(kb_id: str, create: bool = True):
    client = _get_client()
    name = sanitize_collection_name(kb_id)
    if create:
        return client.get_or_create_collection(
            name=name, metadata={"hnsw:space": _SPACE, "kbId": str(kb_id)}
        )
    try:
        return client.get_collection(name=name)
    except Exception:
        return None


def upsert(
    kb_id: str,
    ids: Sequence[str],
    embeddings: Sequence[Sequence[float]],
) -> int:
    """Upsert doc vectors into kb's collection. Idempotent per doc id."""
    pairs = [(str(i), e) for i, e in zip(ids, embeddings) if i and e]
    if not pairs:
        return 0
    col = _get_collection(kb_id)
    # metadata keeps creation idempotent (on-dim mismatch handled by caller's
    # full re-sync); Chroma cannot itself mix dims in one collection.
    ids_out = [p[0] for p in pairs]
    embs = [list(map(float, p[1])) for p in pairs]
    for start in range(0, len(ids_out), _MAX_COMPLETE_BATCH):
        batch_ids = ids_out[start : start + _MAX_COMPLETE_BATCH]
        batch_embs = embs[start : start + _MAX_COMPLETE_BATCH]
        col.upsert(ids=batch_ids, embeddings=batch_embs)
    return len(ids_out)


def delete(kb_id: str, ids: Sequence[str]) -> int:
    ids = [str(i) for i in ids if i]
    if not ids:
        return 0
    col = _get_collection(kb_id)
    if col is None:
        return 0
    col.delete(ids=ids)
    return len(ids)


def query(
    kb_id: str,
    query_embedding: Sequence[float],
    top_n: int,
) -> List[Dict[str, Any]]:
    """Top-N {id, score} by cosine; score = 1 - distance in [ -1, 1 ]."""
    col = _get_collection(kb_id, create=False)
    if col is None or col.count() == 0:
        return []
    if top_n <= 0:
        return []
    result = col.query(
        query_embeddings=[list(map(float, query_embedding))],
        n_results=min(int(top_n), max(col.count(), 1)),
        include=["distances"],
    )
    out: List[Dict[str, Any]] = []
    ids = (result.get("ids") or [[]])[0]
    dists = (result.get("distances") or [[]])[0]
    for i, distance in zip(ids, dists):
        try:
            score = 1.0 - float(distance)
        except (TypeError, ValueError):
            continue
        out.append({"id": str(i), "score": score})
    return out






def drop_collection(kb_id: str) -> bool:
    """Delete this kb's collection entirely (used when deleting a kb)."""
    name = sanitize_collection_name(kb_id)
    client = _get_client()
    try:
        client.delete_collection(name)
        return True
    except Exception:
        return False




