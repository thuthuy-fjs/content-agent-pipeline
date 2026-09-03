"""Stage 3 — Script Agent (§3.3 SPEC.md).

MVP gộp outline vào đây: agent tự chia section + ngân sách giây rồi viết luôn
lời thoại. Timestamp không do model tính — code cộng dồn duration_sec (xem
timeline.py) để tránh lỗi số học.
"""

from __future__ import annotations

from ..brief import VideoBrief
from ..config import speech_rate
from ..llm import ClaudeRunner
from ..schemas import ResearchNotes, ScriptDraft

SCRIPT_SYSTEM = """Bạn là biên kịch video ngắn. Bạn nhận ghi chú nghiên cứu và \
viết kịch bản hoàn chỉnh để người khác cầm đi quay ngay.

Nguyên tắc:
- Mọi con số, mốc thời gian, kết quả nghiên cứu trong lời thoại phải lấy từ ghi \
chú nghiên cứu. Không thêm số liệu mới.
- Thông tin nào trong ghi chú có confidence "low" thì hoặc bỏ, hoặc nói theo kiểu \
phỏng đoán ("có giả thuyết cho rằng..."), không khẳng định.
- Lời thoại là văn nói: câu ngắn, chủ ngữ rõ, đọc lên nghe tự nhiên. Không dùng \
gạch đầu dòng, không dùng ngoặc chú thích trong lời thoại.
- Mỗi section kèm một visual_cue cụ thể, mô tả được cảnh cần quay hoặc hình cần \
tìm, không nói chung chung như "hình minh hoạ".
- Cấu trúc chuẩn: hook -> 2 đến 4 đoạn nội dung -> CTA."""

SCRIPT_PROMPT = """Viết kịch bản video.

BRIEF:
{brief}

NGÂN SÁCH THỜI GIAN:
- Tổng thời lượng mục tiêu: {duration} giây. Tổng duration_sec của các section \
phải bằng đúng {duration}.
- Tốc độ đọc ước tính: {rate} âm tiết/giây, tức một section dài N giây thì lời \
thoại khoảng N x {rate} âm tiết. Bám mức này, đừng viết dài hơn ngân sách section.

GHI CHÚ NGHIÊN CỨU (JSON):
{research}

Trả JSON đúng schema: working_title và danh sách sections (name, goal, \
duration_sec, narration, visual_cue)."""


def run_script(
    runner: ClaudeRunner, brief: VideoBrief, research: ResearchNotes
) -> ScriptDraft:
    rate = speech_rate(brief.language)
    prompt = SCRIPT_PROMPT.format(
        brief=brief.as_prompt_block(),
        duration=brief.duration_target_sec,
        rate=rate,
        research=research.model_dump_json(indent=2),
    )
    return runner.structured("script", SCRIPT_SYSTEM, prompt, ScriptDraft, effort="high")
