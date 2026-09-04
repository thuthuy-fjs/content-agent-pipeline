// Stage 3 — Script Agent (SPEC.md §3.3).
//
// MVP folds outline into this stage: the agent splits sections + a second
// budget and writes narration in one pass. Timestamps are never computed by
// the model — code sums duration_sec (see timeline.ts) to avoid arithmetic errors.

import type { VideoBrief } from "../brief";
import { briefAsPromptBlock } from "../brief";
import { speechRate } from "../config";
import type { LLMRunner } from "../llm/runner";
import { SCRIPT_DRAFT_SCHEMA, validateScriptDraft, type ResearchNotes, type ScriptDraft } from "../schemas";

const SCRIPT_SYSTEM = `Bạn là biên kịch video ngắn. Bạn nhận ghi chú nghiên cứu và viết kịch bản hoàn chỉnh để người khác cầm đi quay ngay.

Nguyên tắc:
- Mọi con số, mốc thời gian, kết quả nghiên cứu trong lời thoại phải lấy từ ghi chú nghiên cứu. Không thêm số liệu mới.
- Thông tin nào trong ghi chú có confidence "low" thì hoặc bỏ, hoặc nói theo kiểu phỏng đoán ("có giả thuyết cho rằng..."), không khẳng định.
- Lời thoại là văn nói: câu ngắn, chủ ngữ rõ, đọc lên nghe tự nhiên. Không dùng gạch đầu dòng, không dùng ngoặc chú thích trong lời thoại.
- Mỗi section kèm một visual_cue cụ thể, mô tả được cảnh cần quay hoặc hình cần tìm, không nói chung chung như "hình minh hoạ".
- Cấu trúc chuẩn: hook -> 2 đến 4 đoạn nội dung -> CTA.`;

function scriptPrompt(brief: VideoBrief, rate: number, researchJson: string): string {
  return `Viết kịch bản video.

BRIEF:
${briefAsPromptBlock(brief)}

NGÂN SÁCH THỜI GIAN:
- Tổng thời lượng mục tiêu: ${brief.duration_target_sec} giây. Tổng duration_sec của các section phải bằng đúng ${brief.duration_target_sec}.
- Tốc độ đọc ước tính: ${rate} âm tiết/giây, tức một section dài N giây thì lời thoại khoảng N x ${rate} âm tiết. Bám mức này, đừng viết dài hơn ngân sách section.

GHI CHÚ NGHIÊN CỨU (JSON):
${researchJson}

Trả JSON đúng schema: working_title và danh sách sections (name, goal, duration_sec, narration, visual_cue).`;
}

export async function runScript(runner: LLMRunner, brief: VideoBrief, research: ResearchNotes): Promise<ScriptDraft> {
  const rate = speechRate(brief.language);
  const prompt = scriptPrompt(brief, rate, JSON.stringify(research, null, 2));
  return runner.structured("script", SCRIPT_SYSTEM, prompt, SCRIPT_DRAFT_SCHEMA, validateScriptDraft, {
    effort: "high",
  });
}
