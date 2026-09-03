"""Orchestration MVP: Research -> Script -> Metadata -> Packager (§3, §4 SPEC.md)."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from . import notion_publish
from .agents import run_metadata, run_research, run_script
from .brief import VideoBrief
from .config import MAX_LOW_CONFIDENCE_RATIO
from .llm import ClaudeRunner
from .render import render_description_txt, render_script_md
from .schemas import ResearchNotes
from .timeline import build_timeline, duration_report


def _write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


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


def run_pipeline(
    brief: VideoBrief,
    runner: ClaudeRunner,
    out_root: Path,
    out_dir: Optional[Path] = None,
    push_to_notion: bool = True,
) -> dict:
    """Chạy hết pipeline, ghi output ra thư mục, trả về summary."""
    warnings: List[str] = []
    log = print if runner.verbose else (lambda *a, **k: None)

    if out_dir is None:
        now = datetime.now()
        # output/<YYYYMMDD>/<slug>-<HHMMSS>: ngày nằm ở thư mục cha, tên run chỉ
        # cần giờ để phân biệt nhiều lần chạy cùng chủ đề trong ngày.
        out_dir = (
            Path(out_root)
            / now.strftime("%Y%m%d")
            / f"{brief.slug()}-{now.strftime('%H%M%S')}"
        )
    out_dir.mkdir(parents=True, exist_ok=True)

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

    # Thư mục được tạo từ đầu run (vài phút trước) để lỗi giữa chừng vẫn để lại dấu
    # vết; tạo lại ngay trước khi ghi phòng trường hợp nó biến mất trong lúc chạy.
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_json(out_dir / "brief.json", brief.model_dump())
    _write_json(out_dir / "research_notes.json", research.model_dump())
    _write_json(out_dir / "script.json", script.model_dump())
    _write_json(out_dir / "title_options.json", {"title_options": metadata.title_options})
    _write_json(out_dir / "tags.json", {"tags": metadata.tags, "hashtags": metadata.hashtags})
    (out_dir / "script.md").write_text(
        render_script_md(brief, script, timeline, report, research), encoding="utf-8"
    )
    (out_dir / "description.txt").write_text(
        render_description_txt(metadata), encoding="utf-8"
    )

    summary = {
        "output_dir": str(out_dir),
        "working_title": script.working_title,
        "sections": len(timeline),
        "facts": len(research.facts),
        "duration": report,
        "warnings": warnings,
        "usage": runner.usage_summary(),
    }

    # Notion là bản sao thêm, không phải nguồn thật — output local đã ghi xong ở
    # trên nên lỗi ở đây chỉ thành cảnh báo, không được làm hỏng cả lần chạy.
    # Bỏ qua với --dry-run: runner.backend giữ nguyên "dry-run" khi FakeClient
    # được truyền vào (xem ClaudeRunner.__post_init__), tận dụng lại tín hiệu đó.
    if push_to_notion and runner.backend != "dry-run" and notion_publish.is_configured():
        try:
            summary["notion_url"] = notion_publish.publish_run(
                out_dir, summary, brief, research, timeline, metadata
            )
        except notion_publish.NotionPublishError as exc:
            warnings.append(f"Không đẩy lên Notion được: {exc}")

    _write_json(out_dir / "run_meta.json", summary)
    return summary
