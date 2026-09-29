"""Managed secrets for endpoint API keys, stored in the project-root .env.

Contract (user-facing): the config dialog always takes PLAINTEXT keys. The
backend persists the plaintext ONLY here (gitignored .env) and stores an
`env:VAR` reference in config.json; requests resolve the reference at call
time (models_client.resolve_api_key). Variables are named DATAAGENT_KEY_<n>
and garbage-collected when no endpoint references them anymore.

Values are deduplicated: saving the same plaintext twice reuses one variable.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Dict, Set

from .dotenv import load_env_file

_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
_PREFIX = "DATAAGENT_KEY_"

_LOCK = threading.Lock()
# in-memory mirror; refreshed from disk on first use and after every write
_vars: Dict[str, str] | None = None


def _read_vars() -> Dict[str, str]:
    global _vars
    if _vars is None:
        load_env_file()  # populates os.environ (respecting real env precedence)
        _vars = {
            k: v
            for k, v in os.environ.items()
            if k.startswith(_PREFIX) and v != ""
        }
    return _vars


def _write_vars(vars: Dict[str, str]) -> None:
    """Atomically rewrite .env with the managed vars plus a header comment.

    Real environment variables are NOT written here (they are not file-backed);
    only DATAAGENT_KEY_* entries are managed.
    """
    lines = [
        "# DataAgent endpoint API keys (auto-managed by the backend).",
        "# This file is gitignored; config.json only holds env:DATAAGENT_KEY_* references.",
        "",
    ]
    lines.extend(f"{k}={v}" for k, v in sorted(vars.items()))
    tmp = Path(str(_ENV_FILE) + ".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(str(tmp), str(_ENV_FILE))
    # make values visible to resolve_api_key in this process
    for k, v in vars.items():
        os.environ[k] = v


def _next_name(vars: Dict[str, str]) -> str:
    n = 1
    while f"{_PREFIX}{n}" in vars:
        n += 1
    return f"{_PREFIX}{n}"


def store_secret(plain: str) -> str:
    """Persist a plaintext key; returns its `env:VAR` reference."""
    plain = (plain or "").strip()
    if not plain:
        return ""
    with _LOCK:
        vars = _read_vars()
        for name, value in vars.items():
            if value == plain:
                return f"env:{name}"
        name = _next_name(vars)
        vars[name] = plain
        _write_vars(vars)
        return f"env:{name}"


def gc_secrets(referenced: Set[str]) -> None:
    """Remove DATAAGENT_KEY_* vars no endpoint references anymore."""
    with _LOCK:
        vars = _read_vars()
        keep = {
            k: v
            for k, v in vars.items()
            if f"env:{k}" in referenced
        }
        if len(keep) != len(vars):
            _write_vars(keep)
