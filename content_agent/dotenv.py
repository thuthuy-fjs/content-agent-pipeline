"""Nạp biến môi trường từ file .env (không cần thư viện ngoài)."""

from __future__ import annotations

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load_env(path: Path = ENV_FILE) -> None:
    """Đọc .env và đặt các biến chưa có trong môi trường.

    Biến đã export sẵn luôn thắng file, để `ANTHROPIC_API_KEY=... run.py` vẫn đè được.
    """
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value
