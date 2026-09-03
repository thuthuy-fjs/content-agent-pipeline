"""Client giả lập cho --dry-run: chạy hết pipeline không gọi API, không tốn tiền.

Sinh dữ liệu bám đúng JSON Schema được gửi lên, nên nó kiểm tra được cả phần
schema lẫn phần ghép file — chỉ nội dung là vô nghĩa.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any


def _sample_for(schema: dict, key: str = "") -> Any:
    kind = schema.get("type")
    if "enum" in schema:
        return schema["enum"][0]
    if kind == "object":
        return {k: _sample_for(v, k) for k, v in schema.get("properties", {}).items()}
    if kind == "array":
        return [_sample_for(schema.get("items", {"type": "string"}), key) for _ in range(3)]
    if kind == "integer":
        return 20 if "duration" in key else 3
    if kind == "number":
        return 1.0
    if kind == "boolean":
        return True
    if "url" in key:
        return "https://example.com/nguon-mau"
    return f"[dry-run] nội dung mẫu cho {key or 'trường này'}"


class FakeMessages:
    def create(self, **params):
        config = params.get("output_config") or params.get("extra_body", {}).get(
            "output_config", {}
        )
        schema = (config.get("format") or {}).get("schema")
        if schema:
            text = json.dumps(_sample_for(schema), ensure_ascii=False)
        else:
            text = (
                "[dry-run] Bản ghi chú nghiên cứu mẫu.\n"
                "- [độ tin cậy: cao] Một thông tin mẫu — Nguồn: https://example.com/a\n"
                "- [độ tin cậy: thấp] Một thông tin chưa chắc — Nguồn: https://example.com/b"
            )
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)],
            stop_reason="end_turn",
            stop_details=None,
            usage=SimpleNamespace(input_tokens=0, output_tokens=0),
        )


class FakeClient:
    def __init__(self) -> None:
        self.messages = FakeMessages()
