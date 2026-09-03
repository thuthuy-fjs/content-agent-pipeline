#!/usr/bin/env python3
"""Điểm vào: python run.py --topic "..." """

import sys

# Console Windows mặc định dùng codepage cp1252, không encode được tiếng Việt/emoji —
# crash đúng lúc pipeline cố in JSON gốc ra để cứu dữ liệu khi Notion lỗi.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

from content_agent.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
