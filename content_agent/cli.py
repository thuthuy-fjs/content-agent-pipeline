"""CLI: python run.py --topic "..." [--platform tiktok] [--dry-run]"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import notion_publish
from .brief import PLATFORMS, VideoBrief
from .config import DEFAULT_MAX_TOKENS, DEFAULT_MODEL, LIGHT_STAGES, PIPELINE_STAGES
from .llm import ClaudeRunner, ContentAgentError
from .pipeline import run_pipeline


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="content-agent",
        description="Từ 1 chủ đề -> research, script, description, tags.",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--topic", help="Chủ đề video")
    source.add_argument("--brief", type=Path, help="File JSON brief đầy đủ")

    parser.add_argument("--platform", choices=PLATFORMS, default="youtube_shorts")
    parser.add_argument("--duration", type=int, default=60, help="Thời lượng mục tiêu (giây)")
    parser.add_argument("--tone")
    parser.add_argument("--audience")
    parser.add_argument("--language", default="vi")
    parser.add_argument("--must-include", action="append", default=[])
    parser.add_argument("--avoid", action="append", default=[])

    parser.add_argument("--llm-platform", choices=["claude", "chatgpt", "gemini"], default="claude", help="Nền tảng LLM cần dùng")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model dùng cho mọi bước")
    parser.add_argument(
        "--light-model",
        help="Model rẻ hơn cho các bước chỉ biến đổi dữ liệu: "
             + ", ".join(LIGHT_STAGES),
    )
    parser.add_argument(
        "--stage-model",
        action="append",
        default=[],
        metavar="STAGE=MODEL",
        help="Đè model cho một bước cụ thể (lặp được). Bước hợp lệ: "
             + ", ".join(PIPELINE_STAGES),
    )
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Chạy thử toàn bộ pipeline với dữ liệu giả, không gọi API",
    )
    return parser


def stage_models_from_args(args: argparse.Namespace) -> dict:
    """Gộp --light-model và --stage-model thành bản đồ stage -> model.

    --stage-model cụ thể hơn nên thắng --light-model khi trùng bước.
    """
    mapping = {}
    if args.light_model:
        mapping.update({stage: args.light_model for stage in LIGHT_STAGES})
    for item in args.stage_model:
        stage, sep, model = item.partition("=")
        stage, model = stage.strip(), model.strip()
        if not sep or not model:
            raise ValueError(f"--stage-model cần dạng STAGE=MODEL, nhận: {item!r}")
        if stage not in PIPELINE_STAGES:
            raise ValueError(
                f"Bước không tồn tại: {stage}. Chọn trong: {', '.join(PIPELINE_STAGES)}"
            )
        mapping[stage] = model
    # Bỏ các mục trùng đúng model mặc định để log và run_meta khỏi nhiễu.
    return {k: v for k, v in mapping.items() if v != args.model}


def brief_from_args(args: argparse.Namespace) -> VideoBrief:
    if args.brief:
        return VideoBrief.from_file(args.brief)
    fields = {
        "topic": args.topic,
        "platform": args.platform,
        "duration_target_sec": args.duration,
        "language": args.language,
        "must_include": args.must_include,
        "avoid": args.avoid,
    }
    if args.tone:
        fields["tone"] = args.tone
    if args.audience:
        fields["audience"] = args.audience
    return VideoBrief(**fields)


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    brief = brief_from_args(args)
    try:
        stage_models = stage_models_from_args(args)
    except ValueError as exc:
        print(f"Dừng pipeline: {exc}", file=sys.stderr)
        return 1

    if not args.dry_run and not notion_publish.is_configured():
        print(
            "Dừng pipeline: chưa cấu hình Notion (cần NOTION_TOKEN và "
            "NOTION_DATA_SOURCE_ID trong .env). Pipeline không ghi file local nữa "
            "nên không có chỗ nào để lưu kết quả.",
            file=sys.stderr,
        )
        return 1

    client = None
    if args.dry_run:
        from .fake import FakeClient

        client = FakeClient()

    runner = ClaudeRunner(
        platform=args.llm_platform,
        model=args.model,
        client=client,
        max_tokens=args.max_tokens,
        verbose=not args.quiet,
        stage_models=stage_models,
    )

    try:
        summary = run_pipeline(brief, runner)
    except ContentAgentError as exc:
        print(f"Dừng pipeline: {exc}", file=sys.stderr)
        return 1

    # web.py bắt đúng tiền tố "Xong -> " này để biết run đã xong và lấy link.
    if summary.get("notion_url"):
        print(f"\nXong -> {summary['notion_url']}")
    else:
        print("\nXong (chạy thử — không lưu ở đâu).")
    print(f"  Title nháp: {summary['working_title']}")
    duration = summary["duration"]
    print(
        f"  Thời lượng: mục tiêu {duration['target_sec']}s · "
        f"kịch bản {duration['planned_sec']}s · "
        f"đọc thử {duration['spoken_estimate_sec']}s ({duration['drift_pct']:+.1f}%)"
    )
    cost = summary["usage"]["total_cost_usd"]
    if cost is not None:
        print(f"  Chi phí ước tính: ${cost:.4f}")
    for warning in summary["warnings"]:
        print(f"  ! {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
