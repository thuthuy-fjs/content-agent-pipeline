"""Cấu hình chung: model, giá, khả năng theo model, tốc độ đọc."""

from __future__ import annotations

import os
from typing import Dict, Optional, Tuple

# Model mặc định. Đổi bằng --model hoặc biến môi trường CONTENT_AGENT_MODEL.
DEFAULT_MODEL = os.environ.get("CONTENT_AGENT_MODEL", "claude-opus-5")

DEFAULT_MAX_TOKENS = 16000

# Bốn lượt gọi model của pipeline, theo đúng thứ tự chạy.
PIPELINE_STAGES = ("research.search", "research.structure", "script", "metadata")

# Hai bước chỉ biến đổi dữ liệu có sẵn (ghi chú -> JSON, kịch bản -> title/tag),
# không cần suy luận sâu nên hạ model được mà chất lượng gần như không đổi.
LIGHT_STAGES = ("research.structure", "metadata")

# Các model hỗ trợ web search bản dynamic-filtering và output_config.effort.
MODERN_MODELS = frozenset(
    {
        "claude-fable-5-1",
        "claude-fable-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
    }
)

MODERN_WEB_SEARCH_TYPE = "web_search_20260209"
BASIC_WEB_SEARCH_TYPE = "web_search_20250305"

# USD / 1 triệu token (input, output).
PRICING_USD_PER_MTOK: Dict[str, Tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

# Tốc độ nói trung bình (âm tiết/giây) dùng để ước lượng thời lượng từ lời thoại.
SPEECH_RATE_PER_SEC = {"vi": 2.5, "en": 2.6}
DEFAULT_SPEECH_RATE = 2.5

# Ngưỡng cảnh báo (§7 SPEC.md).
MAX_DURATION_DRIFT_PCT = 15.0
MAX_LOW_CONFIDENCE_RATIO = 0.30

PLATFORM_HINTS = {
    "youtube_shorts": (
        "Video dọc dưới 60 giây. Hook phải nằm trong 2 giây đầu. "
        "Title ưu tiên gây tò mò, description ngắn kèm 3-5 hashtag."
    ),
    "youtube_long": (
        "Video ngang dài. Title ưu tiên SEO (từ khoá đứng đầu), "
        "description dài có tóm tắt và mốc thời gian chương."
    ),
    "tiktok": (
        "Video dọc, nhịp nhanh, giọng nói đời thường. "
        "Caption ngắn dưới 150 ký tự, hashtag đặt cuối."
    ),
    "reels": (
        "Video dọc, hình ảnh bắt mắt, lời thoại cô đọng. "
        "Caption ngắn, có 1 câu hỏi để kéo bình luận."
    ),
}


def supports_modern_features(model: str) -> bool:
    """Model có nhận web search bản mới và output_config.effort không."""
    return model in MODERN_MODELS


def web_search_tool(model: str, max_uses: int = 8) -> dict:
    """Định nghĩa server tool web search phù hợp với model đang dùng."""
    tool_type = (
        MODERN_WEB_SEARCH_TYPE if supports_modern_features(model) else BASIC_WEB_SEARCH_TYPE
    )
    return {"type": tool_type, "name": "web_search", "max_uses": max_uses}


def estimate_cost_usd(model: str, input_tokens: int, output_tokens: int) -> Optional[float]:
    """Ước tính chi phí một lời gọi; trả None nếu chưa có bảng giá cho model."""
    price = PRICING_USD_PER_MTOK.get(model)
    if price is None:
        return None
    return (input_tokens * price[0] + output_tokens * price[1]) / 1_000_000


def speech_rate(language: str) -> float:
    return SPEECH_RATE_PER_SEC.get(language, DEFAULT_SPEECH_RATE)
