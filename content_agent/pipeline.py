"""Orchestration MVP: Research -> Script -> Metadata -> Notion (§3, §4 SPEC.md).

Pipeline không ghi bất kỳ file nào xuống đĩa: kết quả đi thẳng lên Notion
(xem notion_publish.py). Đổi lại, run thật bắt buộc phải có Notion cấu hình
sẵn — cli.py chặn từ đầu để không đốt hạn mức rồi mới phát hiện không có chỗ lưu.
"""

from __future__ import annotations

import json
from typing import List

from . import notion_publish
from .agents import run_metadata, run_research, run_script
from .brief import VideoBrief
from .config import MAX_LOW_CONFIDENCE_RATIO
from .llm import ClaudeRunner, provider_error
from .schemas import ResearchNotes
from .timeline import build_timeline, duration_report


def _fact_check_gate(research: ResearchNotes, warnings: List[str]) -> None:
    ratio = research.low_confidence_ratio()
    if ratio > MAX_LOW_CONFIDENCE_RATIO:
        warnings.append(
            f"{ratio:.0%} thông tin nghiên cứu có độ tin cậy thấp "
            f"(ngưỡng {MAX_LOW_CONFIDENCE_RATIO:.0%}). Nên kiểm tra lại trước khi quay."
        )
    missing = [f.claim for f in research.facts if not f.source_url]
    if missing:
        warnings.append(f"{len(missing)} thông tin không có URL nguồn.")


def run_pipeline(brief: VideoBrief, runner: ClaudeRunner) -> dict:
    """Chạy hết pipeline, đẩy kết quả lên Notion, trả về summary."""
    warnings: List[str] = []
    log = print if runner.verbose else (lambda *a, **k: None)

    log("[1/3] Research...")
    research = run_research(runner, brief)
    _fact_check_gate(research, warnings)

    log("[2/3] Script...")
    script = run_script(runner, brief, research)
    timeline = build_timeline(script, brief)
    report = duration_report(timeline, brief)
    if not report["within_tolerance"]:
        warnings.append(
            f"Thời lượng đọc thử {report['spoken_estimate_sec']}s lệch "
            f"{report['drift_pct']:+.1f}% so với mục tiêu {report['target_sec']}s."
        )

    log("[3/3] Metadata...")
    metadata = run_metadata(runner, brief, script, timeline)

    summary = {
        "working_title": script.working_title,
        "sections": len(timeline),
        "facts": len(research.facts),
        "duration": report,
        "warnings": warnings,
        "usage": runner.usage_summary(),
    }

    # --dry-run không đẩy đi đâu cả: nó là công cụ kiểm tra đường code, không
    # phải nội dung thật. runner.backend giữ nguyên "dry-run" khi FakeClient
    # được truyền vào (xem ClaudeRunner.__post_init__), tận dụng lại tín hiệu đó.
    if runner.backend == "dry-run":
        return summary

    try:
        page = notion_publish.publish_run(brief, research, script, timeline, metadata, summary)
    except notion_publish.NotionPublishError as exc:
        # Không còn bản local nào để lùi về, nên trước khi báo hỏng phải đổ toàn
        # bộ nội dung ra stdout — cứu vãn cuối cùng để không mất trắng công đã
        # tiêu hạn mức sinh ra.
        log("\n=== NOTION LỖI — JSON GỐC ĐỔ RA ĐÂY ĐỂ BẠN COPY LẠI ===")
        log(json.dumps(
            {"brief": brief.model_dump(), "research": research.model_dump(),
             "script": script.model_dump(), "metadata": metadata.model_dump(),
             "meta": summary},
            ensure_ascii=False,
        ))
        log("=== HẾT JSON GỐC ===\n")
        raise provider_error(f"Notion: không lưu được: {exc}") from exc

    summary["notion_url"] = page["url"]
    summary["notion_page_id"] = page["id"]
    return summary
