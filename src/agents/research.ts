// Stage 1 — Research Agent (SPEC.md §3.1).
//
// Two calls: (1) find material via web search, (2) force the raw notes into
// JSON. Split because the server-side search tool can pause_turn mid-stream,
// while the structuring step is pure text->JSON so it's cheaper/steadier alone.

import type { VideoBrief } from "../brief";
import { briefAsPromptBlock } from "../brief";
import { webSearchTool } from "../config";
import type { LLMRunner } from "../llm/runner";
import { RESEARCH_NOTES_SCHEMA, validateResearchNotes, type ResearchNotes } from "../schemas";

const SEARCH_SYSTEM = `Bạn là research producer của một kênh video. Nhiệm vụ: tìm tư liệu đáng tin cho một chủ đề video sắp quay.

Nguyên tắc:
- Dùng web search cho mọi số liệu, mốc thời gian, tên riêng, kết quả nghiên cứu. Không dựa vào trí nhớ cho các claim cụ thể.
- Mỗi thông tin phải kèm URL nguồn thật đã thấy trong kết quả tìm kiếm. Tuyệt đối không bịa URL.
- Nếu một thông tin thú vị nhưng nguồn yếu (blog cá nhân, forum, không truy được gốc), vẫn ghi lại nhưng đánh dấu rõ là độ tin cậy thấp.
- Ưu tiên thông tin gây bất ngờ, có thể kể thành chuyện, hợp với video ngắn.`;

function searchPrompt(brief: VideoBrief): string {
  return `Nghiên cứu chủ đề video sau.

BRIEF:
${briefAsPromptBlock(brief)}

Viết bản ghi chú nghiên cứu gồm:
1. Tóm tắt bối cảnh chủ đề (3-5 câu).
2. 5-10 thông tin/insight đáng dùng. Mỗi ý một dòng theo dạng:
   - [độ tin cậy: cao|trung bình|thấp] nội dung — Nguồn: <URL>
3. 2-3 góc kể chuyện khả thi cho video.
4. 3-5 ý tưởng câu hook mở đầu.
5. Những điểm còn mơ hồ / chưa kiểm chứng được.`;
}

const STRUCTURE_SYSTEM = `Bạn chuyển bản ghi chú nghiên cứu thành JSON đúng schema. Chỉ dùng thông tin có trong ghi chú, không thêm thắt. Giữ nguyên URL nguồn như trong ghi chú; nếu một ý không có URL thì đặt source_url là "" và confidence là "low".`;

function structurePrompt(language: string, notes: string): string {
  return `Chuyển bản ghi chú dưới đây thành JSON.

Quy ước map độ tin cậy: cao -> "high", trung bình -> "medium", thấp -> "low".
Ngôn ngữ nội dung giữ nguyên: ${language}.

BẢN GHI CHÚ:
${notes}`;
}

export async function runResearch(runner: LLMRunner, brief: VideoBrief): Promise<ResearchNotes> {
  const rawNotes = await runner.text("research.search", SEARCH_SYSTEM, searchPrompt(brief), {
    tools: [webSearchTool(runner.modelFor("research.search"))],
    effort: "high",
  });
  return runner.structured(
    "research.structure",
    STRUCTURE_SYSTEM,
    structurePrompt(brief.language, rawNotes),
    RESEARCH_NOTES_SCHEMA,
    validateResearchNotes,
    { effort: "low" }
  );
}
