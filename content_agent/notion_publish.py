"""Đẩy kết quả một lần chạy lên Notion (tuỳ chọn).

Chỉ kích hoạt khi `NOTION_TOKEN` + `NOTION_DATA_SOURCE_ID` có trong `.env` (xem
README). Thất bại ở đây không được làm hỏng pipeline — output local đã ghi
xong trước khi module này chạy, Notion chỉ là bản sao thêm để đọc/duyệt.

Chỉ dùng `urllib` (thư viện chuẩn), giữ đúng nguyên tắc "không thêm dependency
mới" như `web.py` — máy này pip đang hỏng nên không thể cài `requests`.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from .brief import VideoBrief
from .schemas import ResearchNotes, VideoMetadata
from .timeline import TimedSection, format_timestamp

NOTION_API = "https://api.notion.com/v1"
# Bản API có data source cho database nhiều nguồn (database vừa tạo dùng model này).
NOTION_VERSION = "2025-09-03"
REQUEST_TIMEOUT_SEC = 30
MAX_BLOCKS = 100  # giới hạn children của Notion khi tạo page trong 1 lượt gọi

CONFIDENCE_LABEL = {"high": "CAO", "medium": "TRUNG BÌNH", "low": "THẤP"}
CONFIDENCE_COLOR = {"high": "green", "medium": "yellow", "low": "red"}


class NotionPublishError(RuntimeError):
    """Lỗi khi đẩy lên Notion. Bên gọi phải bắt và chỉ cảnh báo, không dừng pipeline."""


def is_configured() -> bool:
    return bool(os.environ.get("NOTION_TOKEN") and os.environ.get("NOTION_DATA_SOURCE_ID"))


# ---------- dựng rich text / block ----------


def _text(content: Optional[str]) -> List[dict]:
    content = (content or "").strip()
    if not content:
        return []
    return [{"type": "text", "text": {"content": content[:2000]}}]


def _heading(level: int, content: str) -> Optional[dict]:
    blocks = _text(content)
    if not blocks:
        return None
    key = f"heading_{level}"
    return {"object": "block", "type": key, key: {"rich_text": blocks}}


def _paragraph(content: str, color: str = "default") -> Optional[dict]:
    blocks = _text(content)
    if not blocks:
        return None
    return {"object": "block", "type": "paragraph", "paragraph": {"rich_text": blocks, "color": color}}


def _bulleted(content: str) -> Optional[dict]:
    blocks = _text(content)
    if not blocks:
        return None
    return {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": blocks}}


def _bookmark(url: str) -> Optional[dict]:
    if not url.startswith("http"):
        return None
    return {"object": "block", "type": "bookmark", "bookmark": {"url": url}}


def _fact_block(claim: str, confidence: str) -> Optional[dict]:
    text = _text(claim)
    if not text:
        return None
    label = CONFIDENCE_LABEL.get(confidence, confidence.upper())
    color = CONFIDENCE_COLOR.get(confidence, "default")
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {
            "rich_text": [
                {"type": "text", "text": {"content": f"[{label}] "},
                 "annotations": {"bold": True, "color": color}},
                *text,
            ]
        },
    }


def _callout(content: str, emoji: str = "⚠️", color: str = "yellow_background") -> Optional[dict]:
    text = _text(content)
    if not text:
        return None
    return {
        "object": "block",
        "type": "callout",
        "callout": {"rich_text": text, "icon": {"type": "emoji", "emoji": emoji}, "color": color},
    }


# ---------- properties (cột của database) ----------


def build_properties(brief: VideoBrief, summary: Dict[str, Any]) -> Dict[str, Any]:
    usage = summary.get("usage") or {}
    duration = summary.get("duration") or {}
    stage_models = usage.get("stage_models") or {}
    light_summary = ", ".join(f"{stage}={model}" for stage, model in stage_models.items())

    props: Dict[str, Any] = {
        "Video": {"title": _text(summary.get("working_title") or brief.topic)},
        "Chủ đề": {"rich_text": _text(brief.topic)},
        "Nền tảng": {"select": {"name": brief.platform}},
        "Model chính": {"rich_text": _text(usage.get("model"))},
        "Model bước phụ": {"rich_text": _text(light_summary)},
        "Backend": {"select": {"name": usage.get("backend") or "api"}},
        "Có cảnh báo": {"checkbox": bool(summary.get("warnings"))},
        "Thư mục output": {"rich_text": _text(summary.get("output_dir"))},
    }
    if duration.get("target_sec") is not None:
        props["Thời lượng mục tiêu (s)"] = {"number": duration["target_sec"]}
    if duration.get("spoken_estimate_sec") is not None:
        props["Thời lượng đọc thử (s)"] = {"number": duration["spoken_estimate_sec"]}
    if duration.get("drift_pct") is not None:
        props["Lệch %"] = {"number": duration["drift_pct"]}
    cost = usage.get("total_cost_usd")
    if cost is not None:
        props["Chi phí quy đổi"] = {"number": round(cost, 4)}
    return props


def build_tag_properties(metadata: VideoMetadata) -> Dict[str, Any]:
    props: Dict[str, Any] = {}
    if metadata.tags:
        props["Tags"] = {"multi_select": [{"name": t[:100]} for t in metadata.tags[:20]]}
    if metadata.hashtags:
        props["Hashtag"] = {"multi_select": [{"name": h[:100]} for h in metadata.hashtags[:20]]}
    return props


# ---------- nội dung trang (blocks) ----------


def build_blocks(
    research: ResearchNotes,
    timeline: List[TimedSection],
    metadata: VideoMetadata,
    warnings: List[str],
) -> List[dict]:
    blocks: List[Optional[dict]] = []

    if warnings:
        blocks.append(_callout("\n".join(warnings)))

    blocks.append(_heading(2, "Kịch bản"))
    for section in timeline:
        span = f"[{format_timestamp(section.start_sec)}–{format_timestamp(section.end_sec)}] {section.name}"
        blocks.append(_heading(3, span))
        blocks.append(_paragraph(section.narration))
        blocks.append(_paragraph(f"🎬 {section.visual_cue}", color="gray_background"))

    blocks.append(_heading(2, "Nghiên cứu"))
    blocks.append(_paragraph(research.topic_summary))
    for fact in research.facts:
        blocks.append(_fact_block(fact.claim, fact.confidence))
        blocks.append(_bookmark(fact.source_url))
    for title, items in (
        ("Góc kể chuyện", research.angle_suggestions),
        ("Ý tưởng hook", research.hook_ideas),
        ("Còn bỏ ngỏ", research.open_questions),
    ):
        if not items:
            continue
        blocks.append(_heading(3, title))
        blocks.extend(_bulleted(item) for item in items)

    blocks.append(_heading(2, "Metadata"))
    blocks.append(_heading(3, "Title gợi ý"))
    blocks.extend(_bulleted(t) for t in metadata.title_options)
    blocks.append(_heading(3, "Description"))
    blocks.append(_paragraph(metadata.description))

    # Notion giới hạn children khi tạo page trong 1 lượt gọi; cắt bớt thay vì lỗi
    # cả request — bản Notion chỉ là bản sao, output local vẫn đầy đủ.
    return [b for b in blocks if b is not None][:MAX_BLOCKS]


# ---------- gọi API ----------


def publish_run(
    out_dir: Path,
    summary: Dict[str, Any],
    brief: VideoBrief,
    research: ResearchNotes,
    timeline: List[TimedSection],
    metadata: VideoMetadata,
) -> str:
    """Tạo một page trong data source Notion, trả về URL. Raise NotionPublishError nếu lỗi."""
    token = os.environ.get("NOTION_TOKEN")
    data_source_id = os.environ.get("NOTION_DATA_SOURCE_ID")
    if not token or not data_source_id:
        raise NotionPublishError("Thiếu NOTION_TOKEN hoặc NOTION_DATA_SOURCE_ID trong .env.")

    properties = build_properties(brief, summary)
    properties.update(build_tag_properties(metadata))
    blocks = build_blocks(research, timeline, metadata, summary.get("warnings") or [])

    payload = {
        "parent": {"type": "data_source_id", "data_source_id": data_source_id},
        "properties": properties,
        "children": blocks,
    }
    request = urllib.request.Request(
        f"{NOTION_API}/pages",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SEC) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise NotionPublishError(f"Notion API lỗi {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise NotionPublishError(f"Không kết nối được tới Notion: {exc.reason}") from exc

    return data.get("url") or f"https://notion.so/{data['id'].replace('-', '')}"
