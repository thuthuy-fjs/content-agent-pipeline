"""Notion là nơi lưu duy nhất của pipeline — ghi và đọc lại đều qua đây.

Pipeline không còn ghi file xuống đĩa (kể cả file tạm), nên module này phải
làm được cả hai chiều:

- **Ghi**: mỗi lần chạy thật tạo một page trong data source Notion. Page có hai
  phần: phần người đọc (kịch bản theo timeline, nguồn bấm được, metadata) và
  một khối `code` chứa **JSON gốc** của cả lần chạy.
- **Đọc lại**: web UI dựng lại màn kết quả từ khối JSON gốc đó, không parse
  ngược từ các block trình bày. Block trình bày là bản dịch một chiều (độ tin
  cậy thành màu chữ, timestamp thành tiêu đề) — parse ngược sẽ mất dữ liệu và
  vỡ ngay khi ai đó sửa tay trang Notion. JSON gốc thì round-trip chính xác.

Chỉ dùng `urllib` (thư viện chuẩn), giữ nguyên tắc "không thêm dependency" như
`web.py` — máy này pip đang hỏng.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .brief import VideoBrief
from .render import render_script_md
from .schemas import ResearchNotes, ScriptDraft, VideoMetadata
from .timeline import TimedSection, build_timeline, duration_report, format_timestamp

NOTION_API = "https://api.notion.com/v1"
# Bản API có data source cho database nhiều nguồn.
NOTION_VERSION = "2025-09-03"
REQUEST_TIMEOUT_SEC = 30

# Notion giới hạn 100 block children mỗi lượt tạo page, và 2000 ký tự mỗi
# rich text object. Khối JSON gốc luôn được ưu tiên giữ; block trình bày mới là
# thứ bị cắt khi chạm trần, vì mất nó chỉ xấu trang chứ không mất dữ liệu.
MAX_BLOCKS = 100
MAX_TEXT_LEN = 2000

# Heading đánh dấu vùng JSON gốc, dùng làm mốc khi đọc lại.
RAW_MARKER = "Dữ liệu gốc (JSON — đừng sửa tay)"

CONFIDENCE_LABEL = {"high": "CAO", "medium": "TRUNG BÌNH", "low": "THẤP"}
CONFIDENCE_COLOR = {"high": "green", "medium": "yellow", "low": "red"}


class NotionPublishError(RuntimeError):
    """Lỗi khi nói chuyện với Notion. Với run thật, đây là lỗi nghiêm trọng:
    không còn bản local nào để lùi về."""


def is_configured() -> bool:
    return bool(os.environ.get("NOTION_TOKEN") and os.environ.get("NOTION_DATA_SOURCE_ID"))


# ---------- HTTP ----------


def _headers() -> Dict[str, str]:
    token = os.environ.get("NOTION_TOKEN")
    if not token:
        raise NotionPublishError("Thiếu NOTION_TOKEN trong .env.")
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json; charset=utf-8",
    }


def _call(url: str, payload: Optional[dict] = None, method: str = "GET") -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers=_headers())
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SEC) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise NotionPublishError(f"Notion API lỗi {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise NotionPublishError(f"Không kết nối được tới Notion: {exc.reason}") from exc


# ---------- rich text / block ----------


def _text(content: Optional[str]) -> List[dict]:
    content = (content or "").strip()
    if not content:
        return []
    return [{"type": "text", "text": {"content": content[:MAX_TEXT_LEN]}}]


def _text_chunks(content: str) -> List[dict]:
    """Cắt chuỗi dài thành nhiều rich text object — dùng cho JSON gốc, không cắt cụt."""
    return [
        {"type": "text", "text": {"content": content[i:i + MAX_TEXT_LEN]}}
        for i in range(0, len(content), MAX_TEXT_LEN)
    ]


def _plain_text(block: dict) -> str:
    """Ghép plain_text của mọi rich text trong một block."""
    body = block.get(block.get("type") or "", {})
    return "".join(rt.get("plain_text", "") for rt in body.get("rich_text", []))


def _heading(level: int, content: str) -> Optional[dict]:
    rich = _text(content)
    if not rich:
        return None
    key = f"heading_{level}"
    return {"object": "block", "type": key, key: {"rich_text": rich}}


def _paragraph(content: str, color: str = "default") -> Optional[dict]:
    rich = _text(content)
    if not rich:
        return None
    return {"object": "block", "type": "paragraph",
            "paragraph": {"rich_text": rich, "color": color}}


def _bulleted(content: str) -> Optional[dict]:
    rich = _text(content)
    if not rich:
        return None
    return {"object": "block", "type": "bulleted_list_item",
            "bulleted_list_item": {"rich_text": rich}}


def _bookmark(url: str) -> Optional[dict]:
    if not url.startswith("http"):
        return None
    return {"object": "block", "type": "bookmark", "bookmark": {"url": url}}


def _fact_block(claim: str, confidence: str) -> Optional[dict]:
    rich = _text(claim)
    if not rich:
        return None
    label = CONFIDENCE_LABEL.get(confidence, confidence.upper())
    color = CONFIDENCE_COLOR.get(confidence, "default")
    return {
        "object": "block", "type": "paragraph",
        "paragraph": {"rich_text": [
            {"type": "text", "text": {"content": f"[{label}] "},
             "annotations": {"bold": True, "color": color}},
            *rich,
        ]},
    }


def _callout(content: str) -> Optional[dict]:
    rich = _text(content)
    if not rich:
        return None
    return {"object": "block", "type": "callout",
            "callout": {"rich_text": rich, "icon": {"type": "emoji", "emoji": "⚠️"},
                        "color": "yellow_background"}}


def _raw_blocks(payload: Dict[str, Any]) -> List[dict]:
    """Heading mốc + các khối code chứa JSON gốc — nguồn dữ liệu thật của page."""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return [
        _heading(3, RAW_MARKER),
        {"object": "block", "type": "code",
         "code": {"rich_text": _text_chunks(raw), "language": "json"}},
    ]


# ---------- properties ----------


def build_properties(brief: VideoBrief, summary: Dict[str, Any]) -> Dict[str, Any]:
    usage = summary.get("usage") or {}
    duration = summary.get("duration") or {}
    stage_models = usage.get("stage_models") or {}

    props: Dict[str, Any] = {
        "Video": {"title": _text(summary.get("working_title") or brief.topic)},
        "Chủ đề": {"rich_text": _text(brief.topic)},
        "Nền tảng": {"select": {"name": brief.platform}},
        "Model chính": {"rich_text": _text(usage.get("model"))},
        "Model bước phụ": {"rich_text": _text(
            ", ".join(f"{stage}={model}" for stage, model in stage_models.items())
        )},
        "Backend": {"select": {"name": usage.get("backend") or "api"}},
        "Có cảnh báo": {"checkbox": bool(summary.get("warnings"))},
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


# ---------- nội dung trang ----------


def build_blocks(
    research: ResearchNotes,
    timeline: List[TimedSection],
    metadata: VideoMetadata,
    warnings: List[str],
    raw_payload: Dict[str, Any],
) -> List[dict]:
    pretty: List[Optional[dict]] = []

    if warnings:
        pretty.append(_callout("\n".join(warnings)))

    pretty.append(_heading(2, "Kịch bản"))
    for section in timeline:
        span = (f"[{format_timestamp(section.start_sec)}–{format_timestamp(section.end_sec)}] "
                f"{section.name}")
        pretty.append(_heading(3, span))
        pretty.append(_paragraph(section.narration))
        pretty.append(_paragraph(f"🎬 {section.visual_cue}", color="gray_background"))

    pretty.append(_heading(2, "Nghiên cứu"))
    pretty.append(_paragraph(research.topic_summary))
    for fact in research.facts:
        pretty.append(_fact_block(fact.claim, fact.confidence))
        pretty.append(_bookmark(fact.source_url))
    for title, items in (
        ("Góc kể chuyện", research.angle_suggestions),
        ("Ý tưởng hook", research.hook_ideas),
        ("Còn bỏ ngỏ", research.open_questions),
    ):
        if not items:
            continue
        pretty.append(_heading(3, title))
        pretty.extend(_bulleted(item) for item in items)

    pretty.append(_heading(2, "Metadata"))
    pretty.append(_heading(3, "Title gợi ý"))
    pretty.extend(_bulleted(t) for t in metadata.title_options)
    pretty.append(_heading(3, "Description"))
    pretty.append(_paragraph(metadata.description))

    raw = [b for b in _raw_blocks(raw_payload) if b is not None]
    # JSON gốc là nguồn dữ liệu duy nhất nên luôn được giữ; block trình bày bị
    # cắt trước nếu chạm trần 100.
    budget = max(0, MAX_BLOCKS - len(raw))
    return [b for b in pretty if b is not None][:budget] + raw


# ---------- ghi ----------


def publish_run(
    brief: VideoBrief,
    research: ResearchNotes,
    script: ScriptDraft,
    timeline: List[TimedSection],
    metadata: VideoMetadata,
    summary: Dict[str, Any],
) -> Dict[str, str]:
    """Tạo page cho một lần chạy. Trả về {"id", "url"}. Raise NotionPublishError nếu lỗi."""
    data_source_id = os.environ.get("NOTION_DATA_SOURCE_ID")
    if not data_source_id:
        raise NotionPublishError("Thiếu NOTION_DATA_SOURCE_ID trong .env.")

    raw_payload = {
        "brief": brief.model_dump(),
        "research": research.model_dump(),
        "script": script.model_dump(),
        "metadata": metadata.model_dump(),
        "meta": summary,
    }
    properties = build_properties(brief, summary)
    properties.update(build_tag_properties(metadata))

    page = _call(
        f"{NOTION_API}/pages",
        {
            "parent": {"type": "data_source_id", "data_source_id": data_source_id},
            "properties": properties,
            "children": build_blocks(
                research, timeline, metadata, summary.get("warnings") or [], raw_payload
            ),
        },
        method="POST",
    )
    page_id = page["id"]
    return {"id": page_id, "url": page.get("url") or f"https://notion.so/{page_id.replace('-', '')}"}


# ---------- đọc lại ----------


def _prop(props: Dict[str, Any], name: str) -> Any:
    """Lấy giá trị một property từ response của Notion (shape đọc khác shape ghi)."""
    prop = props.get(name) or {}
    kind = prop.get("type")
    if kind in ("title", "rich_text"):
        return "".join(rt.get("plain_text", "") for rt in prop.get(kind) or [])
    if kind == "select":
        return (prop.get("select") or {}).get("name")
    if kind == "number":
        return prop.get("number")
    if kind == "checkbox":
        return prop.get("checkbox")
    return None


def fetch_page_blocks(page_id: str) -> List[dict]:
    blocks: List[dict] = []
    cursor = None
    while True:
        url = f"{NOTION_API}/blocks/{page_id}/children?page_size=100"
        if cursor:
            url += f"&start_cursor={cursor}"
        data = _call(url)
        blocks.extend(data.get("results") or [])
        if not data.get("has_more"):
            return blocks
        cursor = data.get("next_cursor")


def extract_raw_payload(blocks: List[dict]) -> Optional[Dict[str, Any]]:
    """Ghép các khối code nằm ngay sau heading mốc rồi parse JSON gốc."""
    chunks: List[str] = []
    collecting = False
    for block in blocks:
        if not collecting:
            if block.get("type") == "heading_3" and _plain_text(block) == RAW_MARKER:
                collecting = True
            continue
        if block.get("type") != "code":
            break
        chunks.append(_plain_text(block))

    if not chunks:
        return None
    try:
        return json.loads("".join(chunks))
    except json.JSONDecodeError:
        return None


def page_id_from_url(url: str) -> Optional[str]:
    """Lấy page id (32 ký tự hex) từ URL Notion. API nhận id không có dấu gạch."""
    match = re.search(r"([0-9a-fA-F]{32})", (url or "").replace("-", ""))
    return match.group(1) if match else None


def read_run(page_id: str) -> Optional[Dict[str, Any]]:
    """Dựng lại dữ liệu một lần chạy từ page Notion, đúng hình dạng web UI cần."""
    page = _call(f"{NOTION_API}/pages/{page_id}")
    raw = extract_raw_payload(fetch_page_blocks(page_id))
    if raw is None:
        return None

    brief = VideoBrief.model_validate(raw["brief"])
    research = ResearchNotes.model_validate(raw["research"])
    script = ScriptDraft.model_validate(raw["script"])
    metadata = VideoMetadata.model_validate(raw["metadata"])

    # timeline/report tính lại được từ script + brief (thuần số học, xác định)
    # nên không cần lưu thừa trong JSON gốc.
    timeline = build_timeline(script, brief)
    report = duration_report(timeline, brief)

    meta = dict(raw.get("meta") or {})
    meta["notion_url"] = page.get("url")

    return {
        "notion_page_id": page_id,
        "brief": brief.model_dump(),
        "research": research.model_dump(),
        "script": script.model_dump(),
        "title_options": metadata.title_options,
        "tags": {"tags": metadata.tags, "hashtags": metadata.hashtags},
        "meta": meta,
        "description": metadata.description,
        "script_md": render_script_md(brief, script, timeline, report, research),
    }


def query_recent_runs(limit: int = 20) -> List[Dict[str, Any]]:
    """Danh sách lần chạy gần nhất, chỉ đọc properties (không tải block cho nhẹ)."""
    data_source_id = os.environ.get("NOTION_DATA_SOURCE_ID")
    if not data_source_id:
        return []

    data = _call(
        f"{NOTION_API}/data_sources/{data_source_id}/query",
        {"sorts": [{"timestamp": "created_time", "direction": "descending"}],
         "page_size": limit},
        method="POST",
    )

    runs: List[Dict[str, Any]] = []
    for page in data.get("results") or []:
        props = page.get("properties") or {}
        created = page.get("created_time") or ""
        try:
            # Notion trả giờ UTC; đổi sang giờ máy để khớp với phần còn lại của UI.
            stamp = (datetime.strptime(created, "%Y-%m-%dT%H:%M:%S.%fZ")
                     .replace(tzinfo=timezone.utc).astimezone())
        except ValueError:
            stamp = None
        runs.append({
            "page_id": page["id"],
            "notion_url": page.get("url"),
            "title": _prop(props, "Video"),
            "topic": _prop(props, "Chủ đề"),
            "platform": _prop(props, "Nền tảng"),
            "duration": _prop(props, "Thời lượng mục tiêu (s)"),
            "date": stamp.strftime("%d/%m/%Y") if stamp else "",
            "started": stamp.strftime("%H:%M") if stamp else "",
            "_sort_ts": stamp.timestamp() if stamp else 0.0,
        })
    return runs
