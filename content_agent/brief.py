"""Brief đầu vào của pipeline (§2 SPEC.md)."""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import List

from pydantic import BaseModel, Field

from .config import PLATFORM_HINTS

PLATFORMS = tuple(PLATFORM_HINTS)


class VideoBrief(BaseModel):
    """Chỉ `topic` là bắt buộc, phần còn lại có mặc định."""

    topic: str
    platform: str = "youtube_shorts"
    duration_target_sec: int = 60
    tone: str = "giáo dục, gần gũi, hơi hài hước"
    audience: str = "khán giả phổ thông Việt Nam, 18-35 tuổi"
    language: str = "vi"
    must_include: List[str] = Field(default_factory=list)
    avoid: List[str] = Field(default_factory=list)

    def platform_hint(self) -> str:
        return PLATFORM_HINTS.get(self.platform, PLATFORM_HINTS["youtube_shorts"])

    def slug(self) -> str:
        """Slug ASCII dùng đặt tên thư mục output."""
        text = unicodedata.normalize("NFD", self.topic)
        text = "".join(c for c in text if unicodedata.category(c) != "Mn")
        text = text.replace("đ", "d").replace("Đ", "D").lower()
        text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
        return (text or "video")[:60]

    def as_prompt_block(self) -> str:
        """Phần brief chèn vào prompt của mọi agent."""
        lines = [
            f"- Chủ đề: {self.topic}",
            f"- Nền tảng: {self.platform} ({self.platform_hint()})",
            f"- Thời lượng mục tiêu: {self.duration_target_sec} giây",
            f"- Tone: {self.tone}",
            f"- Khán giả: {self.audience}",
            f"- Ngôn ngữ đầu ra: {self.language}",
        ]
        if self.must_include:
            lines.append("- Bắt buộc có: " + "; ".join(self.must_include))
        if self.avoid:
            lines.append("- Phải tránh: " + "; ".join(self.avoid))
        return "\n".join(lines)

    @classmethod
    def from_file(cls, path: Path) -> "VideoBrief":
        return cls.model_validate(json.loads(Path(path).read_text(encoding="utf-8")))
