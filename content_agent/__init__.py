"""Content agent: từ 1 chủ đề -> research, script, metadata (xem SPEC.md)."""

__all__ = ["run_pipeline", "VideoBrief", "ClaudeRunner"]

from .dotenv import load_env  # noqa: E402

load_env()  # phải chạy trước config/llm vì chúng đọc os.environ lúc import

from .brief import VideoBrief  # noqa: E402
from .llm import ClaudeRunner  # noqa: E402
from .pipeline import run_pipeline  # noqa: E402
