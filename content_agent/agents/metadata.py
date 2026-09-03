"""Stage 5 — Metadata Agent (§3.5 SPEC.md)."""

from __future__ import annotations

from typing import List

from ..brief import VideoBrief
from ..llm import ClaudeRunner
from ..schemas import ScriptDraft, VideoMetadata
from ..timeline import TimedSection, format_timestamp

METADATA_SYSTEM = """Bạn phụ trách phần xuất bản của một kênh video: đặt title, \
viết description, chọn tags.

Nguyên tắc:
- Title bám đúng nội dung script, không giật tít quá nội dung có thật.
- Description viết cho người đọc trước, cho thuật toán sau.
- Tags là cụm từ người thật sẽ gõ khi tìm, không nhồi từ khoá rác.
- Không hứa hẹn thông tin mà script không có."""

METADATA_PROMPT = """Viết metadata xuất bản cho video sau.

BRIEF:
{brief}

YÊU CẦU THEO NỀN TẢNG:
{platform_hint}

KỊCH BẢN ({title}):
{script_text}
{chapters}
Trả JSON đúng schema:
- title_options: 3-5 phương án title.
- description: 1 đoạn hoàn chỉnh, đúng phong cách nền tảng.
- tags: 8-15 tag.
- hashtags: 3-6 hashtag (có dấu #, không dấu tiếng Việt, không khoảng trắng)."""


def run_metadata(
    runner: ClaudeRunner,
    brief: VideoBrief,
    script: ScriptDraft,
    timeline: List[TimedSection],
) -> VideoMetadata:
    script_text = "\n\n".join(
        f"[{s.name}] {s.narration}" for s in timeline
    )
    chapters = ""
    if brief.platform == "youtube_long":
        marks = "\n".join(f"{format_timestamp(s.start_sec)} {s.name}" for s in timeline)
        chapters = (
            "\nMỐC THỜI GIAN (đưa nguyên vào description dạng chương):\n" + marks + "\n"
        )

    prompt = METADATA_PROMPT.format(
        brief=brief.as_prompt_block(),
        platform_hint=brief.platform_hint(),
        title=script.working_title,
        script_text=script_text,
        chapters=chapters,
    )
    return runner.structured("metadata", METADATA_SYSTEM, prompt, VideoMetadata, effort="medium")
