"""Stage 1 — Research Agent (§3.1 SPEC.md).

Hai lời gọi: (1) tìm tư liệu bằng web search, (2) ép bản ghi chú thô thành JSON.
Tách đôi vì server tool có thể trả pause_turn giữa chừng, còn bước cấu trúc hoá
thì thuần text -> JSON nên rẻ và ổn định hơn khi chạy riêng.
"""

from __future__ import annotations

from ..brief import VideoBrief
from ..config import web_search_tool
from ..llm import ClaudeRunner
from ..schemas import ResearchNotes

SEARCH_SYSTEM = """Bạn là research producer của một kênh video. Nhiệm vụ: tìm tư liệu \
đáng tin cho một chủ đề video sắp quay.

Nguyên tắc:
- Dùng web search cho mọi số liệu, mốc thời gian, tên riêng, kết quả nghiên cứu. \
Không dựa vào trí nhớ cho các claim cụ thể.
- Mỗi thông tin phải kèm URL nguồn thật đã thấy trong kết quả tìm kiếm. Tuyệt đối \
không bịa URL.
- Nếu một thông tin thú vị nhưng nguồn yếu (blog cá nhân, forum, không truy được \
gốc), vẫn ghi lại nhưng đánh dấu rõ là độ tin cậy thấp.
- Ưu tiên thông tin gây bất ngờ, có thể kể thành chuyện, hợp với video ngắn."""

SEARCH_PROMPT = """Nghiên cứu chủ đề video sau.

BRIEF:
{brief}

Viết bản ghi chú nghiên cứu gồm:
1. Tóm tắt bối cảnh chủ đề (3-5 câu).
2. 5-10 thông tin/insight đáng dùng. Mỗi ý một dòng theo dạng:
   - [độ tin cậy: cao|trung bình|thấp] nội dung — Nguồn: <URL>
3. 2-3 góc kể chuyện khả thi cho video.
4. 3-5 ý tưởng câu hook mở đầu.
5. Những điểm còn mơ hồ / chưa kiểm chứng được."""

STRUCTURE_SYSTEM = """Bạn chuyển bản ghi chú nghiên cứu thành JSON đúng schema. \
Chỉ dùng thông tin có trong ghi chú, không thêm thắt. Giữ nguyên URL nguồn như \
trong ghi chú; nếu một ý không có URL thì đặt source_url là "" và confidence là "low"."""

STRUCTURE_PROMPT = """Chuyển bản ghi chú dưới đây thành JSON.

Quy ước map độ tin cậy: cao -> "high", trung bình -> "medium", thấp -> "low".
Ngôn ngữ nội dung giữ nguyên: {language}.

BẢN GHI CHÚ:
{notes}"""


def run_research(runner: ClaudeRunner, brief: VideoBrief) -> ResearchNotes:
    raw_notes = runner.text(
        "research.search",
        SEARCH_SYSTEM,
        SEARCH_PROMPT.format(brief=brief.as_prompt_block()),
        tools=[web_search_tool(runner.model_for("research.search"))],
        effort="high",
    )
    return runner.structured(
        "research.structure",
        STRUCTURE_SYSTEM,
        STRUCTURE_PROMPT.format(language=brief.language, notes=raw_notes),
        ResearchNotes,
        effort="low",
    )
