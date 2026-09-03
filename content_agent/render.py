"""Kết xuất script.md và description.txt cho người quay/dựng."""

from __future__ import annotations

from typing import List

from .brief import VideoBrief
from .schemas import ResearchNotes, ScriptDraft, VideoMetadata
from .timeline import TimedSection, format_timestamp

CONFIDENCE_LABEL = {"high": "cao", "medium": "trung bình", "low": "thấp"}


def render_script_md(
    brief: VideoBrief,
    script: ScriptDraft,
    timeline: List[TimedSection],
    report: dict,
    research: ResearchNotes,
) -> str:
    lines = [
        f"# {script.working_title}",
        "",
        f"> Chủ đề: {brief.topic}  ",
        f"> Nền tảng: {brief.platform} · Mục tiêu {report['target_sec']}s · "
        f"Kịch bản {report['planned_sec']}s · Đọc thử ước tính {report['spoken_estimate_sec']}s "
        f"(lệch {report['drift_pct']:+.1f}%)  ",
        f"> Tone: {brief.tone} · Khán giả: {brief.audience}",
        "",
    ]

    if not report["within_tolerance"]:
        lines += [
            "**Cảnh báo:** thời lượng đọc thử lệch quá ngưỡng cho phép — "
            "cắt bớt hoặc thêm lời thoại trước khi quay.",
            "",
        ]
    if report["overrunning_sections"]:
        over = ", ".join(
            f"{s['name']} ({s['spoken_sec']}s / {s['budget_sec']}s)"
            for s in report["overrunning_sections"]
        )
        lines += [f"**Section quá dài so với ngân sách:** {over}", ""]

    lines.append("---")
    for section in timeline:
        lines += [
            "",
            f"## [{format_timestamp(section.start_sec)}–{format_timestamp(section.end_sec)}] "
            f"{section.name}",
            "",
            f"*Mục tiêu:* {section.goal}",
            "",
            f"**Lời thoại:** {section.narration}",
            "",
            f"**Hình ảnh:** {section.visual_cue}",
            "",
            f"<sub>{section.syllable_count} âm tiết · đọc ~{section.spoken_sec}s / "
            f"ngân sách {section.duration_sec}s</sub>",
        ]

    lines += ["", "---", "", "## Nguồn tham chiếu", ""]
    for fact in research.facts:
        source = fact.source_url or "không có nguồn"
        lines.append(
            f"- [{CONFIDENCE_LABEL.get(fact.confidence, fact.confidence)}] "
            f"{fact.claim} — {source}"
        )
    lines.append("")
    return "\n".join(lines)


def render_description_txt(metadata: VideoMetadata) -> str:
    parts = [
        f"TITLE (phương án 1): {metadata.title_options[0] if metadata.title_options else ''}",
        "",
        metadata.description,
        "",
        " ".join(metadata.hashtags),
        "",
    ]
    if len(metadata.title_options) > 1:
        parts += ["--- Các phương án title khác ---"]
        parts += [f"- {t}" for t in metadata.title_options[1:]]
        parts.append("")
    return "\n".join(parts)
