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

# Mọi lỗi gọi API bên thứ ba (Anthropic/OpenAI/Gemini/Notion) chỉ hiện đúng câu
# này cho người dùng; chi tiết thật đi ra stderr để debug.
PROVIDER_UNAVAILABLE = "Hệ thống hiện không khả dụng. Vui lòng thử lại sau."

MODERN_WEB_SEARCH_TYPE = "web_search_20260209"
BASIC_WEB_SEARCH_TYPE = "web_search_20250305"

# USD / 1 triệu token (input, output).
PRICING_USD_PER_MTOK: Dict[str, Tuple[float, float]] = {
    # Claude
    "claude-fable-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    
    # ChatGPT
    "gpt-5.6-sol": (15.0, 75.0),
    "gpt-5.6-terra": (5.0, 25.0),
    "gpt-5.6-luna": (1.0, 5.0),
    "gpt-5.5-pro": (10.0, 30.0),
    "gpt-5.5": (2.5, 12.5),
    "gpt-5.4-pro": (5.0, 15.0),
    "gpt-5.4": (1.0, 5.0),

    # Gemini
    "gemini-3.6-flash-high": (1.5, 7.5),
    "gemini-3.6-flash-medium": (1.0, 5.0),
    "gemini-3.6-flash-low": (0.5, 2.5),
    "gemini-3.1-pro-high": (5.0, 20.0),
    "gemini-3.1-pro-low": (2.0, 10.0),
}

PLATFORM_MODELS = {
    "claude": [
        {"value": "claude-opus-5", "label": "Claude Opus 5"},
        {"value": "claude-sonnet-5", "label": "Claude Sonnet 5"},
        {"value": "claude-haiku-4-5", "label": "Claude Haiku 4.5"},
        {"value": "claude-fable-5-1", "label": "Claude Fable 5.1"},
    ],
    "chatgpt": [
        {"value": "gpt-5.6-sol", "label": "GPT-5.6 Sol"},
        {"value": "gpt-5.6-terra", "label": "GPT-5.6 Terra"},
        {"value": "gpt-5.6-luna", "label": "GPT-5.6 Luna"},
        {"value": "gpt-5.5-pro", "label": "GPT 5.5 Pro"},
        {"value": "gpt-5.5", "label": "GPT 5.5"},
        {"value": "gpt-5.4-pro", "label": "GPT 5.4 Pro"},
        {"value": "gpt-5.4", "label": "GPT 5.4"},
    ],
    "gemini": [
        {"value": "gemini-3.6-flash-high", "label": "Gemini 3.6 Flash (High)"},
        {"value": "gemini-3.6-flash-medium", "label": "Gemini 3.6 Flash (Medium)"},
        {"value": "gemini-3.6-flash-low", "label": "Gemini 3.6 Flash (Low)"},
        {"value": "gemini-3.1-pro-high", "label": "Gemini 3.1 Pro (High)"},
        {"value": "gemini-3.1-pro-low", "label": "Gemini 3.1 Pro (Low)"},
    ]
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
