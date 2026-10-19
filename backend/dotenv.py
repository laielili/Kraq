#!/usr/bin/env python3
"""Load the project-root .env into os.environ (no dotenv dependency).

Runs at backend import time, before any endpoint request is built. Existing
environment variables win over .env entries (standard dotenv precedence);
parse tolerates quotes, `export ` prefixes, blank lines and # comments.
"""

from __future__ import annotations

import os
from pathlib import Path

_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def load_env_file() -> int:
    """Populate os.environ from .env; returns the number of applied entries."""
    try:
        text = _ENV_FILE.read_text(encoding="utf-8")
    except OSError:
        return 0
    applied = 0
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        if not key:
            continue
        value = _strip_quotes(value)
        if os.environ.get(key) is None:
            os.environ[key] = value
            applied += 1
    return applied


load_env_file()
